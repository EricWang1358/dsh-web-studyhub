import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// WP-G (tracker #161, #138 #139 #140): the field primitives every settings page uses.
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export * from './ui/components/index.js'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const m = module.exports;
const h = React.createElement;
const html = (type, props = {}, ...children) => renderToStaticMarkup(h(type, props, ...children));
const attr = (markup, name) => markup.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];

test('the library exports the field primitives', () => {
  for (const name of ['Field', 'TextInput', 'TextArea', 'Select', 'NumberInput', 'Checkbox', 'Switch', 'RadioCard', 'RadioCardGroup', 'SettingsSection', 'ProviderCard', 'ProviderGrid', 'StepList']) {
    const component = m[name];
    assert.ok(typeof component === 'function' || typeof component?.render === 'function', name);
  }
});

test('Field labels its control and wires hint and error through aria-describedby', () => {
  const out = html(m.Field, { label: '课程名称', hint: '最多 200 个字。' }, h(m.TextInput, { value: 'a', onChange() {} }));
  const id = attr(out.match(/<input[^>]*>/)[0], 'id');
  assert.ok(id, 'the control gets a generated id');
  assert.match(out, new RegExp(`<label[^>]*class="sh-field__label"[^>]*for="${id}"`));
  const hintId = attr(out.match(/<p[^>]*sh-hint[^>]*>/)[0], 'id');
  assert.ok(hintId);
  assert.equal(attr(out.match(/<input[^>]*>/)[0], 'aria-describedby'), hintId);
  assert.doesNotMatch(out, /aria-invalid/);
  assert.match(out, /class="sh-input"/);
});

test('Field marks an invalid control, shows the error as an alert and keeps the hint described', () => {
  const out = html(m.Field, { label: '题数', hint: '1–50', error: '请输入 1–50 的整数。', required: true }, h(m.NumberInput, { value: 99, min: 1, max: 50, onChange() {} }));
  const input = out.match(/<input[^>]*>/)[0];
  assert.match(input, /aria-invalid="true"/);
  assert.match(input, /required=""/);
  const described = attr(input, 'aria-describedby').split(' ');
  assert.equal(described.length, 2, 'hint and error');
  const error = out.match(/<p[^>]*role="alert"[^>]*>/)[0];
  assert.ok(described.includes(attr(error, 'id')));
  assert.match(out, /请输入 1–50 的整数。/);
  assert.match(out, /sh-field__required/);
});

test('Field keeps a caller-supplied htmlFor / id and merges an existing aria-describedby', () => {
  const out = html(m.Field, { label: '地址', htmlFor: 'mine', hint: '提示' }, h(m.TextInput, { id: 'mine', 'aria-describedby': 'other' }));
  assert.match(out, /for="mine"/);
  assert.equal(attr(out.match(/<input[^>]*>/)[0], 'id'), 'mine');
  assert.match(attr(out.match(/<input[^>]*>/)[0], 'aria-describedby'), /^other /);
});

test('Field width and inline layout are modifier classes; a group field labels a non-input control', () => {
  assert.match(html(m.Field, { label: 'a', width: 'sm' }, h(m.TextInput)), /class="sh-field sh-field--sm"/);
  assert.match(html(m.Field, { label: 'a' }, h(m.TextInput)), /sh-field--md/, 'md is the default');
  assert.match(html(m.Field, { label: 'a', width: 'full' }, h(m.TextInput)), /sh-field--full/);
  assert.match(html(m.Field, { label: 'a', inline: true }, h(m.TextInput)), /sh-field--inline/);
  const group = html(m.Field, { label: '界面语言', group: true, hint: '说明' }, h(m.SegmentedControl, { label: '界面语言', value: 'zh', options: [{ value: 'zh', label: '中文' }] }));
  assert.doesNotMatch(group, /<label/);
  assert.match(group, /<span[^>]*class="sh-field__label"/);
  assert.match(group, /role="group"[^>]*aria-describedby="[^"]+"|aria-describedby="[^"]+"[^>]*role="group"/, 'the group control is described by the hint');
});

test('Field accepts a render function for controls that are not elements', () => {
  const out = html(m.Field, { label: 'x', hint: 'h', error: 'e' }, ({ id, describedBy, invalid }) => h('output', { id, 'data-d': describedBy, 'data-i': String(invalid) }, '1'));
  assert.match(out, /<output id="[^"]+" data-d="[^"]+ [^"]+" data-i="true">1<\/output>/);
});

test('inputs render the one .sh-input look and pass attributes through', () => {
  assert.match(html(m.TextInput, { value: 'x', onChange() {}, maxLength: 5, name: 'n' }), /<input[^>]*type="text"[^>]*class="sh-input"|<input[^>]*class="sh-input"[^>]*type="text"/);
  assert.match(html(m.TextInput, { type: 'url', placeholder: 'https://' }), /type="url"/);
  assert.match(html(m.TextInput, { invalid: true }), /aria-invalid="true"/);
  assert.match(html(m.TextArea, { value: '', onChange() {}, rows: 4 }), /<textarea[^>]*class="sh-input"[^>]*rows="4"|<textarea[^>]*rows="4"[^>]*class="sh-input"/);
  const select = html(m.Select, { value: 'b', onChange() {} }, h('option', { value: 'a' }, 'A'), h('option', { value: 'b' }, 'B'));
  assert.match(select, /<select[^>]*class="sh-input"/);
  assert.match(select, /<option value="b" selected="">B<\/option>/);
});

test('NumberInput renders a number input with limits and an optional suffix', () => {
  const plain = html(m.NumberInput, { value: 3, min: 1, max: 9, step: 1, onChange() {} });
  assert.match(plain, /type="number"/);
  assert.match(plain, /min="1"/);
  assert.match(plain, /max="9"/);
  assert.match(plain, /step="1"/);
  assert.doesNotMatch(plain, /sh-number/);
  const suffixed = html(m.NumberInput, { value: 3, suffix: '分钟', onChange() {} });
  assert.match(suffixed, /class="sh-number"/);
  assert.match(suffixed, /<span class="sh-number__suffix">分钟<\/span>/);
});

test('Checkbox is a labelled checkbox row with a hint the input is described by', () => {
  const out = html(m.Checkbox, { label: '记录使用频率', hint: '关掉后，已有的记录保留。', checked: true, name: 'usage', 'data-usage': 'settings.usage', onChange() {} });
  assert.match(out, /<label class="sh-check/);
  const input = out.match(/<input[^>]*>/)[0];
  assert.match(input, /type="checkbox"/);
  assert.match(input, /checked=""/);
  assert.match(input, /name="usage"/);
  assert.match(input, /data-usage="settings.usage"/);
  assert.doesNotMatch(input, /role=/);
  assert.match(out, /<span class="sh-check__label">记录使用频率<\/span>/);
  const hintId = attr(out.match(/<span[^>]*sh-hint[^>]*>/)[0], 'id');
  assert.equal(attr(input, 'aria-describedby'), hintId);
  assert.match(html(m.Checkbox, { label: 'x', disabled: true }), /disabled=""/);
});

test('Switch is the same row with role="switch"', () => {
  const out = html(m.Switch, { label: '显示实验性功能', hint: '关掉后全部隐藏。', checked: false, onChange() {} });
  const input = out.match(/<input[^>]*>/)[0];
  assert.match(input, /type="checkbox"/);
  assert.match(input, /role="switch"/);
  assert.match(out, /sh-switch__track/);
  assert.match(out, /sh-check__label/);
  assert.match(html(m.Switch, { label: 'x', checked: true, onChange() {} }), /checked=""/);
});

test('RadioCard is a radio with a title, a hint and badges inside one selectable card', () => {
  const card = html(m.RadioCard, { name: 'tier', value: 'basic', checked: true, title: 'basic', hint: '更快', badges: h(m.Badge, { size: 'sm' }, '推荐'), onSelect() {} });
  const input = card.match(/<input[^>]*>/)[0];
  assert.match(input, /type="radio"/);
  assert.match(input, /name="tier"/);
  assert.match(input, /value="basic"/);
  assert.match(input, /checked=""/);
  assert.match(card, /class="sh-radio-card is-selected"/);
  assert.match(card, /sh-radio-card__title/);
  assert.match(card, /sh-badge/);
  assert.equal(attr(input, 'aria-describedby'), attr(card.match(/<span[^>]*sh-hint[^>]*>/)[0], 'id'));
  assert.doesNotMatch(html(m.RadioCard, { name: 'a', value: 'b', checked: false, title: 't' }), /is-selected/);
  assert.match(html(m.RadioCard, { name: 'a', value: 'b', checked: false, title: 't', disabled: true }), /disabled=""/);
  const group = html(m.RadioCardGroup, { legend: '选一个档位' }, card);
  assert.match(group, /<fieldset class="sh-radio-group"><legend>选一个档位<\/legend>/);
});

test('SettingsSection is a fieldset with a legend title, a lead and a tour anchor', () => {
  const out = html(m.SettingsSection, { title: '音频转写', lead: '录音要先转成文字。', tour: 'settings-audio', className: 'extra' }, h('p', null, 'body'));
  assert.match(out, /^<fieldset class="settings-section extra" data-tour="settings-audio">/);
  assert.match(out, /<legend class="settings-section__title">音频转写<\/legend>/);
  assert.match(out, /<p class="settings-section__lead">录音要先转成文字。<\/p>/);
  assert.match(out, /<p>body<\/p><\/fieldset>$/);
  assert.doesNotMatch(html(m.SettingsSection, { title: 'x' }), /__lead/);
  assert.match(html(m.SettingsSection, { title: 'x', disabled: true }), /<fieldset[^>]*disabled=""/);
});

test('StepList numbers its steps and links the ones that have an address', () => {
  const out = html(m.StepList, { steps: [{ text: '打开控制台', href: 'https://example.test/keys' }, { text: '粘贴密钥' }] });
  assert.match(out, /^<ol class="sh-steps"/);
  assert.equal([...out.matchAll(/<li/g)].length, 2);
  assert.match(out, /<span class="sh-steps__num" aria-hidden="true">1<\/span>/);
  assert.match(out, /<a href="https:\/\/example.test\/keys" target="_blank" rel="noreferrer">打开控制台<span class="sh-visually-hidden">（在新标签页打开）<\/span><\/a>/);
  assert.match(out, /<span>粘贴密钥<\/span>/);
});

test('ProviderCard puts the head, the saved state, the steps and the form in one card', () => {
  const out = html(m.ProviderCard, { title: 'Groq', badges: h(m.Badge, null, '免费'), set: true, status: '已保存 ····1234', steps: [{ text: '登录' }], 'data-provider': 'groq' }, h('div', { className: 'form' }));
  assert.match(out, /class="sh-provider is-set"/);
  assert.match(out, /data-provider="groq"/);
  assert.match(out, /<h3 class="sh-provider__title">Groq<\/h3>/);
  assert.match(out, /class="sh-provider__status is-set"/);
  assert.match(out, /已保存 ····1234/);
  assert.match(out, /<ol class="sh-steps"/);
  assert.match(out, /class="form"/);
  const bare = html(m.ProviderCard, { title: 'x', status: '未配置' });
  assert.doesNotMatch(bare, /is-set/);
  assert.doesNotMatch(bare, /<ol/);
  assert.match(html(m.ProviderCard, { title: 'x', layout: 'stack' }), /sh-provider--stack/);
});

test('the field stylesheet uses tokens only and defines every class once', () => {
  const css = readFileSync(new URL('../ui/components/fields.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/, 'no raw colours');
  assert.doesNotMatch(css, /font-size:\s*\d+(\.\d+)?px/, 'no raw font sizes');
  assert.doesNotMatch(css, /!important/);
  assert.doesNotMatch(css, /z-index:\s*\d/);
  assert.match(css, /\.sh-input\b/);
  assert.match(css, /prefers-reduced-motion/);
  const weights = new Set([...css.matchAll(/\.sh-(?:field__label|check__label)[^{]*\{[^}]*font-weight:\s*([^;]+);/g)].map(match => match[1].trim()));
  assert.deepEqual([...weights], ['var(--fw-medium)'], 'one label weight');
});
