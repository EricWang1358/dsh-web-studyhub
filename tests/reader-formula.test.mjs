/* The reader's one formula unit (reader/formula.js): the same markup from a text source and from a Markdown one, atomic in
   selection / find / links, copied as its source, and drawn in quotes. The DOM here is a minimal fake in the style of
   tests/reader.test.mjs; real selection, layout and DOMPurify are checked in the browser (npm run qa:reader-formulas). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseFragment } from 'parse5';

const compiled = await build({ stdin: { contents: `
  export { default as ReadingSections } from './ui/document-preview/reader/ReadingSections.jsx';
  export { readingSections } from './ui/document-preview/reader/text-sections.js';
  export { formulaHtml, formulaViewHtml, spanFormulas, pickFormula, copyText } from './ui/document-preview/reader/formula.js';
  export { renderReaderMarkdown } from './ui/document-preview/reader/markdown.js';
  export { renderNoteMarkdown } from './ui/note-markdown.js';
  export { findRanges } from './ui/document-preview/reader/find.js';
  export { locateGroups } from './ui/document-preview/links/link-ranges.js';
  export { captureSelection } from './ui/document-preview/selection.js';
  export { default as MathText } from './ui/MathText.jsx';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { ReadingSections, readingSections, formulaHtml, formulaViewHtml, spanFormulas, pickFormula, copyText, renderReaderMarkdown, renderNoteMarkdown,
  findRanges, locateGroups, captureSelection, MathText } = module.exports;

/** What selection / find / links count in rendered markup: the text outside every data-study-marker. */
const countedText = html => {
  let text = '';
  const walk = node => {
    if (node.attrs?.some(attribute => attribute.name === 'data-study-marker')) return;
    if (node.nodeName === '#text') text += node.value;
    node.childNodes?.forEach(walk);
  };
  walk(parseFragment(html));
  return text;
};

const INLINE = { source: 'z = Wx + b', display: false, raw: '$z = Wx + b$' };
const DISPLAY = { source: String.raw`\delta = x`, display: true, raw: String.raw`$$\delta = x$$` };

test('a formula is a hidden source (the counted text) beside a drawn marker, escaped, with the same markup everywhere', () => {
  assert.match(formulaHtml(INLINE), /^<span class="reader-math"><span class="reader-math__source" aria-hidden="true">\$z = Wx \+ b\$<\/span><span class="reader-math__view" data-study-marker="true"><span class="katex"><math/);
  assert.match(formulaHtml(DISPLAY), /^<span class="reader-math reader-math--display">/);
  const unsafe = formulaHtml({ source: 'x < y', display: false, raw: '$x < y$' });
  assert.match(unsafe, /aria-hidden="true">\$x &lt; y\$<\/span>/);
  assert.equal(countedText(unsafe), '$x < y$');
  // TeX that cannot be drawn shows its own text instead of nothing.
  assert.equal(formulaViewHtml({ source: String.raw`\frac{`, display: false, raw: String.raw`$\frac{$` }), String.raw`$\frac{$`);
  assert.match(formulaViewHtml({ source: '1', display: false, raw: '$1$', label: '2.1' }), /<span class="reader-math__label">\(2\.1\)<\/span>/);
});

test('the text reader and the Markdown reader draw a formula with exactly the same markup', () => {
  const stored = `前向：${INLINE.raw}，再看\n\n${DISPLAY.raw}\n\n结束。`;
  const sections = readingSections({ paged: false, sources: [{ id: 's', text: stored }], text: stored });
  const text = renderToStaticMarkup(React.createElement(ReadingSections, { sections, labelOf: () => '' })), markdown = renderReaderMarkdown(stored);
  for (const html of [text, markdown]) { assert.ok(html.includes(formulaHtml(INLINE)), 'inline'); assert.ok(html.includes(formulaHtml(DISPLAY)), 'display'); }
});

test('Markdown keeps the exact stored slice of every formula as its counted text, and leaves currency and code alone', () => {
  const stored = '# 标题\n\n前向：$z = Wx + b$，价格 $5 and $10。\n\n$$\n\\delta = (a - y) \\odot \\sigma\'(z)\n$$\n\n未配平 $\\ce{Fe + O2 -> Fe2O3}$，`$x$` 不是公式。\n\n$$E = mc^2$$ (1.1)';
  const html = renderReaderMarkdown(stored), counted = countedText(html);
  for (const raw of ['$z = Wx + b$', '$$\n\\delta = (a - y) \\odot \\sigma\'(z)\n$$', '$\\ce{Fe + O2 -> Fe2O3}$', '$$E = mc^2$$ (1.1)']) assert.ok(counted.includes(raw), raw);
  assert.ok(counted.includes('价格 $5 and $10'), 'currency stays text');
  assert.match(html, /<code>\$x\$<\/code>/, 'code is never a formula');
  assert.equal((html.match(/class="reader-math(?: reader-math--display)?"/g) || []).length, 4);
  assert.equal(countedText(renderReaderMarkdown('$$x$$')), '$$x$$', 'a formula without an equation number carries nothing else');
  assert.match(html, /<h1>标题<\/h1>/, 'the rest of the Markdown is still Markdown');
  assert.doesNotMatch(html, /<eqn>|<section>/);
  assert.match(renderNoteMarkdown('$x$'), /<eq>/, 'cards and notes keep their own rendering');
});

/* ---------- atomic formulas: a fake DOM of text nodes, some inside a formula ---------- */

/** Text nodes in a row; `inside` lists the indexes that sit inside the one `.reader-math` element. */
function fakeText(texts, inside = []) {
  const formula = { name: 'formula', ownerDocument: null };
  const nodes = texts.map((text, index) => {
    const parentElement = { closest: selector => (selector === '.reader-math' && inside.includes(index) ? formula : null) };
    return { nodeType: 3, textContent: text, data: text, parentElement };
  });
  const range = () => { const state = { before: null, after: null, setStartBefore: node => { state.before = node; }, setEndAfter: node => { state.after = node; } };
    state.setStart = (node, offset) => { state.startContainer = node; state.startOffset = offset; }; state.setEnd = (node, offset) => { state.endContainer = node; state.endOffset = offset; }; return state; };
  const walker = () => { let at = 0; return { nextNode: () => nodes[at++] ?? null }; };
  return { nodes, formula, range, ownerDocument: { createTreeWalker: walker, createRange: range } };
}

test('a range boundary inside a formula moves to just outside it; the formula is atomic', () => {
  const dom = fakeText(['由 ', '\\sigma', ' 可得'], [1]);
  const range = dom.range();
  range.startContainer = dom.nodes[1]; range.endContainer = dom.nodes[2];
  assert.equal(spanFormulas(range), true);
  assert.equal(range.before, dom.formula, 'start moves before the formula');
  assert.equal(range.after, null, 'an end outside a formula stays');
  const outside = dom.range(); outside.startContainer = dom.nodes[0]; outside.endContainer = dom.nodes[2];
  assert.equal(spanFormulas(outside), false);
  assert.equal(spanFormulas({}), false, 'a range without containers is left alone');
});

test('find and the link underlines widen a match inside a formula to the whole formula', () => {
  const dom = fakeText(['由 ', '$\\sigma(z)$', ' 可得'], [1]);
  dom.nodes[1].parentElement.closest = selector => (selector === '.reader-math' ? dom.formula : null);
  const root = { ownerDocument: dom.ownerDocument, querySelectorAll: () => [] };
  const [found] = findRanges(root, 'sigma');
  assert.equal(found.before, dom.formula);
  assert.equal(found.after, dom.formula);
  const [located] = locateGroups(root, [{ key: 'k', selection: { sourceId: 'none', quote: '\\sigma(z)', prefix: '', suffix: '' } }]).map(entry => entry.range);
  assert.equal(located.before, dom.formula);
  assert.equal(located.after, dom.formula);
});

test('a selection that starts inside a drawn formula quotes the whole formula and widens the live selection', () => {
  const dom = fakeText(['前向：', '$z = Wx + b$', '，损失'], [1]);
  const range = dom.range();
  range.startContainer = dom.nodes[1]; range.startOffset = 4; range.endContainer = dom.nodes[2]; range.endOffset = 1;
  // setStartBefore(formula) puts the start at the formula's first text node, as a real range does.
  range.setStartBefore = () => { range.startContainer = dom.nodes[1]; range.startOffset = 0; };
  range.toString = () => '[glyphs]，';
  range.cloneRange = () => ({ ...range });
  range.comparePoint = node => { const at = dom.nodes.indexOf(node); return at < 1 ? -1 : at > 2 ? 1 : 0; };
  const added = [], selection = { rangeCount: 1, isCollapsed: false, getRangeAt: () => range, removeAllRanges: () => added.push('clear'), addRange: value => added.push(value) };
  const container = { ownerDocument: dom.ownerDocument, contains: () => true, dataset: {} };
  const capture = captureSelection(container, selection);
  assert.equal(capture.quote, '$z = Wx + b$，');
  assert.equal(capture.prefix, '前向：');
  assert.deepEqual(added.map(item => item === 'clear' ? item : 'range'), ['clear', 'range'], 'the browser selection is replaced by the widened range');
});

test('a click on a formula selects it whole, also inside an earlier selection; elsewhere nothing changes', () => {
  const calls = [], formula = { ownerDocument: { createRange: () => ({ selectNode: node => calls.push(['selectNode', node]) }) } };
  const selection = { isCollapsed: true, removeAllRanges: () => calls.push('clear'), addRange: () => calls.push('add') };
  const target = { nodeType: 1, closest: selector => (selector === '.reader-math' ? formula : null) };
  assert.equal(pickFormula(selection, target), true);
  assert.deepEqual(calls.map(item => Array.isArray(item) ? item[0] : item), ['selectNode', 'clear', 'add']);
  calls.length = 0;
  assert.equal(pickFormula(selection, { nodeType: 1, closest: () => null }), false);
  assert.deepEqual(calls, []);
  assert.equal(pickFormula({ ...selection, isCollapsed: false }, target), true, 'a click inside an existing selection picks the formula too');
});

test('a copy that does not touch a formula stays native (the stored text of a formula copy is checked in the browser)', () => {
  const holder = { append() {}, querySelector: () => null };
  const range = { cloneRange: () => range, startContainer: { ownerDocument: { createElement: () => holder } }, cloneContents: () => ({}) };
  assert.equal(copyText({ rangeCount: 1, isCollapsed: false, getRangeAt: () => range }), null);
  assert.equal(copyText({ rangeCount: 0, isCollapsed: true }), null);
});

/* ---------- quotes ---------- */

test('a quote draws its formulas and keeps the rest as text', () => {
  const html = renderToStaticMarkup(React.createElement('p', null, React.createElement(MathText, { text: '前向 $z = Wx + b$，价格 $5 and $10。' })));
  assert.match(html, /^<p>前向 <span class="md-math"/);
  assert.match(html, /价格 \$5 and \$10。<\/p>$/);
  assert.equal((html.match(/class="md-math"/g) || []).length, 1);
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(MathText, { text: '$$x$$' })), /md-math-display/, 'inside a quote even display formulas are inline');
  assert.equal(renderToStaticMarkup(React.createElement(MathText, { text: '' })), '');
});
