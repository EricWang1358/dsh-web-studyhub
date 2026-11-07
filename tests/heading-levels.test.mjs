import test from 'node:test';
import assert from 'node:assert/strict';
import { inferHeadingLevels } from '../lib/heading-levels.js';
import { parseConvertedDocument } from '../lib/converted-document.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { createMaterialsOperations } from '../lib/contexts/materials/operations.js';
import { bytesHash } from '../lib/contexts/materials/files.js';
import { materialsFingerprint } from '../lib/course-outline-book.js';

/* Flat headings (owner report 2026-11-05): MinerU writes every title at one level (`text_level: 1`), so the converted book's chapters were cut at every
   title and each page went to the last title on it: one "chapter" per page. The levels are read from the titles' own numbering instead. */

const levels = titles => inferHeadingLevels(titles);

test('Chinese numbering: 章 > 节 > 一、 > （一） > 1. > （1） > ①, each one level under the numbering above it', () => {
  assert.deepEqual(levels(['第一章 绪论', '第一节 概念', '一、定义', '（一）狭义', '1. 要点', '(1) 细节', '① 例子', '第二章 方法']), [1, 2, 3, 4, 5, 6, 6, 1]);
  assert.deepEqual(levels(['一、总论', '（一）背景', '（二）意义', '二、方法', '1．调查', '2、实验']), [1, 2, 2, 1, 2, 2]);
  assert.deepEqual(levels(['第一讲 导论', '第二讲 方法', '第十二讲 总结']), [1, 1, 1]);
  assert.deepEqual(levels(['第一部分 基础', '第一章 集合', '第二章 映射', '第二部分 应用']), [1, 2, 2, 1]);
});

test('decimal numbering: 1 > 1.1 > 1.1.1; a bare number is the chapter only when decimals sit under it', () => {
  assert.deepEqual(levels(['1 Introduction', '1.1 Background', '1.1.1 History', '1.2 Scope', '2 Methods', '2.1 Data']), [1, 2, 3, 2, 1, 2]);
  assert.deepEqual(levels(['1. 引言', '1.1 背景', '2. 方法']), [1, 2, 1]);
  assert.deepEqual(levels(['第一章 总论', '1.1 背景', '1.2 意义', '第二章 方法', '2.1 实验']), [1, 2, 2, 1, 2]);
  // A chapter word above them: the bare numbers are items, below the decimals.
  assert.deepEqual(levels(['第一章 总论', '1.1 背景', '1. 第一点', '2. 第二点']), [1, 2, 3, 3]);
});

test('English unit words: Part > Chapter / Lecture / Week > Section; roman and letter lists below', () => {
  assert.deepEqual(levels(['Part I Foundations', 'Chapter 1 Sets', 'Section 1 Basics', 'Chapter 2 Maps', 'Part II Uses']), [1, 2, 3, 2, 1]);
  assert.deepEqual(levels(['Lecture 3 Architecture', 'I. Layers', 'A. Presentation', 'B. Logic', 'II. Patterns', 'Lecture 4 Testing']), [1, 2, 3, 3, 2, 1]);
  assert.deepEqual(levels(['Week 1', 'Week 2', 'Appendix A Tables']), [1, 1, 1]);
});

test('an unnumbered title sits under the numbered one before it; before any, it opens the document', () => {
  assert.deepEqual(levels(['课程讲义', '第一章 绪论', '学习目标', '一、定义', '本章小结', '第二章 方法']), [1, 1, 2, 2, 3, 1]);
  assert.deepEqual(levels(['Overview', 'Chapter 1 Sets', 'Summary', 'Chapter 2 Maps']), [1, 1, 2, 1]);
});

test('no numbering signal (fewer than two numbered titles): null, the levels stay as they are', () => {
  assert.equal(levels(['Introduction', 'Background', 'Results']), null);
  assert.equal(levels(['第一章 绪论', '背景', '方法']), null);
  assert.equal(levels([]), null);
  // Numbers that are no numbering: a year, a quantity, a version.
  assert.equal(levels(['2024年期末复习', '3D 打印', 'v2 新功能', 'COVID-19 专题']), null);
});

test('levels never pass 6, whatever the depth of the numbering', () => {
  const found = levels(['第一部分 甲', '第一章 乙', '第一节 丙', '一、丁', '（一）戊', '1. 己', '(1) 庚', '① 辛', 'a) 壬']);
  assert.ok(found.every(level => level >= 1 && level <= 6));
  assert.deepEqual(found.slice(0, 6), [1, 2, 3, 4, 5, 6]);
});

/* ---------- the owner's material, end to end ---------- */

const title = (text, page) => ({ type: 'text', text, text_level: 1, page_idx: page });
const body = (text, page) => ({ type: 'text', text, page_idx: page });
/* Eight pages; every title at text_level 1, numbered like the owner's material, plus unnumbered titles; most pages hold several titles. */
const flat = [
  title('软件工程课程讲义', 0), body('本讲义供期末复习使用。', 0),
  title('第一章 软件过程', 1), title('一、过程模型', 1), body('过程模型描述开发的阶段。', 1), title('（一）瀑布模型', 1), body('瀑布模型按阶段顺序推进。', 1),
  title('1. 需求', 2), body('需求阶段确定要做什么。', 2), title('2. 设计', 2), body('设计阶段确定怎么做。', 2),
  title('（二）增量模型', 3), body('增量模型分批交付。', 3), title('二、敏捷方法', 3), body('敏捷强调迭代与反馈。', 3),
  title('第二章 需求工程', 4), title('1.1 需求获取', 4), body('访谈与问卷是常用的获取方法。', 4),
  title('1.2 需求分析', 5), body('分析把需求整理成模型。', 5), title('本章小结', 5), body('需求决定了后面的一切。', 5),
  title('Chapter 3 Design', 6), title('3.1 Architecture', 6), body('Layers separate concerns.', 6),
  title('3.2 Patterns', 7), body('Patterns are reusable solutions.', 7),
];

test('trace: flat MinerU titles gave one chapter per page (each page went to the last title on it)', () => {
  // What the import did before: every title at one level, so every title was a chapter and each page belonged to the last one starting on it.
  const book = parseConvertedDocument(JSON.stringify(flat), { filename: '软件工程.pdf' });
  const sources = book.pages.map(page => ({ id: `p${page.page}`, text: page.text, title: `x · p.${page.page}`,
    document: { id: 'h'.repeat(64), page: page.page, totalPages: book.totalPages, origin: 'converted', converter: 'mineru', format: 'pdf',
      ...(page.chapter >= 0 ? { chapter: { index: page.chapter, title: book.chapters[page.chapter].title, level: book.chapters[page.chapter].level } } : {}) } }));
  const [item] = groupSourcesByDocument(sources);
  // Now the chapters are the material's own: 讲义 front page, then 第一章 (pp. 2-4), 第二章 (pp. 5-6), Chapter 3 (pp. 7-8).
  assert.deepEqual(item.chapters.map(chapter => [chapter.title, chapter.startPage, chapter.endPage]),
    [['软件工程课程讲义', 1, 1], ['第一章 软件过程', 2, 4], ['第二章 需求工程', 5, 6], ['Chapter 3 Design', 7, 8]]);
  assert.ok(item.chapters.length < book.totalPages, 'chapters are not pages');
  // The outline keeps every title, at the level its numbering gives it.
  assert.deepEqual(book.outline.map(entry => entry.level), [1, 1, 2, 3, 4, 4, 3, 2, 1, 2, 2, 3, 1, 2, 2]);
  // The stored text is not rewritten: the headings stay as the converter wrote them.
  assert.match(book.pages[1].text, /^# 第一章 软件过程$/m);
  assert.match(book.pages[1].text, /^# 一、过程模型$/m);
});

test('headings that already have levels are kept as the converter wrote them', () => {
  const leveled = [title('第一章 甲', 0), { ...title('1.1 乙', 0), text_level: 2 }, title('第二章 丙', 1)];
  const book = parseConvertedDocument(JSON.stringify(leveled), { filename: 'x.pdf' });
  assert.deepEqual(book.outline.map(entry => entry.level), [1, 2, 1]);
});

test('flat headings with no numbering keep today\'s chapters', () => {
  const plain = [title('Introduction', 0), body('a', 0), title('Background', 1), body('b', 1), title('Results', 2), body('c', 2)];
  const book = parseConvertedDocument(JSON.stringify(plain), { filename: 'x.pdf' });
  assert.deepEqual(book.chapters.map(chapter => chapter.title), ['Introduction', 'Background', 'Results']);
});

/* ---------- a material imported before the fix ---------- */

async function materials(t) {
  const root = await mkdtemp(join(tmpdir(), 'flat-headings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const ops = createMaterialsOperations({ root,
    read: async () => { const state = await store.read(); return structuredClone({ sources: state.sources, documents: state.documents || [] }); },
    update: fn => store.update(async state => {
      const own = { sources: state.sources, documents: state.documents || [] };
      const result = await fn(own); state.sources = own.sources; state.documents = own.documents; return result;
    }) });
  return { store, call: (action, args = {}) => ops.handlers[action](args) };
}

test('a book converted before the fix (page-sized chapters) reads with its heading chapters without converting it again, and its course sees the change', async t => {
  const { store, call } = await materials(t);
  const text = JSON.stringify(flat), hash = bytesHash(Buffer.from(text, 'utf8')), documentId = `document-${hash}-json`, old = `${hash}-json-conv1`;
  // The library as the old import left it: one chapter per page, named after the last title on it.
  const lastTitle = page => flat.filter(item => item.page_idx === page - 1 && item.text_level).at(-1).text;
  const pages = parseConvertedDocument(text, { filename: '软件工程.json' }).pages;
  await store.update(state => {
    state.sources = Array.from({ length: 8 }, (_, at) => ({ id: `${documentId}-${old}-p${at + 1}`, title: `软件工程 · p.${at + 1}`, text: pages[at].text, courses: ['SE'],
      document: { id: hash, page: at + 1, totalPages: 8, extractionVersion: 2, origin: 'converted', converter: 'mineru', materialId: documentId, materialRevision: old,
        format: 'pdf', filename: '软件工程.json', bookTitle: '软件工程', chapter: { index: at, title: lastTitle(at + 1), level: 1 } } }));
    state.documents = [{ id: documentId, format: 'pdf', filename: '软件工程.json', title: '软件工程', currentRevision: old,
      versions: [{ revision: old, attachment: null, sourceIds: state.sources.map(source => source.id), importedAt: '2026-11-01T00:00:00.000Z' }] }];
  });
  const { sources: stored, documents } = await store.read();
  // As stored (what a book built from it saw): a chapter per page. Read now, its pages are stamped again from their own texts (lib/converted-chapter-stamps.js).
  const built = groupSourcesByDocument(stored.map(({ text, ...source }) => ({ ...source, chars: text.length })), { documents });
  assert.equal(built[0].chapters.length, 8, 'the old import as stored: a chapter per page');
  // Without the library's records the pages still say how big their book is: all eight are here, so it is read again all the same.
  assert.equal(groupSourcesByDocument(stored)[0].chapters.length, 4, 'no records, every page of the book: read again');
  assert.equal(groupSourcesByDocument(stored.slice(2, 5))[0].chapters.length, 3, 'no records, a part of the book: its stored chapters stay');
  const before = groupSourcesByDocument(stored, { documents });
  assert.deepEqual(before[0].chapters.map(chapter => chapter.title), ['软件工程课程讲义', '第一章 软件过程', '第二章 需求工程', 'Chapter 3 Design']);
  // The course's materials changed as the outline engine sees them: the book shows 需要更新 and its next update builds the outline again.
  assert.notEqual(materialsFingerprint(before), materialsFingerprint(built));
  const imported = await call('materials.document.import', { dataBase64: Buffer.from(text, 'utf8').toString('base64'), filename: '软件工程.json', format: 'json', courses: ['SE'] });
  assert.notEqual(imported.revision, old, 'the same bytes make a new revision: the projection changed');
  const state = await store.read(), current = new Set(imported.sourceIds);
  const after = groupSourcesByDocument(state.sources.filter(source => current.has(source.id)));
  assert.deepEqual(after[0].chapters.map(chapter => chapter.title), ['软件工程课程讲义', '第一章 软件过程', '第二章 需求工程', 'Chapter 3 Design']);
});
