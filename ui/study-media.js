import { unescapeModelText } from '../lib/model-text.js';
import { safeRasterDataUri } from '../lib/study-image-policy.js';

export const STUDY_IMAGE_PATTERN = /!\[([^\]\n]*)\]\((?:<([^>\n]+)>|([^\s)]+))(?:\s+"[^"\n]*")?\)/;

const MARKER = /[\uE000\uE001]/g;
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
  const before = text[at - 1] || '', after = text[at + 1] || '';
  const wordBefore = /[A-Za-z_]/.test(before) || (/\d/.test(before) && !/[A-Za-z\\]/.test(after));
  const modelNewlineBefore = text.slice(at - 2, at) === '\\n';
  return text[at] === '$' && (!wordBefore || modelNewlineBefore) ? '$' : null;
}

/** Code spans, fences, image/link addresses and bare URLs at `i`: literal text, never math. */
function literalAt(text, i) {
  const rest = text.slice(i);
  const fence = (i === 0 || text[i - 1] === '\n') && rest.match(/^\s*(`{3,}|~{3,})[^\n]*(?:\n|$)/);
  const ticks = rest.match(/^`+/);
  if (fence || ticks) {
    const delimiter = fence ? fence[1] : ticks[0];
    const start = i + (fence ? fence[0].length : delimiter.length);
    let end = text.indexOf(delimiter, start);
    if (fence) {
      while (end >= 0 && !/^\s*$/.test(text.slice(text.lastIndexOf('\n', end) + 1, end))) end = text.indexOf(delimiter, end + delimiter.length);
    }
    if (end >= 0 || fence) return end < 0 ? text.length : end + delimiter.length;
  }
  // Addresses and image descriptions are literal; only regular link labels
  // can contain formulas. Keep the same bounded image/link grammar as Markdown.
  const image = rest.startsWith('![') && STUDY_IMAGE_PATTERN.exec(rest);
  const literal = (image?.index === 0 && image) ||
    rest.match(/^\]\([^\n]*?\)/) || rest.match(/^https?:\/\/[^\s<>]+/);
  return literal ? i + literal[0].length : -1;
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

/** The formula opening at `i`: { end, formula: { source, display, raw } }, or null. */
function formulaAt(text, i) {
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
  const dollarShape = !spaced && !spacedEnd ? true : spaced && spacedEnd && !/[　-鿿＀-￯]/.test(inner) && /[\\^_={}+*/<>|]|^[A-Za-z]\d?$/.test(inner);
  const validDollar = opener !== '$' || (dollarShape && !/\d/.test(text[end + 1] || '') && !currency);
  if (!body.trim() || !(display || (!body.includes('\n') && !body.includes('`'))) || !validDollar) return null;
  return { end: end + closer.length, formula: { source: body, display, raw: text.slice(i, end + closer.length) } };
}

/** Shield formulas before Markdown/HTML normalization, including model newline repair.
 * Code is shielded only during newline repair and never interpreted as math. */
export function prepareStudyMath(source) {
  const formulas = [], code = [];
  const text = String(source || '').replace(MARKER, '');
  let value = '', i = 0;
  while (i < text.length) {
    const literal = literalAt(text, i);
    if (literal >= 0) {
      value += `c${code.length}`;
      code.push(text.slice(i, literal)); i = literal; continue;
    }
    const found = formulaAt(text, i);
    if (found) {
      value += `${formulas.length}`;
      formulas.push(found.formula); i = found.end; continue;
    }
    value += text[i++];
  }
  value = unescapeModelText(value).replace(/c(\d+)/g, (_, index) => code[Number(index)]);
  return { value, formulas };
}

/** Stored text cut into strings and formulas, with nothing rewritten: joining the strings and each
 * formula.raw gives the text back, so readers that map selections to offsets stay exact. */
export function splitStudyMath(source) {
  const text = String(source ?? ''), pieces = [];
  let last = 0, i = 0;
  while (i < text.length) {
    const literal = literalAt(text, i);
    if (literal >= 0) { i = literal; continue; }
    const found = formulaAt(text, i);
    if (!found) { i++; continue; }
    if (i > last) pieces.push(text.slice(last, i));
    pieces.push(found.formula);
    i = last = found.end;
  }
  if (last < text.length) pieces.push(text.slice(last));
  return pieces;
}

/** Embedded raster content is portable; ambient filesystem/browser paths remain refused. */
export function safeStudyImage(src) {
  if (typeof src !== 'string' || !src) return null;
  if (src.startsWith('data:')) return safeRasterDataUri(src);
  if (/[\s\u0000-\u001f\u007f]/.test(src)) return null;
  try {
    const url = new URL(src);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
