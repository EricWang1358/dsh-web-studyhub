/* Structural sharing for the polled snapshot. The panel gets a fresh object graph on every changed poll; memoised
   views over `data.sources`, `data.decks` ... would all recompute, and every memoised child would render again,
   although the host only changed one key (a review click changes `progress`, `runs`, `today`, not the 1 000 sources).

   shareUnchanged(previous, next, previousTexts) compares each top-level key by its JSON text and hands back the
   previous value for every key that did not change, so identity says what changed. It also returns the texts, to be
   passed back on the next poll: one stringify per key replaces the whole-snapshot stringify the panel used to do. */

/** Did nothing but the fingerprint change? The host rolls the fingerprint over every minute (due counts move with time), so a
 *  new snapshot whose every other key kept its identity is a quiet poll as far as the poll rhythm is concerned. */
export function sameExceptFingerprint(previous, next) {
  if (previous === next) return true;
  if (!previous || !next) return false;
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  for (const key of keys) if (key !== "fingerprint" && previous[key] !== next[key]) return false;
  return true;
}

/** { value, texts, changed }: `value` is `previous` itself when nothing changed, else `next` with unchanged keys taken from `previous`. */
export function shareUnchanged(previous, next, previousTexts = {}) {
  const texts = {}, merged = {};
  let changed = !previous;
  for (const [key, item] of Object.entries(next)) {
    const text = JSON.stringify(item) ?? "";
    texts[key] = text;
    if (previous && Object.hasOwn(previous, key) && previousTexts[key] === text) merged[key] = previous[key];
    else { merged[key] = item; changed = true; }
  }
  if (previous && !changed) for (const key of Object.keys(previous)) if (!Object.hasOwn(next, key)) changed = true;
  return { value: changed ? merged : previous, texts, changed };
}
