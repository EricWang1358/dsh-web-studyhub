/* The notice of a settled generation-family run (generate, supplement, repair, publish) is the kernel's settlement sink, not the executor's call: exactly one session notice per
   settled run in every mode. Switch off: the legacy executor announces. Switch on, run not durable: the in-process sink. Switch on, run durable (generationRestart): the sink of the
   persistence port, once across a restart (`deliveries`); a run the restart found interrupted is told once, not once per restart. A counted `notify` stands for the session. Fakes only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { evidence, ONE_BY_ONE, authoring } from './helpers/supplement-fixtures.mjs';
import { gate, openLibrary, restartedOver, jobsOf, soon } from './helpers/generation-baseline.mjs';
import { managedRuntimeOptions } from './helpers/runtime-switch.mjs';
import { settleJob } from './helpers/wait.mjs';

const hostOf = (complete, paths, notify) => { const { starts: _starts, ...options } = managedRuntimeOptions({ complete, paths }); return { ...options, notify }; };
const modes = [['switch off', undefined], ['switch on, not durable', ['generation']], ['switch on, durable', ['generation', 'generationRestart']]];

for (const [name, paths] of modes) {
  test(`${name}: one run, one session notice`, async t => {
    const notices = [], hold = gate(), model = authoring({ entered: true }, Infinity, 'new');
    const { service } = await openLibrary(t, { model, hold, options: paths ? hostOf(model, paths, message => notices.push(message)) : { notify: message => notices.push(message) } });
    await service.call('source.add', { id: 'p1', title: 'Page 1', text: evidence });
    const started = await service.call('generate', { sourceIds: ['p1'], count: 2, kind: 'flashcard', performance: ONE_BY_ONE });
    assert.equal((await settleJob(service, started.jobId)).status, 'complete');
    await soon(() => notices.length >= 1, 'the notice');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(notices.length, 1, `${name}: exactly one notice, not ${notices.length}`);
  });
}

test('a run the restart found interrupted is not announced (the card offers to go on), the retry that settles is, once', async t => {
  const hold = gate(), dying = authoring(hold, 2, 'first'), paths = ['generation', 'generationRestart'];
  const first = await openLibrary(t, { model: dying, hold, options: hostOf(dying, paths, () => {}) });
  await first.service.call('source.add', { id: 'p1', title: 'Page 1', text: evidence });
  await first.service.call('generate', { sourceIds: ['p1'], count: 3, kind: 'flashcard', performance: ONE_BY_ONE });
  await soon(async () => (await first.service.call('export')).drafts[0]?.cards.length === 1, 'the first part to be saved');
  const notices = [];
  let model = async () => { throw new Error('a restart must not call a model by itself'); };
  const after = await restartedOver(t, first.root, { options: hostOf((...args) => model(...args), paths, message => notices.push(message)), model: (...args) => model(...args) });
  after.use = next => { model = next; };
  const [job] = await jobsOf(after.service);
  assert.equal(job.contract.status, 'interrupted');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(notices.length, 0, 'an interrupted run is a stop with something to continue, not a settlement to announce');
  const asked = authoring({ entered: true }, Infinity, 'again');
  after.use(asked);
  const attempt = (await after.service.call('job.control', { jobId: job.id, action: 'retry' })).attemptId;
  assert.equal((await settleJob(after.service, attempt)).status, 'complete');
  await soon(() => notices.length >= 1, 'the notice of the retry');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(notices.length, 1, 'the retry that settled is announced once');
});
