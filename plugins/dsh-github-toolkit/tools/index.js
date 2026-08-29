// dsh-github-toolkit tools — registers gh_publish_plugin / gh_sync_plugins / gh_new_plugin
// so the dsh agent can publish plugin directories to the user's GitHub account and
// install/sync them on any DSH_HOME, without re-walking the manual flow.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, basename, resolve as resolvePath } from 'node:path';
import os from 'node:os';

export const name = 'dsh-github-toolkit';
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

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env || {}) },
    cwd: opts.cwd,
    timeout: opts.timeout ?? 300_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.error && !opts.soft) throw new Error(`${cmd} failed: ${res.error.message}`);
  return { status: res.status, stdout: (res.stdout || '').trim(), stderr: (res.stderr || '').trim(), error: res.error ?? null };
}

function loadConfig(config = {}) {
  return {
    user: config.user ?? process.env.DSH_GH_USER,
    keyPath: config.keyPath ?? process.env.DSH_GH_KEY ?? join(os.homedir(), '.ssh', 'id_ed25519_dsh'),
    pat: config.pat ?? process.env.DSH_GH_PAT,
    branch: config.branch ?? 'main',
    plugins: Array.isArray(config.plugins) && config.plugins.length
      ? config.plugins
      : (process.env.DSH_GH_PLUGINS
          ? process.env.DSH_GH_PLUGINS.split(',').map((s) => s.trim()).filter(Boolean)
          : ['dsh-feishu-cli-bridge', 'dsh-web-search-tavily', 'dsh-github-toolkit']),
  };
}

function gitSSHEnv(cfg) {
  const knownHosts = join(dirname(cfg.keyPath), 'known_hosts');
  return {
    GIT_SSH_COMMAND: `ssh -F /dev/null -i ${cfg.keyPath} -o IdentitiesOnly=yes -o UserKnownHostsFile=${knownHosts}`,
  };
}

function httpsUrl(cfg, repo) {
  return `https://github.com/${cfg.user}/${repo}.git`;
}
function sshUrl(cfg, repo) {
  return `git@github.com:${cfg.user}/${repo}.git`;
}

/** 仓库在 GitHub 上是否已存在。先试 HTTPS（匿名）；HTTPS 网络不稳（如国内网络 github.com 超时）时改用 SSH 探测。 */
function repoExists(cfg, repo) {
  const branch = cfg.branch ?? 'main';
  const https = run('git', ['ls-remote', '--exit-code', '--heads', httpsUrl(cfg, repo), branch], { timeout: 20_000, soft: true });
  if (https.status === 0 || https.status === 2) return true; // 0=有分支, 2=空仓库但可达
  if (https.status === 128) return false; // 确定不存在
  const ssh = run('git', ['ls-remote', '--exit-code', '--heads', sshUrl(cfg, repo), branch], { env: gitSSHEnv(cfg), timeout: 30_000, soft: true });
  return ssh.status === 0 || ssh.status === 2; // SSH 可达即存在；128=不存在
}

async function createRepoViaApi(cfg, { name, description, private: isPrivate, branch }) {
  if (!cfg.pat) return { created: false, reason: 'no-pat' };
  const res = await fetch('https://api.github.com/user/repos', {
    method: 'POST',
    headers: {
      authorization: `token ${cfg.pat}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      name, description: description ?? '', private: !!isPrivate, default_branch: branch,
    }),
  });
  if (res.status === 422) return { created: false, reason: 'exists' };
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { created: false, reason: `api-${res.status}`, detail: body?.message };
  return { created: true, url: body.html_url ?? `https://github.com/${cfg.user}/${name}` };
}

// ------------------------------------------------------------ core logic

/** 发布/更新一个插件目录到 GitHub。repo 不存在时：有 PAT 自动建；没有则返回提示。 */
export async function publishPlugin(cfg, opts) {
  const branch = cfg.branch ?? 'main';
  const pluginDir = resolvePath(opts.pluginDir);
  const pkgFile = join(pluginDir, 'package.json');
  if (!existsSync(pkgFile)) throw new Error(`gh_publish_plugin: ${pluginDir} 里没有 package.json（不是插件目录）`);
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
  const repo = opts.repoName ?? pkg.name;
  if (!/^[A-Za-z0-9_.-]+$/.test(repo)) throw new Error(`gh_publish_plugin: 非法仓库名 "${repo}"`);
  if (!cfg.user) throw new Error('gh_publish_plugin: 未配置 GitHub 用户名（config.user 或 DSH_GH_USER）');
  if (!existsSync(cfg.keyPath)) throw new Error(`gh_publish_plugin: SSH 私钥不存在 ${cfg.keyPath}（config.keyPath 或 DSH_GH_KEY）`);

  // 1. 确保是 git 仓库并写好身份
  if (!existsSync(join(pluginDir, '.git'))) {
    const init = run('git', ['init', '-b', branch], { cwd: pluginDir });
    if (init.status !== 0) throw new Error(`gh_publish_plugin: git init 失败: ${init.stderr}`);
  }
  run('git', ['config', 'user.name', cfg.user], { cwd: pluginDir });
  run('git', ['config', 'user.email', `${cfg.user}@users.noreply.github.com`], { cwd: pluginDir });

  // 2. 仓库不存在则创建
  let repoUrl = `https://github.com/${cfg.user}/${repo}`;
  let created = false;
  if (!repoExists(cfg, repo)) {
    const outcome = await createRepoViaApi(cfg, {
      name: repo,
      description: opts.description ?? pkg.description ?? '',
      private: !!opts.private,
      branch,
    });
    if (!outcome.created) {
      if (outcome.reason === 'no-pat') {
        return {
          ok: false, created: false, repoUrl,
          hint: `仓库 ${repo} 还不存在且未配置 DSH_GH_PAT。请在 https://github.com/new 创建空仓库后重跑本工具`,
        };
      }
      if (outcome.reason !== 'exists') throw new Error(`gh_publish_plugin: 建仓库失败: ${outcome.detail ?? outcome.reason}`);
    } else {
      created = true;
      repoUrl = outcome.url;
    }
  }

  // 3. remote + 提交 + 推送（全部走 SSH 私钥，无需令牌）
  run('git', ['remote', 'remove', 'origin'], { cwd: pluginDir });
  run('git', ['remote', 'add', 'origin', sshUrl(cfg, repo)], { cwd: pluginDir });
  run('git', ['add', '-A'], { cwd: pluginDir });
  const changed = run('git', ['diff', '--cached', '--quiet'], { cwd: pluginDir }).status !== 0;
  if (changed) {
    const msg = opts.commitMessage ?? `update: ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
    const commit = run('git', ['commit', '-m', msg], { cwd: pluginDir, env: gitSSHEnv(cfg) });
    if (commit.status !== 0 && !/nothing to commit/.test(commit.stdout + commit.stderr)) {
      throw new Error(`gh_publish_plugin: commit 失败: ${commit.stderr || commit.stdout}`);
    }
  }
  const push = run('git', ['push', '-u', 'origin', branch], { cwd: pluginDir, env: gitSSHEnv(cfg), timeout: 180_000 });
  if (push.status !== 0) throw new Error(`gh_publish_plugin: push 失败: ${push.stderr}`);
  return { ok: true, created, repoUrl, pushed: changed || created, branch };
}

/** 把配置的插件列表 clone/pull 到 <dshHome>/profiles/node_modules 回退目录，并装依赖。 */
export async function syncPlugins(cfg, dshHome, userOverride) {
  const branch = cfg.branch ?? 'main';
  const user = userOverride ?? cfg.user;
  if (!user) throw new Error('gh_sync_plugins: 未配置 GitHub 用户名（config.user / DSH_GH_USER / 参数 user）');
  const fallback = join(dshHome, 'profiles', 'node_modules');
  const results = [];
  for (const repo of cfg.plugins) {
    const pkgDir = join(fallback, ...repo.split('/'));
    try {
      if (!existsSync(join(pkgDir, '.git'))) {
        mkdirSync(dirname(pkgDir), { recursive: true });
        const clone = run('git', ['clone', '-b', branch, '--depth', '1', httpsUrl(cfg, repo), pkgDir], { timeout: 180_000 });
        if (clone.status !== 0) throw new Error(clone.stderr || 'clone failed');
        results.push({ name: repo, status: 'cloned' });
      } else {
        const fetch = run('git', ['fetch', '--quiet', 'origin'], { cwd: pkgDir, timeout: 120_000 });
        if (fetch.status !== 0) throw new Error(fetch.stderr || 'fetch failed');
        const local = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: pkgDir }).stdout;
        if (local !== branch) run('git', ['checkout', '-B', branch, `origin/${branch}`], { cwd: pkgDir });
        const pull = run('git', ['pull', '--ff-only', '--quiet'], { cwd: pkgDir, timeout: 120_000 });
        if (pull.status !== 0) throw new Error(pull.stderr || 'pull failed');
        results.push({ name: repo, status: 'updated' });
      }
    } catch (err) {
      results.push({ name: repo, status: 'error', detail: err.message });
    }
  }
  return { ok: results.every((r) => r.status !== 'error'), dshHome, user, results, branch };
}

/** 生成一个标准的 dsh 插件骨架目录（cordis bundle + tools 预留），开发完可直接 gh_publish_plugin。 */
export async function scaffoldPlugin(cfg, opts) {
  const nameStr = String(opts.name || '').trim();
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(nameStr)) {
    throw new Error(`gh_new_plugin: 名字必须是小写 kebab-case（如 my-cool-plugin），收到 "${nameStr}"`);
  }
  const dir = resolvePath(opts.dir ?? join(process.cwd(), nameStr));
  mkdirSync(join(dir, 'tools'), { recursive: true });
  const pkg = {
    name: nameStr,
    version: '0.1.0',
    description: `${nameStr}: a dsh (cordis) plugin.`,
    private: false,
    type: 'module',
    main: 'plugin.js',
    exports: { '.': './plugin.js', './tools': './tools/index.js', './package.json': './package.json' },
    engines: { node: '>=22' },
    keywords: ['dsh', 'deepseek-harness', 'cordis', 'plugin'],
    license: 'MIT',
    dsh: { bundle: { patch: './bundle.patch.yml' } },
  };
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  writeFileSync(join(dir, 'plugin.js'),
    `// ${nameStr} as a cordis plugin. See tools/index.js for the agent tools pattern.
export { name, inject, apply } from './tools/index.js';
`);
  writeFileSync(join(dir, 'tools', 'index.js'),
    `// ${nameStr} tools — 参照 dsh-github-toolkit/tools/index.js 注册自己的 ctx.tools.register(...)。
export const name = '${nameStr}';
export const inject = ['tools'];
export function apply(ctx, config = {}) {
  // 例：
  // ctx.tools.register({
  //   name: '${nameStr}_hello',
  //   description: 'A sample tool.',
  //   parameters: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string' } } },
  //   output: { schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }, render: () => [{ type: 'text', text: 'hi' }] },
  //   async execute(rawArgs) { return { ok: true }; },
  // });
}
`);
  writeFileSync(join(dir, 'bundle.patch.yml'),
    `# ${nameStr} bundle patch — 让 profile 以 bundle 方式加载本插件。
- insert:
    - id: ${nameStr}
      name: '${nameStr}'
`);
  writeFileSync(join(dir, 'README.md'), `# ${nameStr}\n\nDSH (cordis) plugin. 开发完成后运行工具 gh_publish_plugin 即可发布到 GitHub。\n`);
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n*.log\n.env*\n*.pem\n*.key\n.DS_Store\n');
  return { ok: true, dir, next: '改好后对 agent 说：用 gh_publish_plugin 发布这个插件' };
}

// ------------------------------------------------------------- tool defs

function registerGithubTools(ctx, config = {}) {
  const cfg = loadConfig(config);

  ctx.tools.register({
    name: 'gh_publish_plugin',
    description:
      '把一个本地插件目录发布/更新到 GitHub 用户的仓库：自动建仓库（需 DSH_GH_PAT 配置或网页建）、git commit、SSH 推送。之后云服务器可用 gh_sync_plugins 拉取。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['plugin_dir'],
      properties: {
        plugin_dir: { type: 'string', description: '插件目录的绝对路径（须含 package.json）。' },
        repo_name: { type: 'string', description: 'GitHub 仓库名（缺省用 package.json 的 name）。' },
        description: { type: 'string', description: '仓库描述（缺省用 package.json description）。' },
        private: { type: 'boolean', description: '是否私有仓库（缺省 false = 公开）。' },
        commit_message: { type: 'string', description: '提交信息（缺省自动生成时间戳）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          created: { type: 'boolean' },
          repoUrl: { type: 'string' },
          pushed: { type: 'boolean' },
          hint: { type: 'string' },
        },
      },
      render: (_args, raw) =>
        text('gh_publish_plugin', raw.ok ? `✅ 已发布: ${raw.repoUrl} (${raw.pushed ? '有新提交' : '无变更'})` : `⚠️ ${raw.hint ?? '发布失败'}`),
    },
    async execute(rawArgs) {
      const args = objArgs(rawArgs, 'gh_publish_plugin');
      return publishPlugin(cfg, {
        pluginDir: strArg(args, 'plugin_dir', 'gh_publish_plugin', { required: true }),
        repoName: strArg(args, 'repo_name', 'gh_publish_plugin'),
        description: strArg(args, 'description', 'gh_publish_plugin'),
        private: args.private === true,
        commitMessage: strArg(args, 'commit_message', 'gh_publish_plugin'),
      });
    },
  });

  ctx.tools.register({
    name: 'gh_sync_plugins',
    description:
      '把 GitHub 上的 dsh 插件（可配置列表）安装/同步到指定 DSH_HOME 的 profiles/node_modules 回退目录：首次克隆，之后拉取更新。适合在新服务器上一键装齐插件。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['dsh_home'],
      properties: {
        dsh_home: { type: 'string', description: '目标 DSH_HOME 绝对路径（如 /home/ubuntu/.dsh）。' },
        user: { type: 'string', description: 'GitHub 用户名（缺省用配置 DSH_GH_USER）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          dshHome: { type: 'string' },
          results: {
            type: 'array',
            items: { type: 'object', additionalProperties: true },
          },
        },
      },
      render: (_args, raw) => {
        const lines = raw.results.map((r) => `  - ${r.name}: ${r.status}${r.detail ? ' (' + r.detail + ')' : ''}`);
        return text('gh_sync_plugins', `同步结果 (${raw.dshHome}):\n${lines.join('\n')}`);
      },
    },
    async execute(rawArgs) {
      const args = objArgs(rawArgs, 'gh_sync_plugins');
      return syncPlugins(cfg, strArg(args, 'dsh_home', 'gh_sync_plugins', { required: true }), strArg(args, 'user', 'gh_sync_plugins'));
    },
  });

  ctx.tools.register({
    name: 'gh_new_plugin',
    description:
      '生成一个标准 dsh (cordis) 插件骨架目录（package.json / plugin.js / tools / bundle.patch.yml / README / .gitignore），开发完成后可直接用 gh_publish_plugin 一键发布到 GitHub。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', description: '插件名，小写 kebab-case（如 my-tool）。' },
        dir: { type: 'string', description: '创建目录（缺省当前目录下的 <name>）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: { ok: { type: 'boolean' }, dir: { type: 'string' }, next: { type: 'string' } },
      },
      render: (_args, raw) => text('gh_new_plugin', `✅ 插件骨架已生成: ${raw.dir}\n下一步: ${raw.next}`),
    },
    async execute(rawArgs) {
      const args = objArgs(rawArgs, 'gh_new_plugin');
      return scaffoldPlugin(cfg, {
        name: strArg(args, 'name', 'gh_new_plugin', { required: true }),
        dir: strArg(args, 'dir', 'gh_new_plugin'),
      });
    },
  });
}

export function apply(ctx, config = {}) {
  registerGithubTools(ctx, config);
}
