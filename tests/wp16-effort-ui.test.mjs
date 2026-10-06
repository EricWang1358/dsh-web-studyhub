import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { nativeSelects } from './helpers/native-selects.mjs';

// WP16 item 1 (UI): Settings offers a reasoning-effort choice only when the
// model in effect has levels, and says plainly what the trade-off is.
const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: { contents: `export { default as ReasoningEffortField, effortTradeoff } from './ui/ReasoningEffortField.jsx'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], plugins: [nativeSelects], loader: { '.css': 'text' }, logLevel: 'silent',
});
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { ReasoningEffortField, effortTradeoff, setUiLanguage } = module.exports;
const render = (props) => renderToStaticMarkup(React.createElement(ReasoningEffortField, { busy: false, onChange() {}, ...props }));
const han = /[㐀-鿿]/;

const LEVELS = [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }];
const binding = (overrides = {}, effort = {}) => ({
  modelSource: 'session', route: { provider: 'p', model: 'm', reasoningEffort: 'medium' }, reasoningEffort: '',
  effort: { options: LEVELS, current: 'medium', followed: 'medium', source: 'session', applied: false, ...effort }, ...overrides,
});

test('nothing is shown when the model offers fewer than two levels', () => {
  setUiLanguage('zh');
  assert.equal(render({ binding: {} }), '');
  assert.equal(render({ binding: binding({}, { options: [], current: '' }) }), '');
  assert.equal(render({ binding: binding({}, { options: [LEVELS[0]] }) }), '');
});

test('a model with levels gets a segmented choice that starts with following the session', () => {
  setUiLanguage('zh');
  const out = render({ binding: binding() });
  assert.match(out, /推理程度/);
  assert.match(out, /role="group"/, 'a WP1 SegmentedControl');
  assert.match(out, /class="sh-seg__item is-active"[^>]*aria-pressed="true"[^>]*>跟随会话（Medium）<\/button>/, 'the effective value is spelled out');
  for (const name of ['Low', 'Medium', 'High']) assert.match(out, new RegExp(`aria-pressed="false"[^>]*>${name}</button>`.replace('Medium', 'Medium')), name);
  assert.match(out, /只影响出题和改题；陪学提示固定用最低档，音频处理在音频设置里单独调。/);
});

test('the trade-off line follows the position of the level in effect', () => {
  setUiLanguage('zh');
  assert.match(render({ binding: binding({}, { current: 'low', source: 'session' }) }), /更快、更省额度/);
  assert.match(render({ binding: binding({ reasoningEffort: 'high' }, { current: 'high', source: 'binding', applied: true }) }), /更慢、消耗更多额度；题目推理链更严谨/);
  assert.match(render({ binding: binding() }), /速度与严谨度折中/);
  assert.match(render({ binding: binding({ route: { provider: 'p', model: 'm' } }, { current: '', source: 'default' }) }), /档位越高/);
  assert.equal(effortTradeoff(LEVELS, 'low').key, 'low');
  assert.equal(effortTradeoff(LEVELS, 'high').key, 'high');
  assert.equal(effortTradeoff(LEVELS, 'medium').key, 'mid');
  assert.equal(effortTradeoff(LEVELS, '').key, 'unknown');
  assert.equal(effortTradeoff([], 'low').key, 'unknown');
});

test('a saved level is the active segment; unavailable saved levels fall back to following', () => {
  setUiLanguage('zh');
  const saved = render({ binding: binding({ reasoningEffort: 'high' }, { current: 'high', source: 'binding', applied: true }) });
  assert.match(saved, /is-active"[^>]*aria-pressed="true"[^>]*>High</);
  const stale = render({ binding: binding({ reasoningEffort: 'max' }, { stale: true }) });
  assert.match(stale, /is-active"[^>]*aria-pressed="true"[^>]*>跟随会话/);
  assert.match(stale, /之前选的「max」当前模型没有，已改为跟随。/);
});

test('with a custom generation model the first choice is the model default', () => {
  setUiLanguage('zh');
  const out = render({ binding: binding({ modelSource: 'custom', route: { provider: 'c', model: 'cm' } }, { current: '', followed: '', source: 'default' }) });
  assert.match(out, /aria-pressed="true"[^>]*>模型默认</);
  assert.doesNotMatch(out, /跟随会话/);
});

test('the first choice names the level following would give, including the model default', () => {
  setUiLanguage('zh');
  const noOwn = (extra = {}) => binding({ route: { provider: 'p', model: 'm' }, ...extra }, { current: 'high', followed: 'high', source: 'default' });
  assert.match(render({ binding: noOwn() }), /aria-pressed="true"[^>]*>跟随会话（High）</, 'the session names none, the model default is High');
  assert.match(render({ binding: noOwn({ modelSource: 'custom' }) }), /aria-pressed="true"[^>]*>模型默认（High）</);
  const chosen = binding({ reasoningEffort: 'low' }, { current: 'low', followed: 'medium', source: 'binding', applied: true });
  assert.match(render({ binding: chosen }), /aria-pressed="false"[^>]*>跟随会话（Medium）</, 'a chosen level does not hide what following would give');
});

test('more than four levels switch to a select with the same first choice', () => {
  setUiLanguage('zh');
  const many = ['minimal', 'low', 'medium', 'high', 'max'].map((id) => ({ id, name: id }));
  const out = render({ binding: binding({}, { options: many, current: 'medium' }) });
  assert.match(out, /<select/);
  assert.doesNotMatch(out, /sh-seg/);
  assert.match(out, /<option value="" selected="">跟随会话（medium）<\/option>/);
  assert.match(out, /<option value="max">max<\/option>/);
});

test('a stale preference on a model without levels gets one muted line instead of a control', () => {
  setUiLanguage('zh');
  const out = render({ binding: binding({ reasoningEffort: 'high' }, { options: [], current: '', source: 'default', stale: true }) });
  assert.match(out, /当前模型不支持推理程度设置，已使用模型默认。/);
  assert.doesNotMatch(out, /sh-seg|<select/);
});

test('changing the level is disabled while another save is running', () => {
  setUiLanguage('zh');
  const out = render({ binding: binding(), busy: true });
  assert.equal((out.match(/<button[^>]*disabled=""/g) || []).length, 4);
});

test('English UI has no Chinese in the field', () => {
  setUiLanguage('en');
  try {
    const out = render({ binding: binding({}, { current: 'high', source: 'session' }) }).replace(/<[^>]*>/g, ' ');
    assert.match(out, /Reasoning effort/);
    assert.match(out, /Follow session/);
    assert.match(out, /slower and uses more quota/i);
    assert.match(out, /only affects question generation and rewriting/i);
    assert.doesNotMatch(out, han);
    const stale = render({ binding: binding({ reasoningEffort: 'x' }, { options: [], current: '', stale: true }) }).replace(/<[^>]*>/g, ' ');
    assert.match(stale, /does not support reasoning effort/);
    assert.doesNotMatch(stale, han);
  } finally { setUiLanguage('zh'); }
});

test('the generation trace shows the level a step ran on, under technical details', async () => {
  const trace = await build({ stdin: { contents: `export { default as GenerationTrace } from './ui/GenerationTrace.jsx';`, resolveDir: process.cwd() },
    bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], plugins: [nativeSelects], loader: { '.css': 'text' }, logLevel: 'silent' });
  const traceModule = { exports: {} };
  new Function('require', 'module', 'exports', trace.outputFiles[0].text)(require, traceModule, traceModule.exports);
  setUiLanguage('zh');
  const job = { status: 'complete', steps: [{ id: 'a', stage: 'Writing', status: 'complete', runtime: 'subagent', reasoningEffort: 'high' }, { id: 'b', stage: 'Review', status: 'complete', runtime: 'direct' }] };
  const out = renderToStaticMarkup(React.createElement(traceModule.exports.GenerationTrace, { job }));
  assert.equal((out.match(/推理程度 high/g) || []).length, 1, 'only the step that recorded a level shows one');
});
