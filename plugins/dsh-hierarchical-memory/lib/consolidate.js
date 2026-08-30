// consolidate.js — memory consolidation & forgetting.
//
// Research grounding:
//  * Sleep-based systems consolidation (Walker & Stickgold 2013; Neuron 2023):
//    repeated, related episodic traces are replayed and fused into stable
//    semantic knowledge.
//  * Gradient Episodic Memory (Lopez-Paz & Ranzato 2017) / continual learning
//    (Parisi et al. 2019): episodic storage prevents catastrophic forgetting of
//    old knowledge — archived traces keep provenance instead of hard deletion.
//  * MemoryBank (2024) Ebbinghaus curve: low-salience, old traces are forgotten
//    (archived) during consolidation.

import { tokenJaccard, truncate, clamp } from "./text.js";
import { baseSalience } from "./scoring.js";

/**
 * Run one consolidation pass.
 *  1. cluster similar episodic/working entries (token-Jaccard overlap);
 *  2. fuse each viable cluster into one semantic entry (importance grows with
 *     cluster size — repeated exposure consolidates);
 *  3. forgetting: archive low-salience old entries;
 *  4. enforce per-layer caps (oldest/lowest-salience archived first);
 *  5. log the pass to the evolution log.
 */
export function consolidate(store, cfg = {}, now = Date.now()) {
  const stats = { fusedClusters: 0, fusedEntries: 0, forgotten: 0, capped: 0, semanticCreated: 0 };

  // ---- 1+2: episodic/working -> semantic fusion ---------------------------
  const candidates = store
    .active("episodic")
    .concat(store.active("working"))
    .filter((e) => !e.archived);
  const used = new Set();
  for (const seed of candidates) {
    if (used.has(seed.id)) continue;
    const cluster = [seed];
    used.add(seed.id);
    for (const other of candidates) {
      if (used.has(other.id) || other.id === seed.id) continue;
      if (tokenJaccard(seed._tokens ?? [], other._tokens ?? []) >= (cfg.mergeJaccard ?? 0.3)) {
        cluster.push(other);
        used.add(other.id);
      }
    }
    if (cluster.length < 2) continue;
    const combined = cluster.reduce((s, e) => s + (e.importance ?? 0), 0);
    if (combined < (cfg.mergeImportanceSum ?? 5.5)) continue;

    const maxImp = Math.max(...cluster.map((e) => e.importance ?? 0));
    const text = truncate(
      cluster
        .map((e) => `${e.source === "auto" ? "·" : "•"} ${e.text}`)
        .join("\n"),
      900,
    );
    store.add({
      layer: "semantic",
      text,
      source: "consolidation",
      importance: clamp(maxImp + 0.5 + 0.7 * Math.log2(cluster.length), 4, 10),
      sessionId: cluster[0].sessionId,
      tags: ["consolidated"],
      refs: cluster.map((e) => e.id),
      meta: { consolidatedAt: now, size: cluster.length, distilled: false },
    });
    for (const e of cluster) store.archive(e.id, "consolidated");
    store.logEvolution("consolidation/fuse", {
      size: cluster.length,
      importance: maxImp,
      refs: cluster.map((e) => e.id),
    });
    stats.fusedClusters++;
    stats.fusedEntries += cluster.length;
    stats.semanticCreated++;
  }

  // ---- 3: forgetting ------------------------------------------------------
  const minAge = (cfg.minAgeHours ?? 24) * 3_600_000;
  const forgetImp = cfg.forgetImportance ?? 2.5;
  for (const e of store.active()) {
    if (e.layer === "working") continue;
    if (e.importance >= forgetImp) continue;
    if (now - e.createdAt < minAge) continue;
    if (baseSalience(e, now, cfg) < forgetImp) {
      if (store.archive(e.id, "decay")) stats.forgotten++;
    }
  }

  // ---- 4: caps ------------------------------------------------------------
  for (const layer of ["working", "episodic", "semantic", "procedural"]) {
    const max = cfg[`max${layer[0].toUpperCase()}${layer.slice(1)}`] ?? 100;
    const actives = store.active(layer);
    if (actives.length <= max) continue;
    actives
      .sort((a, b) => baseSalience(a, now, cfg) - baseSalience(b, now, cfg))
      .slice(0, actives.length - max)
      .forEach((e) => { if (store.archive(e.id, "cap")) stats.capped++; });
  }

  store.meta.lastConsolidation = now;
  store.meta.consolidations += 1;
  store.logEvolution("consolidation/pass", stats);
  return stats;
}