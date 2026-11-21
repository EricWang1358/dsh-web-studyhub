// Browser equivalent of node:util's isDeepStrictEqual for the static demo runtime.

function bytesEqual(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  const va = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const vb = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < va.length; i++) if (va[i] !== vb[i]) return false;
  return true;
}

function ownEnumerableKeys(obj) {
  const keys = Object.keys(obj);
  const syms = Object.getOwnPropertySymbols(obj);
  for (const sym of syms) {
    if (Object.prototype.propertyIsEnumerable.call(obj, sym)) keys.push(sym);
  }
  return keys;
}

function compareDeep(a, b, seen) {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;

  if (a instanceof Date) return Object.is(a.getTime(), b.getTime());
  if (a instanceof RegExp) return a.source === b.source && a.flags === b.flags;
  if (ArrayBuffer.isView(a)) return ArrayBuffer.isView(b) && bytesEqual(a, b);
  if (a instanceof ArrayBuffer) return b instanceof ArrayBuffer && bytesEqual(new Uint8Array(a), new Uint8Array(b));

  let paired = seen.get(a);
  if (paired) {
    if (paired.has(b)) return true;
    paired.add(b);
  } else {
    paired = new Set([b]);
    seen.set(a, paired);
  }

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (Object.hasOwn(a, i) !== Object.hasOwn(b, i)) return false;
      if (!compareDeep(a[i], b[i], seen)) return false;
    }
    const keysA = ownEnumerableKeys(a);
    const keysB = ownEnumerableKeys(b);
    if (keysA.length !== keysB.length) return false;
    for (const k of keysA) {
      if (!Object.hasOwn(b, k) || !compareDeep(a[k], b[k], seen)) return false;
    }
    return true;
  }

  if (a instanceof Set) {
    if (!(b instanceof Set) || a.size !== b.size) return false;
    const unmatched = [];
    for (const item of b) unmatched.push(item);
    for (const item of a) {
      if (b.has(item)) {
        const idx = unmatched.findIndex((candidate) => Object.is(candidate, item));
        if (idx !== -1) { unmatched.splice(idx, 1); continue; }
      }
      const idx = unmatched.findIndex((candidate) => compareDeep(item, candidate, seen));
      if (idx === -1) return false;
      unmatched.splice(idx, 1);
    }
    return true;
  }

  if (a instanceof Map) {
    if (!(b instanceof Map) || a.size !== b.size) return false;
    const unmatched = [...b.entries()];
    for (const [k, v] of a.entries()) {
      if (b.has(k) && compareDeep(v, b.get(k), seen)) {
        const idx = unmatched.findIndex(([bk]) => Object.is(bk, k));
        if (idx !== -1) { unmatched.splice(idx, 1); continue; }
      }
      const idx = unmatched.findIndex(([bk, bv]) => compareDeep(k, bk, seen) && compareDeep(v, bv, seen));
      if (idx === -1) return false;
      unmatched.splice(idx, 1);
    }
    return true;
  }

  const keysA = ownEnumerableKeys(a);
  const keysB = ownEnumerableKeys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.hasOwn(b, key) || !compareDeep(a[key], b[key], seen)) return false;
  }
  return true;
}

export function isDeepStrictEqual(a, b) {
  return compareDeep(a, b, new WeakMap());
}
