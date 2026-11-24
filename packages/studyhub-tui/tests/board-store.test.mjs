// Consolidated unit tests for board-store parser & shared cross-platform atomic-write helpers:
// `node --test tests/board-store.test.mjs`
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');

const [boardStoreMod, atomicWriteMod] = await Promise.all([
  tsImport('../src/views/board/board-store.ts', import.meta.url),
  tsImport('../src/host/atomic-write.ts', import.meta.url),
]);

const {
  MAX_DELETED_UPSTREAM_IDS,
  boardFilePath,
  loadBoardSafe,
  parseBoardDocument,
  saveBoard,
  todayLocalYmd,
} = boardStoreMod;

const {
  atomicWriteExportJson,
  atomicWriteExportText,
  atomicWriteJsonFile,
  atomicWriteTextFile,
  defaultBackupFilePath,
  localTimestampCompact,
  resolveSafeBackupExportPath,
  resolveUniqueFilePath,
  sanitizeExportSlug,
  todayLocalYmd: atomicTodayLocalYmd,
} = atomicWriteMod;

const tempDirs = [];
async function makeTempDir(label) {
  const dir = await mkdtemp(join(tmpdir(), `studyhub-board-store-${label}-`));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
});

const REFACTORED_MODULES = [
  'src/host/tui-prefs.ts',
  'src/views/board/board-store.ts',
  'src/views/settings/WorkspaceTab.tsx',
  'src/shell/InboxModal.tsx',
  'src/views/board/BoardView.tsx',
  'src/views/dashboard/DashboardView.tsx',
  'src/views/wrongbook/WrongBookView.tsx',
  'src/views/skeleton/SkeletonView.tsx',
  'src/views/audio/AudioView.tsx',
  'src/views/exam/ExamSetup.tsx',
];

describe('board-store parseBoardDocument (zero-dependency)', () => {
  test('parses valid document and preserves trimmed fields', () => {
    const doc = parseBoardDocument({
      version: 1,
      cards: [
        {
          id: '  card-1  ',
          title: '  Review OS notes  ',
          column: 'doing',
          course: '  CS101  ',
          dueDate: '  2026-12-01  ',
          upstreamCardId: '  up-1  ',
          createdAt: '2026-11-20T10:00:00.000Z',
          updatedAt: '2026-11-21T10:00:00.000Z',
        },
      ],
      deletedUpstreamIds: ['  del-1 ', 'del-2'],
      focusStats: {
        date: ' 2026-11-22 ',
        completedPomodoros: 4,
        focusedMinutes: 100,
      },
      updatedAt: '2026-11-22T09:00:00.000Z',
    });

    assert.equal(doc.version, 1);
    assert.equal(doc.updatedAt, '2026-11-22T09:00:00.000Z');
    assert.deepEqual(doc.cards, [
      {
        id: 'card-1',
        title: 'Review OS notes',
        column: 'doing',
        course: 'CS101',
        dueDate: '2026-12-01',
        upstreamCardId: 'up-1',
        createdAt: '2026-11-20T10:00:00.000Z',
        updatedAt: '2026-11-21T10:00:00.000Z',
      },
    ]);
    assert.deepEqual(doc.deletedUpstreamIds, ['del-1', 'del-2']);
    assert.deepEqual(doc.focusStats, {
      date: '2026-11-22',
      completedPomodoros: 4,
      focusedMinutes: 100,
    });
  });

  test('handles partial/corrupt card fields, invalid optional fields, and skips invalid cards', () => {
    const doc = parseBoardDocument({
      version: 99,
      updatedAt: 12345,
      cards: [
        null,
        'not-an-object',
        [],
        { id: '   ', title: 'Missing id' },
        { id: 'x'.repeat(121), title: 'Too long id' },
        { id: 'no-title', title: '   ' },
        { id: 'long-title', title: 't'.repeat(301) },
        {
          id: 'ok-1',
          title: 'Fallback fields',
          column: 'bogus',
          course: '   ',
          dueDate: 'd'.repeat(41),
          upstreamCardId: '',
          createdAt: 123,
          updatedAt: null,
        },
        {
          id: 'ok-2',
          title: 'Too long course',
          column: 'done',
          course: 'c'.repeat(121),
          dueDate: '2026-11-22',
          upstreamCardId: 'u'.repeat(121),
        },
      ],
    });

    assert.equal(doc.version, 1);
    assert.ok(!Number.isNaN(Date.parse(doc.updatedAt)));
    assert.equal(doc.cards.length, 2);

    assert.equal(doc.cards[0].id, 'ok-1');
    assert.equal(doc.cards[0].column, 'todo');
    assert.equal('course' in doc.cards[0], false);
    assert.equal('dueDate' in doc.cards[0], false);
    assert.equal('upstreamCardId' in doc.cards[0], false);
    assert.ok(!Number.isNaN(Date.parse(doc.cards[0].createdAt)));
    assert.ok(!Number.isNaN(Date.parse(doc.cards[0].updatedAt)));

    assert.equal(doc.cards[1].id, 'ok-2');
    assert.equal(doc.cards[1].column, 'done');
    assert.equal('course' in doc.cards[1], false);
    assert.equal(doc.cards[1].dueDate, '2026-11-22');
    assert.equal('upstreamCardId' in doc.cards[1], false);
  });

  test('deduplicates card IDs preserving first occurrence order', () => {
    const doc = parseBoardDocument({
      cards: [
        { id: 'c1', title: 'First c1', column: 'doing' },
        { id: 'c2', title: 'Second c2', column: 'done' },
        { id: '  c1  ', title: 'Duplicate c1', column: 'todo' },
        { id: 'c3', title: 'Third c3', column: 'todo' },
      ],
    });

    assert.deepEqual(
      doc.cards.map((c) => ({ id: c.id, title: c.title, column: c.column })),
      [
        { id: 'c1', title: 'First c1', column: 'doing' },
        { id: 'c2', title: 'Second c2', column: 'done' },
        { id: 'c3', title: 'Third c3', column: 'todo' },
      ],
    );
  });

  test('normalizes out-of-range and invalid focusStats and omits non-object focusStats', () => {
    const today = todayLocalYmd();

    const outOfRange = parseBoardDocument({
      focusStats: {
        date: 'not-a-date',
        completedPomodoros: 1000,
        focusedMinutes: -5,
      },
    });
    assert.deepEqual(outOfRange.focusStats, {
      date: today,
      completedPomodoros: 0,
      focusedMinutes: 0,
    });

    const floatStats = parseBoardDocument({
      focusStats: {
        date: '2026-01-15',
        completedPomodoros: 2.5,
        focusedMinutes: 14401,
      },
    });
    assert.deepEqual(floatStats.focusStats, {
      date: '2026-01-15',
      completedPomodoros: 0,
      focusedMinutes: 0,
    });

    const boundaryStats = parseBoardDocument({
      focusStats: {
        date: '2026-01-15',
        completedPomodoros: 999,
        focusedMinutes: 14400,
      },
    });
    assert.deepEqual(boundaryStats.focusStats, {
      date: '2026-01-15',
      completedPomodoros: 999,
      focusedMinutes: 14400,
    });

    for (const bad of [null, 'str', 42, ['2026-01-15']]) {
      const doc = parseBoardDocument({ focusStats: bad });
      assert.equal(doc.focusStats, undefined);
      assert.equal('focusStats' in doc, false);
    }
  });

  test('sanitizes, deduplicates, and caps deletedUpstreamIds at MAX_DELETED_UPSTREAM_IDS (500)', () => {
    const manyIds = Array.from({ length: MAX_DELETED_UPSTREAM_IDS + 50 }, (_, i) => `id-${i}`);
    const doc = parseBoardDocument({
      deletedUpstreamIds: [
        '',
        '   ',
        123,
        null,
        { id: 'obj' },
        'x'.repeat(121),
        '  id-0  ',
        ...manyIds,
      ],
    });

    assert.equal(doc.deletedUpstreamIds.length, MAX_DELETED_UPSTREAM_IDS);
    // 'id-0' appeared first, so deduped sequence is id-0 .. id-549, sliced to last 500 => id-50 .. id-549
    assert.equal(doc.deletedUpstreamIds[0], 'id-50');
    assert.equal(doc.deletedUpstreamIds[MAX_DELETED_UPSTREAM_IDS - 1], `id-${MAX_DELETED_UPSTREAM_IDS + 49}`);

    const mixedInvalid = parseBoardDocument({
      deletedUpstreamIds: ['keep-a', null, 42, '   ', 'keep-b', 'keep-a', 'x'.repeat(121)],
    });
    assert.deepEqual(mixedInvalid.deletedUpstreamIds, ['keep-a', 'keep-b']);

    const nonArray = parseBoardDocument({ deletedUpstreamIds: 'not-an-array' });
    assert.deepEqual(nonArray.deletedUpstreamIds, []);
  });

  test('returns valid empty board for non-object, null, undefined, and array inputs', () => {
    for (const input of [null, undefined, [], [1, 2], 'string', 42, true]) {
      const doc = parseBoardDocument(input);
      assert.equal(doc.version, 1);
      assert.deepEqual(doc.cards, []);
      assert.deepEqual(doc.deletedUpstreamIds, []);
      assert.equal(doc.focusStats, undefined);
      assert.ok(!Number.isNaN(Date.parse(doc.updatedAt)));
    }
  });
});

describe('board-store loadBoardSafe & saveBoard persistence', () => {
  test('returns empty board with existed=false when file is missing, then round-trips saveBoard -> loadBoardSafe', async () => {
    const dir = await makeTempDir('roundtrip');
    const missing = await loadBoardSafe(dir);
    assert.equal(missing.ok, true);
    assert.equal(missing.existed, false);
    assert.deepEqual(missing.doc.cards, []);

    const saved = await saveBoard(dir, {
      version: 1,
      cards: [
        {
          id: 'c-1',
          title: 'Finish NFR cleanup',
          column: 'doing',
          course: 'Systems',
          dueDate: '2026-11-30',
          upstreamCardId: 'up-99',
          createdAt: '2026-11-22T01:00:00.000Z',
          updatedAt: '2026-11-22T01:00:00.000Z',
        },
      ],
      deletedUpstreamIds: ['up-1', 'up-2'],
      focusStats: {
        date: '2026-11-22',
        completedPomodoros: 2,
        focusedMinutes: 50,
      },
      updatedAt: '2026-11-22T01:00:00.000Z',
    });

    const loaded = await loadBoardSafe(dir);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.existed, true);
    assert.deepEqual(loaded.doc, saved);

    const files = await readdir(dir);
    assert.deepEqual(files, ['tui-board.json']);
  });

  test('returns ok=false and leaves corrupt JSON and non-object JSON files untouched on disk', async () => {
    const dir = await makeTempDir('corrupt');
    const file = boardFilePath(dir);

    const corruptPayloads = ['{ broken json', '   \n', '[1, 2, 3]', 'null', '"just a string"'];
    for (const payload of corruptPayloads) {
      await writeFile(file, payload, 'utf8');
      const res = await loadBoardSafe(dir);
      assert.equal(res.ok, false, `expected ok=false for payload ${JSON.stringify(payload)}`);
      assert.equal(res.path, file);
      assert.ok(res.error.length > 0);
      assert.deepEqual(res.doc.cards, []);
      const onDisk = await readFile(file, 'utf8');
      assert.equal(onDisk, payload, 'corrupt file must remain untouched on disk');
    }
  });
});

describe('shared atomic-write helpers & deduplication', () => {
  test('1) todayLocalYmd formats YYYY-MM-DD in local time', () => {
    assert.equal(atomicTodayLocalYmd(new Date(2026, 10, 5)), '2026-11-05');
    assert.equal(atomicTodayLocalYmd(new Date(2026, 0, 9)), '2026-01-09');
  });

  test('2) defaultBackupFilePath builds cross-platform backups/<prefix>-<slug?>-YYYY-MM-DD-HHmmss.<ext>', () => {
    const fixedDate = new Date(2026, 0, 9, 14, 5, 3);
    assert.equal(localTimestampCompact(fixedDate), '2026-01-09-140503');

    const lib = resolve('/tmp/lib');
    const res = defaultBackupFilePath(lib, 'studyhub-test', 'md', fixedDate);
    assert.equal(res, join(lib, 'backups', 'studyhub-test-2026-01-09-140503.md'));
    assert.ok(res.endsWith(join('backups', 'studyhub-test-2026-01-09-140503.md')));

    const dotExt = defaultBackupFilePath(lib, 'studyhub-test', '.json', fixedDate);
    assert.equal(dotExt, join(lib, 'backups', 'studyhub-test-2026-01-09-140503.json'));

    const withSlug = defaultBackupFilePath(lib, 'studyhub-deck', 'md', 'CS 101: 操作系统', fixedDate);
    assert.equal(withSlug, join(lib, 'backups', 'studyhub-deck-CS-101-操作系统-2026-01-09-140503.md'));

    assert.equal(sanitizeExportSlug('  ../weird/name:test?  '), 'weird-name-test');
  });

  test('2b) resolveUniqueFilePath, atomicWriteExportText/Json, and resolveSafeBackupExportPath never overwrite or escape backups/', async () => {
    const root = await makeTempDir('safe-export');
    const first = resolveSafeBackupExportPath(root, 'my-snap', 'studyhub-backup', '.json');
    assert.equal(first, join(root, 'backups', 'my-snap.json'));

    const w1 = await atomicWriteExportJson(first, { run: 1 });
    assert.equal(w1.path, first);

    const second = resolveUniqueFilePath(first);
    assert.equal(second, join(root, 'backups', 'my-snap-2.json'));

    const w2 = await atomicWriteExportJson(first, { run: 2 });
    assert.equal(w2.path, second);
    assert.deepEqual(JSON.parse(await readFile(first, 'utf8')), { run: 1 });
    assert.deepEqual(JSON.parse(await readFile(second, 'utf8')), { run: 2 });

    const t1 = await atomicWriteExportText(join(root, 'backups', 'note.md'), '# First\n');
    const t2 = await atomicWriteExportText(join(root, 'backups', 'note.md'), '# Second\n');
    assert.equal(t1.path, join(root, 'backups', 'note.md'));
    assert.equal(t2.path, join(root, 'backups', 'note-2.md'));
    assert.equal(await readFile(t1.path, 'utf8'), '# First\n');
    assert.equal(await readFile(t2.path, 'utf8'), '# Second\n');

    for (const unsafe of ['/tmp/evil.json', '../escape.json', 'a/../../escape.json', 'C:\\evil.json', '\\\\host\\share\\x.json']) {
      assert.throws(() => resolveSafeBackupExportPath(root, unsafe, 'studyhub-backup', '.json'), /Unsafe export path/);
    }
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
        /(?:host\/|\.\/)atomic-write\.js['"]/.test(src),
        `${rel} must import from leaf atomic-write.js`,
      );
      assert.ok(
        !/from\s+['"][^'"]*host\/index\.js['"]/.test(src),
        `${rel} must never import from host/index.js barrel`,
      );
    }
  });

  test('7) notes-types expandUserPath handles PowerShell drag-and-drop, Explorer quotes, bash escapes, and ~/~\\', async () => {
    const [{ expandUserPath }, { cleanPathInput }] = await Promise.all([
      tsImport('../src/views/notes/notes-types.ts', import.meta.url),
      tsImport('../src/host/sample-actions.ts', import.meta.url),
    ]);
    const { homedir } = await import('node:os');
    const root = resolve('/tmp/studyhub-notes-root');
    assert.equal(expandUserPath('', root), '');
    assert.equal(expandUserPath('~', root), homedir());
    assert.equal(expandUserPath('~/study/note.md', root), join(homedir(), 'study/note.md'));
    assert.equal(expandUserPath('~\\study\\note.md', root), join(homedir(), 'study\\note.md'));
    assert.equal(expandUserPath('"/tmp/my note.md"', root), resolve('/tmp/my note.md'));
    assert.equal(expandUserPath("& '/tmp/ps note.md'", root), resolve('/tmp/ps note.md'));
    assert.equal(expandUserPath('/tmp/bash\\ escaped.md', root), resolve('/tmp/bash escaped.md'));
    assert.equal(expandUserPath('relative/out.md', root), resolve(root, 'relative/out.md'));
    // Cross-platform bash-escaped spaces (including Git Bash on Windows) unescape `\ `,
    // while Windows drive and UNC paths remain intact.
    assert.equal(cleanPathInput('/tmp/bash\\ escaped.md'), '/tmp/bash escaped.md');
    assert.equal(cleanPathInput('notes/my\\ file\\ v2.md'), 'notes/my file v2.md');
    assert.equal(cleanPathInput('C:\\Users\\Alice\\ My Notes.md'), 'C:\\Users\\Alice\\ My Notes.md');
    assert.equal(cleanPathInput('\\\\server\\share\\ My Notes.md'), '\\\\server\\share\\ My Notes.md');
  });
});
