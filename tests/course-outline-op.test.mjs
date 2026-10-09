/* `course.outline` through the real runtime: registered, read-only, answered from the committed library, documented for agents, never in the
   snapshot; a pick is a scope review.start takes as it is, and a run of a row's questions is offered to go on. No model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { libraryContracts, studyToolDescription } from '../lib/study-contracts.js';
import { courseOutline } from '../lib/course-outline.js';

const at = '2026-10-01T08:00:00.000Z';
const fact = (topic, i) => `${topic} fact ${i}: the scheduler keeps each review on its interval.`;
const text = topic => Array.from({ length: 6 }, (_, i) => fact(topic, i)).join(' ');
const card = (id, sourceId, quote) => ({ id, kind: 'flashcard', topic: 'T', prompt: `Question ${id}?`, answer: 'A', citations: sourceId ? [{ sourceId, quote }] : [] });

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-course-outline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.store.update(state => {
    state.sources.push({ id: 's-a', title: 'Lecture A', text: text('Alpha'), courses: ['Memory'], createdAt: at },
      { id: 's-b', title: 'Lecture B', text: text('Beta'), courses: ['Memory'], createdAt: at });
    state.decks.push({ id: 'm1', title: 'Memory 1', course: 'Memory', cards: [card('a1', 's-a', fact('Alpha', 1)), card('a2', 's-a', fact('Alpha', 2)), card('b1', 's-b', fact('Beta', 1)), card('u1')] });
    state.focus = { mode: 'class', course: 'Memory', role: '', jd: '', targetTopics: [] };
  });
  return service;
}

test('course.outline answers the current course from the library, with the rows, the questions of opened rows and 未归位', async t => {
  const service = await setup(t);
  const outline = await service.call('course.outline');
  assert.equal(outline.status, 'ok');
  assert.equal(outline.course, 'Memory');
  assert.deepEqual(outline.documents.map(document => [document.title, document.total]), [['Lecture A', 2], ['Lecture B', 1]]);
  assert.deepEqual([outline.total, outline.placed, outline.unplaced.total], [4, 3, 1]);
  const opened = await service.call('course.outline', { expand: [outline.documents[0].key, outline.unplaced.key] });
  assert.deepEqual(opened.open[outline.documents[0].key].cards.map(ref => ref.cardId), ['a1', 'a2']);
  assert.deepEqual(opened.open[outline.unplaced.key].cards.map(ref => [ref.cardId, ref.reason]), [['u1', 'none']]);
  const snapshot = await service.call('snapshot');
  assert.equal(JSON.stringify(snapshot).includes('"unplaced"'), false, 'the outline is read on demand, never carried by the snapshot');
});

test('a pick starts a practice round of exactly those questions; the row then offers to go on with it', async t => {
  const service = await setup(t);
  const outline = await service.call('course.outline');
  const { practice } = await service.call('course.outline', { pick: { keys: [outline.documents[0].key], cards: [{ deckId: 'm1', cardId: 'a1' }, { deckId: 'm1', cardId: 'b1' }] } });
  assert.deepEqual(practice.scope.map(ref => ref.cardId).sort(), ['a1', 'a2', 'b1']);
  const run = await service.call('review.start', { mode: 'path', scope: practice.scope, fresh: true });
  assert.deepEqual(run.navigation.map(entry => entry.cardId).sort(), ['a1', 'a2', 'b1']);
  const row = await service.call('course.outline', { pick: { keys: [outline.documents[0].key] } });
  await service.call('review.start', { mode: 'path', scope: row.practice.scope, fresh: true });
  const again = await service.call('course.outline');
  assert.equal(again.documents[0].resume?.total, 2, 'Lecture A has an unfinished round of exactly its questions');
  assert.equal(again.documents[1].resume, undefined);
  const resumed = await service.call('review.start', { mode: 'path', scope: row.practice.scope });
  assert.equal(resumed.id, again.documents[0].resume.runId, 'fresh:false goes on with that round');
});

test('agents are told about it in the learning contract and the discovery list', () => {
  assert.match(libraryContracts.learning, /course\.outline \{course\?,deckId\?,expand\?/);
  assert.match(studyToolDescription, /course\.route, course\.outline/);
});

test('a library of 200 materials and 3000 questions is placed without stalling (the time is reported), and the second read is cached', t => {
  const sources = Array.from({ length: 200 }, (_, i) => ({ id: `src-${i}`, title: `Material ${i}`, text: Array.from({ length: 40 }, (_, j) => `Material ${i} point ${j}: a statement long enough to quote from.`).join(' '),
    courses: ['Big'], createdAt: at, ...(i % 4 === 0 ? { document: { materialId: `document-${i}`, format: 'md' } } : {}) }));
  const decks = Array.from({ length: 30 }, (_, d) => ({ id: `deck-${d}`, title: `Deck ${d}`, course: 'Big', cards: Array.from({ length: 100 }, (_, c) => {
    const n = d * 100 + c, i = n % 200, j = n % 40;
    // One in five quotes is written a little differently, so the fuzzy locator works too.
    const quote = `Material ${i} point ${j}: a statement long enough to quote from.`;
    return card(`c${n}`, `src-${i}`, n % 5 === 0 ? quote.replace(/ /g, '  ').replace(':', ' -') : quote);
  }) }));
  const state = Object.freeze({ revision: 7, sources: Object.freeze(sources), documents: Object.freeze([]), decks: Object.freeze(decks), drafts: Object.freeze([]),
    attempts: Object.freeze([]), runs: Object.freeze([]), courses: Object.freeze([]), focus: { course: 'Big' } });
  const started = performance.now();
  const outline = courseOutline(state, { course: 'Big' }, { root: 'perf' });
  const first = performance.now() - started;
  const again = performance.now();
  courseOutline(state, { course: 'Big', expand: [outline.documents[0].key] }, { root: 'perf' });
  const second = performance.now() - again;
  const picked = performance.now();
  const { practice } = courseOutline(state, { course: 'Big', pick: { keys: outline.documents.map(document => document.key) } }, { root: 'perf' });
  const pick = performance.now() - picked;
  t.diagnostic(`200 materials, 3000 questions: first ${first.toFixed(0)} ms, cached ${second.toFixed(1)} ms, pick of all ${pick.toFixed(0)} ms`);
  assert.equal(outline.documents.length, 200);
  assert.equal(outline.total, 3000);
  assert.equal(outline.placed, 3000);
  assert.equal(practice.total, 3000);
  assert.equal(practice.scope.length, 200);
  assert.ok(first < 10000, `${first} ms: not slow, stuck`);
  assert.ok(second < first, 'the second read does not place the questions again');
});
