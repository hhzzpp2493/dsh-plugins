// dsh-feishu-cli-bridge as a cordis plugin: loads the bridge engine
// in-process inside a dsh profile (`dsh --profile feishu-bridge` boots the
// whole Feishu bridge). The nested agent runtime is spawned on first message.
//
// Optional settings integration: when the host composition provides the
// `settings` service AND the schemastery/dsh-settings packages resolve, the
// plugin registers a namespace so dsh Web's Settings → Plugins page can
// configure workspace/model/etc. live. All optional imports are lazy so the
// bundle never blocks a profile boot.
import { FeishuBridgeEngine, loadConfig } from './engine.js';
import { appendFileSync } from 'node:fs';

export const HOST_LOG_FILE = '/home/hzp/deepseek/.dsh-feishu/engine.log';

export function logToFile(line) {
  try {
    appendFileSync(HOST_LOG_FILE, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // ignore
  }
}

export const name = 'dsh-feishu-cli-bridge';

/** No hard service dependency: the bundle must never block a profile boot. */
export const inject = [];

export function apply(ctx, config = {}, deps = {}) {
  const logger = deps.logger ?? ctx.logger ?? console;
  const loggerWrap = {
    log: (...a) => { logToFile(['info', ...a].join(' ')); safeInfo(logger, ...a); },
    warn: (...a) => { logToFile(['warn', ...a].join(' ')); safeWarn(logger, ...a); },
    error: (...a) => { logToFile(['error', ...a].join(' ')); safeError(logger, ...a); },
  };
  let engine;
  let startPromise;
  let stopped = false;

  const effective = loadConfig(process.env, normalizeConfig(config));

  const start = () => {
    if (startPromise) return startPromise;
    startPromise = (async () => {
      engine = new FeishuBridgeEngine(effective, loggerWrap);
      await engine.start();
    })();
    return startPromise;
  };

  const stop = async () => {
    if (startPromise) {
      try {
        await startPromise;
      } catch {
        // ignore start failures in teardown
      }
      startPromise = undefined;
    }
    if (engine) {
      await engine.stop();
      engine = undefined;
    }
  };

  const reload = async (nextConfig) => {
    await stop();
    const next = loadConfig(process.env, normalizeConfig(nextConfig));
    Object.assign(effective, next);
    if (!stopped) void start();
  };

  // Optional live settings (dsh Web Settings → Plugins page).
  if (typeof ctx.inject === 'function' && !deps.skipSettings) {
    void (async () => {
      try {
        const schemaModule = await import('@deepseek-ai/schemastery');
        const settingsModule = await import('@deepseek-ai/dsh-settings');
        const SchemaObj = schemaModule.default ?? schemaModule.Schema ?? schemaModule;
        const settingsNamespaceFn = settingsModule.settingsNamespace;
        if (!SchemaObj?.object || !settingsNamespaceFn) return;
        const Config = SchemaObj.object({
          profile: SchemaObj.string().description('Nested agent runtime profile name (default feishu-agent)'),
          workspace: SchemaObj.string().description('Default project folder for new agent sessions'),
          mediaDir: SchemaObj.string().description('Where Feishu chat attachments are downloaded'),
          provider: SchemaObj.string().description('LLM provider route for the agent runtime'),
          model: SchemaObj.string().description('Default model for agent runs'),
          notifyPort: SchemaObj.number().step(1).min(1).max(65535).description('Localhost callback port for the agent tools'),
          sendAck: SchemaObj.boolean().description('Send "收到，正在处理…" ack before processing'),
        });
        const namespace = settingsNamespaceFn('dsh-feishu-cli-bridge');
        ctx.inject(['settings'], async (settingsContext) => {
          const scope = settingsContext.settings.register(
            namespace,
            Config,
            { base: normalizeConfig(config), applies: 'live' },
          );
          const unwatch = scope.watch(() => void reload(scope.get()));
          settingsContext.effect(() => unwatch());
        });
      } catch {
        // settings unavailable: env config only
      }
    })();
  }

  try {
    safeInfo(logger, '[feishu-bridge] bundle loaded ' +
      `(agentProfile=${effective.profile}, workspace=${effective.workspace}, model=${effective.model})`);
  } catch {
    // some loggers swallow extra args
  }

  // Start the engine unless explicitly disabled.
  const disabled = config.disabled === true || process.env.DSH_FEISHU_DISABLED === '1';
  if (!disabled) void start();

  // Cordis disposer: stop the engine when the profile is stopped or reloaded.
  return async () => {
    stopped = true;
    await stop();
  };
}

function normalizeConfig(keys = {}) {
  const out = {};
  for (const [k, v] of Object.entries(keys)) {
    if (v !== undefined && v !== null && v !== '') out[k] = v;
  }
  return out;
}

function safeInfo(logger, ...args) { if (typeof logger.info === 'function') logger.info(...args); else logger.log(...args); }
function safeWarn(logger, ...args) { if (typeof logger.warn === 'function') logger.warn(...args); }
function safeError(logger, ...args) { if (typeof logger.error === 'function') logger.error(...args); }