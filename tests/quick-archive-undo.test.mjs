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

test('a delete the host skipped (the task started running) names it, so the page can show it again', async () => {
  const quick = q.createQuickActions({ call: async () => ({ deleted: ['a'], skipped: [{ id: 'b', reason: 'running' }] }), timers: false });
  quick.view({ jobs: [], archivedJobs: [] });
  const result = await q.batchRun('delete', ['a', 'b'], { quick });
  assert.equal(result.deleted, 1);
  assert.deepEqual(result.skippedIds, ['b']);
  const viaAct = await q.batchRun('delete', ['a', 'b'], { core: { act: async () => ({ deleted: ['a'], skipped: [{ id: 'b', reason: 'running' }] }) } });
  assert.deepEqual(viaAct.skippedIds, ['b']);
});
