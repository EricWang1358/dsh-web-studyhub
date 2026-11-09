import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';
import { mapProps } from './helpers/study-map-props.mjs';
import { JOB_STATUS, JOB_TYPES, isDeckJob, isGenerationRun } from '../lib/job-status.js';
import { stageCodeOf, withStageCodes } from '../lib/contexts/jobs/contracts.js';

const m = await loadUi(`
  export { default as StudyMap } from './ui/StudyMap.jsx';
  export { default as JobCard } from './ui/study-map/JobCard.jsx';
  export { default as CompactJobCard, cardLine } from './ui/tasks/CompactJobCard.jsx';
  export { stageLabel } from './ui/tasks/task-summary.js';
  export { firstRunLine } from './ui/first-run/line.js';
  export { nextStep, nextStepFacts } from './ui/study-map/next-step.js';
  export { foldJobsByDraft, visibleGenerationJobs } from './ui/job-visibility.js';
  export { estimateMinutes } from './ui/generate-form.js';
  export { ModelSettingsContext } from './ui/ModelErrorNote.jsx';
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

const h = React.createElement;
const noop = () => {};

const NON_DECK_KINDS = [
  'retrieval-index',
  'mineru-install',
  'marker-install',
  'local-install',
  'pdf-convert',
  'audio-import',
  'translation',
  'coach-daily',
  'course-outline-build',
  'course-book-build',
  'course-book-ai',
  'exam-blueprint-build',
  'case-answer-card',
  'coach-prep',
  'daily-recap',
  'note-generate',
  'assist',
  'workflow-skeleton',
  'workflow-teaching',
  'extension',
];

function javaIndexJob(overrides = {}) {
  return withStageCodes({
    id: 'job-idx-java',
    type: 'retrieval-index',
    status: 'running',
    stage: '正在建立索引 135 / 415 页',
    startedAt: '2026-11-09T09:00:00.000Z',
    contract: {
      jobId: 'job-idx-java',
      kind: 'retrieval-index',
      status: 'running',
      title: '建立检索索引 · Java 八股',
      progress: { done: 135, total: 415, unit: 'pages', percent: 32, segments: [] },
      usage: { tokens: null, tokenUsage: null, calls: 0 },
      calls: [{ id: 'c-idx', kind: 'index', status: 'running', observation: { boundary: 'local-process', requestCount: null } }],
      actions: { cancel: { available: true }, retry: { available: false }, pause: { available: false }, resume: { available: false } },
      detail: { index: { course: 'Java 八股' } },
      stage: { code: 'retrieval.indexing', args: { done: 135, total: 415 }, text: '正在建立索引 135 / 415 页' },
      startedAt: '2026-11-09T09:00:00.000Z',
    },
    ...overrides,
  });
}

function renderInApp(element, { data = {}, language = 'zh' } = {}) {
  m.setUiLanguage(language);
  try {
    return renderToStaticMarkup(
      h(m.ModelSettingsContext.Provider, { value: noop }, inApp(m, element, { data, app: { nav: { show: { task: noop } } } })),
    );
  } finally {
    m.setUiLanguage('zh');
  }
}

function renderHome(patch = {}, { language = 'zh', firstRun } = {}) {
  const base = {
    root: '/tmp/lib',
    model: { ready: true, reason: 'ok', label: 'DeepSeek · V4 Flash' },
    decks: [],
    progress: {},
    sources: [],
    drafts: [],
    jobs: [],
    runs: [],
    today: { due: 0, weak: 0, new: 0, size: 0 },
    focus: { mode: 'class', course: '', courses: [], fresh: [] },
    ...patch,
  };
  const home = h(m.StudyMap, mapProps({
    data: base,
    start: noop,
    resume: noop,
    manage: noop,
    openDraft: noop,
    continueDraft: noop,
    retryGeneration: noop,
    addSource: noop,
    createManual: noop,
    importLibrary: noop,
    notebooks: { notebooks: [] },
    generateFromSources: noop,
    ...(firstRun ? { firstRun } : {}),
  }));
  return renderInApp(home, { data: base, language });
}

test('isGenerationRun and isDeckJob separate deck jobs from all runtime v2 non-deck tasks', () => {
  for (const type of [undefined, null, '', 'generate', JOB_TYPES.GENERATION]) {
    assert.equal(isGenerationRun({ id: 'g', type }), true, `expected generation run for type=${String(type)}`);
    assert.equal(isDeckJob({ id: 'g', type }), true, `expected deck job for type=${String(type)}`);
  }
  for (const type of [JOB_TYPES.SUPPLEMENT, JOB_TYPES.DRAFT_REPAIR, JOB_TYPES.DRAFT_PUBLISH]) {
    assert.equal(isGenerationRun({ id: 's', type }), false, `sibling ${type} is not a primary generation run`);
    assert.equal(isDeckJob({ id: 's', type }), true, `sibling ${type} is still a deck job`);
  }
  for (const kind of NON_DECK_KINDS) {
    const job = { id: `j-${kind}`, type: kind, contract: { kind } };
    assert.equal(isGenerationRun(job), false, `${kind} must not match isGenerationRun`);
    assert.equal(isDeckJob(job), false, `${kind} must not match isDeckJob`);
  }
  assert.equal(isGenerationRun({ id: 'ext', contract: { kind: 'retrieval-index' } }), false);
  assert.equal(isDeckJob({ id: 'ext', contract: { kind: 'extension' } }), false);
});

test('stageCodeOf does not stamp authoring onto running non-deck background jobs', () => {
  for (const kind of NON_DECK_KINDS) {
    assert.equal(stageCodeOf({ id: `j-${kind}`, type: kind, status: 'running', stage: 'processing' }), undefined, kind);
  }
  assert.equal(javaIndexJob().stageCode, undefined);
  assert.equal(stageCodeOf({ id: 'g1', type: 'generation', status: 'running', stage: '正在生成题目' }), 'authoring');
  assert.equal(stageCodeOf({ id: 't-done', type: 'translation', status: 'complete' }), 'done');
  assert.equal(stageCodeOf({ id: 't-cancel', type: 'translation', status: 'cancelled' }), 'cancelled');
  assert.equal(stageCodeOf({ id: 't-fail', type: 'translation', status: 'failed' }), 'failed');
});

test('Home StudyMap never renders fake 新题组 / 正在出题 cards for retrieval-index or other non-deck runtime jobs', () => {
  const deck = { id: 'd1', title: 'Java 并发', folder: 'Java 八股', course: 'Java 八股', topics: ['JMM'], available: 8, count: 8, quizCount: 4, createdAt: '2026-11-01T00:00:00Z' };
  const progress = { d1: { counts: { mastered: 2, familiar: 2, learning: 2, weak: 1, new: 1 }, total: 8, mastery: 55, due: 2, status: 'active', topics: [] } };
  const backgroundJobs = [
    javaIndexJob(),
    withStageCodes({ id: 'j-outline', type: 'course-outline-build', status: 'running', contract: { jobId: 'j-outline', kind: 'course-outline-build', status: 'running', title: '整理课程大纲 · Java 八股', stage: { code: 'running' } } }),
    withStageCodes({ id: 'j-install', type: 'mineru-install', status: 'running', contract: { jobId: 'j-install', kind: 'mineru-install', status: 'running', title: '安装本地 PDF 工具（MinerU）', stage: { code: 'install.running', text: '正在安装…' } } }),
  ];

  const withDeckHtml = renderHome({
    decks: [deck],
    progress,
    jobs: backgroundJobs,
    today: { due: 2, weak: 1, new: 1, size: 4 },
    focus: { mode: 'class', course: 'Java 八股', courses: [{ name: 'Java 八股' }], fresh: [] },
  });
  assert.doesNotMatch(withDeckHtml, /正在生成「新题组」/);
  assert.doesNotMatch(withDeckHtml, /正在出题/);
  assert.doesNotMatch(withDeckHtml, /class="cjc"/, 'non-deck background jobs do not mount deck banners on Home');

  const emptyWithSourcesHtml = renderHome({
    sources: [{ id: 's1', title: 'Java八股.pdf 第 1 页', text: 'volatile happens-before', document: { id: 'java-doc', page: 1 } }],
    jobs: backgroundJobs,
  });
  assert.doesNotMatch(emptyWithSourcesHtml, /正在生成「新题组」/);
  assert.doesNotMatch(emptyWithSourcesHtml, /正在出题/);
  assert.doesNotMatch(emptyWithSourcesHtml, /第一组题正在生成|正在出第一组题/);
});

test('JobCard and CompactJobCard keep retrieval-index title and single page-progress phrase in zh and en', () => {
  const job = javaIndexJob();
  const zhCard = renderInApp(h(m.JobCard, { job, drafts: [], jobs: [job], cancelJob: noop }), { language: 'zh' });
  assert.match(zhCard, /建立检索索引 · Java 八股/);
  assert.match(zhCard, /正在建立索引 135 \/ 415 页/);
  assert.match(zhCard, /32%/);
  assert.match(zhCard, /停止/);
  assert.doesNotMatch(zhCard, /正在生成「新题组」|正在出题|135\/415 页完成/);

  const enCard = renderInApp(h(m.JobCard, { job, drafts: [], jobs: [job], cancelJob: noop }), { language: 'en' });
  assert.match(enCard, /Build search index · Java 八股/);
  assert.match(enCard, /Indexing 135 \/ 415 pages/);
  assert.match(enCard, /32%/);
  assert.match(enCard, /Stop/);
  assert.doesNotMatch(enCard, /Generating|Authoring|135\/415 pages done/);
});

test('firstRunLine and nextStep ignore non-deck runtime jobs while honouring runtime v2 generation jobs', () => {
  const sources = [{ id: 's1', title: 'Java八股.md', text: 'JVM GC', createdAt: '2026-11-08T10:00:00.000Z' }];
  const model = { ready: true, reason: 'ok', label: 'DeepSeek' };

  const withIndex = m.firstRunLine({ model, sources, decks: [], drafts: [], jobs: [javaIndexJob()] });
  assert.equal(withIndex.step, 2);
  assert.equal(withIndex.steps[2].status, 'ready', 'running retrieval-index must not flip first-run step to generating');

  const withFailedInstall = m.firstRunLine({
    model,
    sources,
    decks: [],
    drafts: [],
    jobs: [{ id: 'j-inst', type: 'mineru-install', status: 'failed', contract: { kind: 'mineru-install', status: 'failed' } }],
  });
  assert.equal(withFailedInstall.steps[2].status, 'ready', 'failed install job must not flip first-run step to failed');

  const withV2Gen = m.firstRunLine({
    model,
    sources,
    decks: [],
    drafts: [],
    jobs: [{ id: 'j-gen', type: 'generation', status: 'running', contract: { kind: 'generation', status: 'running' } }],
  });
  assert.equal(withV2Gen.steps[2].status, 'generating');

  const now = new Date('2026-11-09T10:00:00.000Z');
  const deck = { id: 'd1', title: '已有题组', available: 5, count: 5 };
  const stepDuringIndex = m.nextStep(m.nextStepFacts({
    model,
    decks: [deck],
    sources,
    drafts: [],
    jobs: [{ ...javaIndexJob(), sourceIds: ['s1'] }],
    today: { due: 0, weak: 0, new: 0, size: 0 },
  }, { now }));
  assert.equal(stepDuringIndex?.id, 'new-source', 'indexing a newly imported source does not hide the prompt to make questions from it');

  const stepDuringGen = m.nextStep(m.nextStepFacts({
    model,
    decks: [deck],
    sources,
    drafts: [],
    jobs: [{ id: 'j-gen', type: 'generation', status: 'running', sourceIds: ['s1'] }],
    today: { due: 0, weak: 0, new: 0, size: 0 },
  }, { now }));
  assert.notEqual(stepDuringGen?.id, 'new-source');
});

test('foldJobsByDraft, visibleGenerationJobs, estimateMinutes, and stageLabel handle runtime v2 jobs', () => {
  const older = { id: 'g1', type: 'generation', draftId: 'dr-1', status: 'complete', startedAt: '2026-11-09T08:00:00Z', finishedAt: '2026-11-09T08:02:00Z', count: 10 };
  const newer = { id: 'g2', type: 'generation', draftId: 'dr-1', status: 'running', startedAt: '2026-11-09T08:05:00Z' };
  const folded = m.foldJobsByDraft([older, newer]);
  assert.equal(folded.length, 1);
  assert.equal(folded[0].job.id, 'g2');
  assert.deepEqual(folded[0].earlier.map((j) => j.id), ['g1']);

  const visible = m.visibleGenerationJobs([
    older,
    javaIndexJob({ status: 'complete' }),
    { id: 'j-out', type: 'course-outline-build', status: 'complete' },
  ]);
  assert.deepEqual(visible.map((j) => j.id), ['g1']);

  const est = m.estimateMinutes([
    older,
    { id: 'idx-done', type: 'retrieval-index', status: 'complete', startedAt: '2026-11-09T08:00:00Z', finishedAt: '2026-11-09T08:20:00Z', count: 415 },
  ], 10);
  assert.deepEqual(est, { low: 1, high: 3 });

  assert.equal(m.stageLabel({ code: 'running' }), '进行中');
  assert.equal(m.stageLabel({ code: JOB_STATUS.CANCELLING }), '正在停止…');
  m.setUiLanguage('en');
  try {
    assert.equal(m.stageLabel({ code: 'running' }), 'In progress');
    assert.equal(m.stageLabel({ code: JOB_STATUS.CANCELLING }), 'Stopping…');
  } finally {
    m.setUiLanguage('zh');
  }
});
