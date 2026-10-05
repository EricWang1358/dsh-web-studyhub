import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/* The audio task card (WP-AU): effective parallelism (#212), and below the history, the sub-agent links (#211, #214). */

const compiled = await build({
  stdin: { contents: `export { AudioJobs, parallelNote } from './ui/audio/AudioJobs.jsx'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.json': 'json', '.css': 'text' },
});
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { AudioJobs, parallelNote, setUiLanguage } = module.exports;
const HAN = /[㐀-鿿]/;
const inLanguage = (language, run) => { try { setUiLanguage(language); return run(); } finally { setUiLanguage('zh'); } };
const noop = () => {};
const render = (job, props = {}) => renderToStaticMarkup(React.createElement(AudioJobs, { data: { jobs: [job] }, busy: false, act: noop, ...props }));
const running = (extra = {}) => ({ id: 'j1', type: 'audio-import', filename: 'lecture.mp3', status: 'running', phase: 'proofread', done: 2, total: 6,
  steps: { transcribe: { done: 1, total: 1 }, proofread: { done: 2, total: 6 } }, warnings: [], startedAt: new Date().toISOString(), ...extra });

test('the card says how many windows run at once, and when a rate limit lowered it', () => {
  assert.equal(parallelNote({ limit: 3, effective: 3, lowest: 3 }), '并行 3');
  assert.equal(parallelNote({ limit: 6, effective: 4, lowest: 4 }), '并行 4（已因限流从 6 降到 4）');
  assert.equal(parallelNote({ limit: 6, effective: 6, lowest: 3 }), '并行 6（曾因限流降到 3，已恢复）');
  assert.equal(parallelNote(null), '');
  assert.match(render(running({ parallel: { text: { limit: 6, effective: 4, lowest: 4 } } })), /并行 4（已因限流从 6 降到 4）/);
  assert.doesNotMatch(render(running({ phase: 'transcribe', parallel: { text: { limit: 6, effective: 4, lowest: 4 } } })), /并行 4/, 'only while the text steps run');
  inLanguage('en', () => {
    const page = render(running({ parallel: { text: { limit: 6, effective: 4, lowest: 4 } } }));
    assert.match(page, /4 in parallel \(lowered from 6 because of rate limits\)/);
    assert.doesNotMatch(page, HAN);
  });
});
