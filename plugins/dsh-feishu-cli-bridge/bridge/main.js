// Standalone runner for the bridge engine (dev/debug). The production path is
// the cordis plugin: `dsh --profile feishu-bridge` (see bridge/plugin.js).
import { FeishuBridgeEngine, loadConfig, makeLogger } from './engine.js';

const config = loadConfig();
const log = makeLogger('[bridge]');
log.log('config:', JSON.stringify({ ...config, notifyToken: '<redacted>' }));

const engine = new FeishuBridgeEngine(config, log);
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.log(`received ${signal}; shutting down`);
  await engine.stop();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

engine.start().catch((error) => {
  log.error('engine start failed:', error);
  process.exit(1);
});