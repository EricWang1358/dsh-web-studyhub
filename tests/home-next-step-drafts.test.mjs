import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { mapProps } from './helpers/study-map-props.mjs';
import { nativeSelects } from './helpers/native-selects.mjs';

const m = await loadUi(`
  export * from './ui/study-map/next-step.js';
  export { nextCardView } from './ui/study-map/next-card-view.js';
  export { buildHomePlan } from './ui/study-map/home-plan.js';
  export { setUiLanguage } from './ui/i18n.js';
`);

const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: {
    contents: "export { default as StudyMap } from './ui/StudyMap.jsx'; export { setUiLanguage } from './ui/i18n.js';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['react'],
  plugins: [nativeSelects],
  loader: { '.css': 'text' },
  logLevel: 'silent',
});
const mapMod = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, mapMod, mapMod.exports);
const { StudyMap, setUiLanguage: setMapLang } = mapMod.exports;
const h = React.createElement;

const NOW = new Date(2026, 10, 10, 10, 0, 0);
const READY = { ready: true, reason: 'ok', label: 'DeepSeek' };
const NOTHING = { ready: false, reason: 'no-route', label: '' };
const quietToday = { due: 0, weak: 0, new: 0, size: 0, ahead: false };
const BANNED = /您|请勿|必须|暂无|啦|哎呀|～|主对话/;
const HAN = /[\u3400-\u9fff]/;

const makeCards = (n) => Array.from({ length: n }, (_, i) => ({
  id: `c-${i + 1}`,
  front: `Q${i + 1}`,
  back: `A${i + 1}`,
  citations: [{ sourceId: 's1', snippet: 'text' }],
}));

const makeDraft = (id, { title = `草稿 ${id}`, cards = 25, course = 'CS3219', ...extra } = {}) => ({
  id,
  title,
  course,
  folder: course,
  cards: Array.isArray(cards) ? cards : makeCards(cards),
  quality: { warnings: [], errors: [] },
  ...extra,
});

const makeDeck = (id = 'd1', { title = '第一套题', course = 'CS3219', ...extra } = {}) => ({
  id,
  title,
  course,
  folder: course,
  topics: ['Topic 1'],
  available: 10,
  count: 10,
  quizCount: 10,
  wrong: 0,
  createdAt: '2026-10-01T00:00:00Z',
  ...extra,
});

function renderMap(dataPatch = {}, actionOverrides = {}) {
  const noop = () => {};
  const courses = dataPatch.focus?.courses || [{ name: 'CS3219' }];
  const data = {
    root: '/tmp/lib-964',
    model: READY,
    decks: [makeDeck()],
    progress: { d1: { counts: { mastered: 10, familiar: 0, learning: 0, weak: 0, new: 0 }, total: 10, mastery: 100, due: 0, status: 'active', topics: [] } },
    sources: [{ id: 's1', title: 'Lecture 1', course: 'CS3219', courses: ['CS3219'], text: 'content' }],
    drafts: [],
    jobs: [],
    runs: [],
    today: { ...quietToday },
    focus: { mode: 'class', course: 'CS3219', courses, fresh: [] },
    ...dataPatch,
  };
  return renderToStaticMarkup(h(StudyMap, mapProps({
    data,
    busy: false,
    start: noop,
    resume: noop,
    endRun: noop,
    manage: noop,
    openDraft: noop,
    topUpDraft: noop,
    retryGeneration: noop,
    addSource: noop,
    createManual: noop,
    importLibrary: noop,
    generateFromSources: noop,
    onWeakPoints: noop,
    onOpenExamBook: noop,
    onFocus: noop,
    notebooks: [],
    ...actionOverrides,
  })));
}

const stripHtml = (html) => html.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const primaryCount = (html) => (html.match(/sh-btn--primary/g) || []).length;

test('single and multiple pending drafts surface in nextStep when 0 published decks exist (even without model) or when first deck is done', () => {
  m.setUiLanguage('zh');
  const dr1 = makeDraft('dr1', { title: '第二讲微测验', cards: 25, course: '' });
  const dr2 = makeDraft('dr2', { title: '第三讲微测验', cards: 15, course: '' });

  // 0 published decks, no AI model configured (e.g. JSON import): checking/publishing a draft needs no model.
  const importedOne = m.nextStepFacts({ root: '/lib', model: NOTHING, decks: [], sources: [], drafts: [dr1], jobs: [], today: quietToday }, { now: NOW });
  assert.equal(importedOne.drafts.count, 1);
  assert.equal(importedOne.drafts.cards, 25);
  assert.deepEqual(m.nextStep(importedOne), { id: 'draft', surface: 'card' });
  assert.equal(m.hasPrimaryAction('draft'), true);

  const opened = [];
  const viewed = [];
  const oneView = m.nextCardView('draft', importedOne, {
    openDraft: (d) => opened.push(d.id),
    viewDrafts: () => viewed.push('all'),
  });
  assert.equal(oneView.eyebrow, '下一步');
  assert.match(oneView.headline, /1.*草稿.*25.*待检查发布/);
  assert.match(oneView.detail, /第二讲微测验/);
  assert.equal(oneView.action.label, '检查并发布');
  oneView.action.run();
  assert.deepEqual(opened, ['dr1']);
  assert.deepEqual(viewed, []);
  assert.doesNotMatch(`${oneView.headline} ${oneView.detail} ${oneView.action.label}`, BANNED);

  // 0 published decks, 2 pending drafts, still no model configured.
  const importedTwo = m.nextStepFacts({ root: '/lib', model: NOTHING, decks: [], sources: [], drafts: [dr1, dr2], jobs: [], today: quietToday }, { now: NOW });
  assert.equal(importedTwo.drafts.count, 2);
  assert.equal(importedTwo.drafts.cards, 40);
  assert.deepEqual(m.nextStep(importedTwo), { id: 'draft', surface: 'card' });

  const twoView = m.nextCardView('draft', importedTwo, {
    openDraft: (d) => opened.push(d.id),
    viewDrafts: () => viewed.push('all'),
  });
  assert.match(twoView.headline, /2.*草稿.*40.*待检查发布/);
  assert.equal(twoView.action.label, '查看待发布草稿');
  twoView.action.run();
  assert.deepEqual(viewed, ['all']);
  assert.doesNotMatch(`${twoView.headline} ${twoView.detail} ${twoView.action.label}`, BANNED);

  // Fallback when viewDrafts is omitted: opens the newest draft.
  const fallbackOpened = [];
  const fallbackView = m.nextCardView('draft', importedTwo, { openDraft: (d) => fallbackOpened.push(d.id) });
  fallbackView.action.run();
  assert.deepEqual(fallbackOpened, ['dr2']);

  // 1st published deck has 0 due reviews (both empty day and ahead-of-schedule finished day): avoids 'done'.
  const secondDraft = makeDraft('dr-ch2', { title: '并发控制练习', cards: 25, course: 'CS3219' });
  for (const today of [quietToday, { due: 0, weak: 0, new: 0, size: 8, ahead: true }]) {
    const factsAfterFirstDone = m.nextStepFacts({
      root: '/lib',
      model: READY,
      decks: [makeDeck('d1', { course: 'CS3219' })],
      sources: [],
      drafts: [secondDraft],
      jobs: [],
      today,
      focus: { mode: 'class', course: 'CS3219', courses: [{ name: 'CS3219' }] },
    }, { now: NOW });
    assert.deepEqual(m.nextStep(factsAfterFirstDone), { id: 'draft', surface: 'card' });
    const card = m.nextCardView('draft', factsAfterFirstDone, { openDraft() {} });
    assert.doesNotMatch(card.headline, /没有要做的复习|任务都完成了/);
  }
});

test('priority order: due and resume outrank draft; draft outranks new-source, wrong, exam, learn, and done; sample and active-job drafts are excluded', () => {
  const draft = makeDraft('dr1', { title: '新草稿', cards: 12, course: 'CS3219' });
  const base = (patch = {}) => ({
    root: '/lib',
    model: READY,
    decks: [makeDeck('d1', { course: 'CS3219', wrong: 4 })],
    sources: [{ id: 's-new', title: '新讲义', course: 'CS3219', courses: ['CS3219'], createdAt: NOW.toISOString(), usedBy: [] }],
    drafts: [draft],
    jobs: [],
    bookCourses: ['CS3219'],
    courses: [{ name: 'CS3219', exam: { date: '2026-11-12' } }],
    today: { due: 0, weak: 2, new: 5, size: 7, ahead: false },
    focus: { mode: 'class', course: 'CS3219', courses: [{ name: 'CS3219' }] },
    ...patch,
  });

  // With a published deck, missing model still takes top priority.
  assert.deepEqual(m.nextStep(m.nextStepFacts(base({ model: NOTHING }), { now: NOW })), { id: 'model', surface: 'card' });

  // Due reviews outrank draft.
  assert.deepEqual(m.nextStep(m.nextStepFacts(base({ today: { due: 3, weak: 2, new: 5, size: 10, ahead: false } }), { now: NOW })), { id: 'due', surface: 'card' });

  // An open practice run (resume) outranks draft when due === 0.
  assert.deepEqual(m.nextStep(m.nextStepFacts(base(), { now: NOW, resumeOpen: true })), { id: 'resume', surface: 'card' });

  // When due === 0 and resumeOpen === false, draft outranks new-source, wrong, exam, learn, and done!
  assert.deepEqual(m.nextStep(m.nextStepFacts(base(), { now: NOW, resumeOpen: false })), { id: 'draft', surface: 'card' });

  // Sample draft, archived draft, and draft still being written by an active generation job do NOT trigger 'draft'.
  const ignored = m.nextStepFacts({
    root: '/lib',
    model: READY,
    decks: [makeDeck('d1', { course: 'CS3219' })],
    sources: [],
    sample: { draftId: 'sample-by-id' },
    drafts: [
      makeDraft('sample-flag', { sample: true, course: 'CS3219' }),
      makeDraft('sample-by-id', { course: 'CS3219' }),
      makeDraft('archived-dr', { archived: true, course: 'CS3219' }),
      makeDraft('generating-dr', { course: 'CS3219' }),
    ],
    jobs: [{ id: 'j-run', type: 'generate', status: 'running', draftId: 'generating-dr' }],
    today: quietToday,
    focus: { mode: 'class', course: 'CS3219', courses: [{ name: 'CS3219' }] },
  }, { now: NOW });
  assert.equal(ignored.drafts.count, 0);
  assert.deepEqual(m.nextStep(ignored), { id: 'done', surface: 'card' });
});

test('course filter scoping: drafts for the selected course (and sub-courses) surface, while other courses stay scoped out', () => {
  const courses = [{ name: 'CS3219' }, { name: 'CS3219 / Week 3' }, { name: 'OS' }];
  const drSub = makeDraft('dr-sub', { title: 'Week 3 Draft', cards: 10, course: 'CS3219 / Week 3' });
  const drOs = makeDraft('dr-os', { title: 'OS Draft', cards: 20, course: 'OS' });

  const inCs = m.nextStepFacts({
    root: '/lib',
    model: READY,
    decks: [makeDeck('d1', { course: 'CS3219' }), makeDeck('d2', { course: 'OS' })],
    sources: [],
    drafts: [drOs],
    jobs: [],
    today: quietToday,
    focus: { mode: 'class', course: 'CS3219', courses },
  }, { now: NOW });
  assert.equal(inCs.drafts.count, 0, 'OS draft does not interrupt CS3219 scope');
  assert.deepEqual(m.nextStep(inCs), { id: 'done', surface: 'card' });

  const withSubCourse = m.nextStepFacts({
    root: '/lib',
    model: READY,
    decks: [makeDeck('d1', { course: 'CS3219' }), makeDeck('d2', { course: 'OS' })],
    sources: [],
    drafts: [drOs, drSub],
    jobs: [],
    today: quietToday,
    focus: { mode: 'class', course: 'CS3219', courses },
  }, { now: NOW });
  assert.equal(withSubCourse.drafts.count, 1, 'parent course scope includes sub-course drafts');
  assert.equal(withSubCourse.drafts.draft.id, 'dr-sub');
  assert.deepEqual(m.nextStep(withSubCourse), { id: 'draft', surface: 'card' });

  const inOs = m.nextStepFacts({
    root: '/lib',
    model: READY,
    decks: [makeDeck('d1', { course: 'CS3219' }), makeDeck('d2', { course: 'OS' })],
    sources: [],
    drafts: [drOs, drSub],
    jobs: [],
    today: quietToday,
    focus: { mode: 'class', course: 'OS', courses },
  }, { now: NOW });
  assert.equal(inOs.drafts.count, 1);
  assert.equal(inOs.drafts.draft.id, 'dr-os');
});

test('TodayCard (buildHomePlan) and StudyMap HomeDrafts surface pending drafts and auto-expand instead of saying empty or all done', () => {
  m.setUiLanguage('zh');
  setMapLang('zh');

  const dr25 = makeDraft('dr-25', { title: '事务隔离级别 25 题', cards: 25, course: 'CS3219' });
  const dr15 = makeDraft('dr-15', { title: '恢复系统 15 题', cards: 15, course: 'CS3219' });

  // 1) buildHomePlan when 1st deck is done (size: 0 or ahead: true) and pending draft(s) exist: never says empty or all done.
  for (const today of [
    { due: 0, weak: 0, new: 0, size: 0, ahead: false, course: 'CS3219', scope: [] },
    { due: 0, weak: 0, new: 0, size: 10, ahead: true, course: 'CS3219', scope: [{ deckId: 'd1' }] },
  ]) {
    const opened = [];
    const revealed = [];
    const singlePlan = m.buildHomePlan({
      data: {
        decks: [makeDeck('d1', { course: 'CS3219' })],
        sources: [],
        drafts: [dr25],
        jobs: [],
        runs: [],
        focus: { mode: 'class', course: 'CS3219', courses: [{ name: 'CS3219' }], fresh: [] },
      },
      today,
      runs: [],
      runFor: () => null,
      activeJobs: [],
      inFocus: () => true,
      revealActivity() {},
      revealDrafts: () => revealed.push('drafts'),
      actions: { start() {}, resume() {}, openDraft: (d) => opened.push(d.id), addSource() {}, importLibrary() {}, generateFromSources() {} },
    });
    assert.doesNotMatch(singlePlan.headline, /还没有可学习的题|任务都完成了/);
    assert.doesNotMatch(singlePlan.plan.detail, /这里还没有可以学的题|今天的任务都完成了/);
    assert.equal(singlePlan.plan.count, 25);
    assert.equal(singlePlan.plan.unit, '题草稿');
    assert.equal(singlePlan.plan.action.label, '检查并发布');
    singlePlan.plan.action.run();
    assert.deepEqual(opened, ['dr-25']);

    const multiPlan = m.buildHomePlan({
      data: {
        decks: [makeDeck('d1', { course: 'CS3219' })],
        sources: [],
        drafts: [dr25, dr15],
        jobs: [],
        runs: [],
        focus: { mode: 'class', course: 'CS3219', courses: [{ name: 'CS3219' }], fresh: [] },
      },
      today,
      runs: [],
      runFor: () => null,
      activeJobs: [],
      inFocus: () => true,
      revealActivity() {},
      revealDrafts: () => revealed.push('drafts'),
      actions: { start() {}, resume() {}, openDraft: (d) => opened.push(d.id), addSource() {}, importLibrary() {}, generateFromSources() {} },
    });
    assert.equal(multiPlan.plan.count, 40);
    assert.equal(multiPlan.plan.action.label, '查看待发布草稿');
    multiPlan.plan.action.run();
    assert.deepEqual(revealed, ['drafts']);
  }

  // 2) Full StudyMap SSR when 1st deck is done and 25-question 2nd draft exists: NextStepCard shows draft, HomeDrafts is open, 1 primary button.
  const htmlDoneWithDraft = renderMap({
    drafts: [dr25],
    today: { due: 0, weak: 0, new: 0, size: 10, ahead: true },
  });
  assert.match(htmlDoneWithDraft, /data-next="draft"/, 'NextStepCard surfaces the pending draft');
  assert.match(htmlDoneWithDraft, /<details class="sh-disclosure home-drafts"[^>]*\sopen(?:=|\s|>)/, 'HomeDrafts auto-expands so the 25-question draft is visible');
  assert.match(htmlDoneWithDraft, /事务隔离级别 25 题/);
  assert.doesNotMatch(htmlDoneWithDraft, /今天没有要做的复习|今天的任务都完成了|这里还没有可以学的题/);
  assert.equal(primaryCount(htmlDoneWithDraft), 1, 'home keeps a single primary button');

  // 3) Full StudyMap SSR with 0 published decks, no AI model, and imported drafts: HomeDrafts auto-expands and 1 primary button.
  const htmlZeroDecksMethod = renderMap({
    model: NOTHING,
    decks: [],
    sources: [],
    drafts: [dr25, dr15],
    today: quietToday,
    focus: { mode: 'class', course: 'CS3219', courses: [{ name: 'CS3219' }], fresh: [], method: { own: true, course: 'CS3219', index: 0, counts: { answered: 0, cards: 0 } } },
  });
  assert.match(htmlZeroDecksMethod, /data-next="draft"/);
  assert.match(htmlZeroDecksMethod, /<details class="sh-disclosure home-drafts"[^>]*\sopen(?:=|\s|>)/);
  assert.equal(primaryCount(htmlZeroDecksMethod), 1);

  const htmlZeroDecksCompact = renderMap({
    model: NOTHING,
    decks: [],
    sources: [],
    drafts: [dr25],
    today: quietToday,
  });
  assert.match(htmlZeroDecksCompact, /<details class="sh-disclosure home-drafts"[^>]*\sopen(?:=|\s|>)/, '0 published decks + pending draft auto-opens HomeDrafts');
  assert.equal(primaryCount(htmlZeroDecksCompact), 1);

  // 4) When due reviews exist today, due wins and HomeDrafts stays folded so due reviews stay above the fold.
  const htmlWithDue = renderMap({
    drafts: [dr25],
    today: { due: 4, weak: 1, new: 0, size: 5, ahead: false },
  });
  assert.match(htmlWithDue, /data-next="due"/);
  assert.match(htmlWithDue, /<details class="sh-disclosure home-drafts"(?![^>]*\sopen)/);
  assert.equal(primaryCount(htmlWithDue), 1);

  // 5) English UI renders cleanly with zero untranslated Chinese characters.
  m.setUiLanguage('en');
  setMapLang('en');
  try {
    const enHtml = renderMap({
      drafts: [makeDraft('dr-en-1', { title: 'Transactions Quiz', cards: 25, course: 'CS3219' }), makeDraft('dr-en-2', { title: 'Recovery Quiz', cards: 15, course: 'CS3219' })],
      today: quietToday,
      decks: [makeDeck('d1', { title: 'Intro Deck', course: 'CS3219' })],
    });
    assert.doesNotMatch(stripHtml(enHtml), HAN, 'English home with pending drafts leaves no Chinese characters');
  } finally {
    m.setUiLanguage('zh');
    setMapLang('zh');
  }
});
