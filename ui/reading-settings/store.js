import { useSyncExternalStore } from 'react';
import { READER_STORAGE_KEY, loadReaderSettings, normalizeReaderSettings, resetReaderSettings, saveReaderSettings } from './settings.js';

/* The one reading setting of this browser, as a store: every reading surface (the reader, a review explanation, a note, a lesson...)
   subscribes, so a change in one is a change in all that are open; another tab's change arrives through the storage event.
   `storage` is injectable for tests; without it the browser's localStorage is used (and may be blocked: the choice then lives
   in memory for the session). */
export function createReadingStore({ storage } = {}) {
  let current = null;
  const listeners = new Set();
  const get = () => (current ??= loadReaderSettings(storage));
  const set = next => { current = next; saveReaderSettings(next, storage); listeners.forEach(listener => listener()); };
  return {
    get,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    /** Merge a patch; an unchanged result is not a change. */
    update(patch) {
      const before = get(), next = normalizeReaderSettings({ ...before, ...patch });
      if (JSON.stringify(next) !== JSON.stringify(before)) set(next);
    },
    /** 恢复默认: the display everywhere; what the reader has open stays open. */
    reset() { set(resetReaderSettings(get())); },
    /** Read the stored value again (another tab changed it). */
    reload() { current = loadReaderSettings(storage); listeners.forEach(listener => listener()); },
  };
}

export const readingStore = createReadingStore();
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function')
  window.addEventListener('storage', event => { if (event.key === null || event.key === READER_STORAGE_KEY) readingStore.reload(); });

/** [settings, update(patch), reset()]: the reading preferences of this browser, live in every open panel. */
export function useReadingSettings() {
  const settings = useSyncExternalStore(readingStore.subscribe, readingStore.get, readingStore.get);
  return [settings, readingStore.update, readingStore.reset];
}
