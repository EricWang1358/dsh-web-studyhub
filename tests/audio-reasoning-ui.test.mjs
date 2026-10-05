import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/* WP-AU #219 / #220: one control per reasoning setting, and its options are the levels of the model in use. */

const compiled = await build({
  stdin: { contents: `export { default as AudioReasoning, EffortSelect } from './ui/AudioReasoning.jsx'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.json': 'json', '.css': 'text' },
});
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { AudioReasoning, EffortSelect, setUiLanguage } = module.exports;
const HAN = /[㐀-鿿]/;
const noop = () => {};
const inLanguage = (language, run) => { try { setUiLanguage(language); return run(); } finally { setUiLanguage('zh'); } };
const deepseek = [{ id: 'default', name: 'Default' }, { id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }];
const render = props => renderToStaticMarkup(React.createElement(AudioReasoning, { busy: false, onSave: noop, timings: [], ...props }));
const options = html => [...html.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map(match => [match[1], match[2]]);

test('the reasoning section has two selects and nothing else for the same settings', () => {
  const page = render({ settings: { proofreadReasoning: 'default', translateReasoning: 'low' }, efforts: deepseek });
  assert.equal((page.match(/<select/g) || []).length, 2, 'one select for proofreading, one for translation');
  assert.doesNotMatch(page, /audio-reasoning-grid|audio-matrix|aria-pressed|<button/, 'no matrix beside the selects');
  assert.doesNotMatch(page, /校正 ↓|翻译 →/);
});

test('the options are the model\'s own levels, with the model default', () => {
  const page = render({ settings: { proofreadReasoning: 'default', translateReasoning: 'low' }, efforts: deepseek, modelName: 'deepseek-v4.1-flash' });
  const first = page.slice(page.indexOf('<select'), page.indexOf('</select>'));
  assert.deepEqual(options(first), [['default', '模型默认'], ['lowest', 'Off'], ['low', 'Low'], ['high', 'High'], ['highest', 'Max']]);
  assert.match(page, /deepseek-v4\.1-flash/);
  assert.match(page, /value="low" selected/, 'the saved strength is the one shown');
});

test('a saved "medium" on a model without it says which level is used instead', () => {
  const page = render({ settings: { proofreadReasoning: 'medium', translateReasoning: 'low' }, efforts: deepseek });
  assert.match(page, /当前模型没有「中」，已用「High」/);
  assert.doesNotMatch(render({ settings: { proofreadReasoning: 'medium', translateReasoning: 'low' }, efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }] }), /当前模型没有/);
  assert.match(render({ settings: { proofreadReasoning: 'high', translateReasoning: 'low' }, efforts: [] }), /当前模型没有可调的推理强度，「高」不起作用，按模型默认运行/);
  assert.doesNotMatch(render({ settings: { proofreadReasoning: 'high', translateReasoning: 'low' }, efforts: null }), /当前模型没有/, 'nothing is claimed before the levels are known');
});

test('measured timing sits beside each select', () => {
  const page = render({ settings: { proofreadReasoning: 'high', translateReasoning: 'low' }, efforts: deepseek,
    timings: [{ stage: 'proofread', averageMs: 4200, count: 3, byReasoning: { high: { count: 3, averageMs: 4200 } } }] });
  assert.match(page, /4\.2s · 3 次近七日样本/);
  assert.match(page, /等待耗时样本/);
});

test('in English the levels keep the model\'s names and the notes are translated', () => inLanguage('en', () => {
  const page = render({ settings: { proofreadReasoning: 'medium', translateReasoning: 'low' }, efforts: deepseek });
  assert.match(page, /This model has no &quot;Mid&quot; level; &quot;High&quot; is used|This model has no "Mid" level; "High" is used/);
  assert.match(page, /Model default/);
  assert.doesNotMatch(page, HAN);
}));

test('a select used alone (live correction) offers the same levels', () => {
  const html = renderToStaticMarkup(React.createElement(EffortSelect, { label: 'x', value: 'low', efforts: deepseek, onChange: noop }));
  assert.deepEqual(options(html).map(([value]) => value), ['default', 'lowest', 'low', 'high', 'highest']);
});
