import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { createRetrievalHandlers } from '../lib/contexts/generation/retrieval-operations.js';
import { INDEX_TOOLS } from '../lib/retrieval-index.js';
import {
  EXTENSION_PACKAGE,
  STARTUP_GRACE_MS,
  classifyRetrievalStatus,
  extensionAssetName,
  extensionState,
  installExtension,
  uninstallExtension,
} from '../lib/retrieval-extension.js';
import { nativeSelects } from './helpers/native-selects.mjs';
import { withStudy } from './helpers/study-services.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const COMPANION = `mcp:${INDEX_TOOLS.query}`;
const FORBIDDEN_ZH = /您|请勿|必须|暂无|宿主|插件/;
const HAN = /[\u3400-\u9fff]/;

const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: {
    contents: `
      export { default as ExtensionPanel, ExtensionUpdateNotice } from './ui/ExtensionPanel.jsx';
      export { default as ExtensionNotStarted } from './ui/ExtensionNotStarted.jsx';
      export { default as ExtensionsSettings, endpointSavedMessage } from './ui/ExtensionsSettings.jsx';
      export { UpdateSettings } from './ui/UpdateCenter.jsx';
      export { StudyServicesContext } from './ui/study-context.jsx';
      export { setUiLanguage } from './ui/i18n.js';
    `,
    resolveDir: process.cwd(),
  },
  bundle: true, write: false, platform: 'node', format: 'cjs',
  external: ['react', 'react-dom'], plugins: [nativeSelects],
  loader: { '.css': 'text', '.json': 'json' }, logLevel: 'silent',
});
const uiMod = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, uiMod, uiMod.exports);
const {
  ExtensionPanel,
  ExtensionUpdateNotice,
  ExtensionNotStarted,
  ExtensionsSettings,
  endpointSavedMessage,
  UpdateSettings,
  StudyServicesContext,
  setUiLanguage,
} = uiMod.exports;

const h = React.createElement;
const render = (el, lang = 'zh', over = {}) => {
  setUiLanguage(lang);
  try { return renderToStaticMarkup(withStudy(StudyServicesContext, el, over)); }
  finally { setUiLanguage('zh'); }
};

function releaseFetch(version) {
  const bytes = Buffer.from(`fake-extension-${version}`);
  const sum = createHash('sha256').update(bytes).digest('hex');
  const sums = `${sum}  ${extensionAssetName(version)}\n`;
  return async url => {
    const body = String(url).endsWith('.tgz') ? bytes : Buffer.from(sums, 'utf8');
    return { ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
  };
}

function fakeCtx({ bundles, desktop = true, application = 'restart-required' }) {
  let list = bundles.map(item => ({ ...item }));
  const manager = {
    listBundles: async () => list.map(item => ({ ...item })),
    removeBundle: async name => {
      list = list.filter(item => item.name !== name);
      return { changed: true, application: 'applied' };
    },
    installBundle: async (_spec, options = {}) => {
      const existing = list.find(item => item.name === EXTENSION_PACKAGE);
      if (existing) return { changed: false, application: 'failed', error: { code: 'ambiguous-install' } };
      list.push({ name: EXTENSION_PACKAGE, version: manager.nextVersion || '4.7.0', installed: true, enabled: options.enabled !== false });
      return { changed: true, application };
    },
    nextVersion: '4.7.0',
    setBundles(next) { list = next.map(item => ({ ...item })); },
  };
  const ctx = {
    get: name => (name === 'pluginManager' ? manager : name === 'profileContext' ? { name: desktop ? 'desktop' : 'web' } : undefined),
  };
  return { ctx, manager };
}

test('#956 tray-quit copy: desktop explicitly names quitting DSH including the tray icon across StartupWait, ExtensionUpdateNotice, ExtensionNotStarted, and ExtensionsSettings; web does not', () => {
  const base = { selected: 'builtin', effective: 'builtin', hostCanSearch: false, providers: [], otherTools: [], companion: { id: COMPANION, running: false }, boot: 'b1' };

  for (const desktop of [true, false]) {
    const startupStatus = { ...base, extension: { canInstall: true, installed: true, enabled: true, version: '4.7.0', desktop } };
    const outdatedStatus = { ...base, extension: { canInstall: true, installed: true, enabled: true, version: '3.6.3', outdated: true, expected: '4.7.0', desktop } };
    const pendingStatus = { ...base, extension: { canInstall: true, installed: true, enabled: true, version: '4.7.0', pendingRestart: '4.7.0', desktop } };
    const stoppedStatus = { ...base, companion: { id: COMPANION, running: false, notStarted: true }, extension: { canInstall: true, installed: true, enabled: true, version: '4.7.0', desktop } };

    const startupZh = render(h(ExtensionPanel, { status: startupStatus }));
    const outdatedZh = render(h(ExtensionUpdateNotice, { status: outdatedStatus }));
    const pendingZh = render(h(ExtensionUpdateNotice, { status: pendingStatus }));
    const stoppedZh = render(h(ExtensionNotStarted, { status: stoppedStatus, refresh: () => {}, repair: async () => {} }));
    const settingsZh = render(h(ExtensionsSettings, { initialStatus: startupStatus, courses: [] }));
    const savedToastZh = endpointSavedMessage('https://hf-mirror.com', desktop);
    const clearedToastZh = endpointSavedMessage('', desktop);

    for (const text of [startupZh, outdatedZh, pendingZh, stoppedZh, savedToastZh, clearedToastZh]) {
      assert.doesNotMatch(text, /title="/, 'no native HTML title attribute');
      if (desktop) assert.match(text, /托盘图标/, `desktop copy must mention tray icon: ${text.slice(0, 120)}`);
      else assert.doesNotMatch(text, /托盘图标/, `non-desktop copy must not mention tray icon: ${text.slice(0, 120)}`);
    }
    if (desktop) assert.match(settingsZh, /改动在完全退出 DSH 桌面版（包括托盘图标）后重新打开时生效/);
    else assert.match(settingsZh, /改动在重启 DSH 后生效/);

    // New sentences follow voice-and-tone rules (no forbidden words in newly rendered notices).
    for (const snippet of [startupZh, outdatedZh, pendingZh, stoppedZh, savedToastZh, clearedToastZh]) {
      assert.doesNotMatch(snippet, FORBIDDEN_ZH);
    }

    // English translations have zero untranslated Chinese characters and mention tray icon on desktop.
    for (const el of [
      h(ExtensionPanel, { status: startupStatus }),
      h(ExtensionUpdateNotice, { status: outdatedStatus }),
      h(ExtensionUpdateNotice, { status: pendingStatus }),
      h(ExtensionNotStarted, { status: stoppedStatus, refresh: () => {}, repair: async () => {} }),
      h(ExtensionsSettings, { initialStatus: startupStatus, courses: [] }),
    ]) {
      const en = render(el, 'en');
      assert.doesNotMatch(en, HAN);
      if (desktop) assert.match(en, /tray icon/i);
    }
    setUiLanguage('en');
    try {
      const toastEn = endpointSavedMessage('https://hf-mirror.com', desktop);
      assert.doesNotMatch(toastEn, HAN);
      if (desktop) assert.match(toastEn, /tray icon/i);
    } finally { setUiLanguage('zh'); }
  }
});

test('#956 persistent pendingRestart & restartFailed: survives tab switches / close-to-tray, avoids double banner on first install, and detects stuck restart', async t => {
  const where = await mkdtemp(join(tmpdir(), 'ext-restart-'));
  t.after(() => rm(where, { recursive: true, force: true, maxRetries: 3 }));

  const T0 = Date.parse('2026-11-10T10:00:00.000Z');
  const boot1 = T0 - 30_000;
  const boot2 = T0 + 60_000;

  // 1. First-time install with restart-required does NOT set pendingRestart or render "这次更新要重启...".
  const fresh = fakeCtx({ bundles: [], desktop: true, application: 'restart-required' });
  fresh.manager.nextVersion = '4.7.0';
  const firstInstall = await installExtension({ manager: fresh.manager, version: '4.7.0', fetch: releaseFetch('4.7.0'), dir: where, now: () => T0, startedAt: boot1 });
  assert.equal(firstInstall.restartRequired, true);
  const afterFirst = await extensionState(fresh.ctx, '4.7.0', { since: '4.6.2', startedAt: boot1, dir: where });
  assert.equal(afterFirst.installed, true);
  assert.equal(afterFirst.pendingRestart, undefined, 'first-time install is not an update');
  const firstPanel = render(h(ExtensionPanel, {
    status: { selected: 'builtin', effective: 'builtin', providers: [], otherTools: [], companion: { id: COMPANION, running: false }, boot: 'b1', extension: afterFirst },
  }));
  assert.match(firstPanel, /检索扩展已安装/);
  assert.doesNotMatch(firstPanel, /这次更新要/, 'first-time install must never show the update restart banner alongside StartupWait');

  // 2. Updating an already-installed extension (3.6.3 -> 4.7.0) with restart-required persists pendingRestart across remounts in the same process.
  const updating = fakeCtx({
    bundles: [{ name: EXTENSION_PACKAGE, version: '3.6.3', installed: true, enabled: true }],
    desktop: true,
    application: 'restart-required',
  });
  updating.manager.nextVersion = '4.7.0';
  const beforeUpdate = await extensionState(updating.ctx, '4.7.0', { since: '4.6.2', startedAt: boot1, dir: where });
  assert.equal(beforeUpdate.outdated, true);

  // Even if wall clock moved back after boot1 (clockBack > T0), same installedBy keeps pendingRestart (never false restartFailed).
  const clockBackBoot = T0 + 15_000;
  await installExtension({ manager: updating.manager, version: '4.7.0', fetch: releaseFetch('4.7.0'), dir: where, now: () => T0, startedAt: clockBackBoot });

  const sameProc = await extensionState(updating.ctx, '4.7.0', { since: '4.6.2', startedAt: clockBackBoot + 1000, dir: where });
  assert.equal(sameProc.outdated, undefined, 'bundle on disk is now 4.7.0');
  assert.equal(sameProc.pendingRestart, '4.7.0', 'backend remembers this process still runs the old MCP server');
  assert.equal(sameProc.restartFailed, undefined);

  // Remounting ExtensionPanel or UpdateSettings from scratch (tab switch / close window to tray) still renders the restart notice!
  const remountedStatus = {
    selected: COMPANION, effective: COMPANION, providers: [], otherTools: [],
    companion: { id: COMPANION, running: true }, boot: 'b1', extension: sameProc,
  };
  const remountedPanel = render(h(ExtensionPanel, { status: remountedStatus, initialPlan: { pages: 0, toIndex: 0, unchanged: 0, toRemove: 0, canIndex: true } }));
  assert.match(remountedPanel, /检索扩展已更新/);
  assert.match(remountedPanel, /托盘图标/);

  const aboutSettings = render(h(UpdateSettings, {
    update: { current: '4.7.0', installed: '4.7.0', latest: '4.7.0', checkedAt: new Date(T0).toISOString(), autoCheck: true },
    retrievalStatus: remountedStatus,
    extension: sameProc,
  }));
  assert.match(aboutSettings, /检索扩展已更新/);
  assert.doesNotMatch(aboutSettings, /已是最新版本/, 'UpdateSettings does not say everything is up to date while extension awaits restart');

  // 3. New process (boot2 > T0, different installedBy) where another profile took the update so this profile still has 3.6.3 -> restartFailed!
  updating.manager.setBundles([{ name: EXTENSION_PACKAGE, version: '3.6.3', installed: true, enabled: true }]);
  const stuckExt = await extensionState(updating.ctx, '4.7.0', { since: '4.6.2', startedAt: boot2, dir: where });
  assert.equal(stuckExt.pendingRestart, undefined);
  assert.deepEqual(stuckExt.restartFailed, { pending: '4.7.0', running: '3.6.3', installedAt: new Date(T0).toISOString() });

  const stuckNoticeZh = render(h(ExtensionUpdateNotice, { status: { ...remountedStatus, extension: stuckExt } }));
  assert.match(stuckNoticeZh, /检索扩展 4\.7\.0 没有生效/);
  assert.match(stuckNoticeZh, /重新安装检索扩展/);
  assert.doesNotMatch(stuckNoticeZh, FORBIDDEN_ZH);
  assert.doesNotMatch(render(h(ExtensionUpdateNotice, { status: { ...remountedStatus, extension: stuckExt } }), 'en'), HAN);

  // Another profile where the search extension was never installed at all does not inherit a false restartFailed banner.
  updating.manager.setBundles([]);
  const uninstalledProfile = await extensionState(updating.ctx, '4.7.0', { since: '4.6.2', startedAt: boot2, dir: where });
  assert.equal(uninstalledProfile.installed, false);
  assert.equal(uninstalledProfile.restartFailed, undefined);

  // 4. New process where 4.7.0 IS active on disk -> marker consumed and cleared!
  updating.manager.setBundles([{ name: EXTENSION_PACKAGE, version: '4.7.0', installed: true, enabled: true }]);
  const activeExt = await extensionState(updating.ctx, '4.7.0', { since: '4.6.2', startedAt: boot2, dir: where });
  assert.equal(activeExt.pendingRestart, undefined);
  assert.equal(activeExt.restartFailed, undefined);
  assert.equal(render(h(ExtensionUpdateNotice, { status: { ...remountedStatus, extension: activeExt } })), '');

  // 5. Two-step update requiring build-script approval (removeBundle on step 1 -> approvedBuilds on step 2) still records pendingRestart, and uninstall removes it.
  updating.manager.setBundles([{ name: EXTENSION_PACKAGE, version: '3.6.3', installed: true, enabled: true }]);
  const baseInstallBundle = updating.manager.installBundle;
  updating.manager.installBundle = async (spec, options = {}) => {
    const existing = (await updating.manager.listBundles()).find(item => item.name === EXTENSION_PACKAGE);
    if (existing) return { changed: false, application: 'failed', error: { code: 'ambiguous-install' } };
    if (!options.approvedBuilds?.length) return { changed: false, application: 'failed', pendingBuilds: ['onnxruntime-node'] };
    return baseInstallBundle(spec, options);
  };
  const step1 = await installExtension({ manager: updating.manager, version: '4.7.0', fetch: releaseFetch('4.7.0'), dir: where, now: () => T0, startedAt: boot1 });
  assert.deepEqual(step1, { status: 'needs-approval', pending: ['onnxruntime-node'] });
  const step2 = await installExtension({ manager: updating.manager, version: '4.7.0', fetch: releaseFetch('4.7.0'), dir: where, approvedBuilds: ['onnxruntime-node'], now: () => T0, startedAt: boot1 });
  assert.equal(step2.status, 'installed');
  assert.equal((await extensionState(updating.ctx, '4.7.0', { since: '4.6.2', startedAt: boot1, dir: where })).pendingRestart, '4.7.0');
  await uninstallExtension({ manager: updating.manager, dir: where });
  assert.equal((await extensionState(updating.ctx, '4.7.0', { since: '4.6.2', startedAt: boot1, dir: where })).pendingRestart, undefined);
});

test('#956 ExtensionNotStarted escape hatch: keeps DiagnosticBar after repair in same session, and breaks infinite repair loop if service still fails after restart', async t => {
  const baseDir = join(repo, 'output', 'test-retrieval-restart-repair');
  await mkdir(baseDir, { recursive: true });
  const home = await mkdtemp(join(baseDir, 'home-'));
  const root = await mkdtemp(join(baseDir, 'lib-'));
  const before = process.env.DSH_HOME;
  process.env.DSH_HOME = home;

  const portState = { running: false };
  const port = {
    tools: () => (portState.running ? Object.values(INDEX_TOOLS).map(name => ({ name, description: name, parameters: { type: 'object', properties: {} } })) : []),
    call: async () => ({ content: [{ type: 'text', text: '{"ok":true}' }] }),
  };
  const service = new StudyService(root, { complete: createFakeModel(), coach: false, retrieval: port });

  t.after(async () => {
    await service.dispose();
    if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before;
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
    await rm(home, { recursive: true, force: true, maxRetries: 3 });
  });

  const ext = { canInstall: true, installed: true, enabled: true, version: '4.7.0', desktop: true };

  // 1. User clicks repair in current process: status.companion.reset.pendingRestart is true, Repair button hides, DiagnosticBar stays visible!
  const repairResult = await service.call('retrieval.index.repair', {});
  const sameSessionStatus = classifyRetrievalStatus(await service.call('retrieval.status', {}), ext, { uptimeMs: STARTUP_GRACE_MS + 1000 });
  assert.equal(sameSessionStatus.companion.reset?.reason, 'repair');
  assert.equal(sameSessionStatus.companion.reset?.pendingRestart, true);

  const awaitingRestartHtml = render(h(ExtensionNotStarted, { status: sameSessionStatus, refresh: () => {}, repair: async () => {} }));
  assert.match(awaitingRestartHtml, /已修复/);
  assert.match(awaitingRestartHtml, /托盘图标/);
  assert.doesNotMatch(awaitingRestartHtml, />修复</, 'Repair button is hidden while awaiting restart');
  assert.match(awaitingRestartHtml, /复制诊断信息/, 'DiagnosticBar stays visible after repair');
  assert.match(awaitingRestartHtml, /发给主会话/, 'HandOff to main chat stays visible after repair');
  assert.doesNotMatch(awaitingRestartHtml, FORBIDDEN_ZH);
  assert.doesNotMatch(render(h(ExtensionNotStarted, { status: sameSessionStatus, refresh: () => {}, repair: async () => {} }), 'en'), HAN);

  // 2. Simulate a NEW process started AFTER repairResult.at where the search service STILL did not start!
  const restartedHandlers = createRetrievalHandlers({
    state: { root, read: async () => ({ sources: [] }) },
    retrieval: port,
    processStartedAt: Date.parse(repairResult.at) + 60_000,
    clearRepairSessionForTest: true,
  });
  const postRestartRaw = await restartedHandlers['retrieval.status']();
  const postRestartStatus = classifyRetrievalStatus(postRestartRaw, ext, { uptimeMs: STARTUP_GRACE_MS + 1000 });
  assert.equal(postRestartStatus.companion.notStarted, true);
  assert.equal(postRestartStatus.companion.reset?.restartedAfterRepair, true);

  const postRestartHtml = render(h(ExtensionNotStarted, { status: postRestartStatus, refresh: () => {}, repair: async () => {} }));
  assert.doesNotMatch(postRestartHtml, /还不行就点修复/, 'must not trap user in an infinite repair loop after restarting');
  assert.doesNotMatch(postRestartHtml, />修复</, 'Repair button is not offered again on an already-reset index');
  assert.match(postRestartHtml, /上次已重置过索引并重启了 DSH/);
  assert.match(postRestartHtml, /发给主会话/);
  assert.match(postRestartHtml, /复制诊断信息/);
  assert.doesNotMatch(postRestartHtml, FORBIDDEN_ZH);
  assert.doesNotMatch(render(h(ExtensionNotStarted, { status: postRestartStatus, refresh: () => {}, repair: async () => {} }), 'en'), HAN);
});
