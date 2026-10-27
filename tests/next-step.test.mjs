/* 3.7 guidance step 3: the one 「下一步」 card on the home. nextStep (ui/study-map/next-step.js) is the whole priority list as a pure function of facts read off the
   snapshot; nextStepFacts reads those facts (local state only: no model call, no daily.plan.get); nextCardView says each state in the voice-and-tone words. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadUi } from './helpers/ui-module.mjs';

const m = await loadUi(`export * from './ui/study-map/next-step.js';
  export { nextCardView } from './ui/study-map/next-card-view.js';
  export { setUiLanguage } from './ui/i18n.js';`);

const NOW = new Date(2026, 9, 28, 10, 0, 0);
const day = (offset) => { const at = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + offset, 9, 0, 0); return at.toISOString(); };
const ymd = (offset) => { const at = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + offset); return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`; };
const READY = { ready: true, reason: 'ok', label: 'DeepSeek' };
const NOTHING = { ready: false, reason: 'no-route', label: '' };
const quiet = { due: 0, weak: 0, new: 0, size: 0, ahead: false };
/** Facts with nothing to do; each row of the table turns on the ones it is about. */
const facts = (patch = {}) => ({ line: { show: false, step: -1 }, modelReady: true, today: { ...quiet }, resumeOpen: false,
  newSources: { count: 0, title: '', sourceIds: [] }, wrong: 0, exam: null, ...patch });

test('the priority list, row by row: the first condition that holds names the one next step', () => {
  const rows = [
    ['no model, nothing else made (the first-run line, step 1)', facts({ line: { show: true, step: 0 }, modelReady: false }), 'model', 'line'],
    ['a model, no material (the line, step 2)', facts({ line: { show: true, step: 1 } }), 'sources', 'line'],
    ['a material, no questions made yet (the line, step 3)', facts({ line: { show: true, step: 2 } }), 'questions', 'line'],
    ['the line outranks reviews that are due (it only shows without a deck of the learner\'s own)', facts({ line: { show: true, step: 2 }, today: { ...quiet, due: 9, size: 9 } }), 'questions', 'line'],
    ['a deck of their own but the model went away', facts({ modelReady: false }), 'model', 'card'],
    ['no model outranks reviews that are due', facts({ modelReady: false, today: { ...quiet, due: 4, size: 4 } }), 'model', 'card'],
    ['reviews due today', facts({ today: { ...quiet, due: 4, size: 6 } }), 'due', 'card'],
    ['reviews due outrank a new material without questions', facts({ today: { ...quiet, due: 1, size: 1 }, newSources: { count: 1, title: 'x', sourceIds: ['s'] } }), 'due', 'card'],
    ['weak and unlearned questions are not "reviews due" (wrong answers have their own state), but they are work: not "done"', facts({ today: { ...quiet, weak: 2, new: 3, size: 5 } }), 'learn', 'card'],
    ['a round of only unlearned questions (the home right after the first deck is published)', facts({ today: { ...quiet, new: 2, size: 2 } }), 'learn', 'card'],
    ['an exam within a week outranks a round that only has weak or unlearned questions', facts({ today: { ...quiet, new: 2, size: 2 }, exam: { course: '数据库', days: 3 } }), 'exam', 'card'],
    ['wrong answers outrank a round of only unlearned questions', facts({ today: { ...quiet, new: 2, size: 2 }, wrong: 3 }), 'wrong', 'card'],
    ['practising ahead of a finished day is "done"', facts({ today: { ...quiet, size: 4, ahead: true } }), 'done', 'card'],
    ['a round left open and nothing due', facts({ resumeOpen: true }), 'resume', 'card'],
    ['a round left open and reviews due: the due reviews name the situation (the button is the same 接着做)', facts({ resumeOpen: true, today: { ...quiet, due: 2, size: 2 } }), 'due', 'card'],
    ['an open round outranks a new material', facts({ resumeOpen: true, newSources: { count: 1, title: 'x', sourceIds: ['s'] } }), 'resume', 'card'],
    ['a newly imported material without questions', facts({ newSources: { count: 2, title: 'a', sourceIds: ['a', 'b'] } }), 'new-source', 'card'],
    ['a new material outranks wrong answers', facts({ newSources: { count: 1, title: 'a', sourceIds: ['a'] }, wrong: 7 }), 'new-source', 'card'],
    ['wrong answers not yet reviewed', facts({ wrong: 7 }), 'wrong', 'card'],
    ['wrong answers outrank an exam within a week', facts({ wrong: 7, exam: { course: '数据库', days: 3 } }), 'wrong', 'card'],
    ['an exam within a week', facts({ exam: { course: '数据库', days: 3 } }), 'exam', 'card'],
    ['nothing left', facts(), 'done', 'card'],
  ];
  for (const [label, given, id, surface] of rows) assert.deepEqual(m.nextStep(given), { id, surface }, label);
});

test('turning the conditions off one at a time walks the whole list in its fixed order', () => {
  const all = facts({ line: { show: false, step: -1 }, modelReady: false, today: { due: 2, weak: 1, new: 1, size: 4, ahead: false }, resumeOpen: true,
    newSources: { count: 1, title: 'a', sourceIds: ['a'] }, wrong: 3, exam: { course: 'x', days: 2 } });
  const seen = [];
  const off = [(f) => ({ ...f, modelReady: true }), (f) => ({ ...f, today: { ...f.today, due: 0 } }), (f) => ({ ...f, resumeOpen: false }),
    (f) => ({ ...f, newSources: { count: 0, title: '', sourceIds: [] } }), (f) => ({ ...f, wrong: 0 }), (f) => ({ ...f, exam: null }),
    (f) => ({ ...f, today: { ...quiet } })];
  let current = all;
  seen.push(m.nextStep(current).id);
  for (const turn of off) { current = turn(current); seen.push(m.nextStep(current).id); }
  assert.deepEqual(seen, ['model', 'due', 'resume', 'new-source', 'wrong', 'exam', 'learn', 'done']);
  assert.deepEqual(m.NEXT_STEP_IDS, ['model', 'sources', 'questions', 'due', 'resume', 'new-source', 'wrong', 'exam', 'learn', 'done'], 'the ids, in priority order (the first three are the first-run line)');
  assert.deepEqual(m.FIRST_RUN_SURFACE, ['model', 'sources', 'questions'], 'the line\'s three steps are the first three states');
});

test('only the states with something to press carry a primary button', () => {
  for (const id of ['model', 'due', 'resume', 'new-source', 'wrong', 'exam', 'learn']) assert.equal(m.hasPrimaryAction(id), true, id);
  assert.equal(m.hasPrimaryAction('done'), false);
  assert.equal(m.hasPrimaryAction('questions'), false, 'the line draws its own button');
});

/* ---------- the facts ---------- */

const library = (patch = {}) => ({ root: '/lib', model: READY, decks: [{ id: 'd1', title: 'D', course: 'A', wrong: 0 }], sources: [], drafts: [], jobs: [], courses: [], today: { ...quiet }, ...patch });
const mine = (id, extra = {}) => ({ id, title: `资料 ${id}`, createdAt: day(-2), usedBy: [], ...extra });

test('newly imported material without questions: recent, the learner\'s own, not archived, not cited, not being made', () => {
  const data = library({ sources: [
    mine('new1'), mine('new2', { createdAt: day(-13) }),
    mine('old', { createdAt: day(-30) }), mine('used', { usedBy: [{ kind: 'deck', id: 'd1', title: 'D' }] }), mine('drafted', { usedBy: [{ kind: 'draft', id: 'dr' }] }),
    mine('gone', { archived: true }), mine('sample-s', { sample: true }), mine('running'), mine('undated', { createdAt: undefined }),
  ], jobs: [{ id: 'j', type: 'generate', status: 'running', sourceIds: ['running'] }] });
  const f = m.nextStepFacts(data, { now: NOW });
  assert.deepEqual(f.newSources.sourceIds.sort(), ['new1', 'new2']);
  assert.equal(f.newSources.count, 2);
  assert.equal(f.newSources.title, '资料 new1', 'the newest one names a single material');
  const covered = m.nextStepFacts(library({ sources: [mine('new1')], materialCoverage: { 'source:new1': { leaves: 3 } } }), { now: NOW });
  assert.equal(covered.newSources.count, 0, 'a material whose text already has questions (coverage) is not new');
  const finished = m.nextStepFacts(library({ sources: [mine('new1')], jobs: [{ id: 'j', type: 'generate', status: 'done', sourceIds: ['new1'] }] }), { now: NOW });
  assert.equal(finished.newSources.count, 1, 'a run that ended does not hold the material back');
  const pdf = m.nextStepFacts(library({ sources: [1, 2, 3].map((page) => mine(`p${page}`, { title: `讲义.pdf · p.${page}`, text: 'x', document: { id: 'h'.repeat(64), page, format: 'pdf', totalPages: 3 } })) }), { now: NOW });
  assert.equal(pdf.newSources.count, 1, 'a PDF is one material, not one per page');
});

test('wrong answers not yet reviewed are the 待巩固 of the decks the learner practises with', () => {
  const data = library({ decks: [{ id: 'a', wrong: 3 }, { id: 'b', wrong: 2 }, { id: 'c', wrong: 9, archived: true }, { id: 'd', wrong: 9, sample: true },
    { id: 'e', wrong: 9, inactive: true }, { id: 'f' }] });
  assert.equal(m.nextStepFacts(data, { now: NOW }).wrong, 5);
  assert.equal(m.nextStepFacts(data, { now: NOW, canWrong: false }).wrong, 0, 'no wrong-answers page, no card pointing at it');
});

test('an exam within a week: the nearest one of a course that is in use and has a review book', () => {
  const course = (name, offset, extra = {}) => ({ name, exam: { date: ymd(offset) }, ...extra });
  const books = ['远', '近', '更近', '停用', '已过', '没设日期', '今天', '第七天', '第八天'];
  const data = library({ bookCourses: books, courses: [course('远', 10), course('近', 5), course('更近', 2), course('停用', 1, { active: false }), course('已过', -1), { name: '没设日期' }, course('今天', 0, { active: false })] });
  assert.deepEqual(m.nextStepFacts(data, { now: NOW }).exam, { course: '更近', days: 2 });
  assert.deepEqual(m.nextStepFacts(library({ bookCourses: books, courses: [course('今天', 0)] }), { now: NOW }).exam, { course: '今天', days: 0 });
  assert.deepEqual(m.nextStepFacts(library({ bookCourses: books, courses: [course('第七天', 7)] }), { now: NOW }).exam, { course: '第七天', days: 7 }, 'a week is seven days, inclusive');
  assert.equal(m.nextStepFacts(library({ bookCourses: books, courses: [course('第八天', 8)] }), { now: NOW }).exam, null);
  assert.equal(m.nextStepFacts(data, { now: NOW, canExam: false }).exam, null, 'no review book page, no card pointing at it');
});

test('an exam near a course without a review book is no card: the book page would only say there is no outline yet', () => {
  const course = (name, offset) => ({ name, exam: { date: ymd(offset) } });
  const data = library({ bookCourses: ['有书'], courses: [course('没有书', 1), course('有书', 4)] });
  assert.deepEqual(m.nextStepFacts(data, { now: NOW }).exam, { course: '有书', days: 4 }, 'the nearer exam has no book, so the one that has one is named');
  assert.equal(m.nextStepFacts(library({ courses: [course('没有书', 1)] }), { now: NOW }).exam, null, 'a snapshot without bookCourses has no book to open');
  assert.equal(m.nextStepFacts(library({ bookCourses: [], courses: [course('没有书', 1)] }), { now: NOW }).exam, null);
  assert.deepEqual(m.nextStep(m.nextStepFacts(library({ bookCourses: [], courses: [course('没有书', 1)], today: { due: 0, weak: 0, new: 2, size: 2, ahead: false } }), { now: NOW })),
    { id: 'learn', surface: 'card' }, 'with no book the day\'s work is what the card says');
});

test('the facts come from the snapshot alone: the model, today, and the first-run line', () => {
  const f = m.nextStepFacts(library({ model: NOTHING, today: { due: 3, weak: 1, new: 2, size: 6, ahead: false } }), { now: NOW, resumeOpen: true });
  assert.equal(f.modelReady, false);
  assert.deepEqual(f.today, { due: 3, weak: 1, new: 2, size: 6, ahead: false });
  assert.equal(f.resumeOpen, true);
  assert.deepEqual(f.line, { show: false, step: -1 }, 'a deck of their own: no first-run line');
  const empty = m.nextStepFacts({ root: '/lib', model: NOTHING, decks: [], sources: [], drafts: [], jobs: [] }, { now: NOW });
  assert.deepEqual(empty.line, { show: true, step: 0 });
  assert.deepEqual(m.nextStep(empty), { id: 'model', surface: 'line' });
  assert.equal(m.nextStepFacts(library({ today: undefined }), { now: NOW }).today.size, 0, 'a snapshot without today counts as nothing to do');
});

/* ---------- the words ---------- */

const plan = (label = '开始今日学习', run = () => {}, detail = '3 题到期 · 2 题薄弱 · 10 题未学') => ({ kind: 'resume', detail, action: { label, run } });
const BANNED = /啦|哎呀|～|主对话|暂无|稍后再试|您/;

test('each state names the situation with a fact and has one action (the done state none)', () => {
  m.setUiLanguage('zh');
  const calls = [];
  /* The home's own card offers a DIFFERENT round (接着做, left open); today's own button is handlers.today: the card's fact and its button must be about the same thing. */
  const handlers = { plan: plan('接着做', () => calls.push('other-run'), '已做到第 3 / 10 题'), today: { label: '开始今日学习', run: () => calls.push('path') }, generate: (ids) => calls.push(['generate', ids]), wrong: () => calls.push('wrong'), exam: (course) => calls.push(['exam', course]),
    modelSettings: () => calls.push('model'), settingsLabel: '前往设置' };
  const view = (given) => m.nextCardView(m.nextStep(given).id, given, handlers);
  const due = view(facts({ today: { due: 12, weak: 2, new: 5, size: 19, ahead: false } }));
  assert.equal(due.eyebrow, '下一步');
  assert.equal(due.headline, '今天有 12 题到期');
  assert.equal(due.action.label, '开始今日学习', "the fact is about today's questions, so the button starts today's round, not whatever else the day's card resumes");
  due.action.run();
  const open = view(facts({ resumeOpen: true }));
  assert.match(open.headline, /练习没做完/);
  assert.equal(open.action.label, '接着做', "the open round is what the day's card resumes: the same button");
  assert.equal(open.detail, '已做到第 3 / 10 题');
  const learn = view(facts({ today: { ...quiet, weak: 1, new: 2, size: 3 } }));
  assert.equal(learn.headline, '今天有 3 题待学');
  assert.equal(learn.detail, '1 题薄弱 · 2 题未学');
  assert.equal(learn.action.label, '开始今日学习');
  learn.action.run();
  assert.equal(view(facts({ today: { ...quiet, new: 2, size: 2 } })).detail, '2 题未学');
  assert.equal(m.nextCardView('due', facts({ today: { ...quiet, due: 2, size: 2 } }), { plan: plan('接着做') }).action.label, '接着做', "without a separate today button the day's card button is used");
  const fresh = view(facts({ newSources: { count: 1, title: '第3讲 进程与线程', sourceIds: ['a'] } }));
  assert.equal(fresh.headline, '「第3讲 进程与线程」还没出过题');
  assert.equal(fresh.action.label, '用这份资料出题');
  fresh.action.run();
  const several = view(facts({ newSources: { count: 3, title: 'x', sourceIds: ['a', 'b', 'c'] } }));
  assert.equal(several.headline, '3 份新资料还没出过题');
  assert.equal(several.action.label, '用这 3 份新资料出题');
  const wrong = view(facts({ wrong: 7 }));
  assert.equal(wrong.headline, '有 7 题待巩固');
  assert.equal(wrong.action.label, '看错题与待巩固');
  wrong.action.run();
  const exam = view(facts({ exam: { course: '数据库', days: 3 } }));
  assert.equal(exam.headline, '「数据库」3 天后考试');
  assert.equal(exam.action.label, '打开复习全书');
  exam.action.run();
  assert.equal(view(facts({ exam: { course: '数据库', days: 0 } })).headline, '「数据库」今天考试');
  assert.equal(view(facts({ exam: { course: '数据库', days: 1 } })).headline, '「数据库」明天考试');
  const model = view(facts({ modelReady: false }));
  assert.equal(model.headline, '还没有可用的 AI 模型');
  assert.equal(model.action.label, '前往设置');
  model.action.run();
  const done = view(facts({ today: { ...quiet, ahead: true, size: 4 } }));
  assert.equal(done.headline, '今天的任务都完成了');
  assert.equal(done.action, null);
  assert.deepEqual(calls, ['path', 'path', ['generate', ['a']], 'wrong', ['exam', '数据库'], 'model']);
  for (const shown of [due, open, learn, fresh, several, wrong, exam, model, done]) {
    assert.doesNotMatch(`${shown.headline} ${shown.detail}`, BANNED, shown.headline);
    assert.doesNotMatch(`${shown.headline} ${shown.detail}`, /!|！/, 'no exclamation mark: none of these is a real piece of good news');
  }
});

test('the card never leans on the learner: facts and a next step, no guilt about a day missed', () => {
  m.setUiLanguage('zh');
  const view = m.nextCardView('due', facts({ today: { due: 30, weak: 0, new: 0, size: 30, ahead: false } }), { plan: plan(), settingsLabel: '前往设置' });
  assert.doesNotMatch(`${view.headline} ${view.detail}`, /落下|又断|还没学|久没|赶紧|快/);
});

test('every sentence has its English pair, with the placeholders kept', async () => {
  const pairs = JSON.parse(await readFile(new URL('../ui/locales/en.next-step.json', import.meta.url), 'utf8'));
  m.setUiLanguage('en');
  const handlers = { plan: plan('Start today', () => {}, 'Reached question 3 / 10'), today: { label: 'Start today', run() {} }, generate() {}, wrong() {}, exam() {}, modelSettings() {}, settingsLabel: 'Open settings' };
  const views = [
    m.nextCardView('due', facts({ today: { due: 12, weak: 2, new: 5, size: 19, ahead: false } }), handlers),
    m.nextCardView('resume', facts({ resumeOpen: true }), handlers),
    m.nextCardView('new-source', facts({ newSources: { count: 1, title: 'Lecture 3', sourceIds: ['a'] } }), handlers),
    m.nextCardView('new-source', facts({ newSources: { count: 3, title: 'x', sourceIds: ['a', 'b', 'c'] } }), handlers),
    m.nextCardView('wrong', facts({ wrong: 7 }), handlers),
    m.nextCardView('exam', facts({ exam: { course: 'Databases', days: 3 } }), handlers),
    m.nextCardView('exam', facts({ exam: { course: 'Databases', days: 0 } }), handlers),
    m.nextCardView('exam', facts({ exam: { course: 'Databases', days: 1 } }), handlers),
    m.nextCardView('model', facts({ modelReady: false }), handlers),
    m.nextCardView('done', facts({ today: { ...quiet, ahead: true } }), handlers),
    m.nextCardView('done', facts(), handlers),
    m.nextCardView('learn', facts({ today: { ...quiet, weak: 1, new: 2, size: 3 } }), handlers),
  ];
  for (const shown of views) for (const sentence of [shown.eyebrow, shown.headline, shown.detail, shown.action?.label].filter(Boolean))
    assert.doesNotMatch(sentence, /[㐀-鿿]/, `English UI, no Chinese left: ${sentence}`);
  assert.equal(views[0].headline, '12 due today');
  assert.equal(views[2].headline, '“Lecture 3” has no questions yet');
  assert.equal(views[7].headline, '“Databases” exam is tomorrow');
  assert.equal(views[11].headline, '3 to study today');
  assert.ok(Object.keys(pairs).length > 10, 'the pairs live in ui/locales/en.next-step.json');
  for (const [zh, en] of Object.entries(pairs)) assert.deepEqual(zh.match(/\{\d\}/g)?.sort() ?? [], en.match(/\{\d\}/g)?.sort() ?? [], `placeholders kept: ${zh}`);
  m.setUiLanguage('zh');
});
