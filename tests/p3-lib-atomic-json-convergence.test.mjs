// P3 (#1354 D10/D11): Behavioral guardrails for shared lib/atomic-json.js convergence
// across backend settings & usage JSON writers.
// Real filesystem only (mkdtemp), zero source-grep assertions, zero node:fs mocks.
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import * as atomicJsonMod from '../lib/atomic-json.js';
import { audioSettingsPath, readAudioSettings, saveAudioSettings } from '../lib/audio-settings.js';
import { recordReads, readReading } from '../lib/book-reading.js';
import { experimentalPath, readExperimental, setExperimental } from '../lib/experimental.js';
import { jevSettingsPath, readJevSettings, saveJevSettings } from '../lib/jev-settings.js';
import { createJevUsage, jevUsagePath } from '../lib/jev-usage.js';
import { markerSettingsPath, readMarkerSettings, saveMarkerSettings } from '../lib/marker-settings.js';
import { createUsageLedger } from '../lib/model-usage.js';
import { readWebGeminiSettings, saveWebGeminiSettings, webGeminiSettingsPath } from '../lib/runtime/web-gemini-settings.js';
import { setUpdatePreferences, updateStatePath } from '../lib/update-check.js';
import { createUsageFrequency, localDay, usageFrequencyPath } from '../lib/usage-frequency.js';

async function withTempDshHome(t, prefix = 'studyhub-p3-lib-') {
  const home = await mkdtemp(path.join(os.tmpdir(), prefix));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(async () => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    await chmod(path.join(home, 'study'), 0o700).catch(() => {});
    await rm(home, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 });
  });
  return home;
}

const findTmpFiles = async (dir) => (await readdir(dir)).filter((name) => name.endsWith('.tmp'));
const findBackupFiles = async (dir, prefix) =>
  (await readdir(dir)).filter((name) => name.startsWith(`${prefix}.corrupt-`) && name.endsWith('.bak'));

describe('P3 (#1354): shared lib/atomic-json.js & backend settings/state atomic write convergence', () => {
  test('1) lib/atomic-json.js supports mode (0o600), backupCorruptJsonFile, and serialized atomicUpdateJson', async (t) => {
    assert.equal(typeof atomicJsonMod.backupCorruptJsonFile, 'function', 'lib/atomic-json.js must export backupCorruptJsonFile');
    assert.equal(typeof atomicJsonMod.atomicUpdateJson, 'function', 'lib/atomic-json.js must export atomicUpdateJson');

    const dir = await mkdtemp(path.join(os.tmpdir(), 'studyhub-p3-core-'));
    t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 }));
    const subDir = path.join(dir, 'nested');
    await mkdir(subDir, { recursive: true });

    // A) mode: 0o600 + sync: true + ensureDir: true
    const secretFile = path.join(dir, 'sub-new', 'secret.json');
    await atomicJsonMod.atomicJson(secretFile, { ok: true }, { space: 2, trailingNewline: true, mode: 0o600, sync: true, ensureDir: true });
    assert.deepEqual(JSON.parse(await readFile(secretFile, 'utf8')), { ok: true });
    if (process.platform !== 'win32') {
      const info = await stat(secretFile);
      assert.equal(info.mode & 0o777, 0o600, 'atomicJson must apply mode 0o600 on POSIX');
    }

    // B) atomicUpdateJson serializes concurrent updates across equivalent path spellings
    const counterFile = path.join(dir, 'counter.json');
    const counterAlias = `${subDir}${path.sep}..${path.sep}counter.json`;
    await writeFile(counterFile, '{"n":0}\n', 'utf8');
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        atomicJsonMod.atomicUpdateJson(
          i % 2 === 0 ? counterFile : counterAlias,
          async (prev) => {
            await new Promise((done) => setTimeout(done, (i % 3) * 2));
            return { n: (prev?.n ?? 0) + 1 };
          },
          { sync: true },
        ),
      ),
    );
    assert.equal(JSON.parse(await readFile(counterFile, 'utf8')).n, 12);
    assert.deepEqual(await findTmpFiles(dir), []);

    // C) atomicUpdateJson aborts by default on corrupt JSON, leaving bytes untouched
    const corruptFile = path.join(dir, 'corrupt.json');
    const corruptBytes = '{"broken": true, BAD';
    await writeFile(corruptFile, corruptBytes, 'utf8');
    await assert.rejects(
      atomicJsonMod.atomicUpdateJson(corruptFile, () => ({ fixed: true })),
      /corrupt\.json.*refusing to overwrite/i,
    );
    assert.equal(await readFile(corruptFile, 'utf8'), corruptBytes);

    // D) backupCorruptJsonFile copies corrupt bytes atomically and throws corrupt-backup-failed on failure
    const backup = await atomicJsonMod.backupCorruptJsonFile(corruptFile, { mode: 0o600 });
    assert.equal(await readFile(backup.backupPath, 'utf8'), corruptBytes);
    await assert.rejects(
      atomicJsonMod.backupCorruptJsonFile(corruptFile, {
        rename: async () => {
          throw Object.assign(new Error('ENOSPC: disk full'), { code: 'ENOSPC' });
        },
      }),
      (err) => err?.code === 'corrupt-backup-failed' && /ENOSPC/.test(err.message),
    );
    assert.deepEqual(await findTmpFiles(dir), []);
  });

  test('2) Concurrent disjoint saves to audio/jev/web-gemini settings serialize with zero lost updates', async (t) => {
    const home = await withTempDshHome(t);
    const studyDir = path.join(home, 'study');

    // audio-settings.js
    await saveAudioSettings({ textConcurrency: 2, transcribeConcurrency: 2, mode: 'SMART' });
    await Promise.all([
      saveAudioSettings({ textConcurrency: 4 }),
      saveAudioSettings({ transcribeConcurrency: 3 }),
      saveAudioSettings({ mode: 'VERBATIM' }),
      saveAudioSettings({ partMinutes: 20 }),
    ]);
    const audio = await readAudioSettings();
    assert.equal(audio.textConcurrency, 4, 'audio textConcurrency must not be clobbered by concurrent save');
    assert.equal(audio.transcribeConcurrency, 3, 'audio transcribeConcurrency must not be clobbered by concurrent save');
    assert.equal(audio.mode, 'VERBATIM', 'audio mode must not be clobbered by concurrent save');
    assert.equal(audio.partMinutes, 20, 'audio partMinutes must not be clobbered by concurrent save');

    // jev-settings.js
    await saveJevSettings({ enabled: false, threshold: 0.8 });
    await Promise.all([
      saveJevSettings({ enabled: true }),
      saveJevSettings({ threshold: 0.72 }),
      saveJevSettings({ keyEnv: 'MY_JEV_TOKEN' }),
    ]);
    const jev = await readJevSettings();
    assert.equal(jev.enabled, true, 'jev enabled must not be clobbered by concurrent save');
    assert.equal(jev.threshold, 0.72, 'jev threshold must not be clobbered by concurrent save');
    assert.equal(jev.keyEnv, 'MY_JEV_TOKEN', 'jev keyEnv must not be clobbered by concurrent save');

    // web-gemini-settings.js
    await saveWebGeminiSettings({ enabled: false, waitSeconds: 600 });
    await Promise.all([
      saveWebGeminiSettings({ enabled: true }),
      saveWebGeminiSettings({ waitSeconds: 240 }),
      saveWebGeminiSettings({ toolName: 'mcp__gemini__ask_web' }),
    ]);
    const wg = await readWebGeminiSettings();
    assert.equal(wg.enabled, true, 'web-gemini enabled must not be clobbered by concurrent save');
    assert.equal(wg.waitSeconds, 240, 'web-gemini waitSeconds must not be clobbered by concurrent save');
    assert.equal(wg.toolName, 'mcp__gemini__ask_web', 'web-gemini toolName must not be clobbered by concurrent save');

    assert.deepEqual(await findTmpFiles(studyDir), [], 'zero orphan .tmp files after concurrent settings saves');
  });

  test('3) Corrupt settings files (audio/experimental/jev/marker/web-gemini) are backed up to .corrupt-*.bak before explicit save', async (t) => {
    const home = await withTempDshHome(t);
    const studyDir = path.join(home, 'study');
    await mkdir(studyDir, { recursive: true });

    const cases = [
      {
        name: 'audio.json',
        file: audioSettingsPath(),
        corrupt: '{"version":1,"textProvider":"gemini", BROKEN_AUDIO',
        save: () => saveAudioSettings({ mode: 'VERBATIM' }),
        verify: async () => assert.equal((await readAudioSettings()).mode, 'VERBATIM'),
      },
      {
        name: 'experimental.json',
        file: experimentalPath(),
        corrupt: '{"version":1,"enabled":true, BROKEN_EXP',
        save: () => setExperimental(true),
        verify: async () => assert.equal(await readExperimental(), true),
      },
      {
        name: 'jev.json',
        file: jevSettingsPath(),
        corrupt: '{"version":1,"enabled":true, BROKEN_JEV',
        save: () => saveJevSettings({ threshold: 0.75 }),
        verify: async () => assert.equal((await readJevSettings()).threshold, 0.75),
      },
      {
        name: 'marker.json',
        file: markerSettingsPath(),
        corrupt: '{"version":1,"command":"/bin/marker", BROKEN_MARKER',
        save: () => saveMarkerSettings({ command: '' }),
        verify: async () => assert.equal((await readMarkerSettings()).command, ''),
      },
      {
        name: 'web-gemini.json',
        file: webGeminiSettingsPath(),
        corrupt: '{"enabled":true, BROKEN_WG',
        save: () => saveWebGeminiSettings({ waitSeconds: 300 }),
        verify: async () => assert.equal((await readWebGeminiSettings()).waitSeconds, 300),
      },
    ];

    for (const c of cases) {
      await writeFile(c.file, c.corrupt, 'utf8');
      await c.save();
      await c.verify();
      const base = path.basename(c.file);
      const backups = await findBackupFiles(studyDir, base);
      assert.ok(backups.length >= 1, `expected ${base}.corrupt-*.bak backup before overwriting corrupt ${base}`);
      const bakContent = await readFile(path.join(studyDir, backups[0]), 'utf8');
      assert.equal(bakContent, c.corrupt, `backup for ${base} must preserve exact original corrupt bytes`);
    }
    assert.deepEqual(await findTmpFiles(studyDir), []);
  });

  test('4) Corrupt backup failure on read-only study dir aborts overwrite instead of silently destroying update.json / usage-frequency.json', async (t) => {
    if (process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)) {
      return;
    }
    const home = await withTempDshHome(t);
    const studyDir = path.join(home, 'study');
    await mkdir(studyDir, { recursive: true });

    const corruptUpdate = '{"autoCheck":false, BROKEN_UPDATE';
    const corruptUsage = '{"version":1,"enabled":true, BROKEN_USAGE';
    await writeFile(updateStatePath(), corruptUpdate, 'utf8');
    await writeFile(usageFrequencyPath(), corruptUsage, 'utf8');

    // Make study dir read-only (0o500): existing files can be read, but creating .corrupt-*.bak fails with EACCES.
    await chmod(studyDir, 0o500);
    t.after(() => chmod(studyDir, 0o700).catch(() => {}));

    const usage = createUsageFrequency();
    await assert.rejects(
      usage.set({ enabled: true }),
      (err) => err?.code === 'corrupt-backup-failed',
      'usage.set must abort with code corrupt-backup-failed when corrupt backup fails',
    );
    await assert.rejects(
      setUpdatePreferences({ autoCheck: false }),
      (err) => err?.code === 'corrupt-backup-failed',
      'setUpdatePreferences must abort with code corrupt-backup-failed when corrupt backup fails',
    );

    await chmod(studyDir, 0o700);
    assert.equal(await readFile(usageFrequencyPath(), 'utf8'), corruptUsage, 'corrupt usage-frequency.json must remain byte-identical');
    assert.equal(await readFile(updateStatePath(), 'utf8'), corruptUpdate, 'corrupt update.json must remain byte-identical');
  });

  test('5) book-reading, jev-usage, and model-usage persist concurrently via shared atomic-json with zero .tmp leftovers', async (t) => {
    await withTempDshHome(t);
    const libRoot = await mkdtemp(path.join(os.tmpdir(), 'studyhub-p3-libroot-'));
    t.after(() => rm(libRoot, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 }));

    // book-reading.js concurrent writes
    await Promise.all([
      recordReads(libRoot, [{ sourceId: 's1', from: 0, to: 100 }], 'p1'),
      recordReads(libRoot, [{ sourceId: 's1', from: 100, to: 220 }], 'p2'),
      recordReads(libRoot, [{ sourceId: 's2', from: 10, to: 50 }], 'p1'),
    ]);
    const reading = await readReading(libRoot);
    assert.deepEqual(reading.sources.s1, [[0, 220]]);
    assert.deepEqual(reading.sources.s2, [[10, 50]]);
    assert.deepEqual(await findTmpFiles(path.join(libRoot, 'book-history')), []);

    // jev-usage.js concurrent records
    const jevMeter = createJevUsage();
    await Promise.all(
      Array.from({ length: 6 }, () =>
        jevMeter.record({ feature: 'assist', usage: { inputTokens: 10, outputTokens: 5 } }),
      ),
    );
    const jevSummary = await jevMeter.summary();
    assert.equal(jevSummary.total.calls, 6);
    assert.equal(jevSummary.total.inputTokens, 60);
    assert.equal(jevSummary.total.outputTokens, 30);
    assert.deepEqual(await findTmpFiles(path.dirname(jevUsagePath())), []);

    // model-usage.js concurrent records
    const modelMeter = createUsageLedger(libRoot);
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        modelMeter.record({
          feature: 'generate',
          usage: { uncachedInputTokens: 20, outputTokens: 10 },
          callId: `call-${i}`,
        }),
      ),
    );
    const modelSummary = await modelMeter.summary();
    assert.equal(modelSummary.total.calls, 6);
    assert.equal(modelSummary.total.uncachedInputTokens, 120);
    assert.equal(modelSummary.total.outputTokens, 60);
    assert.deepEqual(await findTmpFiles(libRoot), []);
  });

  test('6) lib/atomic-json.js serializes symlinked parent dirs, respects { abort: false }, and skips .bak when settings validation fails over corrupt JSON', async (t) => {
    const home = await withTempDshHome(t);
    const studyDir = path.join(home, 'study');
    await mkdir(studyDir, { recursive: true });

    // A) Symlinked parent directory aliases must serialize in atomicUpdateJson
    const realDir = path.join(home, 'real-dir');
    const linkDir = path.join(home, 'link-dir');
    await mkdir(realDir, { recursive: true });
    let symlinkReady = true;
    try {
      await symlink(realDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (err) {
      if (err?.code === 'EPERM' || err?.code === 'EACCES') symlinkReady = false;
      else throw err;
    }
    if (symlinkReady) {
      const realCounter = path.join(realDir, 'counter.json');
      const linkCounter = path.join(linkDir, 'counter.json');
      await writeFile(realCounter, '{"n":0}\n', 'utf8');
      await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          atomicJsonMod.atomicUpdateJson(i % 2 === 0 ? realCounter : linkCounter, async (prev) => {
            await new Promise((done) => setTimeout(done, (i % 3) * 2));
            return { n: (prev?.n ?? 0) + 1 };
          }),
        ),
      );
      assert.equal(JSON.parse(await readFile(realCounter, 'utf8')).n, 12, 'symlinked parent dir updates must serialize cleanly');
    }

    // B) onCorrupt returning { abort: false, recover } must recover instead of aborting
    const policyFile = path.join(realDir, 'policy.json');
    await writeFile(policyFile, '{ broken', 'utf8');
    const rec = await atomicJsonMod.atomicUpdateJson(
      policyFile,
      (prev) => ({ count: (prev?.count ?? 0) + 1 }),
      { onCorrupt: () => ({ abort: false, recover: { count: 4 } }) },
    );
    assert.equal(rec.updated, true);
    assert.deepEqual(rec.value, { count: 5 });

    // C) Validation failure on corrupt audio.json must throw validation error and create 0 .bak files
    const corruptAudio = '{"version":1,"mode":"SMART", BROKEN_AUDIO_VALIDATION';
    await writeFile(audioSettingsPath(), corruptAudio, 'utf8');
    await assert.rejects(
      saveAudioSettings({ textConcurrency: 999 }),
      /并发数/,
      'invalid patch over corrupt audio.json must fail with validation error',
    );
    assert.equal(await readFile(audioSettingsPath(), 'utf8'), corruptAudio, 'corrupt audio.json must remain byte-identical on validation failure');
    assert.deepEqual(await findBackupFiles(studyDir, 'audio.json'), [], 'validation failure must not leave spurious .bak files');
  });

  test('7) usage-frequency passive record() and no-op set({ enabled: false }) over corrupt file create 0 .bak files and never throw on read-only dir', async (t) => {
    const home = await withTempDshHome(t);
    const studyDir = path.join(home, 'study');
    await mkdir(studyDir, { recursive: true });
    const corruptRaw = '{ not valid json';
    await writeFile(usageFrequencyPath(), corruptRaw, 'utf8');

    const usage = createUsageFrequency();
    const today = localDay(Date.now());
    const r1 = await usage.record([{ key: 'nav.library', area: 'library', day: today, n: 1 }]);
    const r2 = await usage.record([{ key: 'nav.library', area: 'library', day: today, n: 2 }]);
    assert.deepEqual({ accepted: r1.accepted, enabled: r1.enabled }, { accepted: 0, enabled: false });
    assert.deepEqual({ accepted: r2.accepted, enabled: r2.enabled }, { accepted: 0, enabled: false });

    const sOff = await usage.set({ enabled: false });
    assert.equal(sOff.enabled, false);
    assert.equal(await readFile(usageFrequencyPath(), 'utf8'), corruptRaw, 'passive/no-op calls must leave corrupt usage-frequency.json untouched');
    assert.deepEqual(await findBackupFiles(studyDir, 'usage-frequency.json'), [], 'passive record() and no-op set({ enabled: false }) must create zero .bak files');

    if (process.platform !== 'win32' && !(typeof process.getuid === 'function' && process.getuid() === 0)) {
      await chmod(studyDir, 0o500);
      t.after(() => chmod(studyDir, 0o700).catch(() => {}));
      const rRo = await usage.record([{ key: 'nav.library', area: 'library', day: today, n: 1 }]);
      assert.deepEqual({ accepted: rRo.accepted, enabled: rRo.enabled }, { accepted: 0, enabled: false }, 'passive record() on read-only dir must not attempt backup or throw');
      await chmod(studyDir, 0o700);
    }

    // Explicit enabling over corrupt file creates exactly one backup and recovers
    const sOn = await usage.set({ enabled: true });
    assert.equal(sOn.enabled, true);
    const baks = await findBackupFiles(studyDir, 'usage-frequency.json');
    assert.equal(baks.length, 1, 'explicit enable over corrupt usage-frequency.json must create exactly one .bak');
    assert.equal(await readFile(path.join(studyDir, baks[0]), 'utf8'), corruptRaw);
  });

  test('8) Separate instances and non-canonical paths for jev-usage, model-usage, usage-frequency, and book-reading serialize with zero lost writes', async (t) => {
    await withTempDshHome(t);
    const libRoot = await mkdtemp(path.join(os.tmpdir(), 'studyhub-p3-multi-'));
    t.after(() => rm(libRoot, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 }));
    const subDir = path.join(libRoot, 'nested');
    await mkdir(subDir, { recursive: true });
    const libAlias = `${subDir}${path.sep}..`;

    // Two independent createJevUsage instances recording concurrently
    const ju1 = createJevUsage();
    const ju2 = createJevUsage();
    await Promise.all([
      ...Array.from({ length: 5 }, () => ju1.record({ feature: 'assist', usage: { inputTokens: 10, outputTokens: 5 } })),
      ...Array.from({ length: 5 }, () => ju2.record({ feature: 'assist', usage: { inputTokens: 10, outputTokens: 5 } })),
    ]);
    assert.equal((await ju1.summary()).total.calls, 10, 'two createJevUsage instances must serialize without losing calls');

    // Two independent createUsageLedger instances on canonical + non-canonical root
    const ml1 = createUsageLedger(libRoot);
    const ml2 = createUsageLedger(libAlias);
    await Promise.all([
      ...Array.from({ length: 5 }, (_, i) => ml1.record({ feature: 'generate', usage: { uncachedInputTokens: 10, outputTokens: 4 }, callId: `a-${i}` })),
      ...Array.from({ length: 5 }, (_, i) => ml2.record({ feature: 'generate', usage: { uncachedInputTokens: 10, outputTokens: 4 }, callId: `b-${i}` })),
    ]);
    assert.equal((await ml1.summary()).total.calls, 10, 'separate createUsageLedger instances across path aliases must not lose calls');

    // Two independent createUsageFrequency instances recording concurrently
    const uf1 = createUsageFrequency();
    const uf2 = createUsageFrequency();
    const today = localDay(Date.now());
    await uf1.set({ enabled: true });
    await Promise.all([
      ...Array.from({ length: 5 }, () => uf1.record([{ key: 'nav.library', area: 'library', day: today, n: 1 }])),
      ...Array.from({ length: 5 }, () => uf2.record([{ key: 'nav.library', area: 'library', day: today, n: 1 }])),
    ]);
    assert.equal((await uf1.read()).controls['nav.library'].total, 10, 'two createUsageFrequency instances must serialize without losing counts');

    // book-reading concurrent writes across canonical + non-canonical root
    await Promise.all([
      recordReads(libRoot, [{ sourceId: 's-a', from: 0, to: 50 }], 'p1'),
      recordReads(libAlias, [{ sourceId: 's-b', from: 0, to: 80 }], 'p2'),
      recordReads(libRoot, [{ sourceId: 's-c', from: 10, to: 40 }], 'p3'),
      recordReads(libAlias, [{ sourceId: 's-d', from: 20, to: 60 }], 'p4'),
    ]);
    const reading = await readReading(libRoot);
    assert.deepEqual(Object.keys(reading.sources).sort(), ['s-a', 's-b', 's-c', 's-d'], 'book-reading across path aliases must not drop concurrent sources');
  });
});
