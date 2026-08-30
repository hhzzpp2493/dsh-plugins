// dsh-cloud-server tools — 把「连接云服务器」封装成 dsh 工具：
//   cloud_ssh     在云服务器上执行任意 shell 命令
//   cloud_status  一键检查云服务器 dsh 全套服务健康状态
// 凭据通过 bundle config 或环境变量提供，不写死在代码里：
//   host    -> config.host    ?? DSH_CLOUD_HOST        （必填）
//   user    -> config.user    ?? DSH_CLOUD_USER ?? 'ubuntu'
//   port    -> config.port    ?? DSH_CLOUD_PORT ?? 22
//   keyPath -> config.keyPath ?? DSH_CLOUD_KEY  ?? ~/.ssh/id_ed25519_dsh
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

export const name = 'dsh-cloud-server';
export const inject = ['tools'];

// ---------------------------------------------------------------- helpers

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

function numArg(args, key, tool, { fallback } = {}) {
  const value = args[key];
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${tool}: "${key}" must be a positive integer`);
  return n;
}

function loadConfig(config = {}) {
  return {
    host: config.host ?? process.env.DSH_CLOUD_HOST,
    user: config.user ?? process.env.DSH_CLOUD_USER ?? 'ubuntu',
    port: config.port ?? Number(process.env.DSH_CLOUD_PORT ?? 22),
    keyPath: config.keyPath ?? process.env.DSH_CLOUD_KEY ?? join(os.homedir(), '.ssh', 'id_ed25519_dsh'),
  };
}

function runSsh(cfg, remoteCmd, opts = {}) {
  const common = [
    '-F', '/dev/null',
    '-i', cfg.keyPath,
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=30',
    '-p', String(cfg.port),
  ];
  const dest = `${cfg.user}@${cfg.host}`;
  const res = spawnSync('ssh', [...common, dest, remoteCmd], {
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 300_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw new Error(`ssh 失败: ${res.error.message}`);
  return { status: res.status ?? -1, stdout: (res.stdout || '').trim(), stderr: (res.stderr || '').trim() };
}

function requireCfg(cfg, tool) {
  if (!cfg.host) throw new Error(`${tool}: 未配置云服务器地址（config.host 或环境变量 DSH_CLOUD_HOST）`);
  if (!existsSync(cfg.keyPath)) {
    throw new Error(
      `${tool}: SSH 私钥不存在 ${cfg.keyPath}（config.keyPath 或 DSH_CLOUD_KEY）。` +
      `在 bundle 配置里指向本机的密钥文件，例如 /home/hzp/deepseek/server-key.pem。`
    );
  }
}

// ------------------------------------------------------------- tool defs

function registerCloudTools(ctx, config = {}) {
  const cfg = loadConfig(config);

  ctx.tools.register({
    name: 'cloud_ssh',
    description:
      '通过 SSH 在云服务器上执行一条 shell 命令并返回输出（stdout/stderr/退出码）。' +
      '连接参数来自 bundle 配置或环境变量 DSH_CLOUD_HOST / DSH_CLOUD_USER / DSH_CLOUD_PORT / DSH_CLOUD_KEY。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['command'],
      properties: {
        command: {
          type: 'string',
          description: '要在云服务器上执行的 shell 命令，例如 "systemctl status dsh --no-pager | head -20"。',
        },
        timeout_ms: {
          type: 'integer',
          description: '可选，命令超时毫秒数（缺省 300000 = 5 分钟）。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'exit_code'],
        properties: {
          ok: { type: 'boolean' },
          exit_code: { type: 'integer' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
        },
      },
      render: (_args, raw) => {
        if (raw.stderr && raw.exit_code !== 0) {
          return text('cloud_ssh', `退出码 ${raw.exit_code}\n--- stderr ---\n${raw.stderr}\n--- stdout ---\n${raw.stdout || '(空)'}`);
        }
        return text('cloud_ssh', raw.exit_code === 0 ? raw.stdout || '(命令执行成功，无输出)' : `退出码 ${raw.exit_code}:\n${raw.stdout || raw.stderr || '(无输出)'}`);
      },
    },
    async execute(rawArgs) {
      const args = objArgs(rawArgs, 'cloud_ssh');
      const command = strArg(args, 'command', 'cloud_ssh', { required: true });
      requireCfg(cfg, 'cloud_ssh');
      const timeoutMs = numArg(args, 'timeout_ms', 'cloud_ssh', { fallback: 300_000 });
      const res = runSsh(cfg, command, { timeoutMs });
      return { ok: res.status === 0, exit_code: res.status, stdout: res.stdout, stderr: res.stderr };
    },
  });

  ctx.tools.register({
    name: 'cloud_status',
    description:
      '一键检查云服务器 dsh 全套服务健康状态：dsh web / nginx / 飞书桥 / relay 中转是否在跑，' +
      '公网 web 是否可访问，以及磁盘/内存占用。用于快速判断云服务器 dsh 是否出问题。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {
        web_url: {
          type: 'string',
          description: '可选，公网 web 地址（如 https://1.14.169.244:38669）。不提供则只做 SSH 内检查。',
        },
        web_user: { type: 'string', description: '可选，web 登录用户名（用于验证登录是否正常）。' },
        web_pass: { type: 'string', description: '可选，web 登录密码。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          services: {
            type: 'array',
            items: { type: 'object', additionalProperties: true },
          },
          web: { type: 'object', additionalProperties: true },
          disk: { type: 'string' },
          memory: { type: 'string' },
        },
      },
      render: (_args, raw) => {
        const lines = raw.services.map(
          (s) => `  ${s.ok ? '✅' : '❌'} ${s.name}: ${s.detail ?? s.status ?? '?'}`
        );
        let webLine = '  web: 未检查';
        if (raw.web) webLine = `  ${raw.web.ok ? '✅' : '❌'} web(${raw.web.url}): HTTP ${raw.web.http_code ?? '?'}`;
        return text(
          'cloud_status',
          `云服务器状态:\n${lines.join('\n')}\n${webLine}\n  💾 磁盘: ${raw.disk}\n  🧠 内存: ${raw.memory}`
        );
      },
    },
    async execute(rawArgs) {
      const args = objArgs(rawArgs, 'cloud_status');
      requireCfg(cfg, 'cloud_status');
      const webUrl = strArg(args, 'web_url', 'cloud_status');
      const webUser = strArg(args, 'web_user', 'cloud_status');
      const webPass = strArg(args, 'web_pass', 'cloud_status');

      const script = `
set -u
echo "=== services ==="
for u in dsh.service dsh-feishu-cli-bridge.service sensenova-relay.service nginx.service; do
  st=$(systemctl is-active "$u" 2>/dev/null || echo inactive)
  echo "$u|$st"
done
echo "=== disk ==="
df -h / | tail -1
echo "=== mem ==="
free -h | head -2
`;
      const res = runSsh(cfg, script, { timeoutMs: 60_000 });

      const services = [];
      let disk = '?', memLines = '';
      for (const line of res.stdout.split('\n')) {
        if (line.includes('|') && !line.startsWith('===')) {
          const [name, status] = line.split('|');
          services.push({
            name: name.replace('.service', ''),
            status,
            ok: status === 'active',
            detail: status === 'active' ? '运行中' : status,
          });
        } else if (line.includes('/dev/')) {
          disk = line.trim();
        } else if (line.startsWith('Mem:')) {
          memLines += line.trim() + ' ';
        }
      }
      if (!services.length && res.status !== 0) {
        throw new Error(`cloud_status: SSH 检查失败（退出码 ${res.status}）：${res.stderr || res.stdout}`);
      }

      let web = undefined;
      if (webUrl) {
        const authArgs = webUser && webPass
          ? ['-u', `${webUser}:${webPass}`]
          : [];
        const webProbe = spawnSync('curl', ['-sk', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '10', ...authArgs, webUrl], {
          encoding: 'utf8',
          timeout: 20_000,
        });
        const code = webProbe.stdout?.trim() || String(webProbe.status ?? 'ERR');
        web = { url: webUrl, http_code: code, ok: code === '200' };
      }

      return {
        ok: services.every((s) => s.ok) && (!web || web.ok),
        services,
        web,
        disk,
        memory: memLines.trim(),
      };
    },
  });
}

export function apply(ctx, config = {}) {
  registerCloudTools(ctx, config);
}