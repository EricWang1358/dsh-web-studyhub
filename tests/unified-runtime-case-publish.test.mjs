import test from 'node:test';
import assert from 'node:assert/strict';
import { settleJob } from './helpers/wait.mjs';
import { managedRuntimeOptions } from './helpers/runtime-switch.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { gate, openLibrary, restartedOver, jobsOf, soon } from './helpers/generation-baseline.mjs';

/* S3-6c (V4): a pasted case with the learner's answers is published and graded at once. The publication is the same plan + runtime commit + look-again as every other publication,
   and each grading is found done by its attempt, so a process that died between the publication and the end of the gradings comes back as a job that finishes the gradings that
   are left - not as a job that imports the case a second time, and not as one that grades an answer twice. The "death" is a copy of the library folder taken while the job is held. */

const RESTART = ['generation', 'generationPublish', 'generationRestart'];
const hostOf = (complete, paths) => { const { starts: _starts, ...options } = managedRuntimeOptions({ complete, paths }); return options; };
const pasted = {
  title: 'Orchard Cold Chain',
  scenario: ['Orchard Cold Chain stores fresh fruit for supermarkets in three refrigerated warehouses.',
    'Temperature sensors report every minute to a desktop program written in Visual Basic in 2009.',
    'In March a warehouse lost power overnight and nobody was alerted until the morning shift arrived.',
    'Management wants customers to see live temperatures on their phones next season.'].join('\n\n'),
  questions: [{ prompt: 'Which architecture style would you recommend for the new monitoring platform? Justify.', marks: 6 },
    { prompt: 'Which data stores would you use for the sensor readings and the customer portal? Justify.', marks: 4 }],
};
const answer = (n) => `I recommend an event-driven architecture ${n} because the sensors already publish readings every minute.\n` +
  'Each reading becomes an event that an alerting service consumes, so a power loss raises an alarm at once.\nThe case does not say how many sensors there are, so I assume about 500.';

/** A library whose case job is held where `where` says, with the runtime on; the process "dies" there. */
async function dying(t, where) {
  const hold = gate(), model = createFakeModel(), grades = { asked: 0 };
  const opened = await openLibrary(t, { prefix: 'study-s36c-', model, options: hostOf(model, RESTART), hold });
  const sourceId = (await opened.service.call('source.add', { title: 'Cloud persistence', text: 'Polyglot persistence chooses a different data store for each workload. Relational databases give ACID transactions.', courses: ['Cloud Native'] })).id;
  const invoke = opened.service.runtime.invoke.bind(opened.service.runtime);
  opened.service.runtime.invoke = async (api, action, args, services) => {
    if (api === 'study.v1' && action === 'card.grade') { grades.asked++; if (where === 'grading' && !hold.entered) { hold.entered = true; await hold.promise; } }
    const result = await invoke(api, action, args, services);
    if (api === 'authoring.v1' && action === 'draft.publish.quick' && where === 'write') { hold.entered = true; await hold.promise; }
    return result;
  };
  const started = await opened.service.call('generate', { kind: 'case', ...pasted, answers: [answer(1), answer(2)], sourceIds: [sourceId], language: 'English', course: 'Cloud Native' });
  await soon(() => hold.entered, `the case job to be held at its ${where}`);
  return { ...opened, hold, started, grades };
}
const afterRestart = async (t, root) => {
  const calls = []; let model = async system => { calls.push(String(system).slice(0, 40)); throw new Error('a restart must not call a model by itself'); };
  const complete = (...args) => model(...args);
  const after = await restartedOver(t, root, { options: hostOf(complete, RESTART), model: complete });
  return { ...after, calls, use(next) { model = next; } };
};
const stateOf = async service => service.call('export');

test('restart, the case was published and its first grading was cut short: the retry does not import it again, and grades what is left once', async t => {
  const first = await dying(t, 'grading');
  const published = (await stateOf(first.service)).decks.filter(deck => deck.case);
  assert.equal(published.length, 1, 'the case is in the library');
  const after = await afterRestart(t, first.root), [job] = await jobsOf(after.service);
  assert.equal(job.contract.status, 'interrupted');
  const grader = createFakeModel(); after.use(grader);
  const done = await settleJob(after.service, (await after.service.call('job.control', { jobId: job.id, action: 'retry' })).attemptId);
  assert.equal(done.status, 'complete', done.stage);
  const state = await stateOf(after.service);
  assert.equal(state.decks.filter(deck => deck.case).length, 1, 'the case was not imported a second time');
  assert.equal(state.drafts.length, 0);
  const rubric = state.attempts.filter(item => item.assessment === 'rubric');
  assert.deepEqual(rubric.map(item => item.quiz_id).sort(), published[0].cards.map(card => card.id).sort(), 'each answered question is graded exactly once');
  assert.equal(done.graded, 2);
  first.hold.open();
});

test('restart, the case was written and the process died before it knew: the retry finds the write by looking, imports nothing again, and grades both answers once', async t => {
  const first = await dying(t, 'write');
  assert.equal((await stateOf(first.service)).decks.filter(deck => deck.case).length, 1, 'the library holds the case');
  assert.equal(first.grades.asked, 0, 'nothing was graded yet');
  const after = await afterRestart(t, first.root), [job] = await jobsOf(after.service);
  after.use(createFakeModel());
  const done = await settleJob(after.service, (await after.service.call('job.control', { jobId: job.id, action: 'retry' })).attemptId);
  assert.equal(done.status, 'complete', done.stage);
  assert.equal(done.recovered, true);
  const state = await stateOf(after.service);
  assert.equal(state.decks.filter(deck => deck.case).length, 1);
  assert.equal(state.attempts.filter(item => item.assessment === 'rubric').length, 2);
  first.hold.open();
});
