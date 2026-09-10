// dsh-prompt-optimizer 服务端实现（cordis 插件）
// - 注册 webServer 路由 POST /plugins/prompt-optimizer/optimize：
//   收到 { text }，调 OpenAI 兼容的 /chat/completions 让 LLM 把草稿优化成
//   结构清晰、意图明确的高质量提示词，返回 { ok, optimized, model, usage }。
// - 注册 optimize_prompt agent 工具（复用同一套优化逻辑）。
import { createHash } from 'node:crypto';

export const name = 'dsh-prompt-optimizer';
export const inject = ['webServer', 'credentials', 'tools'];

// ------------------------------------------------------------------ config

const DEFAULT_CONFIG = {
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  maxTokens: 1024,
  timeoutMs: 60_000,
  maxRetries: 3,
  maxInputChars: 20_000,
};

function loadConfig(config = {}) {
  return {
    apiKeyEnv: config.apiKeyEnv ?? process.env.DSH_PROMPT_OPTIMIZER_API_KEY_ENV ?? DEFAULT_CONFIG.apiKeyEnv,
    baseUrl: config.baseUrl ?? process.env.DSH_PROMPT_OPTIMIZER_BASE_URL ?? DEFAULT_CONFIG.baseUrl,
    model: config.model ?? process.env.DSH_PROMPT_OPTIMIZER_MODEL ?? DEFAULT_CONFIG.model,
    maxTokens: config.maxTokens ?? DEFAULT_CONFIG.maxTokens,
    timeoutMs: config.timeoutMs ?? DEFAULT_CONFIG.timeoutMs,
    maxRetries: config.maxRetries ?? DEFAULT_CONFIG.maxRetries,
    maxInputChars: config.maxInputChars ?? DEFAULT_CONFIG.maxInputChars,
  };
}

// ------------------------------------------------------------------ helpers

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 把任意抛出的值渲染成可读消息（含 cause 链）。 */
function errorChain(value) {
  const seen = new Set();
  const render = (current) => {
    if (!(current instanceof Error)) return String(current);
    if (seen.has(current)) return '<circular>';
    seen.add(current);
    const members = current instanceof AggregateError && current.errors?.length
      ? ` [${current.errors.map(render).join('; ')}]` : '';
    const cause = current.cause instanceof Error && render(current.cause);
    const causeText = cause && cause !== current.message ? `: ${cause}` : '';
    return `${current.message}${members}${causeText}`;
  };
  return render(value);
}

/** 稳定的 JSON 响应写回。 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * 调 OpenAI 兼容 /chat/completions 优化提示词。
 * system 提示词要求模型只输出优化后的正文（不解释、不加引号包裹），
 * 保持原语言与意图、补齐背景/目标/输出形式。
 */
async function optimizeWithLlm(cfg, apiKey, text, mode = 'general') {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;

  const modeSystem = {
    general:
      '你是一位提示词工程专家。用户发来一段草稿指令，请把它改写为一份高质量提示词：' +
      '结构清晰、信息完整、意图明确；补充必要背景、明确任务目标与期望的输出形式；' +
      '不要臆造用户没有表达的硬性要求，不要改变用户原本的意图与事实。' +
      '保持用户使用的语言。只输出优化后的提示词正文，不要任何解释、标题或引号包裹。',
    expand:
      '你是一位提示词工程专家。用户发来一段草稿指令，请把它扩展为一份更详尽的高质量提示词：' +
      '补充角色设定、清晰的任务步骤、输入/输出格式、质量标准与注意事项；' +
      '不要改变用户原本的意图与事实。保持用户使用的语言。' +
      '只输出优化后的提示词正文，不要任何解释、标题或引号包裹。',
    concise:
      '你是一位提示词工程专家。用户发来一段草稿指令，请把它压缩为一份简洁的高质量提示词：' +
      '保留核心意图与关键约束，去掉冗余表达；结构仍然清晰。' +
      '保持用户使用的语言。只输出优化后的提示词正文，不要任何解释、标题或引号包裹。',
  }[mode] ?? '你是一位提示词工程专家。请把用户的草稿指令改写为一份高质量提示词：结构清晰、信息完整、意图明确。保持用户使用的语言，只输出优化后的提示词正文，不要任何解释、标题或引号包裹。';

  const payload = {
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    temperature: 0.6,
    messages: [
      { role: 'system', content: modeSystem },
      { role: 'user', content: text },
    ],
  };

  let lastError;
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt += 1) {
    if (attempt > 0) await sleep(Math.min(1000 * 2 ** (attempt - 1), 15_000));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
          'user-agent': 'dsh-prompt-optimizer/0.1 (dsh harness plugin)',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const raw = await res.text();
      let body;
      try { body = JSON.parse(raw); } catch { body = null; }
      if (!res.ok) {
        const detail = body?.error?.message ?? raw?.slice(0, 300);
        const transient = res.status === 429 || res.status >= 500;
        if (transient && attempt < cfg.maxRetries) {
          lastError = `HTTP ${res.status}: ${detail}`;
          continue;
        }
        throw new Error(`提示词优化请求失败 HTTP ${res.status}: ${detail}`);
      }
      const message = body?.choices?.[0]?.message ?? {};
      let content = typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('')
          : '';
      content = content.trim();
      if (!content) {
        throw new Error(`提示词优化返回为空 (finish_reason=${body?.choices?.[0]?.finish_reason ?? 'unknown'})`);
      }
      // 去掉模型偶尔顺手加上的包裹引号（成对出现且在首尾时）
      content = content.replace(/^[“"「『]+/, '').replace(/[”"」』]+$/, '').trim();
      return {
        optimized: content,
        model: cfg.model,
        usage: body?.usage ?? null,
        digest: createHash('sha1').update(content).digest('hex').slice(0, 12),
      };
    } catch (error) {
      const transient = error?.name === 'AbortError'
        || error?.cause?.code === 'ECONNRESET'
        || error?.cause?.code === 'ECONNREFUSED'
        || error?.cause?.code === 'UND_ERR_CONNECT_TIMEOUT';
      if (transient && attempt < cfg.maxRetries) {
        lastError = error?.message ?? String(error);
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`提示词优化多次重试仍失败: ${lastError ?? 'unknown'}`);
}

// ---------------------------------------------------------------- routes

function registerHttpRoute(ctx, cfg) {
  if (!ctx.webServer) return;
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/plugins/prompt-optimizer/optimize',
    async handler(req, res) {
      try {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '仅支持 POST' });
          return;
        }
        let rawBody = '';
        for await (const chunk of req) rawBody += chunk;
        let data = {};
        try {
          data = rawBody ? JSON.parse(rawBody) : {};
        } catch {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
          return;
        }
        const text = typeof data?.text === 'string' ? data.text.trim() : '';
        if (!text) {
          sendJson(res, 400, { ok: false, error: '缺少要优化的提示词文本（text）' });
          return;
        }
        if (text.length > cfg.maxInputChars) {
          sendJson(res, 400, { ok: false, error: `提示词过长（超过 ${cfg.maxInputChars} 字符）` });
          return;
        }

        const resolved = await ctx.credentials?.resolve(cfg.apiKeyEnv).catch(() => undefined);
        const apiKey = resolved?.value ?? process.env[cfg.apiKeyEnv];
        if (!apiKey) {
          sendJson(res, 503, {
            ok: false,
            error: `未找到 API Key（凭据 "${cfg.apiKeyEnv}" 未配置）。请在 ~/.dsh/.credentials.yaml 或环境变量配置该凭据，或在插件配置里指定 apiKeyEnv。`,
          });
          return;
        }

        const mode = typeof data?.mode === 'string' && ['general', 'expand', 'concise'].includes(data.mode)
          ? data.mode : 'general';
        const result = await optimizeWithLlm(cfg, apiKey, text, mode);
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: errorChain(error) });
      }
    },
  }));
}

// ---------------------------------------------------------------- tools

function registerOptimizeTool(ctx, cfg) {
  if (!ctx.tools) return;
  ctx.tools.register({
    name: 'optimize_prompt',
    description:
      '把一段草稿提示词优化为结构清晰、意图明确的高质量提示词（像华为 OfficeAce 的提示词优化）。' +
      '传入文字，返回优化后的提示词正文；适合在用户的要求含糊、信息不全时先帮他理顺再执行。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: { type: 'string', description: '要优化的原始提示词草稿。' },
        mode: { type: 'string', enum: ['general', 'expand', 'concise'], description: '优化风格：general 常规精炼（缺省）、expand 扩写更详尽、concise 压缩更简短。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['optimized'],
        properties: {
          optimized: { type: 'string', description: '优化后的提示词正文。' },
          model: { type: 'string', description: '用于优化的模型 id。' },
        },
      },
      render: (_args, raw) => [
        { type: 'text', text: `✨ 提示词优化结果（${raw?.model ?? 'unknown'}）：\n${raw?.optimized ?? ''}` },
      ],
    },
    async execute(rawArgs) {
      const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
      const text = typeof args.text === 'string' ? args.text.trim() : '';
      if (!text) throw new Error('optimize_prompt: 缺少要优化的文本参数 text');
      const mode = args.mode === 'expand' || args.mode === 'concise' ? args.mode : 'general';
      const resolved = await ctx.credentials?.resolve(cfg.apiKeyEnv).catch(() => undefined);
      const apiKey = resolved?.value ?? process.env[cfg.apiKeyEnv];
      if (!apiKey) {
        throw new Error(`optimize_prompt: 未找到 API Key（凭据 "${cfg.apiKeyEnv}" 未配置）`);
      }
      const { optimized, model } = await optimizeWithLlm(cfg, apiKey, text, mode);
      return { optimized, model };
    },
  });
}

// ------------------------------------------------------------------ apply

export function apply(ctx, config = {}) {
  const cfg = loadConfig(config);
  registerHttpRoute(ctx, cfg);
  registerOptimizeTool(ctx, cfg);
}