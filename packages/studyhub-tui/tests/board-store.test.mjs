// Unit tests for zero-dependency board-store parser & atomic persistence: `node --test tests/board-store.test.mjs`
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { tsImport } from 'tsx/esm/api';

const {
  MAX_DELETED_UPSTREAM_IDS,
  boardFilePath,
  loadBoardSafe,
  parseBoardDocument,
  saveBoard,
  todayLocalYmd,
} = await tsImport('../src/views/board/board-store.ts', import.meta.url);

const tempDirs = [];
async function makeTempDir(label) {
  const dir = await mkdtemp(join(tmpdir(), `studyhub-board-store-${label}-`));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

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
