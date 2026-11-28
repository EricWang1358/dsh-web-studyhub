/* The 总纲 page drawn (zh and en) from a course.outline answer, its rows and keys (pure), the registry row that reaches it, and the home:
   the folded 课程路线 list is gone, the 总纲 is a visible secondary button beside the course title and in the 学习目录 heading. Fakes only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { loadInteractiveUi, withBrowserGlobals, click } from './helpers/react-harness.mjs';
import { dom } from './helpers/usage-dom.mjs';

const ui = await loadUi(`
  export { default as CourseOutline, CourseOutlineView } from './ui/outline/CourseOutline.jsx';
  export * from './ui/outline/model.js';
  export { default as CourseRoute } from './ui/CourseRoute.jsx';
  export { default as DeskIntro } from './ui/study-map/DeskIntro.jsx';
  export { default as CatalogHeading } from './ui/study-map/CatalogHeading.jsx';
  export { default as StudyMap } from './ui/StudyMap.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
  export { PAGES, backLabelOf, navLabelOf } from './ui/pages.js';
  export { pageAvailable } from './ui/capabilities.js';`);
const h = React.createElement;
const noop = () => {};
const han = /[㐀-鿿]/;
const services = { call: async () => ({}), act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };
const render = element => renderToStaticMarkup(h(ui.StudyServicesContext.Provider, { value: services }, element));
const english = fn => { ui.setUiLanguage('en'); try { return fn(); } finally { ui.setUiLanguage('zh'); } };
const textOf = html => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const summary = (total, state = 'learning', percent = 40) => ({ total, counts: { new: 0, weak: 0, learning: total, familiar: 0, mastered: 0 }, due: 0, weak: 0, fresh: 0, inactive: 0, percent: total ? percent : null, state: total ? state : 'none' });
const outline = {
  status: 'ok', course: 'Databases', total: 5, placed: 4, summary: summary(5), draftCards: 2, limit: 200,
  decks: [{ id: 'd1', title: 'Indexes deck', total: 4 }, { id: 'd2', title: 'Fuzzy deck', total: 1 }], deckId: null,
  documents: [
    { key: 'pdf:book', title: 'book.pdf', format: 'pdf', chapters: 2, total: 4, summary: summary(4), deckCount: 2 },
    { key: 'source:empty', title: 'Unused slides', format: 'text', chapters: 0, total: 0, summary: summary(0), deckCount: 0 },
  ],
  unplaced: { key: 'unplaced', total: 2, summary: summary(2, 'unlearned', 0), reasons: { none: 1, uncategorised: 1, elsewhere: 0, missing: 0 }, materials: [{ key: 'source:loose', title: 'loose-note.md' }] },
  open: {},
};
const details = {
  'pdf:book': { chapters: [
    { key: 'pdf:book#0', kind: 'chapter', index: 0, title: 'Indexes', level: 1, total: 3, summary: summary(3), deckCount: 2 },
    { key: 'pdf:book#1', kind: 'chapter', index: 1, title: 'Transactions', level: 1, total: 2, summary: summary(2), deckCount: 1, resume: { runId: 'r1', index: 1, total: 2 } },
  ] },
  'pdf:book#0': { cards: [
    { deckId: 'd1', cardId: 'c1', deckTitle: 'Indexes deck', prompt: 'What does a B-tree index speed up?', level: 'learning', due: true },
    { deckId: 'd1', cardId: 'c3', deckTitle: 'Indexes deck', prompt: 'Why is a covering index cheaper?', level: 'new', due: false, shared: true },
  ], more: 0 },
  unplaced: { cards: [{ deckId: 'd1', cardId: 'c4', deckTitle: 'Indexes deck', prompt: 'A question with no source', level: 'new', due: false, reason: 'none' },
    { deckId: 'd1', cardId: 'c5', deckTitle: 'Indexes deck', prompt: 'A question on a loose note', level: 'new', due: false, reason: 'uncategorised' }], more: 0 },
};
const actions = { onBack: noop, onCreate: noop, onOpenSources: noop, retry: noop, toggle: noop, onPick: noop, onPickCard: noop, onPracticeRow: noop, clearPick: noop, practisePicked: noop, chooseDeck: noop };
const page = (extra = {}) => render(h(ui.CourseOutlineView, { course: 'Databases', outline, details, open: new Set(['pdf:book', 'pdf:book#0', 'unplaced']), pick: ui.emptyPick(), actions, ...extra }));
const DATA = /Databases|book\.pdf|Unused slides|Indexes deck|Fuzzy deck|Indexes|Transactions|What does a B-tree index speed up\?|Why is a covering index cheaper\?|A question with no source|A question on a loose note|loose-note/g;

test('the rows: documents, the chapters of an open one, 未归位 last; the keys walk and open them', () => {
  const rows = ui.outlineRows(outline, details, new Set(['pdf:book']));
  assert.deepEqual(rows.map(row => [row.key, row.level, row.kind, row.hasChildren]),
    [['pdf:book', 1, 'document', true], ['pdf:book#0', 2, 'chapter', false], ['pdf:book#1', 2, 'chapter', false], ['source:empty', 1, 'document', false], ['unplaced', 1, 'unplaced', false]]);
  assert.deepEqual(ui.outlineKey(rows, 'pdf:book', 'ArrowRight'), { focus: 'pdf:book#0' }, 'an open document: Right goes to its first chapter');
  assert.deepEqual(ui.outlineKey(rows, 'pdf:book#0', 'ArrowRight'), { toggle: 'pdf:book#0', open: true }, 'a chapter opens its questions');
  assert.deepEqual(ui.outlineKey(rows, 'pdf:book#1', 'ArrowLeft'), { focus: 'pdf:book' });
  assert.deepEqual(ui.outlineKey(rows, 'pdf:book', 'ArrowLeft'), { toggle: 'pdf:book', open: false });
  assert.deepEqual(ui.outlineKey(rows, 'source:empty', 'End'), { focus: 'unplaced' });
  assert.equal(ui.outlineKey(rows, 'pdf:book', 'a'), null);
  const closed = ui.outlineRows(outline, details, new Set());
  assert.deepEqual(closed.map(row => row.key), ['pdf:book', 'source:empty', 'unplaced']);
});

test('the pick: rows and questions, as the argument course.outline takes, and a question in a picked row shows ticked', () => {
  let pick = ui.pickRow(ui.emptyPick(), 'pdf:book#0', true);
  pick = ui.pickCard(pick, { deckId: 'd1', cardId: 'c4' }, true);
  assert.deepEqual(ui.pickArgs(pick), { keys: ['pdf:book#0'], cards: [{ deckId: 'd1', cardId: 'c4' }] });
  assert.equal(ui.cardTicked(pick, { deckId: 'd1', cardId: 'c1' }, ['pdf:book#0', 'pdf:book']), true);
  assert.equal(ui.cardTicked(pick, { deckId: 'd1', cardId: 'c1' }, ['pdf:book#1']), false);
  assert.equal(ui.isPicked(ui.pickRow(pick, 'pdf:book#0', false)), true, 'the question picked alone stays');
  ui.keepView('root', 'Databases', { open: new Set(['pdf:book']), deckId: 'd2' });
  assert.deepEqual(ui.keptView('root', 'Databases'), { open: ['pdf:book'], deckId: 'd2' });
  assert.equal(ui.keptView('root', 'Other'), null);
});

test('the page: title, mastery in the 资料 list\'s words, the rows with 练这一节 / 接着练, the questions with their deck and level, 未归位', () => {
  const html = page(), text = textOf(html);
  assert.match(text, /总纲 · Databases/);
  assert.match(text, /返回学习库/);
  assert.match(text, /掌握 40% · 5 题/, 'the course line: MasteryLine, the 资料 list\'s words');
  assert.match(text, /2 份资料 · 草稿里另有 2 题（发布后计入）/);
  assert.match(text, /Indexes 掌握 40% · 3 题/);
  assert.match(text, /练这一节/);
  assert.match(text, /接着练 2\/2/, 'a row with an unfinished round of its questions goes on with it');
  assert.match(text, /Unused slides 还没出题/);
  assert.match(text, /What does a B-tree index speed up\? Indexes deck/);
  assert.match(text, /学习中 到期/);
  assert.match(text, /也列在别处/);
  assert.match(text, /未归位 未学 · 2 题/);
  assert.match(text, /A question with no source Indexes deck · 没有引用资料/);
  assert.match(text, /A question on a loose note Indexes deck · 引用的资料没有归入这门课/);
  assert.match(text, /把这些资料归入这门课后，引用它们的题会出现在总纲里：loose-note 去资料页归入课程/, 'the 未归位 group names the material to file and links to the 资料 page');
  assert.doesNotMatch(textOf(page({ actions: { ...actions, onOpenSources: undefined } })), /去资料页归入课程/, 'no 资料 page, no link');
  const tree = dom(html).all;
  const toggles = tree.filter(node => node.getAttribute('data-outline-toggle') !== null);
  assert.deepEqual(toggles.map(node => node.getAttribute('tabindex')), ['0', '-1', '-1', '-1', '-1'], 'one tab stop for the row buttons');
  assert.equal(toggles[0].getAttribute('aria-expanded'), 'true');
  assert.equal(tree.filter(node => node.getAttribute('class')?.includes('outline-bar')).length, 0, 'nothing picked: no bar');
});

test('the one hover explanation says what the outline is and how a round orders its questions; it is reachable by keyboard', () => {
  const html = page(), nodes = dom(html).all;
  const tips = nodes.filter(node => node.getAttribute('role') === 'tooltip');
  const what = tips.find(tip => /总纲把这门课的资料/.test(tip.textContent));
  assert.ok(what, 'the explanation is there');
  assert.match(what.textContent, /到期 → 薄弱 → 新题/);
  assert.match(what.textContent, /一轮最多 200 题/);
  const anchor = nodes.find(node => (node.getAttribute('aria-describedby') || '').split(/\s+/).includes(what.getAttribute('id')));
  assert.equal(anchor?.getAttribute('tabindex'), '0');
});

test('a pick shows the bar with the de-duplicated count and, over 200, what a round takes', () => {
  const pick = ui.pickRow(ui.emptyPick(), 'pdf:book', true);
  const counting = textOf(page({ pick }));
  assert.match(counting, /正在计算…/);
  const html = page({ pick, picked: { scope: [], total: 250, capped: true, limit: 200 } }), text = textOf(html);
  assert.match(text, /已选 250 题/);
  assert.match(text, /共 250 题，一轮最多 200 题：先练到期、薄弱和新题里排在前面的 200 题。/);
  assert.match(text, /练选中的 200 题/);
  assert.equal((html.match(/data-variant="primary"|sh-btn--primary/g) || []).length, 1, 'one primary on the page');
});

test('the empty states: no question yet points to 创建题组; loading and failure', () => {
  const none = textOf(render(h(ui.CourseOutlineView, { course: 'Databases', outline: { ...outline, total: 0, placed: 0, documents: [outline.documents[1]], unplaced: { ...outline.unplaced, total: 0 } },
    details: {}, open: new Set(), pick: ui.emptyPick(), actions })));
  assert.match(none, /这门课还没有题/);
  assert.match(none, /创建题组/);
  const loading = textOf(render(h(ui.CourseOutline, { data: { root: 'r', revision: 1, focus: { course: 'Databases' } }, onBack: noop, onCreate: noop, onPractice: noop })));
  assert.match(loading, /正在读取总纲…/);
  assert.match(textOf(render(h(ui.CourseOutlineView, { course: 'Databases', outline: null, error: new Error('boom'), open: new Set(), pick: ui.emptyPick(), actions }))), /没能打开总纲/);
});

test('in English the page has no Chinese of its own', () => {
  const pick = ui.pickRow(ui.emptyPick(), 'pdf:book', true);
  english(() => {
    const text = textOf(page({ pick, picked: { scope: [], total: 250, capped: true, limit: 200 } })).replace(DATA, '');
    assert.doesNotMatch(text, han, text.match(/.{0,30}[㐀-鿿].{0,30}/)?.[0]);
    assert.match(text, /Course outline · /);
    assert.match(text, /Practise this/);
    assert.match(text, /Not placed/);
    assert.match(text, /File them on the Sources page/);
    assert.match(text, /What is the outline\?/);
  });
});

test('the page is in the registry, reached from the home, not in the sidebar, and the way back from a round names it', async () => {
  assert.deepEqual({ ...ui.PAGES.outline }, { label: '总纲', title: '总纲', glyph: null, group: null, needs: ['bank', 'study', 'materials'], back: '回到总纲' });
  assert.equal(ui.navLabelOf('outline'), undefined);
  assert.equal(ui.backLabelOf('outline'), '回到总纲');
  assert.equal(ui.backLabelOf('graph'), undefined, 'the other pages keep their way back');

  const interactive = await loadInteractiveUi(`
    export { PAGE_VIEWS } from './ui/app/page-views.jsx';
    export { AppContext } from './ui/app/app-context.js';
    export { StudyServicesContext } from './ui/study-context.jsx';
    export { useLearningNavigation } from './ui/app/use-learning-navigation.js';
    export { setUiLanguage } from './ui/i18n.js';
  `);
  const hi = interactive.React.createElement;
  await withBrowserGlobals(async () => {
    interactive.exports.setUiLanguage('zh');
    const route = {
      course: 'Databases', cards: 10, learned: 4, mastered: 1, weak: 0, current: 0, next: null,
      chapters: [{ deckId: 'd1', title: 'Indexes deck', total: 6, learned: 4, weak: 0, mastered: 1, status: 'current' }],
    };
    const makeApp = (data, navigated) => ({
      data,
      core: { ...services, call: async () => ({}), act: async () => undefined, notify: noop, refresh: async () => {}, setError: noop, refs: { dataRef: { current: data }, epoch: { current: 1 }, navigation: { current: 0 }, examLocation: { current: null } } },
      nav: { page: 'library', navigate: (page) => navigated.push(page), show: { task: noop, page: noop }, leaving: (fn) => fn(), referenceRef: { current: null }, leaveReviewRef: { current: null } },
      lib: { gen: {} },
      set: { setGen: noop, setModal: noop, setRemovingDeck: noop, setGraphScope: noop, setGraphCanvas: noop, setGraphMode: noop, setBoardView: noop },
      session: { run: null, entry: null, enterRun: noop, enterMovedRun: noop, onCoachPractice: noop },
      intents: { startReview: noop, openRun: noop, openDeck: noop, goGenerate: noop, practice: noop, revealHome: 0, setRevealHome: noop },
      drafts: { openDraft: noop, topUpDraft: noop, createManual: noop },
      notebooks: { items: [] },
      tour: { tourStep: null, lineLater: false, sampleBusy: false, sampleForTour: false, openFirstImport: noop, startTour: noop, setRemovingSample: noop, loadSampleAndTour: noop, hideWelcome: noop },
      dailyPlan: { date: '2026-11-26', tasks: [], refresh: noop },
      settingsEntry: { openModelSettings: noop, setCourseSettings: noop },
      learn: { hasTrail: false, trailPage: null, trailLabel: '', returnFromContext: noop, captureContext: () => ({}), rememberContext: noop, openLearningTarget: noop },
      connection: { binding: { effort: { current: '' } } },
    });

    // 1. PAGE_VIEWS.outline mounts CourseOutline directly and renders the loaded outline.
    const outlineNav = [];
    const outlineData = { root: '/pv', revision: 1, decks: [{ id: 'd1', title: 'Indexes deck', course: 'Databases', cards: [] }], sources: [], drafts: [], runs: [], jobs: [], focus: { mode: 'class', course: 'Databases', courses: [{ name: 'Databases' }], route } };
    const outlineServices = { ...services, call: async (action) => (action === 'course.outline' ? outline : {}) };
    const outlineMount = interactive.mount(() => hi(
      interactive.exports.StudyServicesContext.Provider,
      { value: outlineServices },
      hi(interactive.exports.AppContext.Provider, { value: makeApp(outlineData, outlineNav) }, hi(interactive.exports.PAGE_VIEWS.outline)),
    ));
    try {
      await outlineMount.flush();
      assert.match(outlineMount.text(), /总纲 · Databases/, 'PAGE_VIEWS.outline renders CourseOutline');
    } finally {
      outlineMount.unmount();
    }

    // 2. PAGE_VIEWS.library wires onShowOutline to nav.navigate('outline') when outline is available, and omits it when unavailable.
    const navCalls = [];
    const libAvailable = interactive.mount(() => hi(
      interactive.exports.StudyServicesContext.Provider,
      { value: services },
      hi(interactive.exports.AppContext.Provider, { value: makeApp(outlineData, navCalls) }, hi(interactive.exports.PAGE_VIEWS.library)),
    ));
    try {
      const outlineBtn = libAvailable.find((node) => node.type === 'button' && String(node.props?.className || '').includes('outline-entry'));
      assert.ok(outlineBtn, 'home shows 总纲 button when outline capability is available');
      await libAvailable.act(() => click(outlineBtn));
      assert.deepEqual(navCalls, ['outline'], 'clicking 总纲 navigates to outline');
    } finally {
      libAvailable.unmount();
    }

    const disabledData = { ...outlineData, contexts: ['bank', 'study'] };
    assert.equal(ui.pageAvailable(disabledData, 'outline'), false);
    const libUnavailable = interactive.mount(() => hi(
      interactive.exports.StudyServicesContext.Provider,
      { value: services },
      hi(interactive.exports.AppContext.Provider, { value: makeApp(disabledData, []) }, hi(interactive.exports.PAGE_VIEWS.library)),
    ));
    try {
      const outlineBtn = libUnavailable.find((node) => node.type === 'button' && String(node.props?.className || '').includes('outline-entry'));
      assert.equal(outlineBtn, null, 'home hides 总纲 button when outline capability is unavailable');
    } finally {
      libUnavailable.unmount();
    }

    // 3. useLearningNavigation contextLabel uses backLabelOf(origin.page) -> 回到总纲.
    const navHook = interactive.mountHook(interactive.exports.useLearningNavigation, {
      core: { call: async () => ({}), setError: noop, notify: noop, refresh: async () => {}, refs: { dataRef: { current: outlineData }, epoch: { current: 1 }, navigation: { current: 0 }, examLocation: { current: null } } },
      lib: {
        state: { modal: null, contextTrail: [], practiceStack: [], practiceEnded: null, focusRequest: null, detour: null },
        set: { setModal: noop, setContextTrail: noop, setPracticeStack: noop, setPracticeEnded: noop, setFocusRequest: noop, setDetour: noop, setBoardStudyRef: noop, setBoardCompose: noop },
      },
      nav: { page: 'review', show: {}, navigate: noop, leaving: (fn) => fn(), referenceRef: { current: null }, leaveReviewRef: { current: null } },
      session: { run: null, entry: null, enterRun: noop, enterMovedRun: noop },
      rootRef: { current: null },
    });
    try {
      assert.equal(navHook.current.contextLabel({ page: 'outline' }), '回到总纲');
      assert.equal(navHook.current.contextLabel({ page: 'library' }), '返回学习库');
      assert.equal(navHook.current.contextLabel({ page: 'graph' }), '返回原位置');
    } finally {
      navHook.unmount();
    }
  });
});

test('the home: the folded 课程路线 list is gone, the course area links to the 总纲 instead', () => {
  const route = { course: 'Databases', cards: 10, learned: 4, mastered: 1, weak: 0, current: 0, next: null,
    chapters: [{ deckId: 'd1', title: 'Indexes deck', total: 6, learned: 4, weak: 0, mastered: 1, status: 'current' }, { deckId: 'd2', title: 'Fuzzy deck', total: 4, learned: 0, weak: 0, mastered: 0, status: 'upcoming' }] };
  const html = render(h(ui.CourseRoute, { route, onShowOutline: noop })), text = textOf(html);
  assert.doesNotMatch(html, /<details/, 'no folded list');
  assert.doesNotMatch(text, /课程路线 ·|从这一章学|接着学/);
  assert.match(text, /课程进度/);
  assert.doesNotMatch(text, /总纲|按资料的章节找题/, 'no tiny link line under the progress bar any more');
  const deskHtml = render(h(ui.DeskIntro, {
    data: { decks: [{ id: 'd1' }], focus: { mode: 'class', course: 'Databases', courses: [{ name: 'Databases' }], route } },
    home: { interview: false, route, starter: null, headline: 'Databases', plan: { kind: 'path', also: [] }, alternatives: [], otherRuns: [], otherCourse: noop },
    mastery: { primary: null },
    start: noop,
    resume: noop,
    endRun: noop,
    onShowOutline: noop,
  }));
  const routeBlock = deskHtml.match(/<div class="course-route">[\s\S]*?<\/div>\s*<\/div>/)?.[0] || '';
  assert.ok(routeBlock.length > 0, 'DeskIntro renders CourseRoute');
  assert.match(textOf(routeBlock), /课程进度/);
  assert.doesNotMatch(routeBlock, /<button\b|<details\b/, 'CourseRoute inside DeskIntro exposes no chapter-start buttons or folded list');
  assert.doesNotMatch(textOf(deskHtml), /课程路线 ·|从这一章学|接着学/);
});

const buttons = html => [...html.matchAll(/<button\b[^>]*>/g)].map(match => match[0]);
const outlineButtons = html => buttons(html).filter(tag => /outline-entry/.test(tag));

test('the home: the 总纲 is one real secondary button, beside the course title (the 学习目录 heading does not repeat it, #1695)', () => {
  const route = { course: 'Databases', cards: 10, learned: 4, mastered: 1, weak: 0, current: 0, next: null,
    chapters: [{ deckId: 'd1', title: 'Indexes deck', total: 6, learned: 4, weak: 0, mastered: 1, status: 'current' }] };
  const data = { decks: [{ id: 'd1' }], focus: { mode: 'class', course: 'Databases', courses: [{ name: 'Databases' }], route } };
  const home = { interview: false, route, starter: null, headline: 'Databases', plan: { kind: 'path', also: [] }, alternatives: [], otherRuns: [], otherCourse: noop };
  const mastery = { primary: null };
  const desk = (onShowOutline, over = {}) => render(h(ui.DeskIntro, { data, home: { ...home, ...over }, mastery, role: { draft: '', setDraft: noop }, busy: false, start: noop, resume: noop, endRun: noop, onShowOutline }));
  const withIt = desk(noop), tags = outlineButtons(withIt);
  assert.equal(tags.length, 1, 'one 总纲 button beside the course title');
  assert.match(tags[0], /^<button type="button" class="sh-btn sh-btn--secondary sh-btn--md outline-entry"/, 'a secondary button, not the primary one');
  assert.doesNotMatch(tags[0], /sh-btn--primary|sh-btn--link/);
  assert.ok(withIt.indexOf('outline-entry') > withIt.indexOf('course-heading'), 'on the course title row');
  assert.ok(withIt.indexOf('outline-entry') < withIt.indexOf('course-route'), 'above the progress bar, not under it');
  assert.match(textOf(withIt), /总纲/);
  assert.match(withIt, /role="tooltip"[^>]*>按资料的章节找题、挑题练</, 'the explanation is a Tooltip, not a title attribute');
  assert.doesNotMatch(tags[0], /title=/);
  assert.equal(outlineButtons(desk(undefined)).length, 0, 'without the page, no button');
  assert.equal(outlineButtons(desk(noop, { route: null })).length, 0, 'no course route, no button');
  assert.equal(outlineButtons(desk(noop, { route: { ...route, chapters: [] } })).length, 0, 'a route without chapters, no button');

  const heading = over => render(h(ui.CatalogHeading, { count: 2, showArchived: false, hasDecks: true, hasSources: true, course: 'Databases', merge: { busy: false, run: noop }, busy: false, slain: null,
    addSource: noop, createManual: noop, importLibrary: noop, manage: noop, onShowGraph: noop, onShowOutline: noop, ...over }));
  const catalog = heading();
  assert.equal(outlineButtons(catalog).length, 0, 'no second 总纲 in the 学习目录 heading');
  assert.match(textOf(catalog), /查看图谱/);
  assert.doesNotMatch(textOf(heading({ onShowGraph: undefined })), /查看图谱/, 'no graph handler, no button');
  assert.doesNotMatch(catalog + withIt, /sh-btn--primary/, 'neither entry is a primary button');

  const wording = english(() => desk(noop) + heading());
  assert.doesNotMatch(textOf(wording), han, textOf(wording).match(/.{0,30}[㐀-鿿].{0,30}/)?.[0]);
  assert.match(textOf(wording), /Course outline Find questions by the chapters of your materials/);
});

test('#1695: the home draws one 总纲 and one graph entry: 掌握图谱 under mastery, else 查看图谱 on the 学习目录 heading', () => {
  const route = { course: 'Databases', cards: 10, learned: 4, mastered: 1, weak: 0, current: 0, next: null,
    chapters: [{ deckId: 'd1', title: 'Indexes deck', total: 6, learned: 4, weak: 0, mastered: 1, status: 'current' }] };
  const deck = { id: 'd1', title: 'Indexes deck', course: 'Databases', folder: 'Databases', topics: [], available: 6, count: 6, createdAt: '2026-09-01T00:00:00Z' };
  const home = ({ progress = {}, actions = {} } = {}) => render(h(ui.StudyMap, { data: { root: '/one-entry', decks: [deck], progress, sources: [{ id: 's' }], drafts: [], jobs: [], runs: [],
    today: { due: 0, weak: 0, new: 0, size: 0 }, focus: { mode: 'class', course: 'Databases', courses: [{ name: 'Databases' }], route, fresh: [] } },
  actions: { onShowOutline: noop, onShowGraph: noop, onOpenMasteryMap: noop, ...actions } }));
  const count = (html, words) => (html.match(new RegExp(`>${words}<`, 'g')) || []).length;
  const measured = { d1: { counts: { mastered: 1, familiar: 1, learning: 1, weak: 1, new: 2 }, total: 6, mastery: 40, due: 0, status: 'active', topics: [] } };
  const full = home({ progress: measured });
  assert.equal(outlineButtons(full).length, 1, 'one 总纲');
  assert.deepEqual([count(full, '掌握图谱'), count(full, '查看图谱')], [1, 0], 'one graph entry, under mastery');
  const unmeasured = home();
  assert.deepEqual([count(unmeasured, '掌握图谱'), count(unmeasured, '查看图谱')], [0, 1], 'no mastery to show yet: the catalogue keeps the way to the graph');
  const noMap = home({ progress: measured, actions: { onOpenMasteryMap: undefined } });
  assert.deepEqual([count(noMap, '掌握图谱'), count(noMap, '查看图谱')], [0, 1], 'no way to the mastery map: the catalogue keeps the way to the graph');
  assert.equal(outlineButtons(home({ actions: { onShowOutline: undefined } })).length, 0);
});

function mountOutlineSync(Component, initialProps, overrideServices = services) {
  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const hooks = [];
  const effectRecords = [];
  let cursor = 0;
  let dirty = false;
  let unmounted = false;
  let currentProps = initialProps;
  let tree = null;
  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

  const renderPass = () => {
    if (unmounted) return tree;
    dirty = false;
    cursor = 0;
    const pendingEffects = [];
    const prevH = internals.H;
    internals.H = {
      useContext: ctx => (ctx === ui.StudyServicesContext ? overrideServices : ctx._currentValue),
      useState: init => {
        const idx = cursor++;
        if (!(idx in hooks)) {
          const setter = next => {
            if (unmounted) return;
            const prevVal = hooks[idx][0];
            const nextVal = typeof next === 'function' ? next(prevVal) : next;
            if (!Object.is(prevVal, nextVal)) {
              hooks[idx][0] = nextVal;
              dirty = true;
            }
          };
          hooks[idx] = [typeof init === 'function' ? init() : init, setter];
        }
        return hooks[idx];
      },
      useRef: init => {
        const idx = cursor++;
        if (!(idx in hooks)) hooks[idx] = { current: init };
        return hooks[idx];
      },
      useMemo: (fn, deps) => {
        const idx = cursor++;
        if (!(idx in hooks) || deps === undefined || !sameDeps(hooks[idx].deps, deps)) hooks[idx] = { deps, value: fn() };
        return hooks[idx].value;
      },
      useCallback: (fn, deps) => internals.H.useMemo(() => fn, deps),
      useEffect: (fn, deps) => {
        const idx = cursor++;
        const prev = hooks[idx];
        if (!prev || deps === undefined || !sameDeps(prev.deps, deps)) pendingEffects.push({ idx, fn, deps });
      },
      useLayoutEffect: (fn, deps) => internals.H.useEffect(fn, deps),
      useInsertionEffect: (fn, deps) => internals.H.useEffect(fn, deps),
      useId: () => {
        const idx = cursor++;
        if (!(idx in hooks)) hooks[idx] = `:outline-test-${idx}:`;
        return hooks[idx];
      },
      useMemoCache: size => {
        const idx = cursor++;
        if (!(idx in hooks)) hooks[idx] = new Array(size);
        return hooks[idx];
      },
    };
    try {
      tree = Component(currentProps);
    } finally {
      internals.H = prevH;
    }
    for (const eff of pendingEffects) {
      const prevRecord = effectRecords[eff.idx];
      prevRecord?.cleanup?.();
      const cleanup = eff.fn();
      hooks[eff.idx] = { deps: eff.deps };
      effectRecords[eff.idx] = { fn: eff.fn, deps: eff.deps, cleanup: typeof cleanup === 'function' ? cleanup : null };
    }
    return tree;
  };

  const settle = () => {
    for (let i = 0; i < 6 && dirty && !unmounted; i += 1) renderPass();
    return tree;
  };

  renderPass();
  settle();

  return {
    getTree: () => tree,
    rerender: nextProps => { currentProps = nextProps; renderPass(); return settle(); },
    flush: async () => {
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
      return settle();
    },
    simulateStrictModeDoubleEffect: () => {
      for (const rec of effectRecords) if (rec?.cleanup) { rec.cleanup(); rec.cleanup = null; }
      for (const rec of effectRecords) if (rec?.fn) {
        const cleanup = rec.fn();
        rec.cleanup = typeof cleanup === 'function' ? cleanup : null;
      }
      return settle();
    },
    unmount: () => {
      unmounted = true;
      for (const rec of effectRecords) if (rec?.cleanup) { rec.cleanup(); rec.cleanup = null; }
    },
  };
}

function withFakeRaf(fn) {
  const prevRaf = globalThis.requestAnimationFrame;
  const prevCaf = globalThis.cancelAnimationFrame;
  let nextId = 1;
  const queue = new Map();
  globalThis.requestAnimationFrame = cb => {
    const id = nextId++;
    queue.set(id, cb);
    return id;
  };
  globalThis.cancelAnimationFrame = id => { queue.delete(id); };
  const flushRaf = () => {
    const callbacks = [...queue.values()];
    queue.clear();
    for (const cb of callbacks) cb(0);
  };
  return Promise.resolve().then(() => fn(flushRaf)).finally(() => {
    globalThis.requestAnimationFrame = prevRaf;
    globalThis.cancelAnimationFrame = prevCaf;
  });
}

test('outline one-shot targets expire after 15s, delete on clear/expiry, and resolveOutlineDeckFilter clears filter only when targeted (#1224, #1226)', () => {
  ui.clearOutlineTarget('/ttl', 'Databases');

  ui.keepOutline('/ttl', 'Databases', { target: 'pdf:book#1', leafKey: 'bk:p1' }, 1000);
  assert.deepEqual(ui.keptOutlineTarget('/ttl', 'Databases', 1000), { target: 'pdf:book#1', leafKey: 'bk:p1' });
  assert.deepEqual(ui.keptOutlineTarget('/ttl', 'Databases', 16000), { target: 'pdf:book#1', leafKey: 'bk:p1' }, 'still valid at exact 15s boundary');
  assert.equal(ui.keptOutlineTarget('/ttl', 'Databases', 16001), null, 'expired after 15s');
  assert.equal(ui.keptOutlineTarget('/ttl', 'Databases', 1000), null, 'expired target was deleted from the in-memory map');

  ui.keepOutline('/ttl', 'Databases', { target: 'pdf:book#0' }, NaN);
  assert.equal(ui.keptOutlineTarget('/ttl', 'Databases', 1000), null, 'non-finite timestamp expires and deletes');

  ui.keepOutline('/ttl', 'Databases', { target: 'pdf:book#0' }, 5000);
  ui.clearOutlineTarget('/ttl', 'Databases');
  assert.equal(ui.keptOutlineTarget('/ttl', 'Databases', 5001), null, 'clearOutlineTarget deletes entry');

  ui.keepOutline('/ttl', 'Databases', { target: 'pdf:book#0' }, 5000);
  ui.keepOutline('/ttl', 'Databases', { target: null }, 5001);
  assert.equal(ui.keptOutlineTarget('/ttl', 'Databases', 5002), null, 'keepOutline with null target clears entry');

  assert.equal(ui.resolveOutlineDeckFilter({ deckId: 'd1' }, { target: 'pdf:book#0' }), '');
  assert.equal(ui.resolveOutlineDeckFilter({ deckId: 'd1' }, true), '');
  assert.equal(ui.resolveOutlineDeckFilter({ deckId: 'd1' }, null), 'd1');
  assert.equal(ui.resolveOutlineDeckFilter({ deckId: 'd1' }, false), 'd1');
  assert.equal(ui.resolveOutlineDeckFilter(null, null), '');
});

test('CourseOutline resets stale deck filter on target, notifies when target row is missing (zh & en), restores filter without target, and survives React 18 StrictMode double-effect (#1224, #1226)', async () => {
  await withFakeRaf(async (flushRaf) => {
    const root = '/outline-target-test';
    const course = 'Databases';
    ui.keepView(root, course, { open: new Set(['pdf:book']), deckId: 'd1' });

    // 1. Missing target row resets deckId filter to '' and notifies in Chinese and English (zero Han in English).
    for (const [lang, expected] of [['zh', '没有在总纲里找到这道题的出处'], ['en', 'Could not find where this question is in the course outline']]) {
      ui.setUiLanguage(lang);
      try {
        ui.keepView(root, course, { open: new Set(['pdf:book']), deckId: 'd1' });
        ui.keepOutline(root, course, { target: 'pdf:missing#2' });
        const notices = [];
        const callArgs = [];
        const testServices = {
          ...services,
          notify: value => notices.push(value),
          call: async (action, args) => {
            callArgs.push([action, args]);
            if (action === 'course.outline') return { ...outline, open: {} };
            return {};
          },
        };
        const mounted = mountOutlineSync(ui.CourseOutline, {
          data: { root, revision: 1, focus: { course }, sources: [], jobs: [], settings: {} },
          onBack: noop, onCreate: noop, onPractice: noop,
        }, testServices);
        assert.equal(mounted.getTree().props.deckId, '', `${lang}: arriving with target resets deck filter`);
        assert.equal(callArgs[0][1].deckId, undefined, `${lang}: course.outline is requested without stale deckId`);
        await mounted.flush();
        flushRaf();
        await mounted.flush();
        assert.deepEqual(notices, [expected]);
        if (lang === 'en') assert.doesNotMatch(notices[0], han);
        assert.equal(ui.keptOutlineTarget(root, course), null, `${lang}: target cleared after missing notice`);
        mounted.unmount();
      } finally {
        ui.setUiLanguage('zh');
      }
    }

    // 2. React 18 StrictMode double-effect clears Map on simulated cleanup, yet pendingTarget in state still scrolls when outline loads.
    ui.keepView(root, course, { open: new Set(), deckId: 'd2' });
    ui.keepOutline(root, course, { target: 'pdf:book#0' });
    const scrolled = [];
    const strictNotices = [];
    let resolveOutline;
    const strictServices = {
      ...services,
      notify: value => strictNotices.push(value),
      call: async action => {
        if (action === 'course.outline') {
          return new Promise(resolve => { resolveOutline = resolve; });
        }
        return {};
      },
    };
    const strictMounted = mountOutlineSync(ui.CourseOutline, {
      data: { root, revision: 1, focus: { course }, sources: [], jobs: [], settings: {} },
      onBack: noop, onCreate: noop, onPractice: noop,
    }, strictServices);
    assert.equal(strictMounted.getTree().props.deckId, '');
    strictMounted.simulateStrictModeDoubleEffect();
    assert.equal(ui.keptOutlineTarget(root, course), null, 'StrictMode cleanup cleared module map');
    strictMounted.getTree().props.pageRef.current = {
      querySelector: selector => (selector === '[data-key="pdf:book#0"]'
        ? { scrollIntoView: opts => scrolled.push(opts) }
        : null),
    };
    resolveOutline({
      ...outline,
      open: { 'pdf:book': details['pdf:book'], 'pdf:book#0': details['pdf:book#0'] },
    });
    await strictMounted.flush();
    flushRaf();
    await strictMounted.flush();
    assert.deepEqual(scrolled, [{ block: 'center' }], 'pendingTarget state still scrolls after StrictMode effect re-run');
    assert.deepEqual(strictNotices, [], 'no missing-target notice when row is found');
    strictMounted.unmount();

    // 3. Normal mount without target restores saved deckId filter.
    ui.keepView(root, course, { open: new Set(['pdf:book']), deckId: 'd2' });
    ui.clearOutlineTarget(root, course);
    const normalMounted = mountOutlineSync(ui.CourseOutline, {
      data: { root, revision: 1, focus: { course }, sources: [], jobs: [], settings: {} },
      onBack: noop, onCreate: noop, onPractice: noop,
    });
    assert.equal(normalMounted.getTree().props.deckId, 'd2', 'normal mount without target restores saved deck filter');
    normalMounted.unmount();
  });
});

test('CourseOutline clears pending target on load error, early unmount, and course switch without polluting keptView (#1224, #1226)', async () => {
  await withFakeRaf(async () => {
    // 1. Load failure clears target and preserves prior keptView.
    const errRoot = '/err-root';
    ui.keepView(errRoot, 'Databases', { open: new Set(), deckId: 'd1' });
    ui.keepOutline(errRoot, 'Databases', { target: 'pdf:book#1' });
    const errMounted = mountOutlineSync(ui.CourseOutline, {
      data: { root: errRoot, revision: 1, focus: { course: 'Databases' }, sources: [], jobs: [], settings: {} },
      onBack: noop, onCreate: noop, onPractice: noop,
    }, {
      ...services,
      call: async action => {
        if (action === 'course.outline') throw new Error('outline boom');
        return {};
      },
    });
    await errMounted.flush();
    assert.ok(errMounted.getTree().props.error, 'error state recorded');
    assert.equal(ui.keptOutlineTarget(errRoot, 'Databases'), null, 'error clears one-shot target');
    assert.deepEqual(ui.keptView(errRoot, 'Databases'), { open: [], deckId: 'd1' }, 'failed load does not overwrite keptView');
    errMounted.unmount();

    // 2. Unmount before load settles clears target and preserves prior keptView.
    const abortRoot = '/abort-root';
    ui.keepView(abortRoot, 'Databases', { open: new Set(), deckId: 'd2' });
    ui.keepOutline(abortRoot, 'Databases', { target: 'pdf:book#1' });
    const abortMounted = mountOutlineSync(ui.CourseOutline, {
      data: { root: abortRoot, revision: 1, focus: { course: 'Databases' }, sources: [], jobs: [], settings: {} },
      onBack: noop, onCreate: noop, onPractice: noop,
    }, {
      ...services,
      call: () => new Promise(() => {}),
    });
    abortMounted.unmount();
    assert.equal(ui.keptOutlineTarget(abortRoot, 'Databases'), null, 'unmount clears pending target');
    assert.deepEqual(ui.keptView(abortRoot, 'Databases'), { open: [], deckId: 'd2' }, 'aborted load does not overwrite keptView');

    // 3. Course switch clears previous course target and resets/restores next course deckId appropriately.
    const swRoot = '/switch-root';
    ui.keepView(swRoot, 'CourseA', { open: new Set(), deckId: 'dA' });
    ui.keepView(swRoot, 'CourseB', { open: new Set(), deckId: 'dB' });
    ui.keepView(swRoot, 'CourseC', { open: new Set(), deckId: 'dC' });
    ui.keepOutline(swRoot, 'CourseA', { target: 'docA#1' });
    ui.keepOutline(swRoot, 'CourseB', { target: 'docB#2' });
    ui.clearOutlineTarget(swRoot, 'CourseC');

    const swMounted = mountOutlineSync(ui.CourseOutline, {
      data: { root: swRoot, revision: 1, focus: { course: 'CourseA' }, sources: [], jobs: [], settings: {} },
      onBack: noop, onCreate: noop, onPractice: noop,
    });
    assert.equal(swMounted.getTree().props.deckId, '');

    swMounted.rerender({
      data: { root: swRoot, revision: 1, focus: { course: 'CourseB' }, sources: [], jobs: [], settings: {} },
      onBack: noop, onCreate: noop, onPractice: noop,
    });
    assert.equal(ui.keptOutlineTarget(swRoot, 'CourseA'), null, 'switching course clears previous course target');
    assert.equal(swMounted.getTree().props.deckId, '', 'CourseB target resets CourseB deck filter');

    swMounted.rerender({
      data: { root: swRoot, revision: 1, focus: { course: 'CourseC' }, sources: [], jobs: [], settings: {} },
      onBack: noop, onCreate: noop, onPractice: noop,
    });
    assert.equal(ui.keptOutlineTarget(swRoot, 'CourseB'), null, 'switching again clears CourseB target');
    assert.equal(swMounted.getTree().props.deckId, 'dC', 'CourseC without target restores CourseC deck filter');
    swMounted.unmount();
  });
});
