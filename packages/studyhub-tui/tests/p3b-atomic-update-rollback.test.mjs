// P3-b (#1354): single-write atomic read-modify-write + rollback entry.
// Proves the new `atomicUpdateJson` / `withRollback` entry points keep the pre-write bytes
// untouched on failure, never leak `.tmp` files, rename exactly once on success, and surface
// errors a caller can display. Real filesystem only (mkdtemp), no fs mocks.
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const AW = await import('../src/host/atomic-write.ts');
const { atomicUpdateJson, atomicWriteTextFile, AtomicSkip, AtomicRollbackError, withRollback } = AW;

async function tempDir(t, prefix = 'studyhub-p3b-') {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const tmpLeftovers = (files) => files.filter((f) => f.endsWith('.tmp'));

describe('P3-b (#1354): atomicUpdateJson single-write read-modify-write', () => {
  test('① success path mutates from fresh content and renames exactly once', async (t) => {
    const dir = await tempDir(t);
    const target = path.join(dir, 'settings.json');
    await writeFile(target, '{"count":1,"keep":"yes"}\n', 'utf8');

    let renames = 0;
    const res = await atomicUpdateJson(
      target,
      (prev) => ({ ...prev, count: (prev?.count ?? 0) + 1 }),
      {
        fsOps: {
          rename: async (from, to) => {
            renames += 1;
            const { rename } = await import('node:fs/promises');
            await rename(from, to);
          },
        },
      },
    );

    assert.equal(res.updated, true);
    assert.equal(res.value.count, 2);
    assert.equal(res.value.keep, 'yes');
    assert.equal(renames, 1, 'successful update must rename exactly once');
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { count: 2, keep: 'yes' });
    assert.deepEqual(tmpLeftovers(await readdir(dir)), [], 'no .tmp files may survive a successful update');
  });

  test('① missing target starts from undefined and creates the file', async (t) => {
    const dir = await tempDir(t);
    const target = path.join(dir, 'fresh.json');
    const res = await atomicUpdateJson(target, (prev) => {
      assert.equal(prev, undefined);
      return { created: true };
    });
    assert.equal(res.updated, true);
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { created: true });
  });

  test('① write half-way failure leaves original bytes byte-identical and no .tmp behind', async (t) => {
    const dir = await tempDir(t);
    const target = path.join(dir, 'state.json');
    const original = '{"version":1,"stable":true,"列表":["甲","乙"]}\n';
    await writeFile(target, original, 'utf8');
    const before = await readFile(target);

    await assert.rejects(
      atomicUpdateJson(target, () => ({ version: 1, stable: false }), {
        fsOps: {
          writeAndSync: async (tempPath) => {
            await writeFile(tempPath, '{"version":1,"sta', 'utf8');
            throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
          },
        },
      }),
      /ENOSPC/,
    );

    assert.deepEqual(await readFile(target), before, 'original file must stay byte-identical');
    assert.deepEqual(tmpLeftovers(await readdir(dir)), [], 'no orphan .tmp after mid-write failure');
  });

  test('② a throwing mutator never writes anything', async (t) => {
    const dir = await tempDir(t);
    const target = path.join(dir, 'state.json');
    const original = '{"a":1}\n';
    await writeFile(target, original, 'utf8');
    const before = await readFile(target);

    await assert.rejects(
      atomicUpdateJson(target, () => {
        throw new Error('mutator exploded');
      }),
      /mutator exploded/,
    );

    assert.deepEqual(await readFile(target), before);
    assert.deepEqual(await readdir(dir), ['state.json'], 'no temp artifacts may be created');
  });

  test('② mid-rename failure preserves the original bytes', async (t) => {
    const dir = await tempDir(t);
    const target = path.join(dir, 'state.json');
    await writeFile(target, '{"keep":1}\n', 'utf8');
    const before = await readFile(target);

    await assert.rejects(
      atomicUpdateJson(target, () => ({ keep: 2 }), {
        fsOps: {
          rename: async () => {
            throw Object.assign(new Error('EIO: rename failed'), { code: 'EIO' });
          },
        },
      }),
      /EIO/,
    );

    assert.deepEqual(await readFile(target), before);
    assert.deepEqual(tmpLeftovers(await readdir(dir)), []);
  });

  test('④ corrupt JSON aborts by default, file byte-identical, error names the file', async (t) => {
    const dir = await tempDir(t);
    const target = path.join(dir, 'settings.json');
    const corrupt = '{"theme":"nord", BROKEN';
    await writeFile(target, corrupt, 'utf8');

    const err = await atomicUpdateJson(target, () => ({ theme: 'x' })).then(
      () => null,
      (e) => e,
    );
    assert.ok(err instanceof Error);
    assert.match(err.message, /settings\.json/);
    assert.match(err.message, /refusing to overwrite/);
    assert.equal(await readFile(target, 'utf8'), corrupt);
  });

  test('④ skip via undefined / AtomicSkip writes nothing but reports a value', async (t) => {
    const dir = await tempDir(t);
    const target = path.join(dir, 'settings.json');
    const original = '{"theme":"nord"}\n';
    await writeFile(target, original, 'utf8');
    const before = await readFile(target);

    const skippedUndefined = await atomicUpdateJson(target, () => undefined);
    assert.equal(skippedUndefined.updated, false);
    assert.deepEqual(skippedUndefined.value, { theme: 'nord' });

    const skippedExplicit = await atomicUpdateJson(target, () => new AtomicSkip({ theme: 'merged' }));
    assert.equal(skippedExplicit.updated, false);
    assert.deepEqual(skippedExplicit.value, { theme: 'merged' });

    assert.deepEqual(await readFile(target), before, 'skipped updates must not touch the file');
  });

  test('concurrent updates of one path apply in order without losing a write', async (t) => {
    const dir = await tempDir(t);
    const target = path.join(dir, 'counter.json');
    await writeFile(target, '{"n":0}\n', 'utf8');

    await Promise.all(
      Array.from({ length: 20 }, () =>
        atomicUpdateJson(target, (prev) => ({ n: (prev?.n ?? 0) + 1 })),
      ),
    );

    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { n: 20 });
  });
});

describe('P3-b (#1354): withRollback restores the exact pre-write state', () => {
  test('② failing run restores previous bytes byte-identically', async (t) => {
    const dir = await tempDir(t);
    const target = path.join(dir, 'draft.json');
    const original = '{"title":"原稿","cards":[1,2,3]}\n';
    await writeFile(target, original, 'utf8');
    const before = await readFile(target);

    const err = await withRollback(target, async () => {
      await atomicWriteTextFile(target, '{"title":"half"}\n');
      throw new Error('保存草稿失败');
    }).then(
      () => null,
      (e) => e,
    );

    assert.ok(err instanceof Error);
    assert.match(err.message, /保存草稿失败/, 'original error must reach the caller for its notice');
    assert.deepEqual(await readFile(target), before, 'rollback must restore byte-identical content');
    assert.deepEqual(tmpLeftovers(await readdir(dir)), []);
  });

  test('② failing run removes a file it created when nothing existed before', async (t) => {
    const dir = await tempDir(t);
    const target = path.join(dir, 'note.json');

    await assert.rejects(
      withRollback(target, async () => {
        await atomicWriteTextFile(target, '{"half":true}\n');
        throw new Error('boom');
      }),
      /boom/,
    );

    assert.deepEqual(await readdir(dir), [], 'rollback must delete the partially created file');
  });

  test('successful run passes its value through untouched', async (t) => {
    const dir = await tempDir(t);
    const target = path.join(dir, 'note.json');
    await writeFile(target, '{"v":1}\n', 'utf8');

    const value = await withRollback(target, async () => {
      await atomicWriteTextFile(target, '{"v":2}\n');
      return 'ok';
    });

    assert.equal(value, 'ok');
    assert.equal(await readFile(target, 'utf8'), '{"v":2}\n');
  });

  test('rollback failure surfaces AtomicRollbackError with both errors', async (t) => {
    const dir = await tempDir(t);
    const target = path.join(dir, 'note.json');
    await writeFile(target, '{"v":1}\n', 'utf8');

    const err = await withRollback(
      target,
      async () => {
        throw new Error('write failed');
      },
      {
        fsOps: {
          rename: async () => {
            throw Object.assign(new Error('EACCES: restore denied'), { code: 'EACCES' });
          },
        },
      },
    ).then(
      () => null,
      (e) => e,
    );

    assert.ok(err instanceof AtomicRollbackError);
    assert.match(err.message, /EACCES|restore denied/);
    assert.match(String(err.originalError), /write failed/);
  });
});
