import test from 'node:test';
import assert from 'node:assert/strict';
import { resumeArgs } from '../lib/contexts/generation/jobs/resume-args.js';
import { recoverRuns } from '../lib/contexts/generation/jobs/recover-runs.js';
import { RUN_RECORD_WINDOW_MS } from '../lib/generation-limits.js';

test('a later Attempt continues the draft its run saved, and asks the request again as it was when nothing was saved', () => {
  const draft = (extra = {}) => ({ id: 'd', draftVersion: 5, editorial: { generation: { runId: 'run-1' }, ...extra } });
  const asked = { sourceIds: ['s'], count: 3, kind: 'quiz' };
  assert.deepEqual(resumeArgs(asked, { drafts: [draft()] }, 'run-1'), { resumeDraftId: 'd', draftVersion: 5 });
  assert.deepEqual(resumeArgs(asked, { drafts: [draft({ coverageSpec: { rounds: [{ round: 1 }] } })] }, 'run-1'), { resumeDraftId: 'd', draftVersion: 5, coverage: { run: true } });
  assert.deepEqual(resumeArgs({ ...asked, deckId: 'deck' }, { drafts: [draft()] }, 'run-1'), { deckId: 'deck', resumeDraftId: 'd', draftVersion: 5 }, 'a supplement keeps its target');
  assert.equal(resumeArgs(asked, { drafts: [draft()] }, 'run-2'), asked, 'another run\'s draft is not this run\'s');
  const topUp = { resumeDraftId: 'base', draftVersion: 2, extraSourceIds: ['p2'], count: 2 };
  assert.equal(resumeArgs(topUp, { drafts: [] }, 'run-1'), topUp, 'nothing saved yet: the top-up still names the version it was made for');
});

test('a look that could not read is not a look: the disk is looked at again, once', async () => {
  const live = [{ id: 'a', kind: 'generation', status: 'interrupted', at: Date.now() }], restored = [], memory = new Map();
  const runs = { scan: async () => live, forget: async () => {} }, restore = async run => { restored.push(run.id); };
  let broken = 1;
  const read = async () => { if (broken-- > 0) throw new Error('the library is busy'); return { drafts: [] }; };
  await assert.rejects(recoverRuns({ runs, restore, read, memory }), /busy/);
  assert.deepEqual(restored, []);
  assert.equal(await recoverRuns({ runs, restore, read, memory }), 1, 'the failure cost one look, not the rest of the process');
  assert.equal(await recoverRuns({ runs, restore, read, memory }), 0);
  const scanBroken = new Map();
  let scans = 0;
  const flaky = { scan: async () => { if (scans++ === 0) throw new Error('disk'); return live; }, forget: async () => {} };
  await assert.rejects(recoverRuns({ runs: flaky, restore, read, memory: scanBroken }), /disk/);
  assert.equal(await recoverRuns({ runs: flaky, restore, read, memory: scanBroken }), 1);
});

test('two looks at once are one look: the second does not bring a run back twice', async () => {
  const restored = [], memory = new Map(), runs = { scan: async () => [{ id: 'a', kind: 'generation', status: 'interrupted', at: Date.now() }], forget: async () => {} };
  const counts = await Promise.all([1, 2].map(() => recoverRuns({ runs, restore: async run => { restored.push(run.id); }, read: async () => ({ drafts: [] }), memory })));
  assert.deepEqual([counts.sort(), restored], [[0, 1], ['a']]);
});

test('what the last process left is brought back once: live runs return, finished and old ones leave nothing behind, a record that cannot be restored is left alone', async () => {
  const now = Date.now(), fresh = now - 1000, old = now - RUN_RECORD_WINDOW_MS - 1000;
  const runs = { scan: async () => [{ id: 'a', kind: 'generation', status: 'running', at: fresh }, { id: 'b', kind: 'generation', status: 'complete', at: fresh },
    { id: 'c', kind: 'generation', status: 'interrupted', at: old }, { id: 'd', kind: 'supplement', status: 'queued', at: fresh }, { id: 'e', kind: 'generation', status: 'interrupted', at: fresh }],
  forget: async id => { forgotten.push(id); } };
  const forgotten = [], restored = [], memory = new Map(), read = async () => ({ drafts: [] });
  const restore = async run => { if (run.id === 'e') throw new Error('unreadable'); restored.push(run.id); };
  assert.equal(await recoverRuns({ runs, restore, read, memory, now }), 2);
  assert.deepEqual([restored, forgotten], [['a', 'd'], ['b', 'c']]);
  assert.equal(await recoverRuns({ runs, restore, read, memory, now }), 0, 'the console reads the job list all the time: the disk is looked at once');
  assert.equal(await recoverRuns({ runs, restore, read, memory: new Map(), now }), 2, 'a new runtime is a new process');
});
