// P3-b (#1354 D10/D11): Permanent Atomic-Write & Failure-Rollback Guardrails for StudyHub TUI.
// Enforces temp+sync+rename for every file write, zero half-written files or orphan .tmp files
// on failure, multi-file batch rollback, and ESLint bans on raw fs write/copy/rename APIs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build as esbuild } from 'esbuild';
import { ESLint } from 'eslint';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TUI_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(TUI_ROOT, '../..');
const SRC_DIR = path.join(TUI_ROOT, 'src');

const eslint = new ESLint({ cwd: REPO_ROOT });

function walkTsFiles(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkTsFiles(full, out);
    else if (/\.(ts|tsx)$/.test(ent.name)) out.push(full);
  }
  return out;
}

describe('P3-b (#1354): Atomic File Persistence, Rollback & Zero Half-Write Guardrails', () => {
  test('1. ESLint blocks all raw fs write/append/copy/rename imports everywhere in TUI src/ outside host/atomic-write.ts', async () => {
    const badSamples = [
      "import { writeFile } from 'node:fs/promises';\nexport const f = writeFile;\n",
      "import { appendFile } from 'node:fs/promises';\nexport const f = appendFile;\n",
      "import { copyFile } from 'node:fs/promises';\nexport const f = copyFile;\n",
      "import { rename } from 'node:fs/promises';\nexport const f = rename;\n",
      "import { writeFileSync, createWriteStream } from 'node:fs';\nexport const f = [writeFileSync, createWriteStream];\n",
    ];
    for (const code of badSamples) {
      const [res] = await eslint.lintText(code, {
        filePath: path.join(REPO_ROOT, 'packages/studyhub-tui/src/views/fake-persist.tsx'),
      });
      assert.ok(
        res.messages.some((m) => m.ruleId === 'no-restricted-imports' && m.severity === 2),
        `ESLint must reject raw fs write/copy/rename import:\n${code}\ngot: ${JSON.stringify(res.messages)}`,
      );
    }

    // Static scan across src/: only host/atomic-write.ts may import writeFile/copyFile/rename/appendFile from fs
    const RAW_FS_WRITE_IMPORT_RE =
      /import\s+\{[^}]*\b(?:writeFile|writeFileSync|appendFile|appendFileSync|copyFile|copyFileSync|rename|renameSync|createWriteStream)\b[^}]*\}\s+from\s+['"](?:node:)?fs(?:\/promises)?['"]/;
    const rawViolations = [];
    for (const file of walkTsFiles(SRC_DIR)) {
      const rel = path.relative(SRC_DIR, file).replace(/\\/g, '/');
      if (rel === 'host/atomic-write.ts') continue;
      const src = fs.readFileSync(file, 'utf8');
      if (RAW_FS_WRITE_IMPORT_RE.test(src)) {
        rawViolations.push(rel);
      }
    }
    assert.deepEqual(
      rawViolations,
      [],
      `Found raw fs write/copy/rename imports outside host/atomic-write.ts: ${rawViolations.join(', ')}`,
    );
  });

  test('2. atomicWriteTextFile cleans up temp file on mid-write failure, mid-rename failure, and preserves existing target', async (t) => {
    const { atomicWriteTextFile } = await import('../src/host/atomic-write.ts');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'studyhub-p3-atomic-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const target = path.join(dir, 'state.json');
    const original = '{"version":1,"stable":true}\n';
    await writeFile(target, original, 'utf8');

    // A) Mid-write failure: temp file created then write fails -> temp MUST be deleted, target untouched
    let syncCalled = false;
    await assert.rejects(
      atomicWriteTextFile(target, '{"version":1,"half":', {
        fsOps: {
          writeAndSync: async (tempPath) => {
            await writeFile(tempPath, '{"half":', 'utf8');
            throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
          },
        },
      }),
      /ENOSPC/,
    );
    assert.equal(await readFile(target, 'utf8'), original, 'Existing target must remain untouched after write failure');
    assert.deepEqual(
      (await readdir(dir)).filter((f) => f.endsWith('.tmp')),
      [],
      'Zero orphaned .tmp files allowed after mid-write failure',
    );

    // B) Mid-rename failure: temp written completely, rename throws EIO -> temp MUST be deleted, target untouched
    await assert.rejects(
      atomicWriteTextFile(target, '{"version":1,"new":true}\n', {
        fsOps: {
          rename: async () => {
            throw Object.assign(new Error('EIO: rename failed'), { code: 'EIO' });
          },
        },
      }),
      /EIO/,
    );
    assert.equal(await readFile(target, 'utf8'), original, 'Existing target must remain untouched after rename failure');
    assert.deepEqual(
      (await readdir(dir)).filter((f) => f.endsWith('.tmp')),
      [],
      'Zero orphaned .tmp files allowed after rename failure',
    );

    // C) Transient EBUSY on rename retries and succeeds, calling sync before rename
    let renameAttempts = 0;
    const realFs = await import('node:fs/promises');
    const res = await atomicWriteTextFile(target, '{"version":1,"updated":42}\n', {
      fsOps: {
        onSync: () => {
          syncCalled = true;
        },
        rename: async (from, to) => {
          renameAttempts += 1;
          if (renameAttempts === 1) {
            throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
          }
          await realFs.rename(from, to);
        },
      },
    });
    assert.ok(res.bytes > 0);
    assert.equal(syncCalled, true, 'atomicWriteTextFile must sync file data before rename');
    assert.equal(renameAttempts, 2, 'atomicWriteTextFile must retry transient EBUSY rename');
    assert.equal(await readFile(target, 'utf8'), '{"version":1,"updated":42}\n');
    assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith('.tmp')), []);
  });

  test('3. atomicCopyFile copies atomically via temp+rename and preserves target on failure', async (t) => {
    const { atomicCopyFile } = await import('../src/host/atomic-write.ts');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'studyhub-p3-copy-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const src = path.join(dir, 'source.txt');
    const dest = path.join(dir, 'dest.txt');
    await writeFile(src, 'fresh-backup-bytes', 'utf8');
    await writeFile(dest, 'prior-dest-bytes', 'utf8');

    // Failure during rename leaves dest untouched and zero .tmp files
    await assert.rejects(
      atomicCopyFile(src, dest, {
        fsOps: {
          rename: async () => {
            throw Object.assign(new Error('EIO'), { code: 'EIO' });
          },
        },
      }),
      /EIO/,
    );
    assert.equal(await readFile(dest, 'utf8'), 'prior-dest-bytes');
    assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith('.tmp')), []);

    // Success atomically replaces dest
    await atomicCopyFile(src, dest);
    assert.equal(await readFile(dest, 'utf8'), 'fresh-backup-bytes');
    assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith('.tmp')), []);
  });

  test('4. atomicWriteFilesBatch commits all files or rolls back already-renamed files cleanly on failure', async (t) => {
    const { atomicWriteFilesBatch } = await import('../src/host/atomic-write.ts');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'studyhub-p3-batch-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const fileA = path.join(dir, 'a.json');
    const fileB = path.join(dir, 'b.json');
    const fileC = path.join(dir, 'c.json');
    await writeFile(fileA, '{"v":"old-a"}\n', 'utf8');
    await writeFile(fileB, '{"v":"old-b"}\n', 'utf8');

    // Failure while renaming fileB AFTER fileA was already renamed -> fileA MUST roll back to old-a, fileC must not exist!
    const realFs = await import('node:fs/promises');
    await assert.rejects(
      atomicWriteFilesBatch(
        [
          { path: fileA, content: '{"v":"new-a"}\n' },
          { path: fileC, content: '{"v":"new-c"}\n' },
          { path: fileB, content: '{"v":"new-b"}\n' },
        ],
        {
          fsOps: {
            rename: async (from, to) => {
              if (to === fileB) {
                throw Object.assign(new Error('EIO on fileB'), { code: 'EIO' });
              }
              await realFs.rename(from, to);
            },
          },
        },
      ),
      /EIO on fileB/,
    );
    assert.equal(await readFile(fileA, 'utf8'), '{"v":"old-a"}\n', 'fileA must roll back to previous contents');
    assert.equal(await readFile(fileB, 'utf8'), '{"v":"old-b"}\n', 'fileB must remain unchanged');
    assert.equal(fs.existsSync(fileC), false, 'newly created fileC must be removed on batch rollback');
    assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith('.tmp')), [], 'zero orphan .tmp files after batch rollback');

    // Happy path commits all 3 files atomically
    await atomicWriteFilesBatch([
      { path: fileA, content: '{"v":"ok-a"}\n' },
      { path: fileB, content: '{"v":"ok-b"}\n' },
      { path: fileC, content: '{"v":"ok-c"}\n' },
    ]);
    assert.equal(await readFile(fileA, 'utf8'), '{"v":"ok-a"}\n');
    assert.equal(await readFile(fileB, 'utf8'), '{"v":"ok-b"}\n');
    assert.equal(await readFile(fileC, 'utf8'), '{"v":"ok-c"}\n');
    assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith('.tmp')), []);
  });

  test('4b. atomicWriteFilesBatch reports rollback failures together with the original commit error (#1454)', async (t) => {
    const { atomicWriteFilesBatch, AtomicBatchWriteError } = await import('../src/host/atomic-write.ts');
    assert.equal(typeof AtomicBatchWriteError, 'function', 'atomic-write must export AtomicBatchWriteError');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'studyhub-p3-batch-rb-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const fileA = path.join(dir, 'a.json');
    const fileB = path.join(dir, 'b.json');
    const fileC = path.join(dir, 'c.json');
    await writeFile(fileA, '{"v":"old-a"}\n', 'utf8');
    await writeFile(fileB, '{"v":"old-b"}\n', 'utf8');

    const realFs = await import('node:fs/promises');
    let renamesToA = 0;
    // fileC is new (no prior bytes), fileA is pre-existing. Commit order A -> C -> B, so B failing
    // triggers a rollback of C (remove) and A (restore old bytes). The restore rename for A also
    // fails, simulating a file that is locked for BOTH the commit and the rollback.
    const err = await atomicWriteFilesBatch(
      [
        { path: fileA, content: '{"v":"new-a"}\n' },
        { path: fileC, content: '{"v":"new-c"}\n' },
        { path: fileB, content: '{"v":"new-b"}\n' },
      ],
      {
        fsOps: {
          rename: async (from, to) => {
            if (to === fileB) {
              throw Object.assign(new Error('EIO on fileB'), { code: 'EIO' });
            }
            if (to === fileA) {
              renamesToA += 1;
              if (renamesToA > 1) {
                throw Object.assign(new Error('EIO restoring fileA'), { code: 'EIO' });
              }
            }
            await realFs.rename(from, to);
          },
        },
      },
    ).then(
      () => null,
      (thrown) => thrown,
    );

    assert.ok(err, 'batch write must reject when a commit rename fails');
    assert.equal(err.name, 'AtomicBatchWriteError', 'rollback failures must surface as AtomicBatchWriteError');
    assert.ok(err instanceof AtomicBatchWriteError, 'rejection must be an AtomicBatchWriteError instance');
    assert.match(String(err.message), /EIO on fileB/, 'must keep the original commit error (file B)');
    assert.match(String(err.message), /EIO restoring fileA/, 'must also report the failed rollback of file A');
    assert.equal(err.originalError?.message, 'EIO on fileB', 'originalError must be attached as a field');
    assert.ok(err.cause instanceof Error, 'Error.cause must carry the original commit error');
    assert.deepEqual(
      err.rollbackFailures.map((f) => f.path),
      [fileA],
      'rollbackFailures must list every target whose restore/removal failed',
    );
    assert.match(String(err.rollbackFailures[0].error?.message), /EIO restoring fileA/);
    assert.equal(
      await readFile(fileA, 'utf8'),
      '{"v":"new-a"}\n',
      'fileA keeps the new bytes because the restore failed: callers must be told about this mixed state',
    );
    assert.equal(await readFile(fileB, 'utf8'), '{"v":"old-b"}\n', 'fileB must remain untouched');
    assert.equal(fs.existsSync(fileC), false, 'newly created fileC must still be removed during rollback');
    assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith('.tmp')), [], 'zero orphan .tmp files after failed rollback');

    // When every rollback step succeeds the original error is rethrown unchanged (no wrapper noise).
    const plain = await atomicWriteFilesBatch(
      [
        { path: fileA, content: '{"v":"ok-a"}\n' },
        { path: fileB, content: '{"v":"ok-b"}\n' },
      ],
      {
        fsOps: {
          rename: async () => {
            throw Object.assign(new Error('EIO on purpose'), { code: 'EIO' });
          },
        },
      },
    ).then(
      () => null,
      (thrown) => thrown,
    );
    assert.ok(plain, 'batch write must reject');
    assert.equal(plain.message, 'EIO on purpose', 'successful rollback must preserve the original error verbatim');
    assert.equal(plain.name, 'Error', 'successful rollback must not wrap the error');
  });

  test('5. createBoardSaveCoordinator rolls back optimistic memory & UI state when disk save fails', async () => {
    const { createBoardSaveCoordinator, emptyBoard } = await import('../src/views/board/board-store.ts');
    const initial = {
      ...emptyBoard(),
      cards: [{ id: 'c1', title: 'Task 1', column: 'todo', createdAt: '2026-11-24T00:00:00Z', updatedAt: '2026-11-24T00:00:00Z' }],
    };
    const uiStates = [];
    const errors = [];

    const coordinator = createBoardSaveCoordinator({
      initialDoc: initial,
      saveFn: async () => {
        throw new Error('disk readonly');
      },
    });

    await coordinator.persist(
      (prev) => ({ ...prev, cards: prev.cards.map((c) => ({ ...c, column: 'doing' })) }),
      (doc) => uiStates.push(doc.cards[0]?.column),
      (err) => errors.push(err instanceof Error ? err.message : String(err)),
    );
    await coordinator.flush();

    assert.equal(errors.length, 1);
    assert.match(errors[0], /disk readonly/);
    assert.equal(
      coordinator.getDoc().cards[0].column,
      'todo',
      'BoardSaveCoordinator must roll back in-memory doc to last persisted state when saveFn fails',
    );
    assert.equal(
      uiStates.at(-1),
      'todo',
      'BoardSaveCoordinator must notify UI to roll back to last persisted state when saveFn fails',
    );
  });

  test('6. Desktop config-store cleans up orphan .tmp and write-probe files on write/rename failures', async (t) => {
    const configStorePath = path.join(REPO_ROOT, 'packages/studyhub-desktop/adapters/storage/config-store.mjs');
    const hookKey = '__studyhubConfigStoreFsHook_p3__';
    const fsHook = { writeFile: null, rename: null };
    globalThis[hookKey] = fsHook;
    const dir = await mkdtemp(path.join(os.tmpdir(), 'studyhub-p3-cfg-'));
    t.after(async () => {
      delete globalThis[hookKey];
      await rm(dir, { recursive: true, force: true });
    });

    const bundled = await esbuild({
      entryPoints: [configStorePath],
      bundle: true,
      format: 'esm',
      platform: 'node',
      write: false,
      plugins: [
        {
          name: 'inject-config-store-fs-faults',
          setup(buildApi) {
            buildApi.onResolve({ filter: /^node:fs\/promises$/ }, (args) => {
              if (args.namespace === 'fs-fault-inject') {
                return { path: 'node:fs/promises', external: true };
              }
              return {
                path: 'config-store-fs-wrapper',
                namespace: 'fs-fault-inject',
              };
            });
            buildApi.onLoad({ filter: /.*/, namespace: 'fs-fault-inject' }, () => ({
              contents: `
                import * as realFs from 'node:fs/promises';
                export const copyFile = realFs.copyFile;
                export const mkdir = realFs.mkdir;
                export const readFile = realFs.readFile;
                export const rm = realFs.rm;
                export const writeFile = (...args) => {
                  const hook = globalThis[${JSON.stringify(hookKey)}]?.writeFile;
                  return hook ? hook(realFs, ...args) : realFs.writeFile(...args);
                };
                export const rename = (...args) => {
                  const hook = globalThis[${JSON.stringify(hookKey)}]?.rename;
                  return hook ? hook(realFs, ...args) : realFs.rename(...args);
                };
              `,
              loader: 'js',
            }));
            buildApi.onResolve({ filter: /^node:/ }, (args) => ({ path: args.path, external: true }));
            buildApi.onResolve({ filter: /^\./ }, (args) => {
              if (!args.importer) return null;
              return {
                path: pathToFileURL(path.resolve(path.dirname(args.importer), args.path)).href,
                external: true,
              };
            });
          },
        },
      ],
    });
    const code = bundled.outputFiles[0].text;
    const { createConfigStore } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

    const dshHome = path.join(dir, 'dsh');
    const home = path.join(dir, 'home');
    const documentsDir = path.join(dir, 'docs');
    const store = createConfigStore({ env: { DSH_HOME: dshHome }, home, documentsDir });
    const studyHome = path.dirname(store.configPath);

    // Pre-seed valid desktop.json
    await store.save({ mode: 'openai', openai: { providerId: 'deepseek', model: 'deepseek-chat' } });
    const originalJson = await readFile(store.configPath, 'utf8');

    // A1) atomicWriteJson mid-write failure (ENOSPC after creating .tmp) -> rejects, target intact, 0 *.tmp
    let writeFaultFired = 0;
    fsHook.writeFile = async (realFs, targetPath, data, opts) => {
      if (String(targetPath).endsWith('.tmp')) {
        writeFaultFired += 1;
        await realFs.writeFile(targetPath, '{"partial":', 'utf8');
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      }
      return realFs.writeFile(targetPath, data, opts);
    };
    try {
      await assert.rejects(store.save({ mode: 'agy' }), /ENOSPC/);
    } finally {
      fsHook.writeFile = null;
    }
    assert.equal(writeFaultFired, 1, 'injected ENOSPC writeFile failure must have fired on temp file');
    assert.equal(await readFile(store.configPath, 'utf8'), originalJson, 'desktop.json must remain intact after mid-write failure');
    assert.deepEqual(
      (await readdir(studyHome)).filter((f) => f.endsWith('.tmp')),
      [],
      'zero orphan *.tmp files allowed in studyHome after mid-write failure',
    );

    // A2) atomicWriteJson mid-rename failure (EIO after writeFile completes) -> rejects, target intact, 0 *.tmp
    let renameFaultFired = 0;
    fsHook.rename = async () => {
      renameFaultFired += 1;
      throw Object.assign(new Error('EIO: rename failed'), { code: 'EIO' });
    };
    try {
      await assert.rejects(store.save({ mode: 'agy' }), /EIO/);
    } finally {
      fsHook.rename = null;
    }
    assert.equal(renameFaultFired, 1, 'injected EIO rename failure must have fired');
    assert.equal(await readFile(store.configPath, 'utf8'), originalJson, 'desktop.json must remain intact after rename failure');
    assert.deepEqual(
      (await readdir(studyHome)).filter((f) => f.endsWith('.tmp')),
      [],
      'zero orphan *.tmp files allowed in studyHome after rename failure',
    );

    // B1) verifyWritableDirectory happy path leaves 0 .studyhub-write-check-*.tmp probe files
    const normalLoaded = await store.load();
    assert.deepEqual(
      (await readdir(normalLoaded.library.root)).filter((f) => f.startsWith('.studyhub-write-check-')),
      [],
      'normal store.load() must leave zero write-check probe files',
    );

    // B2) verifyWritableDirectory probe writeFile failure (ENOSPC after creating probe) -> falls back & cleans probe
    const failingCandidate = path.join(dir, 'candidate-full');
    await fs.promises.mkdir(failingCandidate, { recursive: true });
    const resolvedCandidate = path.resolve(failingCandidate);
    const probeStore = createConfigStore({
      env: { DSH_HOME: dshHome, STUDYHUB_LIBRARY: failingCandidate },
      home,
      documentsDir,
    });
    let probeFaultFired = 0;
    fsHook.writeFile = async (realFs, targetPath, data, opts) => {
      const resolvedTarget = path.resolve(String(targetPath));
      if (
        path.dirname(resolvedTarget) === resolvedCandidate &&
        path.basename(resolvedTarget).startsWith('.studyhub-write-check-')
      ) {
        probeFaultFired += 1;
        await realFs.writeFile(resolvedTarget, 'partial-probe', 'utf8');
        throw Object.assign(new Error('ENOSPC: probe write failed'), { code: 'ENOSPC' });
      }
      return realFs.writeFile(targetPath, data, opts);
    };
    let fallbackLoaded;
    try {
      fallbackLoaded = await probeStore.load();
    } finally {
      fsHook.writeFile = null;
    }
    assert.equal(probeFaultFired, 1, 'injected ENOSPC probe failure must have fired in candidateDir');
    assert.ok(fallbackLoaded.library.problem, 'store.load() must report library fallback problem');
    assert.match(String(fallbackLoaded.library.problem.reason), /ENOSPC/);
    assert.notEqual(
      path.resolve(fallbackLoaded.library.root),
      resolvedCandidate,
      'store.load() must fall back away from unwritable candidate directory',
    );
    assert.deepEqual(
      (await readdir(failingCandidate)).filter((f) => f.startsWith('.studyhub-write-check-')),
      [],
      'zero orphan .studyhub-write-check-*.tmp probe files allowed in candidate directory after writeFile failure',
    );
    assert.deepEqual(
      (await readdir(fallbackLoaded.library.root)).filter((f) => f.startsWith('.studyhub-write-check-')),
      [],
      'zero orphan .studyhub-write-check-*.tmp probe files allowed in fallback library directory',
    );
  });
});
