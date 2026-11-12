/* #996: a formula is drawn with the standard LaTeX look in every surface, offline. KaTeX lays it out in HTML with its own fonts (Computer Modern
   shapes), the MathML beside it for screen readers. Before, the app relied on native MathML: Chromium draws only mathvariant="normal", so
   \mathbb{E}, \mathcal{F}, \mathbf{v}, \mathfrak{g} came out as plain letters whatever font was installed, and the glyphs were whatever
   serif the machine had. The layout stylesheet (ui/fonts/math-css.js, MIT) goes with the renderer; the twenty fonts (ui/fonts/math-data.js, woff2
   data: URIs, SIL OFL 1.1) are a chunk of their own, loaded when the first formula is drawn, so a page without formulas never fetches them. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderStudyFormula, installMathStyle, loadMathFonts, mathPageCss, MATH_LAYOUT_CSS, MATH_STYLE, MATH_STYLE_MARKER, MATH_FONTS_MARKER } from '../ui/study-math-render.js';
import { mathDataSources } from '../ui/fonts/build-math-data.mjs';
import { renderNoteMarkdown } from '../ui/note-markdown.js';
import { renderMarkdown } from '../ui/markdown-page.js';
import { staticPage } from '../ui/static-page.js';
import { MATH_SAMPLES } from './helpers/math-samples.mjs';

// A Windows checkout may hold the committed text with CRLF; what is compared is the text.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

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

test('the fonts are every KaTeX face as a woff2 data: URI that swaps in; the layout sheet has none, and neither names an address', async () => {
  const fonts = await loadMathFonts();
  const faces = fonts.match(/@font-face\{[^}]*\}/g) || [];
  assert.equal(faces.length, 20, 'all twenty KaTeX faces: Main, Math, AMS, Caligraphic, Fraktur, SansSerif, Script, Typewriter, Size1-4');
  for (const face of faces) {
    assert.match(face, /src:url\(data:font\/woff2;base64,d09GMg/, face.slice(0, 60));
    assert.match(face, /font-display:swap/, 'a formula shows at once in the fallback serif; the font never blocks the page');
  }
  assert.doesNotMatch(MATH_LAYOUT_CSS, /@font-face|data:font/, 'the layout that goes with the renderer carries no font');
  for (const css of [fonts, MATH_LAYOUT_CSS]) {
    assert.doesNotMatch(css, /url\((?!data:font\/woff2;base64,)/, 'no font file is fetched');
    assert.doesNotMatch(css, /https?:\/\/|@import/);
  }
  assert.match(MATH_LAYOUT_CSS, /\.katex-mathml\{/, 'the MathML is kept out of sight by the layout sheet');
});

test('the generated modules are what the generator makes from the installed KaTeX, and each licence travels with what it covers', async () => {
  const sources = await mathDataSources();
  assert.deepEqual(Object.keys(sources).sort(), ['math-css.js', 'math-data.js']);
  for (const [name, text] of Object.entries(sources)) assert.equal(read(`ui/fonts/${name}`), text, `regenerate ${name} with node ui/fonts/build-math-data.mjs`);
  // The stylesheet is MIT (KaTeX's LICENSE); the fonts are SIL OFL 1.1, by their own name tables.
  assert.equal(read('ui/fonts/KaTeX-LICENSE.txt'), read('node_modules/katex/LICENSE'));
  assert.match(read('ui/fonts/math-css.js'), /^\/\*! KaTeX \d+\.\d+\.\d+ stylesheet \(MIT/);
  assert.match(read('ui/fonts/math-data.js'), /^\/\*! KaTeX \d+\.\d+\.\d+ fonts \(SIL OFL 1\.1/);
  const ofl = read('ui/fonts/KaTeX-fonts-OFL.txt');
  assert.match(ofl, /Copyright \(c\) 2009-2010, Design Science, Inc\./);
  assert.match(ofl, /Copyright \(c\) 2014-2018 Khan Academy/);
  for (const name of ['AMS', 'Caligraphic', 'Fraktur', 'Main', 'Math', 'SansSerif', 'Script', 'Size1', 'Size2', 'Size3', 'Size4', 'Typewriter'])
    assert.match(ofl, new RegExp(`\\bKaTeX_${name}\\b`), `Reserved Font Name KaTeX_${name}`);
  const body = (text) => text.slice(text.indexOf('SIL OPEN FONT LICENSE Version 1.1'));
  assert.equal(body(ofl), body(read('ui/fonts/OFL.txt')), 'the full OFL 1.1 text, as the Inter licence carries it');
  // A page saved with formulas carries the notices in its own text.
  const page = await mathPageCss();
  assert.match(page, /^\/\*! KaTeX fonts[^*]*SIL Open Font License 1\.1[^*]*Reserved Font Names KaTeX_/);
  assert.match(page, /\/\*! KaTeX stylesheet[^*]*MIT/);
});

test('the layout goes into the document once, at the first formula; the fonts follow from their own chunk; later formulas look nothing up', async () => {
  const appended = [];
  let lookups = 0;
  const head = { querySelector: () => { lookups++; return null; }, appendChild: (element) => appended.push(element) };
  const doc = { head, createElement: () => ({ textContent: '', attributes: {}, setAttribute(name) { this.attributes[name] = true; } }) };
  let release;
  const load = () => new Promise((resolve) => { release = resolve; });
  installMathStyle(doc, { load });
  for (let i = 0; i < 100; i++) installMathStyle(doc, { load });
  assert.equal(appended.length, 1, 'the layout at once, the fonts not yet');
  assert.equal(appended[0].textContent, MATH_STYLE);
  assert.ok(appended[0].attributes[`data-${MATH_STYLE_MARKER}`]);
  assert.ok(lookups <= 1, `the document is not searched per formula (${lookups} lookups for 101 formulas)`);
  assert.ok(MATH_STYLE.startsWith('@layer study.reset {') && MATH_STYLE.includes(MATH_LAYOUT_CSS), 'in the app\'s lowest layer, so the app\'s formula rules win');
  release('@font-face{font-family:KaTeX_Main}');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(appended.length, 2, 'the fonts arrive once');
  assert.equal(appended[1].textContent, '@font-face{font-family:KaTeX_Main}');
  assert.ok(appended[1].attributes[`data-${MATH_FONTS_MARKER}`]);
  const found = { head: { querySelector: () => ({}), appendChild: (element) => appended.push(element) }, createElement: doc.createElement };
  installMathStyle(found, { load });
  assert.equal(appended.length, 2, 'a document that already has the sheet (another copy of the module) is left as it is');
  assert.doesNotThrow(() => installMathStyle(undefined), 'outside a browser nothing happens');
  assert.doesNotThrow(() => installMathStyle({}), 'nor in a partial document');
  const failing = { head: { querySelector: () => null, appendChild: (element) => appended.push(element) }, createElement: doc.createElement };
  installMathStyle(failing, { load: () => Promise.reject(new Error('offline')) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(appended.length, 3, 'a font chunk that fails leaves the layout and the fallback serif');
  const saved = globalThis.document;
  globalThis.document = { head: { querySelector: () => null, appendChild: (element) => appended.push(element) }, createElement: doc.createElement };
  try {
    renderStudyFormula('x^2', false);
    assert.equal(appended.length, 4, 'drawing a formula installs the layout');
  } finally { if (saved === undefined) delete globalThis.document; else globalThis.document = saved; }
});

test('notes draw their formulas the same way', () => {
  const html = renderNoteMarkdown(String.raw`Formula: $\mathbb{R}^k$`);
  assert.match(html, /class="mord mathbb"/);
  assert.match(html, /<math/);
});

test('a saved page carries the stylesheet and the fonts only when it has a formula, so it draws offline', async () => {
  const mathCss = await mathPageCss();
  assert.ok(mathCss.includes(MATH_LAYOUT_CSS) && mathCss.includes(await loadMathFonts()));
  const { html: withMath } = renderMarkdown('Inline $\\mathbb{E}[X]$.');
  assert.match(withMath, /class="katex"/);
  assert.ok(staticPage({ lang: 'en', title: 'T', css: 'body{}', body: withMath, mathCss }).includes(mathCss), 'a page with a formula embeds the fonts');
  const { html: plain } = renderMarkdown('No formula here, only $5 and $10.');
  assert.ok(!staticPage({ lang: 'en', title: 'T', css: 'body{}', body: plain, mathCss }).includes('@font-face'), 'a page without one stays small');
});
