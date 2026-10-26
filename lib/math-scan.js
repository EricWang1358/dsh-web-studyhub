/* Where a formula starts and ends in study text: the one scanner behind the cards, the review book, the reader's text sources (ui/study-media.js) and the
   generation gate and autofix (lib/tex-text.js, lib/card-autofix.js). The boundaries live here once, so what the page draws as a formula and what the gate
   counts as delimited math can never disagree.

   Delimiters: $…$ (no space inside, or a space on both sides when what is inside looks like math), $$…$$, \(…\), \[…\], and a math environment written without
   a dollar sign (\begin{align}…\end{align}). "$5 and $10" is currency. */

const escaped = (text, at) => {
  let count = 0;
  while (at > 0 && text[--at] === '\\') count++;
  return count % 2 === 1;
};

function mathOpener(text, at) {
  if (escaped(text, at)) return null;
  for (const delimiter of ['$$', '\\[', '\\(']) {
    if (text.startsWith(delimiter, at)) return delimiter;
  }
  // A letter or underscore right before a "$" makes it prose ("a$b"); a digit does too, except in "5$kg$", where a unit follows the number.
  // "%1$s" and "%2$d" are the position marks of a format string, not a number followed by a unit.
  const before = text[at - 1] || '', after = text[at + 1] || '';
  const formatMark = /%\d+$/.test(text.slice(Math.max(0, at - 6), at));
  const wordBefore = /[A-Za-z_]/.test(before) || (/\d/.test(before) && (formatMark || !/[A-Za-z\\]/.test(after)));
  const modelNewlineBefore = text.slice(at - 2, at) === '\\n';
  return text[at] === '$' && (!wordBefore || modelNewlineBefore) ? '$' : null;
}

/** Math environments written without a $ around them, as pasted from a LaTeX file: whether each one is a display equation. */
const ENVIRONMENTS = { equation: true, 'equation*': true, align: true, 'align*': true, alignat: true, 'alignat*': true, gather: true, 'gather*': true,
  aligned: false, gathered: false, cases: false, array: false, matrix: false, pmatrix: false, bmatrix: false, Bmatrix: false, vmatrix: false, Vmatrix: false };

/** "\begin{align} … \end{align}" at `i`, the whole environment being the formula's source. */
function environmentAt(text, i) {
  if (text[i] !== '\\' || escaped(text, i)) return null;
  const open = /^\\begin\{([A-Za-z]+\*?)\}/.exec(text.slice(i, i + 32));
  if (!open || !Object.hasOwn(ENVIRONMENTS, open[1])) return null;
  const closer = `\\end{${open[1]}}`, end = text.indexOf(closer, i + open[0].length);
  if (end < 0) return null;
  const raw = text.slice(i, end + closer.length);
  return { end: i + raw.length, formula: { source: raw, display: ENVIRONMENTS[open[1]], raw } };
}

const CHINESE = /[　-鿿＀-￯]/;
/** What may stand between "$ " and " $" for the pair to be a formula and not two prices: no Chinese, no plain word of three letters or more (commands such as
 * \frac do not count), and either one letter ("$ x $") or a sign of math (= ^ _ { } \). Starting with a digit needs more than "=": "$ 5 = $ 3" is money. */
const spacedFormula = (inner) => !CHINESE.test(inner) && !/(?<![\\A-Za-z])[A-Za-z]{3,}/.test(inner)
  && (/^[A-Za-z]\d?$/.test(inner) || (/[\\^_{}=]/.test(inner) && !(/^\d/.test(inner) && !/[\\^_{}]/.test(inner))));

/** The formula opening at `i`: { end, formula: { source, display, raw } }, or null. */
export function formulaAt(text, i) {
  const environment = environmentAt(text, i);
  if (environment) return environment;
  const opener = mathOpener(text, i);
  if (!opener) return null;
  const closer = opener === '\\[' ? '\\]' : opener === '\\(' ? '\\)' : opener;
  const display = opener === '$$' || opener === '\\[';
  const start = i + opener.length;
  let end = text.indexOf(closer, start);
  while (end >= 0 && escaped(text, end)) end = text.indexOf(closer, end + closer.length);
  const body = end >= 0 ? text.slice(start, end) : '';
  // Dollar delimiters follow normal prose boundaries: "$5 and $10" is currency. "$ F = ma $" (a space inside on both sides) is a formula too, when what
  // is inside looks like math and holds no Chinese: "$x $ 和 $ y$" must not take " 和 " between its formulas. A space on one side only is prose.
  const inner = body.trim(), spaced = /^\s/.test(body), spacedEnd = /\s$/.test(body);
  const currency = /^\d[\d,.]*(?:[.,;:!?]\s|\s+[A-Za-z]{2,})/.test(inner);
  const dollarShape = !spaced && !spacedEnd ? true : spaced && spacedEnd && spacedFormula(inner);
  const validDollar = opener !== '$' || (dollarShape && !/\d/.test(text[end + 1] || '') && !currency);
  if (!body.trim() || !(display || (!body.includes('\n') && !body.includes('`'))) || !validDollar) return null;
  return { end: end + closer.length, formula: { source: body, display, raw: text.slice(i, end + closer.length) } };
}

/** Every formula of `text` as { start, end }, left to right, the way the renderer reads it (code, links and addresses are the caller's to leave out). */
export function formulaSpans(text) {
  const spans = [];
  for (let i = 0; i < text.length;) {
    const found = formulaAt(text, i);
    if (found) { spans.push({ start: i, end: found.end }); i = found.end; } else i++;
  }
  return spans;
}
