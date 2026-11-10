/* WP15 · update UI: a calm "new version" chip, the 关于与更新 settings section and
   the upgrade dialog in both modes — one-click (DSH plugin manager available)
   and guided (copy the package address, reinstall, restart). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { updateView, releaseFromGithub } from '../lib/update-check.js';
import { githubRelease } from './helpers/wp15-release.mjs';

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export * from './ui/UpdateCenter.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { UpdateChip, UpdateDialog: Dialog, UpdateSettings: Settings, startUpgrade, chipState, setUiLanguage, StudyServicesContext } = module.exports;
const han = /[㐀-鿿]/;
const h = React.createElement;
// The dialog and the section read `call` and `host` from the app's services (useStudy): the tests give them as props here and this passes them on.
const withServices = View => ({ call, host, ...props }) => h(StudyServicesContext.Provider, { value: { call, host } }, h(View, props));
const UpdateDialog = withServices(Dialog), UpdateSettings = withServices(Settings);
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

test('the settings section offers 复制诊断信息 when it is given the text, in both languages, and not otherwise (#893)', () => {
  const diagnostic = () => 'StudyHub diagnostic info';
  const zh = render(h(UpdateSettings, { update: update(), call: async () => ({}), onOpen() {}, diagnostic }));
  for (const text of ['复制诊断信息', 'data-tour="settings-diagnostic"', 'DSH 版本请自己补上']) assert.ok(zh.includes(text), text);
  const en = render(h(UpdateSettings, { update: update(), call: async () => ({}), onOpen() {}, diagnostic }), 'en');
  assert.ok(en.includes('Copy diagnostic information'));
  assert.doesNotMatch(en, han);
  assert.ok(!render(h(UpdateSettings, { update: update(), call: async () => ({}), onOpen() {} })).includes('复制诊断信息'));
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
  const pending = render(h(UpdateDialog, { update: update({ pendingRestart: '2.1.1', install: { available: true, desktop: false } }), call, onClose() {} }));
  assert.match(pending, /已安装 2\.1\.1/, 'the restart chip opens the restart instructions, not a second upgrade');
  assert.doesNotMatch(pending, /一键升级/);
  const jobs = render(h(UpdateDialog, { update: update({ install: { available: true } }), call, onClose() {}, initialPhase: { phase: 'jobs', jobs: 2 } }));
  assert.match(jobs, /2 个后台任务/);
  assert.match(jobs, /停止任务并升级/);
});

test('"已是最新版本" is not claimed while the search extension is behind', () => {
  const stale = { canInstall: true, installed: true, enabled: true, version: '2.1.2', outdated: true, expected: '2.1.3' };
  const html = render(h(UpdateSettings, { update: update({ newer: false, latest: '2.1.0' }), call: async () => ({}), onOpen() {}, extension: stale }));
  assert.doesNotMatch(html, /已是最新版本/);
  assert.match(html, /检索扩展/);
  assert.match(html, /2\.1\.2/);
  // One fact, one wording: the update notice (with its button) says it; no second sentence above it says it again.
  assert.equal(html.match(/检索扩展需要更新/g)?.length, 1);
  assert.doesNotMatch(html, /本体已是最新|需要更新到/);
  const current = render(h(UpdateSettings, { update: update({ newer: false, latest: '2.1.0' }), call: async () => ({}), onOpen() {}, extension: { ...stale, outdated: undefined } }));
  assert.match(current, /已是最新版本/);
  const en = render(h(UpdateSettings, { update: update({ newer: false, latest: '2.1.0' }), call: async () => ({}), onOpen() {}, extension: stale }), 'en');
  assert.doesNotMatch(en, han);
});

test('an older pending install never hides the later release in settings, the chip or the upgrade dialog', () => {
  const pending = { ...updateView({ pending: '2.5.10', release: releaseFromGithub(githubRelease('v2.5.11')) }, '2.5.8', '2.5.10'),
    install: { available: true, desktop: false } };
  const props = { update: pending, call: async () => ({}), onOpen() {}, onClose() {} };
  const settings = render(h(UpdateSettings, props));
  assert.match(settings, /有新版本 2\.5\.11/, 'the later release remains visible before restarting');
  for (const text of ['2.5.8', '已安装版本', '2.5.10', '最新已知版本', '2.5.11', '有新版本 2.5.11', '查看升级'])
    assert.ok(settings.includes(text), text);
  assert.match(settings, /已安装 2\.5\.10，重启 DSH 后生效/);
  assert.equal(chipState(pending), 'new');
  assert.match(render(h(UpdateChip, props)), /有新版本 2\.5\.11/);
  const dialog = render(h(UpdateDialog, props));
  assert.match(dialog, /一键升级到 2\.5\.11/);
  assert.match(dialog, /已安装 2\.5\.10/);
  assert.doesNotMatch(dialog, /StudyHub 2\.5\.10 等待重启/);
  const refreshed = render(h(UpdateDialog, { ...props, initialPhase: { phase: 'installed', version: '2.5.10', restartRequired: true } }));
  assert.match(refreshed, /一键升级到 2\.5\.11/, 'an already open restart dialog also offers the later release');
  assert.doesNotMatch(render(h(UpdateDialog, { ...props, initialPhase: { phase: 'installed', version: '2.5.11', restartRequired: true } })), /一键升级/);
  for (const Component of [UpdateChip, UpdateSettings, UpdateDialog])
    assert.doesNotMatch(render(h(Component, props), 'en'), han, Component.name);
  for (const quiet of [{ snoozed: true }, { autoCheck: false }]) {
    assert.equal(chipState({ ...pending, ...quiet }), 'restart');
    assert.match(render(h(UpdateSettings, { ...props, update: { ...pending, ...quiet } })), /查看升级/);
  }
});

test('pending restart instructions remain visible alongside a failed latest check, without duplicate upgrades', () => {
  const pending = { ...updateView({ pending: '2.5.10', error: 'network', release: releaseFromGithub(githubRelease('v2.5.10')) }, '2.5.8', '2.5.10'),
    install: { available: true } };
  const props = { update: pending, call: async () => ({}), onOpen() {}, onClose() {} };
  const settings = render(h(UpdateSettings, props));
  assert.match(settings, /已安装 2\.5\.10/);
  assert.match(settings, /暂时无法连接 GitHub/);
  assert.doesNotMatch(settings, /查看升级|已是最新版本/);
  assert.doesNotMatch(render(h(UpdateDialog, props)), /一键升级/);
  const peerInstalled = { ...pending, installed: '2.5.11', pendingRestart: '2.5.11', latest: '2.5.11' };
  for (const initialPhase of [{ phase: 'idle' }, { phase: 'installed', version: '2.5.10' }]) {
    const dialog = render(h(UpdateDialog, { ...props, update: peerInstalled, initialPhase }));
    assert.match(dialog, /已安装 2\.5\.11/, 'another seat completing an install refreshes the open dialog');
    assert.doesNotMatch(dialog, /一键升级/);
  }
  assert.match(settings, /手动检查立即查询/);
});

test('bilingual release notes render formatted Markdown in the active UI language, and retryable errors offer one-click Retry upgrade', async () => {
  const bilingual = [
    '## 4.5.0 — 2026-11-08',
    '',
    '- **Hands-on task (`动手任务`) check.** Main-chat verification for tasks.',
    '',
    '## 4.5.0 — 2026-11-08',
    '',
    '- **新增通用「动手任务」题型。** 支持在主会话里静态验收。',
  ].join('\n');
  const zhHtml = render(h(UpdateDialog, {
    update: update({ latest: '4.5.0', notes: bilingual, install: { available: true, desktop: true } }),
    call: async () => ({}),
    onClose() {},
  }), 'zh');
  assert.match(zhHtml, /<strong>新增通用「动手任务」题型。<\/strong>/, 'bold Markdown lead renders as semantic <strong>');
  assert.doesNotMatch(zhHtml, /Hands-on task|## 4\.5\.0|\*\*/, 'English section, duplicate version heading and raw ** are hidden in zh UI');

  const enHtml = render(h(UpdateDialog, {
    update: update({ latest: '4.5.0', notes: bilingual, install: { available: true, desktop: true } }),
    call: async () => ({}),
    onClose() {},
  }), 'en');
  assert.match(enHtml, /<strong>Hands-on task/, 'English section renders in en UI');
  assert.doesNotMatch(enHtml, /新增通用|## 4\.5\.0|\*\*/);

  const dropped = await startUpgrade(
    async () => ({ status: 'failed', code: 'UPDATE_DOWNLOAD', detail: 'network', savedBytes: 2048 }),
    update(),
  );
  assert.equal(dropped.phase, 'error');
  assert.match(dropped.message, /已收到的部分会保留/);
  const droppedZh = render(h(UpdateDialog, {
    update: update({ install: { available: true, desktop: true } }),
    call: async () => ({}),
    onClose() {},
    initialPhase: dropped,
  }), 'zh');
  assert.match(droppedZh, /重试升级/, 'primary button retries directly without going back through confirmation');
  assert.doesNotMatch(droppedZh, /一键升级到/);

  const http502En = render(h(UpdateDialog, {
    update: update({ install: { available: true, desktop: true } }),
    call: async () => ({}),
    onClose() {},
    initialPhase: { phase: 'error', code: 'UPDATE_DOWNLOAD', detail: 'http', httpStatus: 502 },
  }), 'en');
  assert.match(http502En, /HTTP 502/);
  assert.match(http502En, /Retry upgrade/);
  assert.doesNotMatch(http502En, han);

  const staleZh = render(h(UpdateDialog, {
    update: update({ install: { available: true, desktop: true } }),
    call: async () => ({}),
    onClose() {},
    initialPhase: { phase: 'error', code: 'UPDATE_STALE' },
  }), 'zh');
  assert.match(staleZh, /知道了/);
  assert.doesNotMatch(staleZh, /重试升级/);
});

/* Issue #951: a restart that did not take effect has its own chip, dialog and settings line; a restart still to come explains what restarting means. */
const INSTALLED_AT = '2026-11-10T08:00:00.000Z';
const stuckView = (extra = {}, state = {}, current = '4.7.0') => ({
  ...updateView({ pending: '4.7.1', installedAt: INSTALLED_AT, release: releaseFromGithub(githubRelease('v4.7.1')), ...state }, current, current, Date.parse('2026-11-10T09:00:00Z')),
  install: { available: true, desktop: true }, ...extra });
const waitingView = (extra = {}) => ({ ...updateView({ pending: '4.7.1', installedAt: INSTALLED_AT, release: releaseFromGithub(githubRelease('v4.7.1')) }, '4.7.0', '4.7.0', Date.parse('2026-11-10T07:00:00Z')),
  install: { available: true, desktop: true }, ...extra });
const noop = { call: async () => ({}), onOpen() {}, onClose() {} };

test('the chip has three states and a failed restart outranks a new-version nudge, a snooze and switched-off checks', () => {
  assert.equal(chipState(waitingView()), 'restart');
  assert.equal(chipState(stuckView()), 'stuck');
  assert.equal(chipState(update()), 'new');
  for (const quiet of [{}, { snoozed: true }, { autoCheck: false }]) assert.equal(chipState(stuckView(quiet)), 'stuck', JSON.stringify(quiet));
  assert.equal(chipState(stuckView({ upgradeAvailable: false, newer: false })), 'stuck', 'nothing to install is still a failed restart');
});

test('the stuck chip says so, in a warning tone, keeps the compact name and uses no title attribute', () => {
  const zh = render(h(UpdateChip, { update: stuckView(), onOpen() {} }));
  assert.match(zh, /升级没有生效/);
  assert.match(zh, /class="update-chip update-chip--stuck"/);
  assert.match(zh, /<span class="sh-badge[^"]*"[^>]*data-tone="warning"/, 'the chip\'s own badge, a warning tone');
  assert.match(zh, /DSH 重启过，运行的仍是 4\.7\.0/, 'hover and focus explain it');
  const compact = render(h(UpdateChip, { update: stuckView(), onOpen() {}, compact: true }));
  assert.match(compact, /aria-label="升级没有生效"/);
  assert.doesNotMatch(compact, /update-chip__label/);
  const en = render(h(UpdateChip, { update: stuckView(), onOpen() {} }), 'en');
  assert.match(en, /Upgrade did not take effect/);
  assert.doesNotMatch(en, han);
  for (const html of [zh, compact, en, render(h(UpdateChip, { update: waitingView(), onOpen() {} })), render(h(UpdateChip, { update: update(), onOpen() {} }))])
    assert.doesNotMatch(html, /\stitle="/, 'an explanation is a Tooltip, never title=');
  assert.match(render(h(UpdateChip, { update: waitingView(), onOpen() {} })), /class="update-chip update-chip--restart"/, 'the other states keep their classes');
});

test('the restart chip explains what restarting means: the same sentence the dialog gives, desktop or service', () => {
  const desktop = render(h(UpdateChip, { update: waitingView(), onOpen() {} }));
  assert.match(desktop, /role="tooltip"[^>]*>请完全退出 DSH 桌面版（包括托盘图标）后重新打开，新版本才会生效。</);
  assert.match(desktop, /aria-describedby="/);
  const web = render(h(UpdateChip, { update: waitingView({ install: { available: true, desktop: false } }), onOpen() {} }));
  assert.match(web, /role="tooltip"[^>]*>请重启 DSH 服务（停止后用原来的方式重新启动），再刷新页面，新版本才会生效。</);
  const en = render(h(UpdateChip, { update: waitingView(), onOpen() {} }), 'en');
  assert.match(en, /Quit DSH desktop fully \(including the tray icon\)/);
  assert.doesNotMatch(en, han);
  const dialog = render(h(UpdateDialog, { ...noop, update: waitingView() }));
  assert.ok(dialog.includes('请完全退出 DSH 桌面版（包括托盘图标）后重新打开，新版本才会生效。'), 'the dialog says the same words');
});

test('the dialog of a failed restart: what happened, the usual causes, and a way out', () => {
  const html = render(h(UpdateDialog, { ...noop, update: stuckView() }));
  assert.match(html, /StudyHub 4\.7\.1 没有生效/);
  assert.match(html, /现在运行的是 4\.7\.0。/);
  assert.match(html, /安装过 4\.7\.1，之后 DSH 重新启动过，运行的仍是 4\.7\.0。/);
  assert.match(html, /DSH 没有完全退出就又打开了（托盘里还留着）/);
  assert.match(html, /另一份 StudyHub（另一个配置）升了级，这一份没有/);
  assert.match(html, /重新安装 4\.7\.1/, 'the one-click flow, offered again');
  assert.match(html, /改用手动升级/);
  assert.doesNotMatch(html, /等待重启|稍后提醒|一键升级到|复制安装地址/, 'no waiting page, no snooze, and the manual steps stay behind their button');
  const en = render(h(UpdateDialog, { ...noop, update: stuckView() }), 'en');
  assert.match(en, /StudyHub 4\.7\.1 did not take effect/);
  assert.match(en, /Reinstall 4\.7\.1/);
  assert.match(en, /Upgrade manually instead/);
  assert.doesNotMatch(en.replace(/calmer update check|What's new/g, ''), han);
});

test('the reinstall of a failed restart is the existing confirm flow, and its result is the normal "installed, restart" page', () => {
  const confirm = render(h(UpdateDialog, { ...noop, update: stuckView(), initialPhase: { phase: 'confirm' } }));
  assert.match(confirm, /确认升级/);
  const done = render(h(UpdateDialog, { ...noop, update: stuckView(), initialPhase: { phase: 'installed', version: '4.7.1', restartRequired: true, desktop: true } }));
  assert.match(done, /StudyHub 4\.7\.1 等待重启/);
  assert.doesNotMatch(done, /没有生效/);
});

test('a failed restart with nothing newer to install: 检查更新 and the manual steps from the release page', () => {
  const none = stuckView({}, { release: releaseFromGithub(githubRelease('v4.7.0')) });
  assert.equal(none.upgradeAvailable, false);
  const html = render(h(UpdateDialog, { ...noop, update: none }));
  assert.match(html, /StudyHub 4\.7\.1 没有生效/);
  assert.match(html, /还没查到比 4\.7\.0 更新的版本/);
  assert.match(html, /sh-btn--primary[^>]*>(?:<[^>]+>)*检查更新</);
  assert.match(html, /复制安装地址/, 'the manual way is always there');
  assert.ok(html.includes(none.url), 'from the release page, not the package of a version this copy already has');
  assert.ok(!html.includes(none.assetUrl));
  assert.doesNotMatch(html, /重新安装|稍后提醒/);
  const noRelease = stuckView({}, { release: undefined });
  assert.match(render(h(UpdateDialog, { ...noop, update: noRelease })), /检查更新/);
  const withoutInstaller = render(h(UpdateDialog, { ...noop, update: stuckView({ install: { available: false } }) }));
  assert.match(withoutInstaller, /复制安装地址/);
  assert.doesNotMatch(withoutInstaller, /重新安装/);
  const en = render(h(UpdateDialog, { ...noop, update: none }), 'en');
  assert.match(en, /Check for updates/);
  assert.doesNotMatch(en.replace(/calmer update check|What's new/g, ''), han);
});

test('the normal "waiting for a restart" page adds one quiet line for a restart that did not really end the old process', () => {
  const desktop = render(h(UpdateDialog, { ...noop, update: waitingView() }));
  assert.match(desktop, /重启后还看到这个提示？先确认已经从托盘退出 DSH；还是不行，可以改用手动升级。/);
  assert.match(desktop, /查看手动升级步骤/);
  assert.doesNotMatch(desktop, /复制安装地址/, 'the steps open on request');
  const web = render(h(UpdateDialog, { ...noop, update: waitingView({ install: { available: true, desktop: false } }) }));
  assert.match(web, /重启后还看到这个提示？先确认 DSH 服务已经停止、重新启动过，并刷新了页面；还是不行，可以改用手动升级。/);
  const en = render(h(UpdateDialog, { ...noop, update: waitingView() }), 'en');
  assert.match(en, /Still seeing this after a restart\?/);
  assert.match(en, /Show the manual steps/);
  assert.doesNotMatch(en, han);
  assert.doesNotMatch(render(h(UpdateDialog, { ...noop, update: stuckView() })), /重启后还看到这个提示/, 'the failed-restart dialog does not repeat it');
});

test('Settings › 关于与更新 says a failed restart in a warning line with the way to the dialog, and keeps one number per fact', () => {
  const props = { ...noop, update: stuckView() };
  const html = render(h(UpdateSettings, props));
  assert.match(html, /sh-inline--warning/);
  assert.match(html, /StudyHub 4\.7\.1 没有生效：DSH 重启过，运行的仍是 4\.7\.0。/);
  assert.match(html, /查看处理办法/);
  assert.match(html, /<dt>当前版本<\/dt><dd>4\.7\.0<\/dd>/);
  assert.match(html, /<dt>已安装版本<\/dt><dd>4\.7\.0<\/dd>/, 'this copy\'s version; the marker\'s is named in the sentence');
  assert.match(html, /<dt>最新已知版本<\/dt><dd>4\.7\.1<\/dd>/);
  assert.doesNotMatch(html, /重启 DSH 后生效|当前版本是正在运行的代码|有新版本|已是最新版本/, 'no second wording of the same fact');
  const en = render(h(UpdateSettings, props), 'en');
  assert.match(en, /StudyHub 4\.7\.1 did not take effect: DSH was restarted and 4\.7\.0 is still what runs\./);
  assert.match(en, /See what to do/);
  assert.doesNotMatch(en, han);
  const waiting = render(h(UpdateSettings, { ...noop, update: waitingView() }));
  assert.match(waiting, /已安装 4\.7\.1，重启 DSH 后生效/, 'a restart still to come reads as before');
  assert.doesNotMatch(waiting, /没有生效/);
});
