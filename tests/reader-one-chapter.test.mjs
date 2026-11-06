/* The reader shows one chapter at a time (owner decision 2026-11-06, a 513-page book blocked the page for 9 s): the chapters are the document's own
   (groupSourcesByDocument, the 「查看 N 章」 list of the 资料 row), else fixed blocks of CHAPTER_BLOCK_PAGES pages; a jump to a page, a section or a
   source finds the chapter that holds it; the 目录 lists chapters with their pages inside; an AI outline lists the entries of other chapters too;
   find counts the matches of every chapter from the stored text. Pure, no DOM. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUi } from './helpers/ui-module.mjs';
import { groupSourcesByDocument } from '../lib/source-groups.js';

const ui = await loadUi(`
  export { CHAPTER_BLOCK_PAGES, readerChapters, chapterAt, chapterOutline, adjacentChapters, withElsewhere, chapterFindGroups, findStop } from './ui/document-preview/reader/chapters.js';
  export { textHits, drawnSectionText } from './ui/document-preview/reader/find.js';
  export { sourcePlacer } from './ui/document-preview/practice/practice-range.js';
  export { readingSections } from './ui/document-preview/reader/text-sections.js';
  export { outlineFromSections, structureOutline, defaultExpanded, outlineRows, filterOutline } from './ui/document-preview/reader/outline.js';`);

const book = (pages, chapterOf) => Array.from({ length: pages }, (_, index) => {
  const page = index + 1, chapter = chapterOf?.(page);
  return { id: `p${page}`, title: `Book · p.${page}`, text: `Heading ${page}\n\nPage ${page} body text about topic ${page}.`,
    document: { materialId: 'document-book', materialRevision: 'r1-conv3', page, totalPages: pages, format: 'pdf', origin: 'converted', converter: 'mineru',
      ...(chapter ? { chapter } : {}) } };
});
const sectionsOf = sources => ui.readingSections({ paged: true, sources });
// 50 pages: pages 1–4 front matter, then five chapters of 9 pages and a last one of 1.
const chaptered = book(50, page => page <= 4 ? null : { index: Math.min(5, Math.floor((page - 5) / 9)), title: `Chapter ${Math.min(5, Math.floor((page - 5) / 9)) + 1}`, level: 1 });

test('chapters come from the document item, front matter included, in page order', () => {
  const item = groupSourcesByDocument(chaptered)[0], sections = sectionsOf(chaptered);
  const chapters = ui.readerChapters({ paged: true, sections, chapters: item.chapters });
  assert.equal(chapters.length, item.chapters.length);
  assert.deepEqual(chapters.map(chapter => chapter.title), ['', 'Chapter 1', 'Chapter 2', 'Chapter 3', 'Chapter 4', 'Chapter 5', 'Chapter 6']);
  assert.equal(chapters[0].front, true);
  assert.deepEqual([chapters[0].startPage, chapters[0].endPage, chapters[0].sectionIds.length], [1, 4, 4]);
  assert.deepEqual([chapters[1].startPage, chapters[1].endPage, chapters[1].sectionIds.length], [5, 13, 9]);
  assert.equal(chapters.reduce((sum, chapter) => sum + chapter.sectionIds.length, 0), sections.length, 'every page is in exactly one chapter');
  assert.equal(new Set(chapters.map(chapter => chapter.id)).size, chapters.length, 'ids are unique');
});

test('without chapters a long document reads in blocks of CHAPTER_BLOCK_PAGES pages; a short one, or a text, is shown whole', () => {
  assert.equal(ui.CHAPTER_BLOCK_PAGES, 20);
  const sections = sectionsOf(book(45));
  const blocks = ui.readerChapters({ paged: true, sections, chapters: [] });
  assert.deepEqual(blocks.map(block => [block.startPage, block.endPage, block.block]), [[1, 20, true], [21, 40, true], [41, 45, true]]);
  assert.deepEqual(ui.readerChapters({ paged: true, sections: sectionsOf(book(20)), chapters: [] }), [], 'one block: no chapters');
  assert.deepEqual(ui.readerChapters({ paged: false, sections: [{ id: 'part-0', kind: 'part', paragraphs: [] }], chapters: [] }), []);
  // A document item of one chapter is no chaptering either.
  const one = book(30, () => ({ index: 0, title: 'Only', level: 1 }));
  assert.equal(ui.readerChapters({ paged: true, sections: sectionsOf(one), chapters: groupSourcesByDocument(one)[0].chapters }).length, 2, 'falls back to blocks');
});

test('a chapter that holds no whole page (it starts inside one) is not a chapter of the reader; a page no chapter names joins the one before it', () => {
  const sections = sectionsOf(book(6));
  const chapters = ui.readerChapters({ paged: true, sections, chapters: [
    { index: 0, title: 'A', front: false, startPage: 1, endPage: 3, sourceIds: ['p1', 'p2', 'p3'] },
    { index: 1, title: 'Inside', front: false, startPage: 3, endPage: 3, sourceIds: [], partial: true },
    { index: 2, title: 'B', front: false, startPage: 4, endPage: 5, sourceIds: ['p4', 'p5'] },
  ] });
  assert.deepEqual(chapters.map(chapter => chapter.title), ['A', 'B']);
  assert.deepEqual(chapters[1].sectionIds.length, 3, 'p6 joins B');
});

test('chapterAt finds the chapter of a section id, a source id or a page; -1 when nothing names one', () => {
  const sections = sectionsOf(chaptered), chapters = ui.readerChapters({ paged: true, sections, chapters: groupSourcesByDocument(chaptered)[0].chapters });
  const p30 = sections.find(section => section.page === 30);
  assert.equal(chapters[ui.chapterAt(chapters, { sectionId: p30.id })].title, 'Chapter 3');
  assert.equal(chapters[ui.chapterAt(chapters, { sourceId: 'p14' })].title, 'Chapter 2');
  assert.equal(chapters[ui.chapterAt(chapters, { page: 2 })].front, true);
  assert.equal(chapters[ui.chapterAt(chapters, { sectionId: 'missing', page: 50 })].title, 'Chapter 6', 'a section id that is gone falls back to the page');
  assert.equal(ui.chapterAt(chapters, {}), -1);
  assert.equal(ui.chapterAt([], { page: 3 }), -1);
});

test('the 目录 lists the chapters with their pages inside, folded except the current one; the filter still finds a page and says its chapter', () => {
  const sections = sectionsOf(chaptered), chapters = ui.readerChapters({ paged: true, sections, chapters: groupSourcesByDocument(chaptered)[0].chapters });
  const entries = ui.chapterOutline(chapters, ui.outlineFromSections(sections));
  assert.equal(entries.length, chapters.length + sections.length);
  const tree = ui.structureOutline(entries, { fold: false });
  const top = tree.filter(node => !node.parent);
  assert.deepEqual(top.map(node => node.kind), chapters.map(() => 'chapter'));
  assert.ok(tree.filter(node => node.parent).every(node => node.kind === 'page'), 'every page sits under its chapter');
  const p30 = sections.find(section => section.page === 30);
  const rows = ui.outlineRows(tree, ui.defaultExpanded(tree, p30.id));
  assert.equal(rows.filter(row => row.kind === 'chapter').length, chapters.length, 'every chapter is a row');
  assert.deepEqual(rows.filter(row => row.kind === 'page').map(row => row.page), [23, 24, 25, 26, 27, 28, 29, 30, 31], 'only the pages of the current chapter are open');
  const found = ui.filterOutline(tree, 'Heading 30');
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].trail, ['Chapter 3']);
});

test('上一章 / 下一章 around a chapter', () => {
  const chapters = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(ui.adjacentChapters(chapters, 0), { previous: null, next: chapters[1] });
  assert.deepEqual(ui.adjacentChapters(chapters, 1), { previous: chapters[0], next: chapters[2] });
  assert.deepEqual(ui.adjacentChapters(chapters, 2), { previous: chapters[1], next: null });
  assert.deepEqual(ui.adjacentChapters([], -1), { previous: null, next: null });
});

test('a kept AI outline keeps the entries of the chapters that are not drawn, in order, and drops what the drawn chapter cannot place', () => {
  const entries = [
    { level: 1, title: 'One', kind: 'chapter', anchor: { sourceId: 'p1', quote: 'a' } },
    { level: 2, title: 'One.1', anchor: { sourceId: 'p2', quote: 'b' } },
    { level: 1, title: 'Two', kind: 'chapter', anchor: { sourceId: 'p5', quote: 'c' } },
    { level: 1, title: 'Gone', anchor: { sourceId: 'p404', quote: 'd' } },
  ];
  const placed = [{ id: 'ai-2', level: 1, title: 'Two', kind: 'chapter', tagged: true }];
  const items = ui.withElsewhere(entries, placed, { drawn: new Set(['p5', 'p6']), known: new Set(['p1', 'p2', 'p5', 'p6']) });
  // Every entry says the page it is on (sourceId), drawn or not, so the questions of a chapter that is not drawn can be placed under the entries by page (F2).
  assert.deepEqual(items.map(item => [item.id, item.elsewhere === true, item.sourceId ?? null]), [['ai-0', true, 'p1'], ['ai-1', true, 'p2'], ['ai-2', false, 'p5']]);
  assert.equal(items[0].level, 1);
});

test('find counts each chapter in the text the reading view draws (paragraphs back to back, formula source in), so 「N 处」 is what is found on arrival', () => {
  const sources = [
    { id: 'p1', text: 'Heading 1\n\nSupply and demand. DEMAND!', document: { page: 1 } },
    { id: 'p2', text: 'Heading 2\n\nnothing here', document: { page: 2 } },
    { id: 'p3', text: 'Heading 3\n\nＤｅｍａｎｄ shock with $Y = C + I + G$ inside', document: { page: 3 } },
  ];
  const sections = ui.readingSections({ paged: true, sources });
  assert.equal(ui.drawnSectionText(sections[0]), 'Heading 1Supply and demand. DEMAND!', 'the paragraphs as drawn: no blank line between them');
  const chapters = [{ id: 'c1', sectionIds: [sections[0].id, sections[1].id] }, { id: 'c2', sectionIds: [sections[2].id] }];
  const groups = ui.chapterFindGroups(chapters, sections, ui.drawnSectionText);
  const hits = ui.textHits(groups, ' demand ');
  assert.deepEqual(hits.map(hit => [hit.key, hit.count, hit.first.page, hit.first.sourceId]), [['c1', 2, 1, 'p1'], ['c2', 1, 3, 'p3']]);
  assert.deepEqual(ui.textHits(groups, 'c + i + g').map(hit => [hit.key, hit.count]), [['c2', 1]], 'a formula is found by its source, as the drawn find does');
  // The stored text has a blank line where the drawn text has none: "1 supply" is in the stored text only, so it is not counted.
  assert.deepEqual(ui.textHits(groups, '1 supply'), []);
  // A match that runs from one page into the next is one match, on the page it starts on.
  assert.deepEqual(ui.textHits(groups, 'DEMAND!Heading 2').map(hit => [hit.key, hit.count, hit.first.page]), [['c1', 1, 1]]);
  // The 原文 view draws the stored text of each page: its groups read that text.
  const stored = ui.chapterFindGroups(chapters, sections, section => sources.find(item => item.id === section.sourceId).text);
  assert.deepEqual(ui.textHits(stored, '1 supply').map(hit => [hit.key, hit.count]), [['c1', 1]]);
  assert.deepEqual(ui.textHits(groups, '  '), []);
});

test('find steps through the matches of the chapter, then on to the next chapter that has one (Shift: the last match of the one before), round the book', () => {
  // Chapters 1, 3 and 6 have matches; the reader shows chapter 3 with 4 of them.
  const hits = [1, 3, 6];
  assert.deepEqual(ui.findStop({ hits, current: 3, total: 4, match: 1, delta: 1 }), { match: 2 });
  assert.deepEqual(ui.findStop({ hits, current: 3, total: 4, match: 3, delta: 1 }), { chapter: 6, landing: 'first' });
  assert.deepEqual(ui.findStop({ hits, current: 3, total: 4, match: 0, delta: -1 }), { chapter: 1, landing: 'last' });
  assert.deepEqual(ui.findStop({ hits, current: 6, total: 2, match: 1, delta: 1 }), { chapter: 1, landing: 'first' }, 'after the last chapter, the first one');
  assert.deepEqual(ui.findStop({ hits, current: 1, total: 2, match: 0, delta: -1 }), { chapter: 6, landing: 'last' }, 'before the first chapter, the last one');
  // None in the chapter shown: Enter goes to the next chapter with one, Shift+Enter to the one before.
  assert.deepEqual(ui.findStop({ hits: [1, 6], current: 3, total: 0, match: 0, delta: 1 }), { chapter: 6, landing: 'first' });
  assert.deepEqual(ui.findStop({ hits: [1, 6], current: 3, total: 0, match: 0, delta: -1 }), { chapter: 1, landing: 'last' });
  // Only this chapter has any: it goes round within it, as before.
  assert.deepEqual(ui.findStop({ hits: [3], current: 3, total: 4, match: 3, delta: 1 }), { match: 0 });
  assert.deepEqual(ui.findStop({ hits: [3], current: 3, total: 4, match: 0, delta: -1 }), { match: 3 });
  assert.equal(ui.findStop({ hits: [], current: 3, total: 0, match: 0, delta: 1 }), null);
});

test('the questions of a chapter that is not drawn are placed under the outline entry of their page, from data (an AI outline keeps its meters in every chapter)', () => {
  const order = new Map(['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map((id, index) => [id, index]));
  const items = [{ id: 'ai-0', sourceId: 'p1' }, { id: 'ai-1', sourceId: 'p3' }, { id: 'ai-2', sourceId: 'p5' }, { id: 'chapter-x' }];
  const place = ui.sourcePlacer({ items, order });
  assert.deepEqual(['p1', 'p2', 'p3', 'p4', 'p6'].map(sourceId => place({ sourceId })), ['ai-0', 'ai-0', 'ai-1', 'ai-1', 'ai-2']);
  assert.equal(place({ sourceId: 'elsewhere' }), null, 'a page of another document is not placed');
  assert.equal(ui.sourcePlacer({ items: [{ id: 'ai-0', sourceId: 'p3' }], order })({ sourceId: 'p1' }), 'ai-0', 'a page before the first entry belongs to the first one');
  assert.equal(ui.sourcePlacer({ items: [], order })({ sourceId: 'p1' }), null);
});
