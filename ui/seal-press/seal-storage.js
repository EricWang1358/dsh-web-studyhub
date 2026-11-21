/* Local Seal Album persistence (`study-seal-album`, capped at 60 entries) and in-round
   leech-conquest memory so Review.jsx can award an honest 破顽 round seal when the learner
   conquered a stubborn question during the round. */
import { browserSession, browserStorage, readJSON, writeJSON } from '../storage.js';

export const SEAL_ALBUM_KEY = 'study-seal-album';
export const SEAL_ALBUM_CHANGE_EVENT = 'study-seal-album-change';
export const MAX_ALBUM_ENTRIES = 60;
const CONQUERED_SESSION_KEY = 'study-seal-conquered-leeches';
const MAX_TRACKED_RUNS = 24;

const VALID_EDITIONS = new Set(['letterpress', 'risograph', 'archival-slip']);
const VALID_SEAL_STYLES = new Set(['yang', 'yin']);
const VALID_SEAL_IDS = new Set([
  'clean-sweep',
  'leech-cleared',
  'night-study',
  'steady-rise',
  'round-done',
  'wrongbook-cleared',
]);

const conqueredByRun = new Map();

function notifyAlbumChange(count, storage) {
  if (typeof window === 'undefined' || storage !== browserStorage()) return;
  try {
    window.dispatchEvent(new CustomEvent(SEAL_ALBUM_CHANGE_EVENT, { detail: { count } }));
  } catch { /* ignore in restricted environments */ }
}

function sanitizeText(value, maxLen) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

/** Normalize one persisted album item, dropping malformed records safely. */
export function normalizeAlbumEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = sanitizeText(raw.id, 120);
  if (!id) return null;
  const sealId = VALID_SEAL_IDS.has(raw.sealId) ? raw.sealId : 'round-done';
  const sealStyle = VALID_SEAL_STYLES.has(raw.sealStyle) ? raw.sealStyle : 'yang';
  const edition = VALID_EDITIONS.has(raw.edition) ? raw.edition : 'letterpress';
  const rawChars = Array.isArray(raw.sealChars) ? raw.sealChars.map((c) => String(c || '').slice(0, 2)).filter(Boolean) : [];
  const sealChars = rawChars.length >= 4
    ? [rawChars[0], rawChars[1], rawChars[2], rawChars[3]]
    : rawChars.length >= 2
      ? [rawChars[0], rawChars[1]]
      : ['笃', '行'];
  const answered = Math.max(0, Math.round(Number(raw.answered) || 0));
  const total = Math.max(answered, Math.round(Number(raw.total) || 0));
  const correct = Math.max(0, Math.min(total || answered, Math.round(Number(raw.correct) || 0)));
  const accuracy = Number.isFinite(Number(raw.accuracy))
    ? Math.max(0, Math.min(100, Math.round(Number(raw.accuracy))))
    : (answered > 0 ? Math.round((correct / answered) * 100) : 0);
  const masteryDelta = raw.masteryDelta === null || raw.masteryDelta === undefined || !Number.isFinite(Number(raw.masteryDelta))
    ? null
    : Math.round(Number(raw.masteryDelta));
  return {
    id,
    runId: sanitizeText(raw.runId, 100),
    savedAt: sanitizeText(raw.savedAt, 40) || new Date().toISOString(),
    dateLabel: sanitizeText(raw.dateLabel, 24),
    title: sanitizeText(raw.title, 80) || 'StudyHub',
    course: sanitizeText(raw.course, 60),
    answered,
    total,
    correct,
    accuracy,
    sealId,
    sealChars,
    sealStyle,
    seed: Number.isFinite(Number(raw.seed)) ? (Number(raw.seed) >>> 0) : 1,
    edition,
    note: sanitizeText(raw.note, 80),
    masteryDelta,
  };
}

/** Read saved collectible postcards from localStorage (newest first, capped cleanly at 60). */
export function loadSealAlbum(storage = browserStorage()) {
  const stored = readJSON(SEAL_ALBUM_KEY, [], storage);
  if (!Array.isArray(stored)) return [];
  const seen = new Set();
  const out = [];
  for (const item of stored) {
    const clean = normalizeAlbumEntry(item);
    if (!clean || seen.has(clean.id)) continue;
    seen.add(clean.id);
    out.push(clean);
    if (out.length >= MAX_ALBUM_ENTRIES) break;
  }
  return out;
}

/** Save or update an entry in the local Seal Album, keeping the newest MAX_ALBUM_ENTRIES items. */
export function saveSealAlbumEntry(entry, storage = browserStorage()) {
  const clean = normalizeAlbumEntry(entry);
  const current = loadSealAlbum(storage);
  if (!clean) return current;
  const next = [clean, ...current.filter((item) => item.id !== clean.id)].slice(0, MAX_ALBUM_ENTRIES);
  writeJSON(SEAL_ALBUM_KEY, next, storage);
  notifyAlbumChange(next.length, storage);
  return next;
}

/** Remove a saved entry by id and persist the updated album. */
export function removeSealAlbumEntry(id, storage = browserStorage()) {
  const target = sanitizeText(id, 120);
  const current = loadSealAlbum(storage);
  if (!target) return current;
  const next = current.filter((item) => item.id !== target);
  if (next.length !== current.length) {
    writeJSON(SEAL_ALBUM_KEY, next, storage);
    notifyAlbumChange(next.length, storage);
  }
  return next;
}

function hydrateConqueredSession() {
  const session = browserSession();
  const stored = readJSON(CONQUERED_SESSION_KEY, null, session);
  if (!stored || typeof stored !== 'object') return;
  for (const [runId, list] of Object.entries(stored)) {
    if (!Array.isArray(list) || conqueredByRun.has(runId)) continue;
    conqueredByRun.set(runId, new Set(list.map((id) => String(id))));
  }
}

function persistConqueredSession() {
  const session = browserSession();
  if (!session) return;
  const entries = [...conqueredByRun.entries()].slice(-MAX_TRACKED_RUNS);
  const plain = Object.fromEntries(entries.map(([runId, set]) => [runId, [...set]]));
  writeJSON(CONQUERED_SESSION_KEY, plain, session);
}

/** Record that the learner passed a stubborn/leech card during this review round. */
export function recordConqueredLeech(runId, cardId) {
  if (!runId || !cardId) return 0;
  hydrateConqueredSession();
  let set = conqueredByRun.get(runId);
  if (!set) {
    set = new Set();
    conqueredByRun.set(runId, set);
    while (conqueredByRun.size > MAX_TRACKED_RUNS) {
      const oldest = conqueredByRun.keys().next().value;
      conqueredByRun.delete(oldest);
    }
  }
  const before = set.size;
  set.add(String(cardId));
  if (set.size !== before) persistConqueredSession();
  return set.size;
}

/** How many stubborn/leech cards were conquered in `runId`. */
export function getConqueredLeechCount(runId) {
  if (!runId) return 0;
  hydrateConqueredSession();
  return conqueredByRun.get(runId)?.size || 0;
}

/** Reset in-memory conquered leech tracking (used by unit tests). */
export function resetConqueredLeechesForTests() {
  conqueredByRun.clear();
  const session = browserSession();
  if (session) {
    try { session.removeItem(CONQUERED_SESSION_KEY); } catch { /* ignore storage errors */ }
  }
}
