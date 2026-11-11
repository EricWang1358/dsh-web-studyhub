/* A short list of the learner's own one-line texts: trimmed, each once, in the order they were saved, at most `count` of at most `length` characters. The one contract
   behind the 修题 phrases (lib/fix-phrases.js) and a course's 出题守则 (lib/course-rules.js). Pure and browser-safe, no imports.
   `one` / `many` name the item in the errors of the strict read ("Invalid fix phrase: …", "Invalid fix phrases: …"). */
export function shortTextList({ count, length }, { one, many }) {
  const fits = text => text.length > 0 && text.length <= length;
  const unique = list => [...new Set(list)];
  /** Why `text` cannot be added to `list` ('empty' | 'saved' | 'long' | 'full'), or { ok: true }. */
  const canAdd = (list, text) => {
    const item = String(text ?? '').trim();
    if (!item) return { ok: false, reason: 'empty' };
    if (list.includes(item)) return { ok: false, reason: 'saved' };
    if (item.length > length) return { ok: false, reason: 'long' };
    if (list.length >= count) return { ok: false, reason: 'full' };
    return { ok: true };
  };
  return Object.freeze({
    /** Forgiving read of a saved or restored list: what is not usable text is left out, and the first `count` items stay. */
    normalize: raw => (Array.isArray(raw) ? unique(raw.filter(item => typeof item === 'string').map(item => item.trim()).filter(fits)).slice(0, count) : []),
    /** Strict read of a list the caller wants saved: a wrong shape, an item over the limit or one item too many fails before the library changes. */
    validate(value) {
      if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error(`Invalid ${many}: expected a list of text`);
      const list = unique(value.map(item => item.trim()).filter(item => item.length > 0));
      if (list.some(item => item.length > length)) throw new Error(`Invalid ${one}: more than ${length} characters`);
      if (list.length > count) throw new Error(`Invalid ${many}: more than ${count}`);
      return list;
    },
    canAdd,
    /** `list` with `text` at the end; the same list when the text cannot be added. Adding it twice ends in the same state. */
    add: (list, text) => (canAdd(list, text).ok ? [...list, String(text).trim()] : list),
    /** `list` without `item`. */
    remove: (list, item) => list.filter(entry => entry !== item),
  });
}
