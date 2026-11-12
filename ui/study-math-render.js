import katex from 'katex/dist/katex.js';
import 'katex/dist/contrib/mhchem.js';
import MATH_LAYOUT_CSS from './fonts/math-css.js';

export { MATH_LAYOUT_CSS };

/* Commands notes copy from the `physics` and `siunitx` packages and from older LaTeX that KaTeX does not know. Each is written out in what KaTeX
   does know, so a physics note draws instead of falling back to its source. Only the commands whose meaning is certain are here, and a macro that
   cannot be sure of its arguments refuses (the formula then shows its source, as before) rather than draw something else: a leading `[` or `*`
   (the optional-argument and starred forms), a derivative written with one argument or with three. Left out on purpose, because the package draws
   something else than the plain text they would give: \qty, \ev, \va, \vu, \ang, \num. Anything not listed still falls back to its source. */

/** The source text of the tokens `consumeArgs` returns (they come last-first, and the lexer has dropped the space after a control word: put it back). */
const textOf = (tokens) => tokens.slice().reverse().map((token) => (/^\\[A-Za-z@]+$/.test(token.text) ? `${token.text} ` : token.text)).join('');
const refuse = (what) => { throw new Error(`${what} is not drawn`); };
const refuseOptional = (context, name) => { if (['[', '*'].includes(context.future().text)) refuse(`${name} with an optional or starred form`); };

/** A command of `count` arguments, replaced by `template` (#1, #2 … stand for the arguments). `only[n]` is the pattern argument n must match, or the command is not drawn. */
const fixed = (name, count, template, only = []) => (context) => {
  refuseOptional(context, name);
  const args = context.consumeArgs(count).map(textOf);
  args.forEach((text, at) => { if (only[at]) plainOnly(name, only[at], text); });
  return template.replace(/#(\d)/g, (_, n) => args[n - 1]);
};
/** siunitx writes a number as `1.6e-19`, `3+-0.1` or `1,5` and draws a power of ten or a ± for it: only a plain number is drawn as it stands. */
const PLAIN_NUMBER = /^[-+]?\d+(?:\.\d+)?$/;
/** A unit as plain text: letters, digits, "/", "^", braces, minus and spaces. A dot, a tilde or a unit macro (\per, \meter) is drawn differently by the package. */
const PLAIN_UNIT = /^[A-Za-z0-9/^{}\- ]+$/;
const plainOnly = (name, pattern, text) => { if (!pattern.test(text.trim())) refuse(`${name} with an argument the package draws differently`); return text; };

/** A command that takes `count` arguments and draws nothing. */
const gobble = (name, count) => (context) => { refuseOptional(context, name); context.consumeArgs(count); return ''; };
/** \dv{f}{x} and \pdv{f}{x}: exactly two groups. One group (the operator form), a third group or an optional order is another formula. */
const derivative = (name, top) => (context) => {
  refuseOptional(context, name);
  const [first] = context.consumeArgs(1);
  if (context.future().text !== '{') refuse(`${name} with one argument`);
  const [second] = context.consumeArgs(1);
  if (context.future().text === '{') refuse(`${name} with three arguments`);
  return `\\frac{${top}${textOf(first)}}{${top}${textOf(second)}}`;
};

const MACROS = {
  '\\mbox': fixed('\\mbox', 1, '\\text{#1}'),
  '\\mathbbm': fixed('\\mathbbm', 1, '\\mathbb{#1}'),
  '\\upmu': '\\mathrm{\\mu}',
  '\\micro': '\\mathrm{\\mu}',
  '\\unit': (context) => fixed('\\unit', 1, '\\mathrm{#1}', [PLAIN_UNIT])(context),
  '\\si': (context) => fixed('\\si', 1, '\\mathrm{#1}', [PLAIN_UNIT])(context),
  '\\SI': (context) => fixed('\\SI', 2, '#1\\,\\mathrm{#2}', [PLAIN_NUMBER, PLAIN_UNIT])(context),
  '\\dv': derivative('\\dv', '\\mathrm{d}'),
  '\\pdv': derivative('\\pdv', '\\partial '),
  '\\vb': fixed('\\vb', 1, '\\mathbf{#1}'),
  '\\abs': fixed('\\abs', 1, '\\left|#1\\right|'),
  '\\norm': fixed('\\norm', 1, '\\left\\|#1\\right\\|'),
  '\\eqref': fixed('\\eqref', 1, '\\text{(#1)}'),
  '\\label': gobble('\\label', 1),
  '\\require': gobble('\\require', 1),
};

/* How a formula is drawn (#996): KaTeX lays it out in HTML with its own fonts, the shapes of LaTeX's Computer Modern, and keeps the MathML beside it,
   out of sight, for screen readers (output 'htmlAndMathml'). Native MathML alone was not enough: Chromium draws only mathvariant="normal", so
   \mathbb{E}, \mathcal{F}, \mathbf{v} and \mathfrak{g} came out as plain letters whatever font the machine had, and every other glyph was whichever
   serif was installed. The layout stylesheet (ui/fonts/math-css.js, MIT) is part of this chunk. The twenty fonts (ui/fonts/math-data.js, woff2
   data: URIs, font-display swap, SIL OFL 1.1) are about 350 KB, so they are a chunk of their own, asked for when the first formula is drawn: the
   views that only might show a formula (the book, the reader, workflows, notes) import this module without fetching them. A saved page embeds
   both (mathPageCss) when it has a formula. */
export const MATH_STYLE_MARKER = 'study-math';
export const MATH_FONTS_MARKER = 'study-math-fonts';

/** The layout as the app's document takes it: in the app's lowest cascade layer (the order is declared by every app sheet, e.g. ui/markdown.css), so
    the app's own rules for a formula (.md-math, .reader-math) win over KaTeX's defaults; unlayered, KaTeX's would win over every layered rule. */
export const MATH_STYLE = `@layer study.reset {\n${MATH_LAYOUT_CSS}\n}`;

/** The @font-face rules of the twenty KaTeX fonts, from their own chunk (each starts with its licence notice). */
export const loadMathFonts = () => import('./fonts/math-data.js').then(module => module.default);

/** The whole stylesheet a saved page embeds when it draws a formula: the fonts, then the layout, each with its notice, so the file reads offline. */
export const mathPageCss = async () => `${await loadMathFonts()}\n${MATH_LAYOUT_CSS}`;

const styled = new WeakSet();
const appendStyle = (doc, marker, text) => {
  const element = doc.createElement('style');
  element.setAttribute(`data-${marker}`, '');
  element.textContent = text;
  doc.head.appendChild(element);
};

/** Put the layout into the document once, before the first drawing is returned (without it the HTML and the MathML would both show), and ask for
    the fonts; until they arrive a formula shows in the fallback serif. Later formulas only find the document in a WeakSet, nothing is looked up.
    A document that already has the sheet (another copy of this module) is left as it is. A missing or partial document (tests, a saved page built
    outside a browser) is left alone, and a font chunk that fails to load leaves the layout. `load` is injectable for tests. */
export function installMathStyle(doc = globalThis.document, { load = loadMathFonts } = {}) {
  try {
    if (!doc || typeof doc !== 'object' || styled.has(doc)) return;
    const head = doc.head;
    if (!head || typeof head.querySelector !== 'function' || typeof head.appendChild !== 'function' || typeof doc.createElement !== 'function') return;
    styled.add(doc);
    if (head.querySelector(`style[data-${MATH_STYLE_MARKER}]`)) return;
    appendStyle(doc, MATH_STYLE_MARKER, MATH_STYLE);
    load().then(fonts => appendStyle(doc, MATH_FONTS_MARKER, fonts)).catch(() => { /* the fallback serif stays */ });
  } catch { /* the formula still draws; only its fonts are missing */ }
}

/** The only injected markup is generated by local KaTeX with trust disabled. */
export function renderStudyFormula(source, display) {
  try {
    const html = katex.renderToString(source, { output: 'htmlAndMathml', displayMode: display, macros: { ...MACROS },
      trust: false, strict: 'ignore', throwOnError: true, maxExpand: 100, maxSize: 20 });
    installMathStyle();
    return html;
  } catch { return null; }
}
