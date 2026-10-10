/* 复习全书 M5 · 分析题答案卡 as ONE visible Job of the unified runtime (`case-answer-card`) with a fake model: the write, the program's checks, the
   independent review (2 calls), one repair when needed (3 calls); the card is saved beside the question, the question's answer, schedule and history are
   never touched; a stop saves nothing; a question changed while the card was written is refused at the save; refusals cost nothing; the card comes with
   the reveal like the reference answer, never in an open exam. No real model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StudyService } from '../lib/service.js';
import { settleJob, until } from './helpers/wait.mjs';
import { gate, privateRoot } from './helpers/model-family-baseline.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { caseCard, caseLibrary, cardModel, goodCard } from './helpers/answer-card-library.mjs';
import { answerCardBasis, renderAnswerCard } from '../lib/answer-card.js';
import { featureOf } from '../lib/model-usage.js';

const KIND = 'case-answer-card';

async function world(t, fake = cardModel(), { cards } = {}) {
  const root = await privateRoot(t, 'answer-card-');
  const service = new StudyService(root, { complete: fake.complete, ...switchOptions('runtime', { complete: fake.complete, paths: [] }) });
  t.after(() => service.dispose());
  const { sources, deck } = caseLibrary();
  if (cards) deck.cards.push(...cards);
  await service.store.update(state => { state.sources.push(...sources); state.decks.push(deck); });
  const build = args => service.call('generation.answerCard.build', { deckId: 'case1', cardId: 'q1', language: 'zh', ...args });
  const finish = async args => { const started = await build(args); return { started, job: await settleJob(service, started.jobId) }; };
  const live = async () => (await service.store.read()).decks.find(item => item.id === 'case1').cards.find(item => item.id === 'q1');
  return { service, fake, build, finish, live, jobs: () => [...service.runtime.work.jobs.values()].filter(job => job.type === KIND) };
}

test('2 calls: write, the program\'s checks, one clean review; the card is saved beside the question, its answer and SM-2 schedule untouched', async t => {
  const w = await world(t);
  const before = await w.live();
  const { started, job } = await w.finish();
  assert.equal(job.status, 'complete', JSON.stringify(w.jobs().at(-1)?.contract?.error ?? null));
  assert.deepEqual(w.fake.calls.map(call => call.kind), ['write', 'review'], 'two model calls');
  assert.deepEqual([started.deckId, started.cardId], ['case1', 'q1']);
  const write = w.fake.calls[0].data;
  assert.equal(write.question.prompt, before.prompt);
  assert.deepEqual(write.question.rubric.flatMap(criterion => criterion.keyPoints.map(point => point.id)), ['c1.k1', 'c1.k2', 'c2.k1']);
  assert.equal(write.likelyType, 'availability');
  assert.ok(write.questionTypes.some(type => type.id === 'risk') && write.materials[0].ref === 'M1', 'the catalogue and the deck\'s own materials');
  assert.match(w.fake.calls[0].system, /Write in English/, 'the card is written in the deck\'s language');
  assert.match(w.fake.calls[1].system, /^You independently review an answer card/);
  const card = await w.live();
  assert.equal(card.answer, before.answer, 'the answer of an existing card is never changed');
  assert.deepEqual(card.review, before.review, 'SM-2 is not reset');
  assert.deepEqual(card.revisions, before.revisions);
  const answerCard = card.answerCard;
  assert.equal(answerCard.status, 'verified');
  assert.equal(answerCard.basis, answerCardBasis(card));
  assert.deepEqual(answerCard.questionType, { id: 'availability', label: 'Availability' });
  assert.equal(answerCard.concepts[0].quote, 'Availability is the proportion of time a system is able to perform its required function');
  assert.deepEqual(answerCard.checks.review, { ran: true, issues: [], repaired: false });
  assert.match(renderAnswerCard(answerCard), /checked ≠ correct/);
  const contract = w.jobs().at(-1).contract;
  assert.equal(contract.title, '答题卡 · 第 1 题 · Does the booking service meet its availa');
  assert.deepEqual([contract.detail.status, contract.detail.calls], ['verified', 2]);
  assert.equal(contract.progress.done, contract.progress.total);
  assert.equal(featureOf('generation', 'answerCard.build'), 'case');
});

test('3 calls: a quote that is not in the case and a review finding go to one repair; the repaired card is checked again', async t => {
  const first = { ...goodCard(), facts: [{ text: 'Bookings stop when a server fails', quote: 'Every failure stops all bookings for a day.' }] };
  const w = await world(t, cardModel({ write: n => (n === 1 ? first : goodCard()), review: () => [{ kind: 'missingCost', where: 'justification.cost', text: 'The cost is vague.' }] }));
  const { job } = await w.finish();
  assert.equal(job.status, 'complete');
  assert.deepEqual(w.fake.calls.map(call => call.kind), ['write', 'review', 'repair'], 'three model calls');
  const repair = w.fake.calls[2].prompt.slice(w.fake.calls[2].prompt.indexOf('REPAIR:'));
  assert.match(repair, /facts\[0\]: the quote is not word for word in the stem or the case \(missing\)/);
  assert.match(repair, /review missingCost at justification\.cost: The cost is vague\./);
  const card = (await w.live()).answerCard;
  assert.deepEqual([card.status, card.checks.review.repaired, card.facts.every(item => item.verified)], ['verified', true, true]);
  assert.equal(w.jobs().at(-1).contract.detail.calls, 3);
});

test('a repair that still leaves a quote unfound saves the card as 部分未核对, the quote marked 未核实; an unreadable review is no 已核对', async t => {
  const bad = { ...goodCard(), concepts: [{ name: 'Availability', ref: 'M1', definition: 'Availability … required function' }] };
  const w = await world(t, cardModel({ write: () => bad }));
  await w.finish();
  const card = (await w.live()).answerCard;
  assert.equal(card.status, 'partial');
  assert.deepEqual([card.concepts[0].verified, card.concepts[0].reason], [false, 'ellipsis']);
  assert.match(renderAnswerCard(card, 'zh'), /（未核实）/);
  const noReview = await world(t, { ...cardModel(), complete: async (system, prompt) => (system.startsWith('You independently review') ? 'not json' : JSON.stringify(goodCard())), calls: [] });
  await noReview.finish();
  const unreviewed = (await noReview.live()).answerCard;
  assert.deepEqual([unreviewed.status, unreviewed.checks.review.ran], ['partial', false]);
});

test('refusals cost nothing: no case question, an open exam, a card that has one; `again` writes it anew; a provider failure (asked twice) saves nothing, a retry saves once', async t => {
  const flashcard = { ...caseCard({ id: 'f1', kind: 'flashcard', prompt: 'What is MTTR?', objective: 'Define MTTR' }) };
  delete flashcard.rubricCriteria;
  const w = await world(t, cardModel({ fail: n => n <= 2 }), { cards: [flashcard] });
  const refused = (promise, code) => assert.rejects(promise, error => { assert.equal(error.code, code, error.message); return true; });
  await refused(w.build({ cardId: 'nope' }), 'answer-card-no-card');
  await refused(w.build({ cardId: 'f1' }), 'answer-card-not-case');
  const exam = await w.service.call('review.start', { mode: 'exam', examKinds: 'case', scope: [{ deckId: 'case1' }], fresh: true });
  await refused(w.build(), 'answer-card-in-exam');
  assert.equal((await w.service.call('review.get', { runId: exam.id })).card.answerCard, undefined);
  await w.service.call('exam.submit', { runId: exam.id });
  assert.equal(w.fake.calls.length, 0, 'no model call');
  const failed = await w.build();
  assert.equal((await settleJob(w.service, failed.jobId)).status, 'failed');
  assert.equal((await w.live()).answerCard, undefined, 'nothing saved');
  await w.service.call('job.control', { jobId: failed.jobId, action: 'retry' });
  assert.equal((await settleJob(w.service, failed.jobId)).status, 'complete');
  assert.equal((await w.live()).answerCard.status, 'verified');
  await refused(w.build(), 'answer-card-exists');
  const again = await w.build({ again: true });
  assert.equal((await settleJob(w.service, again.jobId)).status, 'complete');
});

test('a stop saves nothing; a question changed while its card was written is refused at the save', async t => {
  const held = { at: 1, gate: gate() };
  t.after(() => held.gate.release());
  const s = await world(t, cardModel({ held }));
  const run = await s.build();
  await until(() => s.fake.calls.length === 1, 'the write');
  await s.service.call('job.control', { jobId: run.jobId, action: 'cancel' });
  held.gate.release();
  assert.equal((await settleJob(s.service, run.jobId)).status, 'cancelled');
  assert.equal((await s.live()).answerCard, undefined, 'a stop saves nothing');
  const stale = { at: 2, gate: gate() };
  t.after(() => stale.gate.release());
  const w = await world(t, cardModel({ held: stale }));
  const started = await w.build();
  await until(() => w.fake.calls.length === 2, 'the review');
  await w.service.call('card.update', { deckId: 'case1', cardId: 'q1', patch: { prompt: 'Does the booking service meet its availability target in winter? Show the calculation.' }, reason: 'reworded' });
  stale.gate.release();
  const job = await settleJob(w.service, started.jobId);
  assert.equal(job.status, 'failed');
  assert.match(w.jobs().at(-1).contract.error.message, /写的时候这道题被改过了/);
  assert.equal((await w.live()).answerCard, undefined);
});

test('the card comes with the reveal like the reference answer: an open review run picks it up, its feedback kept; 被改过 after the question is edited', async t => {
  const w = await world(t);
  const run = await w.service.call('review.start', { mode: 'path', scope: [{ deckId: 'case1', cardId: 'q1' }], fresh: true });
  assert.equal(run.card.answerCard, undefined, 'not on the open question');
  await w.service.call('review.reveal', { runId: run.id, cardId: 'q1' });
  assert.equal((await w.service.call('review.get', { runId: run.id })).solution.answerCard, undefined);
  await w.finish();
  const after = await w.service.call('review.get', { runId: run.id });
  assert.equal(after.revealed, true, 'the reveal stands');
  assert.equal(after.solution.answerCard.state, 'verified');
  assert.equal(after.solution.answer, caseCard().answer);
  await w.service.call('card.update', { deckId: 'case1', cardId: 'q1', patch: { hint: 'Use MTBF and MTTR.' }, reason: 'hint' });
  assert.equal((await w.service.call('review.get', { runId: run.id })).solution.answerCard.state, 'verified', 'a hint is not what the card was made for');
  await w.service.call('card.update', { deckId: 'case1', cardId: 'q1', patch: { answer: 'Yes, by a wide margin.' }, reason: 'answer' });
  const edited = await w.live();
  assert.ok(edited.answerCard, 'an edit keeps the card');
  const fresh = await w.service.call('review.start', { mode: 'path', scope: [{ deckId: 'case1', cardId: 'q1' }], fresh: true });
  await w.service.call('review.reveal', { runId: fresh.id, cardId: 'q1' });
  assert.equal((await w.service.call('review.get', { runId: fresh.id })).solution.answerCard.state, 'edited');
  const exam = await w.service.call('review.start', { mode: 'exam', examKinds: 'case', scope: [{ deckId: 'case1' }], fresh: true });
  assert.equal(JSON.stringify(exam).includes('"answerCard"'), false, 'an exam never shows it');
  await assert.rejects(w.service.call('review.reveal', { runId: exam.id, cardId: 'q1' }));
});

test('a course adds its own question type through course.save { caseTypes }; the write call is shown it; a bad list is refused', async t => {
  const w = await world(t);
  await assert.rejects(w.service.call('course.save', { name: 'SWE5001', caseTypes: [{ id: 'Bad id', label: 'x', steps: ['y'] }] }), /unique id/);
  await w.service.call('course.save', { name: 'SWE5001', caseTypes: [{ id: 'queueing', label: '排队论', signals: ['排队'], steps: ['写出到达率和服务率', '算利用率'] }] });
  assert.deepEqual((await w.service.call('course.profile', { name: 'SWE5001' })).caseTypes.map(type => type.id), ['queueing']);
  await w.finish();
  assert.deepEqual(w.fake.calls[0].data.questionTypes.map(type => type.id).slice(-2), ['queueing', 'general']);
  await w.service.call('course.save', { name: 'SWE5001', caseTypes: [] });
  assert.equal((await w.service.call('course.profile', { name: 'SWE5001' })).caseTypes, undefined, 'an empty list takes them away');
});
