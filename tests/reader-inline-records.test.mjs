/* #1013: a question answered in the reader's 本节题目 panel leaves exactly the records the practice page leaves for it. The panel starts an ordinary review
   run with the arguments of 做这几页的题 (ui/learning-navigation.js readingPracticeArgs) and answers through the same session (ui/review/useReviewSession.js,
   the same review.move / review.answer); here both paths run against two copies of one library, in the real runtime, at the same frozen time, and every
   record a learner sees is compared: the attempts, the review (FSRS-6) state of the cards, the wrong book, the stats and daily figures, the mastery the
   reader shows, and at the end of the round its result, its closing, the debrief and the day's recap. No model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { makeTextPdf, LECTURE_PAGES } from './helpers/text-pdf.mjs';
import { loadUi } from './helpers/ui-module.mjs';

const { practiceArgs, readingPracticeArgs } = await loadUi(`export { practiceArgs, readingPracticeArgs } from './ui/learning-navigation.js';`);

const NOW = Date.parse('2026-11-13T09:00:00.000Z');
const quote = 'An index is an extra data';
const question = (id, sourceId, extra = {}) => ({ id, kind: 'quiz', topic: 'Indexes', objective: `Objective ${id}`, prompt: `Question ${id}?`, answer: 'Right',
  options: [{ id: 'r', text: 'Right', correct: true, explanation: 'It is.' }, { id: 'w', text: 'Wrong', correct: false, explanation: 'It is not.' }],
  explanation: 'Because.', misconception: 'None.', citations: [{ sourceId, quote }],
  selections: [{ sourceId, documentId: 'doc', revision: 'rev', start: 0, end: quote.length, quote, prefix: '', suffix: '' }], ...extra });

async function library(t) {
  const root = await mkdtemp(join(tmpdir(), 'reader-inline-records-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const runtime = createStudyRuntime(root);
  const imported = await runtime.call('materials.document.import', { filename: 'lecture.pdf', courses: ['Databases'], dataBase64: (await makeTextPdf(LECTURE_PAGES)).toString('base64') });
  await runtime.dispose();
  const [p1, p2] = imported.sourceIds;
  await new Store(root).update(state => {
    state.decks.push({ id: 'd1', title: 'Indexes', course: 'Databases', cards: [question('a', p1), question('b', p1),
      question('c', p2, { review: { repetitions: 1, interval_days: 1, due_at: new Date(NOW - 86400000).toISOString(), ease_factor: 2.5 } })] });
  });
  return { root, documentId: imported.documentId, p1 };
}

/** The records a learner sees afterwards, without the ids and run ids that differ by construction between two rounds. */
async function records(runtime, { documentId, p1 }) {
  const store = await runtime.call('snapshot');
  const state = await new Store(store.root || runtime.root).read().catch(() => null);
  const attempts = (state?.attempts ?? []).map(({ id, runId, ...rest }) => rest).sort((x, y) => `${x.quiz_id}${x.retry}`.localeCompare(`${y.quiz_id}${y.retry}`));
  const cards = (state?.decks ?? []).flatMap(deck => deck.cards.map(card => ({ id: card.id, review: card.review ?? null })));
  const strip = value => JSON.parse(JSON.stringify(value, (key, item) => (['runId', 'lastRunId', 'id'].includes(key) && typeof item === 'string' && item.length > 12 ? '<id>' : item)));
  const wrong = await runtime.call('wrongbook', { course: '*', includeInactive: true, view: 'weak', offset: 0, limit: 100 });
  const stats = await runtime.call('stats', {});
  const mastery = await runtime.call('materials.pages.cards', { documentId, sourceId: p1 });
  return { attempts, cards, wrong: strip(wrong), stats: strip(stats), mastery: strip({ cards: mastery.cards, summary: mastery.summary }),
    progress: strip(store.progress ?? null), today: strip(store.today ?? null), materialMastery: strip(store.materialMastery ?? null) };
}

const answer = { a: 'r', b: 'w' };
const reading = (seeded) => ({ documentId: seeded.documentId, revision: 'rev', sourceId: seeded.p1, page: 1, sectionId: 'p1', sectionTitle: 'Indexes', sectionOffset: 40, scrollTop: 400,
  progress: 0.1, scope: { kind: 'here', count: 1, label: '本页' } });
const atStop = run => run.navigation?.[run.index] ?? null;

/** To the end of the round as both pages go there: the question on screen answered (a re-asked one right), then on (Enter / 下一题: review.move +1).
    Returns the finished run and the mastery the last answer showed (before → now). */
async function finish(runtime, run) {
  let live = null;
  for (let step = 0; step < 12 && run.card && !run.complete; step++) {
    if (!atStop(run)?.answered) {
      const retry = !!(run.card.retry || atStop(run)?.retry);
      run = await runtime.call('review.answer', { runId: run.id, cardId: run.card.id, queueVersion: run.queueVersion || 0, selected: [retry ? 'r' : answer[run.card.id]] });
      live = run.liveMastery ?? null;
    }
    run = await runtime.call('review.move', { runId: run.id, cardId: run.card.id, queueVersion: run.queueVersion || 0, direction: 1 });
  }
  return { run, live };
}

/** What the end of a round leaves: its result (mastery before → now, counts), whether it is closed, the debrief, the day's recap counts. */
async function roundEnd(runtime, run, live) {
  const strip = value => JSON.parse(JSON.stringify(value, (key, item) => (['runId', 'lastRunId', 'id'].includes(key) && typeof item === 'string' && item.length > 12 ? '<id>' : item)));
  const stored = (await new Store((await runtime.call('snapshot')).root).read()).runs.find(item => item.id === run.id);
  const debrief = await runtime.call('coach.debrief', { runId: run.id }).then(strip, error => ({ error: String(error.message) }));
  const recap = await runtime.call('note.daily.status', {}).then(result => strip({ ...result, modelReady: undefined }), error => ({ error: String(error.message) }));
  return {
    result: strip({ complete: run.complete, answered: run.answered, correct: run.correct, retries: run.retries, mastery: run.mastery ?? null, total: run.total }),
    liveMastery: strip(live), closed: !!stored?.closedAt, open: !stored?.closedAt && stored?.index < stored?.entries.length,
    debrief, recap,
  };
}

async function compare(t, settings) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const seeded = await library(t);
  if (settings) { const setup = createStudyRuntime(seeded.root); await setup.call('settings', settings); await setup.dispose(); }
  const copy = await mkdtemp(join(tmpdir(), 'reader-inline-records-copy-'));
  t.after(() => rm(copy, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  await cp(seeded.root, copy, { recursive: true });
  const scope = [{ deckId: 'd1', cardId: 'a' }, { deckId: 'd1', cardId: 'b' }];

  // The practice page: 去练 these questions (a learning target 'cards' starts practiceArgs(scope)), answer them as they come: a right, b wrong.
  const page = createStudyRuntime(seeded.root);
  t.after(() => page.dispose());
  let run = await page.call('review.start', practiceArgs(scope));
  while (!run.complete && run.card && !run.card.retry && !run.retry) {
    const answered = await page.call('review.answer', { runId: run.id, cardId: run.card.id, queueVersion: run.queueVersion || 0, selected: [answer[run.card.id]] });
    run = await page.call('review.move', { runId: answered.id, cardId: answered.card.id, queueVersion: answered.queueVersion || 0, direction: 1 });
  }

  // The reader panel: the section's questions started with the reading context (taking up an open round of them), the second one clicked first
  // (review.move {index}), then the first.
  const reader = createStudyRuntime(copy);
  t.after(() => reader.dispose());
  let panel = await reader.call('review.start', readingPracticeArgs(scope, reading(seeded), 'sources', { takeUp: true }));
  assert.ok(panel.reading, 'the round keeps where the learner was reading');
  for (const id of ['b', 'a']) {
    // A click on a question of the list moves the round to it (the panel's review.move {index}); a wrong answer queues its re-ask at the end, as ever.
    const at = panel.navigation.findIndex(stop => stop.cardId === id && !stop.answered && !stop.retry);
    if (at !== panel.index) panel = await reader.call('review.move', { runId: panel.id, cardId: panel.card?.id, queueVersion: panel.queueVersion || 0, index: at });
    assert.equal(panel.card.id, id);
    panel = await reader.call('review.answer', { runId: panel.id, cardId: panel.card.id, queueVersion: panel.queueVersion || 0, selected: [answer[id]] });
  }

  const fromPage = await records(page, seeded), fromReader = await records(reader, seeded);
  assert.equal(fromPage.attempts.length, 2, 'one attempt per question');
  assert.ok(fromPage.cards.find(card => card.id === 'a').review, 'the right answer scheduled the question');
  assert.ok(fromPage.wrong.items.some(item => item.cardId === 'b'), 'the wrong answer is in the wrong book');
  for (const key of Object.keys(fromPage)) assert.deepEqual(fromReader[key], fromPage[key], `${key}: the reader panel leaves the same record`);

  // Both rounds to their end (b asked again and answered right): the same records, the same result, closing, debrief and recap.
  const pageEnd = await finish(page, run), readerEnd = await finish(reader, panel);
  assert.ok(pageEnd.run.complete && readerEnd.run.complete, 'both rounds finished');
  const finalPage = await records(page, seeded), finalReader = await records(reader, seeded);
  assert.equal(finalPage.attempts.length, 3, 'the re-ask is an attempt too');
  for (const key of Object.keys(finalPage)) assert.deepEqual(finalReader[key], finalPage[key], `${key} at the end: the reader panel leaves the same record`);
  const endPage = await roundEnd(page, pageEnd.run, pageEnd.live), endReader = await roundEnd(reader, readerEnd.run, readerEnd.live);
  assert.ok(endPage.liveMastery, 'the last answer showed the mastery before → now');
  assert.ok(endPage.result.mastery, 'a finished round shows its mastery before → now');
  for (const key of Object.keys(endPage)) assert.deepEqual(endReader[key], endPage[key], `${key}: the end of the round is the same`);
}

test('a question answered in the reader panel leaves the records the practice page leaves, to the end of the round (#1013)', async t => {
  await compare(t, null);
});

test('the same with other FSRS-6 scheduling settings (#1013)', async t => {
  await compare(t, { request_retention: 0.85, maximum_interval: 120 });
});

test('the reader panel takes up an open round of the same questions; 做这几页的题 to the practice page starts afresh (#1013)', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const seeded = await library(t);
  const runtime = createStudyRuntime(seeded.root);
  t.after(() => runtime.dispose());
  const scope = [{ deckId: 'd1', cardId: 'a' }, { deckId: 'd1', cardId: 'b' }];
  // The practice page shows a round of these questions, one answered.
  let open = await runtime.call('review.start', practiceArgs(scope));
  open = await runtime.call('review.answer', { runId: open.id, cardId: open.card.id, queueVersion: open.queueVersion || 0, selected: [answer[open.card.id]] });
  // The reader panel's start: the same round, where it was, not closed.
  const taken = await runtime.call('review.start', readingPracticeArgs(scope, reading(seeded), 'sources', { takeUp: true }));
  assert.equal(taken.id, open.id, 'the open round is taken up');
  assert.equal(taken.index, open.index, 'where it was');
  const state = await new Store(seeded.root).read();
  assert.ok(!state.runs.find(item => item.id === open.id).closedAt, 'not closed');
  // 做这几页的题 to the practice page: a fresh round, as before.
  const fresh = await runtime.call('review.start', readingPracticeArgs(scope, reading(seeded), 'sources'));
  assert.notEqual(fresh.id, open.id, 'a new round');
});
