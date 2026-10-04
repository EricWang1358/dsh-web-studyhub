import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { recapDay } from '../lib/daily-recap.js';
import { createFakeModel } from '../scripts/fake-model.mjs';

const writing = '# 今日学习总结\n\n' + '围绕已练习的知识点整理正确思路，核对条件与推理步骤。'.repeat(8);
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'study-daily-recap-'));
  const service = new StudyService(root, options);
  t.after(async () => { service.dispose(); await rm(root, { recursive: true, force: true }); });
  await service.store.update(state => {
    for (const [id, course] of [['d', '数学 / 第一章'], ['d2', '数学 / 第二章'], ['other', '英语']])
      state.decks.push({ id, title: course, course, cards: Array.from({ length: 40 }, (_, i) => ({
        id: `${id}-${i}`, kind: 'quiz', topic: `知识点 ${i % 3}`, prompt: `题目 ${i}`, answer: '正确答案',
        explanation: '先核对条件，然后展开推理。', options: [{ id: 'a', text: '正确选项', correct: true }, { id: 'b', text: '干扰选项' }],
      })) });
  });
  return service;
}
async function answers(service, count, { deckId = 'd', offset = 0, timestamp = new Date().toISOString(), runId = 'seed', grade = 4, retry = false } = {}) {
  await service.store.update(state => {
    for (let i = offset; i < offset + count; i++) state.attempts.push({ id: `${runId}-${deckId}-${i}-${state.attempts.length}`,
      runId, deckId, quiz_id: `${deckId}-${i}`, timestamp, grade, assessment: 'graded', retry });
  });
}
async function ready(service, id) {
  for (let i = 0; i < 150; i++) {
    const note = await service.call('note.get', { id });
    if (note.generation?.status !== 'running') return note;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('daily recap did not finish');
}

test('daily recap defaults off, counts distinct answered questions, and refuses fewer than ten before model or note creation', async t => {
  let calls = 0;
  const service = await fixture(t, { complete: async () => { calls++; return writing; } });
  assert.deepEqual((await service.call('settings')).dailyRecap, { automatic: false, tone: 'friendly', timeZone: 'Asia/Shanghai' });
  await answers(service, 9);
  await answers(service, 9, { retry: true });
  const status = await service.call('note.daily.status', { course: '数学 / 第一章' });
  assert.equal(status.groups[0].answeredCount, 9);
  assert.equal(status.groups[0].remaining, 1);
  await assert.rejects(service.call('note.daily.generate', { course: '数学' }), /10/);
  assert.equal(calls, 0);
  assert.equal((await service.call('note.list')).notes.length, 0);
});

test('chapters append to one daily course recap, parallel starts deduplicate, and correct answers produce a grounded review summary', async t => {
  let calls = 0, payload, system;
  const service = await fixture(t, { complete: async (s, p) => { calls++; system = s; payload = JSON.parse(p); return writing; } });
  await answers(service, 10);
  const [first, second] = await Promise.all([service.call('note.daily.generate', { course: '数学 / 第一章' }), service.call('note.daily.generate', { course: '数学' })]);
  assert.equal(first.id, second.id);
  let note = await ready(service, first.id);
  assert.equal(note.kind, 'daily-recap');
  assert.equal(note.daily.answeredCount, 10);
  assert.equal(note.daily.wrongCount, 0);
  assert.equal(calls, 1);
  assert.match(system, /Do not invent/);
  assert.equal(payload.wrongCount, 0);
  assert.equal(payload.questions.length, 10);
  await answers(service, 22, { deckId: 'd2' });
  const update = await service.call('note.daily.generate', { course: '数学 / 第二章' });
  assert.equal(update.id, first.id);
  note = await ready(service, first.id);
  assert.equal(note.cards.length, 32);
  assert.equal(note.daily.answeredCount, 32);
  assert.equal((await service.call('note.list')).notes.length, 1);
});

test('settings merge partially, validate choices, and preserve existing preferences on invalid input', async t => {
  const service = await fixture(t);
  await service.call('settings', { dailyRecap: { tone: 'professional' } });
  await service.call('settings', { dailyRecap: { automatic: true } });
  assert.deepEqual((await service.call('settings')).dailyRecap, { automatic: true, tone: 'professional', timeZone: 'Asia/Shanghai' });
  for (const dailyRecap of [{ tone: 'casual' }, { automatic: 1 }, { timeZone: 'not-a-zone' }, null])
    await assert.rejects(service.call('settings', { dailyRecap }));
  assert.equal((await service.call('settings')).dailyRecap.automatic, true);
});

test('courses and local calendar dates stay separate; a note preserves its grouping zone across timezone changes', async t => {
  const service = await fixture(t, { complete: async () => writing });
  await answers(service, 10, { timestamp: '2026-10-03T18:00:00Z' });
  await answers(service, 10, { deckId: 'other', timestamp: '2026-10-03T18:00:00Z' });
  const china = await service.call('note.daily.status', { day: '2026-10-04', timeZone: 'Asia/Shanghai' });
  assert.deepEqual(china.groups.map(group => group.answeredCount), [10, 10]);
  assert.equal((await service.call('note.daily.status', { day: '2026-10-04', timeZone: 'UTC' })).groups.length, 0);
  const start = await service.call('note.daily.generate', { course: china.groups[0].courseId, day: '2026-10-04', timeZone: 'Asia/Shanghai' });
  await ready(service, start.id);
  const moved = await service.call('note.daily.status', { course: '数学', day: '2026-10-04', timeZone: 'UTC' });
  assert.equal(moved.groups[0].answeredCount, 10);
  assert.equal(moved.groups[0].timeZone, 'Asia/Shanghai');
  assert.equal(moved.groups[0].noteId, start.id);
  assert.equal((await service.call('note.daily.generate', { course: '数学', day: '2026-10-04', timeZone: 'UTC' })).status, 'done');
});

test('read and status never generate; automatic checkpoints prepare at ten and every five distinct questions, then finalize on completion', async t => {
  const stages = [];
  const service = await fixture(t, { complete: async (_system, input) => { stages.push(JSON.parse(input)); return writing; } });
  let run = await service.call('review.start', { mode: 'new', deckId: 'd', count: 12, ordered: true });
  for (let i = 0; i < 10; i++) {
    await service.call('review.answer', { runId: run.id, cardId: run.card.id, selected: ['a'] });
    run = await service.call('review.move', { runId: run.id, direction: 1 });
  }
  await service.call('note.daily.status', { runId: run.id });
  assert.equal(stages.length, 0);
  await service.call('settings', { dailyRecap: { automatic: true } });
  await service.call('review.answer', { runId: run.id, cardId: run.card.id, selected: ['a'] });
  run = await service.call('review.move', { runId: run.id, direction: 1 });
  const before = (await service.call('note.daily.status', { runId: run.id })).groups[0];
  await ready(service, before.noteId);
  assert.equal(stages.length, 1);
  assert.equal(stages[0].answeredCount, 11);
  await service.call('review.answer', { runId: run.id, cardId: run.card.id, selected: ['a'] });
  assert.equal(stages.length, 1);
  run = await service.call('review.move', { runId: run.id, direction: 1 });
  assert.equal(run.complete, true);
  const final = await ready(service, before.noteId);
  assert.equal(final.daily.answeredCount, 12);
  assert.equal(final.daily.final, true);
  assert.equal(stages.length, 2);
});

test('a running checkpoint coalesces new evidence and finalization instead of creating another note', async t => {
  let release, count = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const service = await fixture(t, { complete: async () => { count++; if (count === 1) await gate; return writing; } });
  await service.call('settings', { dailyRecap: { automatic: true } });
  await answers(service, 10);
  const first = await service.call('note.daily.generate', { course: '数学' });
  await answers(service, 5, { offset: 10 });
  await service.call('note.daily.advance', { course: '数学' });
  await answers(service, 1, { offset: 15 });
  await service.call('note.daily.advance', { course: '数学', final: true });
  release();
  let final;
  for (let i = 0; i < 150; i++) {
    final = await service.call('note.get', { id: first.id });
    if (final.daily?.final && final.generation.status === 'done') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(final.daily.answeredCount, 16);
  assert.equal(final.daily.final, true);
  assert.equal(count, 2);
  assert.equal((await service.call('note.list')).notes.length, 1);
});

test('manual edits survive late completion and automatic updates, explicit replacement can update, and CSDN linking retains local writing', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const service = await fixture(t, { complete: async () => { calls++; if (calls === 1) await gate; return writing; } });
  await answers(service, 10);
  const first = await service.call('note.daily.generate', { course: '数学' });
  await service.call('note.save', { id: first.id, markdown: '# 我写的总结' });
  release();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal((await ready(service, first.id)).markdown, '# 我写的总结');
  assert.equal((await service.call('note.daily.generate', { course: '数学' })).status, 'protected');
  await service.call('settings', { dailyRecap: { automatic: true } });
  await answers(service, 5, { offset: 10 });
  await service.call('note.daily.advance', { course: '数学', final: true });
  assert.equal(calls, 1);
  await service.call('note.daily.generate', { course: '数学', force: true });
  const updated = await ready(service, first.id);
  assert.equal(updated.daily.manualEditedAt, undefined);
  await service.call('note.home', { home: 'https://blog.csdn.net/example' });
  await service.call('note.link', { id: first.id, url: 'https://blog.csdn.net/example/article/details/12345' });
  assert.equal((await service.call('note.get', { id: first.id })).markdown, writing);
  await service.call('note.save', { id: first.id, markdown: 'Linked daily writing can still be edited' });
});

test('failed updates preserve successful content and automatic retries do not loop on unchanged evidence', async t => {
  let failing = false, calls = 0;
  const service = await fixture(t, { complete: async () => { calls++; if (failing) throw new Error('model unavailable'); return writing; } });
  await answers(service, 10);
  const first = await service.call('note.daily.generate', { course: '数学' });
  await ready(service, first.id);
  await answers(service, 5, { offset: 10 });
  failing = true;
  await service.call('settings', { dailyRecap: { automatic: true } });
  await service.call('note.daily.advance', { course: '数学', final: true });
  const failed = await ready(service, first.id);
  assert.equal(failed.generation.status, 'failed');
  assert.equal(failed.markdown, writing);
  await service.call('note.daily.advance', { course: '数学', final: true });
  assert.equal(calls, 2);
  failing = false;
  await service.call('note.daily.generate', { course: '数学' });
  assert.equal((await ready(service, first.id)).generation.status, 'done');
});

test('implicit credits never count and weak evidence remains after a correct retry, with real selected answers in the prompt', async t => {
  let input;
  const service = await fixture(t, { complete: async (_system, prompt) => { input = JSON.parse(prompt); return writing; } });
  await answers(service, 9);
  await service.store.update(state => state.attempts.push({ id: 'credit', deckId: 'd', quiz_id: 'd-20', timestamp: new Date().toISOString(), grade: 4, implicit: true }));
  assert.equal((await service.call('note.daily.status', { course: '数学' })).groups[0].answeredCount, 9);
  const run = await service.call('review.start', { mode: 'new', deckId: 'd', count: 1, ordered: true });
  // Seeded attempts do not change card scheduling: pick the first card without a duplicate distinct identity.
  await service.call('review.end', { runId: run.id });
  await service.store.update(state => {
    state.runs.push({ id: 'weak', deckId: 'd', index: 0, entries: [{ deckId: 'd', card: state.decks[0].cards[9], feedback: { selected: ['b'], grade: 1 }, retry: false }] });
    state.attempts.push({ id: 'weak-original', runId: 'weak', deckId: 'd', quiz_id: 'd-9', grade: 1, timestamp: new Date().toISOString(), assessment: 'graded' });
    state.attempts.push({ id: 'weak-retry', runId: 'weak', deckId: 'd', quiz_id: 'd-9', grade: 4, timestamp: new Date().toISOString(), assessment: 'graded', retry: true });
  });
  const start = await service.call('note.daily.generate', { course: '数学' });
  await ready(service, start.id);
  assert.equal(input.answeredCount, 10);
  assert.equal(input.wrongCount, 1);
  assert.deepEqual(input.questions.find(question => question.cardId === 'd-9').attempts[0].selected, ['b']);
});

test('run scope includes all today course attempts and keeps previous-day feedback accessible after midnight', async t => {
  const service = await fixture(t, { complete: async () => writing });
  const today = recapDay(Date.now(), 'Asia/Shanghai');
  const yesterday = recapDay(Date.now() - 86400000, 'Asia/Shanghai');
  await answers(service, 10, { timestamp: `${yesterday}T04:00:00Z`, runId: 'cross' });
  await answers(service, 5, { deckId: 'd2' });
  await answers(service, 5, { deckId: 'd', offset: 10, runId: 'cross' });
  await answers(service, 10, { deckId: 'other' });
  await service.store.update(state => state.runs.push({ id: 'cross', deckId: 'd', index: 0, entries: [{ card: state.decks[0].cards[0] }] }));
  const previous = await service.call('note.daily.generate', { course: '数学', day: yesterday });
  await ready(service, previous.id);
  const status = await service.call('note.daily.status', { runId: 'cross' });
  assert.deepEqual(status.groups.map(group => [group.day, group.course, group.answeredCount]), [[today, '数学', 10], [yesterday, '数学', 10]]);
  assert.equal(status.groups[1].noteId, previous.id);
});

test('an unchanged save allows automatic updates and cached explanations stay out of public snapshots', async t => {
  let calls = 0;
  const service = await fixture(t, { complete: async () => { calls++; return writing; } });
  await answers(service, 35);
  const first = await service.call('note.daily.generate', { course: '数学' });
  const note = await ready(service, first.id);
  assert.equal(note.daily.fragments, undefined);
  const unchanged = await service.call('note.save', { id: note.id, expectedRevision: note.revision,
    title: note.title, markdown: note.markdown, cards: note.cards });
  assert.equal(unchanged.revision, note.revision);
  assert.equal(unchanged.daily.manualEditedAt, undefined);
  assert.equal((await service.call('snapshot')).notes[0].daily.fragments, undefined);
  assert.equal(calls, 3, 'two bounded explanation batches and one consolidation');
  await answers(service, 1, { offset: 35 });
  await service.call('settings', { dailyRecap: { automatic: true } });
  await service.call('note.daily.advance', { course: '数学', final: true });
  const updated = await ready(service, note.id);
  assert.equal(updated.daily.answeredCount, 36);
  assert.equal(calls, 5, 'unchanged first batch reused, then new tail and consolidation');
  await assert.rejects(service.call('note.generate', { id: note.id }), /更新今日总结/);
});

test('a final request from a second runtime catches up the original pending job with one recap', async t => {
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const first = await fixture(t, { complete: async () => { calls++; if (calls === 1) await gate; return writing; } });
  const second = new StudyService(first.store.root, { complete: first.complete });
  t.after(() => second.dispose());
  await first.call('settings', { dailyRecap: { automatic: true } });
  await answers(first, 10);
  const started = await first.call('note.daily.generate', { course: '数学' });
  await answers(second, 6, { offset: 10 });
  const queue = await second.call('note.daily.advance', { course: '数学', final: true });
  assert.equal(queue.generated[0].id, started.id);
  release();
  let note;
  for (let i = 0; i < 150; i++) {
    note = await second.call('note.get', { id: started.id });
    if (note.daily.final && note.generation.status === 'done') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(note.daily.answeredCount, 16);
  assert.equal(note.daily.final, true);
  assert.equal(calls, 2);
  assert.equal((await second.call('note.list')).notes.length, 1);
});

test('cancellation and deletion prevent late writes; an interrupted generation can be restarted explicitly', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const service = await fixture(t, { complete: async () => { await gate; return writing; } });
  await answers(service, 10);
  const started = await service.call('note.daily.generate', { course: '数学' });
  await service.call('note.daily.cancel', { id: started.id });
  release();
  assert.equal((await ready(service, started.id)).generation.status, 'cancelled');
  assert.equal((await service.call('note.get', { id: started.id })).markdown, '');
  service.complete = async () => writing;
  await service.call('note.daily.generate', { course: '数学' });
  await ready(service, started.id);
  await service.store.update(state => {
    state.notes[0].generation = { id: 'abandoned', status: 'running', pid: process.pid, session: 'old-process' };
    delete state.notes[0].daily.fingerprint;
  });
  assert.equal((await service.call('note.daily.status', { course: '数学' })).groups[0].generation.status, 'interrupted');
  assert.equal((await service.call('note.get', { id: started.id })).generation.status, 'interrupted');
  assert.equal((await service.call('note.list')).notes[0].generation.status, 'interrupted');
  await service.call('note.daily.generate', { course: '数学' });
  assert.equal((await ready(service, started.id)).generation.status, 'done');
  let finish;
  service.complete = () => new Promise(resolve => { finish = resolve; });
  await answers(service, 1, { offset: 10 });
  await service.call('note.daily.generate', { course: '数学' });
  while (!finish) await new Promise(resolve => setTimeout(resolve, 5));
  await service.call('note.delete', { id: started.id });
  finish(writing);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await service.call('note.list')).notes.length, 0);
});

test('course rename keeps stable daily identity and a merge preserves both writings with one live course recap', async t => {
  const service = await fixture(t, { complete: async () => writing });
  await answers(service, 10);
  await answers(service, 10, { deckId: 'other' });
  const math = await service.call('course.save', { name: '数学' });
  const english = (await service.call('course.list')).courses.find(course => course.name === '英语');
  const a = await service.call('note.daily.generate', { course: math.id });
  const b = await service.call('note.daily.generate', { course: english.id });
  await ready(service, a.id); await ready(service, b.id);
  await service.call('note.save', { id: b.id, markdown: '# Personal English notes' });
  await service.call('course.rename', { id: math.id, name: '高等数学' });
  assert.equal((await service.call('note.daily.status', { course: math.id })).groups[0].noteId, a.id);
  assert.equal((await service.call('note.get', { id: a.id })).daily.course, '高等数学');
  await service.call('course.merge', { from: [english.id], into: math.id });
  const notes = (await service.call('note.list')).notes;
  assert.equal(notes.filter(note => note.kind === 'daily-recap').length, 1);
  assert.equal(notes.find(note => note.id === b.id).markdown, '# Personal English notes');
  assert.equal((await service.call('note.daily.status', { course: math.id })).groups[0].answeredCount, 20);
});

test('linking CSDN during a daily update does not discard the newer writing', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const service = await fixture(t, { complete: async () => { await gate; return writing; } });
  await answers(service, 10);
  const started = await service.call('note.daily.generate', { course: '数学' });
  await service.call('note.home', { home: 'https://blog.csdn.net/example' });
  await service.call('note.link', { id: started.id, url: 'https://blog.csdn.net/example/article/details/12345' });
  release();
  const note = await ready(service, started.id);
  assert.equal(note.markdown, writing);
  assert.equal(note.publicUrl, 'https://blog.csdn.net/example/article/details/12345');
});

test('exam selections count only after submission and automatically finalize the daily course summary', async t => {
  const service = await fixture(t, { complete: async () => writing });
  await answers(service, 9);
  await service.call('settings', { dailyRecap: { automatic: true } });
  const run = await service.call('review.start', { mode: 'exam', scope: [{ deckId: 'd', cardId: 'd-9' }], count: 1 });
  await service.call('review.answer', { runId: run.id, cardId: 'd-9', selected: ['a'] });
  assert.equal((await service.call('note.daily.status', { runId: run.id })).groups[0].answeredCount, 9);
  assert.equal((await service.call('note.list')).notes.length, 0);
  await service.call('exam.submit', { runId: run.id });
  const status = await service.call('note.daily.status', { runId: run.id });
  assert.equal(status.groups[0].answeredCount, 10);
  assert.equal((await ready(service, status.groups[0].noteId)).daily.final, true);
});

test('submitted nonblank oral answers count before assessment without inventing errors', async t => {
  let prompt;
  const service = await fixture(t, { complete: async (system, input) => {
    if (!system.startsWith('DAILY_COURSE_RECAP:')) throw new Error('assessment unavailable');
    prompt = JSON.parse(input); return writing;
  } });
  await service.call('settings', { dailyRecap: { automatic: true } });
  let run = await service.call('oral.start', { count: 10, scope: [{ deckId: 'd' }] });
  for (let i = 0; i < 10; i++) {
    await service.call('oral.answer', { runId: run.id, cardId: run.entry.cardId, answer: `我给出的回答 ${i}` });
    if (i < 9) run = await service.call('oral.next', { runId: run.id });
  }
  assert.equal((await service.call('note.daily.status', { runId: run.id })).groups[0].answeredCount, 0);
  await service.call('oral.submit', { runId: run.id });
  const status = await service.call('note.daily.status', { runId: run.id });
  await ready(service, status.groups[0].noteId);
  assert.equal(prompt.answeredCount, 10);
  assert.equal(prompt.wrongCount, 0);
  assert.equal(prompt.unassessedCount, 10);
  assert.ok(prompt.questions.every(question => question.attempts[0].assessment === 'unassessed' && question.attempts[0].grade === null));
});

test('completion polishes a checkpoint even when no additional question was answered', async t => {
  let calls = 0;
  const service = await fixture(t, { complete: async () => { calls++; return writing; } });
  await answers(service, 10);
  await service.call('settings', { dailyRecap: { automatic: true } });
  await service.call('note.daily.advance', { course: '数学' });
  const group = (await service.call('note.daily.status', { course: '数学' })).groups[0];
  await ready(service, group.noteId);
  assert.equal(calls, 1);
  await service.call('note.daily.advance', { course: '数学', final: true });
  assert.equal((await ready(service, group.noteId)).daily.final, true);
  assert.equal(calls, 2);
});

test('rubric feedback refreshes an already summarized submitted answer without counting it again', async t => {
  const model = createFakeModel();
  let prompt;
  const service = await fixture(t, { complete: async (system, input, options) => {
    if (system.startsWith('DAILY_COURSE_RECAP:')) { prompt = JSON.parse(input); return writing; }
    return model(system, input, options);
  } });
  await answers(service, 9);
  const timestamp = new Date().toISOString();
  await service.store.update(state => {
    const card = state.decks[0].cards[9];
    Object.assign(card, { kind: 'open', marks: 2, rubricCriteria: [{ id: 'reasoning', label: '推理', marks: 2,
      descriptor: '解释推理与适用条件', keyPoints: ['核对条件'] }] });
    state.runs.push({ id: 'submitted-open', deckId: 'd', mode: 'exam', submittedAt: timestamp, closedAt: timestamp,
      index: 0, entries: [{ deckId: 'd', card: structuredClone(card), response: '先核对条件，再解释推理。' }] });
  });
  await service.call('settings', { dailyRecap: { automatic: true } });
  await service.call('note.daily.advance', { runId: 'submitted-open', final: true });
  const first = (await service.call('note.daily.status', { runId: 'submitted-open' })).groups[0];
  await ready(service, first.noteId);
  assert.equal(prompt.unassessedCount, 1);
  await service.call('card.grade', { deckId: 'd', cardId: 'd-9', runId: 'submitted-open', answer: '先核对条件，再解释推理。' });
  await ready(service, first.noteId);
  assert.equal(prompt.answeredCount, 10);
  assert.equal(prompt.unassessedCount, 0);
  assert.equal(prompt.questions.find(question => question.cardId === 'd-9').attempts.length, 1);
  assert.equal(prompt.questions.find(question => question.cardId === 'd-9').attempts[0].learnerAnswer, '先核对条件，再解释推理。');
});
