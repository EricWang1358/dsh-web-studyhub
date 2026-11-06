/* The reader shows one chapter at a time (owner decision 2026-11-06, a 513-page book blocked the page for 9 s): the chapters are the document's own
   (groupSourcesByDocument, the 「查看 N 章」 list of the 资料 row), else fixed blocks of CHAPTER_BLOCK_PAGES pages; a jump to a page, a section or a
   source finds the chapter that holds it; the 目录 lists chapters with their pages inside; an AI outline lists the entries of other chapters too;
   find counts the matches of every chapter from the stored text. Pure, no DOM. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUi } from './helpers/ui-module.mjs';
import { groupSourcesByDocument } from '../lib/source-groups.js';

const ui = await loadUi(`
  export { CHAPTER_BLOCK_PAGES, readerChapters, chapterAt, chapterOutline, adjacentChapters, withElsewhere, chapterHits } from './ui/document-preview/reader/chapters.js';
  export { textMatches } from './ui/document-preview/reader/find.js';
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
  assert.deepEqual(items.map(item => [item.id, item.elsewhere === true, item.sourceId ?? null]), [['ai-0', true, 'p1'], ['ai-1', true, 'p2'], ['ai-2', false, null]]);
  assert.equal(items[0].level, 1);
});

test('find counts the matches of every page from the stored text and groups them by chapter', () => {
  const pages = [{ sectionId: 's1', sourceId: 'p1', page: 1, text: 'Supply and demand. DEMAND!' }, { sectionId: 's2', sourceId: 'p2', page: 2, text: 'nothing' },
    { sectionId: 's3', sourceId: 'p3', page: 3, text: 'Ｄｅｍａｎｄ shock' }];
  const matches = ui.textMatches(pages, ' demand ');
  assert.deepEqual(matches.map(match => [match.sourceId, match.count]), [['p1', 2], ['p3', 1]]);
  assert.deepEqual(ui.textMatches(pages, '  '), []);
  const chapters = [{ id: 'c1', sectionIds: ['s1', 's2'] }, { id: 'c2', sectionIds: ['s3'] }];
  assert.deepEqual(ui.chapterHits(chapters, matches).map(hit => [hit.chapter.id, hit.count, hit.first.page]), [['c1', 2, 1], ['c2', 1, 3]]);
});
