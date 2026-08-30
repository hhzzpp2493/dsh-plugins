// scoring.js — memory salience scoring.
//
// Modeled on the research synthesis:
//  * Generative Agents (Park et al. 2023): retrieval = importance × recency ×
//    relevance composite scoring over a memory stream.
//  * MemoryBank (Zhong et al. 2024) / Ebbinghaus: exponential forgetting curve
//    for the recency term (half-life per layer).
//  * ACT-R style activation (Lewis & Vasishth 2005): repeated access boosts
//    baseline activation (log(1 + accessCount)), which counters decay.

import { relevance as tokenRelevance } from "./text.js";

export const DEFAULT_WEIGHTS = {
  importance: 0.55,
  recency: 0.22,
  relevance: 0.16,
  access: 0.07,
};

/** Exponential forgetting-curve recency: 0.5 every `halfLifeMs`. */
export function recency(createdAt, now, halfLifeMs) {
  const age = Math.max(0, now - createdAt);
  if (halfLifeMs <= 0) return 1;
  return Math.exp((-Math.LN2 * age) / halfLifeMs);
}

/** Baseline salience with no query: used for forgetting/consolidation gating. */
export function baseSalience(entry, now, cfg) {
  const halfLife = layerHalfLife(entry.layer, cfg);
  return (
    entry.importance * DEFAULT_WEIGHTS.importance +
    recency(entry.createdAt, now, halfLife) * DEFAULT_WEIGHTS.recency +
    Math.log1p(entry.accessCount) * DEFAULT_WEIGHTS.access
  );
}

/** Full retrieval score against a query for one entry. */
export function scoreEntry(entry, queryTokens, now, cfg, weights = DEFAULT_WEIGHTS) {
  const halfLife = layerHalfLife(entry.layer, cfg);
  const rel = queryTokens.length ? tokenRelevance(queryTokens, entry._tokens ?? []) : 0;
  return (
    entry.importance * weights.importance +
    recency(entry.createdAt, now, halfLife) * weights.recency +
    rel * weights.relevance +
    Math.log1p(entry.accessCount) * weights.access
  );
}

/** Per-layer forgetting half-life (recency weight) in milliseconds. */
export function layerHalfLife(layer, cfg) {
  switch (layer) {
    case "working":
      return cfg.workingTTLMinutes * 60_000;
    case "procedural":
      return (cfg.decayHours ?? 168) * 6 * 3_600_000; // lessons persist ~6x longer than facts
    default:
      return (cfg.decayHours ?? 168) * 3_600_000;
  }
}

export function importanceHint(text, base = 3) {
  // Lightweight salience heuristics used for automatic episodic recording.
  let v = base;
  if (text.length >= 80) v += 0.6;          // substantive messages
  if (/remember|记住|务必|never|always|不要|必须|重要/.test(text)) v += 1.2;
  if (/\?|？|帮我|请|please|how to|how do|explain|分析|实现|设计/.test(text)) v += 0.4;
  if (/^(memory|commit|learn|lesson)/i.test(text)) v += 0.5;
  return Math.min(10, v);
}