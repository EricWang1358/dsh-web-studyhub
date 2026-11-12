import { readJSON, writeJSON, browserStorage } from '../../storage.js';

/* 上次读到: where each material was last read, a per-viewer convenience in the browser (like the reader's display settings).
   One place per library and material (`lastReadKey`), the newest LAST_READ_LIMIT only. A place is the reading loop's reading
   context (useReadingLoop's `here()`: the outline entry, the offset into it, the scroll offset and progress, the page and the
   revision), so going back to it is the same restore as 回到阅读 after practice. */

export const LAST_READ_KEY = 'studyhub-last-read:v1';
export const LAST_READ_LIMIT = 200;

/** The store key of a material in a library ('' when either is unknown: nothing is kept). */
export const lastReadKey = (root, materialKey) => (root && materialKey ? `${root}|${materialKey}` : '');

const finite = value => value === undefined || value === null || (Number.isFinite(value) && value >= 0);
const pageNumber = value => Number.isSafeInteger(value) && value > 0;
/* The record also says which view the material was left in (#1001): `view: 'original'` with the page of the 原始 PDF (`originalPage`); no view is the text. */
const isView = value => (value.view === undefined && value.originalPage === undefined) || (value.view === 'original' && pageNumber(value.originalPage));
const isPlace = value => !!value && typeof value === 'object' && !Array.isArray(value)
  && (value.sectionId === null || value.sectionId === undefined || typeof value.sectionId === 'string')
  && finite(value.scrollTop) && finite(value.sectionOffset) && finite(value.progress) && isView(value);

const readAll = storage => {
  const all = readJSON(LAST_READ_KEY, null, storage);
  return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
};

/** The place kept for `key`, or null. */
export function readLastRead(key, storage = browserStorage()) {
  if (!key) return null;
  const entry = readAll(storage)[key];
  return isPlace(entry) ? entry : null;
}

/** Keep `place` as the material's last place; true when it was written. The oldest places go past the limit. */
export function saveLastRead(key, place, { storage = browserStorage(), now = Date.now() } = {}) {
  if (!key || !isPlace(place) || !storage) return false;
  const all = { ...readAll(storage), [key]: { ...place, at: now } };
  const keys = Object.keys(all);
  if (keys.length > LAST_READ_LIMIT) {
    keys.sort((a, b) => (Number(all[a]?.at) || 0) - (Number(all[b]?.at) || 0));
    for (const old of keys.slice(0, keys.length - LAST_READ_LIMIT)) delete all[old];
  }
  return writeJSON(LAST_READ_KEY, all, storage);
}

/**
 * Keep the view the material is read in, in its record: `original` (原始 PDF at `page`) or the text. `place`, the text place of the moment the learner
 * switched, replaces the kept one (it is newer); a page turn passes none and keeps it. Back to the text, the view goes and the place stays.
 */
export function saveLastView(key, { original = false, page, place } = {}, { storage = browserStorage(), now = Date.now() } = {}) {
  if (!key || !storage) return false;
  const kept = place || readLastRead(key, storage);
  const { view: _view, originalPage: _page, at: _at, ...rest } = kept || {};
  if (!original) return kept ? saveLastRead(key, rest, { storage, now }) : true;
  return saveLastRead(key, { ...rest, view: 'original', originalPage: page }, { storage, now });
}

/** Forget the material's place (the learner is back at its start). */
export function forgetLastRead(key, storage = browserStorage()) {
  if (!key || !storage) return false;
  const all = readAll(storage);
  if (!(key in all)) return true;
  delete all[key];
  return writeJSON(LAST_READ_KEY, all, storage);
}

/**
 * Where a reader opening goes back to: the kept place, as a stored reading context the reader resumes (`lastRead: true`), when the
 * material was opened plainly — its first source (the 资料 row), with no quote, no way back, no 看原页图 and not as saved writing.
 * Null otherwise: an open aimed at a place goes there.
 */
export function lastReadOpening({ entry, sourceId, firstSourceId, quote, resume, peekPage, localMode, nonce = Date.now() }) {
  if (!entry || localMode || quote || resume || peekPage) return null;
  if (firstSourceId && sourceId !== firstSourceId) return null;
  return { ...entry, lastRead: true, nonce };
}
