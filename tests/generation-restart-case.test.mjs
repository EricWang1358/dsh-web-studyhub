import test from 'node:test';
import assert from 'node:assert/strict';
import { settleJob } from './helpers/wait.mjs';
import { managedRuntimeOptions } from './helpers/runtime-switch.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { gate, openLibrary, restartedOver, jobsOf, soon } from './helpers/generation-baseline.mjs';

/* S3-7 (the S3-0 matrix row "case before its first draft", V4/D-5): a generated case writes its scenario into the library as a material before the draft that cites it. A process that died
   between the two leaves that material without a draft; the retry (same logical job) must replace it, never leave two scenarios behind. The "death" is a copy of the library folder taken
   while the draft's first save is held. */

const PATHS = ['generation', 'generationRestart'];
const hostOf = (complete) => { const { starts: _starts, ...options } = managedRuntimeOptions({ complete, paths: PATHS }); return options; };
const MATERIALS = [
  { title: 'Architectural styles', text: 'Microservices split a system into independently deployable services that own their data. Event-driven architecture lets services react to events published by others, which decouples producers from consumers.' },
  { title: 'Cloud persistence', text: 'Polyglot persistence chooses a different data store for each workload. Relational databases give ACID transactions for payments and settlements. Key-value stores serve sessions and carts at low latency.' },
];

test('restart, a case cut short between its scenario and its first draft: the retry replaces the scenario material, the library keeps one', async t => {
  const hold = gate(), model = createFakeModel();
  const opened = await openLibrary(t, { prefix: 'study-s37-case-', model, options: hostOf(model), hold });
  const sourceIds = [];
  for (const item of MATERIALS) sourceIds.push((await opened.service.call('source.add', { ...item, courses: ['Cloud Native'] })).id);
  const invoke = opened.service.runtime.invoke.bind(opened.service.runtime);
  opened.service.runtime.invoke = async (api, action, args, services) => {
    if (api === 'bank.v1' && action === 'draft.save' && args.deck?.case && !hold.entered) { hold.entered = true; await hold.promise; }
    return invoke(api, action, args, services);
  };
  await opened.service.call('generate', { kind: 'case', sourceIds, questions: 2, totalMarks: 20, language: 'English', title: 'Harbour practice case', course: 'Cloud Native' });
  await soon(() => hold.entered, 'the first draft of the case to be held');
  const scenarios = async service => (await service.call('export')).sources.filter(source => source.id.startsWith('scenario-'));
  assert.equal((await scenarios(opened.service)).length, 1, 'the scenario is a material before its draft exists');
  const calls = []; let next = async system => { calls.push(String(system).slice(0, 30)); throw new Error('a restart must not call a model by itself'); };
  const after = await restartedOver(t, opened.root, { options: hostOf((...args) => next(...args)), model: (...args) => next(...args) });
  const [job] = await jobsOf(after.service);
  assert.equal(job.contract.status, 'interrupted');
  assert.deepEqual(calls, []);
  next = createFakeModel();
  const done = await settleJob(after.service, (await after.service.call('job.control', { jobId: job.id, action: 'retry' })).attemptId);
  assert.equal(done.status, 'complete', done.stage);
  const state = await after.service.call('export');
  assert.equal((await scenarios(after.service)).length, 1, 'one scenario material, not two');
  assert.equal(state.drafts.filter(draft => draft.case).length, 1, 'one draft');
  hold.open();
});
