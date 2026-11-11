import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { mapProps } from './helpers/study-map-props.mjs';

const m = await loadUi(`
  export { default as SourceListDialog } from './ui/app/modals/SourceListDialog.jsx';
  export { default as SourceReaderDialog } from './ui/app/modals/SourceReaderDialog.jsx';
  export { default as DocumentViewer } from './ui/document-preview/DocumentViewer.jsx';
  export { ModalRouter } from './ui/app/AppModalHost.jsx';
  export { default as Review } from './ui/Review.jsx';
  export { default as ReviewToolbar } from './ui/ReviewToolbar.jsx';
  export { default as StudyMap } from './ui/StudyMap.jsx';
  export { openReaderForPages, deferUnstudiedPagesPlan, readableMaterialItems } from './ui/document-preview/practice/open-reader-pages.js';
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

const h = React.createElement;
const han = /[\u3400-\u9fff]/;
const noop = () => {};
const render = (node) => renderToStaticMarkup(node);
const words = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
const count = (text, pattern) => (text.match(pattern) || []).length;

const withServices = (node, services = {}) =>
  h(m.StudyServicesContext.Provider, {
    value: {
      call: async () => ({}),
      act: async () => undefined,
      busy: false,
      notify: noop,
      askInChat: noop,
      host: {},
      openSettings: noop,
      navigate: noop,
      openModal: noop,
      ...services,
    },
  }, node);

const pdfPages = [
  { id: 'os-p1', title: '操作系统讲义.pdf · p.1', text: '第 1 页', course: 'CS2106', courses: ['CS2106'], document: { id: 'a'.repeat(64), format: 'pdf', page: 1, totalPages: 94, filename: '操作系统讲义.pdf' } },
  { id: 'os-p94', title: '操作系统讲义.pdf · p.94', text: '第 94 页', course: 'CS2106', courses: ['CS2106'], document: { id: 'a'.repeat(64), format: 'pdf', page: 94, totalPages: 94, filename: '操作系统讲义.pdf' } },
];

const secondDoc = {
  id: 'lab-1', title: '实验指导书.md', text: '# 实验 1', format: 'md', course: 'CS2106', courses: ['CS2106'],
};

const jsonSource = {
  id: 'json-1', title: 'JSON 导入：题库', text: '[]', provenance: 'json-card-self-reference', course: 'CS2106', courses: ['CS2106'],
};

test('openReaderForPages & SourceListDialog: collapses multi-page PDFs into one row, opens single material directly, and carries pickPages', () => {
  m.setUiLanguage('zh');
  const data = { sources: [...pdfPages, jsonSource] };

  // Multi-page PDF collapses into 1 row in SourceListDialog instead of 2+ per-page rows.
  const listHtml = render(h(m.SourceListDialog, {
    modal: { type: 'sources', sourceIds: ['os-p1', 'os-p94'], pickPages: true },
    data,
    run: null,
    onClose: noop,
    onOpenSource: noop,
  }));
  assert.equal(count(listHtml, /class="[^"]*source-row/g), 1, 'multi-page PDF renders once');
  assert.match(listHtml, /操作系统讲义\.pdf/);
  assert.match(listHtml, /选择资料按页做题/);
  assert.match(listHtml, /做这几页的题/);

  // Single readable material opens reader directly; 2+ readable materials open grouped SourceListDialog.
  const openedSingle = [];
  assert.equal(m.openReaderForPages({
    sources: data.sources,
    sourceIds: ['os-p1', 'os-p94', 'json-1'],
    openModal: (modal) => openedSingle.push(modal),
    back: true,
  }), true);
  assert.equal(openedSingle.length, 1);
  assert.equal(openedSingle[0].type, 'source');
  assert.equal(openedSingle[0].source.id, 'os-p1');
  assert.equal(openedSingle[0].pickPages, true);
  assert.equal(openedSingle[0].back, true);

  const openedMulti = [];
  assert.equal(m.openReaderForPages({
    sources: [...pdfPages, secondDoc, jsonSource],
    openModal: (modal) => openedMulti.push(modal),
  }), true);
  assert.equal(openedMulti.length, 1);
  assert.equal(openedMulti[0].type, 'sources');
  assert.equal(openedMulti[0].pickPages, true);
  assert.deepEqual(openedMulti[0].sourceIds, ['os-p1', 'lab-1']);

  // JSON-only sources do not offer reader page picking.
  assert.equal(m.readableMaterialItems([jsonSource]).length, 0);
});

test('SourceReaderDialog & DocumentViewer: pickPages shows an intuitive quick-jump banner with a direct 做这几页的题 action', () => {
  m.setUiLanguage('zh');
  const data = { sources: pdfPages, decks: [], drafts: [], jobs: [], settings: {} };
  const app = {
    data,
    host: {},
    core: { call: async () => ({}), act: async () => undefined, busy: false, notify: noop, refresh: noop },
    nav: { navigate: noop },
    learn: { openLearningTarget: noop },
    intents: { goGenerate: noop, practiceFromReading: noop },
    drafts: { openDraft: noop },
    dailyPlan: null,
    selectionNotices: { track: noop },
    settingsEntry: { openSettings: noop, openModelSettings: noop },
  };
  const dialogHtml = render(h(m.AppContext.Provider, { value: app },
    h(m.SourceReaderDialog, { modal: { type: 'source', source: pdfPages[0], pickPages: true, back: true }, onClose: noop })));
  assert.match(dialogHtml, /source-preview/);

  const viewerProps = {
    source: pdfPages[0],
    call: async () => ({}),
    data,
    host: {},
    onGenerate: noop,
    onPracticePages: noop,
    pickPages: true,
    backLabel: '回到这道题',
    onBack: noop,
  };
  const html = render(h(m.DocumentViewer, viewerProps));
  assert.match(html, /做这几页的题/);
  assert.match(html, /翻到正在看的那一章或那几页/);
  assert.match(html, /回到这道题/);

  m.setUiLanguage('en');
  try {
    const enHtml = render(h(m.DocumentViewer, { ...viewerProps, backLabel: 'Back to this question' }));
    assert.doesNotMatch(words(enHtml).replace(/操作系统讲义|第 1 页/g, ''), han);
    assert.match(words(enHtml), /Practise these pages/i);
  } finally {
    m.setUiLanguage('zh');
  }
});

test('Review, QuestionRun & ReviewToolbar: shows page badge, header reader quick-jump, and in-round defer of unstudied pages', () => {
  m.setUiLanguage('zh');
  const run = {
    id: 'run-1',
    mode: 'path',
    deckId: 'd1',
    index: 1,
    total: 3,
    answered: 1,
    correct: 1,
    complete: false,
    sourceIds: ['os-p1', 'os-p94'],
    cardSource: {
      sourceId: 'os-p94',
      documentSourceId: 'os-p1',
      documentKey: 'pdf:' + 'a'.repeat(64),
      title: '操作系统讲义',
      page: 94,
      unit: 'page',
      paged: true,
    },
    card: {
      id: 'c94',
      kind: 'choice',
      topic: '死锁避免',
      prompt: '银行家算法在分配资源前先检查什么？',
      options: [{ id: 'a', text: '安全序列' }, { id: 'b', text: '时间片' }],
    },
    navigation: [
      { key: 'd1:c1', deckId: 'd1', cardId: 'c1', index: 0, answered: true, correct: true, current: false, page: 1, documentKey: 'pdf:' + 'a'.repeat(64) },
      { key: 'd1:c94', deckId: 'd1', cardId: 'c94', index: 1, answered: false, correct: null, current: true, page: 94, documentKey: 'pdf:' + 'a'.repeat(64) },
      { key: 'd1:c95', deckId: 'd1', cardId: 'c95', index: 2, answered: false, correct: null, current: false, page: 95, documentKey: 'pdf:' + 'a'.repeat(64) },
    ],
  };
  const session = {
    run,
    choice: true,
    isCloze: false,
    showBack: false,
    showEn: false,
    autopilot: false,
    entry: { selected: [], hint: false, explain: false, response: '', clozeValues: {} },
    actions: {
      reviewAct: noop, choose: noop, flipCard: noop, assistCard: noop, slayCard: noop,
      studyPrerequisites: noop, teachingAct: noop, cancelTeaching: noop, retryTeaching: noop,
      toggleEn: noop, toggleHelp: noop, toggleAutopilot: noop, setClozeValue: noop, setResponse: noop,
    },
  };
  const data = {
    root: '/tmp/lib',
    sources: pdfPages,
    decks: [{ id: 'd1', title: '操作系统', course: 'CS2106', count: 3, available: 3 }],
    skeletons: [],
    settings: {},
  };

  const reviewHtml = render(withServices(h(m.Review, { session, data, shellTitle: '今日学习' })));
  assert.match(reviewHtml, /去资料选页做题/, 'header offers direct reader page-picking shortcut');
  assert.match(reviewHtml, /第 94 页/, 'question meta shows answer-safe page badge');

  // Toolbar menu opened at render shows the in-round defer item.
  const toolbarHtml = render(withServices(h(m.ReviewToolbar, {
    run,
    expanded: false,
    onToggleHelp: noop,
    onAsk: noop,
    onImprove: noop,
    onSlay: noop,
    onNote: noop,
    onReviewAction: noop,
    onDeferUnstudiedPages: noop,
    moreDefaultOpen: true,
  })));
  assert.match(toolbarHtml, /还没学到第 94 页（本轮移出后续页）/);

  // Pure plan helper computes exact removable indices and fallback when all cards in round are >= page.
  const plan = m.deferUnstudiedPagesPlan(run);
  assert.deepEqual(plan, {
    kind: 'remove',
    page: 94,
    removeIndices: [1, 2],
    removedCount: 2,
  });
  const allUnstudiedPlan = m.deferUnstudiedPagesPlan({
    ...run,
    index: 0,
    answered: 0,
    navigation: [
      { key: 'd1:c94', deckId: 'd1', cardId: 'c94', index: 0, answered: false, current: true, page: 94, documentKey: 'pdf:' + 'a'.repeat(64) },
    ],
  });
  assert.deepEqual(allUnstudiedPlan, {
    kind: 'open-reader',
    page: 94,
    removeIndices: [],
    removedCount: 0,
  });

  m.setUiLanguage('en');
  try {
    const enToolbar = render(withServices(h(m.ReviewToolbar, {
      run,
      expanded: false,
      onToggleHelp: noop,
      onAsk: noop,
      onImprove: noop,
      onSlay: noop,
      onNote: noop,
      onReviewAction: noop,
      onDeferUnstudiedPages: noop,
      moreDefaultOpen: true,
    })));
    assert.doesNotMatch(words(enToolbar), han);
    assert.match(words(enToolbar), /p\. 94/i);
  } finally {
    m.setUiLanguage('zh');
  }
});

test('StudyMap & TodayCard: offers quick-jump to reader page-picking when new questions exist, and stays quiet when none', () => {
  m.setUiLanguage('zh');
  const deck = { id: 'd1', title: '操作系统', folder: 'CS2106', course: 'CS2106', topics: ['进程'], available: 5, count: 5, quizCount: 5, createdAt: '2026-09-01T00:00:00Z' };
  const progress = { d1: { counts: { mastered: 1, familiar: 1, learning: 0, weak: 0, new: 3 }, total: 5, mastery: 40, due: 0, status: 'active', topics: [] } };
  const makeHome = (todayPatch, focusPatch = {}) => render(withServices(h(m.StudyMap, mapProps({
    data: {
      root: '/tmp/lib',
      decks: [deck],
      progress,
      sources: pdfPages,
      drafts: [],
      jobs: [],
      runs: [],
      today: { due: 0, weak: 0, new: 3, size: 3, course: 'CS2106', ...todayPatch },
      next: { deckId: 'd1', deckTitle: '操作系统', topic: '进程', mastery: 40 },
      coach: { ready: 0 },
      focus: { mode: 'class', course: 'CS2106', courses: [{ name: 'CS2106' }], fresh: [{}, {}, {}], ...focusPatch },
    },
    busy: false, start: noop, resume: noop, endRun: noop, manage: noop, openDraft: noop, continueDraft: noop,
    retryGeneration: noop, addSource: noop, createManual: noop, importLibrary: noop, askInChat: noop, notebooks: [],
    onFocus: noop, startCourseFlow: noop,
  }))));

  const withNewHtml = makeHome({});
  assert.match(withNewHtml, /还没学完全文？/);
  assert.match(withNewHtml, /去资料选页做题/);
  assert.match(withNewHtml, /打开资料按页做题/);

  const noNewHtml = makeHome({ new: 0, size: 0 }, { fresh: [] });
  assert.doesNotMatch(noNewHtml, /还没学完全文？/);
  assert.doesNotMatch(noNewHtml, /打开资料按页做题/);

  m.setUiLanguage('en');
  try {
    const enHome = makeHome({});
    assert.doesNotMatch(words(enHome).replace(/操作系统|进程/g, ''), han);
    assert.match(words(enHome), /Practise by page in reader/i);
  } finally {
    m.setUiLanguage('zh');
  }
});
