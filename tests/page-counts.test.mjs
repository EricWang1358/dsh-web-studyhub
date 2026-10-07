import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { describeScope } from '../lib/contexts/generation/retrieval/index-plan.js';
import { nativeSelects } from './helpers/native-selects.mjs';

/* The 资料 page said 404 页 (the row, the index badge), 422 页 (the 大教材建议) and 588 页 with 4 missing (the course box) about one book.
   One fact is one number, and every number says what it counts: the pages of the document that have text, the original file's pages, the whole course. */

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export * from './ui/index-scope.js';
  export { default as Sources } from './ui/Sources.jsx';
  export { default as IndexBadge, indexLabel } from './ui/IndexBadge.jsx';
  export { default as LargeDocumentCard } from './ui/LargeDocumentCard.jsx';
  export { default as ExtensionPanel, ExtensionUpdateNotice } from './ui/ExtensionPanel.jsx';
  export { restartDone } from './ui/retrieval-extension-flow.js';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], plugins: [nativeSelects], loader: { '.css': 'text', '.json': 'json' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { pageFacts, pageGapNote, pageGapHint, indexTip, courseScopeLine, indexTarget, indexAction, Sources, IndexBadge, indexLabel, LargeDocumentCard, ExtensionPanel, ExtensionUpdateNotice, restartDone, setUiLanguage } = module.exports;
const h = React.createElement;
const han = /[㐀-鿿]/;
const render = (element, language = 'zh') => { setUiLanguage(language); try { return renderToStaticMarkup(element); } finally { setUiLanguage('zh'); } };
const visible = html => html.replace(/<span[^>]*role="tooltip"[\s\S]*?<\/span>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const HASH = 'c'.repeat(64);
const COURSE = 'Architecting Software Solutions';

/** A converted book: `readable` pages have text, the original file has `original`. */
const book = (readable, original, extra = {}) => Array.from({ length: readable }, (_, i) => ({ id: `bk-p${i + 1}`, title: `Software Architecture · p.${i + 1}`, text: `第 ${i + 1} 页的正文`.repeat(20), createdAt: '2026-10-01T08:00:00.000Z',
  courses: [COURSE], document: { id: HASH, page: i + 1, totalPages: original, format: 'pdf', filename: 'sa.md', bookTitle: 'Software Architecture', origin: 'converted', converter: 'mineru', extractionVersion: 2, materialId: `document-${HASH}-md`, ...extra } }));
const [taller] = groupSourcesByDocument(book(404, 422));
const [whole] = groupSourcesByDocument(book(404, 404));

/* ---------- one number for a document, and the one place the original's length is said ---------- */

test('a document has the pages that have text, and says once how many the original file has when that is more', () => {
  assert.deepEqual([pageFacts(taller).readable, pageFacts(taller).original, pageFacts(taller).gap], [404, 422, 18]);
  assert.deepEqual([pageFacts(whole).readable, pageFacts(whole).original, pageFacts(whole).gap], [404, 404, 0]);
  assert.equal(pageGapNote(taller), '原 PDF 422 页');
  assert.equal(pageGapNote(whole), '', 'nothing to say when every page has text');
  const sizeless = groupSourcesByDocument(book(5, 5).map(source => ({ ...source, document: { ...source.document, totalPages: undefined } })))[0];
  assert.deepEqual([pageFacts(sizeless).readable, pageFacts(sizeless).original, pageFacts(sizeless).gap], [5, 0, 0]);
  assert.equal(pageGapNote(sizeless), '');
  assert.deepEqual(pageFacts({ pages: [] }), { readable: 0, original: 0, gap: 0 });
  assert.equal(pageGapNote({ pages: [], format: 'pdf' }), '');
  const note = groupSourcesByDocument([{ id: 'n', title: '笔记', text: 'x'.repeat(50), courses: [] }])[0];
  assert.equal(pageGapNote(note), '', 'a note has no original pages');
});

test('the hint gives the numbers and the cause: a converted book skipped pictures and blanks; a PDF may also have been imported in part', () => {
  const converted = pageGapHint(taller);
  assert.match(converted, /404 页有文字/);
  assert.match(converted, /原 PDF 共 422 页/);
  assert.match(converted, /18 页/);
  assert.match(converted, /图片|空白/);
  assert.doesNotMatch(converted, /没有选中/);
  const imported = groupSourcesByDocument(book(404, 422).map(source => ({ ...source, document: { ...source.document, origin: undefined, converter: undefined, materialId: `document-${HASH}-pdf` } })))[0];
  assert.match(pageGapHint(imported), /没有选中|没选/);
  assert.equal(pageGapHint(whole), '');
});

test('the badge counts the document’s own pages and says so; its hover says what “built” means and what it does not count', () => {
  assert.equal(indexLabel({ state: 'indexed', indexed: 404, total: 404 }, { canIndex: true }), '索引已建好 · 这份资料 404/404 页');
  assert.equal(indexLabel({ state: 'partial', indexed: 120, total: 404 }, { canIndex: true }), '索引建了一部分 · 这份资料 120/404 页');
  assert.equal(indexLabel({ state: 'stale', stale: 3, indexed: 401, total: 404 }, { canIndex: true }), '索引需要更新 · 这份资料有 3 页改过');
  const [first, second] = indexTip({ state: 'indexed', indexed: 404, total: 404 });
  assert.match(first, /404 页都已/);
  assert.match(second, /不含课程里的其他资料/);
  assert.match(indexTip({ state: 'partial', indexed: 120, total: 404 })[0], /120 页/);
  assert.match(indexTip({ state: 'missing', total: 404 })[0], /还没有检索目录/);
  assert.equal(indexTip({ state: 'indexed', indexed: 1, total: 1 }).length, 2, 'one sentence and one consequence');
});

/* ---------- the course, with names ---------- */

const picked = [
  ...book(404, 422).map(source => ({ ...source, courses: [COURSE] })),
  ...Array.from({ length: 3 }, (_, i) => ({ id: `a-${i}`, title: `第三章 讲义 · p.${i + 1}`, text: 'x'.repeat(60), courses: [COURSE], document: { id: 'a'.repeat(64), page: i + 1, totalPages: 3, format: 'pdf', filename: 'ch3.pdf' } })),
  { id: 'n1', title: '复习笔记', text: 'y'.repeat(60), courses: [COURSE] },
];

test('the plan names the materials that still have pages to index: how many pages each, the biggest first', () => {
  const add = picked.filter(source => source.id.startsWith('a-') || source.id === 'n1');
  const scope = describeScope({ picked, add });
  assert.equal(scope.documents, 3);
  assert.deepEqual(scope.missing, [{ title: 'ch3.pdf', pages: 3 }, { title: '复习笔记', pages: 1 }]);
  assert.equal(scope.missingDocuments, 2);
  const many = describeScope({ picked, add: picked.slice(0, 410) });
  assert.equal(many.missing[0].pages, 404, 'the book itself');
  const none = describeScope({ picked, add: [] });
  assert.deepEqual([none.documents, none.missing, none.missingDocuments], [3, [], 0]);
  assert.deepEqual(describeScope({ picked: [], add: [] }), { documents: 0, missing: [], missingDocuments: 0 });
  const long = describeScope({ picked: Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, title: `笔记 ${i}`, text: 'z'.repeat(60), courses: [] })), add: Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, title: `笔记 ${i}`, text: 'z'.repeat(60), courses: [] })) });
  assert.equal(long.missingDocuments, 12);
  assert.ok(long.missing.length <= 5, 'only the first few are named');
});

const plan = (extra = {}) => ({ course: COURSE, pages: 588, toIndex: 4, unchanged: 584, toRemove: 0, chars: 2400, firstRun: false, modelMb: 90, canIndex: true,
  documents: 7, missing: [{ title: '第三章 讲义', pages: 3 }, { title: '复习笔记', pages: 1 }], missingDocuments: 2, ...extra });

test('the course line says what it counts: the course, its pages, its materials, and which of them still need the index', () => {
  assert.equal(courseScopeLine(plan(), COURSE),
    '「Architecting Software Solutions」这门课共 588 页（含 7 份资料）：其中 4 页还没建索引，来自《第三章 讲义》（3 页）、《复习笔记》（1 页）；584 页已经建好。');
  assert.equal(courseScopeLine(plan({ toIndex: 0, unchanged: 588, missing: [], missingDocuments: 0 }), COURSE), '「Architecting Software Solutions」这门课共 588 页（含 7 份资料），索引已是最新。');
  assert.match(courseScopeLine(plan({ missing: [{ title: 'A', pages: 2 }, { title: 'B', pages: 1 }, { title: 'C', pages: 1 }], missingDocuments: 5 }), COURSE), /《C》（1 页）等 5 份/);
  assert.match(courseScopeLine(plan({ documents: 1 }), COURSE), /（含 1 份资料）/);
  assert.match(courseScopeLine(plan(), ''), /^全部资料共 588 页/);
  assert.equal(courseScopeLine(plan({ documents: undefined, missing: undefined, missingDocuments: undefined }), COURSE), '「Architecting Software Solutions」这门课共 588 页：其中 4 页还没建索引；584 页已经建好。', 'a host that does not name them: the counts only');
  assert.equal(courseScopeLine(plan({ pages: 0, toIndex: 0, unchanged: 0, documents: 0, missing: [], missingDocuments: 0 }), COURSE), '「Architecting Software Solutions」这门课还没有资料页。');
  assert.equal(courseScopeLine(null, COURSE), '');
  assert.match(courseScopeLine(plan({ missing: [{ title: '很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长的标题', pages: 4 }], missingDocuments: 1 }), COURSE), /《很长[^》]{1,33}…》（4 页）/);
});

test('whose pages are missing decides the button: this document’s own, or other materials’ that the course holds', () => {
  const own = { info: { state: 'partial', indexed: 100, total: 404 }, courses: [COURSE] };
  const done = { info: { state: 'indexed', indexed: 404, total: 404 }, courses: [COURSE] };
  assert.equal(indexTarget(own, COURSE, [COURSE]), 'own');
  assert.equal(indexTarget(done, COURSE, [COURSE]), 'others');
  assert.equal(indexTarget(done, '', [COURSE]), 'others', 'the whole library');
  assert.equal(indexTarget(own, '数据库', [COURSE, '数据库']), 'other-course', 'another course chosen: the document has nothing to do with it');
  assert.equal(indexTarget(undefined, COURSE, [COURSE]), null, 'Settings has no document');
  const top = indexAction({ plan: plan(), document: done, course: COURSE, names: [COURSE] });
  assert.deepEqual([top.label, top.variant], ['为这门课补建 4 页索引', 'secondary']);
  assert.match(top.note, /这份资料自己的 404 页已经全部建好/);
  const mine = indexAction({ plan: plan({ toIndex: 304, unchanged: 284 }), document: own, course: COURSE, names: [COURSE] });
  assert.deepEqual([mine.label, mine.variant, mine.note], ['为这门课建立检索索引', 'primary', '']);
  const settings = indexAction({ plan: plan(), document: undefined, course: COURSE, names: [COURSE] });
  assert.deepEqual([settings.label, settings.variant], ['为这门课建立检索索引', 'primary']);
  const none = indexAction({ plan: null, document: done, course: COURSE, names: [COURSE] });
  assert.deepEqual([none.label, none.variant], ['为这门课建立检索索引', 'primary'], 'until the plan is known nothing is claimed');
  assert.equal(indexAction({ plan: plan({ toIndex: 0, unchanged: 588 }), document: done, course: COURSE, names: [COURSE] }).variant, 'secondary');
});

/* ---------- what is on the screen ---------- */

const data = (sources) => ({ root: '/lib', sources, focus: { courses: [COURSE] }, contexts: ['materials'] });
const sourcesPage = (sources, language = 'zh') => render(h(Sources, { data: data(sources), busy: false, act() {}, call() {}, setModal() {}, onGenerate() {} }), language);

test('the row, the advice title and the card use one count; the original’s 422 is said once, with its hover', () => {
  const html = sourcesPage(book(404, 422));
  const text = visible(html);
  assert.match(text, /转换文档 · 404 页/);
  assert.match(text, /这份资料有 404 页，建议按章节使用/);
  assert.equal((text.match(/422/g) || []).length, 1, '422 appears once in the words a reader sees');
  assert.match(text, /原 PDF 422 页/);
  assert.match(html, /role="tooltip"[^>]*>[^<]*404 页有文字/, 'and its hover explains the 18');
  assert.doesNotMatch(html, /title="[^"]*(?:422|404)/, 'no native title where a Tooltip belongs');
  assert.match(html, /有 404 页/, 'the card says 404 too');
  assert.doesNotMatch(html, /有 422 页/);
});

test('a document whose every page has text shows no second number', () => {
  const text = visible(sourcesPage(book(404, 404)));
  assert.match(text, /这份资料有 404 页/);
  assert.doesNotMatch(text, /原 PDF/);
});

test('the same page in English, with no Chinese left in the words', () => {
  const html = sourcesPage(book(404, 422), 'en');
  const text = visible(html).replace(/Software Architecture|第 \d+ 页的正文|Architecting Software Solutions/g, '');
  assert.match(text, /Converted document · 404 pages/);
  assert.match(text, /This material has 404 pages: use it by chapter/);
  assert.match(text, /Original PDF: 422 pages/);
  assert.doesNotMatch(text, han);
});

const running = { selected: 'builtin', effective: 'builtin', hostCanSearch: false, providers: [], otherTools: [], companion: { id: 'x', running: true }, extension: { canInstall: true, installed: true, enabled: true, version: '3.0.1', desktop: false } };
const card = (props, language) => render(h(LargeDocumentCard, { reason: 'long-document', detail: { name: '软件架构', pages: 404 }, retrieval: running, call: () => {}, courses: [COURSE], defaultCourse: COURSE, initialPlan: plan(), ...props }), language);
const own = { info: { state: 'partial', indexed: 100, total: 404 }, courses: [COURSE] }, done = { info: { state: 'indexed', indexed: 404, total: 404 }, courses: [COURSE] };

test('the card: 404 pages, a course line with names, and a secondary “top up” button when this document needs nothing', () => {
  const html = card({ document: done });
  const text = visible(html);
  assert.match(text, /软件架构」有 404 页/);
  assert.doesNotMatch(text, /422/);
  assert.match(text, /这门课共 588 页（含 7 份资料）：其中 4 页还没建索引，来自《第三章 讲义》（3 页）、《复习笔记》（1 页）；584 页已经建好/);
  assert.match(text, /这份资料自己的 404 页已经全部建好/);
  assert.match(html, /sh-btn--secondary[^>]*>(?:<svg.*?<\/svg>)?为这门课补建 4 页索引/);
  assert.doesNotMatch(html, /sh-btn--primary[^>]*>(?:<svg.*?<\/svg>)?为这门课/, 'the card’s loudest button is not about a document that needs nothing');
});

test('the card: when this document is the one with missing pages the button stays primary and generic', () => {
  const html = card({ document: own, initialPlan: plan({ toIndex: 304, unchanged: 284, missing: [{ title: '软件架构', pages: 304 }], missingDocuments: 1 }) });
  assert.match(html, /sh-btn--primary[^>]*>(?:<svg.*?<\/svg>)?为这门课建立检索索引/);
  assert.doesNotMatch(visible(html), /这份资料自己的/);
});

test('the card in Settings (no document) keeps the generic primary button and the course line', () => {
  const html = render(h(ExtensionPanel, { call: () => {}, status: running, courses: [COURSE], defaultCourse: COURSE, initialPlan: plan() }));
  assert.match(html, /sh-btn--primary[^>]*>(?:<svg.*?<\/svg>)?为这门课建立检索索引/);
  assert.match(visible(html), /这门课共 588 页/);
});

test('before the plan arrives the course line already holds its room, so the card does not grow under the reader', () => {
  const html = render(h(ExtensionPanel, { call: () => {}, status: running, courses: [COURSE], defaultCourse: COURSE }));
  assert.match(html, /extension-panel__plan extension-panel__plan--waiting" aria-hidden="true"/);
  assert.doesNotMatch(visible(html), /这门课共/);
});

test('hovers: the title, the hint on the page count, the badge, the course line, the button and the restart notice each explain themselves', () => {
  const html = card({ document: done });
  const tips = [...html.matchAll(/role="tooltip"[^>]*>([\s\S]*?)<\/span>\s*(?=<|$)/g)].map(match => match[1].replace(/<[^>]+>/g, ''));
  const joined = tips.join('\n');
  assert.match(joined, /整本书|按章节/, 'why long books are advised by chapter');
  assert.match(joined, /整门课|这门课/, 'what the course scope is');
  assert.match(joined, /不调用 AI|不花 token/, 'what the button costs');
  assert.doesNotMatch(html, /<(?:p|span|small|strong)[^>]*\stitle="/, 'no title= on text');
  const badge = render(h(IndexBadge, { info: { state: 'indexed', indexed: 404, total: 404 }, coverage: { canIndex: true } }));
  assert.match(badge, /role="tooltip"[^>]*>[^]*404 页都已/);
  assert.match(badge, /aria-describedby/);
  assert.doesNotMatch(badge, /\stitle="/);
  assert.match(badge, /tabindex="0"/);
  assert.match(badge, /index-badge__full">索引已建好 · 这份资料 404\/404 页<\/span><span class="index-badge__short">索引已建好 · 404\/404 页</, 'a narrow window shows the counts without the scope word');
});

test('the English card says the same with no Chinese', () => {
  const html = card({ document: done }, 'en');
  const text = visible(html).replace(/Architecting Software Solutions|第三章 讲义|复习笔记|软件架构/g, '');
  assert.match(text, /: 588 pages \(in 7 materials\)/);
  assert.match(text, /: 4 of them are not indexed yet, from “” \(3 pp\.\), “” \(1 pp\.\); 584 are already done\./);
  assert.match(text, /Top up 4 pages of the index for this course/);
  assert.doesNotMatch(text, han);
  assert.doesNotMatch(html.replace(/>[^<]*</g, '><').replace(/Architecting Software Solutions|第三章 讲义|复习笔记|软件架构/g, ''), han);
});

/* ---------- the restart notice ---------- */

test('the “restart DSH” notice goes away once DSH really restarted, and stays while it did not', () => {
  assert.equal(restartDone(undefined, 'b1'), false, 'no record of the update: nothing to compare');
  assert.equal(restartDone('b1', undefined), false, 'a host that reports no boot: the notice stays, as before');
  assert.equal(restartDone('b1', 'b1'), false, 'the same process is still running the old version');
  assert.equal(restartDone('b1', 'b2'), true, 'a new process: the update is in effect');
});

test('the notice says what restarting does, with the hover that indexing keeps working meanwhile', () => {
  const status = { extension: { canInstall: true, installed: true, enabled: true, version: '3.0.1', desktop: false } };
  const html = render(h(ExtensionUpdateNotice, { call: () => {}, status, initialDone: { restart: true, boot: 'b1' } }));
  assert.match(html, /检索扩展已更新/);
  assert.match(html, /这次更新要重启 DSH 之后才会生效/);
  assert.match(html, /role="tooltip"[^>]*>[^<]*(?:建索引|检索)[^<]*照常/);
  const gone = render(h(ExtensionUpdateNotice, { call: () => {}, status: { ...status, boot: 'b2' }, initialDone: { restart: true, boot: 'b1' } }));
  assert.equal(gone, '', 'DSH restarted: the notice has done its work');
  const later = render(h(ExtensionUpdateNotice, { call: () => {}, status: { ...status, boot: 'b1' }, initialDone: { restart: true, boot: 'b1' } }));
  assert.match(later, /检索扩展已更新/);
  const noRestart = render(h(ExtensionUpdateNotice, { call: () => {}, status, initialDone: { restart: false } }));
  assert.match(noRestart, /已更新，无需重启/);
});
