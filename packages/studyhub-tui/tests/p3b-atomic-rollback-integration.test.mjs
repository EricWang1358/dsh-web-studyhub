// #1354 P3-b: real-filesystem & fault-injection integration tests for atomic read-modify-write,
// transient lock retry, corrupt-file preservation/recovery, multi-file LIFO rollback, and
// BoardSaveCoordinator rollback/recovery across:
// - `src/host/atomic-write.ts`
// - `src/host/tui-prefs.ts`
// - `src/views/board/board-store.ts`
// - `src/host/tx-write.ts`
//
// Uses real `mkdtemp` directories and explicit fault-injection hooks (`fsOps` / failing `saveFn`).
// Zero `node:fs` module mocking, zero source-grep assertions.
//
// node --test tests/p3b-atomic-rollback-integration.test.mjs
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rename as fsRename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const [atomicMod, prefsMod, boardMod, txMod] = await Promise.all([
  import('../src/host/atomic-write.ts'),
  import('../src/host/tui-prefs.ts'),
  import('../src/views/board/board-store.ts'),
  import('../src/host/tx-write.ts'),
]);

const {
  AtomicBatchWriteError,
  AtomicRollbackError,
  atomicUpdateJson,
  atomicWriteFilesBatch,
  atomicWriteJsonFile,
  atomicWriteTextFile,
  withRollback,
} = atomicMod;

const {
  loadTuiPreferencesSafe,
  saveTuiPreferences,
  tuiPreferencesPath,
} = prefsMod;

const {
  boardFilePath,
  boardSaveFailureNotice,
  createBoardSaveCoordinator,
  emptyBoard,
  loadBoardSafe,
  saveBoard,
} = boardMod;

const {
  runAtomicSteps,
  runIdempotentTwoStep,
  runOptimisticWrite,
} = txMod;

async function makeTempDir(t, prefix = 'studyhub-p3b-int-') {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 }));
  return dir;
}

const findTmpFiles = async (dir) => (await readdir(dir)).filter((name) => name.endsWith('.tmp'));

function makeBoardDoc(cards) {
  const now = '2026-11-26T00:00:00.000Z';
  return {
    version: 1,
    cards: cards.map((c) => ({
      createdAt: now,
      updatedAt: now,
      column: 'todo',
      ...c,
    })),
    deletedUpstreamIds: [],
    updatedAt: now,
  };
}

describe('P3-b atomic read-modify-write & rollback integration', () => {
  test('1) Mid-write ENOSPC and mid-rename EIO leave real tui.json and tui-board.json byte-identical with zero orphan .tmp files', async (t) => {
    const dir = await makeTempDir(t);
    const dshHome = path.join(dir, 'dsh');
    const libRoot = path.join(dir, 'lib');
    const prefsFile = tuiPreferencesPath({ env: { DSH_HOME: dshHome } });
    const boardFile = boardFilePath(libRoot);

    // Seed real persisted files via domain APIs
    await saveTuiPreferences(
      { theme: 'nord', language: 'en', compactMode: true, recentCommands: ['review', 'sources'] },
      { env: { DSH_HOME: dshHome } },
    );
    await saveBoard(
      libRoot,
      makeBoardDoc([
        { id: 'task-1', title: '复习 TCP 三次握手', column: 'doing', course: '计网' },
      ]),
    );

    const prefsBefore = await readFile(prefsFile);
    const boardBefore = await readFile(boardFile);

    // Mid-write ENOSPC on tui.json (after partial bytes written into temp file)
    await assert.rejects(
      atomicUpdateJson(
        prefsFile,
        (prev) => ({ ...prev, theme: 'warm-paper' }),
        {
          fsOps: {
            writeAndSync: async (tempPath) => {
              await writeFile(tempPath, '{"theme":"warm-pa', 'utf8');
              throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
            },
          },
        },
      ),
      /ENOSPC/,
    );

    // Mid-write ENOSPC on tui-board.json
    await assert.rejects(
      atomicWriteJsonFile(
        boardFile,
        makeBoardDoc([{ id: 'task-corrupt', title: 'truncated', column: 'done' }]),
        {
          fsOps: {
            writeAndSync: async (tempPath) => {
              await writeFile(tempPath, '{"version":1,"cards":[', 'utf8');
              throw Object.assign(new Error('ENOSPC: disk full'), { code: 'ENOSPC' });
            },
          },
        },
      ),
      /ENOSPC/,
    );

    // Mid-rename EIO on tui.json & tui-board.json
    await assert.rejects(
      atomicUpdateJson(
        prefsFile,
        (prev) => ({ ...prev, compactMode: false }),
        {
          fsOps: {
            rename: async () => {
              throw Object.assign(new Error('EIO: input/output error during rename'), { code: 'EIO' });
            },
          },
        },
      ),
      /EIO/,
    );

    await assert.rejects(
      atomicUpdateJson(
        boardFile,
        (prev) => ({ ...prev, cards: [] }),
        {
          fsOps: {
            rename: async () => {
              throw Object.assign(new Error('EIO: board rename failed'), { code: 'EIO' });
            },
          },
        },
      ),
      /EIO/,
    );

    // Exact byte-identity preserved and zero orphan .tmp files anywhere
    assert.deepEqual(await readFile(prefsFile), prefsBefore, 'tui.json must remain byte-identical after ENOSPC & EIO');
    assert.deepEqual(await readFile(boardFile), boardBefore, 'tui-board.json must remain byte-identical after ENOSPC & EIO');
    assert.deepEqual(await findTmpFiles(path.dirname(prefsFile)), [], 'no orphan .tmp in prefs dir');
    assert.deepEqual(await findTmpFiles(path.dirname(boardFile)), [], 'no orphan .tmp in board dir');

    // Domain loaders still read the exact intact state
    const loadedPrefs = await loadTuiPreferencesSafe({ env: { DSH_HOME: dshHome } });
    assert.equal(loadedPrefs.status, 'ok');
    assert.equal(loadedPrefs.prefs.theme, 'nord');
    assert.equal(loadedPrefs.prefs.language, 'en');

    const loadedBoard = await loadBoardSafe(libRoot);
    assert.equal(loadedBoard.ok, true);
    assert.equal(loadedBoard.doc.cards.length, 1);
    assert.equal(loadedBoard.doc.cards[0].title, '复习 TCP 三次握手');
  });

  test('2) Transient EBUSY / EPERM / EACCES rename retries succeed cleanly, while non-transient EIO fails without retrying', async (t) => {
    const dir = await makeTempDir(t);
    const target = path.join(dir, 'retry-target.json');
    await writeFile(target, '{"rev":1}\n', 'utf8');

    const transientErrors = ['EBUSY', 'EPERM', 'EACCES'];
    let attempts = 0;
    const res = await atomicUpdateJson(
      target,
      (prev) => ({ rev: (prev?.rev ?? 0) + 1, recovered: true }),
      {
        fsOps: {
          rename: async (from, to) => {
            attempts += 1;
            const faultCode = transientErrors[attempts - 1];
            if (faultCode) {
              throw Object.assign(new Error(`${faultCode}: transient lock`), { code: faultCode });
            }
            await fsRename(from, to);
          },
        },
      },
    );

    assert.equal(attempts, 4, 'must retry EBUSY, EPERM, EACCES and succeed on attempt 4');
    assert.equal(res.updated, true);
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { rev: 2, recovered: true });
    assert.deepEqual(await findTmpFiles(dir), [], 'no orphan .tmp after retry success');

    // Non-transient EIO must fail immediately on attempt 1
    let eioAttempts = 0;
    await assert.rejects(
      atomicWriteJsonFile(target, { rev: 3 }, {
        fsOps: {
          rename: async () => {
            eioAttempts += 1;
            throw Object.assign(new Error('EIO: fatal'), { code: 'EIO' });
          },
        },
      }),
      /EIO/,
    );
    assert.equal(eioAttempts, 1, 'non-transient EIO must not be retried');
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { rev: 2, recovered: true });
    assert.deepEqual(await findTmpFiles(dir), []);
  });

  test('3) Corrupt tui.json and tui-board.json refuse silent overwrite by default and create .corrupt-*.bak on forced/explicit recovery', async (t) => {
    const dir = await makeTempDir(t);
    const dshHome = path.join(dir, 'dsh');
    const libRoot = path.join(dir, 'lib');
    const prefsFile = tuiPreferencesPath({ env: { DSH_HOME: dshHome } });
    const boardFile = boardFilePath(libRoot);

    // --- 3a) Corrupt tui.json ---
    await atomicWriteTextFile(prefsFile, '{"theme":"nord", BROKEN_PREFS');
    const corruptPrefsRaw = await readFile(prefsFile, 'utf8');

    const safeRead = await loadTuiPreferencesSafe({ env: { DSH_HOME: dshHome } });
    assert.equal(safeRead.status, 'corrupt');

    // Passive patch must NOT overwrite or delete corrupt tui.json
    const passiveResult = await saveTuiPreferences(
      { recentCommands: ['open-reader'], lastReadPages: { 'src-1': 7 } },
      { env: { DSH_HOME: dshHome } },
    );
    assert.deepEqual(passiveResult.recentCommands, ['open-reader']);
    assert.equal(await readFile(prefsFile, 'utf8'), corruptPrefsRaw, 'passive patch must leave corrupt tui.json untouched');
    const prefsDirFilesBefore = await readdir(path.dirname(prefsFile));
    assert.equal(
      prefsDirFilesBefore.some((f) => f.includes('.corrupt-')),
      false,
      'passive skip must not create backup yet',
    );

    // Explicit user setting backs up corrupt file to .corrupt-*.bak and writes valid prefs
    const recoveredPrefs = await saveTuiPreferences(
      { theme: 'warm-paper', language: 'en' },
      { env: { DSH_HOME: dshHome } },
    );
    assert.equal(recoveredPrefs.theme, 'warm-paper');
    assert.equal(recoveredPrefs.language, 'en');

    const prefsDirFilesAfter = await readdir(path.dirname(prefsFile));
    const prefsBak = prefsDirFilesAfter.find((f) => f.startsWith('tui.json.corrupt-') && f.endsWith('.bak'));
    assert.ok(prefsBak, `expected tui.json.corrupt-*.bak backup, found: ${prefsDirFilesAfter.join(', ')}`);
    assert.equal(
      await readFile(path.join(path.dirname(prefsFile), prefsBak), 'utf8'),
      corruptPrefsRaw,
      'backup file must preserve exact original corrupt bytes',
    );
    assert.deepEqual(await findTmpFiles(path.dirname(prefsFile)), []);

    const reloadedPrefs = await loadTuiPreferencesSafe({ env: { DSH_HOME: dshHome } });
    assert.equal(reloadedPrefs.status, 'ok');
    assert.equal(reloadedPrefs.prefs.theme, 'warm-paper');

    // --- 3b) Corrupt tui-board.json ---
    const corruptBoardRaw = '{"version":1,"cards":[{"id":"x" BROKEN';
    await atomicWriteTextFile(boardFile, corruptBoardRaw);

    const safeBoard = await loadBoardSafe(libRoot);
    assert.equal(safeBoard.ok, false);

    // Default saveBoard refuses to overwrite corrupt file
    const nextDoc = makeBoardDoc([{ id: 'new-1', title: '恢复后的任务', column: 'todo' }]);
    await assert.rejects(
      saveBoard(libRoot, nextDoc),
      /tui-board\.json.*refusing to overwrite/i,
    );
    assert.equal(await readFile(boardFile, 'utf8'), corruptBoardRaw, 'default saveBoard must keep corrupt bytes untouched');
    assert.equal(
      (await readdir(libRoot)).some((f) => f.includes('.corrupt-')),
      false,
      'refused saveBoard must not create .bak',
    );

    // Forced recovery creates .corrupt-*.bak and persists valid board
    const savedDoc = await saveBoard(libRoot, nextDoc, { force: true });
    assert.equal(savedDoc.cards.length, 1);
    assert.equal(savedDoc.cards[0].title, '恢复后的任务');

    const libFilesAfter = await readdir(libRoot);
    const boardBak = libFilesAfter.find((f) => f.startsWith('tui-board.json.corrupt-') && f.endsWith('.bak'));
    assert.ok(boardBak, `expected tui-board.json.corrupt-*.bak, found: ${libFilesAfter.join(', ')}`);
    assert.equal(await readFile(path.join(libRoot, boardBak), 'utf8'), corruptBoardRaw);
    assert.deepEqual(await findTmpFiles(libRoot), []);

    const reloadedBoard = await loadBoardSafe(libRoot);
    assert.equal(reloadedBoard.ok, true);
    assert.equal(reloadedBoard.doc.cards[0].id, 'new-1');

    // Non-object root JSON (array) is also rejected by default and recoverable with force
    await atomicWriteTextFile(boardFile, '[1, 2, 3]\n');
    await assert.rejects(saveBoard(libRoot, nextDoc), /refusing to overwrite/i);
    assert.equal(await readFile(boardFile, 'utf8'), '[1, 2, 3]\n');
  });

  test('4) Multi-file atomicWriteFilesBatch LIFO rollback, removal of newly created targets, and AtomicBatchWriteError reporting', async (t) => {
    const dir = await makeTempDir(t);
    const fileA = path.join(dir, 'a.json');
    const fileB = path.join(dir, 'b-new.json');
    const fileC = path.join(dir, 'c.json');
    const fileD = path.join(dir, 'd-fail.json');

    const origA = '{"file":"A","v":1}\n';
    const origC = '{"file":"C","v":1}\n';
    await writeFile(fileA, origA, 'utf8');
    await writeFile(fileC, origC, 'utf8');

    // Track rename order during commit and rollback
    const renameTargets = [];
    let failedOnce = false;
    await assert.rejects(
      atomicWriteFilesBatch(
        [
          { path: fileA, content: '{"file":"A","v":2}\n' },
          { path: fileB, content: '{"file":"B","v":2}\n' },
          { path: fileC, content: '{"file":"C","v":2}\n' },
          { path: fileD, content: '{"file":"D","v":2}\n' },
        ],
        {
          fsOps: {
            rename: async (from, to) => {
              renameTargets.push(path.basename(to));
              if (to === fileD && !failedOnce) {
                failedOnce = true;
                throw Object.assign(new Error('EIO: disk failure on D'), { code: 'EIO' });
              }
              await fsRename(from, to);
            },
          },
        },
      ),
      /EIO: disk failure on D/,
    );

    // LIFO verification: C must be restored before A (B is removed via rm, not rename)
    assert.deepEqual(
      renameTargets,
      ['a.json', 'b-new.json', 'c.json', 'd-fail.json', 'c.json', 'a.json'],
      'batch rollback must restore prior targets in strict LIFO order',
    );
    assert.equal(await readFile(fileA, 'utf8'), origA, 'fileA restored byte-identically');
    assert.equal(await readFile(fileC, 'utf8'), origC, 'fileC restored byte-identically');
    assert.equal(existsSync(fileB), false, 'newly created fileB must be deleted during rollback');
    assert.equal(existsSync(fileD), false, 'failed fileD must not exist');
    assert.deepEqual(await findTmpFiles(dir), [], 'zero orphan .tmp files after batch rollback');

    // Rollback failure reporting: commit fails on fileC, and restoring fileA also fails -> AtomicBatchWriteError
    let commitPhase = true;
    const batchErr = await atomicWriteFilesBatch(
      [
        { path: fileA, content: '{"file":"A","v":3}\n' },
        { path: fileC, content: '{"file":"C","v":3}\n' },
      ],
      {
        fsOps: {
          rename: async (from, to) => {
            if (commitPhase && to === fileC) {
              commitPhase = false;
              throw Object.assign(new Error('EIO: commit C failed'), { code: 'EIO' });
            }
            if (!commitPhase && to === fileA) {
              throw Object.assign(new Error('EACCES: restore A denied'), { code: 'EACCES' });
            }
            await fsRename(from, to);
          },
        },
      },
    ).then(
      () => null,
      (err) => err,
    );

    assert.ok(batchErr instanceof AtomicBatchWriteError, 'must throw AtomicBatchWriteError when rollback fails');
    assert.match(String(batchErr.originalError), /commit C failed/);
    assert.equal(batchErr.rollbackFailures.length, 1);
    assert.equal(batchErr.rollbackFailures[0].path, fileA);
    assert.match(String(batchErr.rollbackFailures[0].error), /restore A denied/);
    assert.match(batchErr.message, /mixed|mix old and new/i);
    assert.deepEqual(await findTmpFiles(dir), [], 'zero orphan .tmp even when rollback fails');
  });

  test('5) tx-write.ts (runAtomicSteps, runIdempotentTwoStep, runOptimisticWrite) + withRollback integrated with real disk writes', async (t) => {
    const dir = await makeTempDir(t);
    const prefsFile = path.join(dir, 'tui.json');
    const boardFile = path.join(dir, 'tui-board.json');
    await writeFile(prefsFile, '{"theme":"dsh-dark"}\n', 'utf8');
    const prefsSnapshot = await readFile(prefsFile, 'utf8');

    // 5a) runAtomicSteps executes LIFO rollbacks on step-3 failure
    const rollbackLog = [];
    const stepOutcome = await runAtomicSteps([
      {
        name: 'update-prefs',
        run: async () => {
          const prev = await readFile(prefsFile, 'utf8');
          await atomicUpdateJson(prefsFile, (p) => ({ ...p, theme: 'nord' }));
          return { ok: true, value: prev };
        },
        rollback: async (prevRaw) => {
          rollbackLog.push('update-prefs');
          await atomicWriteTextFile(prefsFile, prevRaw);
        },
      },
      {
        name: 'create-board',
        run: async () => {
          await atomicWriteJsonFile(boardFile, emptyBoard());
          return { ok: true, value: boardFile };
        },
        rollback: async (createdPath) => {
          rollbackLog.push('create-board');
          await rm(createdPath, { force: true });
        },
      },
      {
        name: 'publish-manifest',
        run: async () => ({ ok: false, error: 'manifest validation rejected' }),
      },
    ]);

    assert.equal(stepOutcome.ok, false);
    assert.equal(stepOutcome.failedStep, 'publish-manifest');
    assert.equal(stepOutcome.failedIndex, 2);
    assert.equal(stepOutcome.rolledBack, true);
    assert.deepEqual(stepOutcome.rollbackErrors, []);
    assert.deepEqual(rollbackLog, ['create-board', 'update-prefs'], 'runAtomicSteps must roll back in LIFO order');
    assert.equal(await readFile(prefsFile, 'utf8'), prefsSnapshot);
    assert.equal(existsSync(boardFile), false);

    // 5b) runAtomicSteps reports rollbackErrors while still executing earlier rollbacks
    const partialLog = [];
    const partialRollback = await runAtomicSteps([
      {
        name: 's1',
        run: async () => ({ ok: true, value: 'v1' }),
        rollback: async () => {
          partialLog.push('s1');
        },
      },
      {
        name: 's2',
        run: async () => ({ ok: true, value: 'v2' }),
        rollback: async () => {
          partialLog.push('s2-boom');
          throw new Error('disk vanished');
        },
      },
      {
        name: 's3',
        run: async () => {
          throw new Error('s3 threw');
        },
      },
    ]);
    assert.equal(partialRollback.ok, false);
    assert.equal(partialRollback.rolledBack, false);
    assert.deepEqual(partialLog, ['s2-boom', 's1']);
    assert.equal(partialRollback.rollbackErrors.length, 1);
    assert.match(partialRollback.rollbackErrors[0], /s2: disk vanished/);

    // 5c) runIdempotentTwoStep caches step1 across retry (no duplicate creation) & supports rollbackStep1
    let cached = null;
    let step1Runs = 0;
    let step2Runs = 0;
    const step1File = path.join(dir, 'step1-record.json');
    const step2File = path.join(dir, 'step2-link.json');

    const firstTry = await runIdempotentTwoStep({
      cachedStep1: cached,
      setCachedStep1: (v) => {
        cached = v;
      },
      step1: async () => {
        step1Runs += 1;
        await atomicWriteJsonFile(step1File, { id: 'rec-1', runs: step1Runs });
        return { ok: true, value: 'rec-1' };
      },
      step2: async () => {
        step2Runs += 1;
        return { ok: false, error: 'transient step2 failure' };
      },
    });
    assert.equal(firstTry.ok, false);
    assert.equal(firstTry.step1Succeeded, true);
    assert.equal(cached, 'rec-1');
    assert.equal(step1Runs, 1);

    const retry = await runIdempotentTwoStep({
      cachedStep1: cached,
      setCachedStep1: (v) => {
        cached = v;
      },
      step1: async () => {
        step1Runs += 1;
        return { ok: true, value: 'rec-duplicate' };
      },
      step2: async (id) => {
        step2Runs += 1;
        await atomicWriteJsonFile(step2File, { linkedTo: id });
        return { ok: true, value: { linkedTo: id } };
      },
    });
    assert.equal(retry.ok, true);
    assert.equal(retry.step1Value, 'rec-1');
    assert.equal(step1Runs, 1, 'step1 must not re-run when cached');
    assert.equal(step2Runs, 2);
    assert.equal(cached, null, 'cache must clear after full success');
    assert.deepEqual(JSON.parse(await readFile(step2File, 'utf8')), { linkedTo: 'rec-1' });

    // With rollbackStep1: step2 failure removes step1 file and clears cache
    const rbTarget = path.join(dir, 'step1-rb.json');
    let rbCached = null;
    const rbRes = await runIdempotentTwoStep({
      cachedStep1: rbCached,
      setCachedStep1: (v) => {
        rbCached = v;
      },
      step1: async () => {
        await atomicWriteJsonFile(rbTarget, { created: true });
        return { ok: true, value: rbTarget };
      },
      step2: async () => ({ ok: false, error: 'step2 rejected' }),
      rollbackStep1: async (createdPath) => {
        await rm(createdPath, { force: true });
        return true;
      },
    });
    assert.equal(rbRes.ok, false);
    assert.equal(rbRes.rolledBack, true);
    assert.equal(rbCached, null);
    assert.equal(existsSync(rbTarget), false);

    // 5d) runOptimisticWrite restores UI snapshot when real disk write fails
    let uiState = { theme: 'dsh-dark' };
    const optOutcome = await runOptimisticWrite({
      getSnapshot: () => ({ ...uiState }),
      applyOptimistic: () => {
        uiState = { theme: 'high-contrast' };
      },
      write: async () => {
        await atomicUpdateJson(prefsFile, () => ({ theme: 'high-contrast' }), {
          fsOps: {
            rename: async () => {
              throw Object.assign(new Error('ENOSPC: write failed'), { code: 'ENOSPC' });
            },
          },
        });
        return { ok: true };
      },
      restoreSnapshot: (snap) => {
        uiState = snap;
      },
    });
    assert.equal(optOutcome.ok, false);
    assert.match(optOutcome.error ?? '', /ENOSPC/);
    assert.deepEqual(uiState, { theme: 'dsh-dark' }, 'UI state must roll back to snapshot');
    assert.equal(await readFile(prefsFile, 'utf8'), prefsSnapshot);

    // 5e) withRollback throws AtomicRollbackError when both run and restore fail
    const rbErr = await withRollback(
      prefsFile,
      async () => {
        throw new Error('primary write aborted');
      },
      {
        fsOps: {
          rename: async () => {
            throw Object.assign(new Error('EROFS: read-only fs'), { code: 'EROFS' });
          },
        },
      },
    ).then(
      () => null,
      (e) => e,
    );
    assert.ok(rbErr instanceof AtomicRollbackError);
    assert.match(String(rbErr.originalError), /primary write aborted/);
    assert.match(String(rbErr.rollbackError), /EROFS/);
    assert.deepEqual(await findTmpFiles(dir), []);
  });

  test('6) BoardSaveCoordinator: rolls back in-memory & UI doc state on disk save failure, handles superseding saves, and recovers cleanly on subsequent valid saves', async (t) => {
    const dir = await makeTempDir(t);
    const initialDoc = makeBoardDoc([{ id: 'c1', title: '初始任务', column: 'todo' }]);
    await saveBoard(dir, initialDoc);

    let injectFailure = null;
    const savedSeqTitles = [];
    const coordinator = createBoardSaveCoordinator({
      initialDoc,
      saveFn: async (nextDoc) => {
        if (injectFailure) {
          throw injectFailure;
        }
        const saved = await saveBoard(dir, nextDoc);
        savedSeqTitles.push(saved.cards.map((c) => c.title));
        return saved;
      },
    });

    const uiHistory = [];
    const errors = [];

    // 6a) Failing disk save -> optimistic UI update happens synchronously, then rolls back in-memory & UI state
    injectFailure = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    const afterFailed = await coordinator.persist(
      (prev) => ({
        ...prev,
        cards: [...prev.cards, { ...initialDoc.cards[0], id: 'c2', title: '会失败的新任务', column: 'doing' }],
      }),
      (doc) => uiHistory.push(doc.cards.map((c) => c.title)),
      (err) => errors.push(err),
    );

    assert.equal(errors.length, 1);
    assert.match(boardSaveFailureNotice(errors[0], 'zh'), /修改没有保存.*已恢复.*ENOSPC/);
    assert.match(boardSaveFailureNotice(errors[0], 'en'), /not saved.*reverted.*ENOSPC/i);

    assert.deepEqual(
      uiHistory,
      [['初始任务', '会失败的新任务'], ['初始任务']],
      'UI state must optimistically show the edit and then roll back to lastPersistedDoc',
    );
    assert.deepEqual(
      coordinator.getDoc().cards.map((c) => c.title),
      ['初始任务'],
      'in-memory coordinator doc must roll back to lastPersistedDoc',
    );
    assert.deepEqual(afterFailed.cards.map((c) => c.title), ['初始任务']);

    const diskAfterFail = await loadBoardSafe(dir);
    assert.equal(diskAfterFail.ok, true);
    assert.deepEqual(diskAfterFail.doc.cards.map((c) => c.title), ['初始任务']);

    // 6b) Real corrupt-file disk refusal also triggers clean rollback in BoardSaveCoordinator
    injectFailure = null;
    const boardFile = boardFilePath(dir);
    await atomicWriteTextFile(boardFile, '{"version":1, CORRUPT');
    uiHistory.length = 0;
    errors.length = 0;

    await coordinator.persist(
      (prev) => ({
        ...prev,
        cards: [...prev.cards, { ...initialDoc.cards[0], id: 'c3', title: '遇到损坏文件', column: 'todo' }],
      }),
      (doc) => uiHistory.push(doc.cards.map((c) => c.title)),
      (err) => errors.push(err),
    );
    assert.equal(errors.length, 1);
    assert.match(String(errors[0]), /refusing to overwrite/i);
    assert.deepEqual(uiHistory.at(-1), ['初始任务'], 'UI must revert when saveBoard refuses corrupt file');
    assert.deepEqual(coordinator.getDoc().cards.map((c) => c.title), ['初始任务']);

    // Repair disk file via forced save, then subsequent normal coordinator save must recover cleanly
    await saveBoard(dir, initialDoc, { force: true });
    uiHistory.length = 0;
    errors.length = 0;

    const recovered = await coordinator.persist(
      (prev) => ({
        ...prev,
        cards: [...prev.cards, { ...initialDoc.cards[0], id: 'c4', title: '恢复后的有效任务', column: 'done' }],
      }),
      (doc) => uiHistory.push(doc.cards.map((c) => c.title)),
      (err) => errors.push(err),
    );

    assert.equal(errors.length, 0);
    assert.deepEqual(recovered.cards.map((c) => c.title), ['初始任务', '恢复后的有效任务']);
    assert.deepEqual(coordinator.getDoc().cards.map((c) => c.title), ['初始任务', '恢复后的有效任务']);
    const diskRecovered = await loadBoardSafe(dir);
    assert.equal(diskRecovered.ok, true);
    assert.deepEqual(diskRecovered.doc.cards.map((c) => c.title), ['初始任务', '恢复后的有效任务']);

    // 6c) Rapid overlapping persists: slow in-flight s1 never reverts newer state, intermediate s2 is skipped, final s3 persists
    let markFirstStarted;
    const firstSlowStarted = new Promise((r) => {
      markFirstStarted = r;
    });
    let releaseFirstSlow;
    const firstSlowGate = new Promise((r) => {
      releaseFirstSlow = r;
    });
    const slowSaves = [];
    const slowCoord = createBoardSaveCoordinator({
      initialDoc,
      saveFn: async (nextDoc) => {
        const snapshotTitles = nextDoc.cards.map((c) => c.title);
        slowSaves.push(snapshotTitles);
        if (slowSaves.length === 1) {
          markFirstStarted();
          await firstSlowGate;
        }
        return saveBoard(dir, nextDoc);
      },
    });

    const slowUi = [];
    const p1 = slowCoord.persist(
      (prev) => ({ ...prev, cards: [...prev.cards, { ...initialDoc.cards[0], id: 's1', title: '慢写1', column: 'todo' }] }),
      (d) => slowUi.push(d.cards.map((c) => c.title)),
    );
    await firstSlowStarted;
    const p2 = slowCoord.persist(
      (prev) => ({ ...prev, cards: [...prev.cards, { ...initialDoc.cards[0], id: 's2', title: '中间态2', column: 'doing' }] }),
      (d) => slowUi.push(d.cards.map((c) => c.title)),
    );
    const p3 = slowCoord.persist(
      (prev) => ({ ...prev, cards: [...prev.cards, { ...initialDoc.cards[0], id: 's3', title: '最终态3', column: 'done' }] }),
      (d) => slowUi.push(d.cards.map((c) => c.title)),
    );

    releaseFirstSlow();
    await Promise.all([p1, p2, p3]);
    await slowCoord.flush();

    assert.equal(slowSaves.length, 2, 'intermediate superseded write s2 must be skipped while in-flight s1 and final s3 run');
    assert.deepEqual(slowCoord.getDoc().cards.map((c) => c.title), ['初始任务', '慢写1', '中间态2', '最终态3']);
    assert.deepEqual(slowUi.at(-1), ['初始任务', '慢写1', '中间态2', '最终态3']);
    const finalDisk = await loadBoardSafe(dir);
    assert.equal(finalDisk.ok, true);
    assert.deepEqual(finalDisk.doc.cards.map((c) => c.title), ['初始任务', '慢写1', '中间态2', '最终态3']);
    assert.deepEqual(await findTmpFiles(dir), []);
  });

  test('7) Concurrent saveTuiPreferences calls serialize cleanly through atomicUpdateJson with zero lost keys', async (t) => {
    const dir = await makeTempDir(t);
    const dshHome = path.join(dir, 'dsh');
    const loc = { env: { DSH_HOME: dshHome } };

    await saveTuiPreferences({ theme: 'dsh-dark', language: 'zh' }, loc);

    // Fire overlapping updates to disjoint preference fields concurrently
    await Promise.all([
      saveTuiPreferences({ theme: 'nord' }, loc),
      saveTuiPreferences({ language: 'en' }, loc),
      saveTuiPreferences({ compactMode: true }, loc),
      saveTuiPreferences({ sidebarCollapsed: true }, loc),
      saveTuiPreferences({ recentCommands: ['cmd-1', 'cmd-2'] }, loc),
      saveTuiPreferences({ lastReadPages: { 'doc-a': 12 } }, loc),
    ]);

    const finalRes = await loadTuiPreferencesSafe(loc);
    assert.equal(finalRes.status, 'ok');
    assert.equal(finalRes.prefs.theme, 'nord');
    assert.equal(finalRes.prefs.language, 'en');
    assert.equal(finalRes.prefs.compactMode, true);
    assert.equal(finalRes.prefs.sidebarCollapsed, true);
    assert.deepEqual(finalRes.prefs.recentCommands, ['cmd-1', 'cmd-2']);
    assert.deepEqual(finalRes.prefs.lastReadPages, { 'doc-a': 12 });
    assert.deepEqual(await findTmpFiles(path.dirname(tuiPreferencesPath(loc))), []);
  });
});
