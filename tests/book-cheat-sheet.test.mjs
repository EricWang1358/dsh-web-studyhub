/* The 速查表 of the review book (#710 S5): the data the program assembles from the book as the page has it (cards, answer kit, comparisons, formulas, each with
   the point that teaches it), and the one self-contained .html drawn from it, which the view shows, the browser prints and the learner saves. Fakes only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { withCardNumbers } from '../lib/course-book-card-numbers.js';
import { cheatSheet, readConfusables } from '../ui/book/cheat-sheet-model.js';
import { cheatSheetHtml, cheatSheetFilename } from '../ui/book/cheat-sheet-html.js';
import { renderStudyFormula, mathPageCss } from '../ui/study-math-render.js';
const MATH_CSS = await mathPageCss();

const ID = n => `i${String(n).padStart(11, '0')}`;
const card = (n, name, extra = {}) => ({ item: ID(n), name, plain: `${name} plainly`, pitch: `${name} in one exam sentence.`, ...extra });
const point = (hid, number, title, cards) => ({ hid, title, number, depth: 2, leaf: true, gen: '', mine: '', qa: '', children: [], ...(cards ? { cards } : {}) });

/** A book as course.book.open answers it: two chapters, three points (one without cards), a formula, an answer kit. */
const bookOf = (extra = {}) => ({ status: 'ok', title: 'Software Architecture', language: 'en', unplaced: { title: 'Unplaced', text: '' },
  glossary: [{ term: 'Architecture', item: ID(1), gist: 'the skeleton', kind: 'definition', hid: 'h3', material: 'L1', page: 2 },
    { term: 'Little’s law', item: ID(5), gist: 'L = \\lambda W', kind: 'formula', hid: 'h6', material: 'L2', page: 9 },
    { term: 'Throughput', item: ID(7), gist: 'Throughput = WIP / cycle time', kind: 'formula', hid: 'h3', material: 'L1', page: 3 }],
  nodes: withCardNumbers([
    { hid: 'h1', title: 'Basics', number: '1', depth: 1, leaf: false, children: [point('h3', '1.1', 'What architecture is', [
      card(1, 'Architecture', { alt: 'SA', relations: [{ kind: 'related', item: ID(2), name: 'Coupling' }, { kind: 'opposite', name: 'big ball of mud' }] }), card(2, 'Coupling')])] },
    { hid: 'h2', title: 'Performance', number: '2', depth: 1, leaf: false, children: [point('h5', '2.1', 'Nothing carded'),
      point('h6', '2.2', 'Queues <b>& more</b>', [card(4, 'Big Ball of Mud', { relations: [{ kind: 'parallel', item: ID(1), name: 'Architecture' }] })])] }]),
  examKit: { language: 'en', types: [
    { code: 'T01', name: 'Compare', family: 'compare', signals: ['compare', 'contrast'], asks: 'two things side by side', template: '[A] is [x]; [B] is [y].',
      fills: [{ ref: 'PAST1 Q2', quote: 'Compare X with Y', fill: 'A: X ｜ B: Y' }], anchors: ['PAST1 Q2'], hids: ['h3', 'h6', 'gone'] }] },
  ...extra });

const PAIR = { id: 'C001', items: ['K001', 'K002'], names: ['Architecture', 'Coupling'], rows: [
  { aspect: 'what', cells: ['The skeleton', 'How much modules depend'] }, { aspect: 'difference', cells: ['Structure', 'Dependency'] }, { aspect: 'mistake', cells: ['Confusing it with design', 'Counting calls only'] }] };

test('no ok book, or nothing to put on the sheet: no sheet', () => {
  assert.equal(cheatSheet(null), null);
  assert.equal(cheatSheet({ status: 'rebuild-pending' }), null);
  assert.equal(cheatSheet({ status: 'ok', nodes: [point('h1', '1', 'Alone')], glossary: [] }), null);
});

test('the cards by chapter, each with the point that teaches it and the page its term is taught on; a chapter without cards is left out', () => {
  const sheet = cheatSheet(bookOf());
  assert.deepEqual(sheet.chapters.map(chapter => [chapter.number, chapter.title, chapter.cards.map(each => each.code)]), [['1', 'Basics', ['K001', 'K002']], ['2', 'Performance', ['K003']]]);
  const first = sheet.chapters[0].cards[0];
  assert.deepEqual(first.place, { hid: 'h3', code: 'H3', number: '1.1', title: 'What architecture is' });
  assert.equal(first.page, 2);
  assert.equal(first.material, 'L1');
  assert.equal(first.alt, 'SA');
  assert.deepEqual(first.relations, [{ kind: 'related', name: 'Coupling', code: 'K002' }, { kind: 'opposite', name: 'big ball of mud', code: 'K003' }], 'a carded relation keeps its code');
  assert.equal(sheet.chapters[0].cards[1].page, undefined, 'a card whose term is not in the glossary has no page');
});

test('the answer kit: types with their points named as places; a point the book does not have is dropped', () => {
  const [type] = cheatSheet(bookOf()).kit.types;
  assert.equal(type.code, 'T01');
  assert.deepEqual(type.places.map(place => place.code), ['H3', 'H6']);
  assert.equal(type.template, '[A] is [x]; [B] is [y].');
  assert.equal(cheatSheet(bookOf({ examKit: undefined })).kit, null);
});

test('the formulas in reading order with their card code, point and page', () => {
  const { formulas } = cheatSheet(bookOf());
  assert.deepEqual(formulas.map(each => [each.term, each.place.code, each.page]), [['Throughput', 'H3', 3], ['Little’s law', 'H6', 9]]);
});

test('comparisons are read where they enter: the exact shape or nothing', () => {
  assert.deepEqual(readConfusables([PAIR]), [PAIR]);
  assert.deepEqual(readConfusables(undefined), []);
  assert.deepEqual(readConfusables('x'), []);
  assert.deepEqual(readConfusables([{ ...PAIR, names: ['Only one'] }]), [], 'a pair needs two names');
  assert.deepEqual(readConfusables([{ ...PAIR, id: '' }]), []);
  assert.deepEqual(readConfusables([{ ...PAIR, rows: [{ aspect: 'colour', cells: ['a', 'b'] }, { aspect: 'what', cells: ['one cell'] }] }]), [], 'a row of another aspect or of the wrong width is no row, and no rows is no pair');
  assert.deepEqual(readConfusables([{ ...PAIR, rows: [PAIR.rows[0], { aspect: 'when', cells: ['a'] }] }])[0].rows, [PAIR.rows[0]]);
  assert.equal(readConfusables([PAIR, PAIR]).length, 1, 'one id once');
  const sheet = cheatSheet(bookOf({ confusables: [PAIR] }));
  assert.equal(sheet.confusables.length, 1);
  assert.equal(cheatSheet(bookOf()).confusables.length, 0);
});

test('a chapter that is not built yet (未生成) is not on the sheet: no cards, no places of a template, no formula of its points; a half-built chapter stays whole', () => {
  const book = bookOf(), [basics, performance] = book.nodes;
  const marked = node => ({ ...node, children: node.children.map(child => ({ ...child, unbuilt: true })) });
  const sheet = cheatSheet({ ...book, nodes: [basics, marked(performance)] });
  assert.deepEqual(sheet.chapters.map(chapter => chapter.title), ['Basics']);
  assert.deepEqual(sheet.kit.types[0].places.map(place => place.code), ['H3'], 'h6 is in the chapter not built');
  assert.deepEqual(sheet.formulas.map(each => each.place.code), ['H3']);
  const half = { ...performance, children: performance.children.map((child, at) => (at === 0 ? { ...child, unbuilt: true } : child)) };
  const kept = cheatSheet({ ...book, nodes: [basics, half] });
  assert.deepEqual(kept.chapters.map(chapter => chapter.title), ['Basics', 'Performance']);
  assert.deepEqual(kept.kit.types[0].places.map(place => place.code), ['H3', 'H6']);
  assert.equal(cheatSheet({ ...book, nodes: [marked(basics), marked(performance)], examKit: undefined, glossary: [] }), null, 'nothing built, nothing to show');
});

test('counts say what the sheet holds', () => {
  assert.deepEqual(cheatSheet(bookOf({ confusables: [PAIR] })).counts, { cards: 3, types: 1, confusables: 1, formulas: 2 });
});

const sheetHtml = (extra, options) => cheatSheetHtml(cheatSheet(bookOf(extra)), { formula: renderStudyFormula, formulaCss: MATH_CSS, ...options });
const plain = html => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

test('the file is one self-contained page: inline style, a print layout, no external address, no script', () => {
  const html = sheetHtml({ confusables: [PAIR] });
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /<meta name="viewport"/);
  assert.match(html, /<title>Software Architecture · Cheat sheet<\/title>/);
  assert.match(html, /@media print/);
  assert.match(html, /@page/);
  assert.doesNotMatch(html, /https?:\/\//, 'no network address');
  // The one url() is a formula font inlined as a data: URI (#996): nothing is fetched.
  assert.doesNotMatch(html, /<script|<link|<img|<iframe|@import|url\((?!data:font\/woff2;base64,)/i, 'nothing fetched, nothing run');
  assert.doesNotMatch(html, /:has\(/);
});

test('every part: templates, signal matrix, comparisons, formulas rendered, cards with anchors; text is escaped', () => {
  const html = sheetHtml({ confusables: [PAIR] }), text = plain(html);
  for (const id of ['sheet-templates', 'sheet-matrix', 'sheet-compare', 'sheet-formulas', 'sheet-cards']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /id="K001"/);
  assert.match(html, /href="#K002"/, 'a relation with a card goes to it');
  assert.match(html, /id="T01"/);
  assert.match(html, /href="#T01"/, 'the matrix goes to its template');
  assert.match(html, /id="C001"/);
  assert.match(text, /K001 Architecture SA/);
  assert.match(text, /Compare/);
  assert.match(text, /two things side by side/);
  assert.match(text, /Architecture vs Coupling|Architecture Coupling/);
  assert.match(text, /Confusing it with design/);
  assert.match(html, /<mark class="slot">\[A\]<\/mark>/, 'template slots marked');
  assert.match(text, /H3 1\.1 What architecture is/, 'the point it comes from');
  assert.match(text, /p\. 2/, 'the page it is taught on');
  assert.match(html, /<math[\s\S]*?lambda|<math[\s\S]*?λ/i, 'a TeX formula is drawn, its MathML kept for screen readers');
  assert.match(html, /class="katex-html"/, 'laid out by KaTeX (#996)');
  assert.ok(html.includes(MATH_CSS), 'with its stylesheet and fonts inlined, so the saved file draws it offline');
  assert.doesNotMatch(html, /url\((?!data:font\/woff2;base64,)|https?:\/\//, 'and still no address');
  assert.match(html, /<code>Throughput = WIP \/ cycle time<\/code>/, 'a formula in words stays text');
  assert.match(html, /Queues &lt;b&gt;&amp; more&lt;\/b&gt;/, 'escaped');
  assert.doesNotMatch(html, /<b>& more/);
});

test('no comparisons in the book: no comparisons part, and nothing else shown for them', () => {
  const html = sheetHtml();
  assert.doesNotMatch(html, /sheet-compare|C001/);
});

test('a book without an answer kit or formulas leaves those parts out', () => {
  const html = sheetHtml({ examKit: undefined, glossary: [] });
  assert.doesNotMatch(html, /sheet-templates|sheet-matrix|sheet-formulas/);
  assert.match(html, /sheet-cards/);
});

test('links back to the book exist only when asked for (the view), the saved file has none', () => {
  assert.doesNotMatch(sheetHtml(), /data-go=/);
  const html = sheetHtml({}, { links: true });
  assert.match(html, /<a href="#" data-go="h3"><b>H3<\/b>/);
  assert.doesNotMatch(html, /data-go="gone"/);
});

test('the words follow the book\'s language', () => {
  const zh = cheatSheetHtml(cheatSheet(bookOf({ language: 'zh', confusables: [PAIR] })), { formula: renderStudyFormula });
  assert.match(zh, /<html lang="zh-CN">/);
  for (const word of ['答题模板', '题干信号矩阵', '易混对照', '公式', '术语卡', '第 2 页']) assert.match(zh, new RegExp(word), word);
  assert.match(sheetHtml(), /Answer templates/);
});

test('a formula the renderer cannot draw falls back to its source text; no renderer: source text', () => {
  const html = cheatSheetHtml(cheatSheet(bookOf()), { formula: () => null });
  assert.match(html, /<code>L = \\lambda W<\/code>/);
  assert.doesNotMatch(cheatSheetHtml(cheatSheet(bookOf()), {}), /<math/);
});

test('the file name is the book\'s title, safe to save', () => {
  assert.equal(cheatSheetFilename({ title: 'Software Architecture', language: 'en' }), 'Software Architecture - cheat sheet.html');
  assert.equal(cheatSheetFilename({ title: 'a/b:c', language: 'zh' }), 'a b c 速查表.html');
  assert.equal(cheatSheetFilename({ title: '', language: 'zh' }), '速查表.html');
});
