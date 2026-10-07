import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GENERATION_SETTINGS_DEFAULTS } from '../lib/generation-settings.js';
import { nativeSelects } from './helpers/native-selects.mjs';

/* #226 / #227: the effort selects of 出题偏好 are the same component as the audio settings', with the options of the model in use, and a
   level the model lacks is shown as the level that is really used, the note naming the preference. */

const compiled = await build({
  stdin: { contents: `export { default as GenerationSettings } from './ui/GenerationSettings.jsx'; export { default as AudioReasoning, EffortSelect } from './ui/AudioReasoning.jsx';
    export { EffortSelect as SharedEffortSelect } from './ui/EffortSelect.jsx'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], plugins: [nativeSelects], loader: { '.json': 'json', '.css': 'text' }, logLevel: 'silent',
});
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { GenerationSettings, AudioReasoning, EffortSelect, SharedEffortSelect, setUiLanguage } = module.exports;
const noop = () => {};
const HAN = /[㐀-鿿]/;
const deepseek = [{ id: 'default', name: 'Default' }, { id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }];
const classic = [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }];
const generation = (props = {}, saved = {}) => renderToStaticMarkup(React.createElement(GenerationSettings, { root: '/library', act: noop,
  saved: { ...GENERATION_SETTINGS_DEFAULTS, ...saved }, ...props }));
const selectOf = (html, name) => { const at = html.indexOf(`name="${name}"`); return html.slice(html.lastIndexOf('<select', at), html.indexOf('</select>', at)); };
const options = (html) => [...html.matchAll(/<option value="([^"]*)"([^>]*)>([^<]*)<\/option>/g)].map(match => [match[1], match[3], /selected/.test(match[2])]);
const EFFORT_KEYS = ['effortPlanning', 'effortReview', 'effortWriting', 'effortRepair'];

test('the audio settings and 出题偏好 share one EffortSelect', () => {
  assert.equal(EffortSelect, SharedEffortSelect);
  const html = generation({ efforts: deepseek });
  assert.equal((html.match(/class="effort-select/g) || []).length, 4, 'one shared select per stage');
  assert.equal((renderToStaticMarkup(React.createElement(AudioReasoning, { settings: { proofreadReasoning: 'low' }, busy: false, onSave: noop, efforts: deepseek }))
    .match(/class="effort-select/g) || []).length, 2);
});

test('the options of the generation selects are the levels of the current model, plus following the session', () => {
  const html = generation({ efforts: deepseek });
  for (const key of EFFORT_KEYS) assert.deepEqual(options(selectOf(html, key)).map(([value, label]) => [value, label]),
    [['follow', '跟随当前会话'], ['default', '模型默认'], ['lowest', 'Off'], ['low', 'Low'], ['high', 'High'], ['highest', 'Max']], key);
  assert.deepEqual(options(selectOf(generation({ efforts: classic }), 'effortReview')).map(([value]) => value), ['follow', 'default', 'low', 'medium', 'high']);
  assert.match(selectOf(html, 'effortWriting'), /<option value="low" selected/);
  assert.match(selectOf(html, 'effortReview'), /<option value="follow"[^>]*selected/, 'following the session is a choice of its own, never mapped');
});

test('before the model is known the select does not claim levels it cannot know', () => {
  const html = generation({ efforts: null }, { effortReview: 'medium' });
  assert.deepEqual(options(selectOf(html, 'effortReview')).filter(item => item[2]).map(item => item[0]), ['medium']);
  assert.doesNotMatch(html, /你之前选的/);
});

test('a level the model lacks is shown as the level used, and the note names the preference (#227)', () => {
  const html = generation({ efforts: deepseek }, { effortReview: 'medium' });
  const review = selectOf(html, 'effortReview');
  assert.deepEqual(options(review).filter(item => item[2]), [['high', 'High', true]]);
  assert.ok(!options(review).some(([value]) => value === 'medium'), 'no option for a level the model does not offer');
  assert.match(html, /你之前选的「中」，当前模型没有，已用「High」/);
  const restored = generation({ efforts: classic }, { effortReview: 'medium' });
  assert.deepEqual(options(selectOf(restored, 'effortReview')).filter(item => item[2]).map(item => item[0]), ['medium']);
  assert.doesNotMatch(restored, /你之前选的/, 'a model that has the level restores the preference and says nothing');
  assert.doesNotMatch(generation({ efforts: deepseek }, { effortReview: 'high' }), /你之前选的/);
});

test('a model without adjustable levels offers only the model default and says the preference does nothing', () => {
  const html = generation({ efforts: [] }, { effortReview: 'high' });
  assert.deepEqual(options(selectOf(html, 'effortReview')).map(item => item[0]), ['follow', 'default']);
  assert.match(html, /当前模型没有可调的推理强度，「高」不起作用，按模型默认运行/);
});

test('the English page translates the note and keeps the model\'s level names', () => {
  setUiLanguage('en');
  try {
    const html = generation({ efforts: deepseek }, { effortReview: 'medium' });
    assert.match(html, /You chose (?:&quot;|")Mid(?:&quot;|") before; this model has no such level, so (?:&quot;|")High(?:&quot;|") is used/);
    assert.match(html, /Follow session/);
    assert.doesNotMatch(html.replace(/\bvalue="(?:中文|中英双语)"/g, '').replaceAll('>中文<', '><'), HAN);
  } finally { setUiLanguage('zh'); }
});
