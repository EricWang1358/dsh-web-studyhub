/* S4-0 baseline of 为你定制 (the coach's variant preparation, already the by-the-day contract job `coach-daily`, #234). Describes what origin/main does
   today; the day row, pause and limits are in coach-daily.test.mjs, the preparation itself in coach.test.mjs. Gaps only. Fake models, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StudyService } from '../lib/service.js';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { dayOf } from '../lib/coach-daily.js';
import { usageLedger } from '../lib/model-usage.js';
import { until } from './helpers/wait.mjs';
import { gate, privateRoot, panelDoor } from './helpers/model-family-baseline.mjs';

const text = 'The Caretaker manages snapshot history without inspecting snapshot contents. A Memento stores an opaque snapshot of internal state.';
const quiz = n => ({ id: `q${n}`, kind: 'quiz', topic: 'Memento', objective: `objective ${n}`, prompt: `第 ${n} 个关于 Memento 的问题：谁管理历史 ${n}？`, answer: 'Caretaker',
  hint: 'Who keeps the history?', explanation: 'The Caretaker keeps history.', misconception: 'Treating the Memento as the history manager.',
  citations: [{ sourceId: 'src', quote: 'The Caretaker manages snapshot history without inspecting snapshot contents.' }],
  options: [{ id: 'a', text: 'Caretaker', correct: true, explanation: 'It keeps history.' }, { id: 'b', text: 'Memento', correct: false, explanation: 'It is the snapshot.' },
    { id: 'c', text: 'Originator', correct: false, explanation: 'It restores state.' }] });

/** A library with ten quiz cards, set up only through `call` so the panel's door and the runtime's door can seed the same one. */
async function seed(call) {
  await call('source.add', { id: 'src', title: 'Memento notes', text });
  await call('draft.save', { deck: { id: 'd', title: 'Patterns', cards: Array.from({ length: 10 }, (_, index) => quiz(index + 1)) } });
  await call('draft.publish', { id: 'd' });
}
/** The learner misses `count` cards; the refs of those cards. */
async function miss(call, count) {
  let run = await call('review.start', { deckId: 'd', mode: 'quiz', count });
  const refs = [];
  for (let i = 0; i < count; i++) {
    refs.push({ deckId: 'd', cardId: run.card.id });
    run = await call('review.answer', { runId: run.id, cardId: run.card.id, selected: [run.card.options.find(option => option.text === 'Memento').id] });
    if (i < count - 1) run = await call('review.move', { runId: run.id, direction: 1 });
  }
  return refs;
}
const today = () => dayOf(Date.now());
const dayRows = async call => (await call('snapshot', {})).jobs.filter(job => job.type === 'coach-daily');

/** The coach's light model: counts what is in flight (one lane means one), keeps the options of each call, can hold the first one. */
function lightModel() {
  const log = [], base = createFakeModel({ log, usage: true }), control = { options: [], inFlight: 0, peak: 0, hold: null, armedAt: 0 };
  /** The next call is held until `hold.release()`; what was asked before (the seeding) is not counted. */
  control.arm = () => { control.hold = gate(); control.armedAt = control.options.length; return control.hold; };
  control.complete = async (...args) => {
    control.options.push(args[2] || {}); control.inFlight += 1; control.peak = Math.max(control.peak, control.inFlight);
    try { if (control.hold && control.options.length === control.armedAt + 1) await control.hold.promise; return await base(...args); }
    finally { control.inFlight -= 1; }
  };
  return control;
}

test('preparation batches run one after another in one per-library lane, and a queued batch reads the settings in force when it STARTS, not when it was queued', async t => {
  const light = lightModel();
  const root = await privateRoot(t, 'model-baseline-coach-');
  const service = new StudyService(root, { complete: light.complete, completeLight: light.complete, coach: true });
  t.after(() => service.dispose());
  const call = (action, args) => service.call(action, args);
  await seed(call);
  const refs = await miss(call, 5);
  const hold = light.arm(), before = light.options.length, ledger = usageLedger(root), coachCalls = async () => (await ledger.summary({ days: 1 })).byFeature.coach?.calls || 0, wasCalls = await coachCalls();
  await call('coach.variants', { cards: refs, consent: true });
  await until(() => light.options.length === before + 1, 'the first batch (the three cards that fill the queue) to reach the model');
  const status = await call('coach.status');
  assert.equal(status.preparing, true);
  const [row] = await dayRows(call);
  assert.equal(row.contract.status, 'running');
  assert.equal(row.contract.detail.batches.length, 1, 'the batch still waiting for the lane has no entry yet: the day shows only what has begun');
  assert.deepEqual((await call('snapshot', {})).jobs.map(job => job.type), ['coach-daily'], 'a batch is no job of its own');
  assert.deepEqual([...service.runtime.work.coachTasks.get(root)].map(task => [task.kind, task.status]), [['prep', 'running'], ['prep', 'running']], 'two tasks, the second not started');
  await call('job.control', { jobId: `coach:${today()}`, action: 'set', patch: { reasoning: 'high' } });
  hold.release();
  await until(async () => (await call('coach.status')).preparing === false, 'both batches to finish');
  assert.equal(light.peak, 1, 'one lane: never two batches with the model at once');
  assert.equal(await coachCalls() - wasCalls, 2, 'the usage ledger counted the two batches once each, under the coach feature');
  assert.deepEqual(light.options.slice(before).map(option => option.reasoningEffort), [undefined, 'high'], 'the first batch ran before the change, the queued one after it');
  const batches = (await dayRows(call))[0].contract.detail.batches;
  assert.deepEqual(batches.map(batch => [batch.targets, batch.reasoning]), [[3, undefined], [2, 'high']]);
});

test('the panel and the runtime door prepare the same variants for the same misses and record the same day', async t => {
  const direct = lightModel(), viaPanel = lightModel();
  const root = await privateRoot(t, 'model-baseline-coach-direct-'), panelRoot = await privateRoot(t, 'model-baseline-coach-panel-');
  const service = new StudyService(root, { complete: direct.complete, completeLight: direct.complete, coach: true });
  t.after(() => service.dispose());
  const door = (_name, action, args) => (_name === 'panel' ? panel(action, args) : service.call(action, args));
  const panel = panelDoor(t, panelRoot, { complete: viaPanel.complete, light: viaPanel.complete });
  const outcome = async name => {
    const call = (action, args) => door(name, action, args);
    await seed(call);
    await call('coach.variants', { cards: await miss(call, 3), consent: true });
    await until(async () => (await call('coach.status')).preparing === false && (await dayRows(call)).length === 1, `${name} to prepare`);
    const day = (await dayRows(call))[0].contract;
    const prepared = (await call('export')).prepared.map(item => [item.reason, item.card.kind, item.status]).sort();
    return { prepared, id: day.jobId, batches: day.detail.batches.map(({ status, targets, generated, passed, skipped }) => [status, targets, generated, passed, skipped]), metrics: day.detail.metrics.passed, kind: day.kind };
  };
  const [a, b] = [await outcome('runtime'), await outcome('panel')];
  assert.deepEqual(b, a);
  assert.equal(a.id, `coach:${today()}`);
  assert.equal(viaPanel.options.length, direct.options.length, 'the same number of model calls');
});
