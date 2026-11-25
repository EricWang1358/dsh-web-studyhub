import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { click, loadInteractiveUi } from './helpers/react-harness.mjs';
import { createSelectionJobs } from '../lib/contexts/generation/selection-jobs.js';

const h = React.createElement;
const noop = () => {};

const m = await loadUi(`
  export { setUiLanguage } from './ui/i18n.js';
  export { sourceIdsOf } from './ui/document-preview/practice/practice-range.js';
  export { withElsewhere } from './ui/document-preview/reader/chapters.js';
  export { alignEntrySections, alignEntries, outlineCoverage, rangeCoverageOf } from './ui/document-preview/practice/coverage-outline.js';
  export { default as OutlinePanel } from './ui/document-preview/reader/OutlinePanel.jsx';
  export { LearningPanel } from './ui/document-preview/DocumentLearning.jsx';
  export { SelectionJobCard, SelectionJobList } from './ui/document-preview/SelectionJobs.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
`);

/* ---------- W1-35: AI outline range resolution for 为这几页出题 ---------- */

test('W1-35: sourceIdsOf resolves AI outline section, mid-page boundary, same-page adjacent, and non-contiguous recent ranges', () => {
  const sections = [
    { id: 'pg-1', page: 1, sourceId: 's1' },
    { id: 'pg-2', page: 2, sourceId: 's2' },
    { id: 'pg-3', page: 3, sourceId: 's3' },
    { id: 'pg-4', page: 4, sourceId: 's4' },
    { id: 'pg-5', page: 5, sourceId: 's5' },
    { id: 'pg-6', page: 6, sourceId: 's6' },
  ];
  const documentSourceIds = ['s1', 's2', 's3', 's4', 's5', 's6'];
  const outline = [
    { id: 'ai-0', level: 1, title: 'Ch 1', sourceId: 's1', offset: 0 },
    { id: 'ai-1', level: 2, title: '1.1 Intro', sourceId: 's1', offset: 120 },
    { id: 'ai-2', level: 2, title: '1.2 Core', sourceId: 's3', offset: 40 }, // mid-page start on s3
    { id: 'ai-3', level: 1, title: 'Ch 2', sourceId: 's5', offset: 0 }, // top-of-page start on s5
  ];

  // Adjacent on same page: ai-0 starts on s1, ai-1 also on s1 -> at least ['s1']
  assert.deepEqual(m.sourceIdsOf(new Set(['ai-0']), { sections, outline, documentSourceIds }), ['s1']);
  // Next entry starts mid-page on s3 (offset > 0) -> includes boundary page s3
  assert.deepEqual(m.sourceIdsOf(new Set(['ai-1']), { sections, outline, documentSourceIds }), ['s1', 's2', 's3']);
  // Next entry starts at top of s5 (offset === 0) -> ends at s4 (does NOT include s5)
  assert.deepEqual(m.sourceIdsOf(new Set(['ai-2']), { sections, outline, documentSourceIds }), ['s3', 's4']);
  // Last entry -> through end of book
  assert.deepEqual(m.sourceIdsOf(new Set(['ai-3']), { sections, outline, documentSourceIds }), ['s5', 's6']);
  // Non-contiguous "recent" (ai-0 + ai-3) -> union in reading order, does NOT swallow s2..s4
  assert.deepEqual(m.sourceIdsOf(new Set(['ai-0', 'ai-3']), { sections, outline, documentSourceIds }), ['s1', 's5', 's6']);

  // withElsewhere preserves offset alongside sourceId
  const entries = [
    { level: 1, title: 'Ch 1', kind: 'h', anchor: { sourceId: 's1', offset: 50 } },
    { level: 1, title: 'Ch 2', kind: 'h', anchor: { sourceId: 's5', offset: 12 } },
  ];
  const merged = m.withElsewhere(entries, [{ id: 'ai-0', level: 1, title: 'Ch 1', kind: 'h', range: {}, tagged: true }], {
    drawn: new Set(['s1']),
    known: new Set(['s1', 's5']),
  });
  assert.equal(merged[0].sourceId, 's1');
  assert.equal(merged[0].offset, 50);
  assert.equal(merged[1].sourceId, 's5');
  assert.equal(merged[1].offset, 12);
  assert.equal(merged[1].elsewhere, true);
});

/* ---------- W1-36: AI outline coverage alignment + OutlinePanel filter ---------- */

test('W1-36: coverage-outline aligns both unsegmented paged PDFs and segmented multi-page AI chapters, and OutlinePanel avoids blank wipe', () => {
  const sections = [
    { id: 'pg-1', page: 1, sourceId: 's1' },
    { id: 'pg-2', page: 2, sourceId: 's2' },
    { id: 'pg-3', page: 3, sourceId: 's3' },
    { id: 'pg-4', page: 4, sourceId: 's4' },
  ];
  const outline = [
    { id: 'ai-0', level: 1, parent: null, title: 'Ch 1', sourceId: 's1' },
    { id: 'ai-1', level: 1, parent: null, title: 'Ch 2', sourceId: 's3' },
  ];

  // Case 1: unsegmented paged PDF (leaves are titleless pages)
  const pagedCov = {
    leaves: 4,
    covered: 3,
    sections: [
      { key: 's1|pg1', id: 'pg1', sourceId: 's1', kind: 'page', title: '', page: 1, state: 'covered' },
      { key: 's2|pg2', id: 'pg2', sourceId: 's2', kind: 'page', title: '', page: 2, state: 'covered' },
      { key: 's3|pg3', id: 'pg3', sourceId: 's3', kind: 'page', title: '', page: 3, state: 'covered' },
      { key: 's4|pg4', id: 'pg4', sourceId: 's4', kind: 'page', title: '', page: 4, state: 'never-planned' },
    ],
  };
  const pagedRes = m.outlineCoverage(outline, pagedCov, { sourceId: 's1', sections });
  assert.equal(pagedRes.aligned.size, 2);
  assert.equal(pagedRes.entries.get('ai-0').covered, 2);
  assert.equal(pagedRes.entries.get('ai-0').leaves, 2);
  assert.equal(pagedRes.entries.get('ai-1').covered, 1);
  assert.equal(pagedRes.entries.get('ai-1').leaves, 2);
  assert.equal(pagedRes.uncovered.has('ai-0'), false);
  assert.equal(pagedRes.uncovered.has('ai-1'), true);
  assert.deepEqual(m.rangeCoverageOf(pagedRes, new Set(['ai-1']), pagedCov), { leaves: 2, covered: 1, uncovered: 1 });

  // Case 2: segmented AI chapters with continued slices across pages
  const segCov = {
    leaves: 3,
    covered: 1,
    sections: [
      { key: 's1|c0', id: 'c0', sourceId: 's1', kind: 'chapter', chapter: 0, title: 'Ch 1', state: 'covered' },
      { key: 's2|c0', id: 'c0', sourceId: 's2', kind: 'chapter', chapter: 0, title: 'Ch 1', continued: true, state: 'never-planned' },
      { key: 's3|c1', id: 'c1', sourceId: 's3', kind: 'chapter', chapter: 1, title: 'Ch 2', state: 'never-planned' },
    ],
  };
  const segRes = m.outlineCoverage(outline, segCov, { sourceId: 's1', sections });
  assert.equal(segRes.entries.get('ai-0').leaves, 2, 'Ch 1 must aggregate both initial and continued slice');
  assert.equal(segRes.entries.get('ai-0').covered, 1);
  assert.equal(segRes.uncovered.has('ai-0'), true, 'Ch 1 has uncovered continued slice so must remain uncovered');
  assert.equal(segRes.uncovered.has('ai-1'), true, 'Ch 2 on page 3 must also be aligned and uncovered');

  // Case 3: unaligned window-only plain text under AI outline -> hides 只看没覆盖的 checkbox and keeps rows visible
  m.setUiLanguage('zh');
  const unalignedCov = {
    leaves: 2,
    covered: 1,
    sections: [
      { key: 'txt|w1', id: 'w1', sourceId: 'txt', kind: 'window', title: '', state: 'covered' },
      { key: 'txt|w2', id: 'w2', sourceId: 'txt', kind: 'window', title: '', state: 'never-planned' },
    ],
  };
  const unalignedRes = m.outlineCoverage(outline, unalignedCov, { sourceId: 'txt', sections: [] });
  assert.equal(unalignedRes.aligned.size, 0);
  const html = renderToStaticMarkup(h(m.OutlinePanel, {
    items: outline,
    activeId: 'ai-0',
    onJump: noop,
    coverage: unalignedRes,
    coverageTotals: unalignedCov,
    initialOnlyUncovered: true,
  }));
  assert.doesNotMatch(html, /data-coverage-filter/, 'must hide 只看没覆盖的 checkbox when nothing aligned');
  assert.match(html, /Ch 1/, 'must NOT wipe the outline to a blank white panel');
});

/* ---------- W1-19: RetrievalPanel resets stale preview and guards races ---------- */

test('W1-19: RetrievalPanel resets preview on topic/source/course change and guards stale responses', async () => {
  const ui = await loadInteractiveUi(`
    export { setUiLanguage } from './ui/i18n.js';
    export { default as RetrievalPanel } from './ui/RetrievalPanel.jsx';
    export { StudyServicesContext } from './ui/study-context.jsx';
  `);
  ui.exports.setUiLanguage('zh');
  const hI = ui.React.createElement;

  const pending = [];
  let failNext = false;
  const call = (action, args) => {
    if (action === 'retrieval.preview') {
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error('索引暂时不可用'));
      }
      return new Promise((resolve) => { pending.push({ args, resolve }); });
    }
    return Promise.resolve({});
  };
  const services = { call, act: async () => {}, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };
  const initialPreview = {
    pages: [
      { sourceId: 's1', page: 1, title: 'Ch1', snippet: 'old snippet 1' },
      { sourceId: 's2', page: 2, title: 'Ch2', snippet: 'old snippet 2' },
    ],
  };

  let props = { advice: { chars: 12000 }, sourceIds: ['s1', 's2'], focus: 'Raft', course: 'OS', onApply: noop, initialPreview };
  const view = ui.mount(() => hI(ui.exports.StudyServicesContext.Provider, { value: services }, hI(ui.exports.RetrievalPanel, props)));
  try {
    // 1. Trigger preview -> while loading, checkboxes and apply button must be disabled
    const previewBtn = view.find((n) => n.type === 'button' && ui.textOf(n).includes('预览会用到的页面'));
    assert.ok(previewBtn, 'preview button rendered');
    await view.act(() => click(previewBtn));
    assert.equal(pending.length, 1, 'started retrieval.preview request');

    const checkboxesWhileLoading = view.findAll((n) => n.type === 'input' && n.props?.type === 'checkbox');
    assert.ok(checkboxesWhileLoading.length === 2 && checkboxesWhileLoading.every((cb) => cb.props.disabled), 'checkboxes disabled while loading');
    const applyBtnWhileLoading = view.find((n) => n.type === 'button' && ui.textOf(n).includes('只用勾选的页面'));
    assert.equal(applyBtnWhileLoading.props.disabled || applyBtnWhileLoading.props['aria-disabled'] === 'true', true, 'apply button locked while loading');

    // 2. Change focus (topic) BEFORE request settles -> preview clears and stale response is ignored
    props = { ...props, focus: 'Paxos' };
    view.rerender();
    assert.equal(view.find((n) => n.props?.className === 'retrieval-panel__pages'), null, 'preview cleared on topic change');
    pending[0].resolve({ pages: [{ sourceId: 's1', page: 1, title: 'Stale', snippet: 'stale Raft result' }] });
    await view.flush();
    assert.equal(view.find((n) => n.props?.className === 'retrieval-panel__pages'), null, 'stale response ignored after topic change');

    // 3. Also resets on sourceIds and course change
    await view.act(() => click(view.find((n) => n.type === 'button' && ui.textOf(n).includes('预览会用到的页面'))));
    pending[1].resolve({ pages: [{ sourceId: 's1', page: 1, title: 'Fresh', snippet: 'fresh Paxos result' }] });
    await view.flush();
    assert.ok(view.text().includes('fresh Paxos result'), 'fresh preview rendered');

    props = { ...props, sourceIds: ['s1'] };
    view.rerender();
    assert.equal(view.find((n) => n.props?.className === 'retrieval-panel__pages'), null, 'preview cleared on sourceIds change');

    // 4. Error banner is dismissible
    failNext = true;
    await view.act(() => click(view.find((n) => n.type === 'button' && ui.textOf(n).includes('预览会用到的页面'))));
    await view.flush();
    assert.ok(view.text().includes('索引暂时不可用'), 'error banner rendered');
    const dismissBtn = view.find((n) => n.type === 'button' && (n.props?.className?.includes('sh-inline__close') || ui.textOf(n).includes('关闭')));
    assert.ok(dismissBtn, 'error banner exposes dismiss button');
    await view.act(() => click(dismissBtn));
    assert.equal(view.text().includes('索引暂时不可用'), false, 'clicking dismiss clears error banner');
  } finally {
    view.unmount();
  }
});

/* ---------- W1-10: useGenerationPath partial failure + refine stale guard ---------- */

test('W1-10: useGenerationPath stays on page on partial failure, unchecks started steps, and guards stale refine responses', async () => {
  const ui = await loadInteractiveUi(`
    export { setUiLanguage } from './ui/i18n.js';
    export { useGenerationPath } from './ui/use-generation-path.js';
    export { StudyServicesContext } from './ui/study-context.jsx';
  `);
  ui.exports.setUiLanguage('zh');
  const hI = ui.React.createElement;

  const refineDeferred = [];
  let genCallIdx = 0;
  const call = (action, args) => {
    if (action === 'generate.path.suggest') {
      return new Promise((resolve) => { refineDeferred.push({ args, resolve }); });
    }
    if (action === 'generate') {
      genCallIdx += 1;
      if (genCallIdx === 1) return Promise.resolve({ jobId: 'job-1', status: 'queued' });
      return Promise.reject(new Error('额度不足'));
    }
    return Promise.resolve({});
  };
  const services = { call, act: async () => {}, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };
  const sources = [
    { id: 's1', title: 'Ch1', chars: 120000, document: { documentId: 'doc-1', page: 1 } },
    { id: 's2', title: 'Ch2', chars: 120000, document: { documentId: 'doc-2', page: 1 } },
  ];
  let queuedCount = 0;
  const wrap = (el) => hI(ui.exports.StudyServicesContext.Provider, { value: services }, el);

  const hook = ui.mountHook(
    ui.exports.useGenerationPath,
    { sources, selectedIds: ['s1', 's2'], gen: { kind: 'quiz', count: 5 }, course: 'OS', goal: 'midterm', onQueued: () => { queuedCount += 1; } },
    wrap,
  );
  try {
    assert.ok(hook.current.steps.length >= 2, 'planned at least 2 steps');
    const firstStepId = hook.current.steps[0].id;
    const secondStepId = hook.current.steps[1].id;

    // 1. Partial failure during queue(): must NOT call onQueued, and must uncheck started step only
    await hook.act(() => hook.current.queue());
    await hook.flush();
    assert.equal(queuedCount, 0, 'must NOT call onQueued when any step failed');
    assert.equal(hook.current.report.started.length, 1);
    assert.equal(hook.current.report.failed.length, 1);
    assert.equal(hook.current.steps.find((s) => s.id === firstStepId).included, false, 'started step unchecked to avoid duplicate queueing');
    assert.notEqual(hook.current.steps.find((s) => s.id === secondStepId).included, false, 'failed step stays checked for retry');

    // 2. Stale refine() response after course/goal/selectedIds change is ignored
    const refinePromise = hook.current.refine();
    hook.rerender({ sources, selectedIds: ['s1', 's2'], gen: { kind: 'quiz', count: 5 }, course: 'OS', goal: 'final', onQueued: () => { queuedCount += 1; } });
    assert.equal(hook.current.aiState.phase, 'idle', 'goal change resets aiState to idle');
    refineDeferred[0].resolve({ source: 'model', steps: [{ id: secondStepId, order: 1 }, { id: firstStepId, order: 2 }] });
    await refinePromise;
    await hook.flush();
    assert.equal(hook.current.ai, null, 'stale refine response must be discarded');
    assert.equal(hook.current.aiState.phase, 'idle');
  } finally {
    hook.unmount();
  }
});

/* ---------- W1-20: SelectionJobs error visibility, single primary, and backend idempotency ---------- */

test('W1-20: LearningPanel shows errors in jobsOnly & no-selection views, SelectionJobCard avoids primary conflict, and backend proceed() short-circuits complete records', async () => {
  m.setUiLanguage('zh');
  const finishedJob = {
    id: 'j1',
    operationId: 'op-1',
    status: 'complete',
    outcome: 'saved',
    deckId: 'd1',
    deckTitle: 'OS',
    publication: { deckId: 'd1', cardIds: ['c1', 'c2'], firstCardId: 'c1', added: 2 },
  };
  const jobHtml = renderToStaticMarkup(h(m.SelectionJobCard, {
    job: finishedJob,
    canPractice: true,
    onPractice: noop,
    onOpenDeck: noop,
  }));
  assert.doesNotMatch(jobHtml, /sh-btn--primary/, 'finished supplement card must use secondary instead of primary button');

  const noSelectionHtml = renderToStaticMarkup(h(m.LearningPanel, {
    capture: null,
    jobsOnly: false,
    error: '题组已归档，无法重试',
    jobs: [finishedJob],
  }));
  assert.match(noSelectionHtml, /题组已归档，无法重试/, 'error must be visible even when capture is empty');

  const jobsOnlyHtml = renderToStaticMarkup(h(m.LearningPanel, {
    capture: null,
    jobsOnly: true,
    error: '模型暂不可用',
    jobs: [finishedJob],
  }));
  assert.match(jobsOnlyHtml, /模型暂不可用/, 'error must be visible in jobsOnly (原始 PDF) view');

  // Backend idempotency: proceed() must short-circuit prior.status === 'complete' without calling core.clear or core.supplement
  let clearCalled = 0;
  let supplementCalled = 0;
  let getCalls = 0;
  const completeRecord = {
    operationId: 'op-done',
    status: 'complete',
    deckId: 'd1',
    request: { count: 2, kind: 'quiz', focus: '' },
    selection: { sourceId: 's1', quote: 'hello world' },
    receipt: { deckId: 'd1', added: 2, total: 5, cardIds: ['c1', 'c2'], version: 2 },
  };
  const jobs = new Map();
  const svc = createSelectionJobs({
    root: '/tmp/lib',
    normalize: (a) => ({ count: a.count || 2, kind: a.kind || 'quiz' }),
    get: async () => {
      getCalls += 1;
      // Simulate race: replay() sees prior=null, then by the time proceed() runs the first run completed
      return getCalls === 1 ? null : completeRecord;
    },
    clear: async () => { clearCalled += 1; },
    supplement: async () => { supplementCalled += 1; return completeRecord; },
    resolve: async (sel) => sel,
    bank: { get: async () => ({ deck: { id: 'd1', title: 'OS', cards: [], contentVersion: 1 }, version: 1 }) },
    evidence: async () => [],
    languageFor: async () => 'zh',
    complete: async () => '{}',
  }, {
    work: { jobs, queues: new Map(), settled: new Map(), generationControllers: new Map() },
    jobServices: {
      activeJob: (j) => j.status === 'running' || j.status === 'queued',
      pruneJobs: noop,
      publicJob: (j) => j,
    },
    mail: async () => {},
  });
  await svc['generation.selection.start']({
    operationId: 'op-done',
    deckId: 'd1',
    count: 2,
    kind: 'quiz',
    selection: { sourceId: 's1', quote: 'hello world' },
  }, { language: 'zh' });
  // Wait for queued executor microtasks
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(clearCalled, 0, 'must NEVER clear a completed operation record');
  assert.equal(supplementCalled, 0, 'must NEVER re-run core.supplement when prior is already complete');
});

/* ---------- W1-32: PagePeek retry reload, page switch error reset, keydown & drag cleanup ---------- */

test('W1-32: PagePeek separates focus effect from document load, reloads on retry when renderer failed, clears error on page prop change, and gates keys by phase', async () => {
  const ui = await loadInteractiveUi(`
    export { setUiLanguage } from './ui/i18n.js';
    export { default as PagePeek } from './ui/document-preview/peek/PagePeek.jsx';
  `);
  ui.exports.setUiLanguage('zh');
  const hI = ui.React.createElement;

  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const prevGetComputedStyle = globalThis.getComputedStyle;
  const winListeners = new Map();
  let openerFocused = 0;
  const fakeOpener = { isConnected: true, focus: () => { openerFocused += 1; } };
  globalThis.document = { activeElement: fakeOpener, head: { appendChild: noop }, createElement: () => ({ style: {}, remove: noop }) };
  globalThis.getComputedStyle = () => ({ zoom: '1' });
  globalThis.window = {
    innerWidth: 1200,
    innerHeight: 800,
    devicePixelRatio: 1,
    addEventListener: (type, fn) => {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    },
    removeEventListener: (type, fn) => {
      winListeners.get(type)?.delete(fn);
    },
  };

  try {
    let loadAttempts = 0;
    let closeCalls = 0;
    const loadBytes = async () => {
      loadAttempts += 1;
      if (loadAttempts === 1) throw new Error('network hiccup');
      return new Uint8Array([1, 2, 3]);
    };
    const openRenderer = async () => ({
      numPages: 5,
      pageSize: async () => ({ width: 600, height: 800 }),
      render: async () => ({ width: 600, height: 800, close: noop }),
      destroy: noop,
    });

    let props = {
      page: 2,
      totalPages: 5,
      status: { kind: 'ok' },
      loadBytes,
      openRenderer,
      onClose: () => { closeCalls += 1; },
    };

    const view = ui.mount(() => hI(ui.exports.PagePeek, props));
    await view.flush(6);
    assert.equal(loadAttempts, 1, 'initial mount attempted loadBytes once');
    assert.ok(view.text().includes('network hiccup'), 'enters error phase on initial load failure');

    // 1. Keydown while in error phase: ArrowRight / '+' must be ignored, Escape still closes
    const peekNodeErr = view.find((n) => n.props?.className?.includes('page-peek') && typeof n.props?.onKeyDown === 'function');
    let prevented = 0;
    peekNodeErr.props.onKeyDown({ key: 'ArrowRight', preventDefault: () => { prevented += 1; }, stopPropagation: noop });
    peekNodeErr.props.onKeyDown({ key: '+', preventDefault: () => { prevented += 1; }, stopPropagation: noop });
    assert.equal(prevented, 0, 'navigation and zoom shortcuts ignored when phase !== ready');
    peekNodeErr.props.onKeyDown({ key: 'Escape', preventDefault: noop, stopPropagation: noop });
    assert.equal(closeCalls, 1, 'Escape still closes even in error phase');

    // 2. Retry after initial load failure triggers a fresh loadBytes + openRenderer (docLoadTries)
    const retryBtn = view.find((n) => n.type === 'button' && ui.textOf(n).includes('重试'));
    assert.ok(retryBtn, 'retry button rendered in error phase');
    await view.act(() => click(retryBtn));
    await view.flush(6);
    assert.equal(loadAttempts, 2, 'retry reloads document when renderer failed');
    assert.equal(view.text().includes('network hiccup'), false, 'error cleared after reload succeeds');

    // 3. Force a page-range error on healthy renderer (page 9 > 5), then switch page prop back to valid page 3 -> clears error
    props = { ...props, page: 9 };
    view.rerender();
    await view.flush(4);
    assert.ok(view.text().includes('第 9 页') || view.text().includes('没有第 9 页'), 'shows page-range error');
    props = { ...props, page: 3 };
    view.rerender();
    await view.flush(4);
    assert.equal(view.text().includes('没有第 9 页'), false, 'changing page prop clears error on healthy renderer');

    // 4. Active pointer drag listeners are cleaned up on unmount (and opener focus restored once)
    const head = view.find((n) => typeof n.props?.onPointerDown === 'function' && n.props?.className?.includes('page-peek__head'));
    if (head) {
      head.props.onPointerDown({ button: 0, clientX: 100, clientY: 100, target: { closest: () => null }, preventDefault: noop });
      assert.ok((winListeners.get('pointermove')?.size || 0) > 0, 'drag attached pointermove listener');
    }
    view.unmount();
    assert.equal(winListeners.get('pointermove')?.size || 0, 0, 'pointermove drag listener cleaned up on unmount');
    assert.equal(winListeners.get('pointerup')?.size || 0, 0, 'pointerup drag listener cleaned up on unmount');
    assert.equal(openerFocused, 1, 'focus restored to opener once on unmount');
  } finally {
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
    if (prevDocument === undefined) delete globalThis.document;
    else globalThis.document = prevDocument;
    if (prevGetComputedStyle === undefined) delete globalThis.getComputedStyle;
    else globalThis.getComputedStyle = prevGetComputedStyle;
  }
});
