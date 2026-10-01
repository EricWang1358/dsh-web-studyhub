/* WP15 · update UI: a calm "new version" chip, the 关于与更新 settings section and
   the upgrade dialog in both modes — one-click (DSH plugin manager available)
   and guided (copy the package address, reinstall, restart). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export * from './ui/UpdateCenter.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { UpdateChip, UpdateDialog, UpdateSettings, startUpgrade, chipState, setUiLanguage } = module.exports;
const han = /[㐀-鿿]/;
const h = React.createElement;
const ASSET = 'https://github.com/EricWang1358/dsh-web-studyhub/releases/download/v2.1.1/ericwang1358-dsh-daily-flashcard-2.1.1.tgz';
const update = (extra = {}) => ({ current: '2.1.0', latest: '2.1.1', newer: true, publishedAt: '2026-10-05T08:00:00Z',
  notes: '## What\'s new\n- calmer update check', url: 'https://github.com/EricWang1358/dsh-web-studyhub/releases/tag/v2.1.1',
  assetUrl: ASSET, assetName: 'ericwang1358-dsh-daily-flashcard-2.1.1.tgz', sha256Url: ASSET.replace(/ericwang.*$/, 'SHA256SUMS-2.1.1.txt'),
  checkedAt: '2026-10-06T00:00:00.000Z', autoCheck: true, snoozed: false, pendingRestart: null, ...extra });
const render = (element, language = 'zh') => { setUiLanguage(language); try { return renderToStaticMarkup(element); } finally { setUiLanguage('zh'); } };

test('the chip appears only for a newer, not snoozed release while automatic checks are on', () => {
  assert.match(render(h(UpdateChip, { update: update(), onOpen() {} })), /有新版本 2\.1\.1/);
  assert.match(render(h(UpdateChip, { update: update(), onOpen() {} }), 'en'), /Version 2\.1\.1 available/);
  for (const hidden of [null, update({ newer: false }), update({ snoozed: true }), update({ autoCheck: false })])
    assert.equal(render(h(UpdateChip, { update: hidden, onOpen() {} })), '', JSON.stringify(hidden && { newer: hidden.newer, snoozed: hidden.snoozed, autoCheck: hidden.autoCheck }));
  assert.equal(chipState(update({ pendingRestart: '2.1.1' })), 'restart');
  assert.match(render(h(UpdateChip, { update: update({ pendingRestart: '2.1.1' }), onOpen() {} })), /重启 DSH 完成升级/);
  assert.match(render(h(UpdateChip, { update: update(), onOpen() {}, compact: true })), /aria-label="有新版本 2\.1\.1"/, 'the icon rail keeps an accessible name');
});

test('with DSH\'s plugin manager the dialog offers one-click upgrade, the notes and 稍后提醒', () => {
  const html = render(h(UpdateDialog, { update: update({ install: { available: true, desktop: false } }), call: async () => ({}), onClose() {} }));
  assert.match(html, /一键升级到 2\.1\.1/);
  assert.match(html, /calmer update check/, 'release notes are shown');
  assert.match(html, /当前版本 2\.1\.0/);
  assert.match(html, /稍后提醒/);
  assert.match(html, /查看发布页/);
  assert.match(html, /SHA256/, 'says the package is verified');
  assert.doesNotMatch(html, /复制安装地址/);
  const en = render(h(UpdateDialog, { update: update({ install: { available: true, desktop: true } }), call: async () => ({}), onClose() {} }), 'en');
  assert.match(en, /Upgrade to 2\.1\.1/);
  assert.match(en, /Remind me later/);
  assert.doesNotMatch(en.replace(/calmer update check|What's new/g, ''), han, 'no untranslated application copy');
});

test('without an install API the dialog guides a reinstall from the exact package address', () => {
  const html = render(h(UpdateDialog, { update: update(), call: async () => ({}), onClose() {}, host: { openPluginManager() {} } }));
  assert.doesNotMatch(html, /一键升级/);
  assert.ok(html.includes(ASSET), 'the exact package address is shown');
  assert.match(html, /复制安装地址/);
  for (const step of ['卸载旧版', '添加插件', '粘贴地址', '重启 DSH']) assert.ok(html.includes(step), step);
  assert.match(html, /打开插件管理/, 'opens DSH\'s plugin manager when the host can');
  assert.match(html, /桌面版/, 'desktop note');
  assert.doesNotMatch(html, /npm|pnpm|dsh plugin/, 'never asks the learner to type commands');
  assert.doesNotMatch(render(h(UpdateDialog, { update: update(), call: async () => ({}), onClose() {} })), /打开插件管理/);
  const en = render(h(UpdateDialog, { update: update(), call: async () => ({}), onClose() {}, host: { openPluginManager() {} } }), 'en');
  for (const step of ['Copy package address', 'Remove the old version', 'Add plugin', 'Paste the address', 'Restart DSH']) assert.ok(en.includes(step), step);
  assert.doesNotMatch(en.replace(/calmer update check|What's new/g, ''), han);
});

test('the settings section shows the version, the last check, 检查更新 and the automatic-check setting', () => {
  const html = render(h(UpdateSettings, { update: update(), call: async () => ({}), onOpen() {} }));
  for (const text of ['关于与更新', '当前版本', '2.1.0', '上次检查', '检查更新', '自动检查更新', '有新版本 2.1.1']) assert.ok(html.includes(text), text);
  assert.match(html, /type="checkbox"[^>]*checked=""|checked=""[^>]*type="checkbox"/);
  const calm = render(h(UpdateSettings, { update: update({ newer: false, latest: '2.1.0', error: 'network' }), call: async () => ({}), onOpen() {} }));
  assert.match(calm, /已是最新版本|暂时无法连接/);
  assert.doesNotMatch(calm, /role="alert"/, 'a failed check is never an error banner');
  const en = render(h(UpdateSettings, { update: update(), call: async () => ({}), onOpen() {} }), 'en');
  for (const text of ['About &amp; updates', 'Current version', 'Check for updates', 'Check for updates automatically']) assert.ok(en.includes(text), text);
  assert.doesNotMatch(en, han);
});

test('startUpgrade asks before stopping running jobs and reports the restart DSH needs', async () => {
  const calls = [];
  const replies = [{ status: 'jobs-running', jobs: 2 }, { status: 'installed', version: '2.1.1', restartRequired: true, desktop: true }];
  const call = async (action, args) => { calls.push([action, args]); return replies.shift(); };
  assert.deepEqual(await startUpgrade(call, update()), { phase: 'jobs', jobs: 2 });
  assert.deepEqual(calls[0], ['update.install', { version: '2.1.1' }]);
  assert.deepEqual(await startUpgrade(call, update(), { confirmJobs: true }), { phase: 'installed', version: '2.1.1', restartRequired: true, desktop: true });
  assert.deepEqual(calls[1], ['update.install', { version: '2.1.1', confirmJobs: true }]);
  const failed = await startUpgrade(async () => { throw new Error('学习插件还没有就绪'); }, update());
  assert.deepEqual(failed, { phase: 'error', message: '学习插件还没有就绪' });
  const checksum = await startUpgrade(async () => ({ status: 'failed', code: 'UPDATE_CHECKSUM' }), update());
  assert.equal(checksum.phase, 'error');
  assert.match(checksum.message, /SHA-256/);
  const errorView = render(h(UpdateDialog, { update: update({ install: { available: true } }), call, onClose() {}, initialPhase: { phase: 'error', code: 'UPDATE_INSTALL' } }), 'en');
  assert.match(errorView, /did not install the new version/);
  assert.match(errorView, /Upgrade manually instead/);
  const installed = render(h(UpdateDialog, { update: update({ install: { available: true, desktop: true } }), call, onClose() {}, initialPhase: { phase: 'installed', version: '2.1.1', restartRequired: true, desktop: true } }));
  assert.match(installed, /已安装 2\.1\.1/);
  assert.match(installed, /完全退出/, 'desktop: quit the app fully, then reopen');
  const web = render(h(UpdateDialog, { update: update({ install: { available: true, desktop: false } }), call, onClose() {}, initialPhase: { phase: 'installed', version: '2.1.1', restartRequired: true, desktop: false } }));
  assert.match(web, /重启 DSH 服务/);
  const jobs = render(h(UpdateDialog, { update: update({ install: { available: true } }), call, onClose() {}, initialPhase: { phase: 'jobs', jobs: 2 } }));
  assert.match(jobs, /2 个后台任务/);
  assert.match(jobs, /停止任务并升级/);
});
