/* S4-0 baseline of the model units of 学习流 (workflow.teaching.* and workflow.skeleton.generate). Describes what origin/main does today. Teaching
   results, undo, citations, review and timeouts are in workflow-teaching.test.mjs, the skeleton start in workflow-guide.test.mjs; this file only pins
   the input snapshot, the admission limit, the console visibility and the two entries. Fake model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StudyService } from '../lib/service.js';
import { usageLedger } from '../lib/model-usage.js';
import { reportUsage } from '../lib/usage-scope.js';
import { until } from './helpers/wait.mjs';
import { SWITCH_MODE, switchOptions } from './helpers/runtime-switch.mjs';
import { gate, privateRoot, panelDoor } from './helpers/model-family-baseline.mjs';

const quote = '缓存命中要求请求可以使用已保存的结果，且结果没有过期。';
const article = ['## 从一次请求开始', '## 一步一步推演', '## 边界与易错点'].map(heading => `${heading}\n\n${'这是为说明机制而设定的演示条件，资料本身仅给出复用和有效性的条件。先检查请求，再检查有效期，两项都满足才能复用，否则回源。'.repeat(4)}`).join('\n\n');
const approved = JSON.stringify({ grounded: true, coherent: true, explained: true, example: true, boundaries: true, issues: [] });

/** A model that tells a lesson from its review, records what each was given, and can hold the n-th teaching call. */
function model() {
  const control = { lessons: [], reviews: [], gates: new Map() };
  control.complete = async (system, prompt) => {
    if (system.startsWith('Independently')) { control.reviews.push(JSON.parse(prompt)); return approved; }
    const number = control.lessons.length;
    control.lessons.push(JSON.parse(prompt));
    await control.gates.get(number)?.promise;
    return JSON.stringify({ markdown: article, citations: [{ sourceId: 'source', quote }] });
  };
  return control;
}
async function library(t, options = {}, sessions = 1) {
  const root = await privateRoot(t, 'model-baseline-workflow-');
  const service = new StudyService(root, { ...options, ...switchOptions(SWITCH_MODE, { complete: options.complete, paths: ['workflow'] }) });
  t.after(() => service.dispose());
  await service.store.update(state => {
    state.sources.push({ id: 'source', title: '缓存资料', text: `${quote}未命中时仍需访问原始服务。` });
    state.decks.push({ id: 'deck', title: '缓存', cards: [{ id: 'card', topic: '缓存', kind: 'flashcard', prompt: '如何判断可复用？', answer: '检查请求和有效期', explanation: quote, citations: [{ sourceId: 'source', quote }] }] });
  });
  const template = await service.call('workflow.save', { title: '讲解与复述', steps: [{ id: 'lesson', kind: 'lesson', title: '概念与例子' }, { id: 'recall', kind: 'recall', title: '复述' }] });
  const started = [];
  for (let i = 0; i < sessions; i++) started.push(await service.call('workflow.session.start', { templateId: template.id, topic: `缓存 ${i}`, scope: [{ deckId: 'deck' }], requestId: `start-${i}` }));
  return { root, service, session: started[0], sessions: started };
}
const teach = (call, session, extra = {}) => call('workflow.teaching.start', { id: session.id, version: session.version, stepId: 'lesson', mode: 'lesson', ...extra });
const finished = (call, id) => until(async () => { const { session } = await call('workflow.session.get', { id }); return session.records.lesson?.teaching?.status !== 'running' && session; }, 'the teaching to end');

test('a teaching is its own snapshot: the review is given the cards and evidence of the moment it was started, and the lesson lands on the step it was started for', async t => {
  const fake = model(); fake.gates.set(0, gate());
  const { service, session } = await library(t, { complete: fake.complete });
  await teach(service.call.bind(service), session);
  await until(() => fake.lessons.length === 1, 'the lesson call');
  assert.match(JSON.stringify(fake.lessons[0].cards), /如何判断可复用/);
  // The learner edits the card and moves on to the next step while the model is still writing.
  await service.store.update(state => { state.decks[0].cards[0].prompt = '改过之后的问题'; });
  const moved = await service.call('workflow.session.advance', { id: session.id, version: (await service.call('workflow.session.get', { id: session.id })).session.version, outcome: 'skipped', requestId: 'move' });
  assert.equal(moved.currentStepId, 'recall');
  fake.gates.get(0).release();
  const done = await finished(service.call.bind(service), session.id);
  assert.equal(done.currentStepId, 'recall', 'the learner is still where they moved to');
  assert.equal(done.records.lesson.content, article, 'the lesson was kept on the step it was started for');
  assert.equal(done.records.lesson.teaching.status, 'done');
  assert.match(JSON.stringify(fake.reviews[0].cards), /如何判断可复用/, 'the review judged the article against the input of the submission, not the edited card');
  assert.doesNotMatch(JSON.stringify(fake.reviews[0].cards), /改过之后的问题/);
});

test('at most three teachings per library are admitted at once; the fourth is refused at the door, never queued, and none of them is a row of the console', async t => {
  const fake = model(); for (const n of [0, 1, 2]) fake.gates.set(n, gate());
  const { service, sessions } = await library(t, { complete: fake.complete }, 4);
  const call = service.call.bind(service);
  for (const session of sessions.slice(0, 3)) await teach(call, session);
  await until(() => fake.lessons.length === 3, 'three lesson calls');
  await assert.rejects(teach(call, sessions[3]), /已有三份讲解正在生成/);
  assert.equal(fake.lessons.length, 3, 'the refused one never reached the model');
  // Reviewed difference of the runtime side (S4-6): a teaching is a Job like every other background job, so it is a row of the 任务 console; its state in
  // session.records[step].teaching is unchanged.
  const rows = (await call('snapshot', {})).jobs.map(job => job.type);
  if (SWITCH_MODE === 'runtime') assert.deepEqual(rows, ['workflow-teaching', 'workflow-teaching', 'workflow-teaching']);
  else assert.deepEqual(rows, [], 'a teaching lives in session.records[step].teaching, not in snapshot.jobs');
  const running = (await call('workflow.session.get', { id: sessions[0].id })).resources;
  assert.equal(running.teachingActive, true);
  for (const n of [0, 1, 2]) fake.gates.get(n).release();
  await Promise.all(sessions.slice(0, 3).map(session => finished(call, session.id)));
  await until(() => service.runtime.work.workflowTeachingJobs.size === 0, 'the jobs to be retired');
  assert.equal((await teach(call, sessions[3])).session.records.lesson.teaching.status, 'running', 'a free slot is admitted again');
});

test('the panel and the runtime door start the same teaching: the same lesson text, citations and teaching record', async t => {
  const direct = model(), viaPanel = model();
  const a = await library(t, { complete: direct.complete }), b = await library(t);
  const panel = panelDoor(t, b.root, { complete: viaPanel.complete, ...(SWITCH_MODE === 'runtime' ? { pilot: { workflow: true } } : {}) });
  await teach(a.service.call.bind(a.service), a.session);
  await teach(panel, b.session);
  const [x, y] = await Promise.all([finished(a.service.call.bind(a.service), a.session.id), finished(panel, b.session.id)]);
  const shape = ({ records: { lesson } }) => [lesson.content, lesson.citations, lesson.teaching.mode, lesson.teaching.status, lesson.materialBy];
  assert.deepEqual(shape(y), shape(x));
  assert.deepEqual([viaPanel.lessons.length, viaPanel.reviews.length], [direct.lessons.length, direct.reviews.length]);
});

test('the usage of a teaching is on its record and in the ledger under flow, once per model call: the lesson and its review', async t => {
  const inner = model();
  const { service, session } = await library(t, { complete: async (...args) => { reportUsage({ uncachedInputTokens: 500, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 }); return inner.complete(...args); } });
  await teach(service.call.bind(service), session);
  const done = await finished(service.call.bind(service), session.id);
  assert.equal(done.records.lesson.teaching.status, 'done');
  assert.equal(done.records.lesson.teaching.tokenUsage.calls, 2);
  assert.equal((await usageLedger(service.store.root).summary({ days: 1 })).byFeature.flow.calls, 2);
});
