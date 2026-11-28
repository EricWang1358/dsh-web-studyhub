// @ts-check
/* Rollback-safe unknown-key preservation for desktop domain config (#1629).
   Kept inside `packages/studyhub-desktop/domain/` so the desktop domain layer
   remains pure with zero imports outside `domain/` (tests/desktop-architecture-boundaries.test.mjs). */

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * @param {Record<string, unknown>} value
 * @param {WeakSet<object>} seen
 * @returns {Record<string, unknown>}
 */
function clonePlainObject(value, seen) {
  seen.add(value);
  /** @type {Record<string, unknown>} */
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
 * @param {unknown} value
 * @param {WeakSet<object>} seen
 * @returns {unknown}
 */
function cloneJsonSafe(value, seen) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'object' || seen.has(value)) return undefined;
  if (Array.isArray(value)) {
    seen.add(value);
    const out = value.map((item) => {
      const cloned = cloneJsonSafe(item, seen);
      return cloned === undefined ? null : cloned;
    });
    seen.delete(value);
    return out;
  }
  return isPlainObject(value) ? clonePlainObject(value, seen) : undefined;
}

/**
 * Copy unknown own enumerable keys from `raw` onto a shallow copy of `normalized`
 * without altering validated known keys or allowing prototype pollution.
 * @template {Record<string, unknown>} T
 * @param {unknown} raw
 * @param {T} normalized
 * @returns {T}
 */
export function preserveUnknownDesktopKeys(raw, normalized) {
  if (!isPlainObject(raw)) return normalized;
  const seen = new WeakSet([raw]);
  /** @type {Record<string, unknown> | null} */
  let out = null;
  for (const key of Object.keys(raw)) {
    if (UNSAFE_KEYS.has(key) || Object.hasOwn(normalized, key) || raw[key] === undefined) continue;
    const cloned = cloneJsonSafe(raw[key], seen);
    if (cloned === undefined) continue;
    if (out === null) out = { ...normalized };
    Object.defineProperty(out, key, { value: cloned, enumerable: true, writable: true, configurable: true });
  }
  return /** @type {T} */ (out ?? normalized);
}
