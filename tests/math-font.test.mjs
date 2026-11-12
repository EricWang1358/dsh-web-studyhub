/* #996: a formula is drawn with the standard LaTeX look in every surface, offline. KaTeX lays it out in HTML with its own fonts (Computer Modern
   shapes), the MathML beside it for screen readers. Before, the app relied on native MathML: Chromium draws only mathvariant="normal", so
   \mathbb{E}, \mathcal{F}, \mathbf{v}, \mathfrak{g} came out as plain letters whatever font was installed, and the glyphs were whatever
   serif the machine had. The stylesheet and the fonts are one generated module (ui/fonts/math-data.js), woff2 data: URIs, no address. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderStudyFormula, installMathStyle, MATH_CSS, MATH_STYLE, MATH_STYLE_MARKER } from '../ui/study-math-render.js';
import { mathDataSource } from '../ui/fonts/build-math-data.mjs';
import { renderNoteMarkdown } from '../ui/note-markdown.js';
import { renderMarkdown } from '../ui/markdown-page.js';
import { staticPage } from '../ui/static-page.js';
import { MATH_SAMPLES } from './helpers/math-samples.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('a formula is laid out by KaTeX with its own fonts, and keeps its MathML for screen readers', () => {
  const html = renderStudyFormula(String.raw`\mathbb{E}[X] + \mathcal{F} + \mathbf{v} + \mathfrak{g} + \sum_{i\ge1} x_i^2`, false);
  assert.match(html, /<span class="katex-html" aria-hidden="true">/);
  for (const face of ['mathbb', 'mathcal', 'mathbf', 'mathfrak']) assert.match(html, new RegExp(`class="mord ${face}"`), face);
  assert.match(html, /<span class="katex-mathml"><math/);
  assert.match(renderStudyFormula(String.raw`\left(\frac{a}{b}\right)`, true), /class="katex-display"/);
  assert.match(renderStudyFormula(String.raw`\ce{2H2 + O2 -> 2H2O}`, false), /class="katex-html"/, 'mhchem too');
});

test('every glyph of the samples is in a bundled KaTeX font (its metrics, measured from those fonts, exist for it)', (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  for (const source of MATH_SAMPLES) assert.match(renderStudyFormula(source, true) ?? '', /class="katex-html"/, source);
  assert.deepEqual(warnings, [], 'KaTeX warns "No character metrics" for a glyph its fonts do not have');
  renderStudyFormula('\\star + ☃', false);
  assert.ok(warnings.some((warning) => /No character metrics for '☃'/.test(warning)), 'and the check sees one that is missing');
});

test('the stylesheet carries every KaTeX font as a woff2 data: URI that swaps in, and names no address', () => {
  const faces = MATH_CSS.match(/@font-face\{[^}]*\}/g) || [];
  assert.equal(faces.length, 20, 'all twenty KaTeX faces: Main, Math, AMS, Caligraphic, Fraktur, SansSerif, Script, Typewriter, Size1-4');
  for (const face of faces) {
    assert.match(face, /src:url\(data:font\/woff2;base64,d09GMg/, face.slice(0, 60));
    assert.match(face, /font-display:swap/, 'a formula shows at once in the fallback serif; the font never blocks the page');
  }
  assert.doesNotMatch(MATH_CSS, /url\((?!data:font\/woff2;base64,)/, 'no font file is fetched');
  assert.doesNotMatch(MATH_CSS, /https?:\/\/|@import/);
  assert.match(MATH_CSS, /\.katex-mathml\{/, 'the MathML is kept out of sight by the same sheet');
});

test('math-data.js is what the generator makes from the installed KaTeX, and the licence travels with it', async () => {
  assert.equal(read('ui/fonts/math-data.js'), await mathDataSource(), 'regenerate with node ui/fonts/build-math-data.mjs');
  assert.equal(read('ui/fonts/KaTeX-LICENSE.txt'), read('node_modules/katex/LICENSE'));
  assert.match(read('ui/fonts/math-data.js'), /^\/\*! KaTeX \d+\.\d+\.\d+ stylesheet and fonts \(MIT/, 'a legal comment, kept in the built chunk');
});

test('the stylesheet is put into the document once, the first time a formula is drawn', () => {
  const appended = [];
  const head = { querySelector: (selector) => appended.find((element) => selector === `style[data-${MATH_STYLE_MARKER}]` && element.marked) ?? null,
    appendChild: (element) => appended.push(element) };
  const doc = { head, createElement: () => ({ marked: false, textContent: '', setAttribute(name) { if (name === `data-${MATH_STYLE_MARKER}`) this.marked = true; } }) };
  installMathStyle(doc);
  installMathStyle(doc);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].textContent, MATH_STYLE);
  assert.ok(MATH_STYLE.startsWith('@layer study.reset {') && MATH_STYLE.includes(MATH_CSS), 'in the app\'s lowest layer, so the app\'s formula rules win');
  assert.doesNotThrow(() => installMathStyle(undefined), 'outside a browser nothing happens');
  assert.doesNotThrow(() => installMathStyle({}), 'nor in a partial document');
  const saved = globalThis.document;
  globalThis.document = { head: { querySelector: () => null, appendChild: (element) => appended.push(element) }, createElement: doc.createElement };
  try {
    renderStudyFormula('x^2', false);
    assert.equal(appended.length, 2, 'drawing a formula installs it');
  } finally { if (saved === undefined) delete globalThis.document; else globalThis.document = saved; }
});

test('notes draw their formulas the same way', () => {
  const html = renderNoteMarkdown(String.raw`Formula: $\mathbb{R}^k$`);
  assert.match(html, /class="mord mathbb"/);
  assert.match(html, /<math/);
});

test('a saved page carries the stylesheet only when it has a formula, so it draws offline', () => {
  const { html: withMath } = renderMarkdown('Inline $\\mathbb{E}[X]$.');
  assert.match(withMath, /class="katex"/);
  assert.ok(staticPage({ lang: 'en', title: 'T', css: 'body{}', body: withMath, mathCss: MATH_CSS }).includes(MATH_CSS), 'a page with a formula embeds the fonts');
  const { html: plain } = renderMarkdown('No formula here, only $5 and $10.');
  assert.ok(!staticPage({ lang: 'en', title: 'T', css: 'body{}', body: plain, mathCss: MATH_CSS }).includes('@font-face'), 'a page without one stays small');
});
