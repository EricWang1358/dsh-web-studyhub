// P3 (#1354 D10/D11): Behavioral guardrails for TUI atomic-write convergence,
// canonical path serialization, duplicate batch target rejection, non-silent corrupt backup,
// forward-compatible tui.json schema versioning, and throw-safe tx-write rollback.
// Real filesystem only (mkdtemp), zero source-grep assertions, zero node:fs mocks.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const [atomicMod, prefsMod, txMod] = await Promise.all([
  import('../src/host/atomic-write.ts'),
  import('../src/host/tui-prefs.ts'),
  import('../src/host/tx-write.ts'),
]);

const {
  atomicUpdateJson,
  atomicWriteFilesBatch,
  atomicWriteTextFile,
} = atomicMod;

const {
  loadTuiPreferences,
  loadTuiPreferencesSafe,
  parseTuiPreferences,
  saveTuiPreferences,
} = prefsMod;

const { runIdempotentTwoStep } = txMod;

async function makeTempDir(t, prefix = 'studyhub-p3-conv-') {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 }));
  return dir;
}

const findTmpFiles = async (dir) => (await readdir(dir)).filter((name) => name.endsWith('.tmp'));

describe('P3 (#1354): TUI atomic-write, tui-prefs & tx-write convergence guardrails', () => {
  test('1) atomicUpdateJson serializes concurrent updates across equivalent non-canonical paths without losing writes', async (t) => {
    const dir = await makeTempDir(t);
    const subDir = path.join(dir, 'nested');
    await mkdir(subDir, { recursive: true });
    const canonical = path.join(dir, 'counter.json');
    const dotDotAlias = `${subDir}${path.sep}..${path.sep}counter.json`;
    const dotAlias = `${dir}${path.sep}.${path.sep}counter.json`;
    const relAlias = path.relative(process.cwd(), canonical);
    await writeFile(canonical, '{"n":0}\n', 'utf8');

    const paths = [canonical, dotDotAlias, dotAlias, relAlias];
    await Promise.all(
      Array.from({ length: 18 }, (_, i) =>
        atomicUpdateJson(paths[i % paths.length], async (prev) => {
          // Small async yield widens the race window if queue keys do not normalize paths.
          await new Promise((done) => setTimeout(done, (i % 3) * 2));
          return { n: (prev?.n ?? 0) + 1 };
        }),
      ),
    );

    const parsed = JSON.parse(await readFile(canonical, 'utf8'));
    assert.equal(parsed.n, 18, 'all 18 concurrent updates across equivalent path spellings must serialize with zero lost writes');
    assert.deepEqual(await findTmpFiles(dir), []);
  });

  test('2) atomicWriteFilesBatch rejects duplicate canonical target paths before touching disk', async (t) => {
    const dir = await makeTempDir(t);
    const subDir = path.join(dir, 'sub');
    await mkdir(subDir, { recursive: true });
    const fileA = path.join(dir, 'a.json');
    const fileAAlias = `${subDir}${path.sep}..${path.sep}a.json`;
    const fileB = path.join(dir, 'b.json');
    const origA = '{"v":"orig-a"}\n';
    const origB = '{"v":"orig-b"}\n';
    await writeFile(fileA, origA, 'utf8');
    await writeFile(fileB, origB, 'utf8');

    await assert.rejects(
      atomicWriteFilesBatch([
        { path: fileB, content: '{"v":"new-b"}\n' },
        { path: fileA, content: '{"v":"new-a-1"}\n' },
        { path: fileAAlias, content: '{"v":"new-a-2"}\n' },
      ]),
      /duplicate/i,
      'duplicate canonical target paths in one batch must be rejected before writing',
    );

    assert.equal(await readFile(fileA, 'utf8'), origA, 'fileA must remain byte-identical');
    assert.equal(await readFile(fileB, 'utf8'), origB, 'fileB must remain byte-identical');
    assert.deepEqual(await findTmpFiles(dir), [], 'zero .tmp files may be created when batch validation fails');
  });

  test('3) backupCorruptFile creates collision-free backups and saveTuiPreferences aborts with AtomicBackupError when backup fails', async (t) => {
    assert.equal(typeof atomicMod.backupCorruptFile, 'function', 'atomic-write must export backupCorruptFile');
    assert.equal(typeof atomicMod.AtomicBackupError, 'function', 'atomic-write must export AtomicBackupError');

    const dir = await makeTempDir(t);
    const filePath = path.join(dir, 'tui.json');
    const corruptRaw = '{"theme":"nord","language":"en", BROKEN';
    await writeFile(filePath, corruptRaw, 'utf8');

    // A) Two immediate backupCorruptFile calls must produce two distinct backup files preserving exact bytes
    const [bak1, bak2] = await Promise.all([
      atomicMod.backupCorruptFile(filePath, { mode: 0o600 }),
      atomicMod.backupCorruptFile(filePath, { mode: 0o600 }),
    ]);
    assert.notEqual(bak1.backupPath, bak2.backupPath, 'concurrent corrupt backups must not collide');
    assert.equal(await readFile(bak1.backupPath, 'utf8'), corruptRaw);
    assert.equal(await readFile(bak2.backupPath, 'utf8'), corruptRaw);

    // B) When corrupt backup fails (e.g. ENOSPC on rename), saveTuiPreferences MUST abort and leave tui.json untouched
    const dir2 = await makeTempDir(t);
    const filePath2 = path.join(dir2, 'tui.json');
    await writeFile(filePath2, corruptRaw, 'utf8');

    const err = await saveTuiPreferences(
      { theme: 'warm-paper' },
      {
        filePath: filePath2,
        fsOps: {
          rename: async () => {
            throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
          },
        },
      },
    ).then(
      () => null,
      (thrown) => thrown,
    );

    assert.ok(err instanceof atomicMod.AtomicBackupError, `expected AtomicBackupError, got: ${err}`);
    assert.match(err.message, /tui\.json/);
    assert.match(err.message, /ENOSPC/);
    assert.equal(
      await readFile(filePath2, 'utf8'),
      corruptRaw,
      'corrupt tui.json MUST remain byte-identical when backup fails',
    );
    assert.deepEqual(
      (await readdir(dir2)).filter((f) => f.endsWith('.tmp') || f.endsWith('.bak')),
      [],
      'failed backup must leave zero .tmp or partial .bak files behind',
    );
  });

  test('4) tui.json emits backward-compatible schema version 1 and refuses to overwrite future schema versions (version > 1)', async (t) => {
    const dir = await makeTempDir(t);
    const filePath = path.join(dir, 'tui.json');

    // A) Saved file carries version: 1 on disk while remaining readable by legacy & current parsers
    const saved = await saveTuiPreferences({ theme: 'nord', language: 'en', compactMode: true }, { filePath });
    const rawOnDisk = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(rawOnDisk.version, 1, 'persisted tui.json must include schema version 1');
    assert.equal(rawOnDisk.theme, 'nord');
    assert.deepEqual(await loadTuiPreferences({ filePath }), saved, 'current loader must round-trip cleanly');
    assert.deepEqual(parseTuiPreferences(rawOnDisk), saved, 'forgiving/previous-release parser must read version 1 file cleanly');

    // B) Future version file (version: 2) is reported as unsupported-version and NEVER overwritten
    const futureRaw = `${JSON.stringify({ version: 2, theme: 'future-theme', language: 'en', futureField: { keep: true } }, null, 2)}\n`;
    await atomicWriteTextFile(filePath, futureRaw);

    const safeLoaded = await loadTuiPreferencesSafe({ filePath });
    assert.equal(safeLoaded.status, 'unsupported-version');
    assert.match(safeLoaded.error ?? '', /version\s*2/i);

    // Passive patch must skip without touching the future-version bytes
    await saveTuiPreferences({ recentCommands: ['nav:stats'] }, { filePath });
    assert.equal(
      await readFile(filePath, 'utf8'),
      futureRaw,
      'passive save must leave future-version tui.json byte-identical',
    );

    // Explicit setting change must reject and leave the future-version bytes untouched (and no .bak)
    await assert.rejects(
      saveTuiPreferences({ theme: 'warm-paper' }, { filePath }),
      /unsupported.*version|version\s*2/i,
      'explicit save must refuse to downgrade/overwrite a newer-release tui.json',
    );
    assert.equal(
      await readFile(filePath, 'utf8'),
      futureRaw,
      'explicit save failure must leave future-version tui.json byte-identical',
    );
    assert.deepEqual(
      await readdir(dir),
      ['tui.json'],
      'refusing future-version file must not create .bak or .tmp files',
    );
  });

  test('5) runIdempotentTwoStep catches thrown exceptions in step1 & step2 and guarantees rollbackStep1 runs when step2 throws', async (t) => {
    const dir = await makeTempDir(t);

    // A) step1 throws -> returns structured failure instead of unhandled rejection
    let cachedA = null;
    const step1Throw = await runIdempotentTwoStep({
      cachedStep1: cachedA,
      setCachedStep1: (v) => { cachedA = v; },
      step1: async () => {
        throw new Error('step1 network boom');
      },
      step2: async () => ({ ok: true, value: 'never' }),
    });
    assert.equal(step1Throw.ok, false);
    assert.equal(step1Throw.step1Succeeded, false);
    assert.match(step1Throw.error, /step1 network boom/);
    assert.equal(cachedA, null);

    // B) step2 throws WITH rollbackStep1 -> rollbackStep1 MUST execute, remove real file, and clear cache
    const orphanFile = path.join(dir, 'orphan-step1.json');
    let cachedB = null;
    let rollbackCalls = 0;
    const step2ThrowWithRb = await runIdempotentTwoStep({
      cachedStep1: cachedB,
      setCachedStep1: (v) => { cachedB = v; },
      step1: async () => {
        await atomicWriteTextFile(orphanFile, '{"created":true}\n');
        return { ok: true, value: orphanFile };
      },
      step2: async () => {
        throw new Error('step2 crash after step1');
      },
      rollbackStep1: async (createdPath) => {
        rollbackCalls += 1;
        await rm(createdPath, { force: true });
        return true;
      },
    });
    assert.equal(step2ThrowWithRb.ok, false);
    assert.equal(step2ThrowWithRb.step1Succeeded, true);
    assert.equal(step2ThrowWithRb.rolledBack, true);
    assert.match(step2ThrowWithRb.error, /step2 crash after step1/);
    assert.equal(rollbackCalls, 1, 'rollbackStep1 must be called when step2 throws');
    assert.equal(cachedB, null, 'cache must clear after successful rollback');
    assert.equal(existsSync(orphanFile), false, 'step1 file must be deleted by rollbackStep1');

    // C) step2 throws WITHOUT rollbackStep1 -> step1 value stays cached so retry reuses it
    let cachedC = null;
    let step1Count = 0;
    const step2ThrowNoRb = await runIdempotentTwoStep({
      cachedStep1: cachedC,
      setCachedStep1: (v) => { cachedC = v; },
      step1: async () => {
        step1Count += 1;
        return { ok: true, value: 'id-77' };
      },
      step2: async () => {
        throw new Error('step2 transient throw');
      },
    });
    assert.equal(step2ThrowNoRb.ok, false);
    assert.equal(step2ThrowNoRb.step1Succeeded, true);
    assert.equal(step2ThrowNoRb.rolledBack, false);
    assert.equal(cachedC, 'id-77', 'step1 result must remain cached when step2 throws without rollback');

    const retryOk = await runIdempotentTwoStep({
      cachedStep1: cachedC,
      setCachedStep1: (v) => { cachedC = v; },
      step1: async () => {
        step1Count += 1;
        return { ok: true, value: 'id-dup' };
      },
      step2: async (id) => ({ ok: true, value: { linked: id } }),
    });
    assert.equal(retryOk.ok, true);
    assert.equal(step1Count, 1, 'retry after thrown step2 must reuse cached step1 without duplicating');
    assert.equal(retryOk.step1Value, 'id-77');
    assert.equal(cachedC, null);
  });
});
