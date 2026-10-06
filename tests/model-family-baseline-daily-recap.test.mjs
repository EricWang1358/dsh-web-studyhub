/* S4-0 baseline of the daily recap (note.daily.*). Describes what origin/main does today. Reuse, force, final, batches, tone and the manual-edit guard
   are in daily-recap.test.mjs / daily-recap-tone.test.mjs; this file only pins what the migration must keep or consciously change. Fake model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StudyService } from '../lib/service.js';
import { usageLedger } from '../lib/model-usage.js';
import { reportUsage } from '../lib/usage-scope.js';
import { until } from './helpers/wait.mjs';
import { gate, privateRoot, panelDoor } from './helpers/model-family-baseline.mjs';

const writing = '# 今日学习总结\n\n' + '围绕已练习的知识点整理正确思路，核对条件与推理步骤。'.repeat(8);
const course = '数学 / 第一章';

/** A library with forty quiz cards in one deck; seeded through the service so both doors can start from the same place. */
async function seeded(t, options = {}) {
  const root = await privateRoot(t, 'model-baseline-recap-');
  const service = new StudyService(root, options);
  t.after(() => service.dispose());
  await service.store.update(state => {
    state.decks.push({ id: 'd', title: course, course, cards: Array.from({ length: 40 }, (_, i) => ({ id: `d-${i}`, kind: 'quiz', topic: `知识点 ${i % 3}`, prompt: `题目 ${i}`,
      answer: '正确答案', explanation: '先核对条件。', options: [{ id: 'a', text: '正确选项', correct: true }, { id: 'b', text: '干扰选项' }] })) });
  });
  return service;
}
const answer = (service, count, offset = 0) => service.store.update(state => {
  for (let i = offset; i < offset + count; i++) state.attempts.push({ id: `a-${i}`, runId: 'seed', deckId: 'd', quiz_id: `d-${i}`, timestamp: new Date().toISOString(), grade: 4, assessment: 'graded' });
});
const noteOf = async (service, id) => (await service.call('note.get', { id }));
const done = (service, id, generation) => until(async () => { const note = await noteOf(service, id); return note.generation?.id === generation && note.generation.status !== 'running' && note; }, 'the generation to end');
/** A model that records what it was asked and can hold the n-th call. */
function model() {
  const control = { calls: [], gates: new Map() };
  control.complete = async (system, prompt, options = {}) => {
    const number = control.calls.length;
    control.calls.push({ system, data: JSON.parse(prompt), options });
    const held = control.gates.get(number);
    if (held) await held.promise;
    return writing;
  };
  return control;
}

test('a submission is its own snapshot: the questions and the tone are those of the moment it was started, and the recap is then stale, not rewritten', async t => {
  const fake = model(); fake.gates.set(0, gate());
  const service = await seeded(t, { complete: fake.complete });
  await answer(service, 10);
  const started = await service.call('note.daily.generate', { course });
  assert.equal(started.status, 'running');
  // After the submission the learner answers more, switches to the professional tone and finishes the round.
  await answer(service, 3, 10);
  await service.call('settings', { dailyRecap: { tone: 'professional' } });
  fake.gates.get(0).release();
  const first = await done(service, started.id, started.jobId);
  assert.equal(first.generation.status, 'done');
  assert.equal(fake.calls[0].data.questions.length, 10, 'the model was given the ten answers of the submission');
  assert.deepEqual([first.daily.answeredCount, first.daily.tone, first.daily.final], [10, 'friendly', false]);
  assert.equal((await service.call('note.daily.status', { course })).groups[0].stale, true, 'the three later answers make it stale; they were not slipped in');
  const next = await service.call('note.daily.generate', { course });
  assert.notEqual(next.jobId, started.jobId, 'a new submission is a new generation');
  const second = await done(service, started.id, next.jobId);
  assert.deepEqual([second.daily.answeredCount, second.daily.tone], [13, 'professional'], 'a new submission takes the settings in force now');
});

test('a generation superseded by a course change is not the one that writes: its late result changes nothing, the next generation owns the note', async t => {
  const fake = model(); fake.gates.set(0, gate());
  const service = await seeded(t, { complete: fake.complete });
  await answer(service, 10);
  const saved = await service.call('course.save', { name: '数学' });
  const started = await service.call('note.daily.generate', { course: saved.id });
  await until(() => fake.calls.length === 1, 'the first generation to reach the model');
  await service.call('course.rename', { id: saved.id, name: '高等数学' });
  const mid = await noteOf(service, started.id);
  assert.equal(mid.generation.status, 'superseded');
  assert.equal(mid.generation.id, started.jobId);
  const again = await service.call('note.daily.generate', { course: saved.id });
  assert.notEqual(again.jobId, started.jobId);
  const second = await done(service, started.id, again.jobId);
  assert.equal(second.generation.status, 'done');
  fake.gates.get(0).release();
  await new Promise(resolve => setTimeout(resolve, 60));
  const after = await noteOf(service, started.id);
  assert.deepEqual([after.generation.id, after.generation.status, after.revision], [again.jobId, 'done', second.revision], 'the late result of the superseded generation wrote nothing');
});

test('the recap is not a task of the console and has no host child: it runs as one plain model call with only an abort signal, and says so when no model is chosen', async t => {
  const fake = model(); fake.gates.set(0, gate());
  const service = await seeded(t, { complete: fake.complete });
  await answer(service, 10);
  const started = await service.call('note.daily.generate', { course });
  await until(() => fake.calls.length === 1, 'the generation to reach the model');
  assert.deepEqual(Object.keys(fake.calls[0].options), ['signal'], 'no jobId, stage, task or reasoning: lib/index.js sends this to the plain completion');
  assert.deepEqual((await service.call('snapshot', {})).jobs, [], 'no row in snapshot.jobs: its state is note.generation');
  assert.equal((await noteOf(service, started.id)).generation.status, 'running');
  fake.gates.get(0).release();
  await done(service, started.id, started.jobId);
  const bare = await seeded(t);
  await answer(bare, 10);
  await assert.rejects(bare.call('note.daily.generate', { course }), /请先选择用于每日总结的模型/);
  assert.equal((await bare.call('note.list')).notes.length, 0, 'a refusal leaves no note behind');
});

test('the panel and the runtime door produce the same recap for the same answers', async t => {
  const direct = model(), viaPanel = model();
  const service = await seeded(t, { complete: direct.complete }), twin = await seeded(t);
  for (const each of [service, twin]) await answer(each, 10);
  const panel = panelDoor(t, twin.store.root, { complete: viaPanel.complete });
  const viaRuntime = await service.call('note.daily.generate', { course });
  const viaDoor = await panel('note.daily.generate', { course });
  const [a, b] = await Promise.all([done(service, viaRuntime.id, viaRuntime.jobId),
    until(async () => { const note = await panel('note.get', { id: viaDoor.id }); return note.generation?.status === 'done' && note; }, 'the panel recap')]);
  const shape = note => [note.kind, note.title, note.markdown, note.daily.answeredCount, note.daily.wrongCount, note.daily.tone, note.daily.final, note.cards.length, note.generation.status];
  assert.deepEqual(shape(b), shape(a));
  assert.equal(viaPanel.calls.length, direct.calls.length);
  assert.equal(viaPanel.calls[0].system, direct.calls[0].system);
});

test('the usage of the recap goes to the ledger once, under the feature other (the notes context has none of its own), and the note keeps no usage', async t => {
  const service = await seeded(t, { complete: async () => { reportUsage({ uncachedInputTokens: 500, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 }); return writing; } });
  await answer(service, 10);
  const started = await service.call('note.daily.generate', { course });
  const note = await done(service, started.id, started.jobId);
  const { byFeature } = await usageLedger(service.store.root).summary({ days: 1 });
  assert.deepEqual(Object.keys(byFeature), ['other']);
  assert.equal(byFeature.other.calls, 1);
  assert.deepEqual(Object.keys(note.generation).filter(key => /usage|token/i.test(key)), []);
});
