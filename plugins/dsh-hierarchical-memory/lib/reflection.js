// reflection.js — LLM-assisted memory reflection & semantic distillation.
//
// This module gives the pure-rule self-evolution loop a model-backed quality
// upgrade, following the community-proven pattern (Hermes-style learning loop
// on DSH): fixed system prompt, strict JSON contract, watermark + cooldown +
// call budget, graceful degradation to the rule-based fallback.
//
// Two jobs run in one scheduled batch (invoked after each consolidation pass,
// or on demand via the memory_reflect tool):
//
//  1. lesson reflection — upgrade raw rule-template lessons ("tool X failed
//     (CODE)") into actionable know-how: what happened, why, what to do next.
//  2. semantic distillation — rewrite mechanically-concatenated consolidated
//     clusters into a compact, single-paragraph fact.
//
// Safety rails (all configurable):
//   * watermark     — each procedural lesson is reflected at most once;
//                     a distilled semantic entry is distilled at most once.
//   * cooldown      — no LLM calls within `reflectionCooldownMs` of the last
//                     batch, so the scheduled 6h pass never turns into a loop.
//   * call budget   — at most `reflectionMaxCalls` model calls per batch.
//   * JSON contract — the model must answer pure JSON; any parse failure,
//                     network error, or missing llm service degrades to
//                     keeping the existing entry untouched (never destructive).
//   * timeout       — each call is bounded (abort signal) so a stuck provider
//                     cannot hang the harness event loop.

import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
import { extractText } from "./text.js";

/** System prompt for lesson reflection (binary JSON contract). */
const REFLECT_SYSTEM = [
  "你是一名严谨的记忆策展人，负责把一条原始的工具失败教训改写成后续可执行的经验。",
  "输入是一条 JSON 记录，含 kind（教训类型）与 text（原始教训文本）。",
  "请只输出一个 JSON 对象，不要任何解释、不要 markdown 围栏，形如：",
  '{"refined": "一句话、具体、可执行的教训（怎么做，而不是只说什么失败了）", "why": "一句话解释失败根因", "applyTo": "何时应想起此教训（触发场景）", "keep": true}',
  "若输入的信息量不足以提炼（纯噪音、太短、无可执行内容），输出 {\"keep\": false, \"reason\": \"简短原因\"}。",
  "refined 不超过 120 字，why 不超过 80 字，applyTo 不超过 80 字，全部用中文。",
].join("\n");

/** System prompt for semantic distillation (consolidated cluster). */
const DISTILL_SYSTEM = [
  "你是一名记忆蒸馏器。输入是一组被判定为相似、来自同一主题的情景记忆片段（每条以·开头）。",
  "请把它们融合成一条紧凑、准确、去重、保留关键细节的长期事实/偏好，可直接作为后续检索的依据。",
  "只输出一个 JSON 对象，不要任何解释、不要 markdown 围栏，形如：",
  '{"summary": "融合后的一条事实（中文，不超过 150 字）"}',
  "若片段间互相矛盾无法融合，以最近的记录为准。",
].join("\n");

/** Default config knobs (spread under plugin Config in apply). */
export const REFLECTION_DEFAULTS = {
  reflectionEnabled: true,
  llmProvider: "siliconflow",
  llmModel: "deepseek-ai/DeepSeek-V4-Flash",
  reflectionCooldownMs: 30 * 60 * 1000, // 30 min between LLM batches
  reflectionMaxCalls: 10, // model calls per batch
  reflectionTimeoutMs: 45_000, // per-call abort bound
  reflectionMinImportance: 4.5, // only reflect lessons at/above this weight
  distillMinClusterSize: 2, // distill semantic entries fused from >=2 episodes
};

/**
 * Run one reflection batch: reflect un-reflected procedural lessons, then
 * distill un-distilled semantic clusters. Fire-and-forget friendly: never
 * throws; every failure path keeps prior state intact.
 *
 * @returns {Promise<object>} batch stats (for logging / memory_state).
 */
export async function runReflectionBatch(ctx, store, cfg = {}) {
  const stats = { reflected: 0, distilled: 0, skipped: 0, failed: 0, calls: 0, reason: "" };
  const enabled = cfg.reflectionEnabled ?? REFLECTION_DEFAULTS.reflectionEnabled;
  if (!enabled) {
    store.meta.reflectionAt = Date.now();
    store.meta.reflectionAttempt = { reason: "disabled", at: Date.now() };
    store._scheduleSave();
    stats.reason = "disabled";
    return stats;
  }
  if (!ctx.llm) {
    store.meta.reflectionAt = Date.now();
    store.meta.reflectionAttempt = { reason: "llm service unavailable", at: Date.now() };
    store._scheduleSave();
    stats.reason = "llm service unavailable";
    return stats;
  }

  const provider = cfg.llmProvider ?? REFLECTION_DEFAULTS.llmProvider;
  const model = cfg.llmModel ?? REFLECTION_DEFAULTS.llmModel;
  const cooldown = cfg.reflectionCooldownMs ?? REFLECTION_DEFAULTS.reflectionCooldownMs;
  const maxCalls = cfg.reflectionMaxCalls ?? REFLECTION_DEFAULTS.reflectionMaxCalls;
  const minImportance = cfg.reflectionMinImportance ?? REFLECTION_DEFAULTS.reflectionMinImportance;

  const now = Date.now();
  const last = store.meta.reflectionAt ?? 0;
  if (cfg.force) { /* manual trigger: bypass cooldown */ }
  else if (cooldown > 0 && now - last < cooldown) {
    stats.reason = `cooldown (${Math.round((cooldown - (now - last)) / 1000)}s left)`;
    store.meta.reflectionAttempt = { reason: "cooldown", at: now };
    store._scheduleSave();
    return stats;
  }

  const budget = { remaining: Math.max(1, maxCalls) };

  // ---- stage 1: reflect un-reflected procedural lessons ------------------
  const lessons = store
    .active("procedural")
    .filter((e) => !e.meta?.reflected)
    .filter((e) => (e.importance ?? 0) >= minImportance)
    .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0));
  for (const entry of lessons) {
    if (budget.remaining <= 0) { stats.skipped += 1; continue; }
    const outcome = await reflectOne(ctx, store, provider, model, entry, cfg);
    budget.remaining -= 1;
    stats.calls += 1;
    if (outcome === "ok") stats.reflected += 1;
    else if (outcome === "skip") stats.skipped += 1;
    else stats.failed += 1;
  }

  // ---- stage 2: distill un-distilled semantic clusters -------------------
  const minCluster = cfg.distillMinClusterSize ?? REFLECTION_DEFAULTS.distillMinClusterSize;
  const clusters = store
    .active("semantic")
    .filter((e) => !e.meta?.distilled)
    .filter((e) => (e.meta?.size ?? 0) >= minCluster)
    .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0));
  for (const entry of clusters) {
    if (budget.remaining <= 0) { stats.skipped += 1; continue; }
    const outcome = await distillOne(ctx, store, provider, model, entry, cfg);
    budget.remaining -= 1;
    stats.calls += 1;
    if (outcome === "ok") stats.distilled += 1;
    else if (outcome === "skip") stats.skipped += 1;
    else stats.failed += 1;
  }

  store.meta.reflectionAt = Date.now();
  store.meta.reflectionCalls = (store.meta.reflectionCalls ?? 0) + stats.calls;
  store.meta.reflectionAttempt = { reason: "ran", at: Date.now(), stats: { ...stats } };
  if (stats.calls > 0 || stats.failed > 0) {
    store.logEvolution("reflection/batch", {
      reflected: stats.reflected,
      distilled: stats.distilled,
      skipped: stats.skipped,
      failed: stats.failed,
      calls: stats.calls,
    });
  }
  return stats;
}

/** Reflect one procedural lesson via the model; degrade to keeping as-is. */
async function reflectOne(ctx, store, provider, model, entry, cfg) {
  const timeoutMs = cfg.reflectionTimeoutMs ?? REFLECTION_DEFAULTS.reflectionTimeoutMs;
  const input = {
    kind: entry.tags?.includes("correction") ? "correction" :
           entry.tags?.includes("tool-insight") ? "tool-insight" : "lesson",
    text: String(entry.text ?? "").slice(0, 900),
  };
  const reply = await callLlm(ctx, provider, model, REFLECT_SYSTEM, JSON.stringify(input), timeoutMs);
  if (!reply) { markFailed(store, entry); return "fail"; }
  const parsed = parseJsonContract(reply);
  if (!parsed) { markFailed(store, entry); return "fail"; }
  if (parsed.keep === false) {
    // Not worth keeping as guidance: mark reflected so we never call again.
    entry.meta = {
      ...entry.meta,
      reflected: true,
      reflectionSkipped: true,
      reflectionReason: typeof parsed.reason === "string" ? parsed.reason : "",
      reflectionAt: Date.now(),
    };
    store._scheduleSave();
    return "skip";
  }
  const refined = typeof parsed.refined === "string" ? parsed.refined.trim() : "";
  if (!refined) { markFailed(store, entry); return "fail"; }

  entry.text = upgradeLessonText(entry.text, refined);
  entry.meta = {
    ...entry.meta,
    reflected: true,
    reflectionAt: Date.now(),
    reflection: {
      refined,
      why: typeof parsed.why === "string" ? parsed.why.slice(0, 120) : "",
      applyTo: typeof parsed.applyTo === "string" ? parsed.applyTo.slice(0, 120) : "",
      provider,
      model,
    },
  };
  store._scheduleSave();
  store.logEvolution("reflection/refine", {
    id: entry.id,
    kind: input.kind,
    importance: entry.importance,
  });
  return "ok";
}

/** Distill one semantic cluster into a compact summary; degrade to as-is. */
async function distillOne(ctx, store, provider, model, entry, cfg) {
  const timeoutMs = cfg.reflectionTimeoutMs ?? REFLECTION_DEFAULTS.reflectionTimeoutMs;
  const body = String(entry.text ?? "").slice(0, 2000);
  const reply = await callLlm(ctx, provider, model, DISTILL_SYSTEM, body, timeoutMs);
  if (!reply) { markFailed(store, entry); return "fail"; }
  const parsed = parseJsonContract(reply);
  const summary = parsed && typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  if (!summary) { markFailed(store, entry); return "fail"; }

  entry.text = `· ${summary}`;
  entry.meta = {
    ...entry.meta,
    distilled: true,
    distilledAt: Date.now(),
    distillation: { provider, model },
  };
  store._scheduleSave();
  store.logEvolution("reflection/distill", {
    id: entry.id,
    size: (entry.meta ? entry.meta.size : 0) || 0,
  });
  return "ok";
}

/**
 * One bounded model call through the harness llm seam. Returns the assembled
 * text of the assistant reply, or null on any failure/abort/timeout.
 */
async function callLlm(ctx, provider, model, system, userText, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? 45_000);
  try {
    const assembler = new BlockAssembler();
    const options = {
      provider,
      model,
      system,
      messages: [
        createUserMessage({
          content: [{ type: "text", text: userText }],
          source: { kind: "plugin", plugin: "hierarchical-memory", form: "snapshot" },
        }),
      ],
      temperature: 0.2,
      maxTokens: 700,
      signal: controller.signal,
    };
    for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk);
    if (assembler.finish?.kind === "error") {
      ctx.logger?.("hierarchical-memory")?.warn?.(
        `llm reflection stream error (${provider}/${model}): ${assembler.finish.failure?.message ?? "unknown"}`,
      );
      return null;
    }
    const text = extractText(assembler.blocks()) || "";
    return text.trim() || null;
  } catch (err) {
    ctx.logger?.("hierarchical-memory")?.warn?.(
      `llm reflection call failed (${provider}/${model}): ${err?.message ?? err}`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Tolerant JSON extraction: strip fences, bracket-balance, first object. */
export function parseJsonContract(raw) {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  // strip markdown fences if present
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  // bracket-balance scan for the first balanced {...}
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  const inStr = { v: false, esc: false };
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr.v) {
      if (inStr.esc) inStr.esc = false;
      else if (ch === "\\") inStr.esc = true;
      else if (ch === '"') inStr.v = false;
      continue;
    }
    if (ch === '"') { inStr.v = true; continue; }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/** Prepend the refined guidance to the original text (keeps provenance). */
function upgradeLessonText(original, refined) {
  const clean = String(original ?? "").replace(/^\[经验\]\s*|^\[用户反馈\]\s*|^\[工具教训\]\s*/g, "");
  return `[经验·模型提炼] ${refined}\n（来源：${clean.slice(0, 180)}）`;
}

/** Mark an entry as attempted-but-failed so it is not retried every batch. */
function markFailed(store, entry) {
  entry.meta = {
    ...entry.meta,
    reflectionAttempted: true,
    reflectionFailedAt: Date.now(),
    reflectionFailCount: (entry.meta?.reflectionFailCount ?? 0) + 1,
  };
  // Persist the watermark so a permanently failing lesson is not retried on
  // every batch; a failed reflection never blocks or corrupts state.
  store._scheduleSave();
}