/* WP13 · course UI: the course settings panel (name, aliases, exam profile,
   focus topics, examiner guidance, rename and merge), the exam countdown on the
   library heading and the course pickers that show existing courses first. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export * from './ui/CourseSettings.jsx'; export { default as CourseSettings } from './ui/CourseSettings.jsx';
  export { default as CourseField, toggleCourse } from './ui/CourseField.jsx';
  export { default as PageScope } from './ui/PageScope.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { CourseSettings, CourseList, ExamCountdown, draftFromCourse, payloadFromDraft, examCountdown, CourseField, toggleCourse, PageScope, setUiLanguage } = module.exports;
const han = /[㐀-鿿]/;

const architecture = { id: 'course-aaaaaaaaaaaa', name: 'Architecture', aliases: ['Arch 101'], createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z',
  exam: { format: 'open-book-case', totalMarks: 60, writingMinutes: 120, date: '2026-12-01',
    sections: [{ title: 'Part A', lecturer: 'Dr Tan', marks: 30, topics: ['Microservices', 'Event sourcing'] }] },
  guidanceSourceIds: ['brief'], focusTopics: ['Strangler fig'], decks: 2, drafts: 0, sources: 1 };
const databases = { id: 'course-bbbbbbbbbbbb', name: 'Databases', aliases: [], guidanceSourceIds: [], focusTopics: [], decks: 1, drafts: 0, sources: 0 };
const data = { root: '/lib', courses: [architecture, databases], focus: { course: 'Architecture', courseId: architecture.id, courses: [{ name: 'Architecture' }, { name: 'Databases' }] },
  sources: [{ id: 'brief', title: 'Exam briefing transcript', text: 'The examiner said…', courses: ['Architecture'], createdAt: '2026-09-01T00:00:00.000Z' }] };
const render = (element, language = 'zh') => { setUiLanguage(language); try { return renderToStaticMarkup(element); } finally { setUiLanguage('zh'); } };
const panel = (language, props = {}) => render(React.createElement(CourseSettings, { data, courseId: architecture.id, act: async () => {}, onClose() {}, ...props }), language);

test('the course panel shows name, aliases, the exam profile, focus topics, guidance and rename/merge', () => {
  const html = panel('zh');
  assert.match(html, /Architecture/);
  assert.match(html, /Arch 101/, 'aliases are listed (read-only)');
  for (const label of ['考试形式', '开卷案例', '闭卷', '混合', '总分', '作答时间', '阅读时间', '每分用时', '考试日期', '重点知识点', '考官指引', '改名', '合并', '保存课程信息'])
    assert.ok(html.includes(label), `zh panel shows ${label}`);
  assert.match(html, /type="date"[^>]*value="2026-12-01"|value="2026-12-01"[^>]*type="date"/);
  assert.match(html, /value="Part A"/);
  assert.match(html, /value="Dr Tan"/);
  assert.match(html, /value="Microservices; Event sourcing"/);
  assert.match(html, /value="Strangler fig"/);
  assert.match(html, /source-picker/, 'guidance is picked with the shared SourcePicker');
  assert.match(html, /Exam briefing transcript/);
  assert.match(html, /Databases/, 'other courses are offered for merging');
  assert.match(html, /placeholder="24"/, 'the default reading time is shown as a placeholder');
  const en = panel('en');
  for (const label of ['Exam format', 'Open-book case', 'Closed-book', 'Total marks', 'Writing time', 'Reading time', 'Minutes per mark', 'Exam date', 'Focus topics', 'Examiner guidance', 'Rename', 'Merge', 'Save course'])
    assert.ok(en.includes(label), `en panel shows ${label}`);
  assert.doesNotMatch(en.replace(/…/g, ''), han, 'no untranslated application copy');
});

test('a course without an exam starts from the documented defaults', () => {
  const draft = draftFromCourse(databases);
  assert.equal(draft.format, 'other');
  assert.equal(draft.totalMarks, '');
  assert.deepEqual(draft.sections, []);
  const html = render(React.createElement(CourseSettings, { data, courseId: databases.id, act: async () => {}, onClose() {} }));
  assert.match(html, /placeholder="40"/);
  assert.match(html, /placeholder="120"/);
  assert.match(html, /placeholder="3"/);
});

test('the form round-trips to a course.save payload', () => {
  const draft = draftFromCourse(architecture);
  assert.equal(draft.sections[0].topics, 'Microservices; Event sourcing');
  const payload = payloadFromDraft(architecture, { ...draft, readingMinutes: '15', focusTopics: 'Strangler fig；Saga\nCQRS',
    sections: [...draft.sections, { title: 'Part B', lecturer: '', marks: '', topics: '' }, { title: '  ', lecturer: '', marks: '', topics: '' }] });
  assert.deepEqual(payload, { id: architecture.id, name: 'Architecture', guidanceSourceIds: ['brief'], focusTopics: ['Strangler fig', 'Saga', 'CQRS'],
    exam: { format: 'open-book-case', totalMarks: 60, writingMinutes: 120, readingMinutes: 15, date: '2026-12-01',
      sections: [{ title: 'Part A', lecturer: 'Dr Tan', marks: 30, topics: ['Microservices', 'Event sourcing'] }, { title: 'Part B', topics: [] }] } });
  assert.equal(payloadFromDraft(databases, draftFromCourse(databases)).exam, undefined, 'an untouched empty profile does not invent an exam');
});

test('the library heading counts down to the exam date', () => {
  const now = new Date(2026, 10, 19, 15, 0);
  assert.deepEqual(examCountdown({ date: '2026-12-01', format: 'open-book-case' }, now), { days: 12, text: '距考试 12 天', format: '开卷案例' });
  assert.equal(examCountdown({ date: '2026-11-19' }, now).text, '今天考试');
  assert.equal(examCountdown({ date: '2026-11-18' }, now), null, 'a past exam shows nothing');
  assert.equal(examCountdown({ format: 'closed-book' }, now), null, 'no date, no countdown');
  setUiLanguage('en');
  try {
    assert.deepEqual(examCountdown({ date: '2026-12-01', format: 'closed-book' }, now), { days: 12, text: 'Exam in 12 days', format: 'Closed-book' });
    assert.equal(examCountdown({ date: '2026-11-20' }, now).text, 'Exam in 1 day');
  } finally { setUiLanguage('zh'); }
  const html = render(React.createElement(ExamCountdown, { course: architecture, now }));
  assert.match(html, /距考试 12 天/);
  assert.match(html, /开卷案例/);
  assert.equal(render(React.createElement(ExamCountdown, { course: databases, now })), '');
});

test('Settings lists courses with a way into their panel', () => {
  const html = render(React.createElement(CourseList, { courses: data.courses, onOpen() {} }));
  assert.match(html, /Architecture/);
  assert.match(html, /Databases/);
  assert.equal(html.match(/<button/g)?.length, 2);
  assert.match(html, /也叫 Arch 101|Arch 101/);
  assert.match(render(React.createElement(CourseList, { courses: [], onOpen() {} })), /还没有课程/);
});

test('course pickers show existing courses first and free text still works', () => {
  assert.equal(toggleCourse('', 'Databases', false), 'Databases');
  assert.equal(toggleCourse('Databases', 'Systems', false), 'Systems');
  assert.equal(toggleCourse('Databases', 'Systems', true), 'Databases; Systems');
  assert.equal(toggleCourse('Databases; Systems', 'Databases', true), 'Systems');
  const html = render(React.createElement(CourseField, { courses: data.focus.courses, value: 'Architecture', multiple: true, onChange() {} }));
  assert.match(html, /<input/, 'free text stays');
  assert.match(html, /aria-pressed="true"[^>]*>Architecture|>Architecture<\/button>/);
  assert.equal(html.match(/<button/g)?.length, 2, 'one quick pick per existing course');
  const scope = render(React.createElement(PageScope, { courses: data.focus.courses, value: '*', onChange() {} }));
  assert.ok(scope.indexOf('>Architecture<') < scope.indexOf('>未分类<'), 'real courses come before the unassigned bucket');
});
