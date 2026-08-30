// index.js — dsh-hierarchical-memory plugin entry.
//
// Integrates with DSH (Cordis):
//  * tools  : memory_search / memory_commit / memory_learn / memory_consolidate /
//             memory_reflect / memory_state (ctx.tools.register + defineTool)
//  * events : session/event — auto-record user/assistant exchanges, learn from
//             feedback and tool failures, run interval consolidation
//  * llm    : optional LLM reflection batch (ctx.llm) that upgrades raw
//             rule-template lessons into actionable experience and distills
//             consolidated semantic clusters; degrades to rules when disabled
//  * skills : a dynamic "evolved-playbook" provider whose content grows as the
//             procedural layer evolves (Voyager-style skill library)
//  * prompt : agent/pre-step — inject a compact salient-memory digest so recent
//             working memory + top semantic facts + top lessons guide the model
//             without bloating context

import z from "@deepseek-ai/schemastery";
import { join } from "node:path";
import { homedir } from "node:os";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

import { MemoryStore, LAYERS } from "./store.js";
import { consolidate } from "./consolidate.js";
import {
  handleUserMessage,
  handleAssistantMessage,
  handleFeedback,
  handleToolResult,
  renderPlaybook,
  buildDigest,
} from "./evolve.js";
import { registerMemoryTools } from "./tools.js";
import { runReflectionBatch } from "./reflection.js";
import { extractText } from "./text.js";

export const name = "hierarchical-memory";

export const inject = ["tools", "skills", "llm", "timer"];

export const Config = z.object({
  root: z.string(),
  autoRecord: z.boolean().default(true),
  entryMaxChars: z.number().default(600),
  userImportance: z.number().default(3.2),
  assistantImportance: z.number().default(3.0),
  episodicMinChars: z.number().default(80),

  // context injection
  contextDigest: z.union(["off", "first-step", "every-step"]).default("first-step"),
  digestChars: z.number().default(600),
  digestWorking: z.number().default(3),
  digestSemantic: z.number().default(2),
  digestProcedural: z.number().default(2),

  // retrieval
  searchTopK: z.number().default(5),
  decayHours: z.number().default(168),
  workingTTLMinutes: z.number().default(60),

  // consolidation / forgetting
  consolidateIntervalHours: z.number().default(6),
  mergeJaccard: z.number().default(0.3),
  mergeImportanceSum: z.number().default(5.5),
  minAgeHours: z.number().default(24),
  forgetImportance: z.number().default(2.5),
  maxWorking: z.number().default(30),
  maxEpisodic: z.number().default(400),
  maxSemantic: z.number().default(200),
  maxProcedural: z.number().default(120),
  // bound on archived (forgotten/consolidated/capped) entries retained on disk
  maxArchived: z.number().default(5000),

  // evolution / playbook
  feedbackImportance: z.number().default(6.0),
  lessonImportance: z.number().default(6.0),
  playbookMinImportance: z.number().default(4.5),
  playbookMaxCorrections: z.number().default(6),
  playbookMaxInsights: z.number().default(6),
  playbookMaxLessons: z.number().default(8),
  insightMinCount: z.number().default(2),

  // LLM reflection / distillation (opt-in; graceful degradation to rules)
  reflectionEnabled: z.boolean().default(true),
  llmProvider: z.string().default("siliconflow"),
  llmModel: z.string().default("deepseek-ai/DeepSeek-V4-Flash"),
  reflectionCooldownMs: z.number().default(30 * 60 * 1000),
  reflectionMaxCalls: z.number().default(10),
  reflectionTimeoutMs: z.number().default(45_000),
  reflectionMinImportance: z.number().default(4.5),
  distillMinClusterSize: z.number().default(2),
});

function defaultRoot() {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(home, "storages", "hierarchical-memory");
}

export function apply(ctx, cfg) {
  const root = cfg.root ?? defaultRoot();
  const config = { ...cfg, root };
  const store = new MemoryStore({ root, cfg: config, log: ctx.logger?.(name) ?? console });
  store.logEvolution("plugin/boot", {
    at: Date.now(),
    inject: inject.join(","),
    reflection: config.reflectionEnabled !== false,
    llm: String(config.llmProvider) + "/" + String(config.llmModel),
  });

  // ---- tools ------------------------------------------------------------
  registerMemoryTools(ctx, store, config);

  // ---- auto-record & self-evolution from session events ------------------
  ctx.on("session/event", (session, event) => {
    try {
      const tagged = { ...event.data, sessionId: session?.id ?? null };
      switch (event.type) {
        case "user/message":
          handleUserMessage(store, { data: tagged }, config);
          break;
        case "assistant/message":
          if (config.autoRecord !== false) handleAssistantMessage(store, { data: tagged }, config);
          break;
        case "feedback/record":
          handleFeedback(store, { data: tagged }, config);
          break;
        case "tool/result":
          handleToolResult(store, { data: tagged }, config);
          break;
        default:
          break;
      }
    } catch (err) {
      ctx.logger?.(name)?.warn(`session/event handler failed: ${err?.message ?? err}`);
    }
  });

  // ---- salient-memory digest injection (per model step) ------------------
  if (config.contextDigest !== "off") {
    ctx.on(
      "agent/pre-step",
      async ({ agent, turn, step, signal }, next) => {
        const decision = await next();
        if (decision.kind === "reject" || signal.aborted) return decision;
        if (config.contextDigest === "first-step" && step !== 1) return decision;
        const queryText = recentUserText(agent);
        const digest = buildDigest(store, config, queryText);
        if (!digest) return decision;
        const message = createUserMessage({
          content: [{ type: "text", text: digest }],
          source: {
            kind: "plugin",
            plugin: name,
            form: "snapshot",
            sections: [{ name, text: digest }],
          },
        });
        return { kind: "enter", messages: [...decision.messages, message] };
      },
      { prepend: true },
    );
  }

  // ---- evolving skill library (procedural layer as a runtime skill) ------
  ctx.skills.registerProvider((control) => ({
    name: "hierarchical-memory",
    async list() {
      const procedural = store.active("procedural").length;
      return [
        {
          name: "evolved-playbook",
          description:
            "由分层记忆插件根据对话与反馈持续演进的技能手册：用户纠正、工具教训、经验法则与高频语义要点。",
          whenToUse: "面对类似过去任务、用户偏好、工具踩坑场景时加载，可避免重复错误并沿用有效方法。",
          invocation: { modelInvocable: true, userInvocable: false },
          source: "custom",
          provider: "hierarchical-memory",
          rank: 100,
          locator: { updatedAt: Date.now(), entries: procedural },
          metadata: { proceduralEntries: procedural, updatedAt: Date.now() },
        },
      ];
    },
    async get(candidate) {
      return {
        ...candidate,
        content: renderPlaybook(store, config),
      };
    },
  }));

  // ---- periodic consolidation + LLM reflection (sleep-like pass) ---------
  if ((config.consolidateIntervalHours ?? 6) > 0) {
    const runPass = () => {
      try {
        const stats = consolidate(store, config);
        ctx.logger?.(name)?.debug(`consolidation: ${JSON.stringify(stats)}`);
      } catch (err) {
        ctx.logger?.(name)?.warn(`consolidation failed: ${err?.message ?? err}`);
      }
      // LLM reflection batch runs after the rule pass, fire-and-forget:
      // bounded by cooldown + call budget; never blocks the loop.
      if (config.reflectionEnabled !== false) {
        void runReflectionBatch(ctx, store, config)
          .then((s) => {
            ctx.logger?.(name)?.debug(`reflection batch: ${JSON.stringify(s)}`);
            if (config.reflectionEnabled !== false) {
              store.logEvolution("reflection/pass", { stats: s });
            }
          })
          .catch((err) => {
            ctx.logger?.(name)?.warn(`reflection batch failed: ${err?.message ?? err}`);
            try { store.logEvolution("reflection/pass-error", { error: String(err?.message ?? err) }); } catch {}
          });
      }
    };
    // dsh sandbox disables Node timers; the cordis timer service (inject:
    // ['timer']) exposes ctx.interval as a fiber-managed interval.
    ctx.interval(() => runPass(), (config.consolidateIntervalHours ?? 6) * 3_600_000);
  }

  // ---- one-shot reflection on startup (existing lessons/distillables) ----
  // Runs once ~90s after boot (after providers settle), fire-and-forget:
  // bounded by cooldown + call budget + watermark; safe to skip if llm
  // service isn't ready (the periodic pass will pick it up).
  if (config.reflectionEnabled !== false) {
    const runStartup = () => {
      void runReflectionBatch(ctx, store, config)
        .then((s) => {
          ctx.logger?.(name)?.debug(`startup reflection batch: ${JSON.stringify(s)}`);
          if (config.reflectionEnabled !== false) {
            store.logEvolution("reflection/startup-done", { stats: s });
          }
        })
        .catch((err) => {
          ctx.logger?.(name)?.warn(`startup reflection failed: ${err?.message ?? err}`);
          try { store.logEvolution("reflection/startup-error", { error: String(err?.message ?? err) }); } catch {}
        });
    };
    // fiber-managed one-shot: automatically cleaned up when the plugin stops.
    ctx.timeout(runStartup, 90_000);
  }

  // ---- flush on dispose --------------------------------------------------
  ctx.effect(() => () => void store.flush());

  ctx.logger?.(name)?.info(
    `hierarchical-memory ready: root=${root}, tools=6, digest=${config.contextDigest}, autoRecord=${config.autoRecord}, reflection=${config.reflectionEnabled} (${config.llmProvider}/${config.llmModel})`,
  );
}

/** Most recent direct human prompt text for digest relevance alignment. */
function recentUserText(agent) {
  if (!agent?.session) return "";
  const events = agent.session.events ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "user/message" && e.data?.source?.kind === "user") {
      return extractText(e.data.content);
    }
  }
  return "";
}
