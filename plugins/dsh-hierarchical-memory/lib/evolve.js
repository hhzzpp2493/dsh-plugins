// evolve.js — self-evolving learning from experience.
//
// Research grounding:
//  * Reflexion (Shinn et al. 2023): verbal self-reflection stored in episodic
//    memory and replayed to improve later attempts.
//  * Voyager (Wang et al. 2023): a persistent, reusable skill library is the
//    procedural-memory mechanism of lifelong-learning agents.
//  * ExpeL (Zhao et al. 2024) / Agent-Pro (Zhang et al. 2024): extract
//    transferable lessons/policies from accumulated experience; confidence in
//    each lesson grows with confirmations and shrinks with contradictions.
//
// Implemented learning signals (all rule-based, deterministic, offline):
//  - user feedback (/feedback text)          -> procedural "lesson" entries
//  - repeated tool failures                  -> procedural "tool-insight"
//  - explicit `memory_learn` tool calls      -> procedural "lesson" (curated)
//  - retrieval reuse                         -> accessCount reinforcement
//  - positive semantic salience              -> promoted into the playbook

import { keywords, truncate, extractText, stableHash } from "./text.js";
import { importanceHint } from "./scoring.js";

export function handleUserMessage(store, event, cfg) {
  const msg = event.data;
  if (!msg || msg.source?.kind !== "user") return null; // only direct human prompts
  const text = extractText(msg.content);
  if (!text) return null;
  const important = importanceHint(text, cfg.userImportance ?? 3.2);
  store.addDeduped({
    layer: "working",
    text,
    source: "auto",
    importance: Math.min(10, important),
    sessionId: event.sessionId ?? null,
    tags: ["user"],
  });
  // Substantive tasks also land in episodic for durability.
  if (text.length >= (cfg.episodicMinChars ?? 80)) {
    store.addDeduped({
      layer: "episodic",
      text,
      source: "auto",
      importance: Math.min(10, important - 0.4),
      sessionId: event.sessionId ?? null,
      tags: ["user"],
    });
  }
  return important;
}

export function handleAssistantMessage(store, event, cfg) {
  if (event.data?.interrupted) return null;
  const message = event.data?.message;
  if (!message) return null;
  const text = extractText(message.content);
  if (!text) return null;
  return store.addDeduped({
    layer: "episodic",
    text,
    source: "auto",
    importance: importanceHint(text, cfg.assistantImportance ?? 3.0),
    sessionId: event.sessionId ?? null,
    tags: ["assistant"],
  });
}

/** Turn an arbitrary /feedback text into a durable lesson entry. */
export function handleFeedback(store, event, cfg) {
  const text = String(event.data?.text ?? "").trim();
  if (!text) return null;
  const entry = store.add({
    layer: "procedural",
    text: truncate(`[用户反馈] ${text}`, 500),
    source: "feedback",
    importance: cfg.feedbackImportance ?? 6.0,
    sessionId: event.sessionId ?? null,
    tags: ["feedback", "correction"],
    meta: { kind: "correction", raw: text },
  });
  store.logEvolution("learn/feedback", { id: entry.id, text: truncate(text, 120) });
  return entry;
}

/** Repeated tool failures become procedural insights (trial-and-error learning). */
export function handleToolResult(store, event, cfg) {
  const err = event.data?.error;
  if (!err?.code) return null;
  // tool/result carries the failing tool only via the HarnessError name/client
  // identity; err.name is the HarnessError class name when present.
  const name = typeof err.name === "string" && err.name ? err.name : "tool";
  const tag = `tool-fail:${name}:${err.code}`;
  // dedupe by tag exactly once per tool failure kind
  let existing = null;
  for (const e of store.active("procedural")) {
    if (e.tags?.includes(tag)) { existing = e; break; }
  }
  if (existing) {
    existing.meta = { ...existing.meta, count: (existing.meta?.count ?? 1) + 1 };
    existing.importance = Math.min(10, existing.importance + 0.8);
    existing.lastAccess = Date.now();
    store.logEvolution("learn/tool-fail", { tag, count: existing.meta.count });
    return existing;
  }
  const entry = store.add({
    layer: "procedural",
    text: truncate(`[工具教训] ${name} 失败（${err.code}）——${err.message ?? "针对该失败调整策略或改用其他工具/方法"}.`, 400),
    source: "lesson",
    importance: 5.0,
    sessionId: event.sessionId ?? null,
    tags: [tag, "tool-insight"],
    meta: { kind: "tool", name, code: err.code, count: 1 },
  });
  store.logEvolution("learn/tool-fail", { tag, count: 1 });
  return entry;
}

/** Explicit model/user lesson via the memory_learn tool. */
export function learnLesson(store, { lesson, topic, sessionId, cfg }) {
  const text = truncate(`[经验] ${topic ? `(${topic}) ` : ""}${lesson}`, 600);
  const key = stableHash(text);
  let existing = null;
  for (const e of store.active("procedural")) {
    const kind = e.meta?.kind ?? "lesson";
    if (e.source === "lesson" && kind === "lesson" && e.hash === key) { existing = e; break; }
  }
  if (existing) {
    existing.meta = { ...existing.meta, count: (existing.meta?.count ?? 1) + 1, confirmations: (existing.meta?.confirmations ?? 1) + 1 };
    existing.importance = Math.min(10, existing.importance + 0.5);
    store.logEvolution("learn/confirm", { id: existing.id });
    return { entry: existing, reinforced: true };
  }
  const entry = store.add({
    layer: "procedural",
    text,
    source: "lesson",
    importance: cfg.lessonImportance ?? 6.0,
    sessionId: sessionId ?? null,
    tags: topic ? keywords(topic, 6) : [],
    meta: { kind: "lesson", count: 1, confirmations: 1 },
  });
  store.logEvolution("learn/lesson", { id: entry.id, topic: topic ?? "" });
  return { entry, reinforced: false };
}

/** Render the evolving playbook: the procedural layer seen by the model
 *  (Voyager-style skill library). Consulted by the skill provider, the
 *  memory_search tool, and the per-step digest. */
export function renderPlaybook(store, cfg = {}, now = Date.now()) {
  const procedural = store.active("procedural").filter((e) => e.importance >= (cfg.playbookMinImportance ?? 4.5));
  const corrections = procedural
    .filter((e) => e.tags?.includes("correction"))
    .sort((a, b) => b.importance - a.importance)
    .slice(0, cfg.playbookMaxCorrections ?? 6);
  const insights = procedural
    .filter((e) => e.tags?.includes("tool-insight") && (e.meta?.count ?? 1) >= (cfg.insightMinCount ?? 2))
    .sort((a, b) => (b.meta?.count ?? 0) - (a.meta?.count ?? 0))
    .slice(0, cfg.playbookMaxInsights ?? 6);
  const lessons = procedural
    .filter((e) => e.source === "lesson" && !e.tags?.includes("correction") && !e.tags?.includes("tool-insight"))
    .sort((a, b) => b.importance - a.importance)
    .slice(0, cfg.playbookMaxLessons ?? 8);

  const lines = [];
  lines.push("# 进化技能手册（evolved playbook）");
  lines.push(`> 由分层记忆插件根据经验持续演进 · 更新 ${new Date(now).toISOString()}`);
  if (corrections.length) {
    lines.push("\n## 用户纠正（收藏的经验教训）");
    for (const e of corrections) lines.push(`- ${e.text.replace(/^\[用户反馈\] /, "")}`);
  }
  if (insights.length) {
    lines.push("\n## 工具教训（重复失败）");
    for (const e of insights) lines.push(`- [${e.meta?.count ?? 1}次] ${e.text.replace(/^\[工具教训\] /, "")}`);
  }
  if (lessons.length) {
    lines.push("\n## 经验法则");
    for (const e of lessons) lines.push(`- ${e.text.replace(/^\[经验\] /, "")}`);
  }
  if (lines.length <= 1) {
    lines.push("\n_尚无足够经验 —— 随着对话、反馈与教训的积累，本手册会自动演进。_");
  }
  const semantic = store
    .active("semantic")
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 5);
  if (semantic.length) {
    lines.push("\n## 高频语义要点");
    for (const e of semantic) lines.push(`- ${truncate(e.text.replace(/^[·•] /g, "").split("\n")[0] ?? "", 160)}`);
  }
  return lines.join("\n");
}

/** Compact per-step digest injected into the model context:
 *  working-memory snapshot + top semantic + top procedural lessons
 *  (MemGPT-style salient memory paging into context). */
export function buildDigest(store, cfg = {}, queryText = "", now = Date.now()) {
  const cap = cfg.digestChars ?? 600;
  const parts = [];
  const working = store.recent("working", cfg.digestWorking ?? 3);
  if (working.length) {
    parts.push(
      "【工作记忆】" +
        working.map((e) => truncate(e.text.replace(/\s+/g, " "), 90)).join(" ⏵ "),
    );
  }
  const semantic = store.query(queryText || " ", {
    layers: ["semantic"],
    topK: cfg.digestSemantic ?? 2,
    now,
  });
  if (semantic.length) {
    parts.push(
      "【语义要点】" +
        semantic.map((e) => truncate(e.text.replace(/^[·•] /g, "").replace(/\s+/g, " "), 100)).join(" ⏵ "),
    );
  }
  const procedural = store.query(queryText || " ", {
    layers: ["procedural"],
    topK: cfg.digestProcedural ?? 2,
    now,
  });
  if (procedural.length) {
    parts.push(
      "【经验教训】" +
        procedural.map((e) => truncate(e.text.replace(/^\[(用户反馈|工具教训|经验)\][ ]?/, "").replace(/\s+/g, " "), 100)).join(" ⏵ "),
    );
  }
  if (!parts.length) return "";
  let acc = `记忆摘要（hierarchical-memory）：${parts.join("；")}`;
  if (acc.length > cap) acc = acc.slice(0, cap) + "…";
  return acc;
}