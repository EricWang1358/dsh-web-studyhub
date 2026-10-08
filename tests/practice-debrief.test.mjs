/* 练习点评 (settings.practice.debrief): on by default, one light-model call for a round of 3 or more answers; switched off, coach.debrief makes NO model call
   and still returns the parts that need none (the measured split, the rule-based insights, headline and next step). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StudyService } from '../lib/service.js';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { SWITCH_MODE, switchOptions } from './helpers/runtime-switch.mjs';

const source = { id: 'src', title: 'Memento notes',
  text: 'The Caretaker manages snapshot history without inspecting snapshot contents. A Memento stores an opaque snapshot of internal state. The Originator creates and restores its own snapshots.' };
const quiz = (n, prompt) => ({ id: `q${n}`, kind: 'quiz', topic: 'Memento', objective: `objective ${n}`, prompt, answer: 'Caretaker', hint: 'Who keeps the history?',
  explanation: 'The Caretaker keeps history; the Originator restores state.', misconception: 'Treating the Memento as the history manager.',
  citations: [{ sourceId: 'src', quote: 'The Caretaker manages snapshot history without inspecting snapshot contents.' }],
  options: [{ id: 'a', text: 'Caretaker', correct: true, explanation: 'It manages history without reading snapshots.' },
    { id: 'b', text: 'Memento', correct: false, explanation: 'It is the snapshot, not its manager.' },
    { id: 'c', text: 'Originator', correct: false, explanation: 'It creates and restores snapshots.' }] });
const prompts = ['Memento 模式中哪个角色管理历史？', 'Caretaker 和 Memento 的区别是什么？', '为什么 Caretaker 不读取快照内容？', 'Originator 负责哪一步？', '谁创建快照？'];

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-practice-debrief-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = [];
  const light = createFakeModel({ log });
  const service = new StudyService(root, { complete: light, completeLight: light, coach: true, ...switchOptions(SWITCH_MODE, { complete: light, paths: ['coach'] }) });
  await service.call('source.add', source);
  await service.call('draft.save', { deck: { id: 'd', title: 'Patterns', cards: prompts.map((prompt, at) => quiz(at + 1, prompt)) } });
  await new StudyService(root).call('draft.publish', { id: 'd' });
  return { service, log };
}
async function finishedRun(service, answers = 5) {
  let run = await service.call('review.start', { deckId: 'd', mode: 'quiz' });
  for (let at = 0; at < answers; at++) {
    run = await service.call('review.answer', { runId: run.id, cardId: run.card.id, selected: [run.card.options.find((option) => option.text === 'Caretaker').id] });
    run = await service.call('review.move', { runId: run.id, direction: 1 });
  }
  return run;
}
const modelCalls = (log) => log.filter((entry) => entry.prompt.includes('本轮指标')).length;

test('on by default: a round of three or more answers asks the light model once', async (t) => {
  const { service, log } = await setup(t);
  const run = await finishedRun(service);
  const debrief = await service.call('coach.debrief', { runId: run.id });
  assert.equal(modelCalls(log), 1);
  assert.equal(debrief.headline, '概念会了，别停在纸上谈兵', 'the model phrased the headline');
});

test('switched off: no model call at all, and the measured parts are still there', async (t) => {
  const { service, log } = await setup(t);
  await service.call('coach.consent', { prep: true });
  await service.call('settings.practice.set', { patch: { debrief: false } });
  const run = await finishedRun(service);
  const debrief = await service.call('coach.debrief', { runId: run.id });
  assert.equal(log.length, 0, 'nothing was sent to any model: not the debrief, not a queued preparation');
  assert.equal(debrief.metrics.answered, 5);
  assert.equal(debrief.metrics.gradedCorrect, 5);
  assert.equal(debrief.insights[0].code, 'concept-only');
  assert.equal(debrief.preparing, false, 'a preparation is a model call too, and this switch promised none');
  assert.ok(debrief.headline && debrief.why, 'the rule-based advice is shown instead of the model sentence');
  assert.notEqual(debrief.headline, '概念会了，别停在纸上谈兵');
  assert.equal(debrief.next, 'continue_path');
  assert.equal((await service.call('export')).learner.summary || '', '', 'the profile summary is only ever written by the model call');
});

test('the switch is read when the debrief is made: turning it on again brings the model sentence back for the next round', async (t) => {
  const { service, log } = await setup(t);
  await service.call('settings.practice.set', { patch: { debrief: false } });
  const first = await finishedRun(service);
  await service.call('coach.debrief', { runId: first.id });
  assert.equal(modelCalls(log), 0);
  await service.call('settings.practice.reset');
  const second = await finishedRun(service);
  await service.call('coach.debrief', { runId: second.id });
  assert.equal(modelCalls(log), 1);
});

test('a debrief already made keeps being served after the switch goes off, without a new call', async (t) => {
  const { service, log } = await setup(t);
  const run = await finishedRun(service);
  const made = await service.call('coach.debrief', { runId: run.id });
  await service.call('settings.practice.set', { patch: { debrief: false } });
  const again = await service.call('coach.debrief', { runId: run.id });
  assert.equal(again.at, made.at);
  assert.equal(modelCalls(log), 1);
});
