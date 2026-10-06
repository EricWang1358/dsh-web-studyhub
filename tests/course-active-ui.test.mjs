/* 有效课程 in the UI: the scope picker groups parked courses and says what a page leaves out, the forecast says what it counts,
   Settings has the switch, the library marks and folds parked courses. zh and en; English shows no Han outside the learner's own data. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mapProps } from './helpers/study-map-props.mjs';
import { nativeSelects } from './helpers/native-selects.mjs';

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export { default as PageScope, decksInCourse, courseParked, scopeArgs } from './ui/PageScope.jsx';
  export { ActiveSwitch, ParkedChip, CourseActiveProvider, activeNotice, liveSubCourses, parkedWithin } from './ui/CourseActive.jsx';
  export { CourseList } from './ui/CourseSettings.jsx';
  export { ForecastPanel } from './ui/charts/DashboardCharts.jsx';
  export { default as StudyMap } from './ui/StudyMap.jsx';
  export { default as CourseField } from './ui/CourseField.jsx';
  export { rankCourses } from './ui/course-names.js';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], plugins: [nativeSelects], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { PageScope, decksInCourse, courseParked, scopeArgs, ActiveSwitch, ParkedChip, CourseActiveProvider, activeNotice, liveSubCourses, parkedWithin,
  CourseList, ForecastPanel, StudyMap, CourseField, rankCourses, setUiLanguage } = module.exports;
const h = React.createElement;
const han = /[㐀-鿿]/;
const render = (element, language = 'zh') => { setUiLanguage(language); try { return renderToStaticMarkup(element); } finally { setUiLanguage('zh'); } };
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const noop = () => {};
const api = { setActive: async () => ({}), activate: async () => ({}), manage: noop };
const provide = element => h(CourseActiveProvider, { value: api }, element);

const P = 'Cloud Native Solution Design';
const C05 = `${P} / 05 Kubernetes`;
const courses = [
  { id: 'c-db', name: 'Databases', count: 2, active: true },
  { id: 'c-cloud', name: 'Cloud', count: 3, active: false, explicit: false },
  { id: 'c-p', name: P, count: 1, active: false, explicit: false },
  { id: 'c-05', name: C05, count: 2, active: false, inactiveBy: P },
  { id: 'c-07', name: `${P} / 07 Microservices`, count: 1, active: true, explicit: true },
];
const userData = new RegExp([P, 'Cloud', 'Databases', 'Kubernetes', 'Microservices'].map(name => name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|'), 'g');
const noHan = html => assert.doesNotMatch(html.replace(userData, ''), han);

test('the scope picker lists parked courses under their own heading, selectable, and says what the page leaves out', () => {
  const html = render(h(PageScope, { courses, value: '*', onChange: noop, showInactive: false, onShowInactive: noop }));
  assert.match(html, /<optgroup label="未激活的课程 \(3\)">/, 'Cloud, the parent and chapter 05');
  const group = html.match(/<optgroup[\s\S]*?<\/optgroup>/)[0];
  assert.match(group, /value="Cloud"/);
  assert.match(group, new RegExp(`value="${C05.replace(/\//g, '\\/')}"`), 'a parked chapter stays selectable');
  assert.doesNotMatch(html.replace(group, ''), /value="Cloud"/, 'not in the main list');
  assert.match(html.replace(group, ''), /value="Databases"/);
  assert.match(html.replace(group, ''), /Microservices/, 'chapter 07 is kept alive inside its parked parent and stays in the main list');
  assert.match(text(html), /不含 3 门未激活的课程 · 显示/, 'what this page view leaves out, with the way to show it');
  const shown = render(h(PageScope, { courses, value: '*', onChange: noop, showInactive: true, onShowInactive: noop }));
  assert.match(text(shown), /含 3 门未激活的课程 · 隐藏/);
  assert.doesNotMatch(text(shown), /不含/);
  assert.doesNotMatch(text(render(h(PageScope, { courses, value: '*', onChange: noop }))), /不含/, 'a page that cannot show them says nothing it cannot do');
});

test('a parked course picked on purpose is read, with its state and the way back', () => {
  const html = render(provide(h(PageScope, { courses, value: 'Cloud', onChange: noop, showInactive: false, onShowInactive: noop })));
  assert.match(text(html), /这门课未激活 · 激活/);
  assert.doesNotMatch(text(html), /不含/, 'nothing is left out of the course the learner picked');
  assert.doesNotMatch(text(render(h(PageScope, { courses, value: 'Databases', onChange: noop, onShowInactive: noop }))), /这门课未激活/);
  const bare = render(h(PageScope, { courses, value: 'Cloud', onChange: noop }));
  assert.match(text(bare), /这门课未激活/);
  assert.doesNotMatch(bare, /<button/, 'without the app around it there is nothing to press');
  assert.equal(courseParked({ focus: { courses } }, 'Cloud'), true);
  assert.equal(courseParked({ focus: { courses } }, '*'), false);
  assert.equal(courseParked({ focus: { courses } }, 'Databases'), false);
  assert.equal(parkedWithin(courses, '*'), 3);
  assert.equal(parkedWithin(courses, 'Databases'), 0);
  assert.equal(parkedWithin(courses, P), 2, 'a parent scope counts the parked courses inside it');
  assert.equal(parkedWithin([{ name: 'Empty', active: false, count: 0 }], '*'), 0, 'a parked course that holds no deck leaves nothing out');
});

test('English: the picker, the line and the chip read in English', () => {
  const html = render(provide(h(PageScope, { courses, value: '*', onChange: noop, showInactive: false, onShowInactive: noop })), 'en');
  assert.match(html, /<optgroup label="Inactive courses \(3\)">/);
  assert.match(text(html), /Leaves out 3 inactive courses|3 inactive courses/);
  noHan(html);
  noHan(render(provide(h(PageScope, { courses, value: 'Cloud', onChange: noop, onShowInactive: noop })), 'en'));
  noHan(render(provide(h(ParkedChip, { course: courses[1] })), 'en'));
});

test('decks of parked courses are not in a page\'s default list; picking the course or showing parked courses brings them back', () => {
  const data = { focus: { courses }, decks: [
    { id: 'a', course: 'Databases' }, { id: 'b', course: 'Cloud', inactive: true }, { id: 'c', course: P, inactive: true }, { id: 'd', course: C05, inactive: true },
    { id: 'e', course: `${P} / 07 Microservices` }, { id: 'f', course: '' }] };
  const ids = list => list.map(deck => deck.id);
  assert.deepEqual(ids(decksInCourse(data, '*')), ['a', 'e', 'f']);
  assert.deepEqual(ids(decksInCourse(data, '*', true)), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(ids(decksInCourse(data, 'Cloud')), ['b'], 'an explicit pick of the parked course reads it');
  assert.deepEqual(ids(decksInCourse(data, P)), ['c', 'd', 'e'], 'a parked parent picked on purpose reads everything inside it');
  assert.deepEqual(ids(decksInCourse(data, 'Databases')), ['a']);
  assert.deepEqual(decksInCourse({ focus: { courses: [{ name: 'X' }] }, decks: [{ id: 'z', course: 'X' }] }, '*').map(deck => deck.id), ['z'], 'old snapshots carry no flag');
  assert.deepEqual(scopeArgs('*', true), { course: '*', includeInactive: true });
  assert.deepEqual(scopeArgs('Cloud', false), { course: 'Cloud' });
});

test('the notice after parking or activating states the real numbers', () => {
  const wake = activeNotice({ name: 'Cloud', active: true, changed: true, decks: 2, due: 22, overdue: 22 });
  assert.equal(wake.text, '已激活「Cloud」，到期 22 题（其中逾期 22 题）');
  assert.match(wake.detail, /一次最多 20 题/, 'a big backlog is said plainly; no schedule is rewritten');
  assert.equal(activeNotice({ name: 'Cloud', active: true, changed: true, due: 5, overdue: 1 }).detail, '');
  assert.match(activeNotice({ name: 'Cloud', active: true, changed: true, due: 0 }).text, /现在没有到期的题/);
  const park = activeNotice({ name: 'Cloud', active: false, changed: true, decks: 2, due: 22, subCourses: ['a', 'b'] });
  assert.match(park.text, /2 个题组里 22 题的到期复习不再推给你/);
  assert.match(park.text, /原样保留/);
  assert.match(park.detail, /同时停用了 2 门子课程/);
  assert.match(activeNotice({ name: 'Cloud', active: true, changed: false }).text, /已经是有效课程/);
  assert.match(activeNotice({ name: 'Cloud', active: false, changed: false }).text, /已经是未激活/);
  setUiLanguage('en');
  try { noHan(`${activeNotice({ name: 'Cloud', active: true, changed: true, due: 22, overdue: 30 }).text} ${activeNotice({ name: 'Cloud', active: true, changed: true, due: 22, overdue: 30 }).detail}`);
    noHan(Object.values(activeNotice({ name: 'Cloud', active: false, changed: true, decks: 2, due: 22, subCourses: ['a'] })).join(' ')); }
  finally { setUiLanguage('zh'); }
});

test('the switch: one per course with the effect in words; a parent asks about its sub-courses', () => {
  const html = render(provide(h(ActiveSwitch, { course: courses[0], courses })));
  assert.match(html, /role="switch"[^>]*aria-checked="true"/);
  assert.match(text(html), /有效课程 未激活的课程不进入到期复习和推荐；随时可以再激活/);
  assert.match(text(render(provide(h(ActiveSwitch, { course: courses[4], courses })))), /已单独设为有效，不受上级课程影响/, 'a chapter kept alive inside a parked parent says so');
  const off = render(provide(h(ActiveSwitch, { course: courses[1], courses })));
  assert.match(off, /aria-checked="false"/);
  assert.match(text(off), /未激活：不进入到期复习和推荐；复习进度原样保留，激活后恢复/);
  const inherited = render(provide(h(ActiveSwitch, { course: courses[3], courses })));
  assert.match(text(inherited), /随「Cloud Native Solution Design」未激活；可以单独设为有效/);
  assert.equal(render(h(ActiveSwitch, { course: courses[1], courses })), '', 'nothing without the app around it');
  const parent = { id: 'c-x', name: 'Physics', active: true };
  const kids = [parent, { name: 'Physics / 01', active: true }, { name: 'Physics / 02', active: true, explicit: true }, { name: 'Physics / 03', active: false }];
  assert.deepEqual(liveSubCourses(kids, parent).map(course => course.name), ['Physics / 01'], 'only the ones it would take along');
  const ask = render(provide(h(ActiveSwitch, { course: parent, courses: kids, defaultConfirm: true })));
  assert.match(text(ask), /「Physics」含 1 门子课程，要一起设为未激活吗？/);
  assert.match(text(ask), /连同子课程一起/);
  assert.match(text(ask), /只停这一门/);
  const compact = render(provide(h(ActiveSwitch, { course: courses[1], courses, compact: true })));
  assert.match(compact, /aria-label="有效课程 · Cloud"/);
  assert.match(text(compact), /未激活/);
  noHan(render(provide(h(ActiveSwitch, { course: parent, courses: kids, defaultConfirm: true })), 'en').replace(/Physics/g, ''));
  noHan(render(provide(h(ActiveSwitch, { course: courses[1], courses })), 'en'));
  noHan(render(provide(h(ActiveSwitch, { course: courses[3], courses, compact: true })), 'en'));
});

test('Settings: every row carries the switch and says it parked, in both languages', () => {
  const html = render(provide(h(CourseList, { courses, defaultOpenGroups: [P] })));
  assert.equal((html.match(/role="switch"/g) || []).length, courses.length);
  assert.match(text(html), /未激活的课程不进入到期复习和推荐；随时可以再激活/, 'the effect in words, once above the list');
  assert.match(html, /is-parked-row/);
  noHan(render(provide(h(CourseList, { courses, defaultOpenGroups: [P] })), 'en'));
  assert.doesNotMatch(render(h(CourseList, { courses, defaultOpenGroups: [P] })), /role="switch"/);
});

test('the forecast says it counts active courses only, what sits in parked ones, and where to manage them', () => {
  const day = (i, count) => ({ date: `2026-10-${String(2 + i).padStart(2, '0')}`, count, cards: [], ...(i === 0 ? { overdue: 0 } : {}) });
  const days = Array.from({ length: 14 }, (_, i) => day(i, i === 0 ? 4 : 0));
  const out = render(h(ForecastPanel, { forecast: { days, later: 0, hidden: { today: 22, count: 26, later: 0 } }, parked: { onManage: noop } }));
  assert.match(text(out), /仅有效课程 · 另有 26 题在未激活的课程里/);
  assert.match(text(out), /管理课程/);
  assert.doesNotMatch(text(render(h(ForecastPanel, { forecast: { days, later: 0 } }))), /仅有效课程/, 'nothing parked, nothing to say');
  assert.match(text(render(h(ForecastPanel, { forecast: { days, later: 0 }, parked: { included: true } }))), /含未激活的课程/);
  const english = render(h(ForecastPanel, { forecast: { days, later: 0, hidden: { today: 22, count: 26, later: 0 } }, parked: { onManage: noop } }), 'en');
  assert.match(text(english), /Active courses only · 26 more due cards are in inactive courses/);
  noHan(english);
  const quiet = days.map(d => ({ ...d, count: 0 }));
  assert.match(text(render(h(ForecastPanel, { forecast: { days: quiet, later: 0, hidden: { today: 3, count: 3, later: 0 } } }))), /仅有效课程 · 另有 3 题在未激活的课程里/, 'even when nothing active is due');
});

const deck = (id, course, extra = {}) => ({ id, title: `${id} deck`, folder: course, course, topics: ['t'], available: 3, count: 3, quizCount: 1, createdAt: '2026-09-01T00:00:00Z', ...extra });
const progress = id => ({ [id]: { counts: { mastered: 0, familiar: 0, learning: 1, weak: 0, new: 2 }, total: 3, mastery: 20, due: 1, status: 'active', topics: [] } });
function library(patch = {}, props = {}) {
  const data = { root: '/tmp/lib', decks: [deck('d1', 'Databases'), deck('d2', 'Cloud', { inactive: true })], sources: [], drafts: [], jobs: [], runs: [],
    progress: { ...progress('d1'), ...progress('d2') }, today: { due: 1, weak: 0, new: 2, size: 3 }, next: null,
    focus: { mode: 'class', course: 'Databases', courses: [{ name: 'Databases', count: 1, active: true }, { name: 'Cloud', count: 1, active: false, explicit: false }], fresh: [] }, ...patch };
  return renderToStaticMarkup(h(CourseActiveProvider, { value: api }, h(StudyMap, mapProps({ data, busy: false, start: noop, resume: noop, endRun: noop, manage: noop, openDraft: noop,
    continueDraft: noop, retryGeneration: noop, addSource: noop, createManual: noop, importLibrary: noop, askInChat: noop, notebooks: { notebooks: [] }, onFocus: noop,
    cancelJob: noop, dismissJob: noop, generateFromSources: noop, openModelSettings: noop, canChat: false, ...props }))));
}

test('the library folds parked courses under one heading and keeps their decks out of the default list', () => {
  const html = library();
  assert.match(text(html), /未激活的课程 \(1\)/);
  assert.match(html, /d1 deck/);
  assert.doesNotMatch(html, /d2 deck/, 'folded until the learner opens it');
  assert.doesNotMatch(text(html), /未激活的课程 \(1\)[^]*Cloud[^]*d2 deck/);
});

test('the home marks a parked current course with 未激活 and an 激活 button; the course switcher groups parked courses', () => {
  const html = library({ focus: { mode: 'class', course: 'Cloud', courseId: 'c-cloud', courses: [{ name: 'Databases', count: 1, active: true }, { name: 'Cloud', count: 1, active: false, explicit: false }], fresh: [] } });
  assert.match(html, /class="[^"]*\bcourse-parked\b/);
  assert.match(text(html), /未激活 激活/);
  assert.match(html, /<optgroup label="未激活的课程 \(1\)">/, 'the heading\'s switcher keeps parked courses apart');
  const live = library();
  assert.doesNotMatch(live, /class="[^"]*\bcourse-parked\b/);
});

test('a half-done practice in a parked course is not offered as 接着做, and the other list says so', () => {
  const run = { id: 'r1', title: 'Cloud 练习', deckId: 'd2', deckIds: ['d2'], index: 1, total: 5, mode: 'path', scope: [{ deckId: 'd2' }], inactive: true };
  const html = library({ runs: [run], lastRun: { id: 'r1', title: 'Cloud 练习', index: 1, total: 5, mode: 'path', inactive: true } });
  assert.doesNotMatch(html, /接着上次/);
  assert.match(text(html), /另有 1 组练习未完成/);
  assert.match(text(html), /未激活/);
});

test('English: the library, the chip and the fold read in English', () => {
  setUiLanguage('en');
  try {
    const html = library({ focus: { mode: 'class', course: 'Cloud', courseId: 'c-cloud', courses: [{ name: 'Databases', count: 1, active: true }, { name: 'Cloud', count: 1, active: false, explicit: false }], fresh: [] } });
    assert.match(html, /Inactive courses \(1\)/);
    assert.match(text(html), /Inactive Activate/);
  } finally { setUiLanguage('zh'); }
});

test('pickers rank parked courses last, and the filing field shows them dimmed', () => {
  const ranked = rankCourses({ courses, current: 'Databases' }).map(course => course.name);
  assert.deepEqual(ranked.slice(0, 2), ['Databases', `${P} / 07 Microservices`], 'active first, the current one leading');
  assert.deepEqual(new Set(ranked.slice(2)), new Set(['Cloud', P, C05]));
  const html = render(h(CourseField, { courses, value: '', onChange: noop }));
  assert.match(html, /course-field__pick[^>]*is-parked|is-parked[^>]*course-field__pick/);
  const all = render(h(CourseField, { courses: [...courses, ...Array.from({ length: 6 }, (_, i) => ({ name: `Extra ${i}`, count: 1 }))], value: '', onChange: noop, initialOpen: true }));
  assert.match(text(all), /未激活的课程 \(3\)/);
});

test('the locale carries every new string, the styles use tokens only, the contexts stay quiet about it', () => {
  const english = JSON.parse(readFileSync(new URL('../ui/locales/en.course.json', import.meta.url), 'utf8'));
  for (const key of ['有效课程', '未激活', '激活', '这门课未激活', '显示', '隐藏', '未激活的课程 ({0})', '不含 {0} 门未激活的课程', '含 {0} 门未激活的课程', '仅有效课程 · 另有 {0} 题在未激活的课程里', '管理课程',
    '只停这一门', '连同子课程一起', '未激活的课程不进入到期复习和推荐；随时可以再激活']) assert.ok(english[key], key);
  const css = readFileSync(new URL('../ui/course-active.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, 'no hard-coded colours');
});
