import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUi } from './helpers/ui-module.mjs';
import { library, pointList, buildJob, snapshot } from './helpers/exam-prep-fixtures.mjs';

/* 备考补习, the short create form, its pure part: it opens already filled in (roles, course, name), a role changes in one call, the request carries a
   default name, and a build with no course is shown where its list will be. Fakes only. */

const ui = await loadUi(`
  export * from './ui/exam-prep/model.js';
  export * from './ui/exam-prep/form.js';
  export { setUiLanguage } from './ui/i18n.js';`);
const english = fn => { ui.setUiLanguage('en'); try { return fn(); } finally { ui.setUiLanguage('zh'); } };
const KNOWN = ['网络', '数据库'];
const NOW = new Date('2026-10-08T12:00:00');
const withoutOther = () => library().filter(source => source.id !== 'other-1');
const open = (data, scope = data.focus.course) => ui.openingForm(data, { scope, known: KNOWN });

/* ---------- the opening state ---------- */

test('the form opens filled in: roles from the names and sizes, the course of the page, no name asked', () => {
  const form = open(snapshot({ lists: [] }));
  assert.deepEqual(form.picks.lecture, ['传输层-1', '传输层-2', '传输层-3', '传输层-4', '传输层-6', 'paper-2'], 'the deck and the paper nothing marks');
  assert.deepEqual(form.picks['past-paper'], ['paper-1'], '样卷 in the name');
  assert.deepEqual(form.picks.syllabus, ['syllabus-1'], '大纲 in the name');
  assert.equal(form.course, '网络');
  assert.equal(form.askCourse, false);
  assert.equal(form.title, '', 'the name is the placeholder of the fold, not an input to fill');
  assert.equal(form.language, 'auto');
  assert.equal(form.others, false);
  assert.ok(![...form.picks.lecture, ...form.picks['past-paper'], ...form.picks.syllabus].includes('other-1'), 'another course\'s material is not picked');
});

test('the learner\'s defaults of the Settings page shape the opening state: auto roles, own paper words, language, other courses', () => {
  const off = open(snapshot({ lists: [], examPrep: { autoRoles: false } }));
  assert.deepEqual(off.picks['past-paper'], []);
  assert.deepEqual(off.picks.syllabus, []);
  assert.ok(off.picks.lecture.includes('paper-1') && off.picks.lecture.includes('syllabus-1'), 'everything starts as slides');
  const words = open(snapshot({ lists: [], examPrep: { paperWords: ['卷子'] } }));
  assert.deepEqual(words.picks['past-paper'].sort(), ['paper-1', 'paper-2']);
  const other = open(snapshot({ lists: [], examPrep: { language: 'en', showOtherCourses: true } }));
  assert.equal(other.language, 'en');
  assert.equal(other.others, true);
  assert.ok(!other.picks.lecture.includes('other-1'), 'shown, not picked');
});

test('a material the course marks as its guidance is taken for the syllabus', () => {
  const data = snapshot({ lists: [], courseRecords: [{ id: 'c1', name: '网络', guidanceSourceIds: ['paper-2'], focusTopics: [] }] });
  assert.deepEqual(open(data).picks.syllabus.sort(), ['paper-2', 'syllabus-1']);
});

test('the course: the page\'s, else the common course of the slides, else the only course of the library, else asked once', () => {
  assert.equal(open(snapshot({ lists: [], course: '' }), '*').course, '', 'two courses of slides: no common course');
  assert.equal(open(snapshot({ lists: [], course: '' }), '*').askCourse, true);
  const alone = snapshot({ lists: [], course: '', sources: withoutOther() });
  assert.equal(open(alone, '*').course, '网络', 'the slides share one course');
  assert.equal(open(alone, '*').askCourse, false);
  const unfiled = snapshot({ lists: [], course: '', courses: ['网络'], sources: library([]).filter(source => source.id !== 'other-1') });
  assert.equal(open(unfiled, '*').course, '网络', 'the library has exactly one course');
  const none = snapshot({ lists: [], course: '', courses: [], sources: library([]).filter(source => source.id !== 'other-1') });
  assert.equal(open(none, '*').course, '');
  assert.equal(open(none, '*').askCourse, false, 'nothing to choose from: not asked');
  assert.equal(open(snapshot({ lists: [] }), '数据库').course, '数据库', 'the page\'s course wins');
});

test('the default name: the course name, else the first slides, with the date when the course already has a list of that name', () => {
  const data = snapshot({ lists: [] });
  const items = ui.documentsOf(data.sources);
  const form = open(data);
  assert.equal(ui.defaultTitle(form, items, data, NOW), '网络 考点清单');
  assert.equal(ui.defaultTitle({ ...form, course: '' }, items, data, NOW), '传输层 考点清单', 'the first slides');
  assert.equal(ui.defaultTitle({ ...form, course: '', picks: { lecture: [], 'past-paper': [], syllabus: [] } }, items, data, NOW), '考点清单');
  const taken = snapshot({ lists: [pointList({ title: '网络 考点清单' })] });
  assert.equal(ui.defaultTitle(form, items, taken, NOW), '网络 考点清单 · 2026-10-08');
  const otherCourse = snapshot({ lists: [pointList({ title: '网络 考点清单', courses: ['数据库'] })] });
  assert.equal(ui.defaultTitle(form, items, otherCourse, NOW), '网络 考点清单', 'a list of another course does not count');
  english(() => assert.equal(ui.defaultTitle(form, items, data, NOW), '网络 exam-point list'));
});

/* ---------- roles ---------- */

test('a role change is one call: the document leaves its old role, and the counts follow', () => {
  const data = snapshot({ lists: [] });
  const items = ui.documentsOf(data.sources);
  const deck = items.find(item => item.title === '传输层.pptx'), paper = items.find(item => item.title === '老师给的样卷');
  let picks = open(data).picks;
  assert.deepEqual(ui.roleCounts(items, picks), { lecture: 2, 'past-paper': 1, syllabus: 1 });
  picks = ui.assignRole(picks, paper, 'lecture');
  assert.equal(ui.roleOf(paper, picks), 'lecture');
  assert.deepEqual(picks['past-paper'], []);
  assert.deepEqual(ui.roleCounts(items, picks), { lecture: 3, 'past-paper': 0, syllabus: 1 });
  picks = ui.assignRole(picks, paper, 'none');
  assert.equal(ui.roleOf(paper, picks), 'none');
  assert.ok(!Object.values(picks).flat().includes('paper-1'));
  picks = ui.assignRole(picks, deck, 'past-paper', ['传输层-1', '传输层-2']);
  assert.deepEqual(picks['past-paper'], ['传输层-1', '传输层-2'], 'only the pages chosen');
  assert.ok(!picks.lecture.includes('传输层-1') && picks.lecture.includes('paper-2'));
  assert.equal(ui.roleOf(deck, picks), 'past-paper');
  assert.deepEqual(ui.assignIds(picks, ['paper-9', 'paper-2'], 'past-paper')['past-paper'].slice(-2), ['paper-9', 'paper-2'], 'imported papers');
  assert.ok(!ui.assignIds(picks, ['paper-2'], 'past-paper').lecture.includes('paper-2'));
});

test('the pool is the course and the unfiled materials, all courses on request, and whatever is picked stays', () => {
  const data = snapshot({ lists: [], sources: [...library(), { id: 'loose', title: '没分课程的笔记', text: 'n', createdAt: '2026-10-01T08:00:00.000Z', courses: [], chars: 1 }] });
  const items = ui.documentsOf(data.sources);
  const titles = pool => pool.map(item => item.title);
  assert.ok(!titles(ui.poolOf(items, { course: '网络', others: false, picked: new Set(), known: KNOWN })).includes('别的课的讲义'));
  assert.ok(titles(ui.poolOf(items, { course: '网络', others: false, picked: new Set(), known: KNOWN })).includes('没分课程的笔记'), 'unfiled');
  assert.ok(titles(ui.poolOf(items, { course: '网络', others: true, picked: new Set(), known: KNOWN })).includes('别的课的讲义'));
  assert.ok(titles(ui.poolOf(items, { course: '网络', others: false, picked: new Set(['other-1']), known: KNOWN })).includes('别的课的讲义'), 'picked: stays');
  assert.equal(ui.poolOf(items, { course: '', others: false, picked: new Set(), known: KNOWN }).length, items.length, 'no course: everything');
  const archived = [{ ...library()[5], id: 'old-1', title: '旧资料', archived: true }];
  const old = ui.documentsOf([...library(), ...archived]);
  assert.ok(!ui.poolOf(old, { course: '网络', picked: new Set(), known: KNOWN }).some(item => item.title === '旧资料'), 'archived: hidden');
  assert.ok(ui.poolOf(old, { course: '网络', picked: new Set(['old-1']), known: KNOWN }).some(item => item.title === '旧资料'), 'unless a rebuild still uses it');
  assert.ok(!Object.values(open(snapshot({ lists: [], sources: [...library(), ...archived] })).picks).flat().includes('old-1'), 'and never suggested'); 
});

/* ---------- the request ---------- */

test('the name is not required: the request sends the default, a typed name wins, and the form is ready with slides alone', () => {
  assert.deepEqual(ui.formProblems({ picks: { lecture: ['a'] } }), []);
  assert.deepEqual(ui.formProblems({ picks: { lecture: [] } }), ['lecture']);
  assert.deepEqual(ui.formProblems({ picks: { lecture: [], syllabus: ['s'] } }), []);
  const sources = library();
  const form = { title: '', course: '网络', picks: { lecture: ['传输层-1'], 'past-paper': [], syllabus: [] } };
  assert.equal(ui.buildRequest(form, sources, { defaultTitle: '网络 考点清单' }).title, '网络 考点清单');
  assert.equal(ui.buildRequest({ ...form, title: ' 我的清单 ' }, sources, { defaultTitle: '网络 考点清单' }).title, '我的清单');
  assert.equal(ui.buildRequest(form, sources, { language: 'en' }).language, 'en');
});

/* ---------- builds without a course ---------- */

test('a build with no course is shown where the list it will make is shown: all courses and uncategorised, not under a course', () => {
  const builds = ui.buildsOf(snapshot({ jobs: [buildJob({ id: 'net', course: '网络' }), buildJob({ id: 'none', course: null }), buildJob({ id: 'db', course: '数据库' })] }));
  const ids = scope => ui.buildsInScope(builds, scope, KNOWN).map(build => build.jobId).sort();
  assert.deepEqual(ids('*'), ['db', 'net', 'none']);
  assert.deepEqual(ids(''), ['none']);
  assert.deepEqual(ids('网络'), ['net']);
});
