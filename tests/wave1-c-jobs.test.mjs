import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// UI wave 1 · WP-C: background job rows (#98, #100) and the .warning-as-error sites (#88) in the files this package owns.
const read = async path => (await readFile(path, 'utf8')).replace(/\r\n/g, '\n');
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export { AudioJobs } from './ui/audio/AudioJobs.jsx'; export { default as GenerationTrace } from './ui/GenerationTrace.jsx'; export { setUiLanguage } from './ui/i18n.js'; export { QuickActionsContext } from './ui/quick-actions.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { AudioJobs, GenerationTrace, setUiLanguage, QuickActionsContext } = module.exports;
const h = React.createElement;

const job = (extra = {}) => ({ type: 'audio-import', id: 'j', status: 'running', filename: 'lecture.mp3', phase: 'transcribe', done: 0, total: 3, minutes: 12,
  startedAt: new Date(Date.now() - 5000).toISOString(), steps: { transcribe: { done: 1, total: 3 } }, warnings: [], ...extra });
const render = (jobs, props = {}) => renderToStaticMarkup(h(AudioJobs, { data: { jobs }, busy: false, act() {}, ...props }));

test('audio jobs are JobRows: no live row, no text glyphs, a named progressbar', () => {
  setUiLanguage('zh');
  const out = render([job(), job({ id: 'f', status: 'failed', stage: '转写服务没有响应', retryable: true }), job({ id: 'c', status: 'complete', phase: 'done', sourceIds: ['s1'], finishedAt: new Date().toISOString() })]);
  assert.equal((out.match(/<article class="sh-job /g) || []).length, 3);
  for (const row of out.match(/<article[^>]*>/g)) assert.doesNotMatch(row, /role=|aria-live/, 'a row is never a live region');
  assert.match(out, /sh-job--running/);
  assert.match(out, /sh-job--failed/);
  assert.match(out, /sh-job--complete[^>]*data-tone="success"/, 'a finished job is jade, not cinnabar');
  assert.doesNotMatch(out, /[◌✓×]/);
  const bar = out.match(/<div class="sh-progress[^>]*>/)[0];
  assert.match(bar, /role="progressbar"/);
  assert.match(bar, /aria-label="[^"]*lecture\.mp3[^"]*"/, 'the bar says which file it is about');
  assert.doesNotMatch(out, /audio-bar/);
  assert.match(out, /sh-inline--error[\s\S]*转写服务没有响应/, 'the failure is an error message');
  assert.match(out, /<span class="sh-visually-hidden" role="status"><\/span>/);
  assert.match(out, /<small class="sh-job__meta" aria-live="off">/, 'the elapsed time is not announced');
});

test('audio job actions keep their meaning: stop while running, resume after a failure, 知道了 once finished', () => {
  setUiLanguage('zh');
  const out = render([job(), job({ id: 'f', status: 'failed', stage: 'boom', retryable: true })], { busy: true });
  assert.match(out, /停止（已转写的部分会保留）/);
  assert.match(out, /接着做（不重复付费）/);
  const dismissals = out.match(/<button[^>]*class="[^"]*sh-job__dismiss[^"]*"[^>]*>/g) || [];
  assert.equal(dismissals.length, 1, 'only the finished job can be dismissed');
  assert.doesNotMatch(dismissals[0], /disabled/, 'dismissing is never blocked by another action');
  const leaving = render([job({ id: 'f', status: 'failed', stage: 'boom', leaving: true })]);
  assert.match(leaving, /class="sh-job sh-job--failed is-leaving"[^>]*aria-hidden="true"/);
});

test('a dismiss failure appears inside the row as an error message', () => {
  const quick = { failures: { j: '磁盘忙' }, run() {}, clearFailure() {} };
  const out = renderToStaticMarkup(h(QuickActionsContext.Provider, { value: quick }, h(AudioJobs, { data: { jobs: [job({ status: 'complete', phase: 'done' })] }, busy: false, act() {} })));
  assert.match(out, /sh-inline--error[\s\S]*磁盘忙/);
  assert.doesNotMatch(out, /job-error/);
});

test('the English audio rows keep their words', () => {
  setUiLanguage('en');
  try {
    const out = render([job(), job({ id: 'f', status: 'failed', stage: 'boom', retryable: true })]).replace(/lecture\.mp3|boom/g, '');
    assert.doesNotMatch(out, /[㐀-鿿]/);
    assert.match(out, /Stop \(finished transcription is kept\)/);
  } finally { setUiLanguage('zh'); }
});

test('a collapsed generation trace does not keep a clock running', async () => {
  setUiLanguage('zh');
  const source = await read('ui/GenerationTrace.jsx');
  assert.match(source, /useNow\(\s*1000\s*,\s*\{\s*enabled:/, 'the shared clock, enabled only while open and active');
  assert.doesNotMatch(source, /setInterval/);
  const out = renderToStaticMarkup(h(GenerationTrace, { job: { status: 'running', steps: [{ id: 'a', stage: 'x', status: 'running', startedAt: new Date().toISOString() }] } }));
  assert.match(out, /<details class="generation-trace">/);
  const audio = await read('ui/audio/AudioJobs.jsx');
  assert.match(audio, /useNow\(/);
  assert.doesNotMatch(audio, /setInterval/);
});

test('this package leaves no .warning class, text status glyph or private progress bar behind', async () => {
  for (const file of ['ui/AudioImport.jsx', 'ui/audio/AudioJobs.jsx', 'ui/Ingest.jsx', 'ui/CitationDisclosure.jsx', 'ui/ExplanationFollowup.jsx', 'ui/document-preview/links/SaveAnswerAsCard.jsx']) {
    const source = await read(file);
    assert.doesNotMatch(source, /className="warning"/, `${file} uses InlineMessage or Hint, not .warning`);
    assert.doesNotMatch(source, /className="job-error"/, `${file}`);
  }
  const audio = await read('ui/audio/AudioJobs.jsx');
  assert.doesNotMatch(audio, /["'`](?:◌|✓|×|!)["'` ]/, 'no text glyph as a status mark');
  assert.doesNotMatch(audio, /audio-bar/);
});
