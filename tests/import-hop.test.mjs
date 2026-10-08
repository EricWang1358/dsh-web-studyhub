import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/* Importing material in fewer steps (import-hop): the course is one line with its reason; a PDF with no text and a PDF over 8 MB lead into the converter
   with the file staged; the converters are folded and chosen once; recordings and subtitles go to the audio form; the first import hands the file on to
   创建题组. Pure behaviour and markup here; the whole flow in a browser is tests/import-hop-browser.test.mjs. */

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export * from './ui/ImportHub.jsx'; export { default as ImportHub } from './ui/ImportHub.jsx';
  export { importHandoff, importForQuestions } from './ui/app/import-handoff.js';
  export { default as PdfConversion } from './ui/PdfConversion.jsx';
  export { default as JobFollowUp } from './ui/JobFollowUp.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text', '.json': 'json' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { ImportHub, runImport, importSummary, importDoneMessage, importOutcome, importHandoff, importForQuestions, PdfConversion, JobFollowUp, setUiLanguage } = module.exports;
const h = React.createElement;
const han = /[㐀-鿿]/;
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const known = [{ name: '操作系统', aliases: ['OS'] }, { name: 'CS2105', aliases: ['Networks'] }, { name: 'CS1101' }];
const data = { root: 'lib', sources: [], decks: [], drafts: [], focus: { course: '操作系统', courses: known } };
const render = (props = {}) => renderToStaticMarkup(h(ImportHub, { data, course: '操作系统', onCourseChange() {}, ...props }));
const pdf = (name, size = 10) => ({ name, size, arrayBuffer: async () => new Uint8Array([37, 80, 68, 70]).buffer, text: async () => '' });
const imported = (sourceIds, format = 'pdf') => ({ documentId: 'd', sourceIds, document: { title: 'x', format } });

/* ---------- which course ---------- */

test('the field wins; a blank field is filled only by a file name that names one course, and the result says it was a guess', async () => {
  const calls = [];
  const call = async (action, args) => { calls.push(args); return imported(['s1', 's2']); };
  const named = await runImport([pdf('CS2105 week 3.pdf')], { call, courses: [], known });
  assert.deepEqual(calls.at(-1).courses, ['CS2105']);
  assert.equal(named[0].result.courseHow, 'file-name');
  assert.deepEqual(named[0].result.courses, ['CS2105']);
  assert.match(importDoneMessage(importSummary(named)), /归入「CS2105」（文件名里有课程名）/);
  await runImport([pdf('CS2105 week 3.pdf')], { call, courses: ['操作系统'], known });
  assert.deepEqual(calls.at(-1).courses, ['操作系统'], 'a course in the field is never overridden by a file name');
  const plain = await runImport([pdf('lecture.pdf')], { call, courses: [], known });
  assert.deepEqual(calls.at(-1).courses, []);
  assert.equal(plain[0].result.courseHow, 'none');
  assert.doesNotMatch(importDoneMessage(importSummary(plain)), /归入/);
  await runImport([pdf('CS2105 and CS1101.pdf')], { call, courses: [], known });
  assert.deepEqual(calls.at(-1).courses, [], 'two courses in one name: no guess');
  setUiLanguage('en');
  try { assert.doesNotMatch(importDoneMessage(importSummary(named)).replace('CS2105', '').replace('x', ''), han); } finally { setUiLanguage('zh'); }
});

test('the course is one line with its reason and a way to change it; the field is behind 更改', () => {
  setUiLanguage('zh');
  const html = render();
  assert.match(text(html), /归入「操作系统」 当前课程 更改/);
  assert.doesNotMatch(html, /<input[^>]*placeholder="留空为未分类"/, 'the field is not on the main path');
  assert.match(text(render({ course: '' })), /未分类 文件名里有课程名时，会按它归入 更改/);
  assert.match(text(render({ course: '', data: { ...data, courses: [], focus: { course: '', courses: [] } } })), /未分类 更改/, 'a first-time learner has no courses to name: nothing is explained');
  assert.match(text(render({ course: 'CS2105; CS1101' })), /归入「CS2105、CS1101」 你选的课程/);
  assert.match(text(render({ course: 'Databases', courseFrom: 'page' })), /沿用当前页面的课程/);
  setUiLanguage('en');
  try {
    const english = text(render());
    assert.match(english, /Filed under &quot;操作系统&quot;/);
    assert.match(english, /Change/);
    assert.doesNotMatch(english.replace(/操作系统/g, ''), han);
  } finally { setUiLanguage('zh'); }
});

/* ---------- a PDF the importer cannot use ---------- */

test('a PDF with no text, when the converters are there, is handed to them: the row says why and the file is staged under it', async () => {
  setUiLanguage('zh');
  const call = async () => ({ documentId: 'd', sourceIds: [], skippedPages: [1, 2], document: { title: 'scan.pdf', format: 'pdf' } });
  const [scan] = await runImport([pdf('scan.pdf')], { call, courses: [], known, convertible: true });
  assert.equal(scan.status, 'error');
  assert.equal(scan.scanned, true);
  assert.match(scan.error, /扫描件/);
  assert.match(scan.error, /不会上传/);
  const [without] = await runImport([pdf('scan.pdf')], { call, courses: [], known, convertible: false });
  assert.equal(without.scanned, undefined, 'without the converters there is nothing to hand it to');
  assert.match(without.error, /OCR/);
  const [slides] = await runImport([{ ...pdf('slides.pptx'), name: 'slides.pptx' }], { call: async () => ({ documentId: 'd', sourceIds: [], document: { format: 'pptx' } }), courses: [], known, convertible: true });
  assert.equal(slides.scanned, undefined, 'the converters read PDF only');
});

test('only a PDF is offered the converter for being too large; a big text file is split by chapter, as its message says', async () => {
  setUiLanguage('zh');
  const tooBig = Object.assign(new Error('Document exceeds 8 MB'), { code: 'document-too-large' });
  const call = async () => { throw tooBig; };
  const [book] = await runImport([pdf('book.pdf', 9 * 1024 * 1024)], { call, courses: [], known });
  assert.equal(book.large, 'pdf-size');
  const [notes] = await runImport([{ ...pdf('notes.md', 9 * 1024 * 1024), name: 'notes.md' }], { call, courses: [], known });
  assert.equal(notes.large, undefined);
  assert.match(notes.error, /按章节拆分/);
});

test('recordings and subtitles are not imported on the Files tab: they wait for the audio form, which shows the estimate', async () => {
  setUiLanguage('zh');
  const calls = [];
  const call = async action => { calls.push(action); return {}; };
  const files = [{ name: 'talk.srt', size: 10, text: async () => '1\n00:00:01,000 --> 00:00:02,000\nhi' }, { name: 'talk.mp3', size: 10 },
    { name: 'bili.json', size: 10, text: async () => JSON.stringify({ body: [{ from: 0, to: 2, content: '大家好' }] }) }];
  const results = await runImport(files, { call, courses: [], known, audio: true });
  assert.deepEqual(calls, [], 'nothing is sent to a model, or anywhere');
  assert.deepEqual(results.map(result => result.status), ['error', 'error', 'error']);
  assert.deepEqual(results.map(result => result.carry), [true, true, true]);
  assert.match(results[0].error, /估算/);
  assert.equal(importSummary(results).subtitles, undefined);
});

/* ---------- the converters are folded and chosen once ---------- */

test('the converter block is a closed fold, not two cards; the tool is chosen in the panel and not on the Files tab', () => {
  setUiLanguage('zh');
  const html = render({ audio: h('div', null, 'audio') });
  assert.match(html, /<details class="sh-disclosure import-hub__conversion"(?![^>]*\bopen\b)/, 'closed');
  assert.match(text(html), /PDF 解析 扫描件、公式多或大文件/);
  assert.doesNotMatch(html, /用 MinerU 解析|用 Marker 解析|安装与使用设置|PDF 解析方案/, 'no per-tool buttons');
  assert.equal((html.match(/<h3>MinerU<\/h3>/g) || []).length, 0);
  assert.match(html, /选择 PDF 解析…/);
  assert.match(html, /type="file"[^>]*accept="\.pdf,application\/pdf"/);
});

test('the panel offers local conversion only: no cloud route, no second choice of how', () => {
  setUiLanguage('zh');
  const html = renderToStaticMarkup(h(PdfConversion, { file: { name: 'Book.pdf', size: 12e6 }, call: async () => ({}), initialSettings: { token: { set: true }, acknowledged: false },
    initialLocal: { state: 'ready', tier: 'basic', estimates: { basic: 1.6 } }, initialPlan: { name: 'Book.pdf', pages: 450, bytes: 12e6, windows: [{ index: 1, startPage: 1, endPage: 50, pages: 50 }] } }));
  assert.doesNotMatch(html, /暂不可用|云端|用哪种方式解析|name="mineru-route"|type="checkbox"/);
  assert.match(html, /开始本地解析/);
  assert.match(html, /约 12 分钟（估算：basic 档每页约 1\.6 秒/, 'the estimate stays: it is the cost the learner is about to accept');
  assert.equal((html.match(/name="[^"]*-converter"/g) || []).length, 2, 'MinerU or Marker, once');
});

test('without the audio component the converter says which component it is, and the materials-off message is not a dead end', () => {
  setUiLanguage('zh');
  const off = { ...data, contexts: ['materials'] };
  const html = text(render({ data: off }));
  assert.match(html, /PDF 解析随音频组件一起提供/);
  assert.doesNotMatch(html, /PDF 解析组件/);
  const panel = text(renderToStaticMarkup(h(PdfConversion, { available: false, call: async () => ({}) })));
  assert.match(panel, /PDF 解析随音频组件一起提供，这个安装没有启用它/);
});

/* ---------- where an import goes ---------- */

test('the first import goes on to 创建题组 with its materials ticked; anything else it made takes the usual way', () => {
  setUiLanguage('zh');
  const calls = [];
  const open = importForQuestions(options => calls.push(options));
  assert.equal(open.type, 'add');
  const handoff = importHandoff(open, { done: 1, sourceIds: ['a', 'b'], documents: [{ title: 'L.pdf', format: 'pdf', pages: 2 }], decks: [] });
  handoff.call(handoff.ids);
  assert.deepEqual(calls, [{ sourceIds: ['a', 'b'], remember: true }]);
  assert.match(handoff.notice.text, /已导入「L\.pdf」（2 页）。已勾选，可以直接生成题组。/);
  assert.equal(importHandoff(open, { done: 1, sourceIds: [], decks: [{ title: 'D', cards: [{}] }] }), null, 'a deck opens as a draft, as always');
  assert.equal(importHandoff(open, { done: 1, sourceIds: [], conversions: [{ name: 'B.pdf', pages: 9, converter: 'mineru' }] }), null, 'a conversion runs in the background and lands on 资料');
  // A caller that wants everything for itself (备考补习) still gets it.
  const other = importHandoff({ type: 'add', onImported() {} }, { done: 1, sourceIds: [], decks: [{ title: 'D', cards: [] }] });
  assert.equal(other.call, undefined);
  assert.equal(importOutcome({ done: 1, sourceIds: ['a'], documents: [], decks: [] }, { page: 'library' }).page, 'sources', 'imports from other pages land as before');
});

/* ---------- a finished conversion ---------- */

test('a finished background import offers 用它出题 under its card; one that is not finished, or saved nothing, does not', () => {
  setUiLanguage('zh');
  const card = h('article', null, 'card');
  const view = (job, onGenerate = () => {}) => renderToStaticMarkup(h(JobFollowUp, { job, sourceIds: job.sourceIds, onGenerate }, card));
  assert.match(view({ status: 'complete', filename: 'Book.pdf', sourceIds: ['a'] }), /用它出题/);
  assert.doesNotMatch(view({ status: 'running', filename: 'Book.pdf', sourceIds: ['a'] }), /用它出题/);
  assert.doesNotMatch(view({ status: 'complete', filename: 'Book.pdf', sourceIds: [] }), /用它出题/);
  const without = renderToStaticMarkup(h(JobFollowUp, { job: { status: 'complete', sourceIds: ['a'] }, sourceIds: ['a'] }, card));
  assert.doesNotMatch(without, /用它出题/, 'a page that cannot make questions does not offer it');
  assert.match(view({ status: 'running', sourceIds: [] }), /<div class="job-follow"><article>card<\/article><\/div>/, 'the card keeps its place when the job ends');
});
