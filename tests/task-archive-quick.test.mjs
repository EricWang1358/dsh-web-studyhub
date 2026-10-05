import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuickActions, dismissJobs, archiveJobs, unarchiveJobs, deleteJobs } from '../ui/quick-actions.js';
import { jobContract } from '../lib/job-contract.js';

/* 任务 归档 on the light path (ui/quick-actions.js): 知道了 now archives, and archiving, unarchiving and deleting several tasks patch the view at once, send ONE call per
   100 tasks and keep the patch until a snapshot confirms it. */

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const live = (id, status = 'failed', extra = {}) => { const job = { id, status, deckTitle: `Deck ${id}`, startedAt: '2026-10-05T08:00:00.000Z', ...extra }; return { ...job, contract: jobContract(job) }; };
const audio = (id, status = 'complete') => live(`attempt-${id}`, status, { type: 'audio-import', batchId: `batch-${id}`, filename: `${id}.mp3` });
const library = () => ({ jobs: [live('a'), live('b'), live('c', 'running'), audio('x')],
  archivedJobs: [{ id: 'old', archived: { at: '2026-10-04T08:00:00.000Z' }, contract: { jobId: 'old', status: 'failed' } }] });
function setup(callImpl = async () => ({})) {
  const calls = [];
  const quick = createQuickActions({ call: (action, args) => { calls.push([action, args]); return callImpl(action, args); } });
  const raw = library();
  quick.view(raw);
  return { quick, raw, calls };
}
const ids = (list) => list.map((job) => job.id);

test('知道了 (dismissJobs) sends job.archive now, and the card is marked leaving and shows up under the archived ones at once', async () => {
  const pending = deferred();
  const { quick, raw, calls } = setup(() => pending.promise);
  const done = dismissJobs(quick, 'a');
  assert.deepEqual(calls, [['job.archive', { jobId: 'a' }]]);
  const view = quick.view(raw);
  assert.equal(view.jobs.find((job) => job.id === 'a').leaving, true);
  assert.deepEqual(ids(view.archivedJobs), ['a', 'old'], 'newest archived first: it is already under 已归档');
  assert.equal(view.archivedJobs[0].contract.actions.retry.reason.code, 'archived');
  assert.ok(view.archivedJobs[0].archived.at);
  assert.equal(raw.archivedJobs.length, 1, 'the server snapshot is never mutated');
  pending.resolve({ archived: ['a'] });
  assert.equal((await done).ok, true);
});

test('全部知道了 archives every finished job (job.archive all) and the running one stays', async () => {
  const { quick, raw, calls } = setup();
  await dismissJobs(quick);
  assert.deepEqual(calls, [['job.archive', { all: true }]]);
  const view = quick.view(raw);
  assert.deepEqual(ids(view.jobs.filter((job) => job.leaving)).sort(), ['a', 'attempt-x', 'b']);
});

test('several tasks, named by what survives a retry (an audio batch id) or by their own id, are archived with one call', async () => {
  const { quick, raw, calls } = setup();
  const result = await archiveJobs(quick, ['a', 'batch-x']);
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [['job.archive', { jobIds: ['a', 'batch-x'] }]]);
  const view = quick.view(raw);
  assert.deepEqual(ids(view.jobs.filter((job) => job.leaving)).sort(), ['a', 'attempt-x']);
  assert.deepEqual(ids(view.archivedJobs).sort(), ['a', 'attempt-x', 'old']);
});

test('more than 100 tasks go in calls of 100, one after the other, and the result says how many were archived and skipped', async () => {
  const many = Array.from({ length: 230 }, (_, index) => `t${index}`);
  const { quick, calls } = setup(async (action, args) => ({ archived: args.jobIds.slice(0, args.jobIds.length - 1), skipped: [{ id: args.jobIds.at(-1), reason: 'running' }], alreadyArchived: [], missing: [] }));
  const result = await archiveJobs(quick, many);
  assert.deepEqual(calls.map(([, args]) => args.jobIds.length), [100, 100, 30]);
  assert.equal(result.ok, true);
  assert.deepEqual([result.archived, result.skipped], [227, 3]);
});

test('unarchive takes the record out of the archived list at once; the task comes back when the next snapshot has it', async () => {
  const { quick, raw, calls } = setup();
  await unarchiveJobs(quick, ['old']);
  assert.deepEqual(calls, [['job.unarchive', { jobIds: ['old'] }]]);
  assert.deepEqual(ids(quick.view(raw).archivedJobs), []);
  assert.deepEqual(ids(quick.view(raw).jobs), ['a', 'b', 'c', 'attempt-x'], 'the live list is the server\'s');
});

test('delete removes finished tasks and archived records from the view at once but never shows a running task as gone, and reports what was skipped', async () => {
  const { quick, raw, calls } = setup(async () => ({ deleted: ['a', 'old'], skipped: [{ id: 'c', reason: 'running' }], missing: [] }));
  const result = await deleteJobs(quick, ['a', 'c', 'old']);
  assert.deepEqual(calls, [['job.delete', { jobIds: ['a', 'c', 'old'] }]]);
  const view = quick.view(raw);
  assert.deepEqual(ids(view.jobs), ['b', 'c', 'attempt-x'], 'a is gone; the running one c stays on screen');
  assert.deepEqual(ids(view.archivedJobs), []);
  assert.deepEqual([result.ok, result.deleted, result.skipped], [true, 2, 1]);
});

test('a failed call brings everything back and keeps the message under the action\'s key', async () => {
  const { quick, raw } = setup(async () => { throw new Error('磁盘忙'); });
  const result = await deleteJobs(quick, ['a', 'old']);
  assert.equal(result.ok, false);
  assert.deepEqual(ids(quick.view(raw).jobs), ['a', 'b', 'c', 'attempt-x']);
  assert.deepEqual(ids(quick.view(raw).archivedJobs), ['old']);
  assert.match(result.message, /磁盘忙/);
});

test('nothing selected is nothing sent', async () => {
  const { quick, calls } = setup();
  for (const run of [archiveJobs, unarchiveJobs, deleteJobs]) assert.deepEqual(await run(quick, []), { ok: true, archived: 0, unarchived: 0, deleted: 0, skipped: 0 });
  assert.deepEqual(calls, []);
});

test('a day of 为你定制 is never marked as archived by 全部知道了 (the host does not archive it), so it never blinks out of the list', async () => {
  const day = { id: 'coach:2026-10-01', type: 'coach-daily', status: 'complete', date: '2026-10-01', today: false, startedAt: '2026-10-01T08:00:00.000Z' };
  const raw = { ...library(), jobs: [...library().jobs, { ...day, contract: jobContract(day) }], archivedJobs: [] };
  const calls = [];
  const quick = createQuickActions({ call: async (action, args) => { calls.push([action, args]); return {}; } });
  quick.view(raw);
  await dismissJobs(quick);
  const view = quick.view(raw);
  assert.deepEqual(calls, [['job.archive', { all: true }]]);
  assert.equal(view.jobs.find((job) => job.id === 'coach:2026-10-01').leaving, undefined);
  assert.deepEqual(ids(view.archivedJobs).includes('coach:2026-10-01'), false);
});
