import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// C1: the shared component library. One component per kind of control, all
// styled from tokens, all passing data-* through so tours can anchor to them.
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export * from './ui/components/index.js'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const m = module.exports;
const h = React.createElement;
const html = (type, props = {}, ...children) => renderToStaticMarkup(h(type, props, ...children));
const han = /[㐀-鿿]/;

test('the library exports every contracted component', () => {
  for (const name of ['Button', 'IconButton', 'SegmentedControl', 'PageHeader', 'EmptyState', 'InlineMessage', 'Toast', 'ToastRegion',
    'Banner', 'SetupRequired', 'FileDrop', 'Dialog', 'Disclosure', 'Panel', 'Icon']) {
    const component = m[name];
    assert.ok(typeof component === 'function' || typeof component?.render === 'function', name);
  }
});

test('buttons have explicit variants, sizes, a default type and a busy state', () => {
  const primary = html(m.Button, { variant: 'primary', size: 'sm', 'data-tour': 'generate-submit' }, '生成');
  assert.match(primary, /^<button[^>]*type="button"/);
  assert.match(primary, /class="sh-btn sh-btn--primary sh-btn--sm"/);
  assert.match(primary, /data-tour="generate-submit"/);
  for (const variant of ['primary', 'secondary', 'quiet', 'link', 'danger']) assert.match(html(m.Button, { variant }, 'x'), new RegExp(`sh-btn--${variant} sh-btn--md`));
  assert.match(html(m.Button, { variant: 'shiny' }, 'x'), /sh-btn--secondary/, 'unknown variants fall back to secondary');
  assert.match(html(m.Button, { type: 'submit' }, 'x'), /type="submit"/);
  const busy = html(m.Button, { busy: true, variant: 'primary' }, '保存');
  assert.match(busy, /aria-busy="true"/);
  assert.match(busy, /disabled=""/);
  assert.match(busy, /sh-spinner/);
  assert.match(html(m.Button, { icon: 'upload' }, '上传'), /<svg[^>]*aria-hidden="true"/);
  assert.match(html(m.Button, { className: 'extra' }, 'x'), /class="sh-btn sh-btn--secondary sh-btn--md extra"/);
});

test('icon buttons are named for assistive technology', () => {
  const out = html(m.IconButton, { icon: 'close', label: '关闭' });
  assert.match(out, /aria-label="关闭"/);
  assert.match(out, /title="关闭"/);
  assert.match(out, /sh-btn--icon/);
  assert.match(out, /<svg/);
});

test('segmented controls fill the active segment and expose aria-pressed', () => {
  const out = html(m.SegmentedControl, { label: '界面语言', value: 'en', onChange() {}, options: [{ value: 'zh', label: '中文' }, { value: 'en', label: 'EN' }] });
  assert.match(out, /role="group"[^>]*aria-label="界面语言"|aria-label="界面语言"[^>]*role="group"/);
  assert.match(out, /<button[^>]*aria-pressed="false"[^>]*>中文<\/button>/);
  assert.match(out, /<button[^>]*class="sh-seg__item is-active"[^>]*aria-pressed="true"[^>]*>EN<\/button>/);
});

test('page headers carry one h1, an eyebrow, a description and actions', () => {
  const out = html(m.PageHeader, { eyebrow: '资料', title: '学习资料', description: '导入讲义和笔记。', actions: h(m.Button, { variant: 'primary' }, '添加资料'), 'data-tour': 'sources-add' });
  assert.match(out, /^<header[^>]*class="sh-page-header"/);
  assert.match(out, /data-tour="sources-add"/);
  assert.equal(out.match(/<h1/g).length, 1);
  assert.match(out, /<h1[^>]*>学习资料<\/h1>/);
  assert.match(out, /sh-page-header__eyebrow[^>]*>资料/);
  assert.match(out, /导入讲义和笔记/);
  assert.match(out, /sh-page-header__actions/);
});

test('empty states name the situation and offer one primary action', () => {
  const out = html(m.EmptyState, { icon: 'file', title: '还没有资料', description: '先添加一份讲义。',
    primary: { label: '添加资料', onClick() {} }, secondary: { label: '载入示例', onClick() {} } });
  assert.match(out, /sh-empty/);
  assert.match(out, /<h2[^>]*>还没有资料<\/h2>/);
  assert.equal(out.match(/sh-btn--primary/g).length, 1);
  assert.match(out, /sh-btn--quiet[^>]*>载入示例/);
});

test('setup gates explain why, list steps with safe external links and offer a fix', () => {
  m.setUiLanguage('zh');
  const out = html(m.SetupRequired, { title: '需要先配置 AI 模型', why: '用资料出题要调用一个模型。', tone: 'warning',
    steps: [{ text: '注册硅基流动并创建 API Key', href: 'https://cloud.siliconflow.cn/account/ak' }, { text: '回到设置填入 Key' }],
    primary: { label: '打开模型设置', onClick() {} }, secondary: { label: '先看示例', onClick() {} } });
  assert.match(out, /^<section[^>]*class="sh-setup sh-setup--warning"/);
  assert.match(out, /aria-labelledby="([^"]+)"/);
  const id = out.match(/aria-labelledby="([^"]+)"/)[1];
  assert.match(out, new RegExp(`<h2[^>]*id="${id}"[^>]*>需要先配置 AI 模型</h2>`));
  assert.match(out, /需要先配置<\/p>|需要先配置<\/span>/, 'the default badge');
  assert.match(out, /用资料出题要调用一个模型/);
  assert.match(out, /<ol[^>]*>.*注册硅基流动.*回到设置填入 Key.*<\/ol>/s);
  const link = out.match(/<a[^>]*href="https:\/\/cloud\.siliconflow\.cn\/account\/ak"[^>]*>/)[0];
  assert.match(link, /target="_blank"/);
  assert.match(link, /rel="noreferrer"/);
  assert.match(out, /sh-btn--primary[^>]*>.*打开模型设置/s);
  assert.match(out, /先看示例/);
  assert.match(html(m.SetupRequired, { title: 't', why: 'w', steps: [], primary: { label: 'p', onClick() {} }, badge: '国内直连' }), /国内直连/);
  assert.match(html(m.SetupRequired, { title: 't', why: 'w', steps: [], primary: { label: 'p', onClick() {} } }), /sh-setup--neutral/);
});

test('disclosures and panels are thin, token-styled wrappers', () => {
  const details = html(m.Disclosure, { summary: '高级设置', defaultOpen: true }, '内容');
  assert.match(details, /^<details[^>]*class="sh-disclosure"[^>]*open=""/);
  assert.match(details, /<summary[^>]*>.*高级设置.*<\/summary>/s);
  const panel = html(m.Panel, { title: '模型', actions: h(m.Button, null, '测试') }, '正文');
  assert.match(panel, /^<section[^>]*class="sh-panel"/);
  assert.match(panel, /<h3[^>]*>模型<\/h3>/);
  assert.match(panel, /正文/);
});

test('icons are decorative SVGs from one drawn family', () => {
  for (const name of m.ICON_NAMES) {
    const out = html(m.Icon, { name });
    assert.match(out, /^<svg[^>]*aria-hidden="true"[^>]*focusable="false"/, name);
    assert.match(out, /<(path|circle|rect)/, name);
  }
  for (const name of ['check', 'close', 'upload', 'file', 'audio', 'sparkle', 'info', 'warning', 'error', 'success', 'external']) assert.ok(m.ICON_NAMES.includes(name), name);
  assert.equal(html(m.Icon, { name: 'nope' }), '');
});

test('built-in English copy of every component contains no Chinese', () => {
  m.setUiLanguage('en');
  const out = [
    html(m.SetupRequired, { title: 'Model needed', why: 'Why', steps: [{ text: 'Get a key', href: 'https://example.com' }], primary: { label: 'Open', onClick() {} } }),
    html(m.Button, { busy: true }, 'Save'),
    html(m.Dialog, { title: 'Title', onClose() {} }, 'Body'),
    html(m.FileDrop, { accept: ['.md'], onFiles() {} }),
    html(m.EmptyState, { title: 'Nothing yet' }),
    html(m.Disclosure, { summary: 'More' }, 'x'),
  ].join('');
  assert.doesNotMatch(out, han);
  m.setUiLanguage('zh');
});
