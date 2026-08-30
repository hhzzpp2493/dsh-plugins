// dsh-maintain tools: maintain_status / maintain_now / maintain_log.
// Everything is best-effort and read-only except maintain_now (which may
// restart the web process). No dsh-internal imports: Node builtins only.
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const name = 'dsh-maintain';
export const inject = ['tools'];

const DEFAULT_CONFIG = {
  // local
  maintainScript: '/home/hzp/deepseek/dsh-maintain.sh',
  maintainLog: '/home/hzp/.dsh/storages/dsh-maintain.log',
  repoRoot: '/home/hzp/deepseek/dsh-plugins',
  repoPlugin: '/home/hzp/deepseek/dsh-plugins/plugins/dsh-feishu-web-bridge',
  dstPlugin: '/home/hzp/.dsh/profiles/node_modules/dsh-feishu-web-bridge',
  webUrl: 'http://127.0.0.1:3080/',
  // cloud (optional; disabled when host is empty)
  cloudHost: '1.14.169.244',
  cloudUser: 'ubuntu',
  cloudKey: '/home/hzp/deepseek/server-key.pem',
  cloudRepoPlugin: '/home/ubuntu/.dsh/profiles/.dsh-plugins-src/dsh-plugins/plugins/dsh-feishu-web-bridge',
  cloudWebUrl: 'http://127.0.0.1:38670/',
  // tool behavior
  logLines: 30,
  nowTimeoutMs: 120_000,
};

function text(value) {
  return [{ type: 'text', text: String(value) }];
}

/** Async spawn; resolves {ok, code, stdout, stderr}. */
function run(args, { cwd, timeoutMs = 20_000, env } = {}) {
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

/** One short ssh round-trip (best-effort). -F /dev/null: never trip on host ssh_config permission issues. */
async function sshFor(cfg, command) {
  if (!cfg.cloudHost || !cfg.cloudUser || !cfg.cloudKey) return { ok: false, note: 'cloud 未配置' };
  const args = [
    'ssh', '-F', '/dev/null',
    '-i', cfg.cloudKey,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=8',
    '-o', 'BatchMode=yes',
    `${cfg.cloudUser}@${cfg.cloudHost}`,
    command,
  ];
  return run(args, { timeoutMs: 20_000 });
}

async function repoCommit(root) {
  const r = await run(['git', '-C', root, 'log', '--oneline', '-1']);
  return r.ok ? r.stdout.trim() : '(git 不可用)';
}

/** Byte-level parity between two plugin copies (diff exit code based). */
async function pluginParity(repo, dst) {
  const r = await run(['bash', '-c', `diff -rq --exclude=.git --exclude=node_modules "${repo}" "${dst}" >/dev/null 2>&1; echo $?`]);
  const code = r.stdout.trim();
  if (code === '0') return '一致';
  if (code === '1') return '❌ 有差异（建议 maintain_now 或 manual 同步）';
  return `无法判断（${code}：dst 可能不存在或路径错误）`;
}

async function webCode(url) {
  const r = await run(['curl', '-s', '-m', '5', '-o', '/dev/null', '-w', '%{http_code}', url]);
  return r.ok ? r.stdout.trim() || '(无响应)' : '(web 未监听)';
}

async function consumerCount() {
  // Count the REAL consumer process (the @larksuite/cli binary), not the
  // node shim+child pair. The [e] trick stops pgrep matching its own cmdline.
  const r = await run(['bash', '-c', "pgrep -f '@larksuite/cli/bin/lark-cli [e]vent consume' | wc -l"]);
  return r.ok ? r.stdout.trim() : '0';
}

async function cronRegistered(marker) {
  const r = await run(['bash', '-c', `crontab -l 2>/dev/null | grep -c '${marker}' || true`]);
  if (!r.ok) return '检查失败';
  return r.stdout.trim();
}

async function tailLog(logPath, lines) {
  try {
    const r = await run(['tail', '-n', String(lines), logPath]);
    if (r.ok) return r.stdout.trim();
    return `日志不可读：${r.stderr.trim().slice(0, 200)}`;
  } catch {
    return '日志不可读';
  }
}

async function logMeta(logPath) {
  try {
    const s = await stat(logPath);
    return `大小 ${s.size}B，修改于 ${new Date(s.mtimeMs).toLocaleString('zh-CN', { hour12: false })}`;
  } catch {
    return '（尚无维护日志）';
  }
}

function bytesHash(path) {
  return readFile(path, 'utf8').then(
    (c) => `${c.length}B`,
    () => '?',
  );
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(config ?? {}) };

  ctx.tools.register({
    name: 'maintain_status',
    description:
      '查看 dsh 双端维护状态：本地（总库 commit、飞书插件副本一致性、web 存活、lark consumer、cron 定时、上次维护日志）与云上（commit、consumer、web，经 ssh 尽力探测）。适合回答"插件是不是最新的/两边一致吗/维护正常吗"。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output: { schema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' }, status: { type: 'string' } } } },
    async execute() {
      const lines = [];
      lines.push(`## 本地（本机）`);
      lines.push(`- 总库 commit: ${await repoCommit(cfg.repoRoot)}`);
      lines.push(`- 飞书插件 总库↔部署: ${await pluginParity(cfg.repoPlugin, cfg.dstPlugin)}`);
      lines.push(`- web(${cfg.webUrl}): ${await webCode(cfg.webUrl)}`);
      lines.push(`- lark consumer 数: ${await consumerCount('lark-cli [e]vent consume')}`);
      lines.push(`- cron 维护已注册: ${(await cronRegistered('dsh-maintain')) === '0' ? '❌ 未注册' : ((await cronRegistered('dsh-maintain')) === '检查失败' ? '检查失败' : '✅ 已注册（每天 03:37）')}`);
      lines.push(`- 维护日志: ${await logMeta(cfg.maintainLog)}`);
      const tail = await tailLog(cfg.maintainLog, 6);
      if (tail) lines.push(`  └ 最近：\n${tail.split('\n').map((l) => `    ${l}`).join('\n')}`);

      const remote = await sshFor(cfg, [
        `echo "commit=$(git -C ${cfg.cloudRepoPlugin} log --oneline -1 2>/dev/null || git -C $(dirname $(dirname $(dirname ${cfg.cloudRepoPlugin}))) log --oneline -1 2>/dev/null || echo '?')"`,
        `echo "consumer=$(pgrep -f '@larksuite/cli/bin/lark-cli [e]vent consume' | wc -l)"`,
        `echo "web=$(curl -s -m 5 -o /dev/null -w '%{http_code}' ${cfg.cloudWebUrl})"`,
        `echo "engine=$([ -f ${cfg.cloudRepoPlugin}/bridge/engine.js ] && wc -c < ${cfg.cloudRepoPlugin}/bridge/engine.js || echo '?')"`,
      ].join('; '));
      if (remote.ok && remote.stdout) {
        const r = remote.stdout.trim().split('\n').map((l) => l.trim().replace(/^commit=/, 'commit: ').replace(/^consumer=/, 'consumer 数: ').replace(/^web=/, 'web: ').replace(/^engine=/, 'engine.js 大小: '));
        lines.push('', `## 云上（${cfg.cloudUser}@${cfg.cloudHost}）`);
        lines.push(...r.map((l) => `- ${l}`));
      } else {
        lines.push('', `## 云上（skipped）`);
        lines.push(`- ${remote.ok ? remote.stdout.trim() : (remote.note ?? ((remote.stderr || '').trim().slice(0, 200) || 'ssh 探测失败'))}`);
      }

      const status = lines.join('\n');
      return { ok: true, status };
    },
  });

  ctx.tools.register({
    name: 'maintain_now',
    description:
      '立即执行一次完整维护（等价于手动跑 dsh-maintain.sh）：拉取总库 → 同步飞书插件部署副本 → 检查 dsh 核心版本 → 有变更时重启 web（会短暂断连）→ 健康检查。耗时最长约 2 分钟。执行前如需先看状态请用 maintain_status。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: { ok: { type: 'boolean' }, exitCode: { type: 'number' }, output: { type: 'string' } },
      },
    },
    async execute() {
      const r = await run(['bash', cfg.maintainScript], { timeoutMs: cfg.nowTimeoutMs });
      const out = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n').slice(-3000);
      const ok = r.ok;
      return { ok, exitCode: r.code ?? -1, output: out || (ok ? '维护完成，无输出' : '维护失败，无输出') };
    },
  });

  ctx.tools.register({
    name: 'maintain_log',
    description: `读取 dsh 维护日志（${cfg.maintainLog}）最近 ${cfg.logLines} 行，排查自动维护是否正常、最近一次同步/重启结果。`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        lines: { type: 'integer', minimum: 1, maximum: 200, description: '读取行数（默认 30，最大 200）' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: { ok: { type: 'boolean' }, lines: { type: 'integer' }, log: { type: 'string' } },
      },
    },
    async execute(rawArgs) {
      const limit = Math.min(200, Math.max(1, Number(rawArgs?.lines) || cfg.logLines));
      const log = await tailLog(cfg.maintainLog, limit);
      return { ok: true, lines: limit, log };
    },
  });
}