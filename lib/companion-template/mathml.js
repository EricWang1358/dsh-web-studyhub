/* Offline LaTeX -> W3C MathML compiler powered by `temml` (MIT, zero-dependency pure JS)
   for self-contained interactive companion HTML files.
   Every formula ($...$ or $$...$$) is rendered at compile time into well-formed XML
   <math xmlns="http://www.w3.org/1998/Math/MathML"> stored in a side table (`lesson._math`),
   referenced by `@@SHM_0@@` tokens. Domain plugins carry zero UI npm packages
   (tests/domain-bundle-isolation.test.mjs) and lesson prose stays 100% textNode-only in the browser. */

import temml from 'temml';

const DISPLAY_FORMULA_PATTERN = /\$\$([\s\S]+?)\$\$/g;
const INLINE_FORMULA_OR_CURRENCY_PATTERN = /\\\$|(?<!\$)\$\d+(?:[.,]\d+)*(?![\d.,]*\$)(?=\s+[A-Za-z(]|\s*[.,;:!?)\]]|$)|(?<!\$)\$(?!\$)([^\n$]+?)(?<!\\|\$)\$(?!\$|[0-9])/g;
const RAW_SOURCE_KEYS = new Set([
  'source', 'expr', 'xExpr', 'yExpr', 'dxExpr', 'dyExpr', 'xVar', 'yVar',
  'command', 'path', 'id', 'of', 'lab', 't', 'type', 'beat', 'layout', 'lang', 'tone', 'format', 'template',
]);
const XML_ILLEGAL_CTRL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g;

const escXml = s => String(s)
  .replace(XML_ILLEGAL_CTRL_RE, '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

const fallbackMathMl = (clean, displayMode) => {
  const disp = displayMode ? ' display="block"' : '';
  return `<math xmlns="http://www.w3.org/1998/Math/MathML"${disp}><mtext>${escXml(clean)}</mtext></math>`;
};

/**
 * Compile a single TeX expression to well-formed XML MathML using `temml`
 * (`{ xml: true, throwOnError: false, trust: false }`). Always returns a `<math>...</math>`
 * root element safe for `DOMParser.parseFromString(..., 'application/xml')`, or `null` for empty input.
 */
export function renderTexToMathMl(tex, displayMode = false) {
  const clean = String(tex ?? '').replace(XML_ILLEGAL_CTRL_RE, '').trim();
  if (!clean) return null;
  try {
    const rendered = String(temml.renderToString(clean, {
      displayMode: Boolean(displayMode),
      xml: true,
      throwOnError: false,
      trust: false,
      maxExpand: 1000,
    }) ?? '').replace(XML_ILLEGAL_CTRL_RE, '').trim();
    if (rendered.startsWith('<math') && rendered.endsWith('</math>')) return rendered;
    return fallbackMathMl(clean, displayMode);
  } catch {
    return fallbackMathMl(clean, displayMode);
  }
}

export const latexToMathML = renderTexToMathMl;
export const latexToMathMl = renderTexToMathMl;

/** Replace $...$ and $$...$$ in prose fields with `@@SHM_<index>@@` tokens and populate `_math`. */
export function compileMathInLesson(lesson) {
  const clone = structuredClone(lesson);
  const table = Array.isArray(clone._math) ? [...clone._math] : [];
  const byKey = new Map(table.map((entry, idx) => [`${entry.display ? 'D' : 'I'}:${entry.tex}`, idx]));

  const internFormula = (rawTex, display, whole) => {
    const tex = String(rawTex ?? '').trim();
    if (!tex) return whole;
    // A closed pair around a bare number ("to $0$", "crosses $1.0$") is math the author wrote; bare currency
    // ("$100 to $250") never reaches here because the currency branch of the pattern consumes it first.
    if (!display && /^\d+(?:[.,]\d+)*\s+[A-Za-z(]/.test(tex)) return whole;
    const cacheKey = `${display ? 'D' : 'I'}:${tex}`;
    let index = byKey.get(cacheKey);
    if (index === undefined) {
      const mathml = renderTexToMathMl(tex, display);
      if (!mathml) return whole;
      index = table.length;
      table.push({ tex, display, mathml });
      byKey.set(cacheKey, index);
    }
    return `@@SHM_${index}@@`;
  };

  const replaceString = value => {
    if (typeof value !== 'string' || !value.includes('$')) return value;
    const afterDisplay = value.replace(DISPLAY_FORMULA_PATTERN, (whole, blockTex) => internFormula(blockTex, true, whole));
    return afterDisplay.replace(INLINE_FORMULA_OR_CURRENCY_PATTERN, (whole, inlineTex) => (
      inlineTex === undefined ? whole : internFormula(inlineTex, false, whole)
    ));
  };

  function visit(node, parentKey = '') {
    if (typeof node === 'string') {
      return RAW_SOURCE_KEYS.has(parentKey) ? node : replaceString(node);
    }
    if (Array.isArray(node)) return node.map(item => visit(item, parentKey));
    if (node && typeof node === 'object') {
      if (parentKey === 'experiments' || parentKey === '_math' || parentKey === 'values') return node;
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        if (parentKey === 'terms') {
          out[k] = typeof v === 'string' ? replaceString(v) : visit(v, k);
        } else {
          out[k] = visit(v, k);
        }
      }
      return out;
    }
    return node;
  }

  const transformed = visit(clone, '');
  if (table.length) transformed._math = table;
  return transformed;
}
