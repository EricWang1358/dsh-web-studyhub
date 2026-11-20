import { getUiLanguage, setUiLanguage, ui, uiFormat } from "../i18n.js";

/** Maximum number of unknown terms marked on one question at a time. */
export const MAX_MARKED_TERMS = 6;
/** Maximum length of a single marked term, matching `TERM_SOURCE` in `ui/term-marker.js`. */
export const MAX_TERM_LENGTH = 60;

/** Clean a raw term: single-line, trimmed, collapsed internal spaces, and 1..MAX_TERM_LENGTH chars. */
export function normalizeTerm(raw) {
  if (raw == null) return "";
  const text = String(raw);
  if (/[\r\n\u2028\u2029]/.test(text)) return "";
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned.length > MAX_TERM_LENGTH) return "";
  return cleaned;
}

/**
 * Find the word segment covering `offset` in `text` using `Intl.Segmenter`.
 * Returns `{ term, start, end }` when `isWordLike` is true and normalized length fits, else `null`.
 */
export function wordAt(text, offset, locale = "zh-CN") {
  if (typeof text !== "string" || !text) return null;
  const index = Number(offset);
  if (!Number.isInteger(index) || index < 0 || index >= text.length) return null;
  const segmenter = new Intl.Segmenter(locale || "zh-CN", { granularity: "word" });
  for (const seg of segmenter.segment(text)) {
    const start = seg.index;
    const end = start + seg.segment.length;
    if (index >= start && index < end) {
      if (!seg.isWordLike) return null;
      const term = normalizeTerm(seg.segment);
      return term ? { term, start, end } : null;
    }
  }
  return null;
}

function tryCombine(parts, node) {
  const combined = normalizeTerm(parts.map((part) => part.term).join(""));
  if (!combined) return null;
  return {
    node,
    start: parts[0].start,
    end: parts[parts.length - 1].end,
    term: combined,
  };
}

/**
 * Merge `nextHit` with contiguous entries inside the same text node when the combined term <= MAX_TERM_LENGTH.
 * Returns `{ entries, entry, merged, replaced }`.
 */
export function mergeAdjacent(entries, nextHit) {
  const list = Array.isArray(entries) ? entries : [];
  const normalizedTerm = normalizeTerm(nextHit?.term);
  if (!normalizedTerm) {
    return { entries: [...list], entry: null, merged: false, replaced: [] };
  }
  const hit = {
    node: nextHit?.node ?? null,
    start: Number.isInteger(nextHit?.start) ? nextHit.start : null,
    end: Number.isInteger(nextHit?.end) ? nextHit.end : null,
    term: normalizedTerm,
  };

  if (hit.node != null && hit.start !== null && hit.end !== null && hit.end > hit.start) {
    const leftIndex = list.findIndex((item) => item?.node === hit.node && item.end === hit.start);
    const rightIndex = list.findIndex((item) => item?.node === hit.node && hit.end === item.start);
    const left = leftIndex >= 0 ? list[leftIndex] : null;
    const right = rightIndex >= 0 ? list[rightIndex] : null;

    let mergedEntry = null;
    let mergedIndices = [];
    if (left && right) {
      mergedEntry = tryCombine([left, hit, right], hit.node);
      if (mergedEntry) mergedIndices = [leftIndex, rightIndex];
    }
    if (!mergedEntry && left) {
      mergedEntry = tryCombine([left, hit], hit.node);
      if (mergedEntry) mergedIndices = [leftIndex];
    }
    if (!mergedEntry && right) {
      mergedEntry = tryCombine([hit, right], hit.node);
      if (mergedEntry) mergedIndices = [rightIndex];
    }

    if (mergedEntry) {
      const replaceAt = Math.min(...mergedIndices);
      const dropSet = new Set(mergedIndices);
      const replaced = mergedIndices.map((idx) => list[idx].term);
      const nextEntries = [];
      for (let i = 0; i < list.length; i++) {
        if (i === replaceAt) nextEntries.push(mergedEntry);
        else if (!dropSet.has(i)) nextEntries.push(list[i]);
      }
      return { entries: nextEntries, entry: mergedEntry, merged: true, replaced };
    }
  }

  return { entries: [...list, hit], entry: hit, merged: false, replaced: [] };
}

/**
 * Toggle `term` in `list` up to `limit` unique terms.
 * Returns `{ terms, added, removed, limitReached }`.
 */
export function toggleTerm(list, term, limit = MAX_MARKED_TERMS) {
  const current = Array.isArray(list) ? list.filter(Boolean) : [];
  const normalized = normalizeTerm(term);
  if (!normalized) {
    return { terms: [...current], added: false, removed: false, limitReached: false };
  }
  if (current.includes(normalized)) {
    return {
      terms: current.filter((item) => item !== normalized),
      added: false,
      removed: true,
      limitReached: false,
    };
  }
  if (current.length >= limit) {
    return { terms: [...current], added: false, removed: false, limitReached: true };
  }
  return {
    terms: [...current, normalized],
    added: true,
    removed: false,
    limitReached: false,
  };
}

function parseReviewEntryCardId(key) {
  if (typeof key !== "string") return "";
  try {
    const parsed = JSON.parse(key);
    return Array.isArray(parsed) && parsed[2] != null && parsed[2] !== "" ? String(parsed[2]) : "";
  } catch {
    return "";
  }
}

function entryCardId(key, entry) {
  if (entry && entry.cardId != null && entry.cardId !== "") return String(entry.cardId);
  return parseReviewEntryCardId(key);
}

/**
 * Remove completed `terms` assist-task terms (case-insensitively) from matching card entries in `entriesByKey`.
 * Clears both `terms` and matching `hits` in memory, preserves terms marked after the task started, and leaves
 * unrelated cards and non-`done` tasks untouched.
 */
export function clearCompletedTermEntries(entriesByKey, tasks) {
  if (!entriesByKey || typeof entriesByKey !== "object" || !Array.isArray(tasks) || !tasks.length) {
    return entriesByKey;
  }
  const dropByCard = new Map();
  for (const task of tasks) {
    if (task?.mode !== "terms" || task?.status !== "done" || task?.cardId == null || task.cardId === "") continue;
    const cardId = String(task.cardId);
    for (const rawTerm of Array.isArray(task.terms) ? task.terms : []) {
      const clean = normalizeTerm(rawTerm);
      if (!clean) continue;
      let set = dropByCard.get(cardId);
      if (!set) {
        set = new Set();
        dropByCard.set(cardId, set);
      }
      set.add(clean.toLowerCase());
    }
  }
  if (!dropByCard.size) return entriesByKey;

  let changed = false;
  const nextEntries = {};
  for (const [key, entry] of Object.entries(entriesByKey)) {
    if (!entry || typeof entry !== "object") {
      nextEntries[key] = entry;
      continue;
    }
    const dropKeys = dropByCard.get(entryCardId(key, entry));
    if (!dropKeys?.size) {
      nextEntries[key] = entry;
      continue;
    }
    const prevTerms = Array.isArray(entry.terms) ? entry.terms : [];
    const prevHits = Array.isArray(entry.hits) ? entry.hits : [];
    const nextTerms = prevTerms.filter((item) => !dropKeys.has(normalizeTerm(item).toLowerCase()));
    const nextHits = prevHits.filter((hit) => !dropKeys.has(normalizeTerm(hit?.term).toLowerCase()));
    if (nextTerms.length !== prevTerms.length || nextHits.length !== prevHits.length) {
      changed = true;
      nextEntries[key] = { ...entry, terms: nextTerms, hits: nextHits };
    } else {
      nextEntries[key] = entry;
    }
  }
  return changed ? nextEntries : entriesByKey;
}

/**
 * Filter candidate unfamiliar terms so only normalized, unique terms not currently in `activeTerms`
 * and not present anywhere in `courseTerms` (regardless of `state`: `'unknown'`, `'learned'`, `'known'`, etc.)
 * are shown as dashed candidates. Matching is case-insensitive.
 */
export function filterCandidateTerms(candidates, activeTerms = [], courseTerms = []) {
  if (!Array.isArray(candidates) || !candidates.length) return [];
  const excluded = new Set();
  for (const raw of Array.isArray(activeTerms) ? activeTerms : []) {
    const clean = normalizeTerm(raw);
    if (clean) excluded.add(clean.toLowerCase());
  }
  for (const entry of Array.isArray(courseTerms) ? courseTerms : []) {
    const rawTerm = typeof entry === "string" ? entry : entry?.term;
    const clean = normalizeTerm(rawTerm);
    if (clean) excluded.add(clean.toLowerCase());
  }
  const seen = new Set();
  const out = [];
  for (const raw of candidates) {
    const clean = normalizeTerm(raw);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key) || excluded.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

/** Format marked unknown terms into the question prompt sent to assist via `uiFormat` and the active locale. */
export function fillQuestion(terms, language = getUiLanguage()) {
  const clean = [];
  for (const raw of Array.isArray(terms) ? terms : []) {
    const term = normalizeTerm(raw);
    if (term && !clean.includes(term)) clean.push(term);
  }
  if (!clean.length) return "";
  const formatPrompt = () =>
    uiFormat(
      "这几个词我不认识：{0}。请一个一个讲：它是为了解决什么问题才出现的，大白话怎么说，正式说法是什么。",
      [clean.join(ui("、"))],
    );
  const previous = getUiLanguage();
  if (language && language !== previous) {
    setUiLanguage(language);
    try {
      return formatPrompt();
    } finally {
      setUiLanguage(previous);
    }
  }
  return formatPrompt();
}
