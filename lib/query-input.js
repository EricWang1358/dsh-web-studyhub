


const clampInt = (value, fallback, min, max) => {
  const n = Number(value);
  return Number.isInteger(n) ? Math.min(Math.max(n, min), max) : fallback;
};

/* One character of a language written without spaces is a word of its own (熵, 酶); a lone Latin letter or digit is not. */
const SINGLE_CJK = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u;
const keepTerm = (term) => term.length >= 2 || SINGLE_CJK.test(term);

/*
 * The characters that keyword search folds: those whose NFKC form in lower case differs from themselves AND has the same length.
 * A character whose fold would change the string length (a circled-ideograph sign, a ligature, an astral math letter) is left out, so a
 * position in the folded text is the same position in the original. Built once, on first use, from the engine's own Unicode tables.
 */
let folds;
function foldTable() {
  const map = new Map(), ranges = [];
  for (let cp = 0x80; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const char = String.fromCodePoint(cp), folded = char.normalize("NFKC").toLowerCase();
    if (folded === char || folded.length !== char.length) continue;
    map.set(char, folded);
    const last = ranges.at(-1);
    if (last && last[1] === cp - 1) last[1] = cp; else ranges.push([cp, cp]);
  }
  const hex = (cp) => `\\u{${cp.toString(16)}}`;
  return { map, pattern: new RegExp(`[${ranges.map(([from, to]) => (from === to ? hex(from) : `${hex(from)}-${hex(to)}`)).join("")}]`, "gu") };
}
/**
 * The text as keyword search compares it: NFKC (full-width letters and digits become half-width) and lower case, as long as the input.
 * Queries and searched text both go through this. (U+0130, the one letter whose lower case is longer, is kept as it is.)
 */
export function foldText(text) {
  folds ??= foldTable();
  return String(text ?? "").replace(folds.pattern, (char) => folds.map.get(char)).split("İ").map((part) => part.toLowerCase()).join("İ");
}

function searchTerms(args) {
  const input = args.query ?? args.terms ?? args.q ?? args.keywords;
  const help = 'Give a query with at least one term: 2+ characters, or one Chinese/Japanese/Korean character (a single letter or digit is too short), e.g. {"query":"iframe"}. Accepted fields: query, terms, q, keywords (a string or array of strings).';
  if (typeof input !== "string" && !(Array.isArray(input) && input.every((term) => typeof term === "string")))
    throw new Error(help);
  const text = String(input ?? "");
  const raw = Array.isArray(input)
    ? input
    : /[|,，、"]|\sOR\s/i.test(text)
      ? text.replace(/"/g, "|").split(/\s*(?:\||,|，|、|\sOR\s)\s*/i)
      : text.split(/\s+/);
  const terms = [...new Set(raw.map((t) => foldText(String(t).trim())).filter(keepTerm))].slice(0, 12);
  if (!terms.length) throw new Error(help);
  return terms;
}

export { clampInt, searchTerms };
