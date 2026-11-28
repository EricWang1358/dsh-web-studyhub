// #1436 Batch 4 Item 8:
// Corrupt `desktop.json` must:
// 1) Report `configProblem` from `configStore.load()`, `desktop.config.get`, and `binding.get`
// 2) Keep default refuse-to-overwrite guard on `save` / `saveLibraryRoot` / `confirmLibraryPlace` with stable `code: 'config-corrupt'` + Chinese error localization
// 3) Provide explicit `desktop.config.recover` that backs up `.corrupt-<ts>.bak` and resets cleanly so settings/folder switching unlock
// 4) Hide misleading DesktopLibraryPlace welcome card when `configProblem` is set and offer one-click 「备份并重置配置」
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { createConfigStore } from '../packages/studyhub-desktop/adapters/storage/config-store.mjs';
import { formatCallError } from '../packages/studyhub-desktop/application/desktop-errors.js';
import { createDesktopHost } from '../packages/studyhub-desktop/application/desktop-host.js';
import { click, loadInteractiveUi, withBrowserGlobals } from './helpers/react-harness.mjs';

const require = createRequire(import.meta.url);

test('#1436 Item 8a: configStore.load exposes configProblem, refusal carries code config-corrupt, and recover() backs up & unlocks', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'studyhub-1436-item8-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const store = createConfigStore({ env: { DSH_HOME: dir }, home: dir, documentsDir: join(dir, 'docs') });
  mkdirSync(dirname(store.configPath), { recursive: true });
  const corruptRaw = '{"mode":"openai","openai":{"apiKey":"sk-broken"';
  writeFileSync(store.configPath, corruptRaw, 'utf8');

  // 1) load() surfaces configProblem instead of silently pretending fresh install
  const loaded = await store.load();
  assert.ok(loaded.configProblem, 'load() must report configProblem when desktop.json is corrupt');
  assert.equal(loaded.configProblem.code, 'config-corrupt');
  assert.equal(loaded.configProblem.path, store.configPath);

  // 2) save / saveLibraryRoot / confirmLibraryPlace still refuse by default with stable code 'config-corrupt'
  await assert.rejects(
    store.save({ mode: 'openai' }),
    (err) => err?.code === 'config-corrupt' && /refusing to overwrite|could not be read/i.test(err.message),
    'save() must refuse overwrite by default with code config-corrupt',
  );
  await assert.rejects(
    store.confirmLibraryPlace(),
    (err) => err?.code === 'config-corrupt',
    'confirmLibraryPlace() must refuse with code config-corrupt',
  );
  assert.equal(readFileSync(store.configPath, 'utf8'), corruptRaw, 'corrupt file must remain untouched until explicit recover');

  // Localized Chinese & English error messages via formatCallError
  const zhErr = formatCallError(Object.assign(new Error('raw'), { code: 'config-corrupt' }), 'zh');
  assert.match(zhErr.error, /配置文件.*损坏|备份并重置/);
  const enErr = formatCallError(Object.assign(new Error('raw'), { code: 'config-corrupt' }), 'en');
  assert.match(enErr.error, /corrupt|reset/i);

  // 3) Explicit recover() backs up corrupt file and writes valid defaults
  const rec = await store.recover();
  assert.equal(rec.recovered, true);
  assert.ok(rec.backupPath && rec.backupPath.includes('.corrupt-'));
  const files = readdirSync(dirname(store.configPath));
  assert.ok(files.some((f) => f.startsWith('desktop.json.corrupt-') && f.endsWith('.bak')));

  const after = await store.load();
  assert.equal(after.configProblem, null, 'configProblem must clear after recover()');
});

test('#1436 Item 8b: desktop-host exposes configProblem & desktop.config.recover unlocks saves; UI wires recovery banner', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'studyhub-1436-item8-host-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const store = createConfigStore({ env: { DSH_HOME: dir }, home: dir, documentsDir: join(dir, 'docs') });
  mkdirSync(dirname(store.configPath), { recursive: true });
  writeFileSync(store.configPath, '{CORRUPT_JSON', 'utf8');

  const host = await createDesktopHost({
    configStore: store,
    providerDiscovery: { scan: async () => [], getCached: () => [], findReadyAgyPath: () => '' },
    ensureDir: async (p) => { mkdirSync(p, { recursive: true }); },
    jobExecutor: { asDshJobsService: () => ({}), dispose: () => {} },
    openExternal: async () => {},
    openCliTerminal: async () => {},
  });
  t.after(() => host.dispose());

  const cfgRes = await host.call('desktop.config.get', { uiLanguage: 'zh' });
  assert.equal(cfgRes.ok, true);
  assert.equal(cfgRes.value.configProblem?.code, 'config-corrupt');

  const bindRes = await host.call('binding.get', { uiLanguage: 'zh' });
  assert.equal(bindRes.ok, true);
  assert.equal(bindRes.value.configProblem?.code, 'config-corrupt');

  // Attempting to save before recovery fails with localized Chinese error
  const saveFail = await host.call('desktop.config.save', { mode: 'openai', uiLanguage: 'zh' });
  assert.equal(saveFail.ok, false);
  assert.equal(saveFail.code, 'config-corrupt');
  assert.match(saveFail.error, /损坏|备份并重置/);

  // Explicit desktop.config.recover backs up & unlocks!
  const recoverRes = await host.call('desktop.config.recover', { uiLanguage: 'zh' });
  assert.equal(recoverRes.ok, true);
  assert.equal(recoverRes.value.recovered, true);
  assert.equal(recoverRes.value.config.configProblem, null);

  // Now saving works!
  const confirmOk = await host.call('desktop.library.confirm', { uiLanguage: 'zh' });
  assert.equal(confirmOk.ok, true);
  assert.equal(confirmOk.value.configProblem, null);
});

test('#1436 Item 8c: DesktopLibraryPlace hides welcome card on configProblem and DesktopModelSetup renders & invokes desktop.config.recover', async () => {
  const ui = await loadInteractiveUi(`
    export { default as DesktopLibraryPlace } from './ui/desktop/DesktopLibraryPlace.jsx';
    export { DesktopSetupBody, createDesktopConfigActions } from './ui/desktop/DesktopModelSetup.jsx';
    export { AppContext } from './ui/app/app-context.js';
    export { setUiLanguage } from './ui/i18n.js';
  `);
  const h = ui.React.createElement;
  await withBrowserGlobals(async () => {
    ui.exports.setUiLanguage('zh');
    const makeApp = (configProblem) => ({
      host: { warmKey: 'test-warm' },
      core: { call: async () => ({}), busy: false, setBusy: () => {}, setError: () => {} },
      connection: {
        binding: {
          root: '/tmp/studyhub-lib',
          libraryPlace: { confirmed: false, onSystemDrive: false },
          libraryProblem: null,
          configProblem,
        },
        setBinding: () => {},
      },
      settingsEntry: {},
      nav: {},
    });

    const placeMounted = ui.mount((app = makeApp({ code: 'config-corrupt', path: '/tmp/desktop.json' })) => h(
      ui.exports.AppContext.Provider,
      { value: app },
      h(ui.exports.DesktopLibraryPlace, { data: { decks: [], sources: [] } }),
    ));
    try {
      assert.equal(
        placeMounted.find((n) => n.props && 'data-desktop-library-place' in n.props),
        null,
        'DesktopLibraryPlace hides welcome card when binding.configProblem is set',
      );

      placeMounted.rerender(() => h(
        ui.exports.AppContext.Provider,
        { value: makeApp(null) },
        h(ui.exports.DesktopLibraryPlace, { data: { decks: [], sources: [] } }),
      ));
      const card = placeMounted.find((n) => n.props && 'data-desktop-library-place' in n.props);
      assert.ok(card, 'DesktopLibraryPlace renders welcome card when binding.configProblem is null');
      assert.match(placeMounted.text(card), /先确认学习库放在哪/);
    } finally {
      placeMounted.unmount();
    }

    // DesktopModelSetup: createDesktopConfigActions().recoverConfig() + DesktopSetupBody corrupt banner
    const calls = [];
    let appliedConfig = null;
    let refreshed = 0;
    let lastError = '';
    const workingStates = [];
    const recoveredConfig = { mode: 'openai', providers: [], openai: {}, configPath: '/tmp/desktop.json', configProblem: null, effective: { ready: false } };
    const actions = ui.exports.createDesktopConfigActions({
      call: async (action, args) => {
        calls.push([action, args]);
        return { recovered: true, backupPath: '/tmp/desktop.json.corrupt-1.bak', config: recoveredConfig };
      },
      refresh: async () => { refreshed += 1; },
      setConfig: (next) => { appliedConfig = next; },
      setError: (msg) => { lastError = msg; },
      setWorking: (tag) => { workingStates.push(tag); },
    });

    await actions.recoverConfig();
    assert.deepEqual(calls, [['desktop.config.recover', {}]], 'recoverConfig invokes desktop.config.recover');
    assert.equal(appliedConfig, recoveredConfig);
    assert.equal(refreshed, 1);
    assert.equal(lastError, '');
    assert.deepEqual(workingStates, ['recover-config', '']);

    const corruptConfig = {
      mode: 'openai',
      providers: [],
      openai: { providerId: 'custom', baseUrl: '', model: '', hasKey: false, keyLast4: '' },
      configPath: '/tmp/desktop.json',
      configProblem: { code: 'config-corrupt', path: '/tmp/desktop.json' },
      effective: { ready: false },
    };
    const setupMounted = ui.mount(() => h(ui.exports.DesktopSetupBody, {
      config: corruptConfig,
      actions,
      working: '',
      error: '',
      onDismissError: () => {},
      compact: false,
    }));
    try {
      assert.match(setupMounted.text(), /配置文件已损坏/);
      const recoverBtn = setupMounted.find((n) => n.type === 'button' && setupMounted.text(n).includes('备份并重置配置'));
      assert.ok(recoverBtn, 'DesktopSetupBody renders 「备份并重置配置」 action when configProblem is set');
      await setupMounted.act(() => click(recoverBtn));
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[1], ['desktop.config.recover', {}]);

      setupMounted.rerender(() => h(ui.exports.DesktopSetupBody, {
        config: recoveredConfig,
        actions,
        working: '',
        error: '',
        onDismissError: () => {},
        compact: false,
      }));
      assert.doesNotMatch(setupMounted.text(), /配置文件已损坏/, 'corrupt banner hides when configProblem is null');
    } finally {
      setupMounted.unmount();
    }
  });
});

test('#1436 Item 8d: TUI overlay config store forwards save(next, opts) without leaking env key and supports recover()', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'studyhub-1436-item8-tui-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const baseSaveCalls = [];
  let capturedOverlayStore = null;
  const stubKey = '__STUDY_TUI_OVERLAY_DEPS__';
  globalThis[stubKey] = {
    async loadDesktopDeps() {
      return {
        desktopRoot: resolve('packages/studyhub-desktop'),
        createConfigStore(opts) {
          const real = createConfigStore(opts);
          return {
            get dshHome() { return real.dshHome; },
            get configPath() { return real.configPath; },
            get defaultRoot() { return real.defaultRoot; },
            load: () => real.load(),
            save: (next, saveOpts) => {
              baseSaveCalls.push({ next, opts: saveOpts });
              return real.save(next, saveOpts);
            },
            recover: () => real.recover(),
            saveLibraryRoot: (root) => real.saveLibraryRoot(root),
            confirmLibraryPlace: () => real.confirmLibraryPlace(),
          };
        },
        createDesktopHost(args) {
          capturedOverlayStore = args.configStore;
          return createDesktopHost(args);
        },
        createProcessRunner: () => ({ run: async () => ({ code: 0, stdout: '', stderr: '' }) }),
        createDesktopLibraryEvents: () => null,
        createInProcessJobExecutor: () => ({ asDshJobsService: () => ({}), dispose: () => {} }),
        createOpenAiCompleteAdapter: () => undefined,
        createAgyCompleteAdapter: () => undefined,
        createCodexCompleteAdapter: () => undefined,
        openableExternalUrl: () => null,
        localizeProviders: (providers) => providers,
        resolveEffectiveModel: () => ({ ready: false, label: '', reason: '', provider: '', model: '', maxConcurrency: null, defaultConcurrency: null }),
        redactDesktopConfig: (config) => config,
        spawnDetached: () => {},
      };
    },
  };
  t.after(() => { delete globalThis[stubKey]; });

  const compiled = await build({
    entryPoints: [resolve('packages/studyhub-tui/src/host/tui-host.ts')],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    plugins: [{
      name: 'tui-host-test-deps',
      setup(builder) {
        builder.onResolve({ filter: /^signal-exit$/ }, () => ({ path: 'signal-exit', namespace: 'tui-stub' }));
        builder.onLoad({ filter: /^signal-exit$/, namespace: 'tui-stub' }, () => ({
          contents: 'export const onExit = () => () => {};',
          loader: 'js',
        }));
        builder.onResolve({ filter: /^\.\/desktop-deps\.js$/ }, () => ({ path: 'desktop-deps', namespace: 'tui-stub' }));
        builder.onLoad({ filter: /^desktop-deps$/, namespace: 'tui-stub' }, () => ({
          contents: `export const loadDesktopDeps = () => globalThis[${JSON.stringify(stubKey)}].loadDesktopDeps();`,
          loader: 'js',
        }));
      },
    }],
    logLevel: 'silent',
  });
  const tuiMod = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, tuiMod, tuiMod.exports);

  const envSecret = 'sk-env-secret-1234';
  const preStore = createConfigStore({ env: { DSH_HOME: dir }, home: dir, documentsDir: join(dir, 'docs') });
  mkdirSync(dirname(preStore.configPath), { recursive: true });
  writeFileSync(preStore.configPath, '{CORRUPT_TUI_JSON', 'utf8');

  const tuiHost = await tuiMod.exports.createTuiHost({
    env: { DSH_HOME: dir, OPENAI_API_KEY: envSecret },
    home: dir,
    documentsDir: join(dir, 'docs'),
    skipAutoProbe: true,
    providerDiscovery: { scan: async () => [], getCached: () => [], findReadyPath: () => '', findReadyAgyPath: () => '', findReadyCodexPath: () => '' },
  });
  t.after(() => tuiHost.dispose());

  assert.ok(capturedOverlayStore, 'TUI host passes overlay store to createDesktopHost');

  // Default save refuses corrupt desktop.json
  const saveBlocked = await tuiHost.call('desktop.config.save', { mode: 'openai' });
  assert.equal(saveBlocked.ok, false);
  assert.equal(saveBlocked.error?.code, 'config-corrupt');

  // Overlay store forwards opts ({ force: true }) to base.save AND scrubs the env API key
  await capturedOverlayStore.save({
    mode: 'openai',
    openai: { providerId: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', apiKey: envSecret },
  }, { force: true });

  const forcedCall = baseSaveCalls.at(-1);
  assert.deepEqual(forcedCall?.opts, { force: true }, 'TUI overlay store must forward opts to base.save');
  assert.equal(forcedCall?.next?.openai?.apiKey, '', 'TUI overlay store must scrub env API key before saving');
  const persisted = readFileSync(preStore.configPath, 'utf8');
  assert.doesNotMatch(persisted, /sk-env-secret-1234/, 'env API key must never be written to desktop.json');

  // Re-corrupt and verify TUI host recover() delegates to base.recover()
  writeFileSync(preStore.configPath, '{CORRUPT_AGAIN', 'utf8');
  const rec = await tuiHost.call('desktop.config.recover', {});
  assert.equal(rec.ok, true);
  assert.equal(rec.value.recovered, true);
  assert.equal(rec.value.config.configProblem, null);
});

// Recovery must never lose a config that is merely locked or still fine: it re-reads first, only a parse failure is "corrupt",
// and a backup that cannot be written stops the reset.
async function hostOver(t, prepare) {
  const dir = mkdtempSync(join(tmpdir(), 'studyhub-1436-item8-guard-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createConfigStore({ env: { DSH_HOME: dir }, home: dir, documentsDir: join(dir, 'docs') });
  mkdirSync(dirname(store.configPath), { recursive: true });
  prepare(store.configPath);
  const host = await createDesktopHost({
    configStore: store,
    providerDiscovery: { scan: async () => [], getCached: () => [], findReadyAgyPath: () => '' },
    ensureDir: async (p) => { mkdirSync(p, { recursive: true }); },
    jobExecutor: { asDshJobsService: () => ({}), dispose: () => {} },
    openExternal: async () => {},
    openCliTerminal: async () => {},
  });
  t.after(() => host.dispose());
  return { dir, store, host, backups: () => readdirSync(dirname(store.configPath)).filter((name) => name.includes('.corrupt-')) };
}

test('#1448 recover: a config that reads fine is not reset and not backed up', async (t) => {
  const good = JSON.stringify({ mode: 'openai', libraryRoot: '', openai: { baseUrl: 'https://example.invalid/v1', model: 'm' } });
  const { store, host, backups } = await hostOver(t, (path) => writeFileSync(path, good, 'utf8'));
  const res = await host.call('desktop.config.recover', { uiLanguage: 'zh' });
  assert.equal(res.ok, true);
  assert.equal(res.value.recovered, false, 'nothing to recover');
  assert.equal(readFileSync(store.configPath, 'utf8'), good, 'the file is untouched');
  assert.deepEqual(backups(), []);
});

test('#1448 recover: a file that cannot be read for a reason other than its contents (a read error) is not corruption and is not reset', async (t) => {
  // A directory where desktop.json should be: reading it fails with an I/O error, not a parse error (the portable stand-in for a locked file).
  const { store, host, backups } = await hostOver(t, (path) => mkdirSync(path));
  const loaded = await store.load();
  assert.equal(loaded.configProblem, null, 'a read error is not reported as a corrupt config');
  const res = await host.call('desktop.config.recover', { uiLanguage: 'zh' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'config-unreadable');
  assert.deepEqual(backups(), [], 'no backup, no reset');
  assert.equal(statSync(store.configPath).isDirectory(), true, 'whatever is there stays');
  await assert.rejects(store.save({ mode: 'openai' }, { force: true }), (err) => err?.code === 'config-unreadable', 'force does not turn a read error into a reset');
});

test('#1448 recover: when the backup cannot be written the reset is aborted and the corrupt file stays as it was', async (t) => {
  const raw = '{"mode":"openai","libraryRoot":"/somewhere/precious"';
  const { store, host, backups } = await hostOver(t, (path) => {
    writeFileSync(path, raw, 'utf8');
    // The backup name carries Date.now(): with the clock fixed, a directory of that name makes the copy fail.
    mkdirSync(`${path}.corrupt-1700000000000.bak`);
  });
  const clock = mock.method(Date, 'now', () => 1700000000000);
  t.after(() => clock.mock.restore());
  const res = await host.call('desktop.config.recover', { uiLanguage: 'zh' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'config-backup-failed');
  assert.match(res.error, /备份/);
  assert.equal(readFileSync(store.configPath, 'utf8'), raw, 'the library path and model settings are still in the file');
  assert.equal(backups().length, 1, 'only the blocking directory is there');
  await assert.rejects(store.save({ mode: 'openai' }, { force: true }), (err) => err?.code === 'config-backup-failed', 'a forced save stops the same way');
  assert.equal(readFileSync(store.configPath, 'utf8'), raw);
});

test('#1436 recover: a forced save and a recover in the same millisecond keep two backups and the recover goes through', async (t) => {
  const first = '{"mode":"openai","libraryRoot":"/first"', second = '{"mode":"openai","libraryRoot":"/second"';
  const { store, host, backups } = await hostOver(t, (path) => writeFileSync(path, first, 'utf8'));
  // A fast runner does both inside one millisecond; the fixed clock makes that certain.
  const clock = mock.method(Date, 'now', () => 1700000000000);
  t.after(() => clock.mock.restore());
  await store.save({ mode: 'openai' }, { force: true });
  writeFileSync(store.configPath, second, 'utf8');
  const rec = await host.call('desktop.config.recover', { uiLanguage: 'zh' });
  assert.equal(rec.ok, true, `recover was refused: ${rec.code} ${rec.error}`);
  assert.equal(rec.value.recovered, true);
  const names = backups().sort();
  assert.equal(names.length, 2, `two backups expected, found ${names.join(', ')}`);
  assert.equal(new Set(names).size, 2);
  assert.ok(names.every((name) => /\.corrupt-\d+\.bak$/.test(name)), names.join(', '));
  const dir = dirname(store.configPath);
  assert.deepEqual(names.map((name) => readFileSync(join(dir, name), 'utf8')).sort(), [first, second].sort(), 'each backup holds the file it was taken from');
});
