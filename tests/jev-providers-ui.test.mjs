import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/* The provider selector, the key-source row and the per-provider privacy note of the Jev settings section, zh and en.
   The key itself is never in the markup; a key from an environment variable shows only the variable's NAME. */

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export { JevSettingsView, JevPrivacy } from './ui/JevSettings.jsx';
  export { privacyPoints, providerChoices, keySourceText, JEV_PROVIDER_META } from './ui/jev-flow.js';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text', '.json': 'json' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { JevSettingsView, JevPrivacy, privacyPoints, providerChoices, keySourceText, setUiLanguage } = module.exports;
const h = React.createElement;
const han = /[㐀-鿿]/;
const render = (element, language = 'zh') => { setUiLanguage(language); try { return renderToStaticMarkup(element); } finally { setUiLanguage('zh'); } };
const text = (points, language) => { setUiLanguage(language); try { return privacyPoints(points).join('\n'); } finally { setUiLanguage('zh'); } };

const SECRET = 'zen_env_secret_value_0000000000000000SECR';
const PROVIDERS = [{ id: 'typesafe', model: 'jev-latest', host: 'api.typesafe.ai', family: 'typesafe', defaultKeyEnv: 'JEV_API_KEY' },
  { id: 'opencode-zen-free', model: 'jev-1.13-free', host: 'opencode.ai', family: 'opencode', defaultKeyEnv: 'OPENCODE_GO_API_KEY_2' },
  { id: 'opencode-zen', model: 'jev-1.13', host: 'opencode.ai', family: 'opencode', defaultKeyEnv: 'OPENCODE_GO_API_KEY_2' }];
const base = { provider: 'typesafe', providers: PROVIDERS, key: { set: false, hint: '', source: '', envName: 'JEV_API_KEY', envFound: false }, confirmed: false, confirmedAt: '', enabled: false,
  features: { courseSuggest: false, preReview: false, outlineNoise: false, levelCheck: false }, threshold: 0.8, privacyUrl: 'https://docs.typesafe.ai/legal', docsUrl: 'https://docs.typesafe.ai', settingsFile: 'C:\\Users\\a\\.dsh\\study\\jev.json' };
const zenFree = { ...base, provider: 'opencode-zen-free', key: { set: false, hint: '', source: '', envName: 'OPENCODE_GO_API_KEY_2', envFound: false }, privacyUrl: 'https://opencode.ai/docs/zen/', docsUrl: 'https://opencode.ai/docs/zen/' };
const zenFound = { ...zenFree, key: { set: true, hint: '', source: 'env', envName: 'OPENCODE_GO_API_KEY_2', envFound: true } };
const noop = () => {};
const view = (settings, extra = {}) => h(JevSettingsView, { settings, usage: null, failure: null, busy: false, working: '', result: null, error: '', onKey: noop, onVerify: noop, onClearKey: noop, onConfirm: noop, onEnabled: noop, onFeature: noop, onThreshold: noop, onProvider: noop, onKeyEnv: noop, ...extra });
const noHan = (html, where) => assert.ok(!han.test(html.replace(/C:\\Users[^<]*/g, '')), `${where}: ${html.match(/.{0,30}[㐀-鿿]+.{0,30}/)?.[0]}`);

test('the selector offers the three providers with plain labels, marks the chosen one and calls onProvider with its id', () => {
  assert.deepEqual(providerChoices().map(choice => choice.id), ['typesafe', 'opencode-zen-free', 'opencode-zen']);
  assert.deepEqual(providerChoices().map(choice => choice.label), ['TypeSafe（官方）', 'OpenCode Zen · Jev 免费', 'OpenCode Zen · Jev']);
  const html = render(view(zenFree));
  assert.match(html, /<select[^>]*name="jev-provider"/);
  assert.match(html, /<option value="typesafe">TypeSafe（官方）<\/option>/);
  assert.match(html, /<option value="opencode-zen-free" selected="">OpenCode Zen · Jev 免费<\/option>/);
  assert.match(html, /<option value="opencode-zen">OpenCode Zen · Jev<\/option>/);
  assert.match(html, /aria-label="Jev 服务商"|for="[^"]+"[^>]*>[^<]*Jev 服务商/);
  const en = render(view(zenFree), 'en');
  assert.match(en, /<option value="typesafe">TypeSafe \(official\)<\/option>/);
  assert.match(en, /<option value="opencode-zen-free" selected="">OpenCode Zen · Jev Free<\/option>/);
  assert.match(en, /<option value="opencode-zen">OpenCode Zen · Jev<\/option>/);
  noHan(en, 'selector');
  // A settings object from before the presets (no provider field) reads as TypeSafe.
  assert.match(render(h(JevSettingsView, { settings: { ...base, provider: undefined, providers: undefined }, usage: null, failure: null, busy: false, working: '', result: null, error: '', onKey: noop, onVerify: noop, onClearKey: noop, onConfirm: noop, onEnabled: noop, onFeature: noop, onThreshold: noop })), /<option value="typesafe" selected="">/);
});

test('the key-source row says where the key comes from, shows only the variable NAME and whether it was found, never the value', () => {
  const found = render(view(zenFound));
  assert.match(found, /密钥来自环境变量 OPENCODE_GO_API_KEY_2（已找到）/);
  assert.ok(!found.includes(SECRET) && !found.includes(SECRET.slice(-4)));
  assert.doesNotMatch(found, /清除已保存的密钥/, 'an environment key cannot be cleared here');
  assert.doesNotMatch(found, /••••/);
  const missing = render(view(zenFree));
  assert.match(missing, /OPENCODE_GO_API_KEY_2（未找到）/);
  assert.match(missing, /DSH 可能没有把它传给插件/);
  assert.match(missing, /粘贴密钥/);
  assert.match(missing, /启动 DSH/);
  const en = render(view(zenFound), 'en'), enMissing = render(view(zenFree), 'en');
  assert.match(en, /Key from environment variable OPENCODE_GO_API_KEY_2 \(found\)/);
  assert.match(enMissing, /OPENCODE_GO_API_KEY_2 \(not found\)/);
  assert.match(enMissing, /DSH may not pass it on to the plugin/);
  assert.match(enMissing, /paste a key/i);
  assert.match(enMissing, /start DSH with the variable set/i);
  noHan(en, 'found'); noHan(enMissing, 'missing');
  // A pasted key wins, and the row says so without naming a value.
  const pasted = render(view({ ...zenFree, key: { set: true, hint: '••••ZENP', source: 'file', envName: 'OPENCODE_GO_API_KEY_2', envFound: true } }));
  assert.match(pasted, /••••ZENP/);
  assert.match(pasted, /粘贴的密钥优先/);
  assert.equal(keySourceText({ ...zenFound }).state, 'env-found');
  assert.equal(keySourceText(zenFree).state, 'env-missing');
  assert.equal(keySourceText({ ...zenFree, key: { ...zenFree.key, set: true, hint: '••••ZENP', source: 'file' } }).state, 'file');
});

test('the variable name can be changed (a text input with the default as its placeholder, never a password field)', () => {
  const html = render(view(zenFree));
  assert.match(html, /<input[^>]*name="jev-key-env"[^>]*type="text"|<input[^>]*type="text"[^>]*name="jev-key-env"/);
  assert.match(html, /placeholder="OPENCODE_GO_API_KEY_2"/);
  assert.match(html, /使用这个环境变量/);
  assert.match(render(view(zenFree), 'en'), /Use this variable/);
});

test('for an OpenCode preset the key field invites a pasted key as the optional way, not the TypeSafe console', () => {
  const html = render(view(zenFree));
  assert.doesNotMatch(html, /TypeSafe 控制台/);
  assert.match(html, /type="password"/);
  assert.match(html, /placeholder="[^"]*OpenCode[^"]*"/);
  noHan(render(view(zenFree), 'en'), 'key field');
  assert.match(render(view(base)), /粘贴 TypeSafe 控制台里的 Jev 密钥/, 'TypeSafe keeps its sentence');
});

test('the test button works for the chosen provider once a key exists and the note is confirmed', () => {
  const ready = { ...zenFound, confirmed: true, confirmedAt: '2026-10-03T00:00:00.000Z' };
  assert.match(render(view(ready)), /验证 Jev 密钥/);
});

test('the privacy note is per provider: TypeSafe unchanged, OpenCode says what OpenCode states and, for the free model, what it does not', () => {
  const typesafe = text('typesafe', 'zh');
  assert.equal(text(undefined, 'zh'), typesafe, 'no provider means TypeSafe');
  assert.match(typesafe, /api\.typesafe\.ai/);
  assert.match(typesafe, /不会用用户数据训练/);
  assert.match(typesafe, /企业客户/);
  assert.doesNotMatch(typesafe, /OpenCode/);

  const free = text('opencode-zen-free', 'zh'), paid = text('opencode-zen', 'zh');
  for (const note of [free, paid]) {
    assert.match(note, /OpenCode/);
    assert.match(note, /TypeSafe/, 'the provider behind OpenCode is named');
    assert.match(note, /零数据保留|零保留/);
    assert.match(note, /不用于训练|不会用来训练|不用数据训练|不训练/);
    assert.match(note, /标题和开头的一小段节选/);
    assert.doesNotMatch(note, /api\.typesafe\.ai/);
  }
  assert.match(free, /Jev 1\.13 Free/);
  assert.match(free, /限时/);
  assert.match(free, /没有说明[^。]*(保留|训练)/);
  assert.match(free, /保密/);
  assert.match(free, /未知|不确定|无法确定/);
  assert.doesNotMatch(paid, /Jev 1\.13 Free/);
  assert.doesNotMatch(paid, /保密资料/, 'the caution about the free model is the free model’s');
  assert.ok(!/\$|¥|美元|价格是/.test(free + paid), 'no price in the note');

  for (const id of ['typesafe', 'opencode-zen-free', 'opencode-zen']) noHan(text(id, 'en'), id);
  const enFree = text('opencode-zen-free', 'en');
  assert.match(enFree, /OpenCode/);
  assert.match(enFree, /zero retention/i);
  assert.match(enFree, /does not say whether prompts are retained or used for training/i);
  assert.match(enFree, /limited time/i);
  assert.match(enFree, /confidential/i);
  assert.match(text('opencode-zen', 'en'), /zero retention/i);
  assert.doesNotMatch(text('opencode-zen', 'en'), /does not say whether prompts/i);
});

test('the confirmation checkbox names the provider the content goes to', () => {
  const zh = render(h(JevPrivacy, { confirmed: false, provider: 'opencode-zen-free', onChange: noop, privacyUrl: 'https://opencode.ai/docs/zen/' }));
  assert.match(zh, /同意把这些内容发送到 Jev（OpenCode Zen 云端）/);
  assert.match(zh, /data-provider="opencode-zen-free"/);
  assert.doesNotMatch(zh, /TypeSafe 云端/);
  const typesafe = render(h(JevPrivacy, { confirmed: false, provider: 'typesafe', onChange: noop }));
  assert.match(typesafe, /同意把这些内容发送到 Jev（TypeSafe 云端）/);
  const en = render(h(JevPrivacy, { confirmed: false, provider: 'opencode-zen', onChange: noop }), 'en');
  assert.match(en, /send this content to Jev \(OpenCode Zen’s cloud\)/);
  noHan(en, 'privacy en');
  const full = render(view(zenFree));
  assert.match(full, /OpenCode Zen 云端/);
  assert.match(full, /https:\/\/opencode\.ai\/docs\/zen\//);
});

test('everything stays off by default for an OpenCode preset too: the switches are locked until a key exists and the note is confirmed', () => {
  assert.match(render(view(zenFree)), /<fieldset class="jev-switches" disabled=""/);
  assert.match(render(view(zenFound)), /<fieldset class="jev-switches" disabled=""/, 'a found key alone is not enough');
  const ready = { ...zenFound, confirmed: true };
  assert.doesNotMatch(render(view(ready)), /<fieldset class="jev-switches" disabled=""/);
});

test('a failure of an OpenCode provider is shown with its own sentence in both languages', () => {
  const zh = render(view({ ...zenFound, confirmed: true }, { failure: { feature: 'courseSuggest', reason: 'insufficient-balance', provider: 'opencode-zen', at: 'x' } }));
  assert.match(zh, /OpenCode Zen/);
  const en = render(view({ ...zenFound, confirmed: true }, { failure: { feature: 'courseSuggest', reason: 'rate-limited', provider: 'opencode-zen', at: 'x' } }), 'en');
  assert.match(en, /OpenCode Zen/);
  noHan(en, 'failure');
});
