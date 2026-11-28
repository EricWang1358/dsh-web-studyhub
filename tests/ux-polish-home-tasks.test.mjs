import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';
import { loadInteractiveUi, withBrowserGlobals } from './helpers/react-harness.mjs';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const h = React.createElement;
const noop = () => {};

const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as StudyMap } from './ui/StudyMap.jsx';
  export { default as NotebookDirectory } from './ui/study-map/NotebookDirectory.jsx';
  export { default as CatalogToolbar } from './ui/study-map/CatalogToolbar.jsx';
  export { default as DeskIntro } from './ui/study-map/DeskIntro.jsx';
  export { default as TaskConsole } from './ui/tasks/TaskConsole.jsx';
  export { default as TaskBody } from './ui/tasks/TaskBody.jsx';
  export { seedCoverage, forgetCoverage } from './ui/coverage/use-coverage.js';
  export { ErrorState } from './ui/components/ErrorState.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

const tourMod = await loadInteractiveUi(`
  export { useTour } from './ui/app/use-tour.js';
  export { welcomeDismissed } from './ui/tour/progress.js';
`);

function memoryStorage() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
    clear: () => { store.clear(); },
  };
}

async function withTour(data, fn) {
  const prevStorage = globalThis.localStorage;
  const prevRaf = globalThis.requestAnimationFrame;
  globalThis.localStorage = memoryStorage();
  globalThis.requestAnimationFrame = () => 0;
  try {
    return await withBrowserGlobals(async () => {
      const dataRef = { current: data };
      const core = {
        call: async () => ({}),
        act: async () => ({}),
        setError: noop,
        notify: noop,
        refresh: async () => dataRef.current,
        refs: { dataRef },
      };
      const nav = { page: 'library', navigate: noop, show: { page: noop } };
      const lib = { set: { setModal: noop, setDraft: noop, setSelectedSources: noop, setSkeletonFocus: noop } };
      const session = { run: null, enterRun: noop, clearRun: noop };
      const drafts = { openDraft: noop };
      const intents = { setGenSource: noop, goGenerate: noop };
      const hook = tourMod.mountHook((props) => tourMod.exports.useTour(props), {
        core, lib, nav, session, drafts, intents, data: dataRef.current, rootRef: { current: null }, canChat: true,
      });
      try {
        return await fn({ hook });
      } finally {
        hook.unmount();
      }
    });
  } finally {
    if (prevStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = prevStorage;
    if (prevRaf === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = prevRaf;
  }
}

test('sample tour completion or skip sets lineLater so FirstRunLine does not immediately cover the sample library', async () => {
  const sampleLoaded = {
    root: '/lib-sample-tour',
    model: { ready: true, reason: 'ok', label: 'DeepSeek' },
    decks: [{ id: 'sample-deck', title: '示例题组', sample: true, cards: [] }],
    sources: [{ id: 'sample-src', title: '示例资料', sample: true }],
    drafts: [],
    jobs: [],
    sample: { loaded: true, deckId: 'sample-deck', sourceId: 'sample-src' },
  };
  await withTour(sampleLoaded, async ({ hook }) => {
    await hook.act(() => hook.current.startTour());
    assert.equal(hook.current.lineLater, false);
    await hook.act(() => hook.current.finishTour());
    assert.equal(hook.current.lineLater, true);
    assert.equal(tourMod.exports.welcomeDismissed('/lib-sample-tour'), true);
  });
  await withTour(sampleLoaded, async ({ hook }) => {
    await hook.act(() => hook.current.startTour());
    await hook.act(() => hook.current.closeTour('skip'));
    assert.equal(hook.current.lineLater, true);
    assert.equal(tourMod.exports.welcomeDismissed('/lib-sample-tour'), true);
  });
  await withTour({ ...sampleLoaded, root: '/lib-no-sample', sample: { loaded: false }, decks: [] }, async ({ hook }) => {
    await hook.act(() => hook.current.startTour());
    await hook.act(() => hook.current.finishTour());
    assert.equal(hook.current.lineLater, false);
    assert.equal(tourMod.exports.welcomeDismissed('/lib-no-sample'), false);
  });
});

test('StudyMap deduplicates 总纲 when CourseHeading already renders it, and NotebookDirectory folds when single-workspace', () => {
  m.setUiLanguage('zh');
  const data = {
    root: '/lib',
    model: { ready: true, reason: 'ok', label: 'DeepSeek' },
    decks: [{ id: 'd1', title: 'Distributed Systems', course: 'CS5223', cards: [{ id: 'c1', suspended: false, review: { state: 'new' } }] }],
    sources: [{ id: 's1', title: 'Lecture 1.pdf', courses: ['CS5223'] }],
    drafts: [],
    jobs: [],
    runs: [],
    progress: {},
    today: { due: 0, weak: 0, new: 1, size: 1 },
    focus: {
      mode: 'class',
      course: 'CS5223',
      courses: [{ name: 'CS5223', active: true }],
      fresh: [],
      route: { course: 'CS5223', chapters: [{ id: 'ch1', title: 'Ch 1', decks: 1, cards: 1 }] },
    },
  };
  const home = renderToStaticMarkup(inApp(m, h(m.StudyMap, {
    data,
    actions: {
      start: noop,
      resume: noop,
      manage: noop,
      openDraft: noop,
      topUpDraft: noop,
      retryGeneration: noop,
      addSource: noop,
      createManual: noop,
      importLibrary: noop,
      onShowOutline: noop,
    },
    notebooks: { notebooks: [] },
  }), { data }));
  const outlineMatches = home.match(/class="[^"]*outline-entry[^"]*"/g) || [];
  assert.equal(outlineMatches.length, 1, 'home shows only one 总纲 button (in CourseHeading)');
  const headingSection = home.slice(home.indexOf('class="section-heading map-heading"'));
  assert.doesNotMatch(headingSection.slice(0, headingSection.indexOf('</div></div>') + 12), /outline-entry/);

  const localOnly = renderToStaticMarkup(inApp(m, h(m.NotebookDirectory, {
    notebooks: { notebooks: [{ root: '/lib', workspace: '/lib', current: true, publishedAt: null, deckCount: 1, dueToday: 0, decks: [] }] },
    error: '',
    refresh: noop,
  }), { data }));
  assert.match(localOnly, /aria-expanded="false"/, 'single-workspace unpublished directory starts folded');

  const multi = renderToStaticMarkup(inApp(m, h(m.NotebookDirectory, {
    notebooks: { notebooks: [{ root: '/lib', workspace: '/lib', current: true, publishedAt: '2026-10-01T00:00:00Z', deckCount: 1, dueToday: 0, decks: [] }] },
    error: '',
    refresh: noop,
  }), { data }));
  assert.match(multi, /aria-expanded="true"/, 'published or multi-workspace directory starts open');
});

test('CatalogToolbar and DeskIntro use Tooltip instead of raw host title attributes', () => {
  m.setUiLanguage('zh');
  const toolbar = renderToStaticMarkup(inApp(m, h(m.CatalogToolbar, { search: '', onSearch: noop, showArchived: false, onToggleArchived: noop }), { data: {} }));
  assert.doesNotMatch(toolbar, /<span[^>]*title=/);
  assert.match(toolbar, /role="tooltip"/);

  const deskSource = read('ui/study-map/DeskIntro.jsx');
  assert.doesNotMatch(deskSource, /<div className="desk-mastery" title=/);
  assert.match(deskSource, /<Tooltip layer content=\{title\}><span className="desk-mastery-label" tabIndex=\{0\}>/);
});

test('TaskConsole, ControlRow, TaskBody, and task-console.css clean up jargon, copy, empty control strip, and header overflow', () => {
  m.setUiLanguage('zh');
  const ctrl = read('ui/tasks/ControlRow.jsx');
  assert.doesNotMatch(ctrl, /请稍后再点/);
  assert.match(ctrl, /上一个操作还没结束，等它完成后再点一次。/);

  const tcCss = read('ui/tasks/task-console.css');
  assert.match(tcCss, /\.tc-controls\[data-empty="true"\]\s*\{[^}]*min-height:\s*0/);

  const makeBodyTask = (kind) => ({
    id: `job-${kind}`,
    type: kind,
    status: 'complete',
    startedAt: '2026-10-05T10:00:00.000Z',
    contract: {
      contractVersion: 1,
      jobId: `job-${kind}`,
      kind,
      status: 'complete',
      stage: { code: 'complete', text: 'complete' },
      progress: { done: 1, total: 1, unit: 'steps', percent: 100, segments: [] },
      usage: { tokens: null, tokenUsage: null, calls: 1 },
      execution: { mode: 'direct' },
      detail: { book: { board: [] } },
      startedAt: '2026-10-05T10:00:00.000Z',
      calls: [{ callId: 'c1', stage: 'write', status: 'complete', runner: 'model', tokens: 120, slot: 2, startedAt: '2026-10-05T10:00:00.000Z', finishedAt: '2026-10-05T10:00:05.000Z' }],
      events: [],
    },
  });
  const body = renderToStaticMarkup(inApp(m, h(m.TaskBody, { task: makeBodyTask('material-classify') }), { data: {} }));
  const bookBody = renderToStaticMarkup(inApp(m, h(m.TaskBody, { task: makeBodyTask('course-book-build') }), { data: {} }));
  assert.match(body, /并发通道 2/);
  assert.match(bookBody, />发送内容</);
  assert.doesNotMatch(bookBody, />实际请求</);

  m.setUiLanguage('en');
  const enBody = renderToStaticMarkup(inApp(m, h(m.TaskBody, { task: makeBodyTask('material-classify') }), { data: {} }));
  const enBookBody = renderToStaticMarkup(inApp(m, h(m.TaskBody, { task: makeBodyTask('course-book-build') }), { data: {} }));
  assert.match(enBody, /Parallel lane 2/);
  assert.match(enBookBody, />Request sent</);
  m.setUiLanguage('zh');

  const refusedDraft = {
    id: 'dr1',
    title: 'Shortfall draft',
    draftVersion: 1,
    cards: [{ id: 'c1', kind: 'quiz', prompt: 'p', answer: 'a' }],
    editorial: {
      requested: 5,
      coverageSpec: { goal: 10, level: 'lean', rounds: [{ round: 1, questions: 5, status: 'pending' }] },
      coverageRun: {
        jobId: 'j-refused',
        autoComplete: false,
        state: 'stopped',
        stop: { reason: 'refused', round: 1, code: 'credential', detail: '401 Unauthorized' },
      },
    },
  };
  const refusedJob = {
    id: 'j-refused',
    type: 'generate',
    kind: 'quiz',
    status: 'failed',
    stage: 'Part 1: 401 Unauthorized: Invalid API key',
    retryable: true,
    draftId: 'dr1',
    deckTitle: 'Shortfall draft',
    requestedTotal: 5,
    savedCount: 1,
    startedAt: '2026-10-05T10:00:00.000Z',
    finishedAt: '2026-10-05T10:01:00.000Z',
  };
  m.seedCoverage({ draftId: 'dr1' }, 'r1:1', {
    status: 'ok',
    canTopUp: true,
    coverage: { leaves: 10, covered: 2, uncovered: 8, plannedFailed: 2, neverPlanned: 6, bySection: {} },
    round: { sections: 4, questions: 8, remaining: 8, rounds: 2, allQuestions: 16 },
  });
  let html;
  try {
    html = renderToStaticMarkup(inApp(m, h(m.TaskConsole, {
      data: { revision: 'r1', jobs: [refusedJob], archivedJobs: [], drafts: [refusedDraft], decks: [], modelReady: true },
      openers: { resultOf: () => ({ label: '打开草稿', run: noop }) },
    }), {
      data: { revision: 'r1', jobs: [refusedJob], drafts: [refusedDraft], decks: [] },
      app: { lib: { taskFocus: null } },
    }));
  } finally {
    m.forgetCoverage();
  }
  const head = html.slice(html.indexOf('class="tc-head__actions"'), html.indexOf('aria-label="概览"'));
  assert.match(head, /<button[^>]*data-shortfall-act="model-settings"/, 'keeps 去配置模型 primary CTA visible on credential-refused jobs');
  assert.doesNotMatch(head, /class="[^"]*tc-head__full/, 'overflows low-frequency 全屏 into ⋯ menu when >= 3 header actions compete');
  assert.match(head, /aria-haspopup="menu"/);
});

test('ErrorState supports inline quiet framing without outer double-border box', () => {
  m.setUiLanguage('zh');
  const boxed = renderToStaticMarkup(h(m.ErrorState, { error: '读取失败', onRetry: noop }));
  assert.match(boxed, /sh-inline--boxed/);
  const inline = renderToStaticMarkup(h(m.ErrorState, { error: '读取失败', inline: true, onRetry: noop }));
  assert.match(inline, /role="alert"/);
  assert.match(inline, /sh-error-state--inline/);
  assert.doesNotMatch(inline, /sh-inline--boxed/);
  assert.match(read('ui/components/feedback.css'), /:is\(\.sh-panel, \.sh-paper-card\) \.sh-error-state:not\(\.sh-error-state--compact\):not\(\.sh-error-state--inline\)/);
});
