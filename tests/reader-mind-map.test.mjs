import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUi } from './helpers/ui-module.mjs';

/* 思维导图 of the reader (reader/mind-map.js): a tree of the CURRENT chapter drawn from headings the reader already has, no model call. A paged document's
   chapter is read from the heading paragraphs of its pages (a Markdown "#", a number "11.2.1", 第…章 / 第…节), a text document's from its outline entries. */
const m = await loadUi(`export * from './ui/document-preview/reader/mind-map.js'; export { splitParagraphs } from './ui/document-preview/reader/text-sections.js';`);

const page = (n, text) => ({ id: `page-${n}-0`, kind: 'page', page: n, sourceId: `p${n}`, paragraphs: m.splitParagraphs(text) });
const flat = (node, out = []) => { for (const child of node.children) { out.push(child); flat(child, out); } return out; };
const titles = node => node.children.map(child => ({ title: child.title, children: titles(child) }));

test('headingLevel reads a level from a Markdown mark, a number, a chapter or section word, and says null for a plain heading', () => {
  assert.equal(m.headingLevel('## Money and banks'), 2);
  assert.equal(m.headingLevel('# Money'), 1);
  assert.equal(m.headingLevel('11.2 Fiscal policy'), 2);
  assert.equal(m.headingLevel('11.2.3 Multiplier'), 3);
  assert.equal(m.headingLevel('11 Demand'), 1);
  assert.equal(m.headingLevel('第 11 章 财政政策'), 1);
  assert.equal(m.headingLevel('第二节 乘数'), 2);
  assert.equal(m.headingLevel('Summary'), null);
});

test('a chapter of pages becomes chapter -> sections -> sub-sections from the heading paragraphs of its pages', () => {
  const sections = [
    page(201, ['11 Fiscal policy', 'Body of the first page, which is a sentence.', '11.1 Government spending', 'More body text here.'].join('\n\n')),
    page(202, ['11.1.1 Multiplier', 'Body.', '11.2 Taxes', 'Body.', 'Summary', 'Body.'].join('\n\n')),
  ];
  const map = m.buildMindMap({ title: 'Chapter 11', sections });
  assert.equal(map.title, 'Chapter 11');
  assert.deepEqual(titles(map), [{ title: '11 Fiscal policy', children: [
    { title: '11.1 Government spending', children: [{ title: '11.1.1 Multiplier', children: [] }] },
    { title: '11.2 Taxes', children: [{ title: 'Summary', children: [] }] }] }]);
  const multiplier = flat(map).find(node => node.title === '11.1.1 Multiplier');
  assert.deepEqual(multiplier.target, { sectionId: 'page-202-0', page: 202, headingIndex: 0 }, 'a node knows the page section and which heading of it');
  const taxes = flat(map).find(node => node.title === '11.2 Taxes');
  assert.deepEqual(taxes.target, { sectionId: 'page-202-0', page: 202, headingIndex: 1 });
});

test('a heading met on three pages or more is a running header, not a section; formulas lose their dollar signs', () => {
  const sections = [1, 2, 3, 4].map(n => page(n, [`Macroeconomics 13th ed`, `## Part ${n} $\\alpha$`, 'A body sentence that is long enough to be text.'].join('\n\n')));
  const map = m.buildMindMap({ title: 'Book', sections });
  assert.deepEqual(flat(map).map(node => node.title), ['Part 1 \\alpha', 'Part 2 \\alpha', 'Part 3 \\alpha', 'Part 4 \\alpha']);
});

test('a chapter whose pages have no heading falls back to the entries of its outline; with nothing at all the map is empty', () => {
  const sections = [page(5, 'Just a sentence of body text here that ends with a period.')];
  const outline = [{ id: 'page-5-0', level: 2, kind: 'page', page: 5, title: '' }, { id: 'page-6-1', level: 2, kind: 'page', page: 6, title: 'Interest rates' }];
  const fallback = m.buildMindMap({ title: 'Chapter 2', sections, outline });
  assert.deepEqual(flat(fallback).map(node => node.title), ['Interest rates']);
  assert.equal(fallback.children[0].target.outlineId, 'page-6-1');
  assert.equal(m.buildMindMap({ title: 'Chapter 3', sections: [page(7, 'Body only, with a full stop.')], outline: [] }).children.length, 0);
});

test('a text document maps the branch of the outline around the current entry', () => {
  const outline = [
    { id: 'h-0', level: 1, title: 'Part A', parent: null }, { id: 'h-1', level: 2, title: 'A.1', parent: 'h-0' },
    { id: 'h-2', level: 1, title: 'Part B', parent: null }, { id: 'h-3', level: 2, title: 'B.1', parent: 'h-2' }, { id: 'h-4', level: 3, title: 'B.1.1', parent: 'h-3' }, { id: 'h-5', level: 2, title: 'B.2', parent: 'h-2' },
  ];
  const map = m.buildMindMap({ title: 'Notes', outline, activeId: 'h-4', branch: true });
  assert.equal(map.title, 'Part B');
  assert.deepEqual(titles(map), [{ title: 'B.1', children: [{ title: 'B.1.1', children: [] }] }, { title: 'B.2', children: [] }]);
  assert.equal(map.target.outlineId, 'h-2');
  const whole = m.buildMindMap({ title: 'Notes', outline });
  assert.deepEqual(titles(whole).map(node => node.title), ['Part A', 'Part B']);
});

test('a big chapter is capped and says so; opening shows the top two levels', () => {
  const lines = Array.from({ length: 300 }, (_, n) => `## Heading number ${n}`);
  const map = m.buildMindMap({ title: 'Big', sections: [page(1, lines.join('\n\n'))] }, { max: 50 });
  assert.equal(flat(map).length, 50);
  assert.equal(map.truncated, true);
  const small = m.buildMindMap({ title: 'S', sections: [page(1, ['# A', '## B', '### C', '#### D'].join('\n\n'))] });
  assert.deepEqual([...m.openByDefault(small)].sort(), ['root', ...flat(small).filter(node => node.depth < 1).map(node => node.id)].sort());
});

test('mapOutlineText is the tree as an indented list with the pages, for 交给主会话细化', () => {
  const map = m.buildMindMap({ title: 'Chapter 11', sections: [page(201, ['11 Fiscal policy', 'A body sentence that is long enough to be text.', '11.1 Spending', 'More body text of the section.'].join('\n\n'))] });
  assert.equal(m.mapOutlineText(map), 'Chapter 11\n  11 Fiscal policy (p.201)\n    11.1 Spending (p.201)');
});
