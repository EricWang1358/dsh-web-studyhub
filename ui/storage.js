import { useCallback, useEffect, useRef, useState } from 'react';

/* The one safe way to keep a small value in the browser. Storage can be missing (private windows, tests), full or
   blocked, and a stored value can be stale or corrupt: none of that may break a page, so every call swallows it. */

const defaultStorage = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };
/** The browser's persistent storage, or null when it is missing or blocked. */
export const browserStorage = defaultStorage;

/** The stored JSON value, or `fallback` when it is missing, unreadable or not JSON. */
export function readJSON(key, fallback = null, storage = defaultStorage()) {
  try {
    const raw = storage?.getItem(key);
    return raw === null || raw === undefined ? fallback : JSON.parse(raw);
  } catch { return fallback; }
}

/** Store `value` as JSON; true when it was written. */
export function writeJSON(key, value, storage = defaultStorage()) {
  try {
    const text = JSON.stringify(value);
    if (text === undefined || !storage) return false;
    storage.setItem(key, text);
    return true;
  } catch { return false; }
}

/** Forget a key; true when the storage accepted it. */
export function removeKey(key, storage = defaultStorage()) {
  try {
    if (!storage) return false;
    storage.removeItem(key);
    return true;
  } catch { return false; }
}

/** How one key is read and written. `parse(raw)` and `serialize(value)` default to JSON; a parse that throws or answers undefined is a miss. */
export function persistentCodec(key, { parse = JSON.parse, serialize = JSON.stringify } = {}, storage = defaultStorage()) {
  return {
    read(initial) {
      try {
        const raw = storage?.getItem(key);
        if (raw === null || raw === undefined) return initial;
        const value = parse(raw);
        return value === undefined ? initial : value;
      } catch { return initial; }
    },
    write(value) {
      try {
        const text = serialize(value);
        if (text === undefined || !storage) return false;
        storage.setItem(key, String(text));
        return true;
      } catch { return false; }
    },
  };
}

/**
 * useState that survives reloads: read once on mount, written whenever the value changes. `initial` may be a function
 * (called only when nothing is stored). A write that fails keeps the value for this session.
 */
export function usePersistentState(key, initial, { parse, serialize, storage } = {}) {
  const codec = useRef(null);
  codec.current = persistentCodec(key, { parse, serialize }, storage ?? defaultStorage());
  const [value, setValue] = useState(() => codec.current.read(typeof initial === 'function' ? initial() : initial));
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    codec.current.write(value);
  }, [value, key]);
  const set = useCallback(next => setValue(next), []);
  return [value, set];
}
