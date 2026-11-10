/* #894: each crunch point (冲刺考点) of a course with an exam date ahead says which of three bands it is in on the exam day, projected with no
   further review: still solid (到考试日仍稳), will slip (会掉: solid today, not on the exam day), already weak (已经不稳). The rule is the
   scheduler's own forgetting curve (lib/sm2.js retrievabilityAt) against its own target recall, and "solid" is the readiness rule of
   lib/custom-readiness.js; no percentage leaves the library. No real model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { examDayBand } from '../lib/exam-day-band.js';
import { examDayStart, schedule } from '../lib/sm2.js';
import { StudyService } from '../lib/service.js';
import { courseOutlineMaterial, materialsFingerprint } from '../lib/course-outline-book.js';
import { courseNotesMaterial } from '../lib/course-book.js';
import { buildOutlineIndex } from '../lib/course-outline-index.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { localDate } from '../lib/board-model.js';
import { addDays } from '../lib/crunch-plan.js';
import { crunchComputations } from '../lib/course-book-crunch.js';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';

const DAY = 864e5;
const TODAY = '2026-11-10';
const NOON = new Date(2026, 10, 10, 12, 0).getTime();
/** Learnt well 25 days ago (stability 30 days): recalled above the default target 0.9 three days from now, below it a month from now. */
const learnt = (now = NOON) => ({ algorithm: 'fsrs-6', stability: 30, difficulty: 5, reps: 2, lapses: 0, repetitions: 2, interval_days: 27, ease_factor: 2.3,
  last_review: new Date(now - 25 * DAY).toISOString(), due_at: new Date(now + 2 * DAY).toISOString() });
const solidQuestion = (review = learnt()) => ({ review, answered: true, solid: true, weak: false, focus: false });
const at = days => ({ examDate: addDays(TODAY, days), today: TODAY, settings: {} });

test('the exam day is local 00:00 of the exam date, the instant the scheduler itself uses (#916)', () => {
  assert.equal(examDayStart('2026-12-01'), new Date(2026, 11, 1).getTime());
});

test('the same point is still solid for an exam in three days and will slip when the exam moves a month out; a review brings it back', () => {
  const point = [solidQuestion(), solidQuestion()];
  assert.equal(examDayBand(point, at(3)).band, 'solid');
  const later = examDayBand(point, at(30));
  assert.equal(later.band, 'slip');
  assert.deepEqual(later.atRisk.map(item => item.index), [0, 1], 'both questions fall below the target recall');
  // One review today (Good, through the scheduler itself) raises the stability: the same exam date holds again.
  const reviewed = schedule(learnt(), 4, new Date(NOON).toISOString());
  assert.equal(examDayBand([solidQuestion(reviewed), solidQuestion(reviewed)], at(30)).band, 'solid');
});

test('a point slips only when the readiness rule would no longer call it solid on the exam day: one question at risk out of four is not enough', () => {
  const fresh = schedule(learnt(), 4, new Date(NOON).toISOString());
  const mixed = [solidQuestion(), solidQuestion(fresh), solidQuestion(fresh), solidQuestion(fresh)];
  const band = examDayBand(mixed, at(30));
  assert.equal(band.band, 'solid', 'three of four stay solid: at least half');
  assert.deepEqual(band.atRisk.map(item => item.index), [0], 'the question at risk is still named');
  assert.equal(examDayBand([solidQuestion(), solidQuestion(), solidQuestion(fresh), solidQuestion(fresh)], at(30)).band, 'solid', 'half kept is still at least half');
  assert.equal(examDayBand([solidQuestion(), solidQuestion(), solidQuestion(), solidQuestion(fresh)], at(30)).band, 'slip', 'three of four lost: not solid any more');
});

test('at-risk questions come lowest projected recall first', () => {
  const older = { ...learnt(), last_review: new Date(NOON - 40 * DAY).toISOString() };
  const band = examDayBand([solidQuestion(), solidQuestion(older)], at(30));
  assert.equal(band.band, 'slip');
  assert.deepEqual(band.atRisk.map(item => item.index), [1, 0]);
  assert.ok(band.atRisk[0].recall < band.atRisk[1].recall);
});

test('a focus question is held to the raised target recall the scheduler gives it', () => {
  // Recall about 0.905 at three days out: above the default 0.9, below a focus question's 0.94.
  assert.equal(examDayBand([solidQuestion(), solidQuestion()], at(3)).band, 'solid');
  assert.equal(examDayBand([{ ...solidQuestion(), focus: true }, { ...solidQuestion(), focus: true }], at(3)).band, 'slip');
  // So is a learner's own higher target.
  assert.equal(examDayBand([solidQuestion(), solidQuestion()], { ...at(3), settings: { request_retention: 0.95 } }).band, 'slip');
});

test('an already weak point stays already weak whatever the exam date', () => {
  const point = [solidQuestion(), { ...solidQuestion(), solid: false, weak: true }];
  for (const days of [1, 3, 30, 400]) assert.equal(examDayBand(point, at(days)).band, 'weak', `exam in ${days} days`);
  // Not yet solid by the readiness rule (fewer than half solid) is already weak too: today's rule, not a new one.
  assert.equal(examDayBand([solidQuestion(), { ...solidQuestion(), solid: false }, { ...solidQuestion(), solid: false }], at(3)).band, 'weak');
});

test('no band: a point none of whose questions was ever answered, no exam date, an exam in the past or today', () => {
  assert.equal(examDayBand([{ review: null, answered: false, solid: false, weak: false, focus: false }], at(30)), null);
  assert.equal(examDayBand([], at(30)), null);
  const point = [solidQuestion()];
  assert.equal(examDayBand(point, { examDate: null, today: TODAY, settings: {} }), null);
  assert.equal(examDayBand(point, at(-1)), null);
  assert.equal(examDayBand(point, at(0)), null, 'on the exam day nothing is left to project');
});

/* Through the library: book.crunch carries the band on each point, computed inside its memo. */
const options = [{ id: 'a', text: 'Yes', correct: true }, { id: 'b', text: 'No', correct: false }];
function library() {
  const { sources, decks } = outlineLibrary();
  const deck = decks.find(item => item.id === 'deck-l1');
  deck.cards.slice(0, 6).forEach(card => Object.assign(card, { kind: 'quiz', options }));
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
  return { state, deck };
}

async function service(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-exam-band-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const study = new StudyService(root);
  await study.call('snapshot');
  const { state, deck } = library();
  await study.store.update(own => { own.sources.push(...state.sources); own.decks.push(...state.decks); own.focus = state.focus; });
  await study.call('course.book.open');
  const opened = await study.call('course.book.open');
  const [what, who] = opened.nodes[0].children;
  return { study, deck, what, who };
}

/** Every question of the deck learnt well: right on two days (solid by the readiness rule), the last time 25 days ago. */
const learnEverything = (study, deck) => study.store.update(state => {
  const now = Date.now(), own = state.decks.find(item => item.id === deck.id);
  for (const card of own.cards) {
    card.review = learnt(now);
    for (const back of [26, 25]) state.attempts.push({ id: `l${back}-${card.id}`, quiz_id: card.id, deckId: deck.id, timestamp: new Date(now - back * DAY).toISOString(), grade: 4, assessment: 'graded' });
  }
});
const examIn = (study, days) => study.call('course.save', { name: COURSE, exam: { date: addDays(localDate(), days) } });
const bandOf = async (study, hid) => (await study.call('book.crunch', { date: localDate() })).points.find(point => point.id === hid).examDay;

test('book.crunch: a never-answered point has no band; with no exam date no point has one', async t => {
  const { study, what } = await service(t);
  await examIn(study, 30);
  assert.equal(await bandOf(study, what.hid), undefined, 'nothing answered: the 新 wording stays');
  const { deck } = library();
  await learnEverything(study, deck);
  await study.call('course.save', { name: COURSE, exam: null });
  const none = await study.call('book.crunch', { date: localDate() });
  assert.equal(none.status, 'no-exam');
  assert.ok(none.points.every(point => point.examDay === undefined), 'no exam date: no band anywhere');
});

test('book.crunch: the band follows the exam date and comes back fresh from the memo after a review; the slipping point names its questions in order', async t => {
  const { study, deck, what } = await service(t);
  await learnEverything(study, deck);
  await examIn(study, 30);
  const slipping = await bandOf(study, what.hid);
  assert.equal(slipping.band, 'slip');
  assert.ok(slipping.atRisk.length > 0);
  assert.ok(slipping.atRisk.every(item => typeof item.deckId === 'string' && typeof item.cardId === 'string' && Number.isInteger(item.rank)));
  assert.ok(slipping.atRisk.every(item => !('recall' in item)), 'no recall number leaves the library');
  assert.equal(JSON.stringify(slipping).match(/0\.\d{3}/), null);
  // The memo keeps the answer while nothing changed.
  const before = crunchComputations();
  await bandOf(study, what.hid);
  assert.equal(crunchComputations(), before);
  // A review of every question today: the same exam date holds.
  await study.store.update(state => {
    const own = state.decks.find(item => item.id === deck.id), now = new Date().toISOString();
    for (const card of own.cards) {
      card.review = schedule(card.review, 4, now);
      state.attempts.push({ id: `r-${card.id}`, quiz_id: card.id, deckId: deck.id, timestamp: now, grade: 4, assessment: 'graded' });
    }
  });
  assert.equal((await bandOf(study, what.hid)).band, 'solid', 'a fresh band after the review, not the memoised one');
  assert.equal(crunchComputations(), before + 1);
  // On the exam day itself nothing is projected.
  await examIn(study, 0);
  assert.equal(await bandOf(study, what.hid), undefined);
});

test('book.crunch: a higher target recall in the settings moves the band through the memo', async t => {
  const { study, deck, what } = await service(t);
  await learnEverything(study, deck);
  await examIn(study, 3);
  assert.equal((await bandOf(study, what.hid)).band, 'solid');
  const before = crunchComputations();
  await study.call('settings', { ...(await study.call('snapshot')).settings, request_retention: 0.95 });
  assert.equal((await bandOf(study, what.hid)).band, 'slip', 'the target the scheduler uses is the target the band uses');
  assert.equal(crunchComputations(), before + 1);
});

test('course.plan reads the same points: a whole-period plan carries the band too', async t => {
  const { study, deck, what } = await service(t);
  await learnEverything(study, deck);
  await examIn(study, 30);
  await study.call('course.save', { name: COURSE, plan: { version: 1, minutesPerDay: 90 } });
  const plan = await study.call('course.plan', { course: COURSE, date: localDate() });
  assert.equal(plan.points.find(point => point.id === what.hid).examDay.band, 'slip');
});
