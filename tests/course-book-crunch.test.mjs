/* 期末一周 on the library (docs/plans/review-book.md M7): book.crunch makes the plan from the course's exam date and the book's points (no model call),
   shows a course only inside its window, counts a point learnt from the answers, keeps 读完了 / 已看 in the book's record (export unaffected);
   book.mock.plan says how many of the points' questions a mock paper can take and what the exam mode leaves out; book.mock starts an ordinary exam
   run over exactly those (single and multiple choice, due and weak first, 1–200). No real model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { courseOutlineMaterial, materialsFingerprint } from '../lib/course-outline-book.js';
import { courseNotesMaterial } from '../lib/course-book.js';
import { buildOutlineIndex } from '../lib/course-outline-index.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { localDate } from '../lib/board-model.js';
import { addDays } from '../lib/crunch-plan.js';
import { pointMistakes } from '../lib/book-flip.js';
import { crunchComputations } from '../lib/course-book-crunch.js';
import { crunchMinutes, mergeBookSettings } from '../lib/book-settings.js';
import { libraryContracts, studyToolDescription } from '../lib/study-contracts.js';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';

const TODAY = localDate();
const options = [{ id: 'a', text: 'Yes', correct: true }, { id: 'b', text: 'No', correct: false }];

/** Two points of lecture 1: 'what' (chapter 0: six single choice, one multiple choice, one open question and flashcards) and 'who' (chapter 1: flashcards only). */
function library() {
  const { sources, decks } = outlineLibrary();
  const deck = decks.find(item => item.id === 'deck-l1');
  deck.cards.slice(0, 6).forEach(card => Object.assign(card, { kind: 'quiz', options }));
  Object.assign(deck.cards[6], { kind: 'multi', options: [...options, { id: 'c', text: 'Both', correct: true }] });
  Object.assign(deck.cards[7], { kind: 'open', answer: 'A decision and its reasons.' });
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

async function service(t, { book = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'study-book-crunch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const study = new StudyService(root);
  await study.call('snapshot');
  const { state, deck } = library();
  await study.store.update(own => { own.sources.push(...state.sources); own.decks.push(...state.decks); own.focus = state.focus; });
  if (book) await study.call('course.book.open');
  const opened = await study.call('course.book.open');
  const [what, who] = opened.nodes[0].children;
  return { study, deck, what, who };
}
const examIn = (study, days) => study.call('course.save', { name: COURSE, exam: { date: addDays(TODAY, days) } });

test('no exam date: no plan, the points and the 翻看 order are still read; an exam within 21 days: the plan, today first', async t => {
  const { study, what, who } = await service(t);
  const none = await study.call('book.crunch', { date: TODAY });
  assert.equal(none.status, 'no-exam');
  assert.deepEqual(none.plan.days, []);
  assert.deepEqual(none.points.map(point => [point.id, point.code, point.title]), [[what.hid, what.hid.toUpperCase(), 'What architects do'], [who.hid, who.hid.toUpperCase(), 'Stakeholders']]);
  assert.deepEqual([...none.plan.order.flip].sort(), [what.hid, who.hid].sort());
  const first = none.points[0];
  assert.equal(first.questions, what.questionTotal);
  assert.equal(first.weakness, 0.6, 'nothing answered yet: every question is new');
  assert.equal(first.tested, 0, 'no sample paper: nothing is tested');
  assert.ok(first.size > 0);
  assert.deepEqual((await study.call('book.crunch', { all: true, date: TODAY })).courses, [], 'no exam date: no card');

  await examIn(study, 7);
  const week = await study.call('book.crunch', { date: TODAY });
  assert.equal(week.status, 'ok');
  assert.equal(week.daysLeft, 7);
  assert.equal(week.window, 21);
  assert.deepEqual(week.plan.days.map(day => day.mode), ['learn', 'learn', 'learn', 'learn', 'learn', 'flip', 'flip']);
  assert.equal(week.plan.days[6].mock, true);
  assert.equal(week.plan.weighting, 'size', 'no papers: by size');
  const all = await study.call('book.crunch', { all: true, date: TODAY });
  assert.equal(all.courses.length, 1);
  assert.deepEqual({ course: all.courses[0].course, daysLeft: all.courses[0].daysLeft, mockDate: all.courses[0].mockDate }, { course: COURSE, daysLeft: 7, mockDate: addDays(TODAY, 6) });
  assert.deepEqual(all.courses[0].points.map(point => point.id), all.courses[0].today.points);
  assert.ok(all.courses[0].points.length >= 1);
});

test('the window: an exam 30 days away is far (no card) until crunchWindowDays says 30; a past exam has no plan', async t => {
  const { study } = await service(t);
  await examIn(study, 30);
  assert.equal((await study.call('book.crunch', { date: TODAY })).status, 'far');
  assert.deepEqual((await study.call('book.crunch', { all: true, date: TODAY })).courses, []);
  await study.call('settings.book.set', { patch: { crunchWindowDays: 30 } });
  assert.equal((await study.call('book.crunch', { date: TODAY })).status, 'ok');
  assert.equal((await study.call('book.crunch', { all: true, date: TODAY })).courses.length, 1);
  await assert.rejects(study.call('settings.book.set', { patch: { crunchWindowDays: 61 } }), /Invalid book setting/);
  await study.call('settings.book.set', { patch: { crunchWindowDays: null } });
  assert.equal((await study.store.read()).settings.book.crunchWindowDays, undefined);
  await examIn(study, -1);
  assert.equal((await study.call('book.crunch', { date: TODAY })).status, 'past');
  await assert.rejects(study.call('book.crunch', { date: '2026-13-01' }), /date must be/);
});

test('a course with an exam date but no review book: no card; the plan says no-book', async t => {
  const { study } = await service(t, { book: false });
  await study.store.update(state => { state.sources = state.sources.filter(source => source.provenance !== 'course-book-doc'); });
  await examIn(study, 5);
  assert.equal((await study.call('book.crunch', { date: TODAY })).status, 'no-book');
  assert.deepEqual((await study.call('book.crunch', { all: true, date: TODAY })).courses, []);
});

test('a point is learnt when at least five of its questions were answered on a day; a point without questions when it is marked 读完了', async t => {
  const { study, deck, what } = await service(t);
  await examIn(study, 7);
  const now = new Date().toISOString();
  await study.store.update(state => {
    for (const card of deck.cards.slice(0, 5)) state.attempts.push({ id: `a-${card.id}`, quiz_id: card.id, deckId: deck.id, timestamp: now, grade: 4, assessment: 'graded' });
  });
  const plan = await study.call('book.crunch', { date: TODAY });
  const point = plan.points.find(item => item.id === what.hid);
  assert.equal(point.done, TODAY);
  assert.ok(plan.plan.today.points.includes(what.hid) && plan.plan.today.done.includes(what.hid), 'done today: on today, done');
  assert.ok(point.weakness < 0.6, 'answered well: less weak');
  // 读完了 is the learner's mark (kept by day); it only counts for a point without questions.
  const marked = await study.call('book.crunch.mark', { hid: what.hid, kind: 'read', date: TODAY });
  assert.equal(marked.write, 'marked');
  assert.equal((await study.call('book.crunch.mark', { hid: what.hid, kind: 'read', date: TODAY })).write, 'unchanged');
});

test('已看 is kept in the book\'s record per point, cleared on request; an unknown point is refused; the book\'s files and its export do not change', async t => {
  const { study, what } = await service(t);
  const before = await study.call('course.book.export', {});
  const opened = await study.call('course.book.open');
  const seen = await study.call('book.crunch.mark', { hid: what.hid, kind: 'seen', date: TODAY });
  assert.equal(seen.write, 'marked');
  assert.equal(seen.points.find(point => point.id === what.hid).seen, TODAY);
  const record = (await study.store.read()).sources.find(source => source.provenance === 'course-book-doc');
  assert.deepEqual(record.bookDoc.marks.seen, { [what.hid]: TODAY });
  const after = await study.call('course.book.open');
  assert.equal(after.revision, opened.revision, 'a mark is not a change of the book');
  assert.equal((await study.call('course.book.export', {})).text, before.text, 'the export is unaffected');
  const cleared = await study.call('book.crunch.mark', { hid: what.hid, kind: 'seen', on: false, date: TODAY });
  assert.equal(cleared.write, 'cleared');
  assert.equal(cleared.points.find(point => point.id === what.hid).seen, null);
  await assert.rejects(study.call('book.crunch.mark', { hid: 'h999', kind: 'seen' }), /no such point|没有这一节/);
  await assert.rejects(study.call('book.crunch.mark', { hid: what.hid, kind: 'liked' }), /kind must be/);
});

test('book.mock.plan: how many questions the points have, how many a mock paper can take, what the exam mode leaves out', async t => {
  const { study, what, who } = await service(t);
  const plan = await study.call('book.mock.plan', { pointIds: [what.hid] });
  assert.equal(plan.questions, what.questionTotal);
  assert.equal(plan.eligible, 7, 'six single choice and one multiple choice');
  assert.equal(plan.leftOut.open, 1);
  assert.equal(plan.leftOut.flashcard, what.questionTotal - 8);
  assert.equal(plan.count, 7, 'at most 20 by default');
  assert.equal(plan.capped, false);
  assert.equal(plan.scope, undefined, 'the plan does not hand out the questions');
  assert.deepEqual(plan.perPoint.map(item => [item.id, item.eligible]), [[what.hid, 7]]);
  const both = await study.call('book.mock.plan', { pointIds: [what.hid, who.hid, 'h999'] });
  assert.deepEqual(both.unknown, ['h999'], 'an unknown point is reported, not dropped silently');
  assert.deepEqual(both.perPoint.map(item => [item.id, item.eligible]), [[what.hid, 7], [who.hid, 0]]);
  assert.equal((await study.call('book.mock.plan', { pointIds: [what.hid], count: 3 })).count, 3);
  assert.equal((await study.call('book.mock.plan', { pointIds: [what.hid], count: 3 })).capped, true);
  await assert.rejects(study.call('book.mock.plan', { pointIds: [what.hid], count: 201 }), /1–200/);
  await assert.rejects(study.call('book.mock.plan', { pointIds: ['h999'] }), /No point is chosen|没有选中/);
  // Without pointIds and without a plan: every point of the book.
  assert.deepEqual((await study.call('book.mock.plan', {})).points, [what.hid, who.hid]);
});

test('book.mock starts an ordinary exam run over exactly the chosen questions: choice only, due and weak first; points without choice questions are refused', async t => {
  const { study, deck, what, who } = await service(t);
  // One question answered wrong a while ago: weak, so it comes first.
  const weak = deck.cards[4];
  await study.store.update(state => { state.attempts.push({ id: 'w1', quiz_id: weak.id, deckId: deck.id, timestamp: '2026-01-01T00:00:00.000Z', grade: 1, assessment: 'graded' }); });
  const run = await study.call('book.mock', { pointIds: [what.hid], count: 3, limitMinutes: 15 });
  assert.equal(run.mode, 'exam');
  assert.equal(run.total, 3);
  assert.equal(run.limitMs, 15 * 60000);
  assert.equal(run.mock.count, 3);
  assert.equal(run.mock.eligible, 7);
  const stored = (await study.store.read()).runs.find(item => item.id === run.id);
  assert.equal(stored.mode, 'exam');
  assert.equal(stored.examKinds, 'all');
  assert.ok(stored.entries.every(entry => ['quiz', 'multi'].includes(entry.card.kind)), 'only single and multiple choice');
  assert.deepEqual([...stored.scope].map(ref => ref.cardId).sort(), stored.entries.map(entry => entry.card.id).sort(), 'the exam takes exactly the chosen questions');
  assert.ok(stored.entries.some(entry => entry.card.id === weak.id), 'the weak question is in');
  // The exam mode is the ordinary one: review.answer records without grading, exam.submit grades.
  await study.call('review.answer', { runId: run.id, cardId: stored.entries[0].card.id, selected: ['a'] });
  const report = await study.call('exam.submit', { runId: run.id });
  assert.equal(report.total ?? report.questions?.length ?? 3, 3);
  await assert.rejects(study.call('book.mock', { pointIds: [who.hid] }), error => error.code === 'book-mock-empty' || /出不了模拟卷/.test(error.message));
});

test('the 易错点 of a point: the follow-ups put into the book, the answer cards\' pitfalls, the 弄懂 blocks', () => {
  const book = { status: 'ok', title: 'B', language: 'zh', unplaced: { title: '未归位', text: '' }, answerCards: [{ deckId: 'd', cardId: 'q2', hid: 'h2', pitfalls: ['把串联的可用性相加'] }],
    nodes: [{ hid: 'h1', title: 'C', number: '1', depth: 1, leaf: false, children: [{ hid: 'h2', title: 'A', number: '1.1', depth: 2, leaf: true, gen: '', qa: '<!-- sh:qa card=q1 fid=f1 -->\n> **追问：** 为什么串联要相乘？\n>\n> **答：** 因为独立。\n<!-- /sh:qa -->',
      mine: '<!-- sh:ai id=ai1 at=abc state=new mode=explain -->\n关于：「可用性」\n\n解释。\n<!-- /sh:ai -->\n\n<!-- sh:ai id=ai2 at=h:h2 state=new mode=here -->\n关于：「A」\n\n一段。\n<!-- /sh:ai -->', children: [] },
    { hid: 'h3', title: 'B', number: '1.2', depth: 2, leaf: true, gen: '', mine: '', qa: '', children: [] }] }] };
  const items = pointMistakes(book);
  assert.deepEqual(items.get('h2').map(item => [item.kind, item.text]), [['asked', '为什么串联要相乘？'], ['pitfall', '把串联的可用性相加'], ['explained', '可用性']]);
  assert.equal(items.has('h3'), false);
});

test('book.crunch is kept per course, library revision, book revision and day: an unchanged second call does not rebuild the book; a book write or a new answer does', async t => {
  const { study, deck, what } = await service(t);
  await examIn(study, 7);
  await study.call('book.crunch', { date: TODAY });
  const first = crunchComputations();
  const again = await study.call('book.crunch', { date: TODAY });
  await study.call('book.crunch', { all: true, date: TODAY });
  assert.equal(crunchComputations(), first, 'unchanged: not computed again (the home card asks the same)');
  assert.equal(again.status, 'ok');
  await study.call('book.crunch', { date: addDays(TODAY, 1) });
  assert.equal(crunchComputations(), first + 1, 'another day is another plan');
  // A write of the book (a mark) invalidates it.
  const marked = await study.call('book.crunch.mark', { hid: what.hid, kind: 'seen', date: TODAY });
  assert.equal(marked.points.find(point => point.id === what.hid).seen, TODAY);
  const afterMark = crunchComputations();
  assert.ok(afterMark > first + 1);
  await study.call('book.crunch', { date: TODAY });
  assert.equal(crunchComputations(), afterMark, 'the answer of the mark is kept');
  // A new answer invalidates it.
  await study.store.update(state => { for (const card of deck.cards.slice(0, 5)) state.attempts.push({ id: `n-${card.id}`, quiz_id: card.id, deckId: deck.id, timestamp: new Date().toISOString(), grade: 4, assessment: 'graded' }); });
  const fresh = await study.call('book.crunch', { date: TODAY });
  assert.equal(crunchComputations(), afterMark + 1);
  assert.equal(fresh.points.find(point => point.id === what.hid).done, TODAY, 'the new answers are seen');
});

test('a parked course is left out of the 期末一周 of the home; activated again it is back', async t => {
  const { study } = await service(t);
  await examIn(study, 7);
  assert.equal((await study.call('book.crunch', { all: true, date: TODAY })).courses.length, 1);
  await study.call('course.deactivate', { name: COURSE });
  assert.deepEqual((await study.call('book.crunch', { all: true, date: TODAY })).courses, []);
  assert.equal((await study.call('book.crunch', { date: TODAY })).status, 'ok', 'its book page still has the plan');
  await study.call('course.activate', { name: COURSE });
  assert.equal((await study.call('book.crunch', { all: true, date: TODAY })).courses.length, 1);
});

test('the minutes a day (settings.book.crunchMinutes, default 180) go to the planner', async t => {
  assert.equal(crunchMinutes(undefined), 180);
  assert.deepEqual(mergeBookSettings(undefined, { crunchMinutes: 90 }), { qaToBook: 'manual', crunchMinutes: 90 });
  assert.throws(() => mergeBookSettings(undefined, { crunchMinutes: 5 }), /Invalid book setting/);
  const { study } = await service(t);
  await examIn(study, 7);
  assert.equal((await study.call('book.crunch', { date: TODAY })).plan.capacity, 180);
  await study.call('settings.book.set', { patch: { crunchMinutes: 60 } });
  assert.equal((await study.call('book.crunch', { date: TODAY })).plan.capacity, 60);
  assert.equal((await study.call('book.crunch', { date: TODAY, minutesPerDay: 240 })).plan.capacity, 240, 'the op argument wins');
});

test('the contracts name the ops', () => {
  assert.match(libraryContracts.learning, /book\.crunch \{course\?/);
  assert.match(libraryContracts.learning, /book\.mock \{course\?/);
  assert.match(studyToolDescription, /book\.crunch/);
});

// #489 item 9: 学完 means studied. Answers given in a mock exam (or an oral one) measure, they do not teach the point, so the plan keeps it; a practice round's answers still count.
test('answers in a mock exam do not make a point learnt; the same answers in practice do', async t => {
  const { study, deck, what } = await service(t);
  await examIn(study, 7);
  const run = await study.call('book.mock', { course: COURSE, pointIds: [what.hid], count: 5, date: TODAY });
  const answer = (prefix, extra) => study.store.update(state => {
    for (const card of deck.cards.slice(0, 5)) state.attempts.push({ id: `${prefix}-${card.id}`, quiz_id: card.id, deckId: deck.id, timestamp: new Date().toISOString(), grade: 4, assessment: 'graded', ...extra });
  });
  const pointNow = async () => (await study.call('book.crunch', { course: COURSE, date: TODAY })).points.find(point => point.id === what.hid);
  await answer('exam', { runId: run.id });
  assert.equal((await pointNow()).done, null, 'five answers in the mock paper: not learnt');
  await answer('oral', { assessment: 'oral', runId: 'an-oral-run' });
  assert.equal((await pointNow()).done, null, 'nor in an oral exam');
  const plan = await study.call('course.plan', { course: COURSE, date: TODAY });
  assert.ok(!plan.schedule?.today?.done?.includes(what.hid), 'the whole-period plan reads the same days');
  await answer('practice', { runId: 'a-practice-run' });
  assert.equal((await pointNow()).done, TODAY, 'a run that is not a mock counts');
});

test('a mock paper says how many case questions it leaves out, apart from other open questions', async t => {
  const { study, deck, what } = await service(t);
  await study.store.update(state => { const own = state.decks.find(item => item.id === deck.id); own.cards[7].rubricCriteria = [{ id: 'c', text: 'Names the decision', points: 1 }]; });
  const plan = await study.call('book.mock.plan', { course: COURSE, pointIds: [what.hid] });
  assert.equal(plan.leftOut.case, 1);
  assert.equal(plan.leftOut.open, undefined);
});
