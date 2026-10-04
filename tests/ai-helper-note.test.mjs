/* 2.5.8 · one way of saying why an AI helper did not work: no model (with the model settings), a failed call (with its short error),
   an answer in the wrong format (with the answer to look at). The 帮我想想 line and the 分步生成路径 line are the same component,
   differing only in what the learner is left with. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const compiled = await build({ stdin: { contents: `
  export { default as AiHelperNote, describeAiUnavailable } from './ui/AiHelperNote.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { AiHelperNote, describeAiUnavailable, setUiLanguage } = module.exports;
const han = /[㐀-鿿]/;
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const noop = () => {};
const render = props => renderToStaticMarkup(React.createElement(AiHelperNote, props));
const PATH = '先用按章节做的路径';

test('each reason has its own plain words, and the fallback names what the learner is left with', () => {
  assert.match(describeAiUnavailable({ reason: 'no-model' }, PATH).text, /^还没有可用的 AI 模型。先用按章节做的路径。$/);
  assert.match(describeAiUnavailable({ reason: 'failed', message: 'boom' }, PATH).text, /^AI 调用没有成功：boom。先用按章节做的路径，可以再试一次。$/);
  assert.match(describeAiUnavailable({ reason: 'nothing-usable', sample: '{}' }, PATH).text, /^AI 的回答不是约定的格式，没能用上。先用按章节做的路径，可以再试一次。$/);
  assert.equal(describeAiUnavailable({ reason: 'no-signal' }, PATH), null, 'nothing to explain when there was nothing to ask about');
  assert.equal(describeAiUnavailable(null, PATH), null);
});

test('a known provider error reads in plain words and keeps the raw text to look at', () => {
  const note = describeAiUnavailable({ reason: 'failed', message: '429 Too Many Requests: rate limit' }, PATH);
  assert.match(note.text, /AI 调用没有成功：模型服务太忙了/);
  assert.equal(note.detail, '429 Too Many Requests: rate limit');
  const none = describeAiUnavailable({ reason: 'failed', message: '' }, PATH);
  assert.match(none.text, /没有说明原因/);
});

test('the component shows the answer on request, and only offers what can help', () => {
  const html = render({ unavailable: { reason: 'nothing-usable', sample: '{"note":"x"}' }, fallback: PATH, onRetry: noop });
  assert.match(html, /看 AI 的回答（可以发给开发者）/);
  assert.match(html, /<pre>/);
  assert.match(html, />再试一次<\/button>/);
  const quiet = render({ unavailable: { reason: 'failed', message: 'boom' }, fallback: PATH });
  assert.doesNotMatch(quiet, />再试一次<\/button>/, 'no retry button when the page has its own');
  assert.doesNotMatch(quiet, /<details/);
  const key = render({ unavailable: { reason: 'failed', message: '401 Unauthorized: invalid api key' }, fallback: PATH, onRetry: noop, onSettings: noop });
  assert.match(key, /打开模型设置/, 'a missing or rejected key is fixed in the settings, not by retrying');
  assert.doesNotMatch(key, />再试一次<\/button>/);
  assert.equal(render({ unavailable: { reason: 'no-signal' }, fallback: PATH }), '');
});

test('English has no Han and the same structure', () => {
  setUiLanguage('en');
  try {
    for (const unavailable of [{ reason: 'no-model' }, { reason: 'failed', message: 'boom' }, { reason: 'failed', message: '429 rate limit' }, { reason: 'nothing-usable', sample: '{}' }]) {
      const html = render({ unavailable, fallback: PATH, onRetry: noop, onSettings: noop });
      assert.doesNotMatch(html, han, unavailable.reason);
    }
    assert.match(text(render({ unavailable: { reason: 'nothing-usable', sample: '{}' }, fallback: PATH })), /could not be used\. The chapter-based path stays; you can try again\./);
  } finally { setUiLanguage('zh'); }
});
