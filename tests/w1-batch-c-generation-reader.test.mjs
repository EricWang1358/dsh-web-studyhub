import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
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
  const src = await readFile(new URL('../ui/RetrievalPanel.jsx', import.meta.url), 'utf8');
  assert.match(src, /inputKey\s*=.*course.*topic.*sourceIds/, 'tracks value signature of course, topic, and sourceIds');
  assert.match(src, /seqRef\.current/, 'uses request sequence guard');
  assert.match(src, /disabled\s*\|\|\s*loading/, 'disables checkboxes and apply button while loading');
  assert.match(src, /onDismiss=\{\(\) => setError\(''\)\}/, 'allows dismissing error banner');
});

/* ---------- W1-10: useGenerationPath partial failure + refine stale guard ---------- */

test('W1-10: useGenerationPath stays on page on partial failure, unchecks started steps, and guards stale refine responses', async () => {
  const src = await readFile(new URL('../ui/use-generation-path.js', import.meta.url), 'utf8');
  assert.match(src, /result\.started\.length\s*&&\s*!result\.failed\.length/, 'only calls onQueued on full success');
  assert.match(src, /included:\s*false/, 'unchecks started steps on partial failure to prevent duplicate queueing');
  assert.match(src, /refineSeqRef\.current/, 'guards refine() with request sequence number');
  assert.match(src, /selectionSignature\s*=.*course.*goal.*selectedIds/, 'resets and invalidates refine on course/goal/selectedIds change');
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
  const src = await readFile(new URL('../ui/document-preview/peek/PagePeek.jsx', import.meta.url), 'utf8');
  assert.match(src, /docLoadTries/, 'uses docLoadTries to re-run document open on retry');
  assert.match(src, /needsReload\.current\s*=\s*true/, 'marks renderer as needing reload on load/render failure');
  assert.match(src, /setPhase\(prev => \(prev === 'error' \? 'ready' : prev\)\)/, 'clears page error when external page prop changes on healthy renderer');
  assert.match(src, /if \(phase !== 'ready'\) return;/, 'gates navigation/zoom shortcuts to ready phase');
  assert.match(src, /if \(typeof drag\.current === 'function'\) drag\.current\(\)/, 'cleans up active pointer drag listeners on unmount');
});
