// FeishuWebBridgeEngine: relays Feishu messages into the SAME dsh web
// sessions this process serves. Runs inside the `dsh --profile web` process:
// - sessions are created/resumed through ctx.agents (identical to how the
//   browser's /api session.create & prompt work), so they appear live in the
//   Web UI, stream events to any open browser, and persist under $DSH_HOME.
// - every chat maps 1:1 to a web session attached to the "飞书" workspace.
// - final assistant text is relayed back into the Feishu chat (a pure shell).
// - model / preset / archiving are all the web-native machinery
//   (agentDefaultModel / agentPresets / workspaceRegistry.archiveSession).
import { mkdir, readFile, writeFile, readdir, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { FeishuSender } from './sender.js';
import { EventConsumer } from './event-consumer.js';

const DAY_MS = 86_400_000;
const ARCHIVE_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function makeLogger(prefix = '[feishu-bridge]') {
  const stamp = () => new Date().toISOString();
  return {
    log: (...args) => console.log(stamp(), prefix, ...args),
    warn: (...args) => console.warn(stamp(), prefix, ...args),
    error: (...args) => console.error(stamp(), prefix, ...args),
  };
}

/** Config resolution: explicit config keys win over environment defaults. */
export function loadConfig(env = process.env, override = {}) {
  const pick = (envKey, def, key) => (override[key] !== undefined ? override[key] : (env[envKey]?.trim() || def));
  const dshHome = pick('DSH_HOME', join(homedir(), '.dsh'), 'dshHome');
  return {
    dshHome,
    // All persistent state lives under $DSH_HOME (the web side).
    workspace: pick('DSH_FEISHU_WORKSPACE', join(dshHome, 'feishu-workspace'), 'workspace'),
    mediaDir: pick('DSH_FEISHU_MEDIA_DIR', join(dshHome, 'feishu-media'), 'mediaDir'),
    cliBin: pick('DSH_FEISHU_CLI_BIN', 'lark-cli', 'cliBin'),
    cliHome: pick('DSH_FEISHU_CLI_HOME', env.HOME?.trim() || homedir(), 'cliHome'),
    sendAck: override.sendAck !== undefined
      ? Boolean(override.sendAck)
      : (env.DSH_FEISHU_ACK?.trim() || '1') !== '0',
    archiveInactiveDays: Number(pick('DSH_FEISHU_ARCHIVE_DAYS', '7', 'archiveInactiveDays')),
    // Archived feishu sessions older than this are physically removed (0 = keep forever).
    archiveRetentionDays: Number(pick('DSH_FEISHU_RETENTION_DAYS', '45', 'archiveRetentionDays')),
    // Max archived sessions remembered per chat inside the bridge state.
    archiveKeepPerChat: Number(pick('DSH_FEISHU_KEEP_PER_CHAT', '20', 'archiveKeepPerChat')),
    // Show the usage/model footer at the bottom of reply cards (per-chat /stats can override).
    showStats: override.showStats !== undefined
      ? Boolean(override.showStats)
      : (env.DSH_FEISHU_STATS?.trim() || '1') !== '0',
  };
}

/** Compact token count for the stats footer: 8945 -> 8.9k, 1200000 -> 1.2M. */
export function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/** Build a Feishu interactive card (v2 schema): blue header + lark_md body + optional footer. */
export function buildReplyCard(reply, { footer } = {}) {
  const elements = [{ tag: 'markdown', content: reply, text_size: 'normal' }];
  if (footer) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', content: footer, text_size: 'notice' });
  }
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: '🐋 DeepSeek Harness' },
    },
    body: { elements },
  };
}

/**
 * Session id per Feishu chat generation. `gen` is bumped by `/new` so a fresh
 * conversation gets a NEW session id instead of resuming the archived one.
 * Legacy first-generation ids (`feishu-<chatId>`, no suffix) keep working.
 */
export function sessionIdForChat(chatId, gen) {
  const n = Number(gen);
  if (Number.isInteger(n) && n > 1) return `feishu-${chatId}-${n}`;
  return `feishu-${chatId}`;
}

/** Mint the id for the chat's NEXT generation (current + 1). */
export function nextSessionIdFor(chatId, gen) {
  const n = Number(gen ?? 0);
  return `feishu-${chatId}-${Math.max(2, n + 1)}`;
}

function splitLongText(text, max = 4_000) {
  if (text.length <= max) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut <= 0) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Aggregate the last assistant text written after `firstSeq` (headless-style). */
export function summarizeText(events, firstSeq) {
  let started = false;
  let text = '';
  for (const event of events) {
    if (event.seq < firstSeq) continue;
    if (event.type === 'turn/start') {
      started = true;
      continue;
    }
    if (!started) continue;
    if (event.type === 'assistant/message') {
      const joined = (event.data.message.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('');
      if (joined !== '') text = joined;
    }
  }
  return text.trim();
}

/** First turn after `firstSeq` that ended in error → its message (for relay). */
export function lastTurnErrorText(events, firstSeq) {
  for (const event of events) {
    if (event.seq < firstSeq) continue;
    if (event.type === 'turn/end' && event.data?.reason?.kind === 'error') {
      const err = event.data.reason.error;
      const message = err?.message ?? JSON.stringify(err ?? event.data.reason);
      return String(message).slice(0, 500);
    }
  }
  return '';
}

export class FeishuWebBridgeEngine {
  constructor({ ctx, config, logger = makeLogger() } = {}) {
    this.ctx = ctx;
    this.config = config;
    this.log = logger;
    this.started = false;
    this.readyPromise = undefined;
    this.consumer = undefined;
    this.sender = undefined;
    this.state = { version: 1, chats: {} };
    this.archiveTimer = undefined;
    this.pending = new Map(); // per-chat serialization: chatId -> settled promise chain
    this.modelSelections = new Map(); // chatId -> live model selection holder
    this.workspacePath = undefined;
  }

  async start() {
    if (this.started) return this;
    const { config, log } = this;
    await mkdir(config.workspace, { recursive: true });
    await mkdir(config.mediaDir, { recursive: true });
    this.workspacePath = await realpath(config.workspace);

    this.state = await this.loadState();

    this.sender = new FeishuSender({
      identity: 'bot',
      cliBin: config.cliBin,
      cliHome: config.cliHome,
      logger: log,
    });

    this.consumer = new EventConsumer({
      eventKey: 'im.message.receive_v1',
      identity: 'bot',
      logger: log,
      cliBin: config.cliBin,
      cliHome: config.cliHome,
    });
    this.consumer.on('event', (ev) => {
      this.dispatch(ev).catch((error) => log.error('handleEvent failed:', error));
    });
    this.consumer.start();

    if (config.archiveInactiveDays > 0) {
      this.archiveTimer = setInterval(() => {
        this.sweepArchive().catch((error) => log.error('archive sweep failed:', error));
      }, ARCHIVE_SWEEP_INTERVAL_MS);
    }

    this.started = true;
    log.log(`bridge started (workspace=${this.workspacePath}, chats=${Object.keys(this.state.chats).length}); waiting for Feishu events`);
    return this;
  }

  async stop() {
    if (!this.started) return;
    this.started = false;
    if (this.archiveTimer) {
      clearInterval(this.archiveTimer);
      this.archiveTimer = undefined;
    }
    if (this.consumer) {
      try { await this.consumer.stop(); } catch { /* ignore */ }
      this.consumer = undefined;
    }
  }

  // ---- service resolution -------------------------------------------------

  /** Resolve host services and wait for the profile mount before driving agents. */
  ready() {
    if (!this.readyPromise) {
      this.readyPromise = (async () => {
        await this.ctx.get('loader')?.await?.();
        this.agents = this.ctx.get('agents');
        this.sessions = this.ctx.get('sessions');
        this.workspaceRegistry = this.ctx.get('workspaceRegistry');
        this.defaults = this.ctx.get('agentDefaultModel');
        this.presets = this.ctx.get('agentPresets');
        this.sessionPersistence = this.ctx.get('sessionPersistence');
        this.sessionProjections = this.ctx.get('sessionProjections');
        if (!this.agents || !this.sessions || !this.workspaceRegistry || !this.defaults) {
          throw new Error('feishu bridge: required host services missing (agents/sessions/workspaceRegistry/agentDefaultModel)');
        }
      })().catch((error) => {
        this.readyPromise = undefined;
        throw error;
      });
    }
    return this.readyPromise;
  }

  defaultAgentOptions() {
    const { provider, model } = this.defaults.currentSelection();
    return { provider, model };
  }

  /** Agent options for a chat: its /model override, else the web default. */
  agentOptionsFor(chatId) {
    const recModel = this.state.chats[chatId]?.model;
    if (recModel?.provider && recModel?.model) return { provider: recModel.provider, model: recModel.model };
    return this.defaultAgentOptions();
  }

  /** Mirror the api-proxy composeAgent: mount a preset (or the default one) on the agent. */
  async composePreset(presetId, chatId) {
    if (!this.presets) {
      return { setup: () => this.installSelection(chatId, {}) };
    }
    const resolvedId = (await this.presets.resolve(presetId)).id;
    return {
      agentPreset: resolvedId,
      setup: async (agentCtx) => {
        this.installSelection(chatId, agentCtx);
        await this.presets.mount(agentCtx, resolvedId);
      },
    };
  }

  /**
   * Mutable per-chat model selection (web `session.selectModel` parity): the
   * holder is created on first use, seeded from the chat's `/model` override
   * (or the web default), and can be retargeted live by /model later.
   */
  selectionForChat(chatId) {
    let holder = this.modelSelections.get(chatId);
    if (!holder) {
      const seeded = this.agentOptionsFor(chatId);
      const current = { provider: seeded.provider, model: seeded.model };
      holder = {
        get current() {
          return current;
        },
        set current(next) {
          current.provider = next.provider;
          current.model = next.model;
        },
        assembled: undefined,
      };
      this.modelSelections.set(chatId, holder);
    }
    return holder;
  }

  /** Model-selection contribution (headless-style): keeps the session on the chat's model. */
  installSelection(chatId, agentCtx) {
    try {
      installModelSelection(agentCtx, this.selectionForChat(chatId));
    } catch (error) {
      // non-fatal: the agent still runs with agentOptions provider/model
      this.log.warn('installModelSelection skipped:', error.message);
    }
  }

  // ---- session lifecycle --------------------------------------------------

  async ensureFeishuWorkspace() {
    let ws;
    try {
      ws = await this.workspaceRegistry.resolveByPath(this.workspacePath);
    } catch { /* not found */ }
    if (!ws) ws = await this.workspaceRegistry.create(this.workspacePath, '飞书');
    return ws;
  }

  /** Find the live agent for a chat's session; create (or resume) it if absent. */
  async ensureSessionFor(chatId, sessionId) {
    let agent = this.agents.get(sessionId);
    if (agent) return agent;

    // Persisted (web restarted since the chat last spoke) → resume the SAME session.
    if (this.sessionPersistence) {
      try {
        const listed = await this.sessionPersistence.list();
        if (listed.some((h) => h.id === sessionId)) {
          const inspected = await this.sessionPersistence.inspect(sessionId);
          if (inspected.meta.cwd === this.workspacePath) {
            const presetId = inspected.meta.agentPreset;
            const composition = await this.composePreset(presetId, chatId);
            const { agent: resumed } = await this.agents.resume({
              resumeSessionId: sessionId,
              agentOptions: this.agentOptionsFor(chatId),
              setup: composition.setup,
            });
            this.log.log(`resumed session ${sessionId} for chat=${chatId}`);
            try { (await this.ensureFeishuWorkspace()).attachSession(sessionId); } catch { /* already attached or best-effort */ }
            return resumed;
          }
          this.log.warn(`session ${sessionId} has a different cwd; creating a fresh session`);
        }
      } catch (error) {
        this.log.warn(`resume failed for chat=${chatId}; creating fresh: ${error.message}`);
      }
    }

    const composition = await this.composePreset(undefined, chatId);
    const { agent: created } = await this.agents.create({
      sessionId,
      agentOptions: this.agentOptionsFor(chatId),
      meta: {
        cwd: this.workspacePath,
        ...(composition.agentPreset ? { agentPreset: composition.agentPreset } : {}),
      },
      setup: composition.setup,
    });
    try {
      const ws = await this.ensureFeishuWorkspace();
      await ws.attachSession(sessionId);
    } catch (error) {
      this.log.warn(`workspace attach failed for ${sessionId}: ${error.message}`);
    }
    this.log.log(`created session ${sessionId} for chat=${chatId}`);
    return created;
  }

  // ---- event handling -----------------------------------------------------

  /** Serialize each chat's events (later messages queue behind earlier ones). */
  dispatch(ev) {
    const chatId = ev?.chat_id ?? ev?.message?.chat_id ?? ev?.event?.message?.chat_id;
    if (!chatId) return Promise.resolve();
    const prev = this.pending.get(chatId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.handleEvent(ev));
    const tracked = next.then(
      () => { if (this.pending.get(chatId) === tracked) this.pending.delete(chatId); },
      (error) => {
        if (this.pending.get(chatId) === tracked) this.pending.delete(chatId);
        throw error;
      },
    );
    this.pending.set(chatId, tracked);
    return tracked;
  }

  async handleEvent(ev) {
    const message = ev?.message ?? ev?.event?.message ?? {};
    const chatId = ev.chat_id ?? message.chat_id;
    if (!chatId) return;
    const senderType = ev.sender_type ?? message.sender?.sender_type;
    if (senderType === 'app') return; // our own bot messages
    const msgType = ev.message_type ?? message.message_type;
    if (!msgType) return;
    const messageId = ev.message_id ?? ev.id ?? message.message_id;

    const contentRaw = ev.content ?? message.content ?? '';
    let content;
    try {
      content = typeof contentRaw === 'string' ? JSON.parse(contentRaw) : contentRaw;
    } catch {
      content = typeof contentRaw === 'string' ? { text: contentRaw } : contentRaw ?? {};
    }
    if (typeof content !== 'object' || content === null) content = {};

    let text = '';
    if (msgType === 'text') {
      text = String(content.text ?? (typeof contentRaw === 'string' ? contentRaw : '') ?? '').trim();
    } else if (msgType === 'image' || msgType === 'file') {
      const key = content.image_key ?? content.file_key;
      if (key && messageId) {
        try {
          const saved = this.sender.downloadResource(
            messageId,
            key,
            msgType === 'image' ? 'image' : 'file',
            this.config.mediaDir,
          );
          text = `[用户发来${msgType === 'image' ? '图片' : '文件'}，已下载到 ${join(this.config.mediaDir, saved)} 供你使用]`;
        } catch (error) {
          text = `[用户发来${msgType === 'image' ? '图片' : '文件'}，但下载失败：${error.message}]`;
        }
      }
    }

    if (!text) return;
    const userName = ev.sender_id ?? message.sender?.sender_id?.open_id ?? 'unknown';
    this.log.log(`message from chat=${chatId} type=${msgType} text=${text.slice(0, 120)}`);

    // Bridge commands: /new (fresh session), /model (per-chat model switch), /stats (footer toggle).
    const cmd = text.trim().toLowerCase();
    if (cmd === '/new' || cmd === '/重置' || cmd === '/重开') {
      await this.handleNew(chatId);
      return;
    }
    if (cmd === '/model' || cmd === '/模型' || cmd.startsWith('/model ') || cmd.startsWith('/模型 ')) {
      await this.handleModelCommand(chatId, cmd);
      return;
    }
    if (cmd === '/stats' || cmd === '/用量' || cmd === '/统计' || cmd.startsWith('/stats ') || cmd.startsWith('/用量 ')) {
      await this.handleStatsCommand(chatId, cmd);
      return;
    }

    // Resolve this chat's session id: first-ever message mints generation 1;
    // later messages keep the id stored by the mapping (bumped by /new).
    let rec = this.state.chats[chatId];
    if (!rec) {
      rec = {
        sessionId: sessionIdForChat(chatId, 1),
        gen: 1,
        lastActivity: new Date().toISOString(),
      };
      this.state.chats[chatId] = rec;
    }
    const sessionId = rec.sessionId;

    try {
      await this.ready();
    } catch (error) {
      this.log.error('ready failed:', error.message);
      this.trySend(chatId, `⚠️ Web 服务尚未就绪：${error.message}`);
      return;
    }

    if (this.config.sendAck) this.trySend(chatId, '收到，正在处理…');

    let agent;
    try {
      agent = await this.ensureSessionFor(chatId, sessionId);
    } catch (error) {
      this.log.error(`ensureSessionFor failed for chat=${chatId}:`, error.message);
      this.trySend(chatId, `⚠️ 会话准备失败：${error.message}`);
      return;
    }

    if (agent.status === 'running') {
      // busy because the web side (or a previous turn) is still working
      this.trySend(chatId, '上一条还在处理中（web 端可能正在运行任务），请稍候再发。');
      return;
    }

    rec.sessionId = agent.session.id;
    rec.lastActivity = new Date().toISOString();
    await this.saveState();

    const firstSeq = agent.session.seq;
    const prompt = this.buildPrompt(chatId, userName, text);
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    }));

    try {
      await agent.whenIdle();
    } catch (error) {
      this.log.error(`run failed for chat=${chatId}:`, error.message);
      this.trySend(chatId, `⚠️ 处理出错：${error.message}`);
      return;
    }

    try { await this.sessions.flush(agent.session); } catch { /* the loop flushes too */ }
    const reply = summarizeText(agent.session.events, firstSeq);
    this.state.chats[chatId].lastActivity = new Date().toISOString();
    await this.saveState();

    if (!reply) {
      const turnError = lastTurnErrorText(agent.session.events, firstSeq);
      if (turnError) {
        this.log.warn(`turn error for chat=${chatId}: ${turnError}`);
        this.trySend(chatId, `⚠️ 本轮处理出错（可在 web 界面查看详情）：${turnError}`);
      } else {
        this.trySend(chatId, '（本轮没有文本回复，可在 web 界面查看完整过程）');
      }
      return;
    }
    this.sendReply(chatId, reply, agent);
  }

  buildPrompt(chatId, userName, text) {
    return [
      `用户通过飞书发来消息（来自 ${userName}）：`,
      '',
      text,
      '',
      '说明：你正在与本机的 dsh Web 界面共享此会话。你在 web 界面的完整工作过程用户也能看到；',
      '你的最终文本回复会自动以卡片推送到这个飞书聊天。',
    ].join('\n');
  }

  trySend(chatId, text) {
    try {
      this.sender.sendMessage(chatId, text);
    } catch (error) {
      this.log.error(`send to chat=${chatId} failed: ${error.message}`);
    }
  }

  // ---- reply cards ---------------------------------------------------------

  /** Effective usage-footer state for a chat (per-chat override or global default). */
  statsEnabledFor(chatId) {
    const flag = this.state.chats[chatId]?.stats; // 'on' | 'off' | undefined
    if (flag === 'on') return true;
    if (flag === 'off') return false;
    return this.config.showStats;
  }

  statsStateLabel(chatId) {
    const flag = this.state.chats[chatId]?.stats;
    const flagText = flag === 'on' ? '开' : flag === 'off' ? '关' : '跟随全局';
    const globalText = this.config.showStats ? '开（默认）' : '关（默认）';
    return `用量统计：本会话 ${flagText}；全局默认 ${globalText}`;
  }

  /**
   * The model that actually served this run: the last request/header written
   * after `firstSeq`, else this chat's /model override, else the web default.
   */
  runModelFromEvents(events, firstSeq, chatId) {
    let fromLog = null;
    for (const event of events ?? []) {
      if (event.seq < firstSeq) continue;
      if (event.type === 'request/header' && event.data?.header?.config) {
        fromLog = event.data.header.config;
      }
    }
    if (fromLog?.provider && fromLog?.model) return `${fromLog.provider}/${fromLog.model}`;
    const rec = this.state.chats[chatId] ?? {};
    if (rec.model?.provider && rec.model?.model) return `${rec.model.provider}/${rec.model.model}`;
    try {
      const d = this.defaults?.currentSelection?.();
      if (d?.provider && d?.model) return `${d.provider}/${d.model}`;
    } catch { /* ignore */ }
    return '—';
  }

  /**
   * Web-UI-identical usage figures: read the host sessionProjections
   * `tokenUsage` snapshot — the SAME projection values the browser renders —
   * so the card footer always matches the web interface exactly.
   *   输入 = uncachedInput + cacheRead + cacheWrite (billed input)
   *   输出 = outputTokens
   *   缓存命中 = round(cacheRead / billed × 100)
   */
  webUsageFor(agent) {
    try {
      if (!this.sessionProjections || !agent) return null;
      const snap = this.sessionProjections.snapshot(agent.session);
      const usage = snap?.values?.tokenUsage;
      if (!usage) return null;
      const billed = (usage.uncachedInputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
      const output = usage.outputTokens ?? 0;
      if (billed <= 0 && output <= 0) return null;
      return {
        input: billed,
        output,
        cachePct: billed > 0 ? Math.min(100, Math.round((usage.cacheReadTokens ?? 0) / billed * 100)) : null,
      };
    } catch (error) {
      this.log.warn('webUsageFor failed:', error.message);
      return null;
    }
  }

  /** Send a reply as one or more interactive cards; footer (usage + model) on the last card. */
  sendReply(chatId, reply, agent) {
    if (!reply || !reply.trim()) return;
    const parts = splitLongText(reply, 6_000);
    let footer = '';
    if (this.statsEnabledFor(chatId)) {
      const usage = this.webUsageFor(agent);
      const usageLine = usage
        ? `📊 输入 ${formatTokens(usage.input)} · 输出 ${formatTokens(usage.output)} · 缓存命中 ${usage.cachePct === null ? '—' : `${usage.cachePct}%`}`
        : '';
      const modelLine = `🖥️ 模型：${this.runModelFromEvents(agent.session.events, 0, chatId)}`;
      footer = [usageLine, modelLine].filter(Boolean).join('\n');
    }
    for (let index = 0; index < parts.length; index += 1) {
      const isLast = index === parts.length - 1;
      try {
        this.sender.sendCard(chatId, buildReplyCard(parts[index], { footer: isLast && footer ? footer : undefined }));
      } catch (error) {
        this.log.error(`send reply card to chat=${chatId} failed: ${error.message}`);
      }
    }
  }

  /** /new: archive the current session (stays in the web, out of the sidebar)
   *  and bump this chat's generation so the NEXT message mints a fresh session. */
  async handleNew(chatId) {
    try {
      await this.advanceChatGen(chatId, { archiveOld: true });
      const rec = this.state.chats[chatId];
      this.log.log(`/new for chat=${chatId}: gen=${rec.gen} id=${rec.sessionId}`);
      this.trySend(chatId, `✅ 已开新会话（旧会话已归档，可在 web 端恢复）。下一条消息将接入全新会话（id ${rec.sessionId}）。`);
    } catch (error) {
      this.log.error(`/new failed for chat=${chatId}:`, error.message);
      this.trySend(chatId, `⚠️ 开新会话失败：${error.message}`);
    }
  }

  /** Bump a chat's generation: archive the old session (optional) and reserve
   *  the next-generation session id so a later message never resumes an old one. */
  async advanceChatGen(chatId, { archiveOld = false } = {}) {
    const rec = this.state.chats[chatId] ?? { gen: 0 };
    if (archiveOld && rec.sessionId) {
      try {
        await this.ready();
        await this.workspaceRegistry.archiveSession(SessionId(rec.sessionId));
        // remember the archive for retention-based cleanup
        const archived = rec.archived ?? [];
        archived.push({ sessionId: rec.sessionId, at: new Date().toISOString() });
        rec.archived = archived.slice(-Math.max(1, this.config.archiveKeepPerChat));
      } catch (error) {
        this.log.warn(`archive session failed for chat=${chatId} (${rec.sessionId}): ${error.message}`);
      }
    }
    const gen = Number(rec.gen ?? 1);
    this.state.chats[chatId] = {
      ...rec,
      sessionId: nextSessionIdFor(chatId, gen),
      gen: gen + 1,
      lastActivity: new Date().toISOString(),
    };
    await this.saveState();
    return this.state.chats[chatId];
  }

  // ---- /model ------------------------------------------------------------------

  /** Models from settings.yaml + the pi-ai builtin catalog (same source as the web UI). */
  async listModels() {
    const out = [];
    const seen = new Set();
    let providers = {};
    try {
      const text = await readFile(join(this.config.dshHome, 'settings.yaml'), 'utf8');
      const yaml = await import('js-yaml');
      providers = ((yaml.load(text) || {})['llm-pi-ai'] || {}).providers || {};
    } catch (error) {
      this.log.warn('settings read failed: ' + error.message);
    }
    for (const provider of Object.keys(providers)) {
      const conf = providers[provider] || {};
      const confModels = Array.isArray(conf.models) && conf.models.length ? conf.models : null;
      if (confModels) {
        for (const m of confModels) {
          if (!m || !m.id) continue;
          out.push({ provider, model: String(m.id), name: m.name ? String(m.name) : String(m.id) });
          seen.add(`${provider}/${m.id}`);
        }
      }
    }
    try {
      const mod = await import('@earendil-works/pi-ai/providers/all');
      const getBuiltinModels = mod.getBuiltinModels;
      for (const provider of Object.keys(providers)) {
        let builtins = [];
        try {
          builtins = getBuiltinModels(provider) || [];
        } catch {
          continue;
        }
        for (const m of builtins) {
          if (!m || !m.id) continue;
          const key = `${provider}/${m.id}`;
          if (seen.has(key)) continue;
          out.push({ provider, model: String(m.id), name: m.name ? String(m.name) : String(m.id) });
          seen.add(key);
        }
      }
    } catch (error) {
      this.log.warn('pi-ai catalog unavailable: ' + error.message);
    }
    return out;
  }

  currentModelLine(chatId) {
    const rec = this.state.chats[chatId];
    if (rec?.model?.provider && rec?.model?.model) return `${rec.model.provider}/${rec.model.model}（本聊天设置）`;
    const d = this.defaults.currentSelection();
    return `${d.provider}/${d.model}（web 默认）`;
  }

  async handleModelCommand(chatId, cmd) {
    try {
      await this.ready();
    } catch (error) {
      this.log.error('ready failed:', error.message);
      this.trySend(chatId, `⚠️ Web 服务尚未就绪：${error.message}`);
      return;
    }

    if (cmd === '/model' || cmd === '/模型') {
      const models = await this.listModels();
      if (models.length === 0) {
        this.trySend(chatId, `⚠️ 没读到模型列表（settings.yaml 的 llm-pi-ai.providers 为空或解析失败）。当前：${this.currentModelLine(chatId)}`);
        return;
      }
      const lines = models.map((m, i) => `${i + 1}. ${m.provider}/${m.model}${m.name && m.name !== m.model ? `（${m.name}）` : ''}`);
      const reply = `可用模型：\n${lines.join('\n')}\n—\n当前：${this.currentModelLine(chatId)}\n回复 /model <编号 或 provider/model> 切换；/model default 恢复 web 默认`;
      this.trySend(chatId, reply);
      return;
    }

    const selMatch = cmd.match(/^\/model\s+(.+)$/) ?? cmd.match(/^\/模型\s+(.+)$/);
    const sel = selMatch ? selMatch[1].trim() : '';
    if (!sel) return;

    if (sel.toLowerCase() === 'default') {
      await this.setChatModel(chatId, null, null);
      this.trySend(chatId, `✅ 已恢复 web 默认模型（当前会话与后续新会话均生效）。`);
      return;
    }

    const models = await this.listModels();
    const idx = Number.parseInt(sel, 10);
    let hit = null;
    if (!Number.isNaN(idx) && idx >= 1 && idx <= models.length) hit = models[idx - 1];
    else {
      const lower = sel.toLowerCase();
      hit = models.find((m) => `${m.provider}/${m.model}`.toLowerCase() === lower
        || m.model.toLowerCase() === lower
        || (m.name && m.name.toLowerCase() === lower)) ?? null;
    }
    if (!hit) {
      this.trySend(chatId, `未找到模型「${sel}」。发 /model 查看可用列表。`);
      return;
    }
    await this.setChatModel(chatId, hit.provider, hit.model);
    this.log.log(`chat=${chatId} model -> ${hit.provider}/${hit.model}`);
    this.trySend(chatId, `✅ 本聊天已切换模型：${hit.provider}/${hit.model}${hit.name && hit.name !== hit.model ? `（${hit.name}）` : ''}，下一条消息生效。`);
  }

  /** Persist the chat's model override AND retarget the live agent's selection. */
  async setChatModel(chatId, provider, model) {
    let rec = this.state.chats[chatId];
    if (!rec) {
      rec = { gen: 0, sessionId: undefined, lastActivity: new Date().toISOString() };
      this.state.chats[chatId] = rec;
    }
    if (provider && model) rec.model = { provider, model };
    else delete rec.model;
    rec.lastActivity = new Date().toISOString();
    await this.saveState();
    try {
      await this.ready();
      const sid = rec.sessionId ?? sessionIdForChat(chatId, rec.gen ?? 1);
      const agent = this.agents.get(sid);
      if (!agent) return;
      const selection = this.selectionForChat(chatId);
      if (provider && model) selection.current = { provider, model };
      else {
        const d = this.defaults.currentSelection();
        selection.current = { provider: d.provider, model: d.model };
      }
      // A fresh install wraps earlier contributions, so the latest switch wins.
      installModelSelection(agent.ctx, selection);
    } catch (error) {
      this.log.warn(`live model switch failed for chat=${chatId}: ${error.message}`);
    }
  }

  /** /stats: toggle the usage/model footer on reply cards for this chat. */
  async handleStatsCommand(chatId, cmd) {
    const arg = (cmd.match(/^\/(stats|用量|统计)\s+(.+)$/) ?? [])[2]?.trim();
    let next;
    if (!arg) {
      next = this.statsEnabledFor(chatId) ? 'off' : 'on';
    } else if (arg === 'default' || arg === '全局' || arg === '跟随全局') {
      next = null;
    } else if (/^(on|1|开|开启|打开|是|true)$/i.test(arg)) {
      next = 'on';
    } else if (/^(off|0|关|关闭|否|false)$/i.test(arg)) {
      next = 'off';
    } else {
      this.trySend(chatId, `无法识别「${arg}」。用 /stats、/stats on、/stats off 或 /stats default。`);
      return;
    }
    let rec = this.state.chats[chatId];
    if (!rec) {
      rec = { gen: 0, sessionId: undefined, lastActivity: new Date().toISOString() };
      this.state.chats[chatId] = rec;
    }
    if (next === null) delete rec.stats;
    else rec.stats = next;
    rec.lastActivity = new Date().toISOString();
    await this.saveState();
    this.log.log(`chat=${chatId} stats -> ${next ?? 'default'}`);
    this.trySend(chatId, next === null
      ? `✅ 已恢复跟随全局默认（${this.config.showStats ? '开' : '关'}）。${this.statsStateLabel(chatId)}，下一条消息生效。`
      : `✅ 卡片用量统计已${next === 'on' ? '开启' : '关闭'}。${this.statsStateLabel(chatId)}，下一条消息生效。`);
  }

  // ---- retention cleanup -----------------------------------------------------

  /** Physically remove an archived feishu session: persistence dir + registry + projcache. */
  async purgeSession(sessionId) {
    if (this.ctx.get('agents')?.get(sessionId) || this.ctx.get('sessions')?.get(sessionId)) {
      this.log.warn(`purge skipped: ${sessionId} is still live`);
      return false;
    }
    let removed = false;
    // 1. session persistence directory
    const sessionsRoot = join(this.config.dshHome, 'sessions');
    try {
      const groups = await readdir(sessionsRoot, { withFileTypes: true });
      for (const g of groups) {
        if (!g.isDirectory()) continue;
        try {
          await rm(join(sessionsRoot, g.name, sessionId), { recursive: true, force: true });
          removed = true;
        } catch { /* not found */ }
      }
    } catch { /* sessions root missing */ }
    // 2. workspace registry: drop from the global archive set (public API)
    if (this.workspaceRegistry.archivedSessionIds.includes(sessionId)) {
      try {
        await this.workspaceRegistry.enqueueOperation(async () => {
          const state = this.workspaceRegistry.requireState();
          await this.workspaceRegistry.setState({
            ...state,
            archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
          });
        });
      } catch (error) {
        this.log.warn(`purge registry update failed for ${sessionId}: ${error.message}`);
      }
    }
    // 3. projection cache (cache only; drop the key)
    try {
      const p = join(this.config.dshHome, 'storages', 'session_projcache.json');
      const doc = JSON.parse(await readFile(p, 'utf8'));
      const tbl = doc?.tables?.sessions;
      if (tbl && typeof tbl === 'object' && sessionId in tbl) {
        delete tbl[sessionId];
        await writeFile(p, JSON.stringify(doc, null, 2));
      }
    } catch { /* cache miss */ }
    this.log.log(`purged archived session ${sessionId} (removed=${removed})`);
    return removed;
  }

  /** Auto-archive idle chats (existing) and physically drop over-retention archives. */
  async sweepArchive() {
    const days = this.config.archiveInactiveDays;
    const retention = this.config.archiveRetentionDays;
    if (!(days > 0) && !(retention > 0)) return;
    await this.ready();
    const now = Date.now();
    let changed = false;

    for (const [chatId, rec] of Object.entries(this.state.chats)) {
      // A. idle chats → archive + bump generation
      if (days > 0) {
        const last = Date.parse(rec.lastActivity);
        if (Number.isFinite(last) && now - last >= days * DAY_MS) {
          this.log.log(`auto-archive chat=${chatId} session=${rec.sessionId} (idle >= ${days}d)`);
          try {
            await this.workspaceRegistry.archiveSession(SessionId(rec.sessionId));
            const archived = rec.archived ?? [];
            archived.push({ sessionId: rec.sessionId, at: new Date().toISOString() });
            rec.archived = archived.slice(-Math.max(1, this.config.archiveKeepPerChat));
          } catch (error) {
            this.log.warn(`archive failed for ${rec.sessionId}: ${error.message}`);
          }
          await this.advanceChatGen(chatId, { archiveOld: false });
          changed = true;
        }
      }
      // B. over-retention archives → physical purge
      if (retention > 0 && Array.isArray(rec.archived) && rec.archived.length) {
        const keep = [];
        for (const a of rec.archived) {
          const at = Date.parse(a.at);
          const expired = Number.isFinite(at) && now - at >= retention * DAY_MS;
          if (expired && a.sessionId) {
            this.log.log(`purge old archive chat=${chatId} session=${a.sessionId} (kept ${retention}d)`);
            await this.purgeSession(a.sessionId);
            changed = true;
          } else {
            keep.push(a);
          }
        }
        if (keep.length !== rec.archived.length) {
          rec.archived = keep.length ? keep : undefined;
          changed = true;
        }
      }
    }
    if (changed) await this.saveState();
  }

  // ---- durable state (web side: $DSH_HOME/storages) ------------------------

  statePath() {
    return join(this.config.dshHome, 'storages', 'feishu-bridge.json');
  }

  async loadState() {
    try {
      const doc = JSON.parse(await readFile(this.statePath(), 'utf8'));
      if (doc && typeof doc === 'object') return { version: 1, chats: doc.chats ?? {} };
    } catch { /* first boot */ }
    return { version: 1, chats: {} };
  }

  async saveState() {
    try {
      await mkdir(join(this.config.dshHome, 'storages'), { recursive: true });
      await writeFile(this.statePath(), JSON.stringify(this.state, null, 2));
    } catch (error) {
      this.log.warn('state save failed:', error.message);
    }
  }
}