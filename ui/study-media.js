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
  const wordBefore = /\w/.test(text[at - 1] || '');
  const modelNewlineBefore = text.slice(at - 2, at) === '\\n';
  return text[at] === '$' && (!wordBefore || modelNewlineBefore) ? '$' : null;
}

/** Shield formulas before Markdown/HTML normalization, including model newline repair.
 * Code is shielded only during newline repair and never interpreted as math. */
export function prepareStudyMath(source) {
  const formulas = [], code = [];
  const text = String(source || '').replace(MARKER, '');
  let value = '', i = 0;
  while (i < text.length) {
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
      if (end >= 0 || fence) {
        end = end < 0 ? text.length : end + delimiter.length;
        value += `\uE000c${code.length}\uE001`;
        code.push(text.slice(i, end)); i = end; continue;
      }
    }
    // Addresses and image descriptions are literal; only regular link labels
    // can contain formulas. Keep the same bounded image/link grammar as Markdown.
    const image = rest.startsWith('![') && STUDY_IMAGE_PATTERN.exec(rest);
    const literal = (image?.index === 0 && image) ||
      rest.match(/^\]\([^\n]*?\)/) || rest.match(/^https?:\/\/[^\s<>]+/);
    if (literal) {
      value += `\uE000c${code.length}\uE001`;
      code.push(literal[0]); i += literal[0].length; continue;
    }
    const opener = mathOpener(text, i);
    if (opener) {
      const closer = opener === '\\[' ? '\\]' : opener === '\\(' ? '\\)' : opener;
      const display = opener === '$$' || opener === '\\[';
      const start = i + opener.length;
      let end = text.indexOf(closer, start);
      while (end >= 0 && escaped(text, end)) end = text.indexOf(closer, end + closer.length);
      const body = end >= 0 ? text.slice(start, end) : '';
      // Dollar delimiters follow normal prose boundaries: "$5 and $10" is currency.
      const currency = /^\d[\d,.]*(?:[.,;:!?]\s|\s+[A-Za-z]{2,})/.test(body);
      const validDollar = opener !== '$' || (!/^\s|\s$/.test(body) && !/\d/.test(text[end + 1] || '') && !currency);
      if (body.trim() && (display || (!body.includes('\n') && !body.includes('`'))) && validDollar) {
        value += `\uE000${formulas.length}\uE001`;
        formulas.push({ source: body, display, raw: text.slice(i, end + closer.length) });
        i = end + closer.length; continue;
      }
    }
    value += text[i++];
  }
  value = unescapeModelText(value).replace(/\uE000c(\d+)\uE001/g, (_, index) => code[Number(index)]);
  return { value, formulas };
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
