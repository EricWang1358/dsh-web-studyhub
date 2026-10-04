import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// O-3 / O-4 / P19–P21 / P05: one add-material entry. The course comes first,
// one drop zone takes documents, JSON decks and subtitles in one go and routes
// each file by type, every file shows its own status, failures say why in
// plain words, and file drops anywhere in the dialog never reach DSH's chat.
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export * from './ui/ImportHub.jsx'; export { default } from './ui/ImportHub.jsx'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { default: ImportHub, routeImportFile, importAccept, looksLikeSubtitleJson, runImport, importSummary,
  importDoneMessage, plainImportError, hubDropHandler, setUiLanguage } = module.exports;
const han = /[㐀-鿿]/;
const SHA = '9'.repeat(64);
const data = { root: 'lib', sources: [], decks: [], drafts: [], focus: { course: '操作系统', courses: [{ name: '操作系统' }, { name: 'Databases' }] },
  contexts: undefined };
const render = props => renderToStaticMarkup(React.createElement(ImportHub, { data, call: async () => ({}), course: '操作系统', onCourseChange() {}, ...props }));
const deckJson = JSON.stringify({ title: '期中复习', cards: [{ kind: 'flashcard', prompt: 'Q', answer: 'A' }] });
const bilibili = JSON.stringify({ body: [{ from: 0, to: 2.5, content: '大家好' }, { from: 2.5, to: 4, content: '今天讲分页' }] });

test('files are routed by type; audio and subtitles only when the audio component is on', () => {
  for (const name of ['a.pdf', 'b.MD', 'c.markdown', 'd.html', 'e.htm', 'f.txt']) assert.equal(routeImportFile({ name }, { audio: true }), 'document', name);
  assert.equal(routeImportFile({ name: 'deck.json' }, { audio: true }), 'deck');
  assert.equal(routeImportFile({ name: 'lecture.srt' }, { audio: true }), 'subtitle');
  assert.equal(routeImportFile({ name: 'lecture.vtt' }, { audio: true }), 'subtitle');
  assert.equal(routeImportFile({ name: 'lecture.srt' }, { audio: false }), null);
  assert.equal(routeImportFile({ name: 'talk.mp3' }, { audio: true }), 'audio');
  assert.equal(routeImportFile({ name: 'talk.mp3' }, { audio: false }), null);
  assert.equal(routeImportFile({ name: 'virus.exe' }, { audio: true }), null);
  const withAudio = importAccept({ audio: true }), plain = importAccept({ audio: false });
  for (const extension of ['.pdf', '.md', '.markdown', '.html', '.htm', '.txt', '.json']) assert.ok(plain.includes(extension), extension);
  assert.ok(withAudio.includes('.srt') && withAudio.includes('.vtt') && withAudio.includes('.mp3'));
  assert.ok(!plain.includes('.srt') && !plain.includes('.mp3'));
  assert.equal(plain.filter(extension => extension === '.txt').length, 1, '.txt has exactly one entry point');
});

test('Bilibili subtitle JSON is told apart from a JSON deck', () => {
  assert.equal(looksLikeSubtitleJson(bilibili), true);
  assert.equal(looksLikeSubtitleJson(JSON.stringify(JSON.parse(bilibili).body)), true);
  assert.equal(looksLikeSubtitleJson(deckJson), false);
  assert.equal(looksLikeSubtitleJson('not json'), false);
});

test('one batch imports documents, decks and subtitles, each with its own status and plain reasons', async () => {
  setUiLanguage('zh');
  const calls = [];
  const call = async (action, args) => {
    calls.push([action, args]);
    if (action === 'materials.document.import') {
      if (args.filename === 'huge.pdf') throw new Error('Document exceeds 8 MB');
      if (args.filename === 'scan.pdf') return { documentId: 'document-s-pdf', sourceIds: [], skippedPages: [1, 2], selectedPages: [1, 2], document: { title: 'scan.pdf', format: 'pdf' } };
      if (args.filename === 'lecture.pdf') return { documentId: `document-${SHA}-pdf`, sourceIds: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'], selectedPages: [1, 2, 3, 4, 5, 6, 7], skippedPages: [7],
        document: { title: 'lecture.pdf', format: 'pdf' } };
      return { documentId: 'document-m-md', sourceIds: ['m1'], document: { title: args.filename, format: 'md' } };
    }
    if (action === 'draft.import.propose') return { title: '期中复习', course: 'Elsewhere', originalTitle: '期中复习', method: 'rules' };
    if (action === 'draft.import') return { id: 'draft-1', title: args.title, course: args.course, cards: [{}, {}] };
    if (action === 'audio.subtitles.import') return { id: 'job-1', status: 'running' };
    throw new Error(`unexpected ${action}`);
  };
  const updates = [];
  const files = [new File(['%PDF-1.7'], 'lecture.pdf'), new File(['# x'], 'notes.md'), new File([deckJson], 'deck.json'),
    new File(['1\n00:00:01,000 --> 00:00:02,000\n你好'], 'talk.srt'), new File(['%PDF'], 'huge.pdf'), new File(['%PDF'], 'scan.pdf'), new File(['ID3'], 'talk.mp3')];
  const results = await runImport(files, { call, courses: ['操作系统'], audio: true, onUpdate: (index, patch) => updates.push([index, patch.status]) });
  assert.deepEqual(results.map(result => result.status), ['done', 'done', 'done', 'done', 'error', 'error', 'error']);
  const documentCalls = calls.filter(([action]) => action === 'materials.document.import');
  assert.deepEqual(documentCalls.map(([, args]) => args.filename), ['lecture.pdf', 'notes.md', 'huge.pdf', 'scan.pdf']);
  assert.deepEqual(documentCalls[0][1].courses, ['操作系统']);
  assert.equal(documentCalls[0][1].dataBase64, Buffer.from('%PDF-1.7').toString('base64'));
  const draft = calls.find(([action]) => action === 'draft.import')[1];
  assert.equal(draft.course, '操作系统', 'the course chosen first applies to decks too');
  assert.equal(draft.text, deckJson);
  assert.deepEqual(calls.find(([action]) => action === 'audio.subtitles.import')[1].courses, ['操作系统']);
  assert.ok(!calls.some(([, args]) => args?.filename === 'talk.mp3'), 'audio is never sent to the document importer');
  assert.deepEqual(updates.filter(([index]) => index === 0).map(([, status]) => status), ['working', 'done'], 'each file shows working, then its result');
  assert.equal(results[0].result.pages, 6);
  assert.deepEqual(results[0].result.skippedPages, [7]);
  assert.match(results[4].error, /8 MB/);
  assert.doesNotMatch(results[4].error, /Document exceeds/);
  assert.match(results[5].error, /OCR|扫描/);
  assert.match(results[6].error, /音频/);
  for (const result of results.filter(item => item.status === 'error')) assert.match(result.error, han);
  assert.deepEqual(results.filter(item => item.status === 'error').map(item => item.permanent), [true, true, true],
    'a file that is too large, has no text or is audio will fail again: offer removal, not retry');
  const flaky = await runImport([new File(['# x'], 'notes.md')], { call: async () => { throw new Error('连接中断'); } });
  assert.equal(flaky[0].permanent, false, 'a dropped connection is worth a retry');
  assert.equal(flaky[0].error, '连接中断');
  const summary = importSummary(results);
  assert.equal(summary.done, 4);
  assert.equal(summary.failed, 3);
  assert.deepEqual(summary.documents.map(item => item.title), ['lecture.pdf', 'notes.md']);
  assert.deepEqual(summary.sourceIds, ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'm1']);
  assert.equal(summary.decks[0].id, 'draft-1');
  assert.equal(summary.subtitles.length, 1);
});

test('a subtitle JSON dropped with the decks goes to the subtitle path', async () => {
  const calls = [];
  const results = await runImport([new File([bilibili], 'bili.json')], { call: async (action, args) => { calls.push(action); return { id: 'job', args }; }, courses: [], audio: true });
  assert.equal(results[0].status, 'done');
  assert.deepEqual(calls, ['audio.subtitles.import']);
});

test('the success message names the document and its pages, in either language', () => {
  setUiLanguage('zh');
  const one = { documents: [{ title: 'lecture.pdf', format: 'pdf', pages: 6, sourceIds: ['p1'] }], decks: [], subtitles: [], done: 1, failed: 0, sourceIds: ['p1'] };
  assert.equal(importDoneMessage(one), '已导入「lecture.pdf」（6 页）');
  assert.equal(importDoneMessage({ ...one, documents: [{ title: 'notes.md', format: 'md', pages: 1, sourceIds: ['m'] }] }), '已导入「notes.md」');
  const many = { ...one, documents: [one.documents[0], { title: 'notes.md', format: 'md', pages: 1 }], decks: [{ title: '期中复习', cards: [{}, {}] }], subtitles: [{ name: 'talk.srt' }] };
  assert.match(importDoneMessage(many), /已导入 2 份资料/);
  assert.match(importDoneMessage(many), /题组/);
  assert.match(importDoneMessage(many), /字幕/);
  setUiLanguage('en');
  try {
    assert.equal(importDoneMessage(one), 'Imported “lecture.pdf” (6 pages)');
    assert.doesNotMatch(importDoneMessage(many).replace('期中复习', ''), han, 'only the deck title (user content) stays Chinese');
  } finally { setUiLanguage('zh'); }
});

test('import errors are rewritten in plain language and keep unknown details', () => {
  setUiLanguage('zh');
  assert.match(plainImportError(new Error('Text documents must use UTF-8 encoding')), /UTF-8/);
  assert.match(plainImportError(new Error('Text documents must use UTF-8 encoding')), han);
  assert.match(plainImportError(new Error('文件不是有效 PDF，或超过 8 MB')), /PDF/);
  assert.match(plainImportError(new Error('PDF 超过 200 页，请先按章节拆分')), /200/);
  assert.equal(plainImportError(new Error('网络断开了')), '网络断开了');
});

test('the dialog asks for the course first and offers one drop zone for every file type', () => {
  setUiLanguage('zh');
  const html = render({ audio: React.createElement('div', { className: 'audio-stub' }, 'audio') });
  const course = html.indexOf('这些资料属于哪门课'), drop = html.indexOf('data-tour="import-drop"');
  assert.ok(course >= 0 && drop > course, 'the course field sits above the controls it affects');
  assert.match(html, /value="操作系统"/);
  const ordinaryInputs = [...html.matchAll(/<input[^>]*type="file"[^>]*>/g)].map(match => match[0]).filter(input => /accept="[^"]*\.pdf/.test(input));
  assert.equal(ordinaryInputs.length, 1, 'one shared file input for documents, decks and subtitles; external converters have separate result pickers');
  assert.match(ordinaryInputs[0], /accept="[^"]*\.pdf[^"]*\.json[^"]*\.srt/);
  assert.match(ordinaryInputs[0], /multiple/);
  assert.match(html, /aria-pressed="true"[^>]*>(?:<svg[\s\S]*?<\/svg>)?文件/);
  assert.match(html, /粘贴文本/);
  assert.match(html, /音频/);
  assert.doesNotMatch(html, /audio-stub/, 'audio is a secondary tab, not shown by default');
  assert.doesNotMatch(html, /导入 Markdown \/ 文本/);
  assert.doesNotMatch(render({}), /aria-pressed="false"[^>]*>(?:<svg[\s\S]*?<\/svg>)?音频/, 'no audio tab without the audio component');
});

test('the paste tab keeps the existing source.add form', () => {
  setUiLanguage('zh');
  const html = render({ initialTab: 'paste' });
  assert.match(html, /资料名称/);
  assert.match(html, /原文/);
  assert.match(html, /保存资料/);
  assert.doesNotMatch(html, /type="file"/);
});

test('the dialog reads in English without Chinese application copy', () => {
  setUiLanguage('en');
  try {
    const strip = html => html.replace(/<[^>]+>/g, ' ').replace(/操作系统/g, '');
    assert.doesNotMatch(strip(render({ audio: React.createElement('div') })), han);
    assert.doesNotMatch(strip(render({ initialTab: 'paste' })), han);
  } finally { setUiLanguage('zh'); }
});

function dragEvent(type, { files = true, target = {} } = {}) {
  return { type, target, defaultPrevented: false, propagationStopped: false,
    dataTransfer: { types: files ? ['Files'] : ['text/plain'], dropEffect: 'copy' },
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; } };
}

test('a file dropped in the hub outside a drop zone is swallowed with a hint and never reaches the host', () => {
  // The dialog around the hub guards its own header and margins (Dialog guardDrops, tests/wp-b-overlays-browser.test.mjs).
  // Inside the hub: an inner zone that already took the file only loses propagation.
  const handled = [];
  const handler = hubDropHandler(type => handled.push(type));
  const zoneDrop = { ...dragEvent('drop'), isDefaultPrevented: () => true };
  handler(zoneDrop);
  assert.ok(zoneDrop.propagationStopped);
  assert.deepEqual(handled, []);
  const strayDrop = { ...dragEvent('drop'), isDefaultPrevented() { return this.defaultPrevented; } };
  handler(strayDrop);
  assert.ok(strayDrop.defaultPrevented && strayDrop.propagationStopped);
  assert.deepEqual(handled, ['drop']);
});
