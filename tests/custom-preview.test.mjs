/* 深度定制 (4.4 S0): course.custom.preview, the read-only op the main chat asks BEFORE anything is spent. It lists the course's materials and their chapters as they are
   without a model call (the ids a 定制方案's scope names), the defaults of every purpose, what the saved (or the given, or the review) plan would cost in calls and
   tokens, and the saved plan. The estimate counts only the chosen chapters and only the ticked parts, reuses the repo's estimators for the sizes (it adds none of its
   own), says it is rough while it rests on characters, and names no price. No real model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { writesFor } from '../lib/runtime/domain-contracts.js';
import { assistantRefusal } from '../lib/assistant-boundary.js';
import { studyToolDescription, libraryContracts } from '../lib/study-contracts.js';
import { CUSTOM_PURPOSES, customDefaults } from '../lib/custom-plan.js';
import { COURSE, LECTURES, outlineLibrary } from './helpers/course-outline-library.mjs';

async function open(t, { paper = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'study-custom-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const study = new StudyService(root);
  await study.call('snapshot');
  const { sources, decks } = outlineLibrary({ paper });
  await study.store.update(own => { own.sources.push(...sources); own.decks.push(...decks); own.focus = { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] }; });
  return study;
}
/** One converted book of 10 chapters of 24 000 characters: big enough for the strength levels to differ (a course of many small materials gets a question per material at every level). */
async function openBigBook(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-custom-preview-big-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const study = new StudyService(root);
  await study.call('snapshot');
  const sources = Array.from({ length: 40 }, (_, at) => ({ id: `big-p${at + 1}`, title: `Big Book · p. ${at + 1}`, text: 'word '.repeat(1200), createdAt: '2026-10-01T08:00:00.000Z', courses: ['Big'],
    document: { materialId: 'document-big', page: at + 1, totalPages: 40, format: 'pdf', origin: 'converted', converter: 'marker', filename: 'Big Book.pdf',
      chapter: { index: Math.floor(at / 4), title: `Chapter ${Math.floor(at / 4) + 1}`, level: 1 }, extractionVersion: 2 } }));
  await study.store.update(own => { own.sources.push(...sources); });
  return study;
}
const preview = (study, args = {}) => study.call('course.custom.preview', { course: COURSE, ...args });
const lectureOf = (answer, n) => answer.skeleton.documents.find(doc => doc.title.includes(LECTURES[n - 1].title) && !doc.copyOf && doc.chapters.length === 3);
const chaptersOf = (answer, ns) => ns.flatMap(n => lectureOf(answer, n).chapters.map(chapter => chapter.id));
const custom = (purpose, over = {}) => ({ ...customDefaults(purpose), scope: { kind: 'all' }, ...over });
const book = (parts, over = {}) => ({ make: true, coverage: 'standard', parts, ...over });

test('the skeleton is what the library holds before any model call: materials, their chapters with a stable id, pages and size', async t => {
  const study = await open(t);
  const answer = await preview(study);
  assert.equal(answer.status, 'ok');
  assert.equal(answer.course, COURSE);
  const lecture = lectureOf(answer, 3);
  assert.equal(lecture.pages, 6);
  assert.deepEqual(lecture.chapters.map(chapter => chapter.title), LECTURES[2].chapters);
  assert.deepEqual(lecture.chapters.map(chapter => chapter.pages), [[1, 2], [3, 4], [5, 6]]);
  assert.deepEqual(lecture.chapters.map(chapter => chapter.id), [0, 1, 2].map(at => `${lecture.key}#${at}`), 'chapterKey of lib/course-outline-index.js: <document key>#<chapter index>');
  assert.ok(lecture.chapters.every(chapter => chapter.chars > 0));
  assert.equal(new Set(answer.skeleton.documents.flatMap(doc => doc.chapters.map(chapter => chapter.id))).size, answer.skeleton.documents.flatMap(doc => doc.chapters).length, 'ids are unique');
  const note = answer.skeleton.documents.find(doc => doc.title.startsWith('Handout 1:'));
  assert.deepEqual(note.chapters.map(chapter => chapter.id), [note.key], 'a material with no chapters is one chapter named by its document key');
  assert.equal(answer.skeleton.documents.find(doc => doc.title.includes('样卷')).paper, true, 'a sample paper is marked: it is not taught, it fills the answer kit');
  const again = answer.skeleton.documents.filter(doc => doc.title.includes(LECTURES[0].title) && doc.chapters.length === 3);
  assert.equal(again.length, 2, 'the same lecture imported twice is listed twice');
  assert.equal(again.filter(doc => doc.copyOf).length, 1, 'but the second is marked as a copy of the first');
  assert.equal(again.find(doc => doc.copyOf).copyOf, again.find(doc => !doc.copyOf).key);
});

test('the defaults of every purpose come from the one table; the saved plan is null until the course has one', async t => {
  const study = await open(t);
  const answer = await preview(study);
  assert.deepEqual(Object.keys(answer.defaults), [...CUSTOM_PURPOSES]);
  for (const purpose of CUSTOM_PURPOSES) assert.deepEqual(answer.defaults[purpose], customDefaults(purpose), purpose);
  assert.equal(answer.saved, null);
  await study.call('course.save', { name: COURSE, custom: custom('openbook') });
  const saved = await preview(study);
  assert.equal(saved.saved.purpose, 'openbook');
  assert.deepEqual(saved.saved, (await study.call('course.get', { name: COURSE })).custom);
});

test('the estimate is for the given plan, else the saved one, else the review defaults', async t => {
  const study = await open(t);
  const none = await preview(study), review = await preview(study, { custom: custom('review') });
  assert.deepEqual(none.estimate, review.estimate, 'no plan at all: the review defaults');
  await study.call('course.save', { name: COURSE, custom: custom('openbook') });
  const savedOne = await preview(study), given = await preview(study, { custom: custom('review') });
  assert.notDeepEqual(savedOne.estimate, review.estimate, 'a saved plan is the one estimated');
  assert.deepEqual(given.estimate, review.estimate, 'a given plan wins over the saved one');
  assert.equal(given.saved.purpose, 'openbook', 'and the saved one is still reported as it is');
});

test('only the chosen chapters count: fewer chapters, fewer points, calls, questions and tokens; the same chapters through the all scope add up', async t => {
  const study = await open(t);
  const whole = await preview(study, { custom: custom('review') });
  const one = await preview(study, { custom: custom('review', { scope: { kind: 'chapters', chapters: chaptersOf(whole, [3]).slice(0, 1) } }) });
  const three = await preview(study, { custom: custom('review', { scope: { kind: 'chapters', chapters: chaptersOf(whole, [3]) } }) });
  const a = one.estimate, b = three.estimate, all = whole.estimate;
  for (const part of [['book', 'points'], ['book', 'calls'], ['questions', 'count'], ['questions', 'calls'], ['total', 'calls'], ['total', 'readTokens']]) {
    const [group, key] = part;
    assert.ok(a[group][key] > 0, `${group}.${key} of one chapter`);
    assert.ok(a[group][key] <= b[group][key] && b[group][key] < all[group][key], `${group}.${key}: one ≤ three < all`);
  }
  assert.deepEqual(one.unknownChapters, []);
});

test('a chapter id the library no longer holds is reported, not counted', async t => {
  const study = await open(t);
  const whole = await preview(study);
  const [first] = chaptersOf(whole, [3]);
  const mixed = await preview(study, { custom: custom('review', { scope: { kind: 'chapters', chapters: [first, 'gone#9'] } }) });
  const alone = await preview(study, { custom: custom('review', { scope: { kind: 'chapters', chapters: [first] } }) });
  assert.deepEqual(mixed.unknownChapters, ['gone#9']);
  assert.deepEqual(mixed.estimate, alone.estimate);
});

test('only the ticked parts count, a part not made adds nothing, and what a part rests on is counted with it', async t => {
  const study = await open(t);
  const of = async (parts, over = {}) => (await preview(study, { custom: custom('review', { book: book(parts), questions: { ...customDefaults('review').questions, make: false }, ...over }) })).estimate;
  const explain = await of(['explain']), terms = await of(['explain', 'terms']), confusables = await of(['confusables']), kit = await of(['explain', 'answerKit']), sheet = await of(['cheatSheet']);
  assert.ok(explain.book.calls > 0);
  assert.ok(terms.book.calls > explain.book.calls, 'the term cards are a call of their own');
  assert.deepEqual(confusables.book, (await of(['explain', 'terms', 'confusables'])).book, 'confusables is counted with the cards it is made of');
  assert.ok(confusables.book.calls > terms.book.calls, 'and the pairs are asked');
  assert.ok(kit.book.calls > explain.book.calls, 'the answer kit is asked when the course has a sample paper');
  assert.deepEqual(sheet.book, terms.book, 'a cheat sheet alone brings the term cards and nothing of its own');
  assert.equal((await of(['explain', 'formulas', 'index'])).book.calls, explain.book.calls, 'formulas and index are read out of the explanations: no call');
  assert.equal(explain.total.calls, explain.book.calls, 'questions off: the total is the book');
  const bare = await open(t, { paper: false });
  const bareOf = async parts => (await preview(bare, { custom: custom('review', { book: book(parts), questions: { ...customDefaults('review').questions, make: false } }) })).estimate.book;
  assert.deepEqual(await bareOf(['explain', 'answerKit']), await bareOf(['explain']), 'with no sample paper the answer kit adds nothing');
});

test('make:false adds nothing; the plan and variants add no call; the totals are the sums', async t => {
  const study = await open(t);
  const base = customDefaults('review');
  const get = async over => (await preview(study, { custom: custom('review', over) })).estimate;
  const full = await get({}), noBook = await get({ book: { ...base.book, make: false } }), noQuestions = await get({ questions: { ...base.questions, make: false } });
  assert.deepEqual(noBook.book, { points: 0, calls: 0, readTokens: 0 });
  assert.deepEqual(noQuestions.questions, { count: 0, calls: 0, readTokens: 0 });
  assert.equal(noBook.total.calls, full.questions.calls);
  assert.equal(noQuestions.total.calls, full.book.calls);
  assert.equal(full.total.calls, full.book.calls + full.questions.calls);
  assert.equal(full.total.readTokens, full.book.readTokens + full.questions.readTokens);
  assert.deepEqual(await get({ plan: { ...base.plan, make: false } }), full, 'the schedule is the program\'s: no call');
  assert.deepEqual(await get({ questions: { ...base.questions, variants: false } }), full, 'variants are only written once an answer is wrong');
  const nothing = await get({ book: { ...base.book, make: false }, questions: { ...base.questions, make: false } });
  assert.equal(nothing.total.calls, 0);
  assert.equal(nothing.rough, false, 'nothing counted: nothing to be rough about');
  assert.equal(full.rough, true, 'characters, not an inventory: rough');
});

test('the question count follows the strength level of lib/coverage-strength.js, the calls follow the kinds and the batch size', async t => {
  const study = await openBigBook(t);
  const base = customDefaults('review').questions;
  const count = async (strength, kinds = base.kinds) => (await study.call('course.custom.preview', { course: 'Big', custom: custom('review', { book: { ...customDefaults('review').book, make: false },
    questions: { ...base, strength, kinds } }) })).estimate.questions;
  const lean = await count('lean'), standard = await count('standard'), full = await count('full');
  assert.ok(lean.count < standard.count && standard.count < full.count, `${lean.count} < ${standard.count} < ${full.count}`);
  assert.ok(lean.calls < standard.calls && standard.calls < full.calls);
  assert.ok((await count('standard', ['quiz'])).calls < standard.calls, 'one kind is fewer parts than five');
  assert.ok(full.readTokens > 0);
});

test('a plan the record refuses is refused here with the same message; no course says so; nothing is written; no price anywhere', async t => {
  const study = await open(t);
  const before = JSON.stringify(await study.call('export'));
  await assert.rejects(preview(study, { custom: { ...customDefaults('review'), purpose: 'later' } }), /用途需为/);
  await assert.rejects(preview(study, { custom: customDefaults('follow') }), /指定章节需选/, 'a purpose that asks for chapters needs them named before it can be estimated');
  const nothing = await study.call('course.custom.preview', { course: 'No such course' });
  assert.equal(nothing.status, 'no-course');
  assert.deepEqual(nothing.skeleton.documents, []);
  const answer = await preview(study, { custom: custom('openbook') });
  assert.doesNotMatch(JSON.stringify(answer), /price|cost|usd|cny|¥|\$|元|费用|价/i);
  assert.equal(JSON.stringify(await study.call('export')), before, 'reading writes nothing');
});

test('the op is declared read only, the assistant may call it, and the chat\'s contract names it', () => {
  assert.deepEqual(writesFor('library', 'course.custom.preview'), []);
  assert.equal(assistantRefusal('course.custom.preview'), null);
  assert.match(studyToolDescription, /Discovery: [^\n]*source\.pages \(details: book\), course\.custom\.preview \(details: custom\), map/);
  assert.match(studyToolDescription, /areas: [^\n]*custom/, 'a library.context area of its own');
  assert.match(libraryContracts.custom, /course\.custom\.preview \{course\?,custom\?\}/);
  assert.match(libraryContracts.custom, /course\.save \{name\|id, custom\}/);
  for (const id of ['explain', 'terms', 'formulas', 'index', 'confusables', 'answerKit', 'cheatSheet', 'quiz', 'multi', 'flashcard', 'open', 'cloze', 'lean', 'unknownChapters']) assert.ok(libraryContracts.custom.includes(id), id);
  assert.ok(libraryContracts.custom.length < 3000 && libraryContracts.plan.length < 3000, 'each area stays short enough to read in one go');
});
