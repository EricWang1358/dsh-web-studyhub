// Guardrail & regression tests for #1354 D11:
// Local settings files (`retrieval.json`, `notebooks.json`, `coach-daily.json`, `desktop.json`)
// must NEVER silently overwrite corrupt, unreadable, or newer-version files with defaults.
// node --test tests/d11-settings-no-overwrite.test.mjs
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { createCoachDaily, DAILY } from '../lib/coach-daily.js';
import { createCalibration } from '../lib/estimate-calibration.js';
import { adoptIndexProvider } from '../lib/contexts/generation/retrieval/adopt-index.js';
import { INDEX_TOOLS } from '../lib/retrieval-index.js';
import { listNotebooks, publishNotebook, unpublishNotebook } from '../lib/notebooks.js';
import * as retrievalSettings from '../lib/retrieval-settings.js';
import { createConfigStore } from '../packages/studyhub-desktop/adapters/storage/config-store.mjs';
import { formatCallError } from '../packages/studyhub-desktop/application/desktop-errors.js';
import { loadInteractiveUi, withBrowserGlobals } from './helpers/react-harness.mjs';

async function withTempDshHome(t, prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  t.after(async () => {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

describe('#1354 D11 — local settings files never silently overwrite on read failure or newer version', () => {
  test('retrieval.json: corrupt/unreadable/future-version refuse silent overwrite; passive adopt skips; explicit recover backs up', async (t) => {
    await withTempDshHome(t, 'studyhub-d11-retrieval-');
    const filePath = retrievalSettings.retrievalSettingsPath();
    await mkdir(path.dirname(filePath), { recursive: true });

    assert.equal(typeof retrievalSettings.readRetrievalSettingsSafe, 'function', 'readRetrievalSettingsSafe must be exported');

    // 1) Corrupt JSON: default save & passive adopt refuse overwrite; bytes stay intact
    const corruptRaw = '{"provider":"service","hfEndpoint": BROKEN';
    await writeFile(filePath, corruptRaw, 'utf8');

    const safeCorrupt = await retrievalSettings.readRetrievalSettingsSafe();
    assert.equal(safeCorrupt.status, 'corrupt');
    assert.deepEqual(safeCorrupt.settings, { provider: 'builtin' });

    await assert.rejects(
      retrievalSettings.saveRetrievalSettings({ provider: 'builtin' }),
      (err) => err?.code === 'retrieval-settings-corrupt',
      'saveRetrievalSettings must refuse to silently overwrite corrupt retrieval.json',
    );
    assert.equal(await readFile(filePath, 'utf8'), corruptRaw);

    // Passive adoption after index build must NOT clobber corrupt retrieval.json
    const fakePort = { tools: () => [{ name: INDEX_TOOLS.query }] };
    await adoptIndexProvider(fakePort);
    assert.equal(await readFile(filePath, 'utf8'), corruptRaw, 'adoptIndexProvider must not overwrite corrupt retrieval.json');

    // Explicit recover backs up corrupt file before writing
    const recovered = await retrievalSettings.saveRetrievalSettings({ provider: 'service' }, { recover: true });
    assert.deepEqual(recovered, { provider: 'service' });
    const files = await readdir(path.dirname(filePath));
    const bak = files.find((f) => f.startsWith('retrieval.json.corrupt-') && f.endsWith('.bak'));
    assert.ok(bak, `expected retrieval.json.corrupt-*.bak backup, found: ${files.join(', ')}`);
    assert.equal(await readFile(path.join(path.dirname(filePath), bak), 'utf8'), corruptRaw);

    // 2) UTF-8 BOM reads cleanly
    await writeFile(filePath, `\uFEFF${JSON.stringify({ provider: 'service', explicit: true })}`, 'utf8');
    const bomRes = await retrievalSettings.readRetrievalSettingsSafe();
    assert.equal(bomRes.status, 'ok');
    assert.equal(bomRes.settings.provider, 'service');

    // 3) Future schema version [C38]: refuses overwrite even on recover: true
    const futureRaw = JSON.stringify({ version: 2, provider: 'service', futureKey: 'keep-me' });
    await writeFile(filePath, futureRaw, 'utf8');
    const futureRes = await retrievalSettings.readRetrievalSettingsSafe();
    assert.equal(futureRes.status, 'unsupported-version');
    await assert.rejects(
      retrievalSettings.saveRetrievalSettings({ provider: 'builtin' }, { recover: true }),
      (err) => err?.code === 'retrieval-settings-unsupported-version',
    );
    assert.equal(await readFile(filePath, 'utf8'), futureRaw);

    // 4) Unreadable (directory stand-in): refuses overwrite
    await rm(filePath, { force: true });
    await mkdir(filePath);
    const unreadableRes = await retrievalSettings.readRetrievalSettingsSafe();
    assert.equal(unreadableRes.status, 'unreadable');
    await assert.rejects(
      retrievalSettings.saveRetrievalSettings({ provider: 'builtin' }, { recover: true }),
      (err) => err?.code === 'retrieval-settings-unreadable',
    );
    assert.equal((await stat(filePath)).isDirectory(), true);

    // 5) Backup failure during recover: true aborts and leaves original corrupt bytes intact
    await rm(filePath, { recursive: true, force: true });
    const corruptKeep = '{"provider":"service","hfEndpoint": KEEP_ME';
    await writeFile(filePath, corruptKeep, 'utf8');
    await assert.rejects(
      retrievalSettings.saveRetrievalSettings(
        { provider: 'builtin' },
        {
          recover: true,
          copyFile: async () => {
            throw Object.assign(new Error('Simulated disk full on backup'), { code: 'ENOSPC' });
          },
        },
      ),
      (err) => err?.code === 'retrieval-settings-backup-failed',
    );
    assert.equal(await readFile(filePath, 'utf8'), corruptKeep, 'corrupt retrieval.json must stay untouched when backup fails');
  });

  test('notebooks.json: corrupt backs up before recovery; unreadable & future version refuse overwrite', async (t) => {
    const dir = await withTempDshHome(t, 'studyhub-d11-notebooks-');
    const studyDir = path.join(dir, 'study');
    const regPath = path.join(studyDir, 'notebooks.json');
    await mkdir(studyDir, { recursive: true });

    // 1) Corrupt registry: publishNotebook backs up original corrupt bytes before recovering
    const corruptRaw = '{"version":1,"notebooks":[{"root":"/keep/me" BROKEN';
    await writeFile(regPath, corruptRaw, 'utf8');
    assert.deepEqual((await listNotebooks(dir)).notebooks, []);
    assert.equal(await readFile(regPath, 'utf8'), corruptRaw, 'listNotebooks must not touch corrupt notebooks.json');

    await publishNotebook(dir, path.join(dir, 'lib-a'));
    const files = await readdir(studyDir);
    const bak = files.find((f) => f.startsWith('notebooks.json.corrupt-') && f.endsWith('.bak'));
    assert.ok(bak, `expected notebooks.json.corrupt-*.bak backup before recovery, found: ${files.join(', ')}`);
    assert.equal(await readFile(path.join(studyDir, bak), 'utf8'), corruptRaw);

    // 2) Future schema version [C38]: refuses overwrite and leaves bytes untouched
    const futureRaw = JSON.stringify({ version: 2, notebooks: [{ root: '/future/lib' }], extra: 1 });
    await writeFile(regPath, futureRaw, 'utf8');
    await assert.rejects(
      publishNotebook(dir, path.join(dir, 'lib-b')),
      (err) => err?.code === 'notebooks-registry-unsupported-version',
    );
    await assert.rejects(
      unpublishNotebook(path.join(dir, 'lib-a')),
      (err) => err?.code === 'notebooks-registry-unsupported-version',
    );
    assert.equal(await readFile(regPath, 'utf8'), futureRaw);

    // 3) Unreadable (directory stand-in): refuses overwrite
    await rm(regPath, { force: true });
    await mkdir(regPath);
    await assert.rejects(
      publishNotebook(dir, path.join(dir, 'lib-c')),
      (err) => err?.code === 'notebooks-registry-unreadable',
    );
    assert.equal((await stat(regPath)).isDirectory(), true);
  });

  test('coach-daily.json: corrupt, unreadable, and future-version refuse overwrite while read-only gate degrades safely', async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'studyhub-d11-coach-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dailyPath = path.join(root, DAILY.file);

    // 1) Corrupt JSON: gate() degrades without writing, setSettings/pause refuse overwrite and preserve bytes
    const corruptRaw = '{"version":1,"settings":{"maxReady":4},"days": BROKEN';
    await writeFile(dailyPath, corruptRaw, 'utf8');
    const ledger = createCoachDaily(root);
    const gateRes = await ledger.gate();
    assert.equal(gateRes.ok, true);
    assert.equal(await readFile(dailyPath, 'utf8'), corruptRaw);

    await assert.rejects(
      ledger.patch({ maxReady: 6 }),
      (err) => err?.code === 'coach-daily-corrupt',
      'patch must refuse to overwrite corrupt coach-daily.json',
    );
    await assert.rejects(
      ledger.setPaused(true),
      (err) => err?.code === 'coach-daily-corrupt',
      'setPaused must refuse to overwrite corrupt coach-daily.json',
    );
    assert.equal(await readFile(dailyPath, 'utf8'), corruptRaw, 'corrupt coach-daily.json bytes must remain intact');

    // 2) UTF-8 BOM reads cleanly and preserves settings on update
    await writeFile(dailyPath, `\uFEFF${JSON.stringify({ version: 1, settings: { maxReady: 5 }, days: {} })}`, 'utf8');
    ledger.reload();
    assert.equal((await ledger.gate()).settings.maxReady, 5);
    await ledger.patch({ maxBatchesPerDay: 10 });
    const afterBom = JSON.parse(await readFile(dailyPath, 'utf8'));
    assert.equal(afterBom.settings.maxReady, 5);
    assert.equal(afterBom.settings.maxBatchesPerDay, 10);

    // 3) Future schema version [C38]: refuses overwrite EVEN WITHOUT reload() (warm cache cannot clobber newer disk file)
    const futureRaw = JSON.stringify({ version: 2, settings: { maxReady: 8 }, days: {}, futureFlag: true });
    await writeFile(dailyPath, futureRaw, 'utf8');
    await assert.rejects(
      ledger.patch({ maxReady: 3 }),
      (err) => err?.code === 'coach-daily-unsupported-version',
    );
    assert.equal(await readFile(dailyPath, 'utf8'), futureRaw);

    // 4) Unreadable (directory stand-in): refuses overwrite
    await rm(dailyPath, { force: true });
    await mkdir(dailyPath);
    ledger.reload();
    await assert.rejects(
      ledger.patch({ maxReady: 3 }),
      (err) => err?.code === 'coach-daily-unreadable',
    );
    assert.equal((await stat(dailyPath)).isDirectory(), true);

    // 5) Failed save() must NOT poison in-memory cache with uncommitted patch values
    await rm(dailyPath, { recursive: true, force: true });
    await writeFile(dailyPath, JSON.stringify({ version: 1, settings: { maxReady: 11 }, days: {} }), 'utf8');
    const failingLedger = createCoachDaily(root, {
      rename: async () => {
        throw Object.assign(new Error('Simulated rename ENOSPC'), { code: 'ENOSPC' });
      },
    });
    assert.equal((await failingLedger.read()).settings.maxReady, 11);
    await assert.rejects(failingLedger.patch({ maxReady: 3 }), /ENOSPC/);
    assert.equal(
      (await failingLedger.read()).settings.maxReady,
      11,
      'failed save must not leave uncommitted maxReady=3 in in-memory cache',
    );
    assert.equal(JSON.parse(await readFile(dailyPath, 'utf8')).settings.maxReady, 11);
  });

  test('desktop.json: UTF-8 BOM loads cleanly and future version refuses overwrite (even force/recover)', async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'studyhub-d11-desktop-'));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const store = createConfigStore({ env: { DSH_HOME: dir }, home: dir, documentsDir: path.join(dir, 'docs') });
    await mkdir(path.dirname(store.configPath), { recursive: true });

    // 1) UTF-8 BOM is accepted as valid config (not falsely flagged config-corrupt)
    await writeFile(
      store.configPath,
      `\uFEFF${JSON.stringify({ mode: 'openai', openai: { providerId: 'deepseek', model: 'deepseek-chat' } })}`,
      'utf8',
    );
    const bomLoaded = await store.load();
    assert.equal(bomLoaded.configProblem, null, 'UTF-8 BOM desktop.json must load cleanly without configProblem');
    assert.equal(bomLoaded.config.openai.model, 'deepseek-chat');

    // 2) Future schema version [C38]: surfaces configProblem and refuses save/force/recover/confirm
    const futureRaw = JSON.stringify({ version: 2, mode: 'openai', futureSetting: 'preserve-me' });
    await writeFile(store.configPath, futureRaw, 'utf8');
    const futureLoaded = await store.load();
    assert.equal(futureLoaded.configProblem?.code, 'config-unsupported-version');

    await assert.rejects(store.save({ mode: 'openai' }), (err) => err?.code === 'config-unsupported-version');
    await assert.rejects(store.save({ mode: 'openai' }, { force: true }), (err) => err?.code === 'config-unsupported-version');
    await assert.rejects(store.recover(), (err) => err?.code === 'config-unsupported-version');
    await assert.rejects(store.confirmLibraryPlace(), (err) => err?.code === 'config-unsupported-version');
    assert.equal(await readFile(store.configPath, 'utf8'), futureRaw, 'future-version desktop.json bytes must stay intact');

    // Localized error formatting for config-unsupported-version
    const zh = formatCallError(Object.assign(new Error('raw'), { code: 'config-unsupported-version' }), 'zh');
    assert.match(zh.error, /版本|升级|desktop\.json/);
    const en = formatCallError(Object.assign(new Error('raw'), { code: 'config-unsupported-version' }), 'en');
    assert.match(en.error, /version|newer|desktop\.json/i);

    // 3) Invalid string/zero version values also refuse overwrite
    for (const badVer of ['2', 0, null]) {
      const badRaw = JSON.stringify({ version: badVer, mode: 'openai' });
      await writeFile(store.configPath, badRaw, 'utf8');
      await assert.rejects(store.save({ mode: 'openai' }, { force: true }), (err) => err?.code === 'config-unsupported-version');
      assert.equal(await readFile(store.configPath, 'utf8'), badRaw);
    }
  });

  test('DesktopSetupBody renders upgrade-required banner (no reset button) for config-unsupported-version in zh & en', async () => {
    const ui = await loadInteractiveUi(
      `export { DesktopSetupBody } from './ui/desktop/DesktopModelSetup.jsx';
       export { setUiLanguage } from './ui/i18n.js';`,
    );
    const { createElement: h } = ui.React;
    await withBrowserGlobals(async () => {
      const futureConfig = {
        mode: 'openai',
        providers: [],
        openai: { providerId: 'custom', baseUrl: '', model: '', hasKey: false, keyLast4: '' },
        configPath: '/tmp/desktop.json',
        configProblem: { code: 'config-unsupported-version', path: '/tmp/desktop.json', reason: 'version 2' },
        effective: { ready: false },
      };
      const actions = {
        recoverConfig: async () => {
          throw new Error('recoverConfig must not be offered for unsupported-version');
        },
      };

      ui.exports.setUiLanguage('zh');
      const mountedZh = ui.mount(() => h(ui.exports.DesktopSetupBody, {
        config: futureConfig,
        actions,
        working: '',
        error: '',
        onDismissError: () => {},
        compact: false,
      }));
      try {
        const textZh = mountedZh.text();
        assert.doesNotMatch(textZh, /配置文件已损坏/, 'newer-version config must not falsely claim file is corrupted');
        assert.match(textZh, /更新版本|升级/, 'newer-version banner must ask user to upgrade');
        const recoverBtnZh = mountedZh.find((n) => n.type === 'button' && mountedZh.text(n).includes('备份并重置配置'));
        assert.equal(recoverBtnZh, null, 'newer-version banner must NOT offer broken reset button');
      } finally {
        mountedZh.unmount();
      }

      ui.exports.setUiLanguage('en');
      const mountedEn = ui.mount(() => h(ui.exports.DesktopSetupBody, {
        config: futureConfig,
        actions,
        working: '',
        error: '',
        onDismissError: () => {},
        compact: false,
      }));
      try {
        const textEn = mountedEn.text();
        assert.doesNotMatch(textEn, /corrupted/i, 'English banner must not falsely claim file is corrupted');
        assert.match(textEn, /newer version|upgrade/i, 'English banner must ask user to upgrade');
        const recoverBtnEn = mountedEn.find((n) => n.type === 'button' && /reset/i.test(mountedEn.text(n)));
        assert.equal(recoverBtnEn, null, 'English newer-version banner must NOT offer reset button');
      } finally {
        ui.exports.setUiLanguage('zh');
        mountedEn.unmount();
      }
    });
  });

  test('estimate-calibration.json: tolerates UTF-8 BOM, refuses future version [C38], and aborts if damaged backup fails', async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'studyhub-d11-calib-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const filePath = path.join(dir, 'estimate-calibration.json');

    // 1) UTF-8 BOM reads cleanly without flagging file as damaged
    const bomRuns = [
      { at: '2026-11-26T00:00:00.000Z', stages: { author: [100, 200] } },
      { at: '2026-11-26T00:01:00.000Z', stages: { author: [100, 200] } },
      { at: '2026-11-26T00:02:00.000Z', stages: { author: [100, 200] } },
    ];
    await writeFile(filePath, `\uFEFF${JSON.stringify({ version: 1, runs: bomRuns, imported: [] })}`, 'utf8');
    const bomCal = createCalibration(dir);
    const bomFactors = await bomCal.factors();
    assert.equal(bomFactors.samples, 3, 'UTF-8 BOM calibration file must load cleanly');
    assert.equal(bomFactors.stages.author, 2);

    // 2) Future schema version [C38]: refuses overwrite and leaves bytes untouched
    const futureRaw = JSON.stringify({ version: 2, runs: bomRuns, imported: [], futureMeta: 'keep' });
    await writeFile(filePath, futureRaw, 'utf8');
    const futureCal = createCalibration(dir);
    await assert.rejects(
      futureCal.record({ stageTotals: { author: { low: 100, high: 200 } }, actual: { author: 150 } }),
      (err) => err?.code === 'calibration-unsupported-version',
    );
    assert.equal(await readFile(filePath, 'utf8'), futureRaw, 'future-version estimate-calibration.json must stay intact');

    // 3) Backup rename failure on damaged file must abort instead of swallowing error and clobbering original bytes
    const damagedRaw = '{damaged-calibration-bytes';
    await writeFile(filePath, damagedRaw, 'utf8');
    const failBackupCal = createCalibration(dir, {
      rename: async () => {
        throw Object.assign(new Error('Simulated backup rename failure'), { code: 'EACCES' });
      },
    });
    await assert.rejects(
      failBackupCal.record({ stageTotals: { author: { low: 100, high: 200 } }, actual: { author: 150 } }),
      (err) => err?.code === 'calibration-backup-failed',
    );
    assert.equal(await readFile(filePath, 'utf8'), damagedRaw, 'damaged estimate-calibration.json must remain intact if backup fails');
  });
});
