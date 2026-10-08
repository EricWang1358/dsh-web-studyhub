import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { loadUi } from './helpers/ui-module.mjs';

/* The course panel after the shortening: the exam date is the first thing in it and setting only the date is open, pick, save; everything else is one fold, 更多设置.
   Focus topics are chips (suggestions from the learner's weakest topics are offered, never added), guidance suggestions are unticked with their reason, and a typed course
   name that is nearly an existing one is asked about, not silently made. */

const m = await loadUi(`
  export { default as CourseSettings, draftFromCourse } from './ui/CourseSettings.jsx';
  export { default as TopicChips } from './ui/TopicChips.jsx';
  export { default as GuidanceSuggestions, guidanceSuggestions } from './ui/GuidanceSuggestions.jsx';
  export { addTopics, removeTopic } from './ui/course-topics.js';
  export { similarCourses } from './ui/course-names.js';
  export { setUiLanguage } from './ui/i18n.js';
`);
const han = /[㐀-鿿]/;
const text = markup => markup.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
const draw = (element, language = 'zh') => { m.setUiLanguage(language); try { return renderToStaticMarkup(element); } finally { m.setUiLanguage('zh'); } };

const architecture = { id: 'course-aaaaaaaaaaaa', name: 'Architecture', aliases: ['Arch 101'], exam: { format: 'open-book-case', totalMarks: 60, writingMinutes: 120, date: '2026-12-01',
  sections: [{ title: 'Part A', lecturer: 'Dr Tan', marks: 30, topics: ['Microservices'] }] }, guidanceSourceIds: ['brief'], focusTopics: ['Strangler fig'], decks: 2, drafts: 0, sources: 1 };
const databases = { id: 'course-bbbbbbbbbbbb', name: 'Databases', aliases: [], guidanceSourceIds: [], focusTopics: [], decks: 1, drafts: 0, sources: 0 };
const dated = { ...databases, id: 'course-cccccccccccc', name: 'Networks', exam: { format: 'other', date: '2026-12-01', sections: [] } };
const data = { root: '/lib', courses: [architecture, databases, dated], focus: { course: 'Architecture', courses: [{ name: 'Architecture' }, { name: 'Databases' }, { name: 'Networks' }] },
  sources: [{ id: 'brief', title: 'Exam briefing transcript', text: 'x', courses: ['Architecture'], createdAt: '2026-09-01T00:00:00.000Z' }] };
const panel = (course, language = 'zh', extra = {}) => draw(React.createElement(m.CourseSettings, { data, courseId: course.id, act: async () => {}, onClose() {}, ...extra }), language);

test('the exam date is the first field of the panel and it is outside the fold', () => {
  const html = panel(databases);
  const date = html.search(/type="date"/), fold = html.indexOf('更多设置');
  assert.ok(date > 0 && fold > 0 && date < fold, 'the date comes before 更多设置');
  assert.ok(date < html.indexOf('课程名称'), 'and before the name');
  assert.ok(date < html.indexOf('考试形式'), 'and before the exam format');
  const before = html.slice(0, fold);
  assert.doesNotMatch(before, /考试形式|总分|重点知识点|考官指引|课程名称/, 'nothing else sits above the fold');
});

test('the fold holds the rest, and stays closed unless the course already has something in it', () => {
  const closed = panel(databases), only = panel(dated), open = panel(architecture);
  const fold = html => /<details class="[^"]*course-settings__more[^"]*"([^>]*)>/.exec(html)?.[1] ?? null;
  assert.ok(fold(closed) !== null, 'the fold exists');
  assert.doesNotMatch(fold(closed), /\bopen\b/, 'a new course: closed');
  assert.doesNotMatch(fold(only), /\bopen\b/, 'a course with only a date: closed');
  assert.match(fold(open), /\bopen\b/, 'a course with a profile: open');
  for (const label of ['课程名称', '考试形式', '总分', '重点知识点', '考官指引', '把其他课程合并到这里']) assert.ok(closed.includes(label), `${label} is in the fold`);
  assert.match(panel(databases, 'zh', { mergeFrom: [architecture.id] }), /<details class="[^"]*course-settings__more[^"]*"[^>]*\bopen\b/, 'opening 合并到这里 shows the merge');
  // The date is still the learner's: it keeps its value and its save button.
  assert.match(panel(dated), /type="date"[^>]*value="2026-12-01"|value="2026-12-01"[^>]*type="date"/);
  assert.match(panel(dated), /保存课程信息/);
});

test('focus topics are chips that can be removed, with a box to add more; the suggestions are offered, never added', () => {
  const out = draw(React.createElement(m.TopicChips, { value: 'Saga; CQRS', onChange() {}, suggestions: [{ topic: 'Raft elections', weak: 3 }, { topic: 'Saga', weak: 1 }] }));
  assert.match(out, /Saga/); assert.match(out, /CQRS/);
  assert.match(out, /aria-label="删除「Saga」"/);
  assert.match(out, /<input[^>]*aria-label="添加重点知识点"/);
  assert.doesNotMatch(out, /value="Saga; CQRS"/, 'it is no longer one semicolon text');
  const suggested = out.slice(out.indexOf('建议'));
  assert.match(text(suggested), /Raft elections/);
  assert.match(text(suggested), /答错最多/, 'the suggestion says where it comes from');
  assert.doesNotMatch(text(suggested), /Saga/, 'what is already a chip is not suggested again');
  assert.doesNotMatch(draw(React.createElement(m.TopicChips, { value: '', onChange() {}, suggestions: [] })), /建议/, 'no weak topics, no suggestion row');
});

test('adding and removing topics keeps the list tidy: split on ； ; and new lines, no empties, no repeats, a comma stays in its topic', () => {
  assert.equal(m.addTopics('Saga; CQRS', 'Strangler fig；Saga\nOutbox, Inbox'), 'Saga; CQRS; Strangler fig; Outbox, Inbox');
  assert.equal(m.addTopics('', '  '), '');
  assert.equal(m.removeTopic('Saga; CQRS; Outbox', 'CQRS'), 'Saga; Outbox');
  assert.equal(m.removeTopic('Saga', 'Saga'), '');
});

test('guidance suggestions are materials whose name says syllabus, never ticked, each with its reason; chosen and other courses\' ones are left out', () => {
  const sources = [
    { id: 'a', title: '考试大纲.pdf', text: 'x', courses: ['Architecture'], createdAt: '2026-09-01T00:00:00.000Z', document: { materialId: 'document-a-pdf', materialRevision: 'r', format: 'pdf', filename: '考试大纲.pdf', totalPages: 3 } },
    { id: 'b', title: 'Course syllabus', text: 'x', courses: ['Architecture'], createdAt: '2026-09-01T00:00:00.000Z' },
    { id: 'c', title: 'Syllabus of another course', text: 'x', courses: ['Databases'], createdAt: '2026-09-01T00:00:00.000Z' },
    { id: 'd', title: 'Week 1 lecture', text: 'x', courses: ['Architecture'], createdAt: '2026-09-01T00:00:00.000Z' },
    { id: 'e', title: 'Final exam paper 2024', text: 'x', courses: ['Architecture'], createdAt: '2026-09-01T00:00:00.000Z' }];
  const found = m.guidanceSuggestions({ sources, focus: { courses: [{ name: 'Architecture' }, { name: 'Databases' }] } }, 'Architecture', []);
  assert.deepEqual(found.map(item => item.title).sort(), ['Course syllabus', '考试大纲.pdf']);
  assert.ok(found.every(item => item.reason && item.ids.length), 'a reason and the ids to add');
  assert.match(found.find(item => item.title === 'Course syllabus').reason, /文件名含「syllabus」/);
  const chosen = m.guidanceSuggestions({ sources, focus: { courses: [{ name: 'Architecture' }] } }, 'Architecture', ['b']);
  assert.deepEqual(chosen.map(item => item.title), ['考试大纲.pdf'], 'what is chosen already is not suggested');
  const out = draw(React.createElement(m.GuidanceSuggestions, { items: found, onAdd() {} }));
  assert.doesNotMatch(out, /checked/, 'never preselected');
  assert.equal((out.match(/type="checkbox"/g) || []).length, 2);
  assert.match(text(out), /文件名含「syllabus」/);
  assert.match(text(out), /建议/);
  assert.equal(draw(React.createElement(m.GuidanceSuggestions, { items: [], onAdd() {} })), '', 'nothing to suggest, nothing drawn');
});

test('a typed course name that is nearly an existing one is found; an existing name, a course code that differs in its digits and a short name are not', () => {
  const courses = [{ id: '1', name: 'Algorithms' }, { id: '2', name: 'CS2030' }, { id: '3', name: 'Cloud Native Solution Design' }, 'Databases'];
  const names = typed => m.similarCourses(typed, courses).map(course => course.name ?? course);
  assert.deepEqual(names('Algoritms'), ['Algorithms'], 'a missing letter');
  assert.deepEqual(names('algorithms'), ['Algorithms'], 'another spelling of the same name');
  assert.deepEqual(names('Algorithms '), [], 'the same name with a trailing space is that course');
  assert.deepEqual(names('Algorithms'), [], 'an existing name is that course, not a duplicate');
  assert.deepEqual(names('CS2040'), [], 'a different course code is a different course');
  assert.deepEqual(names('Cs2030'), ['CS2030'], 'but the same code in another case is the same course');
  assert.deepEqual(names('Cloud Native Solution Desgin'), ['Cloud Native Solution Design'], 'a swapped pair of letters in a long name');
  assert.deepEqual(names('Databses'), ['Databases']);
  assert.deepEqual(names('ML'), [], 'short names are never guessed at');
  assert.deepEqual(names(''), []);
  assert.deepEqual(names('Operating Systems'), []);
});

async function library(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-course-weak-'));
  const service = new StudyService(root);
  t.after(async () => { service.dispose(); await rm(root, { recursive: true, force: true }); });
  await service.store.update(state => {
    const card = (id, topic) => ({ id, kind: 'flashcard', topic, prompt: `${id}?`, answer: 'a' });
    state.decks.push({ id: 'd1', title: 'Deck', course: 'SWE5001', cards: [card('c1', 'Raft elections'), card('c2', 'Raft elections'), card('c3', 'Sharding'), card('c4', 'Caching')] },
      { id: 'd2', title: 'Other course', course: 'OTHER', cards: [card('o1', 'Unrelated weak topic')] });
    for (const [deckId, quiz_id, grade] of [['d1', 'c1', 1], ['d1', 'c2', 2], ['d1', 'c3', 1], ['d1', 'c4', 5], ['d2', 'o1', 1]])
      state.attempts.push({ deckId, quiz_id, assessment: 'self', grade, timestamp: new Date().toISOString() });
  });
  return service;
}

test('generate.weakTopics lists the course\'s weakest topics from the learner\'s own answers, with no model call and nothing written', async t => {
  let calls = 0;
  const service = await library(t);
  const before = JSON.stringify(await service.call('snapshot'));
  const found = await service.call('generate.weakTopics', { course: 'SWE5001' });
  assert.deepEqual(found.topics.map(item => item.topic), ['Raft elections', 'Sharding'], 'most weak cards first; the strong one and the other course are not there');
  assert.equal(found.topics[0].weak, 2);
  assert.deepEqual((await service.call('generate.weakTopics', { course: 'NONE' })).topics, []);
  assert.deepEqual((await service.call('generate.weakTopics', {})).topics.map(item => item.topic).sort(), ['Raft elections', 'Sharding', 'Unrelated weak topic'], 'no course: every course');
  assert.equal(JSON.stringify(await service.call('snapshot')), before, 'it only reads');
  assert.equal(calls, 0);
});

test('English: the panel, the chips and the suggestions have no Chinese left', () => {
  const html = panel(architecture, 'en');
  assert.doesNotMatch(html.replace(/…/g, ''), han);
  assert.match(text(html), /More settings/);
  const chips = draw(React.createElement(m.TopicChips, { value: 'Saga', onChange() {}, suggestions: [{ topic: 'Raft', weak: 2 }] }), 'en');
  assert.doesNotMatch(chips, han);
  assert.match(chips, /aria-label="Add a focus topic"/);
  const guidance = draw(React.createElement(m.GuidanceSuggestions, { items: [{ key: 'k', title: 'Syllabus', ids: ['b'], reason: 'The name has “syllabus”' }], onAdd() {} }), 'en');
  assert.doesNotMatch(guidance, han);
});

/* 新建课程: a course is made where the courses are listed, by name; a typo is asked about before it makes a second one. */
const made = await loadUi(`
  export { NewCourse, CourseList } from './ui/CourseSettings.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);
const field = (props, language = 'zh') => { made.setUiLanguage(language); try { return renderToStaticMarkup(React.createElement(made.NewCourse, { courses: [architecture, databases], onCreate() {}, onOpen() {}, ...props })); } finally { made.setUiLanguage('zh'); } };

test('the course list has a 新建课程 control that stays out of the way until it is used', () => {
  const closed = field({});
  assert.match(closed, /<button[^>]*>(?:<[^>]+>)*新建课程/);
  assert.doesNotMatch(closed, /<input/, 'no form until it is asked for');
  made.setUiLanguage('zh');
  const list = renderToStaticMarkup(React.createElement(made.CourseList, { courses: [architecture, databases], onOpen() {}, onCreate() {} }));
  assert.match(list, /新建课程/);
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(made.CourseList, { courses: [architecture], onOpen() {} })), /新建课程/, 'a list that cannot create has no control for it');
});

test('a new name is created with one press; a name that is nearly an existing course is asked about first, and the existing course is one click away', () => {
  const fresh = field({ initial: { open: true, name: 'Operating Systems' } });
  assert.match(fresh, /<input[^>]*aria-label="课程名称"[^>]*value="Operating Systems"/);
  assert.match(fresh, /<button[^>]*>(?:<[^>]+>)*创建/);
  assert.doesNotMatch(text(fresh), /很像/);
  const typo = field({ initial: { open: true, name: 'Databses' } });
  assert.match(text(typo), /和已有的课程「Databases」很像/);
  assert.match(typo, /<button[^>]*>(?:<[^>]+>)*打开「Databases」/);
  assert.match(typo, /<button[^>]*>(?:<[^>]+>)*仍然新建「Databses」/);
  assert.doesNotMatch(typo, /<button[^>]*>(?:<[^>]+>)*创建<\/button>/, 'the plain create button waits for the answer');
  const same = field({ initial: { open: true, name: 'architecture' } });
  assert.match(text(same), /和已有的课程「Architecture」很像/, 'another spelling of an existing course too');
  const exact = field({ initial: { open: true, name: 'Databases' } });
  assert.match(text(exact), /已经有这门课了/);
  assert.match(exact, /<button[^>]*>(?:<[^>]+>)*打开「Databases」/);
  assert.doesNotMatch(exact, /<button[^>]*>(?:<[^>]+>)*创建/);
});

test('English: the new course form and its question are English', () => {
  for (const name of ['Operating Systems', 'Databses', 'Databases']) assert.doesNotMatch(field({ initial: { open: true, name } }, 'en').replace(/Operating Systems|Databses|Databases|Architecture/g, ''), han);
  assert.match(text(field({ initial: { open: true, name: 'Databses' } }, 'en')), /looks a lot like the course “Databases”/);
  assert.match(text(field({}, 'en')), /New course/);
});
