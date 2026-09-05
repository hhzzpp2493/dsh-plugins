// dsh-image-vision tools — registers view_image: 让主模型（即使本身不支持图片）
// 也能「看图」——把图片文件交给商汤日日新视觉模型（sensenova-6.8-flash-lite，
// OpenAI Vision 兼容接口）做描述 / 问答 / OCR，返回文字结果。
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, resolve as resolvePath, join as joinPath } from 'node:path';
import os from 'node:os';

export const name = 'dsh-image-vision';
export const inject = ['tools', 'credentials'];

// ---------------------------------------------------------------- helpers

/** 运行中的 dsh 宿主可能没导出 DSH_HOME；按默认约定补为 ~/.dsh。 */
function dshHome() {
  return process.env.DSH_HOME || joinPath(os.homedir(), '.dsh');
}

/** 按文件头魔数识别图片 mime（无扩展名的附件也认得出来）。 */
function sniffMime(buffer) {
  if (!buffer || buffer.length < 12) return undefined;
  const b = buffer;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  return undefined;
}

const EXT_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

/** 把 Windows 风格路径（C:\...）转成 WSL 路径（/mnt/c/...），其余原样返回。 */
function toWslPath(p) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p.trim());
  if (!m) return p.trim();
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

function text(label, msg) {
  return [{ type: 'text', text: String(msg) }];
}

function objArgs(rawArgs, tool) {
  if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) return rawArgs;
  throw new Error(`${tool}: arguments must be an object`);
}

function strArg(args, key, tool, { required = false } = {}) {
  const value = args[key];
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`${tool}: missing required argument "${key}"`);
    return undefined;
  }
  if (typeof value !== 'string') throw new Error(`${tool}: "${key}" must be a string`);
  return value;
}

function loadConfig(config = {}) {
  return {
    apiKeyEnv: config.apiKeyEnv ?? process.env.DSH_IMAGE_VISION_API_KEY_ENV ?? 'SHANGTANG_API_KEY',
    baseUrl: config.baseUrl ?? process.env.DSH_IMAGE_VISION_BASE_URL ?? 'https://token.sensenova.cn/v1',
    model: config.model ?? process.env.DSH_IMAGE_VISION_MODEL ?? 'sensenova-6.8-flash-lite',
    maxTokens: config.maxTokens ?? 1024,
    timeoutMs: config.timeoutMs ?? 120_000,
    maxRetries: config.maxRetries ?? 4,
    // 商汤官方建议：长边不超过 2048px，节省 tokens 与延迟
    maxSide: config.maxSide ?? 2048,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 加载 sharp（用于缩放图片）。
 * 插件可能以软链方式安装（真实路径不在 profiles/node_modules 下），
 * 而 sharp 是平台自带依赖、固定在 $DSH_HOME/profiles/node_modules，
 * 因此先从那里 createRequire（宿主可能没导出 DSH_HOME，缺省 ~/.dsh），
 * 再退回普通 import（插件被复制安装时可直接解析）。
 */
async function loadSharp() {
  try {
    const { createRequire } = await import('node:module');
    const req = createRequire(joinPath(dshHome(), 'profiles', 'node_modules', 'sharp', 'package.json'));
    return req('sharp');
  } catch { /* fall through to plain import */ }
  try {
    const mod = await import('sharp');
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

/** 读取图片并转成 data URI：mime 用扩展名+魔数双重识别；sharp 可用时按需缩放到长边 <= maxSide。 */
async function imageToDataUri(path, maxSide) {
  if (!existsSync(path)) throw new Error(`view_image: 图片不存在: ${path}`);
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error(`view_image: 不是文件: ${path}`);
  if (stat.size > 64 * 1024 * 1024) throw new Error(`view_image: 图片太大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，请先压缩`);

  const ext = extname(path).toLowerCase();
  const buffer = readFileSync(path);
  let mime = EXT_MIME[ext] ?? sniffMime(buffer);
  let width;
  let height;

  const sharp = await loadSharp();
  if (sharp) {
    try {
      const meta = await sharp(buffer, { failOn: 'error' }).metadata();
      if (meta.format) mime = `image/${meta.format === 'jpg' ? 'jpeg' : meta.format}`;
      width = meta.width;
      height = meta.height;
      const longest = Math.max(width ?? 0, height ?? 0);
      if (longest > maxSide) {
        const scale = maxSide / longest;
        const out = await sharp(buffer, { failOn: 'error' })
          .resize({ width: Math.round((width ?? maxSide) * scale), height: Math.round((height ?? maxSide) * scale), fit: 'inside' })
          .jpeg({ quality: 90 })
          .toBuffer();
        return { dataUri: `data:image/jpeg;base64,${out.toString('base64')}`, mime: 'image/jpeg', width: Math.round((width ?? maxSide) * scale), height: Math.round((height ?? maxSide) * scale) };
      }
    } catch (error) {
      // sharp 解释失败：非致命，退回原始字节
      if (!mime) throw new Error(`view_image: 无法识别图片格式(${ext}): ${error?.message ?? error}`);
    }
  }

  // 无 sharp 或无需缩放：直接发送原始字节。超大原始图（>8MB）无 sharp 时拒绝，避免请求过大。
  if (!mime) throw new Error(`view_image: 无法识别图片格式(${ext})`);
  if (buffer.length > 8 * 1024 * 1024) {
    throw new Error(`view_image: 图片 ${(buffer.length / 1024 / 1024).toFixed(1)}MB 且当前环境无 sharp 无法压缩，请先用工具压到 8MB 以内`);
  }
  return { dataUri: `data:${mime};base64,${buffer.toString('base64')}`, mime, width, height };
}

/** 调 OpenAI 兼容 /chat/completions，content 里带 image_url；对 429/5xx/网络抖动做指数退避重试。 */
async function askVisionModel(cfg, apiKey, dataUri, question) {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
  const payload = {
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: question },
          { type: 'image_url', image_url: { url: dataUri } },
        ],
      },
    ],
  };

  let lastError;
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt += 1) {
    if (attempt > 0) {
      // 指数退避：2s, 4s, 8s, 16s ...
      await sleep(Math.min(2000 * 2 ** (attempt - 1), 30000));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
          'user-agent': 'dsh-image-vision/0.1 (dsh harness plugin)',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const raw = await res.text();
      let body;
      try { body = JSON.parse(raw); } catch { body = null; }
      if (!res.ok) {
        const detail = body?.error?.message ?? raw?.slice(0, 300);
        if ((res.status === 429 || res.status >= 500) && attempt < cfg.maxRetries) {
          lastError = `HTTP ${res.status}: ${detail}`;
          continue;
        }
        throw new Error(`view_image: 视觉模型请求失败 HTTP ${res.status}: ${detail}`);
      }
      const message = body?.choices?.[0]?.message ?? {};
      const content = message.content ?? message.reasoning ?? '';
      if (typeof content !== 'string' || content.trim().length === 0) {
        throw new Error(`view_image: 视觉模型返回为空 (finish_reason=${body?.choices?.[0]?.finish_reason ?? 'unknown'})`);
      }
      const usage = body?.usage ?? {};
      return { content: content.trim(), usage };
    } catch (error) {
      const transient = error?.name === 'AbortError' || error?.cause?.code === 'ECONNRESET'
        || error?.cause?.code === 'ECONNREFUSED' || error?.cause?.code === 'UND_ERR_CONNECT_TIMEOUT';
      if (transient && attempt < cfg.maxRetries) {
        lastError = error?.message ?? String(error);
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`view_image: 视觉模型多次重试仍失败: ${lastError ?? 'unknown'}`);
}

// ---------------------------------------------------------------- tool defs

function registerVisionTools(ctx, config = {}) {
  const cfg = loadConfig(config);

  ctx.tools.register({
    name: 'view_image',
    description:
      '让 dsh 看一张图片并给出文字回答（视觉模型：商汤日日新 sensenova-6.8-flash-lite，OpenAI Vision 兼容）。' +
      '主模型本身不支持图片时用它看图：传入图片文件路径（WSL 绝对路径或 /mnt/x/...；Windows 路径 C:\\... 会自动转换），' +
      '模型会读取图片并按 question 回答——支持描述内容、辨认图纸/表单/截图、识别其中的文字（OCR）、回答图中问题等。' +
      '图片较长边会按需自动缩放到 <=2048px 再发送。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string', description: '图片文件路径（WSL 绝对路径或 /mnt/c/...；Windows C:\\... 路径自动转换）。' },
        question: { type: 'string', description: '想问图片的问题；缺省为「详细描述这张图片的内容」。' },
        model: { type: 'string', description: '视觉模型 id（缺省 sensenova-6.8-flash-lite）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'content'],
        properties: {
          ok: { type: 'boolean' },
          content: { type: 'string', description: '视觉模型对图片的回答文本。' },
          model: { type: 'string' },
          mediaType: { type: 'string' },
          width: { type: 'number' },
          height: { type: 'number' },
        },
      },
      render: (_args, raw) => {
        if (!raw.ok) return text('view_image', `⚠️ 看图失败`);
        const meta = [raw.mediaType, raw.width ? `${raw.width}x${raw.height}` : null].filter(Boolean).join(' · ');
        return [
          { type: 'text', text: `🖼️ 看图结果（${raw.model}${meta ? ` · ${meta}` : ''}）：\n${raw.content}` },
        ];
      },
    },
    async execute(rawArgs) {
      const args = objArgs(rawArgs, 'view_image');
      const path = toWslPath(strArg(args, 'path', 'view_image', { required: true }));
      const question = strArg(args, 'question', 'view_image') ?? '详细描述这张图片的内容';
      const model = strArg(args, 'model', 'view_image');
      const requestCfg = model ? { ...cfg, model } : cfg;

      const resolved = await ctx.credentials.resolve(requestCfg.apiKeyEnv).catch(() => undefined);
      const apiKey = resolved?.value ?? process.env[requestCfg.apiKeyEnv];
      if (!apiKey) {
        throw new Error(
          `view_image: 未找到 API Key（凭据 "${requestCfg.apiKeyEnv}" 未配置）。请在 ~/.dsh/.credentials.yaml 或环境变量中配置 SHANGTANG_API_KEY。`
        );
      }

      const { dataUri, mime, width, height } = await imageToDataUri(path, requestCfg.maxSide);
      const { content } = await askVisionModel(requestCfg, apiKey, dataUri, question);
      return { ok: true, content, model: requestCfg.model, mediaType: mime, width, height };
    },
  });
}

export function apply(ctx, config = {}) {
  registerVisionTools(ctx, config);
}