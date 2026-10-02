import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

// O-3 / P19: after an import the dialog closes, a success toast offers the
// next step and the new material is highlighted in 资料 — unless the learner
// came from 创建题组, where the new material is ticked in place.
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export { importOutcome } from './ui/ImportHub.jsx'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { importOutcome, setUiLanguage } = module.exports;
const pdf = { title: 'lecture.pdf', format: 'pdf', pages: 6, sourceIds: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'] };
const summary = (extra = {}) => ({ done: 1, failed: 0, documents: [pdf], decks: [], subtitles: [], sourceIds: pdf.sourceIds, ...extra });

test('documents take the learner to 资料 with the new item highlighted and a 用它出题 toast', () => {
  setUiLanguage('zh');
  const outcome = importOutcome(summary(), { page: 'library' });
  assert.equal(outcome.page, 'sources');
  assert.deepEqual(outcome.highlight, pdf.sourceIds);
  assert.deepEqual(outcome.select, pdf.sourceIds);
  assert.equal(outcome.notice.tone, 'success');
  assert.equal(outcome.notice.text, '已导入「lecture.pdf」（6 页）');
  assert.equal(outcome.notice.action, 'generate');
});

test('from 创建题组 the new material is ticked in place instead', () => {
  setUiLanguage('zh');
  const outcome = importOutcome(summary(), { page: 'generate' });
  assert.equal(outcome.page, undefined);
  assert.equal(outcome.highlight, undefined);
  assert.deepEqual(outcome.select, pdf.sourceIds);
  assert.match(outcome.notice.text, /已勾选/);
});

test('a single JSON deck opens its draft; subtitles land in 资料', () => {
  setUiLanguage('zh');
  const deck = { id: 'd1', title: '期中复习', cards: [{}, {}, {}] };
  const draft = importOutcome(summary({ documents: [], sourceIds: [], decks: [deck] }), { page: 'sources' });
  assert.equal(draft.openDraft, deck);
  assert.match(draft.notice.text, /期中复习/);
  const many = importOutcome(summary({ documents: [], sourceIds: [], decks: [deck, { ...deck, id: 'd2' }] }), { page: 'sources' });
  assert.equal(many.page, 'library');
  const subtitles = importOutcome(summary({ documents: [], sourceIds: [], subtitles: [{ name: 'talk.srt' }] }), { page: 'library' });
  assert.equal(subtitles.page, 'sources');
  assert.match(subtitles.notice.text, /字幕/);
  assert.equal(importOutcome(summary({ done: 0, documents: [], sourceIds: [] }), { page: 'library' }), null);
});

test('App wires the hub into the dialog and the empty state, and counts documents', async () => {
  const source = await readFile(new URL('../ui/App.jsx', import.meta.url), 'utf8');
  assert.match(source, /const sourceForm = [\s\S]{0,400}<ImportHub/);
  assert.doesNotMatch(source, /导入 Markdown \/ 文本/, 'the third text input is gone');
  assert.doesNotMatch(source, /<DocumentImport /);
  assert.match(source, /hint=\{[^}]*countDocuments\(data\.sources\)/, 'the 资料 row shows its document count as its trailing hint');
  assert.match(source, /highlight=\{sourceHighlight\}/);
  assert.match(source, /onComplete=\{finishImport\}/);
  assert.match(source, /documentSourceIds\(data\.sources, modal\.source\.id\)/, 'the source dialog generates from the whole document');
});
