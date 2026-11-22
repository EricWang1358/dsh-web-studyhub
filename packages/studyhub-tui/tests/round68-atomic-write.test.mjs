// Round 68 Track 1: Unit tests for shared src/host/atomic-write.ts and deduplication static checks.
// `node --test --test-concurrency=1 tests/round68-atomic-write.test.mjs`
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');

const {
  atomicWriteJsonFile,
  atomicWriteTextFile,
  defaultBackupFilePath,
  todayLocalYmd,
} = await tsImport('../src/host/atomic-write.ts', import.meta.url);

const tempDirs = [];
async function makeTempDir(label) {
  const dir = await mkdtemp(join(tmpdir(), `studyhub-r68-${label}-`));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
});

const REFACTORED_MODULES = [
  'src/views/settings/WorkspaceTab.tsx',
  'src/shell/InboxModal.tsx',
  'src/views/board/BoardView.tsx',
  'src/views/dashboard/DashboardView.tsx',
  'src/views/wrongbook/WrongBookView.tsx',
  'src/views/skeleton/SkeletonView.tsx',
  'src/views/audio/AudioView.tsx',
  'src/views/exam/ExamSetup.tsx',
];

describe('Round 68 Track 1: shared atomic-write helpers & deduplication', () => {
  test('1) todayLocalYmd formats YYYY-MM-DD in local time', () => {
    assert.equal(todayLocalYmd(new Date(2026, 10, 5)), '2026-11-05');
    assert.equal(todayLocalYmd(new Date(2026, 0, 9)), '2026-01-09');
  });

  test('2) defaultBackupFilePath builds cross-platform backups/<prefix>-YYYY-MM-DD.<ext>', () => {
    const res = defaultBackupFilePath('/tmp/lib', 'studyhub-test', 'md', new Date(2026, 0, 9));
    assert.equal(res, join('/tmp/lib', 'backups', 'studyhub-test-2026-01-09.md'));
    assert.ok(res.endsWith(join('backups', 'studyhub-test-2026-01-09.md')));

    const dotExt = defaultBackupFilePath('/tmp/lib', 'studyhub-test', '.json', new Date(2026, 0, 9));
    assert.equal(dotExt, join('/tmp/lib', 'backups', 'studyhub-test-2026-01-09.json'));
  });

  test('3) atomicWriteTextFile creates missing parents, writes exact UTF-8 CJK/emoji, leaves zero .tmp, and overwrites atomically', async () => {
    const root = await makeTempDir('text');
    const targetDir = join(root, 'nested', 'dir');
    const targetPath = join(targetDir, 'notes.md');

    const content1 = '# 学习笔记 📚\n进程调度与页表 — α ≤ β 🚀\n';
    const res1 = await atomicWriteTextFile(targetPath, content1);
    assert.equal(res1.bytes, Buffer.byteLength(content1, 'utf8'));
    assert.equal(await readFile(targetPath, 'utf8'), content1);

    let entries = await readdir(targetDir);
    assert.deepEqual(entries, ['notes.md']);

    const content2 = '# 更新后笔记 ✨\n已覆盖旧内容 🎉\n';
    const res2 = await atomicWriteTextFile(targetPath, content2);
    assert.equal(res2.bytes, Buffer.byteLength(content2, 'utf8'));
    assert.equal(await readFile(targetPath, 'utf8'), content2);

    entries = await readdir(targetDir);
    assert.deepEqual(entries, ['notes.md']);
    assert.equal(
      entries.filter((name) => name.includes('.tmp')).length,
      0,
      'must leave zero .tmp leftovers after atomic overwrite',
    );
  });

  test('4) atomicWriteJsonFile writes pretty 2-space JSON with trailing newline and round-trips cleanly', async () => {
    const root = await makeTempDir('json');
    const targetDir = join(root, 'backups');
    const targetPath = join(targetDir, 'export.json');

    const payload = {
      title: '测试备份 🧪',
      count: 42,
      nested: { tags: ['os', '页表'], ok: true },
    };

    const res = await atomicWriteJsonFile(targetPath, payload);
    const raw = await readFile(targetPath, 'utf8');
    assert.equal(res.bytes, Buffer.byteLength(raw, 'utf8'));
    assert.equal(raw, `${JSON.stringify(payload, null, 2)}\n`);
    assert.ok(raw.endsWith('\n'));
    assert.deepEqual(JSON.parse(raw), payload);

    const entries = await readdir(targetDir);
    assert.deepEqual(entries, ['export.json']);
  });

  test('5) failure cleanup removes orphaned .tmp file when rename fails against an existing directory', async () => {
    const root = await makeTempDir('fail');
    const targetPath = join(root, 'collision-target');
    await mkdir(targetPath, { recursive: true });

    await assert.rejects(
      () => atomicWriteTextFile(targetPath, 'should fail cleanly'),
      (err) => Boolean(err && typeof err === 'object' && 'code' in err),
    );

    const entries = await readdir(root);
    assert.deepEqual(entries, ['collision-target']);
    assert.equal(
      entries.filter((name) => name.includes('.tmp')).length,
      0,
      'must clean up .tmp file on rename failure',
    );
  });

  test('6) static check: refactored modules import leaf atomic-write.js and never redefine renameWithRetry or import host barrel', async () => {
    for (const rel of REFACTORED_MODULES) {
      const abs = join(pkgRoot, rel);
      const src = await readFile(abs, 'utf8');

      assert.ok(
        !/\bfunction\s+renameWithRetry\b|\bconst\s+renameWithRetry\b/.test(src),
        `${rel} must not redefine renameWithRetry locally`,
      );
      assert.ok(
        !/\bconst\s+RETRY_CODES\b/.test(src),
        `${rel} must not redefine RETRY_CODES locally`,
      );
      assert.ok(
        /host\/atomic-write\.js['"]/.test(src),
        `${rel} must import from leaf host/atomic-write.js`,
      );
      assert.ok(
        !/from\s+['"][^'"]*host\/index\.js['"]/.test(src),
        `${rel} must never import from host/index.js barrel`,
      );
    }
  });
});
