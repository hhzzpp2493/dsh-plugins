// Supervises `lark-cli event consume im.message.receive_v1 --as bot`:
// - parses the NDJSON event stream on stdout
// - emits 'event' for each parsed event
// - restarts with exponential backoff unless stopped
import { EventEmitter } from 'node:events';
import { spawnLarkCli } from './cli.js';

export class EventConsumer extends EventEmitter {
  constructor({ eventKey = 'im.message.receive_v1', identity = 'bot', logger = console } = {}) {
    super();
    this.eventKey = eventKey;
    this.identity = identity;
    this.logger = logger;
    this.child = null;
    this.stopping = false;
    this.backoffMs = 1_000;
    this.restartTimer = undefined;
  }

  start() {
    if (this.stopping) return;
    this.logger.log(`[consumer] start lark-cli event consume ${this.eventKey} (--as ${this.identity})`);
    const child = spawnLarkCli(['event', 'consume', this.eventKey, '--as', this.identity]);
    this.child = child;
    let buf = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        if (line.startsWith('[')) continue; // marker/diagnostic lines
        try {
          const ev = JSON.parse(line);
          this.emit('event', ev);
        } catch {
          this.logger.warn(`[consumer] unparsable NDJSON line: ${line.slice(0, 300)}`);
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      for (const raw of chunk.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        this.logger.log(`[consumer:stderr] ${line}`);
        if (line.includes('[event] ready')) {
          this.backoffMs = 1_000;
          this.emit('ready');
        }
        if (line.startsWith('{')) {
          try {
            this.emit('fatal-error', JSON.parse(line));
          } catch {
            // ignore
          }
        }
      }
    });

    child.on('error', (err) => {
      this.logger.warn(`[consumer] spawn error: ${err.message}`);
      this.child = null;
      this.scheduleRestart();
    });

    child.on('exit', (code, signal) => {
      this.child = null;
      this.logger.log(`[consumer] exited code=${code} signal=${signal ?? ''}`);
      if (!this.stopping) this.scheduleRestart();
    });

    return this;
  }

  scheduleRestart() {
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    this.logger.log(`[consumer] restart scheduled in ${delay}ms`);
    this.restartTimer = setTimeout(() => this.start(), delay);
  }

  async stop() {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    const child = this.child;
    if (!child) return;
    // stdin EOF triggers a graceful exit for unbounded consumers.
    try {
      child.stdin.end();
    } catch {
      // ignore
    }
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (this.child) {
      try {
        this.child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
  }
}