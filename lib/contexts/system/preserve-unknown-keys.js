/* Single source of truth for rollback-safe settings normalization (#1629).
   Pure and browser-safe (zero Node imports) so both Node storage modules and
   UI-shared settings contracts use the exact same unknown-key preservation and
   prototype-pollution guard. */

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function cloneJsonSafe(value, seen = new WeakSet()) {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'boolean' || type === 'string') return value;
  if (type === 'number') return Number.isFinite(value) ? value : undefined;
  if (type !== 'object') return undefined;
  if (seen.has(value)) return undefined;
  if (Array.isArray(value)) {
    seen.add(value);
    const out = [];
    for (let i = 0; i < value.length; i += 1) {
      const cloned = cloneJsonSafe(value[i], seen);
      out.push(cloned === undefined ? null : cloned);
    }
    seen.delete(value);
    return out;
  }
  if (!isPlainObject(value)) return undefined;
  seen.add(value);
  const out = {};
  for (const key of Object.keys(value)) {
    if (UNSAFE_KEYS.has(key)) continue;
    const cloned = cloneJsonSafe(value[key], seen);
    if (cloned !== undefined) {
      Object.defineProperty(out, key, { value: cloned, enumerable: true, writable: true, configurable: true });
    }
  }
  seen.delete(value);
  return out;
}

/**
 * Copy unknown own enumerable keys from `raw` onto a shallow copy of `normalized`
 * without altering any validated known key or mutating `raw` / `normalized`.
 *
 * - No-op when `raw` is not a plain object (null, array, primitive, class instance).
 * - Never overwrites keys already present on `normalized`.
 * - Skips keys in `dropKeys` (intentionally removed legacy keys or validated-absent optional known keys).
 * - Blocks prototype-pollution keys (`__proto__`, `constructor`, `prototype`) at every nesting depth.
 * - Deep-clones JSON-safe values and ignores `undefined`, functions, symbols, non-finite numbers, and cycles.
 */
export function preserveUnknownKeys(raw, normalized, dropKeys = null) {
  if (!isPlainObject(raw)) return normalized;
  const dropped = dropKeys == null ? null : dropKeys instanceof Set ? dropKeys : new Set(dropKeys);
  const seen = new WeakSet([raw]);
  let out = null;
  for (const key of Object.keys(raw)) {
    if (UNSAFE_KEYS.has(key)) continue;
    if (Object.hasOwn(normalized, key)) continue;
    if (dropped?.has(key)) continue;
    if (raw[key] === undefined) continue;
    const cloned = cloneJsonSafe(raw[key], seen);
    if (cloned === undefined) continue;
    if (out === null) out = { ...normalized };
    Object.defineProperty(out, key, { value: cloned, enumerable: true, writable: true, configurable: true });
  }
  return out ?? normalized;
}
