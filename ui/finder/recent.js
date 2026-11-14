import { browserStorage, readJSON, writeJSON } from '../storage.js';

const KEY = 'studyhub:finder-recent';
const MAX_RECENT = 4;

/** Read up to four recently visited Feature Finder entry IDs. */
export function readRecentFinderIds(storage = browserStorage()) {
  const raw = readJSON(KEY, [], storage);
  if (!Array.isArray(raw)) return [];
  const unique = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !item || unique.includes(item)) continue;
    unique.push(item);
    if (unique.length >= MAX_RECENT) break;
  }
  return unique;
}

/** Prepend `id` to the recent Feature Finder entries (deduplicated, capped at 4). */
export function recordRecentFinderId(id, storage = browserStorage()) {
  if (typeof id !== 'string' || !id) return readRecentFinderIds(storage);
  const next = [id, ...readRecentFinderIds(storage).filter((existing) => existing !== id)].slice(0, MAX_RECENT);
  writeJSON(KEY, next, storage);
  return next;
}

/** Clear stored recent Feature Finder entries. */
export function clearRecentFinderIds(storage = browserStorage()) {
  try {
    if (storage?.removeItem) storage.removeItem(KEY);
    else writeJSON(KEY, [], storage);
  } catch {
    writeJSON(KEY, [], storage);
  }
  return [];
}

/** Resolve reachable Feature Finder entries matching `recentIds`. */
export function recentFinderEntries(markedEntries, recentIds) {
  if (!Array.isArray(markedEntries) || !Array.isArray(recentIds) || !recentIds.length) return [];
  const byId = new Map(markedEntries.map((entry) => [entry.id, entry]));
  const out = [];
  for (const id of recentIds) {
    const entry = byId.get(id);
    if (entry && entry.kind !== 'term' && !entry.unavailable) out.push(entry);
  }
  return out;
}
