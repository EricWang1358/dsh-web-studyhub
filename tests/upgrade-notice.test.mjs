/* DSH 0.2.2 loads the new code at once and takes StudyHub's page away around the time the install answers (usually before, once seen just after), so the
   page that asked for the upgrade cannot say how it ended. The dialog says so before and during the install, and the first StudyHub opened on the new code
   says 「已升级到 X」 once. The host half
   (lib/update-check.js, lib/update-install.js) decides when there is something to say; ui/UpdateCenter.jsx says it and tells the host. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { installUpdate } from '../lib/update-install.js';
import { checkForUpdate, currentVersion, markUpdateInstalled, markUpdateInstalling, readUpdateView, releaseFromGithub, setUpdatePreferences, updateStatePath } from '../lib/update-check.js';
import { createHostHandler } from '../lib/host.js';
import { githubRelease } from './helpers/wp15-release.mjs';
import { loadUi } from './helpers/ui-module.mjs';

const OLD = '98.0.0', NEW = '99.0.0';
const PACKAGE = Buffer.from('fake studyhub 99.0.0 tarball bytes');
const sha = createHash('sha256').update(PACKAGE).digest('hex');
const view = () => ({ current: OLD, ...releaseFromGithub(githubRelease(`v${NEW}`)), newer: true });
const releaseHost = async url => String(url).endsWith('.tgz') ? new Response(PACKAGE) : new Response(`${sha}  ericwang1358-dsh-daily-flashcard-${NEW}.tgz\n`);
const saved = async () => JSON.parse(await readFile(updateStatePath(), 'utf8'));
/** What a page asking right now is told, by code of `version`. */
const told = async version => (await readUpdateView({ current: version })).upgraded;
async function home(t) {
  const dir = await mkdtemp(join(tmpdir(), 'upgrade-notice-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  t.after(async () => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; await rm(dir, { recursive: true, force: true }); });
  return dir;
}
const upgrade = installBundle => installUpdate({ view: view(), manager: { installBundle }, fetch: releaseHost, activeJobs: 0 });

test('an ordinary start says nothing: no state, a checked release, or a fresh install of the latest version', async t => {
  await home(t);
  assert.equal(await told(NEW), null);
  const checked = await checkForUpdate({ force: true, current: NEW, fetch: async () => new Response(JSON.stringify(githubRelease(`v${NEW}`))) });
  assert.equal(checked.upgraded, null, 'running the latest release is not an upgrade');
  assert.equal(await told(NEW), null);
});

test('the new code is told even when it asks before the install has answered (DSH hot-reloads it first)', async t => {
  await home(t);
  let during, oldDuring;
  const result = await upgrade(async () => {
    // DSH has loaded the new code and the learner has reopened StudyHub; the old module has not written its restart marker yet.
    oldDuring = await told(OLD);
    during = await told(NEW);
    return { application: 'applied' };
  });
  assert.equal(result.status, 'installed');
  assert.equal(oldDuring, null, 'the old code, still running, has nothing to say');
  assert.equal(during, NEW);
});

test('once a page has said it, no later read says it again, even when the old module writes its marker afterwards', async t => {
  await home(t);
  await upgrade(async () => {
    assert.equal(await told(NEW), NEW);
    const answered = await setUpdatePreferences({ upgradeTold: NEW }, { current: NEW });
    assert.equal(answered.upgraded, null, 'the answer to the page already has nothing left to say');
    return { application: 'applied' };
  });
  assert.equal((await saved()).pending, NEW, 'the old module did write its marker after the page was told');
  for (let read = 0; read < 3; read++) assert.equal(await told(NEW), null, `read ${read + 1}`);
});

test('an upgrade made by an earlier StudyHub, which only leaves the restart marker, is told once', async t => {
  await home(t);
  await markUpdateInstalled(NEW); // all that 5.4.0 wrote
  assert.equal(await told(NEW), NEW);
  assert.equal(await told(NEW), NEW, 'it stays until a page says it has shown it');
  await setUpdatePreferences({ upgradeTold: NEW }, { current: NEW });
  assert.equal(await told(NEW), null);
});

for (const [name, read] of [
  ['a cached check', () => checkForUpdate({ current: NEW, fetch: () => { throw new Error('must not fetch'); } })],
  ['a preference write', () => setUpdatePreferences({ autoCheck: false }, { current: NEW })],
]) {
  test(`whichever read confirms the marker, the notice survives it (${name})`, async t => {
    await home(t);
    await markUpdateInstalled(NEW);
    await setUpdatePreferences({ autoCheck: false }, { current: OLD });
    assert.equal((await read()).upgraded, NEW);
    assert.equal(Object.hasOwn(await saved(), 'pending'), false);
    assert.equal(await told(NEW), NEW);
  });
}

test('a DSH that needs a restart: nothing while the old code runs, told when the new version first runs', async t => {
  await home(t);
  await upgrade(async () => ({ application: 'restart-required' }));
  const waiting = await readUpdateView({ current: OLD });
  assert.equal(waiting.upgraded, null);
  assert.equal(waiting.pendingRestart, NEW, 'the restart wording and chip are unchanged');
  assert.equal(await told(NEW), NEW);
});

test('only the version the upgrade went to is announced, never a look-alike or a later one', async t => {
  await home(t);
  await upgrade(async () => ({ application: 'applied' }));
  for (const other of [`${NEW}-rc.1`, '99.0.1', '100.0.0', '9.9.0']) assert.equal(await told(other), null, other);
  assert.equal(await told(NEW), NEW);
  await setUpdatePreferences({ upgradeTold: '100.0.0' }, { current: NEW });
  assert.equal(await told(NEW), NEW, 'a page naming another version does not use this one up');
});

for (const [name, installBundle] of [
  ['DSH refuses the package', async () => ({ application: 'failed', error: { code: 'operation-error' } })],
  ['DSH cancels it', async () => ({ application: 'cancelled' })],
  ['the plugin manager throws', async () => { throw new Error('pnpm exited with 1'); }],
]) {
  test(`a failed install leaves nothing to announce (${name})`, async t => {
    await home(t);
    await assert.rejects(upgrade(installBundle), error => error.code === 'UPDATE_INSTALL');
    assert.equal(await told(OLD), null);
    assert.equal(await told(NEW), null, 'even if that version arrives another way later');
  });
}

// Review of #1733: two guards in lib/update-check.js had no test (removing either kept every test green).
test('a notice a page has already shown stays shown when the install then fails, even if the marker for that version comes later', async t => {
  await home(t);
  await assert.rejects(upgrade(async () => {
    assert.equal(await told(NEW), NEW);
    await setUpdatePreferences({ upgradeTold: NEW }, { current: NEW });
    throw new Error('pnpm exited with 1 after DSH had loaded the new code');
  }), error => error.code === 'UPDATE_INSTALL');
  assert.deepEqual((await saved()).announce, { version: NEW, told: true }, 'the shown notice is kept, not taken back');
  await markUpdateInstalled(NEW);
  assert.equal(await told(NEW), null, 'never said a second time');
});

test('a restart marker for the running version leaves a later announced upgrade alone', async t => {
  await home(t);
  await markUpdateInstalled(NEW);
  await markUpdateInstalling('100.0.0');
  assert.equal(await told(NEW), null, 'the upgrade under way is to 100.0.0, so 99.0.0 is not announced over it');
  assert.equal((await saved()).announce.version, '100.0.0');
});

test('installing the same version again is announced again', async t => {
  await home(t);
  await upgrade(async () => ({ application: 'applied' }));
  await setUpdatePreferences({ upgradeTold: NEW }, { current: NEW });
  assert.equal(await told(NEW), null);
  await upgrade(async () => ({ application: 'applied' }));
  assert.equal(await told(NEW), NEW);
});

test('the announcement leaves the rest of the update state as it was, and refuses a value that is not a version', async t => {
  await home(t);
  await setUpdatePreferences({ autoCheck: false, snooze: '97.0.0' }, { current: OLD });
  await upgrade(async () => ({ application: 'applied' }));
  await setUpdatePreferences({ upgradeTold: NEW }, { current: NEW });
  const file = await saved();
  assert.equal(file.autoCheck, false);
  assert.equal(file.snoozed, '97.0.0');
  assert.ok(file.installedAt);
  for (const bad of ['soon', '', 5, null]) await assert.rejects(setUpdatePreferences({ upgradeTold: bad }, { current: NEW }), /version/, String(bad));
});

test('the panel reaches both through its own operations: update.check says it, update.preferences uses it up', async t => {
  const dir = await home(t);
  await markUpdateInstalled(currentVersion());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(githubRelease(`v${currentVersion()}`)));
  t.after(() => { globalThis.fetch = realFetch; });
  const ctx = { sessions: { get: () => ({ header: { cwd: dir } }) }, get: () => undefined };
  const handle = createHostHandler(ctx, { libraryRoot: join(dir, 'library') });
  const call = async (action, args = {}) => {
    const answer = await handle('call', { sessionId: 's', action, args });
    assert.equal(answer.ok, true, answer.error?.message);
    return answer.value;
  };
  assert.equal((await call('update.check')).upgraded, currentVersion());
  assert.equal((await call('update.preferences', { upgradeTold: currentVersion() })).upgraded, null);
  assert.equal((await call('update.check')).upgraded, null);
});

/* ── the page ─────────────────────────────────────────────────────────── */

const ui = await loadUi(`
  export * from './ui/UpdateCenter.jsx';
  export { ANY_PAGE, noticeVisible, bindNotice, reviewNoticeScope } from './ui/ActionFeedback.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';`);
const han = /[㐀-鿿]/;
const render = (props, language = 'zh') => {
  ui.setUiLanguage(language);
  try {
    return renderToStaticMarkup(React.createElement(ui.StudyServicesContext.Provider, { value: { call: async () => ({}) } },
      React.createElement(ui.UpdateDialog, { onClose() {}, ...props })));
  } finally { ui.setUiLanguage('zh'); }
};
const offer = { current: '2.1.0', latest: '2.1.1', newer: true, publishedAt: '2026-10-05T08:00:00Z', notes: '', url: 'https://github.com/EricWang1358/dsh-web-studyhub/releases/tag/v2.1.1',
  assetUrl: 'https://github.com/EricWang1358/dsh-web-studyhub/releases/download/v2.1.1/ericwang1358-dsh-daily-flashcard-2.1.1.tgz', autoCheck: true, snoozed: false, pendingRestart: null,
  install: { available: true, desktop: false } };

test('before the upgrade the dialog says the page may close, how to come back and what will confirm it; it promises no restart', () => {
  const idle = render({ update: offer });
  assert.doesNotMatch(idle, /安装后重启 DSH 即可使用新版本/, 'DSH 0.2.2 needs no restart');
  assert.match(idle, /SHA256/);
  const confirm = render({ update: offer, initialPhase: { phase: 'confirm' } });
  assert.match(confirm, /DSH 可能在安装时关掉本页/);
  assert.match(confirm, /重新打开 StudyHub/);
  assert.match(confirm, /「已升级到 2\.1\.1」/);
  assert.match(confirm, /需要重启 DSH/, 'a DSH that does need a restart is not contradicted');
  assert.doesNotMatch(confirm, /安装完成后要重启 DSH/);
  const en = render({ update: offer, initialPhase: { phase: 'confirm' } }, 'en');
  assert.match(en, /DSH may close this page/);
  assert.match(en, /Upgraded to 2\.1\.1/);
  assert.doesNotMatch(en, han);
});

test('during the install the dialog says a closed page does not stop it', () => {
  const working = render({ update: offer, initialPhase: { phase: 'working' } });
  assert.match(working, /正在下载并校验安装包，然后交给 DSH 安装…/);
  assert.match(working, /本页被关掉也不影响安装，过一会儿重新打开 StudyHub 即可。/);
  assert.equal(working.match(/role="status"/g)?.length, 1, 'one live region says both');
  const en = render({ update: offer, initialPhase: { phase: 'working' } }, 'en');
  assert.match(en, /If this page closes, the install carries on/);
  assert.doesNotMatch(en, han);
  for (const phase of [{ phase: 'idle' }, { phase: 'confirm' }, { phase: 'jobs', jobs: 1 }, { phase: 'error', code: 'UPDATE_INSTALL' }])
    assert.doesNotMatch(render({ update: offer, initialPhase: phase }), /本页被关掉也不影响安装/, phase.phase);
});

/* The "installed" page is the first thing a learner reads after the install answers. DSH 0.2.2 answers 'applied' (the new code is already running, restartRequired
   false); an older DSH answers 'restart-required'. Each case has its own sentence: telling the first to restart DSH sends them off to fix nothing. */
const installedOf = (restartRequired, desktop = false) => ({ phase: 'installed', version: '2.1.1', restartRequired, desktop });
const RESTART_WORDS = /等待重启|请重启 DSH 服务|请完全退出 DSH 桌面版|仍在运行旧版本|重启后还看到/;
const RESTART_WORDS_EN = /waiting for a restart|Restart the DSH service|Quit DSH desktop|keeps running the old version|after a restart/;

test('after an install that took effect at once the dialog says the new version is running and nothing needs a restart', () => {
  for (const desktop of [false, true]) {
    const applied = render({ update: { ...offer, install: { available: true, desktop } }, initialPhase: installedOf(false, desktop) });
    assert.match(applied, /StudyHub 2\.1\.1 已升级/, 'the title');
    assert.match(applied, /已升级到 2\.1\.1/, 'the same words as the notice the new version shows');
    assert.match(applied, /不用重启 DSH/);
    assert.match(applied, /重新打开 StudyHub/, 'this page is the old code; opening StudyHub again shows the new version');
    assert.doesNotMatch(applied, RESTART_WORDS, `desktop ${desktop}`);
    const en = render({ update: { ...offer, install: { available: true, desktop } }, initialPhase: installedOf(false, desktop) }, 'en');
    assert.match(en, /StudyHub 2\.1\.1 has been upgraded/);
    assert.match(en, /Upgraded to 2\.1\.1/);
    assert.match(en, /No need to restart DSH/);
    assert.match(en, /open StudyHub again/);
    assert.doesNotMatch(en, RESTART_WORDS_EN, `desktop ${desktop}`);
    assert.doesNotMatch(en, han);
  }
});

test('after an install that needs a restart the dialog still says it is waiting for one, in the words of the sidebar chip', () => {
  for (const [desktop, step] of [[false, /重启 DSH 服务/], [true, /完全退出 DSH 桌面版/]]) {
    for (const phase of [installedOf(true, desktop), { phase: 'installed', version: '2.1.1', desktop }]) {
      const html = render({ update: { ...offer, install: { available: true, desktop } }, initialPhase: phase });
      assert.match(html, /StudyHub 2\.1\.1 等待重启/);
      assert.match(html, /已安装 2\.1\.1/);
      assert.match(html, step);
      assert.match(html, /重启前，当前页面仍在运行旧版本/);
      assert.doesNotMatch(html, /已升级到|不用重启/, 'a restart is needed, so it is not said to be upgraded');
    }
    const en = render({ update: { ...offer, install: { available: true, desktop } }, initialPhase: installedOf(true, desktop) }, 'en');
    assert.match(en, /StudyHub 2\.1\.1 is waiting for a restart/);
    assert.match(en, /2\.1\.1 installed/);
    assert.doesNotMatch(en, /Upgraded to|No need to restart/);
    assert.doesNotMatch(en, han);
  }
});

test('the install answer decides which installed page the dialog shows', async () => {
  const answer = restartRequired => ui.startUpgrade(async () => ({ status: 'installed', version: '2.1.1', restartRequired }), { latest: '2.1.1' });
  assert.match(render({ update: offer, initialPhase: await answer(false) }), /不用重启 DSH/);
  assert.match(render({ update: offer, initialPhase: await answer(true) }), /等待重启/);
});

test('an install answer that does not say whether a restart is needed keeps the restart wording (an older DSH)', async () => {
  const phase = await ui.startUpgrade(async () => ({ status: 'installed', version: '2.1.1' }), { latest: '2.1.1' });
  assert.equal(phase.restartRequired, true, 'no field is not "applied"');
  const html = render({ update: offer, initialPhase: phase });
  assert.match(html, /StudyHub 2\.1\.1 等待重启/);
  assert.match(html, /重启前，当前页面仍在运行旧版本/);
  assert.doesNotMatch(html, /已升级到|不用重启/);
});

test('the notice is said once per version in a page, then reported to the host', async () => {
  const shown = [], calls = [];
  const toast = { success: (message, options) => shown.push({ message, options }) };
  const call = async (action, args) => { calls.push([action, args]); return { upgraded: null }; };
  const said = new Set();
  for (const update of [null, {}, { upgraded: null, current: '2.1.1' }]) await ui.announceUpgrade(update, { call, toast, said, running: '2.1.1' });
  assert.deepEqual([shown, calls], [[], []], 'nothing to say, nothing asked');
  await ui.announceUpgrade({ upgraded: '2.1.1' }, { call, toast, said, running: '2.1.1' });
  await ui.announceUpgrade({ upgraded: '2.1.1' }, { call, toast, said, running: '2.1.1' });
  assert.equal(shown.length, 1, 'a second seat, or the same answer again, does not repeat it');
  assert.equal(shown[0].message, '已升级到 2.1.1');
  assert.equal(shown[0].options.scope, ui.ANY_PAGE, 'the start page may move while the answer arrives');
  assert.ok(shown[0].options.timeout > 6000, 'it stays longer than a routine toast, then leaves by itself');
  assert.equal(shown[0].options.action, undefined, 'no extra control');
  assert.deepEqual(calls, [['update.preferences', { upgradeTold: '2.1.1' }]]);
  await ui.announceUpgrade({ upgraded: '2.1.2' }, { call: async () => { throw new Error('host gone'); }, toast, said, running: '2.1.2' });
  assert.equal(shown.length, 2, 'a later version is said too, and a lost report does not break the page');
});

test('a StudyHub that was open when the install was asked for says nothing and uses nothing up: the news is for one opened afterwards', async () => {
  const shown = [], calls = [];
  const toast = { success: message => shown.push(message) };
  const call = async (action) => { calls.push(action); return action === 'update.install' ? { status: 'installed', version: '3.0.0', restartRequired: false } : {}; };
  await ui.startUpgrade(call, { latest: '3.0.0' });
  // DSH has not closed the page yet, and its dialog has already heard of the upgrade from the new code. This page is still the code of 2.9.0.
  await ui.announceUpgrade({ upgraded: '3.0.0' }, { call, toast, said: new Set(), running: '2.9.0' });
  assert.deepEqual(shown, []);
  assert.deepEqual(calls, ['update.install'], 'nothing is reported to the host');
  // The StudyHub opened afterwards runs the code of 3.0.0 (a module of its own, with its own record of what it said).
  await ui.announceUpgrade({ upgraded: '3.0.0' }, { call, toast, said: new Set(), running: '3.0.0' });
  assert.deepEqual(shown, ['已升级到 3.0.0']);
  assert.deepEqual(calls, ['update.install', 'update.preferences']);
});

/* The page that asked is not the only old code that hears of the upgrade on a host that loads the new code at once (DSH 0.2.2): another StudyHub
   window or tab still on the old code, or an <UpdateWatch> mounted again in the old module (App's loading state during a library switch), hears
   update.check say `upgraded` too. Only the code of that very version may say it: anything older would use the notice up before the new code is on screen. */
test('only the code of the announced version says it: another window, or an UpdateWatch mounted again, still on the old code says nothing and uses nothing up', async () => {
  const shown = [], calls = [];
  const toast = { success: message => shown.push(message) };
  const call = async (action, args) => { calls.push([action, args]); return {}; };
  const oldModule = new Set();
  for (let mount = 0; mount < 3; mount += 1) await ui.announceUpgrade({ upgraded: '3.0.0' }, { call, toast, said: oldModule, running: '2.9.0' });
  await ui.announceUpgrade({ upgraded: '3.0.0' }, { call, toast, said: new Set(), running: '3.0.1' });
  assert.deepEqual([shown, calls], [[], []], 'an older or a later build says nothing and reports nothing');
  await ui.announceUpgrade({ upgraded: '3.0.0' }, { call, toast, said: new Set(), running: '3.0.0' });
  assert.deepEqual(shown, ['已升级到 3.0.0']);
  assert.deepEqual(calls, [['update.preferences', { upgradeTold: '3.0.0' }]]);
});

test('the page knows its own version from package.json, the file the host reads for the running version, and says only that one', async () => {
  assert.equal(ui.UI_BUILD_VERSION, currentVersion(), 'one source of truth for both halves');
  const shown = [];
  const toast = { success: message => shown.push(message) };
  const call = async () => ({});
  await ui.announceUpgrade({ upgraded: '0.0.1' }, { call, toast, said: new Set() });
  assert.deepEqual(shown, [], 'not this build');
  await ui.announceUpgrade({ upgraded: currentVersion() }, { call, toast, said: new Set() });
  assert.deepEqual(shown, [`已升级到 ${currentVersion()}`]);
});

test('a notice for any page survives a page change; the others still stay on their page', () => {
  const library = ui.reviewNoticeScope('/lib', 'library', null), board = ui.reviewNoticeScope('/lib', 'board', null);
  const anywhere = ui.bindNotice({ id: 1, value: { text: '已升级到 2.1.1', scope: ui.ANY_PAGE } }, library);
  assert.equal(ui.noticeVisible(anywhere, board), true);
  assert.equal(ui.noticeVisible(ui.bindNotice({ id: 2, value: '已保存' }, library), board), false);
});
