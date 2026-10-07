/* The quiet line in 模型用量 about quick requests that waited for the shared provider quota (S6-5a): shown only when something waited, in both languages, from the optional
   in-memory `instant` block of `usage.summary` (a missing block is zero). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const compiled = await build({ stdin: { contents: `
  export { ModelUsageView, instantWait } from './ui/TokenUsage.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { ModelUsageView, instantWait, setUiLanguage } = module.exports;
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const base = { days: 30, byFeature: { coach: { uncachedInputTokens: 900, outputTokens: 250, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 5 } },
  total: { uncachedInputTokens: 900, outputTokens: 250, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 5 }, daily: [] };
const view = summary => renderToStaticMarkup(React.createElement(ModelUsageView, { state: { status: 'ready', summary }, days: 30, onDays() {}, onAudio() {} }));

test.afterEach(() => setUiLanguage('zh'));

test('the line is absent when nothing waited, whether the block is missing, zero or only cooled', () => {
  for (const summary of [base, { ...base, instant: { calls: 4, waitedCalls: 0, waitedMs: 0, cooldowns: 0 } }, { ...base, instant: {} }]) {
    assert.equal(instantWait(summary), '');
    assert.doesNotMatch(view(summary), /data-instant-wait/);
  }
});

test('the line is present, with the count and the time, when something waited; the same words in zh and en', () => {
  const summary = { ...base, instant: { calls: 9, waitedCalls: 3, waitedMs: 4200, cooldowns: 1 } };
  setUiLanguage('zh');
  const zh = view(summary);
  assert.match(zh, /data-instant-wait/);
  assert.match(text(zh), /有 3 次因共享额度排队，共等待 4 秒；重启后清零/);
  setUiLanguage('en');
  const en = view(summary);
  assert.match(en, /data-instant-wait/);
  assert.match(text(en), /waited 3 times for the shared quota, 4 sec in all; this resets on restart/);
  assert.doesNotMatch(text(en), /[㐀-鿿]/, 'no Chinese is left in the English line');
});
