// dsh-modelscope-toolkit tools: modelscope_mcp_status / modelscope_mcp_start /
// modelscope_skill_sync. Node builtins only — no dsh-internal imports.
// 用途: 管理本机/云服务器的魔搭 MCP server（常驻 8765 端口）以及官方 skill 同步。
import { spawn } from 'node:child_process';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const name = 'dsh-modelscope-toolkit';
export const inject = ['tools'];

const DEFAULT_CONFIG = {
  // MCP server
  port: 8765,
  mcpUrl: 'http://127.0.0.1:8765/mcp',
  tokenEnv: 'MODELSCOPE_API_TOKEN',
  tokenFile: '',             // 可选: token 文件路径（若不放在进程环境变量）
  startScript: '',           // 可选: 外部启动脚本（优先于内部 uvx 逻辑）
  // skills
  skillsDir: join(homedir(), '.agents', 'skills'),
  skillsRepo: 'https://github.com/modelscope/modelscope-skills.git',
  skillsNames: ['ms-hub', 'ms-studio-deploy'],
  // 行为
  serverTimeoutMs: 120_000,
};

function text(value) {
  return [{ type: 'text', text: String(value) }];
}

/** Async spawn; resolves {ok, code, stdout, stderr}. */
function run(args, { cwd, timeoutMs = 30_000, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(args[0], args.slice(1), {
      cwd,
      env: env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        resolve({ ok: false, code: null, stdout, stderr: `${stderr}\n(超时 ${timeoutMs}ms，已终止)`.trim() });
      }
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, code: null, stdout, stderr: `spawn 失败: ${error.message}` });
      }
    });
    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ ok: code === 0, code, stdout, stderr });
      }
    });
  });
}

/** 检测 MCP server 是否监听端口（ss/netstat）。 */
function isPortListening(port) {
  return new Promise((resolve) => {
    const child = spawn('bash', [
      '-c',
      `command -v ss >/dev/null && ss -tln | grep -q ":${port} " || netstat -tln 2>/dev/null | grep -q ":${port} "`,
    ], { stdio: ['ignore', 'ignore', 'ignore'] });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

async function buildServerEnv(config) {
  const env = { ...process.env };
  const PATH = env.PATH ?? '';
  if (!PATH.includes(homedir())) {
    env.PATH = `${join(homedir(), '.local', 'bin')}:${PATH}`;
  }
  if (!env.MODELSCOPE_API_TOKEN && config.tokenFile) {
    try {
      env.MODELSCOPE_API_TOKEN = (await readFile(config.tokenFile, 'utf8')).trim();
    } catch { /* 文件不存在则忽略 */ }
  }
  return env;
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // ── modelscope_mcp_status: 检查 8765 端口 + 进程 + 日志 ──
  ctx.tools.register({
    name: 'modelscope_mcp_status',
    description: '检查魔搭 ModelScope MCP server 是否在运行（端口探测 + uvx 进程检查），返回端口/进程/日志路径。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {},
    },
    async execute() {
      const listening = await isPortListening(cfg.port);
      const proc = await run(['bash', '-c', `pgrep -af "modelscope-mcp-server --transport http" | head -3 || true`], { timeoutMs: 10_000 });
      return {
        port: cfg.port,
        listening,
        processLines: proc.stdout.trim().split('\n').filter(Boolean),
        logPaths: [join(homedir(), '.dsh', 'storages', 'modelscope-mcp.log')],
      };
    },
    output: {
      schema: {
        type: 'object',
        required: ['port', 'listening'],
        properties: {
          port: { type: 'number' },
          listening: { type: 'boolean' },
          processLines: { type: 'array', items: { type: 'string' } },
          logPaths: { type: 'array', items: { type: 'string' } },
        },
      },
      render(result) {
        const lines = [
          `魔搭 MCP server: 端口 ${result.port} ${result.listening ? '✅ 监听中' : '❌ 未监听'}`,
        ];
        if (result.processLines?.length) {
          lines.push('进程:');
          for (const p of result.processLines) lines.push(`  ${p}`);
        } else {
          lines.push('进程: 无 uvx modelscope-mcp-server 进程');
        }
        return text(lines.join('\n'));
      },
    },
  });

  // ── modelscope_mcp_start: 拉起/确保 MCP server 常驻 ──
  ctx.tools.register({
    name: 'modelscope_mcp_start',
    description: '启动（或确认已在运行）魔搭 ModelScope MCP server：优先用配置的 startScript，否则内部用 uvx 拉起并常驻 8765 端口；需要 MODELSCOPE_API_TOKEN（或 config.tokenFile）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {},
    },
    async execute() {
      const listening = await isPortListening(cfg.port);
      if (listening) {
        return { started: false, alreadyRunning: true, message: `MCP server 已在 ${cfg.port} 端口运行` };
      }
      if (cfg.startScript) {
        const r = await run(['bash', cfg.startScript], { timeoutMs: cfg.serverTimeoutMs });
        return {
          started: r.ok,
          alreadyRunning: false,
          message: r.ok ? `已通过脚本 ${cfg.startScript} 启动` : `启动失败: ${r.stderr.trim() || r.stdout.trim()}`,
        };
      }
      const env = await buildServerEnv(cfg);
      if (!env.MODELSCOPE_API_TOKEN) {
        return { started: false, alreadyRunning: false, message: `缺少 ${cfg.tokenEnv} 环境变量或 config.tokenFile，无法启动 MCP server` };
      }
      await mkdir(join(homedir(), '.dsh', 'storages'), { recursive: true });
      const logPath = join(homedir(), '.dsh', 'storages', 'modelscope-mcp.log');
      const child = spawn('bash', [
        '-c',
        `nohup uvx modelscope-mcp-server --transport http --port ${cfg.port} >> "${logPath}" 2>&1 &`,
      ], { env, stdio: ['ignore', 'ignore', 'ignore'], detached: true });
      child.unref();
      // 轮询等待端口就绪（最多 ~15s）
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (await isPortListening(cfg.port)) {
          return { started: true, alreadyRunning: false, message: `MCP server 已启动并监听 ${cfg.port}（日志: ${logPath}）` };
        }
      }
      let tail = '';
      try { tail = (await readFile(logPath, 'utf8')).slice(-400); } catch { /* ignore */ }
      return { started: false, alreadyRunning: false, message: `启动超时（15s 内端口未就绪）; 日志尾部:\n${tail}` };
    },
    output: {
      schema: {
        type: 'object',
        required: ['started', 'alreadyRunning'],
        properties: {
          started: { type: 'boolean' },
          alreadyRunning: { type: 'boolean' },
          message: { type: 'string' },
        },
      },
      render(result) {
        const state = result.alreadyRunning ? '已在运行' : (result.started ? '已启动' : '启动失败');
        return text(`[${state}] ${result.message ?? ''}`.trim());
      },
    },
  });

  // ── modelscope_skill_sync: 从官方仓库同步 skill 到 ~/.agents/skills ──
  ctx.tools.register({
    name: 'modelscope_skill_sync',
    description: '从 modelscope/modelscope-skills 官方仓库同步 skill（默认 ms-hub、ms-studio-deploy）到 ~/.agents/skills/，供 dsh 自动发现（无需重启）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {
        names: {
          type: 'array',
          items: { type: 'string' },
          description: '要同步的 skill 名（默认 ms-hub、ms-studio-deploy）',
        },
      },
    },
    async execute(rawArgs) {
      const names = rawArgs?.names?.length ? rawArgs.names : cfg.skillsNames;
      await mkdir(cfg.skillsDir, { recursive: true });
      const tmp = join(homedir(), '.cache', 'ms-skills-git');
      await run(['bash', '-c', `rm -rf "${tmp}" && git clone --depth 1 "${cfg.skillsRepo}" "${tmp}"`], { timeoutMs: 120_000 });
      const results = [];
      for (const n of names) {
        const src = join(tmp, 'skills', n);
        try { await stat(join(src, 'SKILL.md')); } catch {
          results.push({ name: n, ok: false, message: '仓库中不存在该 skill' });
          continue;
        }
        await run(['bash', '-c', `rm -rf "${join(cfg.skillsDir, n)}" && cp -r "${src}" "${cfg.skillsDir}/"`], { timeoutMs: 30_000 });
        results.push({ name: n, ok: true, message: `已安装到 ${join(cfg.skillsDir, n)}` });
      }
      await run(['bash', '-c', `rm -rf "${tmp}"`]);
      return { skillsDir: cfg.skillsDir, results };
    },
    output: {
      schema: {
        type: 'object',
        required: ['skillsDir', 'results'],
        properties: {
          skillsDir: { type: 'string' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              required: ['name', 'ok'],
              properties: {
                name: { type: 'string' },
                ok: { type: 'boolean' },
                message: { type: 'string' },
              },
            },
          },
        },
      },
      render(result) {
        const lines = [`skill 目录: ${result.skillsDir}`];
        for (const r of result.results ?? []) {
          lines.push(`  ${r.ok ? '✅' : '❌'} ${r.name}: ${r.message}`);
        }
        return text(lines.join('\n'));
      },
    },
  });
}