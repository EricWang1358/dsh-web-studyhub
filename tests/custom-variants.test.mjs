/* 深度定制 (4.4 S3): the plan's `questions.variants` decides whether the misses of THAT course get variants prepared automatically (the practice debrief, a follow-up, a too-easy /
   too-hard vote). Off: none for that course, whatever the learner's general 备题 consent says; on: the plan is the learner's yes for that course (the general consent is not
   switched on by it); no plan, or a plan that makes no questions: the general consent decides, as it always did. What the learner asks for by hand in the wrong book is theirs
   and not touched. Fake model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StudyService } from '../lib/service.js';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { customDefaults } from '../lib/custom-plan.js';
import { variantSwitch, prepPolicy } from '../lib/custom-variants.js';
import { SWITCH_MODE, switchOptions } from './helpers/runtime-switch.mjs';

const source = { id: 'src', title: 'Memento notes',
  text: 'The Caretaker manages snapshot history without inspecting snapshot contents. A Memento stores an opaque snapshot of internal state. The Originator creates and restores its own snapshots.' };
const quiz = (n, prompt) => ({ id: `q${n}`, kind: 'quiz', topic: 'Memento', objective: `objective ${n}`, prompt, answer: 'Caretaker', hint: 'Who keeps the history?',
  explanation: 'The Caretaker keeps history; the Originator restores state.', misconception: 'Treating the Memento as the history manager.',
  citations: [{ sourceId: 'src', quote: 'The Caretaker manages snapshot history without inspecting snapshot contents.' }],
  options: [{ id: 'a', text: 'Caretaker', correct: true, explanation: 'It manages history without reading snapshots.' }, { id: 'b', text: 'Memento', correct: false, explanation: 'It is the snapshot, not its manager.' },
    { id: 'c', text: 'Originator', correct: false, explanation: 'It creates and restores snapshots.' }] });
const prompts = ['Memento 模式中哪个角色管理历史？', 'Caretaker 和 Memento 的区别是什么？', '为什么 Caretaker 不读取快照内容？', 'Originator 负责哪一步？', '谁创建快照？'];
const plan = (questions = {}) => ({ ...customDefaults('follow'), scope: { kind: 'all' }, questions: { ...customDefaults('follow').questions, make: true, ...questions } });

async function setup(t, { custom, consent = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'study-custom-variants-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = [], light = createFakeModel({ log });
  const service = new StudyService(root, { complete: light, completeLight: light, coach: true, ...switchOptions(SWITCH_MODE, { complete: light, paths: ['coach'] }) });
  t.after(() => service.dispose());
  await service.call('source.add', source);
  await service.call('draft.save', { deck: { id: 'd', title: 'Patterns', course: 'Mem', cards: prompts.map((prompt, at) => quiz(at + 1, prompt)) } });
  await new StudyService(root).call('draft.publish', { id: 'd' });
  if (custom !== undefined) await service.call('course.save', { name: 'Mem', custom });
  if (consent) await service.call('coach.consent', { prep: true });
  return { service, log };
}
/** A round of five right answers: the debrief wants a harder variant of what was easy (the rule `concept-only`), so it asks for variants when it may. */
async function finishedRun(service) {
  let run = await service.call('review.start', { deckId: 'd', mode: 'quiz' });
  for (let at = 0; at < 5; at++) {
    run = await service.call('review.answer', { runId: run.id, cardId: run.card.id, selected: [run.card.options.find(option => option.text === 'Caretaker').id] });
    run = await service.call('review.move', { runId: run.id, direction: 1 });
  }
  return run;
}
const variantCalls = log => log.filter(entry => entry.prompt.includes('为每个 target')).length;
const prepare = async (service, run) => { const debrief = await service.call('coach.debrief', { runId: run.id }); await service.call('coach.prepare'); return debrief; };

test('the switch of a course: only a plan that makes questions has one; policy: the plan, else the general consent', () => {
  const state = custom => ({ decks: [{ id: 'd', course: 'Mem' }], courses: [{ name: 'Mem', ...(custom ? { custom } : {}) }] }), deck = { id: 'd', course: 'Mem' };
  assert.equal(variantSwitch(state(), deck), null, 'no plan');
  assert.equal(variantSwitch(state(plan({ variants: true })), deck), true);
  assert.equal(variantSwitch(state(plan({ variants: false })), deck), false);
  assert.equal(variantSwitch(state(plan({ make: false, variants: false })), deck), null, 'a plan that makes no questions has no say');
  assert.equal(variantSwitch({ courses: [] }, { id: 'x', course: 'Nowhere' }), null);
  assert.deepEqual(prepPolicy(state(), deck, true), { on: true, viaPlan: false });
  assert.deepEqual(prepPolicy(state(), deck, false), { on: false, viaPlan: false });
  assert.deepEqual(prepPolicy(state(plan({ variants: false })), deck, true), { on: false, viaPlan: false }, 'off beats the general consent');
  assert.deepEqual(prepPolicy(state(plan({ variants: true })), deck, false), { on: true, viaPlan: true }, 'on is the learner\'s yes for this course');
  assert.deepEqual(prepPolicy(state(plan({ variants: true })), deck, true), { on: true, viaPlan: false });
});

test('variants off in the plan: no automatic preparation for that course, with the general consent on', async t => {
  const { service, log } = await setup(t, { custom: plan({ variants: false }), consent: true });
  const debrief = await prepare(service, await finishedRun(service));
  assert.equal(debrief.preparing, false);
  assert.equal(variantCalls(log), 0, 'the model was not asked for variants');
  assert.equal((await service.call('coach.status')).ready, 0);
});

test('no plan: the general consent decides, as before', async t => {
  const { service, log } = await setup(t, { consent: true });
  const debrief = await prepare(service, await finishedRun(service));
  assert.equal(debrief.preparing, true);
  assert.ok(variantCalls(log) >= 1);
  const off = await setup(t);
  assert.equal((await prepare(off.service, await finishedRun(off.service))).preparing, false, 'and without it nothing is prepared');
});

test('variants on in the plan: this course is prepared without the general consent, which stays off', async t => {
  const { service, log } = await setup(t, { custom: plan({ variants: true }) });
  const debrief = await prepare(service, await finishedRun(service));
  assert.equal(debrief.preparing, true);
  assert.ok(variantCalls(log) >= 1, 'the model was asked');
  assert.ok((await service.call('coach.status')).ready >= 1, 'and the variants are ready');
  assert.notEqual((await service.call('export')).learner?.consent?.prep, true, 'the plan is the yes of this course only');
});

test('what the learner asks for by hand is theirs: coach.variants works on a course whose plan says off', async t => {
  const { service } = await setup(t, { custom: plan({ variants: false }), consent: true });
  const asked = await service.call('coach.variants', { cards: [{ deckId: 'd', cardId: 'q1' }] });
  assert.equal(asked.queued, 1);
  await service.call('coach.prepare');
});
