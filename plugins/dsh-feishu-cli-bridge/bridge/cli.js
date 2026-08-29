// Thin wrapper around the official @larksuite/cli binary.
// All Feishu/Lark API access goes through `lark-cli` (official CLI).
import { spawn, spawnSync } from 'node:child_process';

export function resolveCliBin() {
  const bin = process.env.DSH_FEISHU_CLI_BIN?.trim();
  if (bin) return bin;
  return 'lark-cli';
}

/**
 * Run `lark-cli <args>` synchronously and return its stdout.
 * Throws with a readable message on spawn failure or non-zero exit.
 */
export function runLarkCli(args, { cwd, timeoutMs = 120_000, input } = {}) {
  const res = spawnSync(resolveCliBin(), args, {
    cwd,
    input,
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
export function spawnLarkCli(args, opts = {}) {
  return spawn(resolveCliBin(), args, { stdio: ['pipe', 'pipe', 'pipe'], ...opts });
}

/**
 * Async variant of runLarkCli. MUST be used inside agent tool bodies: the
 * blocking spawnSync freezes the runtime's event loop and stalls the SDK
 * JSON-RPC channel, so agent tool executors must stay async.
 */
export function runLarkCliAsync(args, { cwd, timeoutMs = 120_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(resolveCliBin(), args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
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