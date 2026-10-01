import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// WP22: Word and PowerPoint in the one import hub. .docx/.pptx are documents
// with their own (larger) size limit, old Office formats get a friendly
// per-file message instead of a generic failure, and the picker lists the
// document types first.
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export * from './ui/ImportHub.jsx'; export { default } from './ui/ImportHub.jsx'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { default: ImportHub, routeImportFile, importAccept, runImport, importSummary, importDoneMessage, plainImportError, isPermanentImportError,
  MAX_DOCUMENT_BYTES, MAX_OFFICE_BYTES, documentLimit, setUiLanguage } = module.exports;
const MB = 1024 * 1024;
const han = /[㐀-鿿]/;
const data = { root: 'lib', sources: [], decks: [], drafts: [], focus: { course: '操作系统', courses: [{ name: '操作系统' }] } };
const render = props => renderToStaticMarkup(React.createElement(ImportHub, { data, call: async () => ({}), course: '操作系统', onCourseChange() {}, ...props }));
const fake = (name, size, bytes = [1, 2, 3]) => ({ name, size, arrayBuffer: async () => new Uint8Array(bytes).buffer, text: async () => '' });

test('Word and PowerPoint files are documents; old Office formats are recognised as legacy', () => {
  for (const audio of [true, false]) {
    for (const name of ['a.docx', 'B.DOCX', 'slides.pptx', 'Week 3.PPTX']) assert.equal(routeImportFile({ name }, { audio }), 'document', name);
    for (const name of ['old.doc', 'old.ppt', 'wps.wps', 'talk.key', 'notes.pages', 'OLD.DOC']) assert.equal(routeImportFile({ name }, { audio }), 'legacy', name);
  }
  assert.equal(routeImportFile({ name: 'a.pdf' }), 'document');
  assert.equal(routeImportFile({ name: 'x.exe' }), null);
});

test('the picker lists documents first: .docx and .pptx right after .pdf, audio last', () => {
  const accept = importAccept({ audio: true });
  assert.deepEqual(accept.slice(0, 3), ['.pdf', '.docx', '.pptx']);
  for (const extension of ['.doc', '.ppt', '.wps', '.key', '.pages']) assert.ok(accept.includes(extension), extension);
  assert.equal(new Set(accept).size, accept.length, 'no extension is listed twice');
  const lastDocument = Math.max(...['.pdf', '.docx', '.pptx', '.md', '.markdown', '.html', '.htm', '.txt', '.json', '.doc', '.ppt'].map(extension => accept.indexOf(extension)));
  const firstOther = Math.min(...['.srt', '.vtt', '.mp3', '.wav', '.m4a'].map(extension => accept.indexOf(extension)));
  assert.ok(lastDocument < firstOther, 'subtitle and audio extensions come after every document extension');
  const plain = importAccept({ audio: false });
  assert.deepEqual(plain.slice(0, 3), ['.pdf', '.docx', '.pptx']);
  assert.ok(!plain.includes('.mp3') && !plain.includes('.srt'));
});

test('the drop zone hint names the new formats and one limit per format, in both languages', () => {
  setUiLanguage('zh');
  const zh = render({ audio: React.createElement('div') });
  assert.match(zh, /PDF · Word · PowerPoint · Markdown/);
  assert.match(zh, /PDF 与文本最大 8 MB，Word \/ PPT 最大 40 MB/);
  assert.match(zh, /accept="\.pdf,\.docx,\.pptx,/);
  setUiLanguage('en');
  try {
    const en = render({ audio: React.createElement('div') }).replace(/<[^>]+>/g, ' ');
    assert.match(en, /Word · PowerPoint/);
    assert.match(en, /PDF and text up to 8 MB, Word \/ PPT up to 40 MB/);
    assert.doesNotMatch(en.replace(/操作系统/g, ''), han);
  } finally { setUiLanguage('zh'); }
});

test('legacy Office files get a specific message and are never sent to the server', async () => {
  setUiLanguage('zh');
  let calls = 0;
  const results = await runImport([fake('old.doc', 10), fake('old.ppt', 10), fake('x.wps', 10), fake('t.key', 10), fake('n.pages', 10)], { call: async () => { calls++; return {}; }, audio: true });
  assert.equal(calls, 0);
  assert.deepEqual(results.map(result => result.status), ['error', 'error', 'error', 'error', 'error']);
  assert.equal(results[0].error, '暂不支持旧版 .doc，请在 Word 里另存为 .docx 或 PDF 后再导入。');
  assert.equal(results[1].error, '暂不支持旧版 .ppt，请在 PowerPoint 里另存为 .pptx 或 PDF 后再导入。');
  assert.match(results[2].error, /\.wps.*\.docx/);
  assert.match(results[3].error, /Keynote.*PowerPoint|PDF/);
  assert.match(results[4].error, /Pages.*Word|PDF/);
  assert.ok(results.every(result => result.permanent === true), 'removal, not retry');
  setUiLanguage('en');
  try {
    const english = await runImport([fake('old.doc', 10), fake('old.ppt', 10)], { call: async () => ({}) });
    assert.equal(english[0].error, 'Old-format .doc files aren’t supported. In Word, save as .docx or PDF, then import it.');
    assert.equal(english[1].error, 'Old-format .ppt files aren’t supported. In PowerPoint, save as .pptx or PDF, then import it.');
    for (const result of english) assert.doesNotMatch(result.error, han);
  } finally { setUiLanguage('zh'); }
});

test('size limits depend on the format and share one constant per format', async () => {
  setUiLanguage('zh');
  assert.equal(MAX_DOCUMENT_BYTES, 8 * MB);
  assert.equal(MAX_OFFICE_BYTES, 40 * MB);
  assert.equal(documentLimit('a.pdf'), 8 * MB);
  assert.equal(documentLimit('a.md'), 8 * MB);
  assert.equal(documentLimit('a.DOCX'), 40 * MB);
  assert.equal(documentLimit('a.pptx'), 40 * MB);
  const sent = [];
  const call = async (action, args) => { sent.push(args.filename); return { sourceIds: ['s1'], document: { title: args.filename, format: args.filename.endsWith('x') ? args.filename.slice(-4) : 'pdf' } }; };
  const results = await runImport([fake('ok.docx', 30 * MB), fake('ok.pptx', 40 * MB), fake('big.docx', 41 * MB), fake('big.pptx', 80 * MB),
    fake('big.pdf', 9 * MB), fake('ok.pdf', 8 * MB), fake('big.txt', 9 * MB)], { call });
  assert.deepEqual(results.map(result => result.status), ['done', 'done', 'error', 'error', 'error', 'done', 'error']);
  assert.deepEqual(sent, ['ok.docx', 'ok.pptx', 'ok.pdf']);
  assert.match(results[2].error, /40 MB/);
  assert.match(results[3].error, /40 MB/);
  assert.match(results[4].error, /8 MB/);
  assert.doesNotMatch(results[4].error, /40/);
  assert.ok(results.filter(result => result.status === 'error').every(result => result.permanent));
});

test('server errors about Office files are explained in plain words', () => {
  setUiLanguage('zh');
  for (const [message, pattern] of [
    ['Office file is damaged or not a valid DOCX file', /Word.*损坏|读不出来/],
    ['Office file is damaged or not a valid PPTX file', /PowerPoint.*损坏|读不出来/],
    ['Office file is password-protected or in an old format', /密码|旧版/],
    ['Office file is too large when unpacked', /展开|解压|太大|过大/],
    ['Document must be a file of at most 40 MB', /40 MB/],
    ['Document exceeds 40 MB', /40 MB/],
  ]) {
    const plain = plainImportError(new Error(message));
    assert.match(plain, han, message);
    assert.match(plain, pattern, message);
    assert.equal(isPermanentImportError(new Error(message)), true, message);
  }
  assert.doesNotMatch(plainImportError(new Error('Document must be a file of at most 40 MB')), /\b8 MB/);
  assert.match(plainImportError(new Error('Supported document formats: PDF, Word, PowerPoint, Markdown, HTML, TXT')), /Word/);
});

test('Office imports report slides and skipped slides like PDF pages', async () => {
  setUiLanguage('zh');
  const call = async (action, args) => args.filename === 'imgs.pptx'
    ? { sourceIds: [], skippedPages: [1, 2], document: { title: 'imgs.pptx', format: 'pptx' } }
    : args.filename === 'empty.docx' ? { sourceIds: [], document: { title: 'empty.docx', format: 'docx' } }
      : args.filename === 'deck.pptx' ? { documentId: 'document-x-pptx', sourceIds: ['a', 'b', 'c'], skippedPages: [4], document: { title: 'OS Lecture 5', format: 'pptx' } }
        : { documentId: 'document-y-docx', sourceIds: ['w'], document: { title: 'Notes', format: 'docx' } };
  const results = await runImport([fake('deck.pptx', 5), fake('notes.docx', 5), fake('imgs.pptx', 5), fake('empty.docx', 5)], { call });
  assert.deepEqual(results.map(result => result.status), ['done', 'done', 'error', 'error']);
  assert.equal(results[0].result.format, 'pptx');
  assert.equal(results[0].result.pages, 3);
  assert.deepEqual(results[0].result.skippedPages, [4]);
  assert.equal(results[1].result.format, 'docx');
  assert.match(results[2].error, /幻灯片|图片/);
  assert.match(results[3].error, /没有可用的文字/);
  assert.doesNotMatch(results[3].error, /OCR/);
  const summary = importSummary(results);
  assert.equal(importDoneMessage({ ...summary, documents: [summary.documents[0]] }), '已导入「OS Lecture 5」（3 页）');
  assert.equal(importDoneMessage({ ...summary, documents: [summary.documents[1]] }), '已导入「Notes」');
  setUiLanguage('en');
  try { assert.equal(importDoneMessage({ ...summary, documents: [summary.documents[0]] }), 'Imported “OS Lecture 5” (3 pages)'); }
  finally { setUiLanguage('zh'); }
});
