/* The learning loop under a question (#1015, #1016), on the library with a fake model and no network:
   - 试一道同类题: review.similar finds a similar existing question with the wrong book's finder (lib/recommend.js recommendSimilar, one copy) and never one of
     this round; the question is practised as a detour run (returnTo) that remembers which question it was for (similarFor); answering it is an ordinary
     attempt of THAT card and never credits the original; the original round's result and the wrong book say 答错 → 讲解 → 同类题答对 from the runs.
   - 用自己的话讲一遍: teach.retell (a question) and book.retell (a 复习全书 point) make one model call each and keep only an aggregate (tries, passes, the
     last gap tag, time): the learner's words are never stored. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { recommendSimilar, similarWins } from '../lib/recommend.js';
import { retellRecord, RETELL_GAPS } from '../lib/teaching.js';
import { completeJson } from '../lib/generation.js';
import { assistantRefusal } from '../lib/assistant-boundary.js';
import { capabilityIndex, filterCapabilities } from '../lib/runtime/tools.js';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';
import { courseOutlineMaterial, materialsFingerprint } from '../lib/course-outline-book.js';
import { courseNotesMaterial } from '../lib/course-book.js';
import { buildOutlineIndex } from '../lib/course-outline-index.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';

const card = (id, topic, prompt) => ({ id, kind: 'flashcard', topic, objective: 'o', prompt, answer: 'An answer.', hint: 'h', explanation: 'e', misconception: 'm', citations: [] });
const deck = () => ({ id: 'd', title: 'Breakers', course: 'SRE', cards: [
  card('orig', '熔断器', '熔断器在半开状态下会做什么？'),
  card('twin', '熔断器', '熔断器什么时候从打开转为半开？'),
  card('far', '日志', '结构化日志有什么好处？'),
] });

async function library(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-learning-loop-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const study = new StudyService(root);
  await study.call('snapshot');
  await study.store.update((state) => { state.decks.push(deck()); });
  return study;
}
/** A round over `cardIds`, the first answered with `grade`. */
async function answered(study, cardIds, grade, extra = {}) {
  const run = await study.call('review.start', { mode: 'path', scope: cardIds.map((cardId) => ({ deckId: 'd', cardId })), fresh: true, ordered: true, ...extra });
  const cardId = run.card.id;
  await study.call('review.reveal', { runId: run.id, cardId });
  return { run: await study.call('review.answer', { runId: run.id, cardId, grade }), cardId };
}

test('the finder leaves out the questions it is told to (the round), so one shared finder serves the wrong book and practice', () => {
  const state = { sources: [], decks: [deck()], attempts: [], runs: [] };
  const mistakes = [{ deckId: 'd', cardId: 'orig' }];
  assert.deepEqual(recommendSimilar(state, { mistakes }).items.map((item) => item.cardId), ['twin']);
  assert.deepEqual(recommendSimilar(state, { mistakes, exclude: [{ deckId: 'd', cardId: 'twin' }] }).items, []);
});

test('review.similar: a similar question of the course that is not in this round, or none', async (t) => {
  const study = await library(t);
  const { run } = await answered(study, ['orig'], 1);
  const found = await study.call('review.similar', { runId: run.id, cardId: 'orig' });
  assert.equal(found.item.cardId, 'twin');
  assert.equal(found.item.deckId, 'd');
  const both = await answered(study, ['orig', 'twin'], 1);
  assert.equal((await study.call('review.similar', { runId: both.run.id, cardId: both.cardId })).item, null, 'a question of this round is never offered');
  await assert.rejects(study.call('review.similar', { runId: run.id, cardId: 'far' }), /not in this round/i, 'only a question of the round has a similar one');
});

test('a question that builds on the original (or on a question of the round) is no similar question, and a detour holds exactly what it was given', async (t) => {
  const study = await library(t);
  // twin builds on orig: it is no similar question (a round of it would pull orig back in, a right answer would credit orig).
  await study.store.update((state) => { state.decks[0].cards.find((c) => c.id === 'twin').requires = [{ deckId: 'd', cardId: 'orig' }]; });
  const { run } = await answered(study, ['orig', 'far'], 1);
  assert.equal((await study.call('review.similar', { runId: run.id, cardId: 'orig' })).item, null, 'twin requires the original');
  // twin2 builds on far, a question of the round, through mid: two steps, the reach of creditPrerequisites.
  await study.store.update((state) => {
    const cards = state.decks[0].cards;
    cards.push({ ...card('twin2', '熔断器', '熔断器关闭后什么时候会再次打开？'), requires: [{ deckId: 'd', cardId: 'mid' }] });
    cards.push({ ...card('mid', '日志', '日志级别怎么选？'), requires: [{ deckId: 'd', cardId: 'far' }] });
  });
  assert.equal((await study.call('review.similar', { runId: run.id, cardId: 'orig' })).item, null, 'twin2 reaches a question of the round');
  await study.store.update((state) => { state.decks[0].cards.push(card('plain', '熔断器', '熔断器为什么要有半开状态？')); });
  assert.equal((await study.call('review.similar', { runId: run.id, cardId: 'orig' })).item?.cardId, 'plain', 'a question that builds on neither is offered');
  // Even a detour over a question that requires the (unlearned) original asks only that question: no prerequisite is pulled in, nothing credited.
  const detour = await study.call('review.start', { mode: 'path', scope: [{ deckId: 'd', cardId: 'twin' }], fresh: true, returnTo: run.id, similarFor: { deckId: 'd', cardId: 'orig' } });
  assert.deepEqual([detour.card.id, detour.total], ['twin', 1]);
  await study.call('review.reveal', { runId: detour.id, cardId: 'twin' });
  await study.call('review.answer', { runId: detour.id, cardId: 'twin', grade: 4 });
  const state = await study.call('export');
  assert.deepEqual(state.attempts.filter((a) => a.quiz_id === 'orig').map((a) => [a.grade, !!a.implicit]), [[1, false]], 'the original is not credited');
  // A prerequisite round (returnTo without similarFor) still pulls unlearned prerequisites in, as before.
  const prerequisite = await study.call('review.start', { mode: 'path', scope: [{ deckId: 'd', cardId: 'twin2' }], fresh: true, returnTo: run.id });
  assert.ok(prerequisite.total > 1, 'an ordinary detour keeps its prerequisites');
});

test('the similar question is a detour of its own: an ordinary attempt for that card, no credit for the original, the round untouched', async (t) => {
  const study = await library(t);
  const { run: original } = await answered(study, ['orig', 'far'], 1);
  const before = await study.call('review.get', { runId: original.id });
  const detour = await study.call('review.start', { mode: 'path', scope: [{ deckId: 'd', cardId: 'twin' }], fresh: true, returnTo: original.id,
    similarFor: { deckId: 'd', cardId: 'orig' } });
  assert.notEqual(detour.id, original.id);
  await study.call('review.reveal', { runId: detour.id, cardId: 'twin' });
  await study.call('review.answer', { runId: detour.id, cardId: 'twin', grade: 4 });
  const state = await study.call('export');
  assert.deepEqual(state.attempts.filter((a) => a.quiz_id === 'twin').map((a) => [a.grade, !!a.implicit]), [[4, false]], 'one ordinary attempt for the similar card');
  assert.deepEqual(state.attempts.filter((a) => a.quiz_id === 'orig').map((a) => [a.grade, !!a.implicit]), [[1, false]], 'the original keeps only its own answer');
  const after = await study.call('review.get', { runId: original.id });
  assert.deepEqual([after.index, after.questions, after.answered, after.total], [before.index, before.questions, before.answered, before.total], 'the detour adds nothing to the round');
  assert.equal(state.runs.find((r) => r.id === detour.id).similarFor.cardId, 'orig');
});

test('答错 → 讲解 → 同类题答对 is told from the runs: the round result and the wrong book row', async (t) => {
  const study = await library(t);
  const { run: original } = await answered(study, ['orig'], 1);
  const detour = await study.call('review.start', { mode: 'path', scope: [{ deckId: 'd', cardId: 'twin' }], fresh: true, returnTo: original.id, similarFor: { deckId: 'd', cardId: 'orig' } });
  await study.call('review.reveal', { runId: detour.id, cardId: 'twin' });
  await study.call('review.answer', { runId: detour.id, cardId: 'twin', grade: 4 });
  // Back on the original round: on to its re-ask at the tail (#660), answered, and the round ends.
  let back = await study.call('review.move', { runId: original.id, direction: 1 });
  assert.equal(back.card.id, 'orig');
  await study.call('review.reveal', { runId: original.id, cardId: 'orig' });
  await study.call('review.answer', { runId: original.id, cardId: 'orig', grade: 3 });
  back = await study.call('review.move', { runId: original.id, direction: 1 });
  const result = await study.call('review.get', { runId: original.id });
  assert.equal(result.complete, true);
  assert.deepEqual(result.similarWins.map((win) => [win.cardId, win.topic]), [['orig', '熔断器']]);
  const book = await study.call('wrongbook', {});
  assert.equal(book.items.find((item) => item.cardId === 'orig').similarWin, true);
  // A similar question answered wrong says nothing.
  const runs = [{ id: 'x', returnTo: 'o', similarFor: { deckId: 'd', cardId: 'orig' }, startedAt: '2026-11-01T00:00:00.000Z', entries: [{ card: { id: 'twin' }, feedback: { grade: 1 } }] }];
  assert.equal(similarWins(runs).size, 0);
});

test('a retell aggregate keeps counts, the last gap tag and the time, never words', () => {
  const at = '2026-11-13T08:00:00.000Z';
  const first = retellRecord(undefined, { passed: false, right: ['a'], missed: ['b'], wrong: [] }, at);
  assert.deepEqual(first, { tries: 1, passes: 0, gap: 'missed', at });
  const second = retellRecord(first, { passed: false, right: [], missed: ['b'], wrong: ['c'] }, at);
  assert.deepEqual(second, { tries: 2, passes: 0, gap: 'wrong', at });
  const third = retellRecord(second, { passed: true, right: ['a', 'b'], missed: [], wrong: [] }, at);
  assert.deepEqual(third, { tries: 3, passes: 1, gap: 'none', at });
  assert.deepEqual([...RETELL_GAPS].sort(), ['missed', 'none', 'wrong']);
});

const SECRET = 'MY_OWN_WORDS_SECRET_42';
const verdict = { passed: false, right: ['它会放少量请求试探下游'], missed: ['成功后会关闭熔断器'], wrong: [], cite: null };

test('teach.retell: one model call, the three parts back, only the aggregate on the card, and the words nowhere', async (t) => {
  const study = await library(t);
  await answered(study, ['orig'], 1);
  let calls = 0, sent = '';
  study.complete = async (system, prompt) => { calls += 1; sent = prompt; return JSON.stringify(verdict); };
  const answer = await study.call('teach.retell', { deckId: 'd', cardId: 'orig', text: SECRET, language: 'zh' });
  assert.equal(calls, 1);
  assert.ok(sent.includes(SECRET), 'the words go to the model');
  assert.deepEqual([answer.right, answer.missed, answer.wrong, answer.passed, answer.gap], [verdict.right, verdict.missed, [], false, 'missed']);
  const state = await study.call('export');
  const stored = state.decks[0].cards.find((c) => c.id === 'orig').retell;
  assert.deepEqual([stored.tries, stored.passes, stored.gap], [1, 0, 'missed']);
  assert.equal(JSON.stringify(state).includes(SECRET), false, 'the learner words are not stored');
  assert.equal(JSON.stringify(state).includes(verdict.missed[0]), false, 'nor what the model said about them');

  study.complete = async () => '{"passed":"yes"}';
  await assert.rejects(study.call('teach.retell', { deckId: 'd', cardId: 'orig', text: SECRET }), /retell/i);
  assert.equal((await study.call('export')).decks[0].cards.find((c) => c.id === 'orig').retell.tries, 1, 'a failed check stores nothing');
  // An unreadable reply is not asked again: one check stays one model call.
  calls = 0;
  study.complete = async () => { calls += 1; return 'not json at all'; };
  await assert.rejects(study.call('teach.retell', { deckId: 'd', cardId: 'orig', text: SECRET }), /retell/i);
  assert.equal(calls, 1, 'no second call for an unreadable reply');
  study.complete = async () => null;
  await assert.rejects(study.call('teach.retell', { deckId: 'd', cardId: 'orig', text: SECRET }), /Invalid retell feedback/, 'no text at all reads as unreadable, not a TypeError');
  study.complete = null;
  await assert.rejects(study.call('teach.retell', { deckId: 'd', cardId: 'orig', text: SECRET }), /model/i);
});

/** A course with an outline and a review book of two points (as tests/course-book-crunch.test.mjs builds it). */
async function bookLibrary(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-learning-loop-book-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const study = new StudyService(root);
  await study.call('snapshot');
  const { sources, decks } = outlineLibrary();
  const state = { sources, decks, focus: { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] } };
  const lecture = groupSourcesByDocument(sources).find(item => item.sourceIds.includes('document-l1-p1')).key;
  const outline = { ...courseOutlineMaterial({ title: '总纲 · SA', course: COURSE, orderBasis: { codes: ['numbering'] }, fingerprint: materialsFingerprint(buildOutlineIndex({ ...state, documents: [], drafts: [], attempts: [] }, { course: COURSE }).allDocuments),
    nodes: [{ id: 'c1', title: 'Introduction', children: [{ id: 'what', title: 'What architects do', anchors: [`${lecture}#0`] }, { id: 'who', title: 'Stakeholders', anchors: [`${lecture}#1`] }] }],
    other: { anchors: [] }, counts: { units: 2, leftover: 0, invalid: 0, repeated: 0 } }), createdAt: '2026-10-09T00:00:00.000Z' };
  sources.push(outline);
  const page = sources.find(source => source.id === 'document-l1-p1'), leaves = outline.courseOutline.nodes[0].children;
  sources.push({ ...courseNotesMaterial({ title: '复习全书 · SA', course: COURSE, outlineId: outline.id, language: 'zh', papers: [], counts: {}, leaves: leaves.map(leaf => ({ id: leaf.id, title: leaf.title, anchors: leaf.anchors,
    body: { fingerprint: 'f'.repeat(16), points: [`${leaf.title} [^1].`], explain: `About ${leaf.title}.`, cites: [{ n: 1, sourceId: page.id, quote: page.text.slice(0, 30), start: 0, end: 30 }] } })) }),
    createdAt: '2026-10-09T01:00:00.000Z' });
  await study.store.update(own => { own.sources.push(...state.sources); own.decks.push(...state.decks); own.focus = state.focus; });
  const opened = await study.call('course.book.open');
  return { study, what: opened.nodes[0].children[0] };
}

test('book.retell: one model call on the point, 讲清楚过 on the point once passed, the words nowhere', async (t) => {
  const { study, what } = await bookLibrary(t);
  assert.equal(what.retold, undefined);
  let calls = 0, sent = '';
  study.complete = async (system, prompt) => { calls += 1; sent = prompt; return JSON.stringify({ ...verdict, passed: true, missed: [] }); };
  const answer = await study.call('book.retell', { hid: what.hid, text: SECRET, language: 'zh' });
  assert.equal(calls, 1);
  assert.ok(sent.includes('About What architects do'), 'the point text is the material');
  assert.equal(answer.passed, true);
  assert.equal(answer.gap, 'none');
  const reopened = (await study.call('course.book.open')).nodes[0].children[0];
  assert.deepEqual([reopened.retold.tries, reopened.retold.passes, reopened.retold.gap], [1, 1, 'none']);
  const state = await study.call('export');
  assert.equal(JSON.stringify(state).includes(SECRET), false, 'the learner words are not stored');
  await assert.rejects(study.call('book.retell', { hid: 'h-none', text: SECRET }), /point/i);
});

test('the panel keeps the loop: the main chat is refused review.similar, teach.retell and book.retell and sees them in no listing', () => {
  for (const action of ['review.similar', 'teach.retell', 'book.retell']) assert.match(assistantRefusal(action) || '', /not available to the assistant/, action);
  assert.match(assistantRefusal('teach.retell'), /grade|mastery/i, 'a retell aggregate is learner performance');
  assert.equal(assistantRefusal('wrongbook.recommend'), null, 'the main chat finds similar questions with wrongbook.recommend');
  const study = { id: 'study', api: 'study.v1', operations: ['review.get', 'review.similar', 'teach.answer', 'teach.retell'].map((name) => ({ name, available: true })) };
  const library = { id: 'library', api: 'library.v1', operations: ['book.read', 'book.retell'].map((name) => ({ name, available: true })) };
  const index = JSON.stringify(capabilityIndex([study, library]));
  assert.doesNotMatch(index, /similar|retell/, 'not in the index');
  const listed = JSON.stringify(filterCapabilities([study, library], {}));
  assert.doesNotMatch(listed, /similar|retell/, 'not in a context listing');
  assert.match(listed, /teach\.answer/);
});

test('completeJson can make exactly one call: an unreadable reply is an error, not a second call', async () => {
  let calls = 0;
  const complete = async () => { calls += 1; return 'nope'; };
  await assert.rejects(completeJson(complete, 's', 'p', { retry: false }));
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(completeJson(complete, 's', 'p'));
  assert.equal(calls, 2, 'the default still asks once more');
});

test('teach.retell gives the model the citations it may point at (index and quote), and 去原文看这段 points at one of them', async (t) => {
  const study = await library(t);
  await study.store.update((state) => {
    state.sources.push({ id: 'src', title: 'Notes', text: 'A breaker opens after failures and lets trial calls through when half-open.' });
    state.decks[0].cards.find((c) => c.id === 'orig').citations = [{ sourceId: 'src', quote: 'lets trial calls through when half-open' }];
  });
  await answered(study, ['orig'], 1);
  let sent;
  study.complete = async (system, prompt) => { sent = JSON.parse(prompt); return JSON.stringify({ ...verdict, cite: 0 }); };
  const answer = await study.call('teach.retell', { deckId: 'd', cardId: 'orig', text: SECRET });
  assert.deepEqual(sent.material.citations, [{ index: 0, quote: 'lets trial calls through when half-open' }]);
  assert.equal(answer.cite, 0);
});

test('the retell aggregate follows the review: kept through a published edit of other questions, gone when the question itself changed', async (t) => {
  const study = await library(t);
  // card.update checks the deck: each question its own objective and a citation.
  await study.store.update((state) => {
    state.sources.push({ id: 'src', title: 'Notes', text: 'A breaker opens after failures and lets trial calls through when half-open.' });
    for (const c of state.decks[0].cards) Object.assign(c, { objective: `Objective of ${c.id}`, citations: [{ sourceId: 'src', quote: 'A breaker opens after failures' }], addedAt: '2026-11-01T00:00:00.000Z' });
  });
  const { run } = await answered(study, ['orig'], 1);
  await study.call('review.end', { runId: run.id });
  study.complete = async () => JSON.stringify(verdict);
  const editing = await study.call('deck.edit', { id: 'd' });
  await study.call('teach.retell', { deckId: 'd', cardId: 'orig', text: SECRET });
  await study.call('teach.retell', { deckId: 'd', cardId: 'twin', text: SECRET });
  // The edit draft was opened before the checks; publishing it changes only `far` and must not roll the aggregates back.
  const draft = await study.call('draft.get', { id: editing.id });
  draft.cards.find((c) => c.id === 'far').answer = 'Structured logs can be queried.';
  const saved = await study.call('draft.save', { deck: draft });
  await study.call('draft.publish.quick', { id: saved.id, draftVersion: saved.draftVersion });
  let cards = (await study.call('export')).decks.find((d) => d.id === 'd').cards;
  assert.equal(cards.find((c) => c.id === 'far').answer, 'Structured logs can be queried.', 'the edit is published');
  assert.equal(cards.find((c) => c.id === 'orig').review.reps, 1, 'the unchanged question keeps its review');
  assert.equal(cards.find((c) => c.id === 'orig').retell?.tries, 1, 'kept through the publish');
  assert.equal(cards.find((c) => c.id === 'twin').retell?.tries, 1, 'kept through the publish');
  // A substantive change of the question resets its review, and its retell with it.
  await study.call('card.update', { deckId: 'd', cardId: 'twin', patch: { answer: 'Another answer altogether.' }, reason: 'test', quiet: true });
  cards = (await study.call('export')).decks.find((d) => d.id === 'd').cards;
  assert.equal(cards.find((c) => c.id === 'twin').retell, undefined, 'reset with the review');
  assert.equal(cards.find((c) => c.id === 'orig').retell?.tries, 1);
});
