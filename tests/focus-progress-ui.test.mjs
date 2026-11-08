import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';

/* 重点 × 掌握度 in the interface (#690 S1): one compact line on the home under the course progress (the counts of the focus topics, a link to practise the ones the
   learner cannot do yet, the summary opens the course settings), and a read-only list of the saved focus topics in the course settings. Both read the same
   readout (lib/focus-progress.js) and say each status in the same words (ui/focus-progress-copy.js). */

const m = await loadUi(`
  export { default as DeskIntro } from './ui/study-map/DeskIntro.jsx';
  export { default as FocusProgressLine } from './ui/study-map/FocusProgressLine.jsx';
  export { FocusProgressRows } from './ui/FocusProgressList.jsx';
  export { default as CourseSettings } from './ui/CourseSettings.jsx';
  export { appendFocus } from './ui/generate-form.js';
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);
const h = React.createElement;
const noop = () => {};
const text = markup => markup.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();
/* What the learner reads without hovering: the markup without its tooltips. */
const visible = markup => text(markup.replace(/<span id="[^"]*" role="tooltip"[^>]*>[^<]*<\/span>/g, ''));
const render = (element, language = 'zh') => { m.setUiLanguage(language); try { return renderToStaticMarkup(inApp(m, element, { call: async () => ({}) })); } finally { m.setUiLanguage('zh'); } };

const counts = (over = {}) => ({ new: 0, weak: 0, learning: 0, familiar: 0, mastered: 0, ...over });
const progress = {
  course: 'OS', total: 8, done: 3, weak: 2, none: 1,
  weakScope: [{ deckId: 'd1', cardId: 'q1' }, { deckId: 'd1', cardId: 'q2' }],
  topics: [
    { topic: '死锁', cards: 4, counts: counts({ weak: 1, mastered: 3 }), mastery: 74, status: 'weak', weakCards: [{ deckId: 'd1', cardId: 'q1' }] },
    { topic: '信号量', cards: 3, counts: counts({ weak: 1, learning: 2 }), mastery: 40, status: 'weak', weakCards: [{ deckId: 'd1', cardId: 'q2' }] },
    { topic: '页面置换', cards: 0, counts: counts(), mastery: 0, status: 'none', weakCards: [] },
    { topic: 'TLB', cards: 2, counts: counts({ new: 2 }), mastery: 0, status: 'todo', weakCards: [] },
    { topic: '调度', cards: 5, counts: counts({ learning: 3, familiar: 2 }), mastery: 63, status: 'active', weakCards: [] },
    { topic: '内存', cards: 2, counts: counts({ mastered: 2 }), mastery: 100, status: 'done', weakCards: [] },
  ],
};

const desk = (over = {}, props = {}) => {
  const data = { decks: [{ id: 'd1' }], focus: { mode: 'class', course: 'OS', courseId: 'course-os', courses: [{ name: 'OS' }], progress, ...over } };
  const home = { interview: false, route: null, starter: null, headline: 'OS', plan: { kind: 'path', also: [] }, alternatives: [], otherRuns: [], otherCourse: noop };
  return render(h(m.DeskIntro, { data, home: { ...home, ...props.home }, mastery: { primary: null }, role: { draft: '', setDraft: noop }, start: noop, resume: noop, endRun: noop, onCourseSettings: noop }));
};

test('the home line counts the focus topics and sits under the course progress, in one line with one link', () => {
  const html = desk(), line = visible(html);
  assert.match(line, /重点 8 条：已掌握 3 · 还不会 2 · 还没有题 1(?! ·)/);
  assert.match(line, /练还不会的重点 →/);
  assert.equal((html.match(/练还不会的重点/g) || []).length, 1);
  assert.ok(html.indexOf('class="focus-progress"') > html.indexOf('course-heading'), 'under the course title');
  assert.match(html, /<p class="focus-progress"/, 'a single line of text, not a card');
});

test('zero counts are left out, and nothing to practise means no link', () => {
  const done = { ...progress, total: 2, done: 2, weak: 0, none: 0, weakScope: [], topics: progress.topics.filter(topic => topic.status === 'done').concat(progress.topics.filter(topic => topic.status === 'done')) };
  const line = visible(desk({ progress: done }));
  assert.match(line, /重点 2 条：已掌握 2/);
  assert.doesNotMatch(line, /还不会|还没有题|练还不会的重点/);
});

test('every topic still being learned: the line says so instead of ending at the colon', () => {
  const learning = { ...progress, total: 2, done: 0, weak: 0, none: 0, weakScope: [], topics: progress.topics.filter(topic => ['todo', 'active'].includes(topic.status)) };
  assert.match(visible(desk({ progress: learning })), /重点 2 条：学习中 2/);
  assert.match(visible(render(h(m.FocusProgressLine, { progress: learning, courseId: 'c', start: noop }), 'en')), /Learning 2/);
});

test('the line is hidden without focus topics and when the readout is empty', () => {
  assert.doesNotMatch(desk({ progress: undefined }), /focus-progress/);
  assert.doesNotMatch(desk({ progress: { ...progress, total: 0, topics: [] } }), /focus-progress/);

});

test('how it is counted is a hover Tooltip, never a title attribute', () => {
  const html = desk();
  assert.match(html, /role="tooltip"[^>]*>[^<]*一道题可以属于几条重点/);
  const line = /<p class="focus-progress"[\s\S]*?<\/p>/.exec(html)[0];
  assert.doesNotMatch(line, /\btitle=/);
});

test('English: every word of the line and its explanation is English', () => {
  const html = render(h(m.FocusProgressLine, { progress, courseId: 'course-os', lock: false, start: noop, onCourseSettings: noop }), 'en'), line = visible(html);
  assert.match(line, /Focus topics 8: Mastered 3 · Not yet 2 · No questions 1(?! ·)/);
  assert.match(line, /Practise the focus topics you can't do yet →/);
  assert.doesNotMatch(text(html), /[㐀-鿿]/, 'the explanation too');
  const rows = text(render(h(m.FocusProgressRows, { progress }), 'en'));
  assert.match(rows, /4 questions · Mastered 3/);
  assert.match(rows, /No questions/);
});

/* The elements of a component's output, to press a button without a DOM: the line has no hooks, so calling it gives its tree. */
const walk = (node, found = []) => {
  if (Array.isArray(node)) { node.forEach(child => walk(child, found)); return found; }
  if (node && typeof node === 'object' && node.props) { found.push(node); walk(node.props.children, found); }
  return found;
};
const textOf = node => (typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(textOf).join('') : node?.props ? textOf(node.props.children) : '');

test('pressing the link starts a path run over the weak focus questions; pressing the summary opens the course settings', () => {
  const calls = [];
  const tree = m.FocusProgressLine({ progress, courseId: 'course-os', lock: false, start: args => calls.push(['start', args]), onCourseSettings: id => calls.push(['settings', id]) });
  const buttons = walk(tree).filter(node => typeof node.props.onClick === 'function');
  assert.equal(buttons.length, 2);
  const [summary, practise] = buttons;
  assert.match(textOf(summary), /重点 8 条/);
  assert.match(textOf(practise), /练还不会的重点/);
  summary.props.onClick();
  practise.props.onClick();
  assert.deepEqual(calls, [['settings', 'course-os'], ['start', { mode: 'path', scope: progress.weakScope }]]);
  assert.equal(practise.props.lock, false, 'the link takes the single-flight lock of the app');
});

test('the settings list shows each saved topic with its status and counts, and "no questions" in words', () => {
  const html = render(h(m.FocusProgressRows, { progress })), list = text(html);
  assert.match(html, /<ul class="focus-progress-list"/);
  assert.match(list, /死锁 还不会 4 题 · 已掌握 3/);
  assert.match(list, /页面置换 还没有题/);
  assert.match(list, /内存 已掌握 2 题 · 已掌握 2/);
  assert.match(list, /TLB 学习中 2 题 · 已掌握 0/);
  assert.equal(html.match(/<li/g).length, 6);
  assert.ok(list.indexOf('死锁') < list.indexOf('页面置换') && list.indexOf('页面置换') < list.indexOf('内存'), 'weak first, done last');
  assert.equal(render(h(m.FocusProgressRows, { progress: { ...progress, topics: [], total: 0 } })), '', 'nothing without saved topics');
});

test('the course settings carry the list under the topic chips, for the saved topics only', () => {
  const source = readFileSync('ui/CourseSettings.jsx', 'utf8');
  const chips = source.indexOf('<TopicChips'), list = source.indexOf('<FocusProgressList');
  assert.ok(chips > 0 && list > chips, 'the list comes after the chips');
  assert.match(source, /<FocusProgressList course=\{course\.name\}/, 'it reads the saved course (course.name), not the draft chips');
  assert.doesNotMatch(source.slice(list, list + 120), /draft/);
  const course = { id: 'course-os', name: 'OS', focusTopics: ['死锁'], exam: null, aliases: [], guidanceSourceIds: [], decks: 1, sources: 0 };
  const html = render(h(m.CourseSettings, { data: { root: '/lib', courses: [course], sources: [], focus: { course: 'OS', courses: [{ name: 'OS' }] } }, courseId: 'course-os', onClose: noop }));
  assert.match(text(html), /重点知识点/);
});

test('empty focus topics offer an entry into existing generation from both course settings and the home line when no weak focus question blocks it', () => {
  const generated = [];
  const rowsHtml = render(h(m.FocusProgressRows, { progress, lock: false, onGenerateTopic: topic => generated.push(topic) }));
  assert.match(text(rowsHtml), /页面置换 还没有题 去出题 →/);
  assert.equal((rowsHtml.match(/去出题 →/g) || []).length, 1, 'only status === none topics get the generation button');
  assert.match(text(render(h(m.FocusProgressRows, { progress, lock: false, onGenerateTopic: noop }), 'en')), /No questions Generate questions →/);

  const rowsTree = m.FocusProgressRows({ progress, lock: false, onGenerateTopic: topic => generated.push(topic) });
  const genBtn = walk(rowsTree).find(node => typeof node.props.onClick === 'function');
  genBtn.props.onClick();
  assert.deepEqual(generated, ['页面置换']);

  const withWeak = render(h(m.FocusProgressLine, { progress, courseId: 'course-os', lock: false, start: noop, onCourseSettings: noop, onGenerateFocus: noop }));
  assert.doesNotMatch(text(withWeak), /去出缺题重点/);
  const noWeak = { ...progress, weak: 0, none: 2, weakScope: [], topics: [
    { topic: '页面置换', cards: 0, counts: counts(), mastery: 0, status: 'none', weakCards: [] },
    { topic: '银行家算法', cards: 0, counts: counts(), mastery: 0, status: 'none', weakCards: [] },
    { topic: '内存', cards: 2, counts: counts({ mastered: 2 }), mastery: 100, status: 'done', weakCards: [] },
  ] };
  const lineCalls = [];
  const lineTree = m.FocusProgressLine({ progress: noWeak, courseId: 'course-os', lock: false, start: noop, onCourseSettings: noop, onGenerateFocus: (topics, course) => lineCalls.push([topics, course]) });
  const lineBtns = walk(lineTree).filter(node => typeof node.props.onClick === 'function');
  assert.equal(lineBtns.length, 2);
  assert.match(textOf(lineBtns[1]), /去出缺题重点 →/);
  lineBtns[1].props.onClick();
  assert.deepEqual(lineCalls, [[['页面置换', '银行家算法'], 'OS']]);
  assert.equal(m.appendFocus('死锁', ['页面置换', '死锁', '银行家算法']), '死锁；页面置换；银行家算法');
  assert.match(visible(render(h(m.FocusProgressLine, { progress: noWeak, courseId: 'course-os', lock: false, start: noop, onGenerateFocus: noop }), 'en')), /Generate for empty focus topics →/);
});
