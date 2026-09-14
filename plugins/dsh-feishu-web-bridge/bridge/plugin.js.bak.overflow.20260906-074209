// dsh-feishu-web-bridge as a cordis plugin: runs INSIDE the `dsh --profile web`
// process and relays Feishu messages into the SAME web sessions. The Feishu
// side is a pure shell (send/receive); sessions, models, agent presets and
// archiving all belong to the web side.
//
// Install: put this package in $DSH_HOME/profiles/node_modules and insert it
// into the web profile's cordis.patch.yml (same as the tavily/github-toolkit
// entries). All bridge memory lives under $DSH_HOME/storages.
import { FeishuWebBridgeEngine, loadConfig } from './engine.js';

export const name = 'dsh-feishu-web-bridge';

/** Host services this plugin needs (all provided by the web profile). */
export const inject = [
  'agents',
  'sessions',
  'workspaceRegistry',
  'agentDefaultModel',
  'agentPresets',
];

export function apply(ctx, config = {}, deps = {}) {
  const logger = deps.logger ?? ctx.logger ?? console;
  const loggerWrap = {
    log: (...a) => safeInfo(logger, ...a),
    warn: (...a) => safeWarn(logger, ...a),
    error: (...a) => safeError(logger, ...a),
  };

  const effective = loadConfig(process.env, normalizeConfig(config));
  let engine;
  let startPromise;
  let stopped = false;

  const start = () => {
    if (startPromise) return startPromise;
    startPromise = (async () => {
      engine = new FeishuWebBridgeEngine({ ctx, config: effective, logger: loggerWrap });
      await engine.start();
    })().catch((error) => {
      startPromise = undefined;
      loggerWrap.error('engine start failed:', error);
      throw error;
    });
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
      try {
        await engine.stop();
      } catch (error) {
        loggerWrap.warn('engine stop failed:', error);
      }
      engine = undefined;
    }
  };

  // Optional live settings (dsh Web → Settings → Plugins page), fully guarded.
  if (typeof ctx.inject === 'function' && !deps.skipSettings) {
    void (async () => {
      try {
        const schemaModule = await import('@deepseek-ai/schemastery');
        const settingsModule = await import('@deepseek-ai/dsh-settings');
        const SchemaObj = schemaModule.default ?? schemaModule.Schema ?? schemaModule;
        const settingsNamespaceFn = settingsModule.settingsNamespace;
        if (!SchemaObj?.object || !settingsNamespaceFn) return;
        const Config = SchemaObj.object({
          workspace: SchemaObj.string().description('Web-side folder that owns Feishu sessions (under $DSH_HOME by default)'),
          mediaDir: SchemaObj.string().description('Where Feishu chat attachments are downloaded'),
          cliBin: SchemaObj.string().description('lark-cli binary path (default: lark-cli on PATH)'),
          cliHome: SchemaObj.string().description('Home directory holding ~/.lark-cli credentials'),
          sendAck: SchemaObj.boolean().description('Send "收到，正在处理…" ack before processing'),
          archiveInactiveDays: SchemaObj.number().integer().min(0).description('Auto-archive sessions idle for N days (0 = off)'),
          archiveRetentionDays: SchemaObj.number().integer().min(0).description('Physically delete archived feishu sessions older than N days (0 = keep forever)'),
          archiveKeepPerChat: SchemaObj.number().integer().min(1).description('Max archived sessions remembered per chat for cleanup'),
          showStats: SchemaObj.boolean().description('Show usage/model footer at the bottom of reply cards'),
        });
        const namespace = settingsNamespaceFn('dsh-feishu-web-bridge');
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
        // settings unavailable: env/config only
      }
    })();
  }

  const reload = async (nextConfig) => {
    await stop();
    const next = loadConfig(process.env, normalizeConfig(nextConfig));
    Object.assign(effective, next);
    if (!stopped) void start().catch((error) => loggerWrap.error('reload start failed:', error));
  };

  try {
    safeInfo(logger, `[feishu-web-bridge] loaded (workspace=${effective.workspace}, inboxDays=${effective.archiveInactiveDays})`);
  } catch {
    // some loggers swallow extra args
  }

  const disabled = config.disabled === true || process.env.DSH_FEISHU_DISABLED === '1';
  if (!disabled) void start().catch((error) => loggerWrap.error('delayed start failed:', error));

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