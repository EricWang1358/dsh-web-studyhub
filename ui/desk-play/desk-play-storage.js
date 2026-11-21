/* Local preferences for the Home Desk Play strip (hide/restore).
   Safe under SSR and restricted storage environments. */

import { browserStorage } from '../storage.js';

export const DESK_PLAY_STORAGE_KEY = 'study-desk-play';

export const DEFAULT_DESK_PLAY_PREFS = Object.freeze({ hidden: false });

const memoryFallback = new Map();

function resolveStorage(explicit) {
  return explicit || browserStorage();
}

export function readDeskPlayPrefs(storage) {
  const store = resolveStorage(storage);
  try {
    const raw = store ? store.getItem(DESK_PLAY_STORAGE_KEY) : memoryFallback.get(DESK_PLAY_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_DESK_PLAY_PREFS };
    const parsed = JSON.parse(raw);
    return { hidden: Boolean(parsed && typeof parsed === 'object' && parsed.hidden) };
  } catch {
    return { ...DEFAULT_DESK_PLAY_PREFS };
  }
}

export function writeDeskPlayPrefs(patch, storage) {
  const next = { ...readDeskPlayPrefs(storage), ...(patch && typeof patch === 'object' ? { hidden: Boolean(patch.hidden) } : {}) };
  const serialized = JSON.stringify(next);
  const store = resolveStorage(storage);
  if (store) {
    try { store.setItem(DESK_PLAY_STORAGE_KEY, serialized); } catch { /* quota or blocked storage */ }
  } else {
    memoryFallback.set(DESK_PLAY_STORAGE_KEY, serialized);
  }
  return next;
}
