// Thin wrapper around the official @larksuite/cli binary.
// All Feishu/Lark API access goes through `lark-cli` (official CLI).
// `cliHome` override: lark-cli keeps its state (config.json, events, locks)
// under $HOME/.lark-cli, so every spawn carries HOME=cliHome to find the
// right credentials regardless of the host process's HOME (the dsh web
// process runs with HOME=/home/hzp while the lark-cli state lives under
// /home/hzp/deepseek, for example).
import { spawn, spawnSync } from 'node:child_process';

export function resolveCliBin() {
  const bin = process.env.DSH_FEISHU_CLI_BIN?.trim();
  if (bin) return bin;
  return 'lark-cli';
}

/** Build the child env for a lark-cli spawn: inherited env + HOME override. */
export function cliEnv({ cliHome } = {}) {
  if (!cliHome) return process.env;
  return { ...process.env, HOME: cliHome };
}

/**
 * Run `lark-cli <args>` synchronously and return its stdout.
 * Throws with a readable message on spawn failure or non-zero exit.
 */
export function runLarkCli(args, { cwd, timeoutMs = 120_000, input, cliBin, cliHome } = {}) {
  const res = spawnSync(cliBin || resolveCliBin(), args, {
    cwd,
    input,
    env: cliEnv({ cliHome }),
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (res.error) {
    const err = new Error(`lark-cli ${args[0] ?? ''} spawn failed: ${res.error.message}`);
    err.cause = res.error;
    err.exitCode = undefined;
    throw err;
  }
  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout || '').trim().slice(0, 4000);
    const err = new Error(`lark-cli ${args.join(' ').slice(0, 120)} exited ${res.status}: ${detail}`);
    err.exitCode = res.status;
    throw err;
  }
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', status: res.status };
}

/** Spawn a long-running lark-cli process (e.g. `event consume`). */
export function spawnLarkCli(args, { cliBin, cliHome } = {}, opts = {}) {
  return spawn(cliBin || resolveCliBin(), args, { stdio: ['pipe', 'pipe', 'pipe'], env: cliEnv({ cliHome }), ...opts });
}

/** Async variant of runLarkCli (non-blocking; safe inside agent tool bodies). */
export function runLarkCliAsync(args, { cwd, timeoutMs = 120_000, cliBin, cliHome } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cliBin || resolveCliBin(), args, {
      cwd,
      env: cliEnv({ cliHome }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error(`lark-cli ${args[0] ?? ''} timed out after ${timeoutMs}ms`));
        }, timeoutMs)
      : undefined;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`lark-cli ${args[0] ?? ''} spawn failed: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise({ stdout, stderr, status: code });
      } else {
        const detail = (stderr || stdout || '').trim().slice(0, 4000);
        reject(new Error(`lark-cli ${args.join(' ').slice(0, 120)} exited ${code}: ${detail}`));
      }
    });
  });
}