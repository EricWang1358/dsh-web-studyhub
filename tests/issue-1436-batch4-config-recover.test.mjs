// #1436 Batch 4 Item 8:
// Corrupt `desktop.json` must:
// 1) Report `configProblem` from `configStore.load()`, `desktop.config.get`, and `binding.get`
// 2) Keep default refuse-to-overwrite guard on `save` / `saveLibraryRoot` / `confirmLibraryPlace` with stable `code: 'config-corrupt'` + Chinese error localization
// 3) Provide explicit `desktop.config.recover` that backs up `.corrupt-<ts>.bak` and resets cleanly so settings/folder switching unlock
// 4) Hide misleading DesktopLibraryPlace welcome card when `configProblem` is set and offer one-click 「备份并重置配置」
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createConfigStore } from '../packages/studyhub-desktop/adapters/storage/config-store.mjs';
import { formatCallError } from '../packages/studyhub-desktop/application/desktop-errors.js';
import { createDesktopHost } from '../packages/studyhub-desktop/application/desktop-host.js';

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

  // UI checks: DesktopLibraryPlace hides welcome card on configProblem; DesktopModelSetup exposes recover action
  const placeSrc = readFileSync(new URL('../ui/desktop/DesktopLibraryPlace.jsx', import.meta.url), 'utf8');
  const setupSrc = readFileSync(new URL('../ui/desktop/DesktopModelSetup.jsx', import.meta.url), 'utf8');
  const tuiHostSrc = readFileSync(new URL('../packages/studyhub-tui/src/host/tui-host.ts', import.meta.url), 'utf8');
  assert.match(placeSrc, /configProblem/, 'DesktopLibraryPlace must check binding.configProblem');
  assert.match(setupSrc, /desktop\.config\.recover/, 'DesktopModelSetup must expose desktop.config.recover action');
  assert.match(tuiHostSrc, /save\s*\(\s*next\s*,\s*opts\s*\)/, 'TUI overlay store must forward opts to base.save');
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
