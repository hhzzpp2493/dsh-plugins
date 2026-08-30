// store.js — layered memory store with JSONL persistence.
//
// Layers (from CoALA / cognitive-architecture taxonomy + MemGPT):
//   working    — current-session scratch; short TTL, auto-cleared by decay
//   episodic   — "what happened": auto-recorded exchanges & outcomes
//   semantic   — consolidated facts/knowledge (episodic → semantic merging)
//   procedural — how-to knowledge: lessons, corrections, tool insights
//
// Persistence: append-oriented JSONL (memories.jsonl) with debounced atomic
// rewrite; evolution.jsonl is a strict append-only learning log.

import { mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { keywords, truncate, stableHash } from "./text.js";
import { scoreEntry } from "./scoring.js";

export const LAYERS = ["working", "episodic", "semantic", "procedural"];

export const LAYER_DEFAULTS = {
  working: { importance: 2.5, max: 30 },
  episodic: { importance: 3.0, max: 400 },
  semantic: { importance: 5.0, max: 200 },
  procedural: { importance: 5.5, max: 120 },
};

export class MemoryStore {
  constructor({ root, cfg = {}, log = console }) {
    this.root = root;
    this.cfg = cfg;
    this.log = log;
    this.entries = new Map();   // id -> entry
    this.evolution = [];        // learning log (memory)
    this.meta = { lastConsolidation: 0, consolidations: 0, learnEvents: 0 };
    this._saveTimer = null;
    this._dirty = false;
    mkdirSync(root, { recursive: true });
    this.load();
  }

  // ---- persistence ------------------------------------------------------

  load() {
    const memPath = join(this.root, "memories.jsonl");
    if (existsSync(memPath)) {
      try {
        for (const line of readFileSync(memPath, "utf8").split("\n")) {
          if (!line.trim()) continue;
          const e = JSON.parse(line);
          if (e && e.id && e.layer) {
            e._tokens = keywords(e.text ?? "", 16);
            this.entries.set(e.id, e);
          }
        }
      } catch (err) {
        this.log.warn(`[hierarchical-memory] failed to read ${memPath}: ${err?.message ?? err}`);
      }
    }
    const evPath = join(this.root, "evolution.jsonl");
    if (existsSync(evPath)) {
      try {
        for (const line of readFileSync(evPath, "utf8").split("\n")) {
          if (line.trim()) this.evolution.push(JSON.parse(line));
        }
      } catch { /* non-fatal */ }
    }
    const metaPath = join(this.root, "meta.json");
    if (existsSync(metaPath)) {
      try { this.meta = { ...this.meta, ...JSON.parse(readFileSync(metaPath, "utf8")) }; } catch { /* non-fatal */ }
    }
    this.log.info(`[hierarchical-memory] loaded ${this.entries.size} entries, ${this.evolution.length} evolution events from ${this.root}`);
  }

  _scheduleSave() {
    this._dirty = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => { this._saveTimer = null; void this.save(); }, 800);
  }

  /** Keep archived entries bounded: drop the oldest archived past the cap so
   *  memories.jsonl can't grow unbounded (same style as the evolution splice).
   *  Live (non-archived) entries are never touched. */
  pruneArchived() {
    const maxArchived = this.cfg.maxArchived ?? 5000;
    const archived = [...this.entries.values()]
      .filter((e) => e.archived)
      .sort((a, b) => (a.archivedAt ?? a.lastAccess ?? 0) - (b.archivedAt ?? b.lastAccess ?? 0));
    const overflow = archived.length - maxArchived;
    if (overflow <= 0) return overflow;
    for (const e of archived.slice(0, overflow)) this.entries.delete(e.id);
    return -overflow;
  }

  async save() {
    this._dirty = false;
    this.pruneArchived();
    const memPath = join(this.root, "memories.jsonl");
    const tmp = memPath + ".tmp";
    try {
      const lines = [];
      for (const e of this.entries.values()) {
        const { _tokens, ...plain } = e;
        lines.push(JSON.stringify(plain));
      }
      writeFileSync(tmp, lines.join("\n") + (lines.length ? "\n" : ""));
      renameSync(tmp, memPath);
      writeFileSync(join(this.root, "meta.json"), JSON.stringify(this.meta));
      this.log.debug(`[hierarchical-memory] saved ${this.entries.size} entries`);
    } catch (err) {
      this.log.warn(`[hierarchical-memory] save failed: ${err?.message ?? err}`);
    }
  }

  async flush() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    await this.save();
  }

  // ---- mutations --------------------------------------------------------

  add({ layer, text, source = "auto", importance, sessionId, tags = [], refs = [], meta = {} }) {
    const id = randomUUID();
    const entry = {
      id,
      layer,
      text: truncate(String(text ?? ""), this.cfg.entryMaxChars ?? 600),
      source,
      importance: importance ?? (LAYER_DEFAULTS[layer]?.importance ?? 3),
      createdAt: Date.now(),
      lastAccess: Date.now(),
      accessCount: 0,
      archived: false,
      archivedAt: null,
      archiveReason: null,
      sessionId: sessionId ?? null,
      tags,
      refs,
      meta,
      hash: stableHash(truncate(String(text ?? ""), 240)),
      _tokens: keywords(String(text ?? ""), 16),
    };
    this.entries.set(id, entry);
    this._scheduleSave();
    return entry;
  }

  /** Dedupe-aware add: if an identical-text active entry exists in the same
   *  layer, bump its access/importance instead of duplicating. */
  addDeduped(opts) {
    const key = stableHash(truncate(String(opts.text ?? ""), 240));
    let best = null;
    for (const e of this.entries.values()) {
      if (!e.archived && e.layer === opts.layer && e.hash === key) {
        if (best === null || e.importance < best.importance) best = e;
      }
    }
    if (best) {
      best.accessCount += 1;
      best.lastAccess = Date.now();
      best.importance = Math.min(10, best.importance + 0.3);
      this._scheduleSave();
      return best;
    }
    return this.add(opts);
  }

  get(id) {
    return this.entries.get(id);
  }

  update(id, patch) {
    const e = this.entries.get(id);
    if (!e) return;
    for (const [k, v] of Object.entries(patch)) {
      if (k === "_tokens" || k === "id") continue;
      if (v !== undefined) e[k] = v;
    }
    this._scheduleSave();
  }

  archive(id, reason) {
    const e = this.entries.get(id);
    if (!e || e.archived) return false;
    e.archived = true;
    e.archivedAt = Date.now();
    e.archiveReason = reason;
    this._scheduleSave();
    return true;
  }

  active(layer) {
    return [...this.entries.values()].filter((e) => !e.archived && (layer ? e.layer === layer : true));
  }

  /** Query with salience scoring; bumps access counts of hits (self-evolving
   *  reinforcement: retrieved memories get stronger). */
  query(text, { layers = LAYERS, topK = 5, now = Date.now() } = {}) {
    const qTokens = keywords(text ?? "", 16);
    const scored = [];
    for (const e of this.entries.values()) {
      if (e.archived) continue;
      if (e.archivedAt && e.archiveReason === "decay" && e.importance < (this.cfg.forgetImportance ?? 2.5)) continue;
      if (!layers.includes(e.layer)) continue;
      scored.push({ entry: e, score: scoreEntrySafe(e, qTokens, now, this.cfg) });
    }
    scored.sort((a, b) => b.score - a.score);
    const hits = scored.slice(0, topK);
    for (const { entry } of hits) {
      entry.accessCount += 1;
      entry.lastAccess = now;
    }
    if (hits.length) this._scheduleSave();
    return hits.map(({ entry, score }) => ({ ...plain(entry), score: Number(score.toFixed(4)) }));
  }

  /** Recent entries of a layer (working memory snapshot). */
  recent(layer, topK = 5) {
    return this.active(layer)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, topK)
      .map(plain);
  }

  counts() {
    const c = { working: 0, episodic: 0, semantic: 0, procedural: 0, archived: 0 };
    for (const e of this.entries.values()) {
      if (e.archived) c.archived++;
      else if (c[e.layer] !== undefined) c[e.layer]++;
    }
    return c;
  }

  logEvolution(type, data) {
    const ev = { time: Date.now(), type, ...data };
    this.evolution.push(ev);
    if (this.evolution.length > 2000) this.evolution.splice(0, this.evolution.length - 2000);
    this.meta.learnEvents += 1;
    try { appendFileSync(join(this.root, "evolution.jsonl"), JSON.stringify(ev) + "\n"); } catch { /* non-fatal */ }
    this._scheduleSave();
    return ev;
  }
}

/** Strip internal fields for returned/rendered copies. */
function plain(e) {
  const { _tokens, ...rest } = e;
  return rest;
}

function scoreEntrySafe(e, qTokens, now, cfg) {
  return scoreEntry(e, qTokens, now, cfg);
}