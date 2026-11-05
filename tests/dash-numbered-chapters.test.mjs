import test from 'node:test';
import assert from 'node:assert/strict';
import { inferHeadingLevels } from '../lib/heading-levels.js';
import { parseConvertedDocument } from '../lib/converted-document.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { snapshotSources } from '../lib/source-query.js';
import { courseSkeleton } from '../lib/custom-skeleton.js';
import { coverageForDocument } from '../lib/coverage-state.js';

/* Owner report 2026-11-06: a 513-page translated textbook converted with local MinerU came out as 64 "chapters", 47 of them one page, and three 附录 headings
   swallowing pages 81-513. Its chapter titles carry no 第N章: each chapter is "<title>", then 本章要点, then sections numbered N—M (em dash; also N-M, N–M,
   N－M, with or without spaces); figure / table / box captions (表1-1, 图2-3, [资料1- 1]) are no sections; the end-of-chapter headings (本章提要, 关键术语,
   问题, 概念题, 操作题 …) and each chapter's own 附录 belong to that chapter. The fixture below has the same shape with neutral titles. */

const levels = titles => inferHeadingLevels(titles);

test('N—M is section numbering of chapter N (the rank of 1.1), with every dash and spacing', () => {
  // Under a chapter word the dash sections sit where decimal sections sit.
  assert.deepEqual(levels(['第一章 总论', '1—1 背景', '1-2 意义', '第二章 方法', '2–1 实验', '2 － 2 调查']), [1, 2, 2, 1, 2, 2]);
  assert.deepEqual(levels(['第一章 总论', '1.1 背景', '1—2 意义']), [1, 2, 2]);
  // A caption, a year range and a quantity are no section numbering.
  assert.deepEqual(levels(['第一章 总论', '1—1 背景', '表1-1 2001—2010年间的价格', '图1-2 曲线', '[资料1- 1] 故事', '1965—2014年间的增长', '3-5 分钟练习']),
    [1, 2, 3, 3, 3, 3, 3]);
});

const BOOK_TITLES = ['示例教材', '版权页', '译者前言', '目录',
  '市场导论', '本章要点', '1—1 市场的含义', '表1-1 2001—2010年间的价格指数', '[资料1- 1] 一个故事', '1–2 供给与需求', '本章提要', '关键术语', '问题', '概念题',
  '生产理论', '本章要点', '2-1 生产函数', '图2-3 成本曲线', '2 - 2 规模报酬', '2—3 技术进步', '技术题', '操作题', '附录:生产函数的数学',
  '货币与银行', '本章要点', '3－1 货币的职能', '3—2 银行体系', '本章提要', '附录'];

test('a book that numbers its sections N—M and has no chapter word: the title before each chapter\'s first section is the chapter', () => {
  assert.deepEqual(levels(BOOK_TITLES), [
    2, 2, 2, 2, // front matter: under the chapters, so it is no chapter
    1, 2, 2, 3, 3, 2, 3, 3, 3, 3, // 市场导论: 本章要点 and its sections under it, the captions and the end-of-chapter headings under the sections
    1, 2, 2, 3, 2, 2, 3, 3, 2, // 生产理论: its 附录 is a part of the chapter, a sibling of its sections
    1, 2, 2, 2, 3, 2, // 货币与银行: the 附录 after the last chapter's sections is that chapter's
  ]);
});

test('a chapter whose title the converter missed starts at its lead-in, else at its first section; a caption or an end-of-chapter heading is never its title', () => {
  // 第二章's title is missing: the heading before 本章要点 is the first chapter's 操作题, so 本章要点 opens the chapter.
  assert.deepEqual(levels(['甲', '本章要点', '1—1 a', '1—2 b', '操作题', '本章要点', '2—1 c', '2—2 d']), [1, 2, 2, 2, 3, 1, 2, 2]);
  // No lead-in either, and the heading before is a caption: the first section opens the chapter.
  assert.deepEqual(levels(['甲', '1—1 a', '1—2 b', '表1-1 数据', '2—1 c', '2—2 d']), [1, 2, 2, 3, 1, 2]);
});

/* ---------- the whole book, as MinerU writes it ---------- */

const title = (text, page) => ({ type: 'text', text, text_level: 1, page_idx: page - 1 });
const body = (text, page) => ({ type: 'text', text: `${text}（第 ${page} 页的正文）`, page_idx: page - 1 });
/* 17 pages: four of front matter, then three chapters; every title at text_level 1. */
const BOOK = [
  title('示例教材', 1), body('封面', 1), title('版权页', 2), body('版权信息', 2), title('译者前言', 3), body('前言', 3), title('目录', 4), body('1—1 市场的含义 …… 6', 4),
  title('市场导论', 5), title('本章要点', 5), body('本章讲市场', 5),
  title('1—1 市场的含义', 6), body('市场是交换的场所', 6), title('表1-1 2001—2010年间的价格指数', 6), body('价格表', 6),
  title('[资料1- 1] 一个故事', 7), body('故事', 7), title('1–2 供给与需求', 7), body('供求决定价格', 7),
  title('本章提要', 8), body('小结', 8), title('关键术语', 8), body('市场 供给 需求', 8), title('问题', 8), title('概念题', 8), body('什么是市场', 8),
  title('生产理论', 9), title('本章要点', 9), body('本章讲生产', 9), title('2-1 生产函数', 9), body('投入与产出', 9),
  title('图2-3 成本曲线', 10), body('曲线', 10), title('2 - 2 规模报酬', 10), body('规模报酬递增', 10),
  title('2—3 技术进步', 11), body('技术进步', 11), title('技术题', 11), body('计算', 11), title('操作题', 11), body('操作', 11),
  title('附录:生产函数的数学', 12), body('推导', 12), body('推导续', 13),
  title('货币与银行', 14), title('本章要点', 14), body('本章讲货币', 14), title('3－1 货币的职能', 14), body('交换媒介', 14),
  title('3—2 银行体系', 15), body('银行', 15), title('本章提要', 15), body('小结', 15),
  title('附录', 16), body('附加材料', 16), body('附加材料续', 17),
];
const CHAPTERS = [['市场导论', 5, 8], ['生产理论', 9, 13], ['货币与银行', 14, 17]];

test('the book\'s chapters are its real chapters: front matter before the first, no one-page chapters, each 附录 inside its chapter', () => {
  const book = parseConvertedDocument(JSON.stringify(BOOK), { filename: '示例教材.json' });
  assert.deepEqual(book.chapters.map(chapter => [chapter.title, chapter.startPage, chapter.endPage]), CHAPTERS);
  assert.deepEqual(book.pages.filter(page => page.chapter < 0).map(page => page.page), [1, 2, 3, 4], 'front matter is before the first chapter (index -1)');
  assert.equal(book.pages.find(page => page.page === 12).chapter, 1, 'the 附录 of 生产理论 is in 生产理论');
  assert.equal(book.pages.find(page => page.page === 17).chapter, 2);
});

test('a book-level appendix of a 第N章 book stays a chapter; the 第N章 and decimal books keep their chapters', () => {
  const chaptered = [title('第一章 甲', 1), body('a', 1), title('1.1 乙', 2), body('b', 2), title('第二章 丙', 3), body('c', 3), title('2.1 丁', 4), body('d', 4),
    title('附录 A 数学工具', 5), body('e', 5)];
  assert.deepEqual(parseConvertedDocument(JSON.stringify(chaptered), { filename: 'x.json' }).chapters.map(chapter => [chapter.title, chapter.startPage, chapter.endPage]),
    [['第一章 甲', 1, 2], ['第二章 丙', 3, 4], ['附录 A 数学工具', 5, 5]]);
  const decimal = [title('1 Introduction', 1), body('a', 1), title('1.1 Background', 2), body('b', 2), title('2 Methods', 3), body('c', 3), title('2.1 Data', 4), body('d', 4)];
  assert.deepEqual(parseConvertedDocument(JSON.stringify(decimal), { filename: 'x.json' }).chapters.map(chapter => [chapter.title, chapter.startPage, chapter.endPage]),
    [['1 Introduction', 1, 2], ['2 Methods', 3, 4]]);
});

/* ---------- a book imported before the fix ---------- */

const HASH = 'd'.repeat(64), DOCUMENT_ID = `document-${HASH}-json`;
/** The book's pages as the materials import stores them, stamped with the chapters of `revision`'s rule (`chapters`: the chapter title of each page, '' for none). */
function stored(revision, chapterOf) {
  const book = parseConvertedDocument(JSON.stringify(BOOK), { filename: '示例教材.json' });
  const titles = [...new Set(book.pages.map(page => chapterOf(page.page)).filter(Boolean))];
  return book.pages.map(page => ({ id: `${DOCUMENT_ID}-${revision}-p${page.page}`, title: `示例教材 · p.${page.page}`, text: page.text, courses: ['经济学'], createdAt: '2026-11-01T00:00:00.000Z',
    document: { id: HASH, page: page.page, totalPages: book.totalPages, extractionVersion: 2, origin: 'converted', converter: 'mineru', materialId: DOCUMENT_ID,
      materialRevision: revision, format: 'pdf', filename: '示例教材.json', bookTitle: '示例教材',
      ...(chapterOf(page.page) ? { chapter: { index: titles.indexOf(chapterOf(page.page)), title: chapterOf(page.page), level: 1 } } : {}) } }));
}
const documentsOf = (sources, revision) => [{ id: DOCUMENT_ID, format: 'pdf', filename: '示例教材.json', title: '示例教材', currentRevision: revision,
  versions: [{ revision, attachment: null, sourceIds: sources.map(source => source.id), importedAt: '2026-11-01T00:00:00.000Z' }] }];
/* What the import before this fix stored: a chapter for every page that starts with a title (named after the last one), the 附录 pages their own chapters. */
const oldChapterOf = page => ({ 1: '示例教材', 2: '版权页', 3: '译者前言', 4: '目录', 5: '本章要点', 6: '表1-1 2001—2010年间的价格指数', 7: '1–2 供给与需求', 8: '概念题',
  9: '2-1 生产函数', 10: '2 - 2 规模报酬', 11: '操作题', 12: '附录:生产函数的数学', 13: '附录:生产函数的数学', 14: '3－1 货币的职能', 15: '本章提要', 16: '附录', 17: '附录' })[page];
const rows = item => item.chapters.filter(chapter => !chapter.front).map(chapter => [chapter.title, chapter.startPage, chapter.endPage]);

test('a book imported before the fix reads with its real chapters, without converting it again', () => {
  const revision = `${HASH}-json-conv2`, sources = stored(revision, oldChapterOf), documents = documentsOf(sources, revision);
  const [item] = groupSourcesByDocument(sources, { documents });
  assert.deepEqual(rows(item), CHAPTERS);
  assert.deepEqual(item.chapters[0], { ...item.chapters[0], front: true, startPage: 1, endPage: 4 });
  // The panel's snapshot (no page texts) carries the same chapters, so the 资料 page and the picker list what the backend lists.
  const snapshot = snapshotSources(sources, new Set(), documents);
  assert.ok(snapshot.every(source => source.text === undefined));
  assert.deepEqual(rows(groupSourcesByDocument(snapshot, { documents })[0]), CHAPTERS);
  // The 深度定制 interview offers the real chapters.
  const skeleton = courseSkeleton({ sources, documents, decks: [], drafts: [], courses: [] }, '经济学');
  assert.deepEqual(skeleton.documents[0].chapters.map(chapter => [chapter.title, ...chapter.pages]), CHAPTERS);
  // The book's coverage rolls up by the same chapters (front matter is no chapter group).
  const coverage = coverageForDocument({ sources, documents, decks: [], drafts: [] }, { documentId: DOCUMENT_ID }).coverage;
  assert.deepEqual(coverage.groups.filter(group => group.kind === 'chapter').map(group => group.title), CHAPTERS.map(row => row[0]));
});

test('a book imported with this rule keeps the chapters it was stored with; part of an old book is not re-chaptered on its own', () => {
  // conv3 stamps are this rule's own: they are read as stored (here deliberately different, to show they are not derived again).
  const revision = `${HASH}-json-conv3`, sources = stored(revision, oldChapterOf);
  assert.equal(groupSourcesByDocument(sources, { documents: documentsOf(sources, revision) })[0].chapters.length, 15);
  // Some pages of an old book (a selection): their chapters cannot be read from a part, so the stored ones stay.
  const old = `${HASH}-json-conv2`, all = stored(old, oldChapterOf), some = all.filter(source => source.document.page >= 9 && source.document.page <= 13);
  assert.deepEqual(rows(groupSourcesByDocument(some, { documents: documentsOf(all, old) })[0]).map(row => row[0]),
    ['2-1 生产函数', '2 - 2 规模报酬', '操作题', '附录:生产函数的数学']);
});

/* ---------- the owner's real heading runs (coordinator's read-only run on the 513-page book, 2026-11-06) ---------- */

/* What stands between a chapter's end block and its first N—1, as MinerU wrote it: a lead-in (本章要点) with content headings after it ([资料5-1] …,
   本章内容是关于…, 注意那些…, 本章纲要), a title numbered "N 标题", a bare "N" before the title, a leftover of the previous chapter (泰勒规则), a title that
   ends in 题 (前沿课题). The chapter starts at the heading before its FIRST lead-in, and that heading is its title. */
const RUNS = [
  [88, '旧的一章'], [88, '本章要点'], [89, '4—1 甲'], [95, '4—2 乙'], [97, '本章提要'], [97, '操作题'],
  [98, '总供给与总需求'], [98, '本章要点'], [100, '[资料5-1] 历史故事'], [100, '“总供给”与“总需求”:名称的含义？'], [101, '5—1 甲'], [105, '操作题'],
  [169, '政策预览'], [169, '本章要点'], [169, '本章内容是关于经济政策的'], [170, '9—1 甲'], [174, '操作题'], [175, '泰勒规则'],
  [176, '10 收入与支出'], [176, '本章要点'], [177, '10—1 甲'], [195, '操作题'],
  [196, '11 货币、利息与收入'], [196, '本章要点'], [198, '注意那些看起来难懂的材料'], [199, '本章纲要'], [200, '11—1 甲'], [270, '操作题'],
  [272, '消费与储蓄'], [272, '本章要点'], [275, '[资料14-1] 历史故事'], [275, '税收政策下的现代消费理论'], [276, '14—1 甲'], [290, '操作题'],
  [292, '15 投资支出'], [292, '本章要点'], [293, '投资为什么是动荡不定的'], [294, '投资:总投资与净投资'], [295, '15—1 甲'], [314, '操作题'],
  [316, '货币需求'], [316, '本章要点'], [316, '什么是“货币”'], [317, '16—1 甲'], [328, '操作题'],
  [330, '【选读材料】'], [330, '附录:鲍莫尔-托宾的交易需求模型'], [331, '17'], [332, '联邦储备、货币与信用'], [332, '本章要点'], [333, '17—1 甲'], [349, '操作题'],
  [351, '政策'], [351, '本章要点'], [351, '本章是关于政策的。'], [352, '18—1 甲'], [465, '操作题'],
  [467, '前沿课题'], [467, '本章要点'], [468, '24—1 甲'], [470, '操作题'],
];
const runBook = () => [...RUNS.flatMap(([page, text]) => [title(text, page), body(text, page)]), body('最后一页', 471)];

test('the owner\'s heading runs: each chapter starts at the heading before its first lead-in, "N 标题" and a bare "N" give the title, a leftover stays behind', () => {
  const book = parseConvertedDocument(JSON.stringify(runBook()), { filename: '宏观.json' });
  assert.deepEqual(book.chapters.map(chapter => [chapter.title, chapter.startPage, chapter.endPage]), [
    ['旧的一章', 88, 97], ['总供给与总需求', 98, 168], ['政策预览', 169, 175], ['收入与支出', 176, 195], ['货币、利息与收入', 196, 271],
    ['消费与储蓄', 272, 291], ['投资支出', 292, 315], ['货币需求', 316, 330], ['联邦储备、货币与信用', 331, 350], ['政策', 351, 466], ['前沿课题', 467, 471],
  ]);
  // The stored text keeps the headings as written; only the chapter's name drops its number.
  assert.match(book.pages.find(page => page.page === 176).text, /^# 10 收入与支出$/m);
});
