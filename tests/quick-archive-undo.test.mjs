import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUi } from './helpers/ui-module.mjs';

// 归档 on the light path (ui/quick-actions.js) then 撤销 within the 8 s hold of its patch: the task is back at once (not still "leaving"), and a second 归档 is really
// sent (it used to be swallowed as the same action still in flight). Review of #506, item 19.
const q = await loadUi(`export { createQuickActions, dismissJobs, unarchiveJobs } from './ui/quick-actions.js'; export { batchRun } from './ui/tasks/task-batch.js';`);

test('归档 then 撤销 then 归档 again, all inside the hold', async () => {
  const sent = [];
  let clock = 0;
  const quick = q.createQuickActions({ call: async (action) => { sent.push(action); return action === 'job.archive' ? { archived: ['X'] } : { unarchived: ['run-X'] }; }, now: () => clock, timers: false });
  const job = { id: 'X', status: 'complete', contract: { jobId: 'run-X', kind: 'audio', status: 'complete' } };
  quick.view({ jobs: [job], archivedJobs: [] });
  await q.dismissJobs(quick, 'X');
  assert.equal(quick.view({ jobs: [job], archivedJobs: [] }).jobs[0].leaving, true, 'archived: the card leaves at once');
  clock = 1000;
  const back = await q.batchRun('unarchive', ['run-X'], { quick });
  assert.notEqual(back.ok, false);
  const shown = quick.view({ jobs: [job], archivedJobs: [] }).jobs.find((item) => item.id === 'X');
  assert.notEqual(shown.leaving, true, '撤销: the task is back at once, not hidden until the hold ends');
  await q.dismissJobs(quick, 'X');
  assert.deepEqual(sent, ['job.archive', 'job.unarchive', 'job.archive'], 'the second 归档 reached the host');
});

test('归档 → 撤销 → 归档 → 撤销 inside one snapshot poll: every step reaches the host (a second 撤销 is never taken for the first one still held)', async () => {
  const sent = [];
  const quick = q.createQuickActions({ call: async (action) => { sent.push(action); return action === 'job.archive' ? { archived: ['run-X'] } : { unarchived: ['run-X'] }; }, now: () => 0, timers: false });
  const job = { id: 'X', status: 'complete', contract: { jobId: 'run-X', kind: 'audio', status: 'complete' } };
  const raw = { jobs: [job], archivedJobs: [] };
  quick.view(raw);
  await q.dismissJobs(quick, 'X');
  assert.notEqual((await q.batchRun('unarchive', ['run-X'], { quick })).ok, false);
  await q.dismissJobs(quick, 'X');
  assert.equal(quick.view(raw).jobs[0].leaving, true, 'the second 归档 shows');
  const second = await q.batchRun('unarchive', ['run-X'], { quick });
  assert.notEqual(second.ok, false);
  assert.deepEqual(sent, ['job.archive', 'job.unarchive', 'job.archive', 'job.unarchive'], 'four calls, none swallowed');
  assert.notEqual(quick.view(raw).jobs[0].leaving, true, 'back on screen');
});

test('全部归档: the notice counts and 撤销 brings back exactly what the host archived, and only those jobs flash back', async () => {
  const m = await loadUi(`export { archiveAllWithUndo, archivedIdsOf } from './ui/tasks/archive-all.js'; export { createQuickActions, dismissJobs } from './ui/quick-actions.js';`);
  const onHome = ['h1', 'h2', 'h3'], elsewhere = ['e1', 'e2', 'e3', 'e4'];
  const jobs = [...onHome, ...elsewhere].map((id) => ({ id, status: 'complete', contract: { jobId: id, kind: 'generation', status: 'complete' } }));
  const sent = [];
  const quick = m.createQuickActions({ call: async (action, args) => { sent.push([action, args]); return action === 'job.archive' ? { archived: [...onHome, ...elsewhere.slice(0, 3)], alreadyArchived: [elsewhere[3]] } : { unarchived: args.jobIds }; }, timers: false });
  const raw = { jobs, archivedJobs: [] };
  quick.view(raw);
  const shown = [];
  const toast = { show: (notice) => shown.push(notice), dismiss() {}, error() {} };
  const result = await m.archiveAllWithUndo({ archive: () => m.dismissJobs(quick), quick, toast });
  assert.deepEqual(sent[0], ['job.archive', { all: true }]);
  assert.equal(result.ids.length, 7);
  assert.match(shown[0].message, /已归档 7 个任务/);
  assert.equal(await shown[0].action.onClick(), true);
  assert.deepEqual(sent[1][0], 'job.unarchive');
  assert.deepEqual([...sent[1][1].jobIds].sort(), [...onHome, ...elsewhere].sort(), '撤销 unarchives the same 7');
  assert.deepEqual(m.archivedIdsOf({ archived: ['a'], alreadyArchived: ['b', 'a'] }), ['a', 'b']);
});

test('a 撤销 of some of the jobs of a 全部归档 does not let the others flash back', async () => {
  const jobs = ['a', 'b', 'c'].map((id) => ({ id, status: 'complete', contract: { jobId: id, kind: 'generation', status: 'complete' } }));
  const quick = q.createQuickActions({ call: async (action, args) => (action === 'job.archive' ? { archived: ['a', 'b', 'c'] } : { unarchived: args.jobIds }), timers: false });
  const raw = { jobs, archivedJobs: [] };
  quick.view(raw);
  await q.dismissJobs(quick);
  await q.batchRun('unarchive', ['a'], { quick });
  const leaving = quick.view(raw).jobs.filter((job) => job.leaving).map((job) => job.id);
  assert.deepEqual(leaving, ['a', 'b', 'c'], 'the all-archive patch stays until every job it covers is back (the snapshot brings a back)');
});

test('a delete the host skipped (the task started running) names it, so the page can show it again', async () => {
  const quick = q.createQuickActions({ call: async () => ({ deleted: ['a'], skipped: [{ id: 'b', reason: 'running' }] }), timers: false });
  quick.view({ jobs: [], archivedJobs: [] });
  const result = await q.batchRun('delete', ['a', 'b'], { quick });
  assert.equal(result.deleted, 1);
  assert.deepEqual(result.skippedIds, ['b']);
  const viaAct = await q.batchRun('delete', ['a', 'b'], { core: { act: async () => ({ deleted: ['a'], skipped: [{ id: 'b', reason: 'running' }] }) } });
  assert.deepEqual(viaAct.skippedIds, ['b']);
});
