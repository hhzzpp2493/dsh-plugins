// dsh-modelscope-router: ModelScope 免费推理池自动路由 + 每日额度本地记账。
// 依赖 Node >=18（全局 fetch）；纯 Node builtins，无 dsh-internal import。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const name = 'dsh-modelscope-router';
export const inject = ['tools'];

// ── 模型分级池（"优先能力强"版，2026-09-10 用 curl 逐个验证过）──
// 只放实测 support_inference=true 且魔搭 API 能调的模型
// strong = 旗舰档；main = 主力档（日常）；light = 轻量兜底；deep = 深推理独立池（200 次/天）
const TIERS = {
  strong: [
    'deepseek-ai/DeepSeek-V4-Pro-0813',   // DeepSeek 最新旗舰
    'Qwen/Qwen3.8-27B',                    // Qwen 最新一代
    'ZhipuAI/GLM-5.2',                     // 智谱主力
    'Qwen/Qwen3-30B-A3B',                  // Qwen MoE 高效
    'deepseek-ai/DeepSeek-V4-Pro',         // DeepSeek 上代旗舰
  ],
  main: [
    'deepseek-ai/DeepSeek-V4-Flash-0731',  // 快且稳
    'Qwen/Qwen3.8-27B',
    'ZhipuAI/GLM-5.2',
    'Qwen/Qwen3-30B-A3B',
    'Qwen/Qwen3-8B',
  ],
  light: [
    'Qwen/Qwen3-8B',
    'ZhipuAI/GLM-4.7-Flash',
    'deepseek-ai/DeepSeek-V4-Flash-0731',
  ],
  deep: [
    'deepseek-ai/DeepSeek-V4-Pro-0813',    // 深推理首选
    'deepseek-ai/DeepSeek-V4-Pro',
  ],
};

// 自动路由关键词
const DEEP_KEYWORDS = [
  '推理', '证明', '数学', '定理', '微积分', '算数', '算法', '复杂度',
  '排序', '递归', '动态规划', '代码', 'bug', '调试', 'debug', '重构',
  '规划', '策略', '因果', '权衡',
];
const STRONG_KEYWORDS = [
  '总结', '摘要', '概括', '提炼', '要点', '解释', '说明', '原理', '机制',
  '流程', '建议', '方案', '分析', '评价', '比较', '对比', '写作', '翻译',
  '改写', '润色', '总结报告', '日报',
];

const DEFAULT_CONFIG = {
  baseUrl: 'https://api-inference.modelscope.cn/v1/chat/completions',
  tokenFile: '/home/ubuntu/.dsh/modelscope-token',
  timeoutMs: 90_000,
  ledgerPath: '/home/ubuntu/.dsh/storages/ms-router-ledger.json',
  dailyLimit: 2000,        // 主池（含 strong/main/light）
  deepPoolLimit: 200,      // 深推理池独立
  degradeRatio: 0.95,      // 主池超过此比例自动降级到 light
  heavyUseThreshold: 30,   // 单个模型今日调用超过此数则切换到下一 fallback
  defaultTier: 'strong',   // "优先能力强"版：普通请求默认走强档
  enableThinking: false,   // 全局默认是否输出 reasoning_content
};

function text(value) { return [{ type: 'text', text: String(value) }]; }

function todayStr() {
  // 以 UTC+8 为准
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

// ── Ledger ───────────────────────────────────────────────
async function readLedger(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return { date: todayStr(), pools: {}, models: {}, calls: [] };
  }
}

async function writeLedger(path, ledger) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(ledger, null, 2), 'utf8');
}

/** 检查某池是否还有额度；超限返回 {allowed:false, reason}。 */
async function reserveQuota(config, pool) {
  const today = todayStr();
  const ledger = await readLedger(config.ledgerPath);
  if (ledger.date !== today) {
    ledger.date = today;
    ledger.pools = {};
    ledger.models = {};
    ledger.calls = [];
  }
  const limit = pool === 'deep' ? config.deepPoolLimit : config.dailyLimit;
  const used = ledger.pools[pool] ?? 0;
  if (used >= limit) {
    return { allowed: false, ledger, reason: `${pool} 池已用尽 ${used}/${limit}（今日），请明日再试` };
  }
  return { allowed: true, ledger };
}

async function commitCall(config, { pool, model, tokens, tier, elapsedMs }) {
  const ledger = await readLedger(config.ledgerPath);
  ledger.pools[pool] = (ledger.pools[pool] ?? 0) + 1;
  ledger.models[model] = (ledger.models[model] ?? 0) + 1;
  if (ledger.calls.length > 200) ledger.calls = ledger.calls.slice(-200);
  ledger.calls.push({ ts: new Date().toISOString(), model, pool, tier, tokens, elapsedMs });
  await writeLedger(config.ledgerPath, ledger);
}

// ── 路由选择 ──────────────────────────────────────────────
function decideRoute({ hint, textPreview, ledger, config }) {
  if (hint && hint !== 'auto') return hint;
  // 主池接近耗尽 → 降级到 light 保底（避免整池打爆后无法服务）
  const used = ledger.pools.main ?? 0;
  if (used >= config.dailyLimit * config.degradeRatio) return 'light';
  // 关键词判断
  const t = textPreview || '';
  const hits = (list) => list.reduce((n, k) => n + (t.includes(k) ? 1 : 0), 0);
  if (hits(DEEP_KEYWORDS) >= 2) return 'deep';
  if (hits(STRONG_KEYWORDS) >= 1) return 'strong';
  // 长度兜底
  if (t.length > 1500) return 'strong';
  if (t.length < 30) return 'light';
  return config.defaultTier;   // "优先能力强"版默认走 strong
}

/** 按池内顺序选具体模型；跳过今日调用过多的模型，做软均衡。 */
function pickModel(ledger, poolKey, overrideModel) {
  if (overrideModel) return overrideModel;
  const pool = TIERS[poolKey] ?? TIERS.main;
  for (const m of pool) {
    if ((ledger.models[m] ?? 0) < (ledger._heavy ?? 30)) return m;
  }
  return pool[0];
}

// ── SSE 流解析 ────────────────────────────────────────────
async function readSSE(resp) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let text = '';
  let reasoning = '';
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let finishReason = null;
  let finalModel = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let obj;
      try { obj = JSON.parse(payload); } catch { continue; }
      finalModel = obj.model ?? finalModel;
      const c = obj.choices?.[0];
      if (c) {
        const d = c.delta ?? c.message ?? {};
        if (d.content) text += d.content;
        if (d.reasoning_content) reasoning += d.reasoning_content;
        if (c.finish_reason) finishReason = c.finish_reason;
      }
      if (obj.usage) usage = obj.usage;
    }
  }
  return { text, reasoning, usage, finishReason, model: finalModel };
}

// ── 主调用逻辑 ────────────────────────────────────────────
async function chat(config, { messages, poolKey, modelOverride, maxTokens, temperature, topP, noThinking }) {
  const token = (await readFile(config.tokenFile, 'utf8').catch((e) => {
    throw new Error(`读取 token 失败: ${e.message}`);
  })).trim();
  if (!token) throw new Error('token 为空');

  const startedAt = Date.now();
  const ledger = await readLedger(config.ledgerPath);
  ledger._heavy = config.heavyUseThreshold;
  const chosenModel = pickModel(ledger, poolKey, modelOverride);

  const body = {
    model: chosenModel,
    messages,
    stream: true,
    max_tokens: maxTokens ?? 2048,
    temperature: temperature ?? 0.7,
    top_p: topP ?? 0.9,
    chat_template_kwargs: { enable_thinking: noThinking === false ? true : !config.enableThinking },
  };

  let resp;
  try {
    resp = await fetch(config.baseUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream, application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (e) {
    throw new Error(`网络/超时错误: ${e.message}`);
  }

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status} from ModelScope: ${errText.slice(0, 400)}`);
  }

  const ct = resp.headers.get('content-type') || '';
  const parsed = ct.includes('text/event-stream') ? await readSSE(resp) : await resp.json();

  const finalText = parsed.text ?? parsed.choices?.[0]?.message?.content ?? '';
  const finalReasoning = parsed.reasoning ?? '';
  const usage = parsed.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const elapsedMs = Date.now() - startedAt;
  const finalModel = parsed.model ?? chosenModel;
  const pool = poolKey === 'deep' ? 'deep' : 'main';

  // 只有真实返回内容才算一次有效调用
  await commitCall(config, { pool, model: finalModel, tokens: usage.total_tokens, tier: poolKey, elapsedMs });

  return { model: finalModel, tier: poolKey, pool, content: finalText, reasoning: finalReasoning, finish_reason: parsed.finish_reason ?? null, usage, elapsedMs };
}

// ── 工具 1: ms_chat（自动路由）──
function buildMsChat(config) {
  return {
    name: 'ms_chat',
    description:
      '调魔搭免费推理池：按 hint/关键词/长度自动选档（strong/main/light/deep），池内按 fallback 顺序挑模型；主池每日 2000 次、深推理池独立 200 次，本地记账，接近上限自动降级。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['messages'],
      properties: {
        messages: {
          type: 'array',
          items: {
            type: 'object',
            required: ['role', 'content'],
            properties: {
              role: { type: 'string', enum: ['system', 'user', 'assistant'] },
              content: { type: 'string' },
            },
          },
        },
        hint: {
          type: 'string',
          enum: ['auto', 'light', 'main', 'strong', 'deep'],
          description: '档位：auto 自动；light 轻量；main 主力；strong 旗舰；deep 深推理',
        },
        model: { type: 'string', description: '直接指定魔搭模型 ID（覆盖档位）' },
        maxTokens: { type: 'number', description: '最大输出 token，默认 2048' },
        temperature: { type: 'number', description: '0~1，默认 0.7' },
        noThinking: { type: 'boolean', description: '关闭 reasoning_content 输出，默认 true' },
      },
    },
    async execute(rawArgs) {
      if (!rawArgs?.messages?.length) return { ok: false, error: 'messages 为空' };
      const lastUser = [...rawArgs.messages].reverse().find((m) => m.role === 'user');
      const textPreview = (lastUser?.content || '').slice(0, 500);
      const ledger = await readLedger(config.ledgerPath);
      const tierDecision = decideRoute({ hint: rawArgs.hint, textPreview, ledger, config });

      // 深推理池超限时降级到 main
      let poolKey = tierDecision;
      if (poolKey === 'deep') {
        const d = await reserveQuota(config, 'deep');
        if (!d.allowed) poolKey = 'main';
      }
      const quota = await reserveQuota(config, poolKey === 'deep' ? 'deep' : 'main');
      if (!quota.allowed) {
        // 主池也满了，尝试 light 兜底
        poolKey = 'light';
        const l = await reserveQuota(config, 'main');
        if (!l.allowed) return { ok: false, error: '主池额度已耗尽' };
      }

      try {
        const result = await chat(config, {
          messages: rawArgs.messages,
          poolKey,
          modelOverride: rawArgs.model,
          maxTokens: rawArgs.maxTokens,
          temperature: rawArgs.temperature,
          noThinking: rawArgs.noThinking ?? true,
        });
        return { ok: true, ...result, tier_decision: tierDecision };
      } catch (err) {
        return { ok: false, error: String(err?.message || err) };
      }
    },
    output: {
      schema: {
        type: 'object',
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          model: { type: 'string' },
          tier: { type: 'string' },
          content: { type: 'string' },
          reasoning: { type: 'string' },
          usage: { type: 'object' },
          elapsedMs: { type: 'number' },
          tier_decision: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render(result) {
        if (!result.ok) return text(`❌ ${result.error}`);
        const lines = [
          `✅ ${result.model} [decision=${result.tier_decision || result.tier}, tier=${result.tier}]`,
          result.usage ? `tokens ${result.usage.total_tokens} (p:${result.usage.prompt_tokens}/c:${result.usage.completion_tokens}) · ${result.elapsedMs}ms` : '',
          '──── 内容 ────',
          result.content || '(空)',
        ];
        if (result.reasoning) {
          lines.push('──── reasoning (前 400 字) ────');
          lines.push(result.reasoning.slice(0, 400));
        }
        return text(lines.filter(Boolean).join('\n'));
      },
    },
  };
}

// ── 工具 2: ms_chat_force（指定档位/模型）──
function buildMsChatForce(config) {
  return {
    name: 'ms_chat_force',
    description: '按指定档位/模型强制调魔搭推理（不做自动路由），用于测试某个模型或明确指定。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['messages', 'tier'],
      properties: {
        messages: {
          type: 'array',
          items: {
            type: 'object',
            required: ['role', 'content'],
            properties: {
              role: { type: 'string', enum: ['system', 'user', 'assistant'] },
              content: { type: 'string' },
            },
          },
        },
        tier: { type: 'string', enum: ['light', 'main', 'strong', 'deep'], description: '目标档位' },
        model: { type: 'string', description: '或直接指定具体模型 ID 覆盖' },
        maxTokens: { type: 'number' },
        temperature: { type: 'number' },
      },
    },
    async execute(rawArgs) {
      if (!rawArgs?.messages?.length) return { ok: false, error: 'messages 为空' };
      if (!rawArgs?.tier && !rawArgs?.model) return { ok: false, error: 'tier 或 model 必填' };
      const tier = rawArgs.tier ?? 'main';
      const pool = tier === 'deep' ? 'deep' : 'main';
      const d = await reserveQuota(config, pool);
      if (!d.allowed) return { ok: false, error: d.reason };
      try {
        const result = await chat(config, {
          messages: rawArgs.messages,
          poolKey: tier,
          modelOverride: rawArgs.model,
          maxTokens: rawArgs.maxTokens,
          temperature: rawArgs.temperature,
          noThinking: true,
        });
        return { ok: true, ...result };
      } catch (err) {
        return { ok: false, error: String(err?.message || err) };
      }
    },
    output: {
      schema: {
        type: 'object',
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          model: { type: 'string' },
          tier: { type: 'string' },
          content: { type: 'string' },
          usage: { type: 'object' },
          elapsedMs: { type: 'number' },
          error: { type: 'string' },
        },
      },
      render(result) {
        if (!result.ok) return text(`❌ ${result.error}`);
        return text(`✅ ${result.model} [${result.tier}] · ${result.elapsedMs}ms\n${result.content || '(空)'}`);
      },
    },
  };
}

// ── 工具 3: ms_ledger（查额度）──
function buildMsLedger(config) {
  return {
    name: 'ms_ledger',
    description: '查看今日魔搭推理额度使用情况：主池、深推理池已用/上限、各模型调用次数、最近若干条调用记录。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {},
    },
    async execute() {
      const ledger = await readLedger(config.ledgerPath);
      const today = todayStr();
      if (ledger.date !== today) {
        return { ok: true, date: today, message: '今日无调用', pools: {}, models: [], recent: [] };
      }
      const modelsSorted = Object.entries(ledger.models || {})
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => ({ model: k, calls: v }));
      const recent = (ledger.calls || []).slice(-20).reverse();
      return {
        ok: true,
        date: ledger.date,
        pools: {
          main: { used: ledger.pools.main ?? 0, limit: config.dailyLimit },
          deep: { used: ledger.pools.deep ?? 0, limit: config.deepPoolLimit },
        },
        models: modelsSorted,
        recent,
        ledgerPath: config.ledgerPath,
      };
    },
    output: {
      schema: {
        type: 'object',
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          date: { type: 'string' },
          pools: { type: 'object' },
          models: { type: 'array' },
          recent: { type: 'array' },
          ledgerPath: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render(result) {
        if (!result.ok) return text('❌ ' + result.message);
        if (result.message) return text(result.message);
        const p = result.pools;
        const lines = [
          `📊 魔搭推理额度 · ${result.date}`,
          `  主池: ${(p.main?.used ?? 0)} / ${p.main?.limit ?? 0}`,
          `  深推理池: ${(p.deep?.used ?? 0)} / ${p.deep?.limit ?? 0}`,
          '─ 各模型调用 ─',
        ];
        for (const m of result.models ?? []) lines.push(`  ${m.model}: ${m.calls} 次`);
        if (result.recent?.length) {
          lines.push('─ 最近调用 ─');
          for (const r of result.recent) {
            lines.push(`  ${r.ts?.slice(11, 19)} ${r.tier}/${r.model} · ${r.tokens} tok · ${r.elapsedMs}ms`);
          }
        }
        return text(lines.join('\n'));
      },
    },
  };
}

// ── 工具 4: ms_ledger_reset（测试用清零）──
function buildMsLedgerReset(config) {
  return {
    name: 'ms_ledger_reset',
    description: '清空今日记账（仅供测试/手动清零，非生产用途）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {},
    },
    async execute() {
      await writeLedger(config.ledgerPath, { date: todayStr(), pools: {}, models: {}, calls: [] });
      return { ok: true, message: `已重置 ${config.ledgerPath}` };
    },
    output: {
      schema: {
        type: 'object',
        required: ['ok'],
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
      },
      render(result) {
        return text(result.ok ? `✅ ${result.message}` : '❌ reset failed');
      },
    },
  };
}

// ── apply ─────────────────────────────────────────────────
export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  ctx.tools.register(buildMsChat(cfg));
  ctx.tools.register(buildMsChatForce(cfg));
  ctx.tools.register(buildMsLedger(cfg));
  ctx.tools.register(buildMsLedgerReset(cfg));
}
