// FeishuBridgeEngine: the whole bridge (event consumer supervisor, Feishu
// sender, localhost notify server, nested dsh runtime via the SDK client,
// per-chat session routing). Framework-agnostic so both the standalone runner
// (bridge/main.js) and the cordis plugin (bridge/plugin.js) can own one.
import { randomUUID } from 'node:crypto';
import { mkdir, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
import { join, resolve } from 'node:path';
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
import { runLarkCli } from './cli.js';
import { FeishuSender } from './sender.js';
import { EventConsumer } from './event-consumer.js';
import { startNotifyServer } from './notify-server.js';

export function makeLogger(prefix = '[bridge]') {
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
  return {
    dshHome: pick('DSH_HOME', resolve(env.HOME ?? '/root', '.dsh'), 'dshHome'),
    // Nested agent runtime profile name.
    profile: pick('DSH_FEISHU_PROFILE', 'feishu-agent', 'profile'),
    dshBin: pick('DSH_FEISHU_DSH_BIN', '/usr/bin/dsh', 'dshBin'),
    workspace: pick('DSH_FEISHU_WORKSPACE', resolve(process.cwd(), 'feishu-workspace'), 'workspace'),
    mediaDir: pick('DSH_FEISHU_MEDIA_DIR', resolve(process.cwd(), 'feishu-media'), 'mediaDir'),
    provider: pick('DSH_FEISHU_PROVIDER', 'opencode-go', 'provider'),
    model: pick('DSH_FEISHU_MODEL', 'deepseek-v4-flash', 'model'),
    notifyPort: Number(pick('DSH_FEISHU_NOTIFY_PORT', '48_680', 'notifyPort')),
    notifyToken: pick('DSH_FEISHU_NOTIFY_TOKEN', randomUUID(), 'notifyToken'),
    sendAck: override.sendAck !== undefined
      ? Boolean(override.sendAck)
      : (env.DSH_FEISHU_ACK?.trim() || '1') !== '0',
    cliBin: pick('DSH_FEISHU_CLI_BIN', 'lark-cli', 'cliBin'),
  };
}

function sessionIdForChat(chatId) {
  // Namespaced per deployment: stale restored sessions from a killed bridge
  // (prefix `feishu:`) leave a wedged turn that makes runs return empty.
  return `feishu2:${chatId}`;
}

function buildPrompt(chatId, userName, text) {
  return [
    `User message from Feishu chat ${chatId}${userName ? ` (from ${userName})` : ''}:`,
    text,
    '',
    'Context: this conversation happens in a Feishu chat with a real user.',
    `To send a message back into this chat, call the feishu_send_message tool with chat_id="${chatId}".`,
    'To return a local file into the chat, call feishu_send_file with chat_id="' + chatId + '".',
    'You can also work with the user\'s Feishu Drive via feishu_drive_upload / feishu_drive_download /',
    'feishu_drive_search / feishu_create_doc tools.',
  ].join('\n');
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

export class FeishuBridgeEngine {
  constructor(config, logger = makeLogger()) {
    this.config = config;
    this.log = logger;
    this.started = false;
    this.harnessReady = false;
    this.harness = undefined;
    this.consumer = undefined;
    this.notifyServer = undefined;
    this.runningChats = new Set();
  }

  async start() {
    if (this.started) return;
    const { config, log } = this;
    await mkdir(config.workspace, { recursive: true });
    await mkdir(config.mediaDir, { recursive: true });

    const sender = new FeishuSender({ identity: 'bot' });
    this.sender = sender;

    const { server: notifyServer } = await startNotifyServer({
      port: config.notifyPort,
      token: config.notifyToken,
      handlers: {
        '/send': (body) => {
          const { text, chat_id } = body;
          if (!chat_id || !text) throw new Error('send requires chat_id and text');
          sender.sendMessage(chat_id, text);
          return { chatId: chat_id };
        },
        '/send-file': (body) => {
          const { local_path, chat_id, filename } = body;
          if (!chat_id || !local_path) throw new Error('send-file requires chat_id and local_path');
          sender.sendFile(chat_id, local_path, { filename });
          return { chatId: chat_id };
        },
      },
    });
    this.notifyServer = notifyServer;
    log.log(`notify server listening on 127.0.0.1:${config.notifyPort}`);

    // Runtime env: inherited process env + the explicit overrides the nested
    // agent runtime (and its tool spawns of lark-cli) must see.
    this.runtimeEnv = {
      ...process.env,
      DSH_HOME: config.dshHome,
      DSH_FEISHU_NOTIFY_URL: `http://127.0.0.1:${config.notifyPort}`,
      DSH_FEISHU_NOTIFY_TOKEN: config.notifyToken,
      ...(config.cliBin ? { DSH_FEISHU_CLI_BIN: config.cliBin } : {}),
    };
    this.harness = new DeepSeekHarness({
      launch: {
        command: 'node',
        args: [config.dshBin, '--profile', config.profile],
        env: this.runtimeEnv,
        cwd: config.workspace,
      },
      cwd: config.workspace,
      provider: config.provider,
      model: config.model,
    });

    this.consumer = new EventConsumer({ eventKey: 'im.message.receive_v1', identity: 'bot', logger: log });
    this.consumer.on('event', (ev) => {
      this.handleEvent(ev).catch((error) => log.error('handleEvent failed:', error));
    });
    this.consumer.start();

    this.started = true;
    log.log('bridge started; waiting for Feishu events');
    return this;
  }

  async ensureHarness() {
    if (!this.harnessReady) {
      await this.harness.start();
      this.harnessReady = true;
      this.log.log('runtime handshake complete');
    }
  }

  newHarness(provider = this.lastTarget?.provider ?? this.config.provider, model = this.lastTarget?.model ?? this.config.model) {
    const { config } = this;
    return new DeepSeekHarness({
      launch: {
        command: 'node',
        args: [config.dshBin, '--profile', config.profile],
        env: this.runtimeEnv,
        cwd: config.workspace,
      },
      cwd: config.workspace,
      provider,
      model,
    });
  }

  async runForChat(chatId, prompt) {
    if (this.runningChats.has(chatId)) {
      this.log.warn(`concurrent run for chat=${chatId}; ignoring`);
      return '';
    }
    this.runningChats.add(chatId);
    try {
      return await this.runForChatInner(chatId, prompt);
    } finally {
      this.runningChats.delete(chatId);
    }
  }

  async runForChatInner(chatId, prompt) {
    const { log } = this;
    try {
      const target = (await this.chatModel(chatId)) ?? { provider: this.config.provider, model: this.config.model };
      this.lastTarget = target;
      const tkey = `${target.provider}/${target.model}`;
      if (this.harnessKey !== tkey) {
        if (this.harness) {
          try { await this.harness.close(); } catch { /* ignore */ }
          this.harness = undefined;
        }
        this.harnessReady = false;
        this.harness = this.newHarness(target.provider, target.model);
        this.harnessKey = tkey;
        log.log(`runtime model -> ${tkey}`);
      }
      await this.ensureHarness();
    } catch (error) {
      log.error('runtime start failed (will retry next message):', error.message);
      return `⚠️ 运行时连接失败：${error.message}`;
    }
    const sessionId = sessionIdForChat(chatId);
    try {
      const result = await this.harness.run(prompt, { sessionId });
      const reply = (result.finalResponse ?? '').trim();
      if (!reply) return '';
      for (const part of splitLongText(reply)) {
        try {
          this.sender.sendMessage(chatId, part);
        } catch (error) {
          log.error('send reply failed:', error.message);
        }
      }
      return reply;
    } catch (error) {
      log.error(`run failed for chat ${chatId}:`, error.message);
      if (!this.harnessReady) {
        try {
          this.harness = this.newHarness();
          await this.harness.start();
          this.harnessReady = true;
          const result = await this.harness.run(prompt, { sessionId });
          const reply = (result.finalResponse ?? '').trim();
          if (reply) {
            for (const part of splitLongText(reply)) this.sender.sendMessage(chatId, part);
          }
          return reply;
        } catch (retryError) {
          this.harnessReady = false;
          return `⚠️ 处理失败（重试后）：${retryError.message}`;
        }
      }
      return `⚠️ 处理出错：${error.message}`;
    }
  }

  /** Delete this chat's session directory(ies) so the next run starts fresh. */
  async resetSession(chatId) {
    const sessionsRoot = join(this.config.dshHome, 'sessions');
    const target = `feishu2~003A${chatId}`;
    const removed = [];
    let projects;
    try {
      projects = await readdir(sessionsRoot, { withFileTypes: true });
    } catch {
      return removed;
    }
    for (const proj of projects) {
      if (!proj.isDirectory()) continue;
      const projPath = join(sessionsRoot, proj.name);
      let children;
      try {
        children = await readdir(projPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of children) {
        if (!child.isDirectory()) continue;
        if (child.name === target || child.name.startsWith(target)) {
          await rm(join(projPath, child.name), { recursive: true, force: true });
          removed.push(join(projPath, child.name));
        }
      }
    }
    return removed;
  }

  /** Models from the shared settings.yaml, with the pi-ai builtin catalog as
   *  fallback - the exact source the dsh Web UI model list uses, so plan
   *  providers like opencode-go (no explicit models in settings) show all. */
  async listModels() {
    const out = [];
    let providers = {};
    try {
      const text = await readFile(join(this.config.dshHome, 'settings.yaml'), 'utf8');
      const doc = yaml.load(text);
      providers = ((doc || {})['llm-pi-ai'] || {}).providers || {};
    } catch (error) {
      this.log.warn('settings read failed: ' + error.message);
    }
    const names = Object.keys(providers);
    const seen = new Set();
    for (const provider of names) {
      const conf = providers[provider] || {};
      const confModels = Array.isArray(conf.models) && conf.models.length ? conf.models : null;
      if (confModels) {
        for (const m of confModels) {
          if (!m || !m.id) continue;
          out.push({ provider, model: String(m.id), name: m.name ? String(m.name) : String(m.id) });
          seen.add(provider + '/' + String(m.id));
        }
      }
    }
    const mod = await import('@earendil-works/pi-ai/providers/all');
    const getBuiltinModels = mod.getBuiltinModels;
    for (const provider of names) {
      let builtins = [];
      try {
        builtins = getBuiltinModels(provider) || [];
      } catch (e) {
        continue;
      }
      for (const m of builtins) {
        if (!m || !m.id) continue;
        const key = provider + '/' + String(m.id);
        if (seen.has(key)) continue;
        out.push({ provider, model: String(m.id), name: m.name ? String(m.name) : String(m.id) });
        seen.add(key);
      }
    }
    return out;
  }

  modelStorePath() {
    return join(this.config.dshHome, 'feishu-chat-models.json');
  }

  async chatModel(chatId) {
    try {
      const store = JSON.parse(await readFile(this.modelStorePath(), 'utf8'));
      const hit = store?.[chatId];
      return hit?.provider && hit?.model ? { provider: String(hit.provider), model: String(hit.model) } : null;
    } catch {
      return null;
    }
  }

  async setChatModel(chatId, provider, model) {
    let store = {};
    try { store = JSON.parse(await readFile(this.modelStorePath(), 'utf8')) ?? {}; } catch { store = {}; }
    if (provider && model) store[chatId] = { provider, model };
    else delete store[chatId];
    await writeFile(this.modelStorePath(), JSON.stringify(store, null, 2));
  }

  async handleEvent(ev) {
    // The CLI flattens the event: top-level fields (chat_id / message_type /
    // content / sender_id / sender_type). Fall back to the nested `message`
    // object for other event shapes.
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

    // Slash-command: /new resets this chat's session to a fresh conversation.
    const cmd = text.trim().toLowerCase();
    if (cmd === '/new' || cmd === '/重置' || cmd === '/重开') {
      if (this.runningChats.has(chatId)) {
        try { this.sender.sendMessage(chatId, '上一条还在处理中，请稍等完成后再发 /new。'); } catch {}
        return;
      }
      try {
        await this.resetSession(chatId);
        this.log.log(`session reset for chat=${chatId}`);
        this.sender.sendMessage(chatId, '✅ 已重置会话，接下来是全新对话。');
      } catch (error) {
        this.log.error(`reset failed for chat=${chatId}: ${error.message}`);
        try { this.sender.sendMessage(chatId, `⚠️ 重置失败：${error.message}`); } catch {}
      }
      return;
    }

    if (cmd === '/model' || cmd === '/模型') {
      const models = await this.listModels();
      const cur = await this.chatModel(chatId);
      const curLine = cur
        ? `当前：${cur.provider}/${cur.model}`
        : `当前（默认）：${this.config.provider}/${this.config.model}`;
      if (models.length === 0) {
        try { this.sender.sendMessage(chatId, `⚠️ 没读到模型列表（settings.yaml 的 llm-pi-ai.providers 为空或解析失败）。${curLine}`); } catch {}
        return;
      }
      const lines = models.map((m, i) => `${i + 1}. ${m.provider}/${m.model}${m.name && m.name !== m.model ? `（${m.name}）` : ''}`);
      const reply = `可用模型：\n${lines.join('\n')}\n—\n${curLine}\n回复 /model <编号 或 provider/model> 切换；/model default 恢复默认`;
      try { this.sender.sendMessage(chatId, reply); } catch {}
      return;
    }
    const selMatch = cmd.match(/^\/model\s+(.+)$/) ?? cmd.match(/^\/模型\s+(.+)$/);
    if (selMatch) {
      const sel = selMatch[1].trim();
      if (sel.toLowerCase() === 'default') {
        await this.setChatModel(chatId, null, null);
        try { this.sender.sendMessage(chatId, `✅ 已恢复默认模型：${this.config.provider}/${this.config.model}`); } catch {}
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
        try { this.sender.sendMessage(chatId, `未找到模型「${sel}」。发 /model 查看可用列表。`); } catch {}
        return;
      }
      await this.setChatModel(chatId, hit.provider, hit.model);
      this.log.log(`chat=${chatId} model -> ${hit.provider}/${hit.model}`);
      try { this.sender.sendMessage(chatId, `✅ 本聊天已切换模型：${hit.provider}/${hit.model}${hit.name && hit.name !== hit.model ? `（${hit.name}）` : ''}，下一条消息生效`); } catch {}
      return;
    }

    if (this.config.sendAck) {
      try {
        this.sender.sendMessage(chatId, '收到，正在处理…');
      } catch {
        // ignore ack failures
      }
    }

    const prompt = buildPrompt(chatId, userName, text);
    await this.runForChat(chatId, prompt);
  }

  async stop() {
    if (!this.started) return;
    this.log.log('stopping bridge engine');
    this.started = false;
    if (this.consumer) {
      await this.consumer.stop();
      this.consumer = undefined;
    }
    if (this.harnessReady && this.harness) {
      try {
        await this.harness.close();
      } catch {
        // ignore
      }
      this.harnessReady = false;
      this.harness = undefined;
    }
    if (this.notifyServer) {
      try {
        this.notifyServer.close();
      } catch {
        // ignore
      }
      this.notifyServer = undefined;
    }
  }
}

// Re-export for tools/tests that need the CLI wrapper.
export { runLarkCli };