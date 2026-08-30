// text.js — small text utilities: tokenization (En + CJK-friendly), keyword
// extraction, truncation, message-block extraction, stable hashing.

/** Minimal English stop words (agent-memory noise reduction).
 *  Deliberately small: over-filtering hides rare-but-important tokens. */
const STOP = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "for",
  "with", "by", "from", "as", "is", "are", "was", "were", "be", "been", "being",
  "it", "its", "this", "that", "these", "those", "i", "you", "we", "they", "he",
  "she", "them", "there", "here", "what", "which", "who", "whom", "how", "why",
  "when", "where", "do", "does", "did", "have", "has", "had", "not", "no", "yes",
  "can", "could", "will", "would", "should", "may", "might", "must", "about",
  "into", "over", "under", "again", "then", "than", "so", "too", "very", "just",
  "also", "if", "else", "my", "your", "our", "their", "his", "her", "me", "us",
]);

const CJK = /[\u3400-\u9fff]/;

/** Split text into lowercase word tokens. CJK runs become whole-run tokens plus
 *  2-grams so Chinese phrases still overlap on shared character pairs. */
export function tokenize(text) {
  if (!text) return [];
  const out = [];
  // latin/digit words
  for (const m of text.toLowerCase().matchAll(/[a-z0-9][a-z0-9'-]*/g)) {
    const w = m[0].replace(/^['-]+|['-]+$/g, "");
    if (w.length >= 2 && !STOP.has(w)) out.push(w);
  }
  // CJK runs
  for (const m of text.matchAll(/\p{Script=Han}+/gu)) {
    const run = m[0];
    out.push(run);
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

/** Top-N keywords by frequency (ties broken by first-seen order). */
export function keywords(text, max = 12) {
  const freq = new Map();
  for (const w of tokenize(text)) freq.set(w, (freq.get(w) ?? 0) + 1);
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([w]) => w);
}

/** Jaccard overlap between two token sets (used for consolidation clustering). */
export function tokenJaccard(a, b) {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a);
  let inter = 0;
  for (const t of b) if (sa.has(t)) inter++;
  const union = sa.size + b.length - inter;
  return union === 0 ? 0 : inter / union;
}

/** Overlap of query tokens into a target's text tokens, normalized to 0..1. */
export function relevance(queryTokens, targetTokens) {
  if (!queryTokens.length || !targetTokens.length) return 0;
  const set = new Set(targetTokens);
  let hit = 0;
  for (const t of queryTokens) if (set.has(t)) hit++;
  return hit / queryTokens.length;
}

export function truncate(text, max = 400) {
  if (!text) return "";
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
}

/** Join the text blocks of a model message's content array. */
export function extractText(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/** Stable 24-bit hash (for dedupe keys), FNV-1a flavored. */
export function stableHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

export function nowMs() {
  return Date.now();
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

export function fmtTime(ms) {
  return new Date(ms).toISOString();
}