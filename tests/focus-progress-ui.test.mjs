import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { fakeApp, inApp } from './helpers/fake-app.mjs';
import { loadInteractiveUi, withBrowserGlobals, click } from './helpers/react-harness.mjs';
import { parseCss } from '../scripts/qa/guardrail-baseline.mjs';

/* 重点 × 掌握度 in the interface (#690 S1): one compact line on the home under the course progress (the counts of the focus topics, a link to practise the ones the
   learner cannot do yet, the summary opens the course settings), and a read-only list of the saved focus topics in the course settings. Both read the same
   readout (lib/focus-progress.js) and say each status in the same words (ui/focus-progress-copy.js). */

const m = await loadUi(`
  export { default as DeskIntro } from './ui/study-map/DeskIntro.jsx';
  export { default as FocusProgressLine } from './ui/study-map/FocusProgressLine.jsx';
  export { FocusProgressRows } from './ui/FocusProgressList.jsx';
  export { appendFocus } from './ui/generate-form.js';
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);
const h = React.createElement;
const noop = () => {};
/* The pieces of the home line (head, each count with its words) are inline spans of one sentence: they read as the text they hold, not as separate blocks. */
const joinPieces = markup => markup.replace(/<span class="focus-progress__piece">([^<]*)<\/span>/g, '$1').replace(/<span class="focus-progress__words">([^<]*)<\/span>/g, '$1');
const text = markup => joinPieces(markup).replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();
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
  assert.match(line, /练还不会的重点/);
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
  assert.match(visible(render(h(m.FocusProgressLine, { progress: learning, courseId: 'c', start: noop }), 'en')), /2 focus topics: 2 learning/);
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
  assert.match(line, /8 focus topics: 3 mastered · 2 not yet · 1 without a question(?! ·)/);
  assert.match(line, /Practise the focus topics you can't do yet/);
  assert.doesNotMatch(text(html), /[㐀-鿿]/, 'the explanation too');
  const rows = text(render(h(m.FocusProgressRows, { progress }), 'en'));
  assert.match(rows, /4 questions · Mastered 3/);
  assert.match(rows, /No questions/);
});

test('English reads as a sentence, with the singular, not two counts glued together (#1130: "Focus topics 1: No questions 1")', () => {
  const one = { ...progress, total: 1, done: 0, weak: 0, none: 1, weakScope: [], topics: progress.topics.filter(topic => topic.status === 'none').slice(0, 1) };
  const en = visible(render(h(m.FocusProgressLine, { progress: one, courseId: 'c', start: noop }), 'en'));
  assert.match(en, /1 focus topic: 1 without a question/);
  assert.doesNotMatch(en, /Focus topics|No questions \d/);
  assert.match(visible(render(h(m.FocusProgressLine, { progress: { ...one, none: 3, total: 3 }, courseId: 'c', start: noop }), 'en')), /3 focus topics: 3 without questions/);
  assert.match(visible(render(h(m.FocusProgressLine, { progress: { ...one, none: 0, done: 1 }, courseId: 'c', start: noop }), 'en')), /1 focus topic: 1 mastered/);
  assert.match(visible(desk({ progress: one })), /重点 1 条：还没有题 1/, 'Chinese is unchanged');
  // The line is drawn in pieces that never break (the head and each count with its words), joined by the spaces the sentence has: the same visible words, the same accessible name.
  const piecesOf = (markup) => [...markup.matchAll(/<span class="focus-progress__piece">([^<]*)<\/span>/g)].map(found => found[1]);
  const mix = { ...progress, total: 7, done: 2, weak: 2, none: 2 };
  assert.deepEqual(piecesOf(render(h(m.FocusProgressLine, { progress: mix, courseId: 'c', start: noop }), 'en')), ['7 focus topics:', '2 mastered ·', '2 not yet ·', '2 without questions']);
  assert.deepEqual(piecesOf(render(h(m.FocusProgressLine, { progress: { ...one, none: 1 }, courseId: 'c', start: noop }), 'en')), ['1 focus topic:', '1 without a question']);
  assert.deepEqual(piecesOf(render(h(m.FocusProgressLine, { progress: mix, courseId: 'c', start: noop }), 'zh')), ['重点 7 条：', '已掌握 2 ·', '还不会 2 ·', '还没有题 2']);
  assert.match(visible(render(h(m.FocusProgressLine, { progress: mix, courseId: 'c', start: noop }), 'zh')), /重点 7 条：已掌握 2 · 还不会 2 · 还没有题 2/, 'no space after the Chinese colon');
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
  assert.equal(summary.props.iconEnd ?? summary.props.icon, undefined, 'a status that opens its detail: no arrow');
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

test('the course settings carry the list under the topic chips, for the saved topics only', async () => {
  const ui = await loadInteractiveUi(`
    export { default as CourseSettings } from './ui/CourseSettings.jsx';
    export { AppContext } from './ui/app/app-context.js';
    export { StudyServicesContext } from './ui/study-context.jsx';
    export { setUiLanguage } from './ui/i18n.js';
  `);
  const ih = ui.React.createElement;
  const hasClass = (node, cls) => typeof node?.props?.className === 'string' && node.props.className.split(/\s+/).includes(cls);
  const focusCalls = [];
  const call = async (method, args) => {
    if (method === 'course.focusProgress') {
      focusCalls.push(args);
      return progress;
    }
    if (method === 'generate.weakTopics') return { topics: [] };
    return {};
  };
  const study = {
    call,
    act: async () => undefined,
    busy: false,
    notify: noop,
    askInChat: noop,
    host: {},
    openSettings: noop,
    navigate: noop,
    openModal: noop,
  };
  const makeElement = (course) => {
    const data = { root: '/lib', courses: [course], sources: [], focus: { course: 'OS', courses: [{ name: 'OS' }] } };
    return ih(
      ui.exports.StudyServicesContext.Provider,
      { value: study },
      ih(
        ui.exports.AppContext.Provider,
        { value: fakeApp({ data, call }) },
        ih(ui.exports.CourseSettings, { data, courseId: 'course-os', onClose: noop }),
      ),
    );
  };

  const initialCourse = { id: 'course-os', name: 'OS', focusTopics: ['死锁'], exam: null, aliases: [], guidanceSourceIds: [], decks: 1, sources: 0 };
  await withBrowserGlobals(async () => {
    ui.exports.setUiLanguage('zh');
    const mounted = ui.mount(() => makeElement(initialCourse));
    try {
      await mounted.flush(5);
      assert.deepEqual(focusCalls, [{ course: 'OS' }], 'CourseSettings queries course.focusProgress for the saved course once on mount');
      assert.match(mounted.text(), /重点知识点/);

      const hosts = mounted.findAll((node) => typeof node.type === 'string');
      const chipsIdx = hosts.findIndex((node) => hasClass(node, 'topic-field'));
      const listIdx = hosts.findIndex((node) => hasClass(node, 'focus-progress-list'));
      assert.ok(chipsIdx >= 0 && listIdx > chipsIdx, 'FocusProgressList renders after TopicChips');

      const listNode = hosts[listIdx];
      assert.match(mounted.text(listNode), /死锁/);
      assert.match(mounted.text(listNode), /页面置换/);

      // Mutate unsaved draft topics through TopicChips: FocusProgressList must stay on saved topics and not re-fetch.
      const topicField = hosts[chipsIdx];
      const topicInput = mounted.find((node) => node.type === 'input' && hasClass(node, 'topic-field__input'), topicField);
      assert.ok(topicInput, 'TopicChips renders its text input');
      await mounted.act(() => {
        topicInput.props.onChange({ target: { value: '未保存草案' } });
      });
      const addWrap = mounted.find((node) => hasClass(node, 'topic-field__add'));
      const addBtn = mounted.find((node) => node.type === 'button', addWrap);
      assert.ok(addBtn && !addBtn.props.disabled, 'add button becomes enabled for draft topic');
      await mounted.act(() => {
        click(addBtn);
      });
      await mounted.flush(5);

      const updatedField = mounted.find((node) => hasClass(node, 'topic-field'));
      const updatedList = mounted.find((node) => hasClass(node, 'focus-progress-list'));
      assert.match(mounted.text(updatedField), /未保存草案/, 'draft chip is added to TopicChips');
      assert.equal(focusCalls.length, 1, 'unsaved draft edits must not re-fetch course.focusProgress');
      assert.doesNotMatch(mounted.text(updatedList), /未保存草案/, 'FocusProgressList must not show unsaved draft topics');

      // Updating saved course.focusTopics re-fires course.focusProgress.
      mounted.rerender(() => makeElement({ ...initialCourse, focusTopics: ['死锁', '信号量'] }));
      await mounted.flush(5);
      assert.deepEqual(focusCalls, [{ course: 'OS' }, { course: 'OS' }], 'saved course.focusTopics update re-fetches course.focusProgress');
    } finally {
      mounted.unmount();
      ui.exports.setUiLanguage('zh');
    }
  });
});

test('empty focus topics offer an entry into existing generation from both course settings and the home line when no weak focus question blocks it', () => {
  const generated = [];
  const rowsHtml = render(h(m.FocusProgressRows, { progress, lock: false, onGenerateTopic: topic => generated.push(topic) }));
  assert.match(text(rowsHtml), /页面置换 还没有题 去出题/);
  assert.equal((rowsHtml.match(/去出题/g) || []).length, 1, 'only status === none topics get the generation button');
  assert.match(text(render(h(m.FocusProgressRows, { progress, lock: false, onGenerateTopic: noop }), 'en')), /No questions Generate questions/);

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
  assert.match(textOf(lineBtns[1]), /去出缺题重点/);
  lineBtns[1].props.onClick();
  assert.deepEqual(lineCalls, [[['页面置换', '银行家算法'], 'OS']]);
  assert.equal(m.appendFocus('死锁', ['页面置换', '死锁', '银行家算法']), '死锁；页面置换；银行家算法');
  assert.match(visible(render(h(m.FocusProgressLine, { progress: noWeak, courseId: 'course-os', lock: false, start: noop, onGenerateFocus: noop }), 'en')), /Generate for empty focus topics/);
});

test('narrow viewports: focus action links wrap instead of overflowing and keep the trailing arrow glued to the last word (#1155)', () => {
  const { declarations } = parseCss(readFileSync('ui/components/components.css', 'utf8'));
  const splitSelectors = (sel) => sel.split(/,(?![^(]*\))/).map((s) => s.trim());
  const wrapDecls = declarations.filter(
    (d) => splitSelectors(d.ctx.at(-1) || '').includes('.sh-btn--link[class~="sh-btn--wrap"]'),
  );
  assert.equal(wrapDecls.some((d) => d.prop === 'display' && d.value === 'inline'), true, '.sh-btn--link[class~="sh-btn--wrap"] sets display: inline');
  assert.equal(wrapDecls.some((d) => d.prop === 'min-width' && d.value === '0'), true, '.sh-btn--link[class~="sh-btn--wrap"] sets min-width: 0');
  const tailDecls = declarations.filter(
    (d) => splitSelectors(d.ctx.at(-1) || '').includes('.sh-btn__tail'),
  );
  // The last word of the label keeps its arrow: the last declaration that sets the wrap mode must be white-space: nowrap.
  // A later text-wrap shorthand (pretty, balance, wrap) or text-wrap-mode resets the mode and would let the arrow wrap away (#1155).
  const lastWrapMode = tailDecls.findLast((d) => /^(?:white-space|text-wrap|text-wrap-mode)$/.test(d.prop));
  assert.equal(lastWrapMode && `${lastWrapMode.prop}: ${lastWrapMode.value}`, 'white-space: nowrap', '.sh-btn__tail sets white-space: nowrap (the last declaration wins)');

  const enWeak = render(h(m.FocusProgressLine, { progress, courseId: 'course-os', lock: false, start: noop, onCourseSettings: noop }), 'en');
  assert.match(enWeak, /class="sh-btn sh-btn--link sh-btn--md sh-btn--wrap"[^>]*>Practise the focus topics you can&#x27;t do <span class="sh-btn__tail">yet<svg[^>]*sh-icon--inline sh-icon--trail/);
  assert.match(visible(enWeak), /Practise the focus topics you can't do yet/);

  const noWeak = { ...progress, weak: 0, none: 1, weakScope: [], topics: [{ topic: 'Paging', cards: 0, counts: counts(), mastery: 0, status: 'none', weakCards: [] }] };
  const enEmpty = render(h(m.FocusProgressLine, { progress: noWeak, courseId: 'course-os', lock: false, start: noop, onCourseSettings: noop, onGenerateFocus: noop }), 'en');
  assert.match(enEmpty, /class="sh-btn sh-btn--link sh-btn--md sh-btn--wrap"[^>]*>Generate for empty focus <span class="sh-btn__tail">topics<svg[^>]*sh-icon--inline sh-icon--trail/);

  const zhWeak = render(h(m.FocusProgressLine, { progress, courseId: 'course-os', lock: false, start: noop, onCourseSettings: noop }), 'zh');
  assert.match(zhWeak, /class="sh-btn sh-btn--link sh-btn--md sh-btn--wrap"[^>]*><span class="sh-btn__tail">练还不会的重点<svg[^>]*sh-icon--inline sh-icon--trail/);
});
