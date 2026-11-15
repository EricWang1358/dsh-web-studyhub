import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadUi } from './helpers/ui-module.mjs';
import { revisionSnapshot } from '../lib/snapshot-time.js';
import { StudyService } from '../lib/service.js';
import { seedLibrary } from '../scripts/qa/perf-seed.mjs';

test('warm-session store caches per session root, ignores ephemeral views and sidebar, and enforces the LRU cap', async (t) => {
  const warm = await loadUi('export * from "./ui/app/warm-session.js";');
  t.after(() => warm.resetWarmSessions());
  warm.resetWarmSessions();

  // Empty or missing warmKey must stay a strict no-op so isolated tests remain cold.
  warm.writeWarmBinding('', { root: '/lib/a', provider: '', model: '' });
  warm.writeWarmSnapshot('', { binding: { root: '/lib/a', provider: '', model: '' }, data: { root: '/lib/a', fingerprint: 'fp-empty' } });
  assert.equal(warm.readWarmSession(''), null);
  assert.equal(warm.readWarmSession(null), null);
  assert.equal(warm.readWarmSession(undefined), null);

  const bindingA = { root: '/lib/a', provider: 'deepseek', model: 'deepseek-chat' };
  const snapA = { root: '/lib/a', fingerprint: 'fp-a1' };
  const snapshotKeyA = { sources: '[]', decks: '[]' };
  const boardA = { revision: 3, columns: [], cards: {} };
  const planA = { key: '/lib/a:2026-11-15', state: { tasks: [] } };
  const notebooksA = [{ id: 'n1', title: 'Notes' }];

  warm.writeWarmSnapshot('s1', { binding: bindingA, data: snapA, snapshotKey: snapshotKeyA });
  warm.writeWarmBoard('s1', '/lib/a', boardA);
  warm.writeWarmDailyPlan('s1', '/lib/a', planA);
  warm.writeWarmNotebooks('s1', '/lib/a', notebooksA);
  warm.writeWarmView('s1', '/lib/a', 'page', { page: 'sources', boardView: 'today' });
  warm.writeWarmView('s1', '/lib/a', 'sidebar', { page: 'sources', boardView: 'today' });
  for (const ephemeral of ['review', 'draft', 'manage', 'guided']) {
    warm.writeWarmView('s1', '/lib/a', 'panel', { page: ephemeral, boardView: 'today' });
  }

  const cached = warm.readWarmSession('s1');
  assert.ok(cached);
  assert.equal(cached.root, '/lib/a');
  assert.equal(cached.data, snapA);
  assert.deepEqual(cached.snapshotKey, snapshotKeyA);
  assert.notEqual(cached.snapshotKey, snapshotKeyA);
  assert.equal(cached.board, boardA);
  assert.equal(cached.dailyPlan, planA);
  assert.equal(cached.notebooks, notebooksA);
  assert.deepEqual(cached.views, { page: { page: 'sources', boardView: 'today' } });

  // Switching library root drops cached data/board/dailyPlan/notebooks/views for the old root.
  warm.writeWarmBinding('s1', { root: '/lib/b', provider: '', model: '' });
  assert.equal(warm.readWarmSession('s1'), null);

  warm.writeWarmSnapshot('s1', { binding: { root: '/lib/b', provider: '', model: '' }, data: { root: '/lib/b', fingerprint: 'fp-b1' } });
  const cachedB = warm.readWarmSession('s1');
  assert.ok(cachedB);
  assert.equal(cachedB.board, null);
  assert.equal(cachedB.dailyPlan, null);
  assert.equal(cachedB.notebooks, null);
  assert.deepEqual(cachedB.views, {});

  warm.clearWarmSession('s1');
  assert.equal(warm.readWarmSession('s1'), null);

  // LRU eviction at MAX_WARM_SESSIONS = 8: populate 1..8, touch 1, write 9 -> 2 is evicted, 1 survives.
  for (let i = 1; i <= 8; i++) {
    const key = `sess-${i}`;
    warm.writeWarmSnapshot(key, { binding: { root: `/lib/${i}` }, data: { root: `/lib/${i}`, fingerprint: `fp-${i}` } });
  }
  warm.writeWarmBoard('sess-1', '/lib/1', { revision: 1, columns: [], cards: {} });
  warm.writeWarmSnapshot('sess-9', { binding: { root: '/lib/9' }, data: { root: '/lib/9', fingerprint: 'fp-9' } });
  assert.ok(warm.readWarmSession('sess-1'), 'touched session stays warm');
  assert.equal(warm.readWarmSession('sess-2'), null, 'oldest untouched session is evicted once past cap');
  assert.ok(warm.readWarmSession('sess-9'));
});

test('revisionSnapshot memoizes per-revision projections and StudyService invalidates on write', async (t) => {
  const memoRoot = `memo-${Date.now()}-${Math.random()}`;
  let builds = 0;
  const make = (label) => () => { builds++; return { label, count: builds }; };

  const a1 = revisionSnapshot(memoRoot, 'rev1::zh', make('rev1'));
  const a2 = revisionSnapshot(memoRoot, 'rev1::zh', make('rev1'));
  assert.equal(a1, a2);
  assert.equal(builds, 1);

  const b1 = revisionSnapshot(memoRoot, 'rev2::zh', make('rev2'));
  assert.notEqual(b1, a1);
  assert.equal(builds, 2);

  // Per-root cap of 4 evicts oldest untouched keys (`rev1` after touching `rev2`, adding `rev3`, `rev4`, `rev5`).
  revisionSnapshot(memoRoot, 'rev3::zh', make('rev3'));
  revisionSnapshot(memoRoot, 'rev4::zh', make('rev4'));
  revisionSnapshot(memoRoot, 'rev5::zh', make('rev5'));
  assert.equal(builds, 5);
  assert.equal(revisionSnapshot(memoRoot, 'rev2::zh', make('rev2')), b1);
  assert.equal(builds, 5);
  const a3 = revisionSnapshot(memoRoot, 'rev1::zh', make('rev1-rebuilt'));
  assert.notEqual(a3, a1);
  assert.equal(builds, 6);

  const dir = await mkdtemp(join(tmpdir(), 'study-revision-snapshot-'));
  await seedLibrary(dir, { sources: 8, decks: 2, cardsPerDeck: 4, runs: 1, attempts: 10, courses: 2, largeSources: 0 });
  const service = new StudyService(dir);
  t.after(async () => {
    await service.dispose();
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  const first = await service.call('snapshot');
  const second = await service.call('snapshot');
  assert.deepEqual(second, first);

  await service.call('coach.goal', { goal: 'exam' });
  const afterWrite = await service.call('snapshot');
  assert.equal(afterWrite.coach.goal, 'exam');
  assert.notEqual(afterWrite.fingerprint, first.fingerprint);
});
