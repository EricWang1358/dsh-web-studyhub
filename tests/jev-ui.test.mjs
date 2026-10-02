import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/* The Jev settings section and the organizer rows: the privacy note, the one confirmation, the switches (all off), the key shown
   only as its last four characters, the usage rows, and the probabilities under a suggested course. zh and en. */

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export { default as JevSettings, JevSettingsView, JevPrivacy, JevUsageView } from './ui/JevSettings.jsx';
  export { JevSuggestButton, JevNote, JevProbabilities } from './ui/JevOrganize.jsx';
  export { privacyPoints, setupStep, dshUsage, thresholdChoices, probabilityRows, startsIncluded, JEV_FEATURE_META } from './ui/jev-flow.js';
  export { setUiLanguage, ENGLISH_SOURCES } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text', '.json': 'json' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { JevSettings, JevSettingsView, JevUsageView, JevSuggestButton, JevNote, JevProbabilities, privacyPoints, setupStep, dshUsage, thresholdChoices, probabilityRows, startsIncluded, JEV_FEATURE_META, setUiLanguage, ENGLISH_SOURCES } = module.exports;
const h = React.createElement;
const han = /[㐀-鿿]/;
const render = (element, language = 'zh') => { setUiLanguage(language); try { return renderToStaticMarkup(element); } finally { setUiLanguage('zh'); } };

const KEY = 'tsk_live_looking_JEV_key_00000000000000000001';
const fresh = { key: { set: false, hint: '', source: '' }, confirmed: false, confirmedAt: '', enabled: false, features: { courseSuggest: false, preReview: false, outlineNoise: false, levelCheck: false },
  threshold: 0.8, privacyUrl: 'https://docs.typesafe.ai/legal', docsUrl: 'https://docs.typesafe.ai', settingsFile: 'C:\\Users\\a\\.dsh\\study\\jev.json' };
const keyed = { ...fresh, key: { set: true, hint: `••••${KEY.slice(-4)}`, source: 'file' } };
const ready = { ...keyed, confirmed: true, confirmedAt: '2026-10-02T00:00:00.000Z' };
const on = { ...ready, enabled: true, features: { ...ready.features, courseSuggest: true } };
const usage = { today: { calls: 2, inputTokens: 500, outputTokens: 20 }, total: { calls: 7, inputTokens: 2100, outputTokens: 90 }, byFeature: { courseSuggest: { calls: 5, inputTokens: 1600, outputTokens: 60 }, test: { calls: 2, inputTokens: 500, outputTokens: 30 } }, daily: [] };
const noop = () => {};
const view = (settings, extra = {}) => h(JevSettingsView, { settings, usage: null, failure: null, busy: false, working: '', result: null, error: '', onKey: noop, onVerify: noop, onClearKey: noop, onConfirm: noop, onEnabled: noop, onFeature: noop, onThreshold: noop, ...extra });

test('the section says it is experimental and off by default, in both languages', () => {
  const zh = render(h(JevSettings, { call: async () => ({}), initial: { settings: fresh, usage: null, failure: null } }));
  assert.match(zh, /实验性 · Jev 判断服务/);
  assert.match(zh, /默认全部关闭/);
  assert.match(zh, /data-experimental="true"/);
  const en = render(h(JevSettings, { call: async () => ({}), initial: { settings: fresh, usage: null, failure: null } }), 'en');
  assert.match(en, /Experimental · Jev decision service/);
  assert.match(en, /off by default|All of it is off/i);
  assert.ok(!han.test(en.replace(/C:\\Users[^<]*/g, '')), `no Han in English: ${en.match(/.{0,20}[㐀-鿿]+.{0,20}/)?.[0]}`);
});

test('the privacy note says what is sent, where, what the provider states, and what is not documented', () => {
  const zh = privacyPoints().join('\n');
  assert.match(zh, /标题和开头的一小段节选/);
  assert.match(zh, /TypeSafe AI/);
  assert.match(zh, /不会用用户数据训练/);
  assert.match(zh, /没有说明/, 'retention for a normal account is stated as undocumented');
  assert.match(zh, /企业客户/);
  assert.match(zh, /没有经过验证/);
  setUiLanguage('en');
  const en = privacyPoints().join('\n');
  setUiLanguage('zh');
  assert.ok(!han.test(en), en);
  assert.match(en, /excerpt/i);
  assert.match(en, /not to train models on user data/i);
  assert.match(en, /not documented|does not say|not stated/i);
  assert.match(en, /enterprise/i);
  assert.match(en, /not been verified|unverified|not verified/i);
  assert.ok(!/price of|\$|¥/.test(en));
});

test('nothing can be switched on until a key is saved and the note is confirmed; the confirmation is an unchecked checkbox first', () => {
  for (const [settings, step] of [[fresh, 'key'], [keyed, 'confirm'], [ready, 'ready']]) assert.equal(setupStep(settings), step);
  const html = render(view(fresh));
  assert.match(html, /<fieldset class="jev-switches" disabled=""/);
  assert.match(html, /<input id="[^"]*" type="checkbox"(?![^>]*checked)/, 'the confirmation starts unchecked');
  assert.match(html, /未配置/);
  const confirm = render(view(keyed));
  assert.match(confirm, /先确认上面的隐私说明/);
  assert.match(confirm, /<fieldset class="jev-switches" disabled=""/);
  const open = render(view(ready));
  assert.doesNotMatch(open, /<fieldset class="jev-switches" disabled=""/);
  assert.match(open, /data-confirmed="true"/);
});

test('every experiment has its own switch and all of them start off; the master switch is the kill switch', () => {
  const html = render(view(ready));
  for (const feature of JEV_FEATURE_META) {
    const at = html.indexOf(`data-feature="${feature.id}"`);
    assert.ok(at > 0, feature.id);
    assert.doesNotMatch(html.slice(at, at + 120), /checked/, `${feature.id} starts off`);
  }
  assert.match(html, /总开关/);
  assert.match(html, /立即生效/);
  const enabled = render(view(on));
  assert.match(enabled, /data-feature="courseSuggest"><input type="checkbox" checked=""/);
});

test('the key is shown only as its last four characters and the field is a password input', () => {
  const html = render(view(keyed));
  assert.match(html, /type="password"/);
  assert.match(html, new RegExp(`••••${KEY.slice(-4)}`));
  assert.ok(!html.includes(KEY) && !html.includes(KEY.slice(0, 20)));
  assert.match(html, /保存 Jev 密钥/);
  assert.match(html, /验证 Jev 密钥/);
  assert.match(html, /清除已保存的密钥/);
  const env = render(view({ ...keyed, key: { ...keyed.key, source: 'env' } }));
  assert.match(env, /来自环境变量/);
  assert.doesNotMatch(env, /清除已保存的密钥/, 'a key from the environment cannot be cleared here');
});

test('the threshold picker offers the default 80% and keeps a saved odd value', () => {
  assert.deepEqual(thresholdChoices(0.8), [0.6, 0.7, 0.8, 0.9, 0.95]);
  assert.deepEqual(thresholdChoices(0.85), [0.6, 0.7, 0.8, 0.85, 0.9, 0.95]);
  const html = render(view({ ...ready, threshold: 0.9 }));
  assert.match(html, /<option value="0\.9" selected="">90%<\/option>/);
});

test('usage shows today and the total in DSH-style rows, per experiment, and never a price', () => {
  assert.deepEqual(dshUsage({ calls: 2, inputTokens: 500, outputTokens: 20 }), { uncachedInputTokens: 500, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 2 });
  const html = render(h(JevUsageView, { usage }));
  assert.match(html, /今天/);
  assert.match(html, /合计/);
  assert.match(html, /500/);
  assert.match(html, /2\.1K|2,100|2100/);
  assert.match(html, /课程归属建议/);
  assert.match(html, /验证密钥时的调用/);
  assert.match(html, /不显示价格/);
  assert.doesNotMatch(html.replace(/不显示价格/g, ''), /价格|\$|¥|元/);
  assert.match(render(h(JevUsageView, { usage: { total: { calls: 0 }, byFeature: {} } })), /还没有调用过 Jev/);
});

test('a failure is shown as a quiet warning in plain words, in both languages', () => {
  const zh = render(view(on, { failure: { feature: 'courseSuggest', reason: 'rate-limited', at: 'x' } }));
  assert.match(zh, /Jev 请求太频繁/);
  const en = render(view(on, { failure: { feature: 'courseSuggest', reason: 'network', at: 'x' } }), 'en');
  assert.match(en, /Cannot reach Jev/);
  assert.ok(!han.test(en.replace(/C:\\Users[^<]*/g, '')));
});

test('the test result: valid in green words, a refusal with the server’s sentence', () => {
  assert.match(render(view(ready, { result: { ok: true, state: 'valid', message: 'x' } })), /可用：密钥有效，Jev 连得上/);
  assert.match(render(view(ready, { result: { ok: false, state: 'invalid-key', message: 'Jev 密钥无效或已被撤销：请到「设置 › 实验性 · Jev 判断服务」重新填写一个有效的密钥。' } })), /密钥无效/);
  assert.match(render(view(ready, { result: { ok: true, state: 'valid', message: 'x' } }), 'en'), /Works: the key is valid and Jev is reachable|The key is valid/);
});

test('the organizer: no button unless the experiment is on; the probabilities and the threshold line sit under a suggested row', () => {
  assert.equal(render(h(JevSuggestButton, { enabled: false, onClick: noop })), '');
  const button = render(h(JevSuggestButton, { enabled: true, onClick: noop }));
  assert.match(button, /Jev 建议/);
  assert.match(button, /实验性/);
  const jev = { choice: 'Databases', probability: 0.93, threshold: 0.8, filled: true, changed: true, viaParent: false, top: [{ course: 'Databases', p: 0.93 }, { course: 'Operating Systems', p: 0.04 }], none: 0.03 };
  const html = render(h(JevProbabilities, { jev }));
  assert.match(html, /93%/);
  assert.match(html, /Operating Systems/);
  assert.match(html, /采用线 80%/);
  assert.match(html, /已填入/);
  assert.match(html, /都不合适/);
  assert.match(html, /is-picked/);
  const low = render(h(JevProbabilities, { jev: { ...jev, filled: false, changed: false, choice: null, probability: 0.55 } }));
  assert.match(low, /把握不够，没有填入/);
  assert.deepEqual(probabilityRows(jev).map(row => row.id), ['Databases', 'Operating Systems', '__none__']);
  assert.equal(startsIncluded({ jev }), true);
  assert.equal(startsIncluded({ jev: { ...jev, changed: false } }), false, 'a suggestion that changes nothing starts unchecked');
  assert.equal(startsIncluded({}), false);
  assert.equal(render(h(JevProbabilities, { jev: null })), '');
  assert.match(render(h(JevNote, { note: 'Jev 请求太频繁，已自动等待过但仍被限流，已改用原来的做法。' })), /请 AI 建议/);
  assert.equal(render(h(JevNote, { note: '' })), '');
  const en = render(h(JevProbabilities, { jev }), 'en');
  assert.match(en, /line 80%/i);
  assert.ok(!han.test(en), en);
});

test('every Chinese sentence of the Jev screens has an English one', async () => {
  const files = ['ui/JevSettings.jsx', 'ui/JevOrganize.jsx', 'ui/jev-flow.js'];
  const english = Object.assign({}, ...Object.values(ENGLISH_SOURCES));
  const missing = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/\bui(?:Format|Message)?\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
      const text = match[2].replace(/\\'/g, "'");
      if (han.test(text) && !Object.hasOwn(english, text)) missing.push(`${file}: ${text}`);
    }
  }
  assert.deepEqual(missing, []);
});
