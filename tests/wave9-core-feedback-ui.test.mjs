import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { nativeSelects } from './helpers/native-selects.mjs';

const require = createRequire(import.meta.url);

const {
  SectionPractice,
  RubricResult,
  CaseReport,
  CoachDebrief,
  StudyServicesContext,
  setUiLanguage,
} = await loadUi(`
  export { default as SectionPractice } from './ui/document-preview/practice/SectionPractice.jsx';
  export { RubricResult, CaseReport } from './ui/CaseResult.jsx';
  export { default as CoachDebrief } from './ui/CoachDebrief.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

const oralExamStub = {
  name: 'oral-exam-stub',
  setup(b) {
    b.onResolve({ filter: /(^|\/)exam\/useExamRun\.js$/ }, () => ({ path: 'useExamRun-stub', namespace: 'wave9-stub' }));
    b.onLoad({ filter: /.*/, namespace: 'wave9-stub' }, () => ({
      contents: `export const useExamRun = () => globalThis.__wave9OralExamState;`,
      loader: 'js',
    }));
  },
};

const oralBuild = await build({
  stdin: {
    contents: `export { default as OralExam } from './ui/OralExam.jsx';
      export { StudyServicesContext } from './ui/study-context.jsx';
      export { setUiLanguage } from './ui/i18n.js';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['react'],
  plugins: [nativeSelects, oralExamStub],
  loader: { '.css': 'text' },
  logLevel: 'silent',
});
const oralMod = { exports: {} };
new Function('require', 'module', 'exports', oralBuild.outputFiles[0].text)(require, oralMod, oralMod.exports);
const { OralExam, StudyServicesContext: OralServicesContext, setUiLanguage: setOralLanguage } = oralMod.exports;

const han = /[\u3400-\u9fff]/;
const noop = () => {};
const baseServices = {
  call: async () => ({}),
  act: async () => undefined,
  busy: false,
  notify: noop,
  askInChat: noop,
  host: {},
  openSettings: noop,
  navigate: noop,
  openModal: noop,
};

function renderWithServices(type, props, language = 'zh', services = baseServices, Context = StudyServicesContext, setLang = setUiLanguage) {
  setLang(language);
  try {
    return renderToStaticMarkup(
      React.createElement(
        Context.Provider,
        { value: services },
        React.createElement(type, props),
      ),
    );
  } finally {
    setLang('zh');
  }
}

function makeLoop(hereCards, chapterCards = hereCards) {
  const map = new Map([['e1', hereCards], ['e2', chapterCards.filter((c) => !hereCards.includes(c))]]);
  const options = [
    { kind: 'here', ids: new Set(['e1']), cards: hereCards, count: hereCards.length },
  ];
  if (chapterCards.length > hereCards.length) {
    options.push({ kind: 'chapter', ids: new Set(['e1', 'e2']), cards: chapterCards, count: chapterCards.length });
  }
  return {
    status: 'ready',
    options,
    entryOf: (key) => {
      for (const [eid, list] of map) {
        if (list.some((c) => `${c.deckId}|${c.cardId}` === key)) return eid;
      }
      return null;
    },
    cards: chapterCards,
    noteAssigned: new Map(),
    start: () => ({ refs: [], reading: {} }),
  };
}

const secCard = (cardId, level, prompt = `Prompt ${cardId}`) => ({
  deckId: 'd1',
  cardId,
  level,
  prompt,
  links: [{ sourceId: 's1', start: 0, end: 10 }],
});

test('U39 SectionPractice shows all-mastered state (here & chapter) and mixed progress count without extra Chip', () => {
  const outline = [{ id: 'e1', title: 'Section One' }, { id: 'e2', title: 'Section Two' }];
  const masteredHere = [secCard('c1', 'mastered', 'Explain idempotency keys.'), secCard('c2', 'familiar', 'Explain retry backoff.')];
  const baseProps = {
    loop: makeLoop(masteredHere),
    outline,
    title: 'Section One',
    chapterName: 'Chapter One',
    unit: 'section',
    inline: { start: async () => true, Run: () => null },
    version: 1,
    visible: true,
  };

  const zhHere = renderWithServices(SectionPractice, baseProps, 'zh');
  assert.match(zhHere, /data-all-mastered="true"/);
  assert.match(zhHere, /data-testid="section-all-mastered"/);
  assert.match(zhHere, /本节题目已全部掌握/);
  assert.doesNotMatch(zhHere, /section-practice__progress/);

  const enHere = renderWithServices(SectionPractice, baseProps, 'en');
  assert.match(enHere, /All questions in this section mastered/);
  assert.doesNotMatch(enHere, han);

  const chapterMastered = [
    secCard('c1', 'mastered', 'Chapter item 1'),
    secCard('c2', 'familiar', 'Chapter item 2'),
  ];
  const chapterProps = {
    ...baseProps,
    loop: makeLoop([], chapterMastered),
  };
  assert.match(renderWithServices(SectionPractice, chapterProps, 'zh'), /本章题目已全部掌握/);
  const enChapter = renderWithServices(SectionPractice, chapterProps, 'en');
  assert.match(enChapter, /All questions in this chapter mastered/);
  assert.doesNotMatch(enChapter, han);

  const mixedCards = [
    secCard('m1', 'mastered', 'Mixed 1'),
    secCard('m2', 'familiar', 'Mixed 2'),
    secCard('m3', 'new', 'Mixed 3'),
  ];
  const mixedProps = { ...baseProps, loop: makeLoop(mixedCards) };
  const zhMixed = renderWithServices(SectionPractice, mixedProps, 'zh');
  assert.doesNotMatch(zhMixed, /data-all-mastered/);
  assert.match(zhMixed, /只看未掌握 1/);
  assert.match(zhMixed, /class="section-practice__progress">已掌握 2\/3<\/span>/);
  assert.equal((zhMixed.match(/class="sh-chip[\s"]/g) || []).length, 1);

  const enMixed = renderWithServices(SectionPractice, mixedProps, 'en');
  assert.match(enMixed, /Mastered 2\/3/);
  assert.doesNotMatch(enMixed, han);

  const unmasteredProps = { ...baseProps, loop: makeLoop([secCard('u1', 'new', 'Unmastered 1')]) };
  const zhUnmastered = renderWithServices(SectionPractice, unmasteredProps, 'zh');
  assert.doesNotMatch(zhUnmastered, /data-all-mastered/);
  assert.doesNotMatch(zhUnmastered, /section-practice__progress/);
});

test('U40 RubricResult uses semantic bar tones & data-band while CaseReport highlights all-attained cleanly', () => {
  const rubricHtml = renderWithServices(RubricResult, {
    rubric: {
      total: 8.5,
      max: 10,
      band: 'good',
      summary: 'Solid causal reasoning.',
      criteria: [
        { id: 'c1', label: 'Evidence check', score: 4.5, max: 5, ratio: 0.9 },
        { id: 'c2', label: 'Trade-offs', score: 2.8, max: 4, ratio: 0.7 },
        { id: 'c3', label: 'Assumptions', score: 0.4, max: 1, ratio: 0.4 },
      ],
    },
  }, 'en');
  assert.doesNotMatch(rubricHtml, han);
  assert.match(rubricHtml, /class="rubric-row" data-band="strong"[\s\S]*data-tone="success"/);
  assert.match(rubricHtml, /class="rubric-row">[\s\S]*data-tone="accent"/);
  assert.match(rubricHtml, /class="rubric-row is-weak" data-band="weak"[\s\S]*data-tone="warning"/);

  const basePaper = {
    total: 9,
    max: 10,
    pending: 0,
    pacing: {
      readingMs: 300000,
      writingMs: 900000,
      writingMinutes: 15,
      unanswered: [],
      overBudget: [],
      rows: [{ cardId: 'q1', spentMs: 300000, budgetMs: 600000, status: 'ok' }],
    },
    weakest: [],
    questions: [{
      n: 1,
      cardId: 'q1',
      deckId: 'd1',
      prompt: 'Design a circuit breaker for downstream overload.',
      status: 'graded',
      total: 9,
      marks: 10,
    }],
  };

  const zhAttained = renderWithServices(CaseReport, { report: { runId: 'cr1', case: basePaper }, busy: false, assistTasks: [] }, 'zh');
  assert.match(zhAttained, /data-all-attained="true"/);
  assert.match(zhAttained, /data-testid="case-all-attained">各评分项均已达标</);
  assert.match(zhAttained, /本次案例各评分项均已达标，没有待补薄弱项。/);

  const enAttained = renderWithServices(CaseReport, { report: { runId: 'cr1', case: basePaper }, busy: false, assistTasks: [] }, 'en');
  assert.doesNotMatch(enAttained, han);
  assert.match(enAttained, /data-all-attained="true"/);
  assert.match(enAttained, /data-testid="case-all-attained"/);

  for (const patch of [
    { pending: 1, questions: [{ ...basePaper.questions[0], status: 'pending', total: null }] },
    { weakest: [{ cardId: 'q1', criterionId: 'c3', n: 1, label: 'Assumptions', score: 1, max: 5 }] },
    { pacing: { ...basePaper.pacing, unanswered: ['q2'] } },
  ]) {
    const html = renderWithServices(CaseReport, { report: { runId: 'cr2', case: { ...basePaper, ...patch } }, busy: false, assistTasks: [] }, 'zh');
    assert.doesNotMatch(html, /data-all-attained/);
    assert.doesNotMatch(html, /case-all-attained/);
  }
});

test('U41 OralExam report shows all-strong recognition, legend tone dots, and keeps unassessed state neutral', () => {
  const renderOralReport = (report, language) => {
    globalThis.__wave9OralExamState = {
      phase: 'report',
      run: { id: report.runId },
      report,
      busy: false,
      error: '',
      loading: false,
      enter: noop,
      leave: noop,
      perform: noop,
      submit: noop,
    };
    return renderWithServices(OralExam, {
      data: { root: '/lib', decks: [] },
      onExit: noop,
      header: null,
      recent: null,
    }, language, baseServices, OralServicesContext, setOralLanguage);
  };

  const strongReport = {
    runId: 'oral-1',
    feedbackStatus: 'assessed',
    total: 3,
    answered: 3,
    assessed: 3,
    strong: 3,
    developing: 0,
    weak: 0,
    weakTopics: [],
    weakScope: [],
    entries: [{
      deckId: 'd1',
      cardId: 'c1',
      topic: 'Backpressure',
      prompt: 'How do bounded queues prevent cascading timeouts?',
      answer: 'They enforce admission control early.',
      expected: 'Fail fast under load with bounded wait.',
      assessment: { band: 'strong', grade: 4, reason: 'Clear mechanism and failure mode.' },
    }],
  };

  const zhStrong = renderOralReport(strongReport, 'zh');
  assert.match(zhStrong, /class="[^"]*\boral-report\b[^"]*"[^>]*data-all-strong="true"/);
  assert.match(zhStrong, /data-testid="oral-all-strong">全部回答扎实</);
  assert.match(zhStrong, /data-tone="success"/);
  assert.match(zhStrong, /data-tone="warning"/);
  assert.match(zhStrong, /data-tone="error"/);
  assert.match(zhStrong, /全部考查主题均已过关/);
  assert.match(zhStrong, /class="oral-report__clear"/);

  const enStrong = renderOralReport(strongReport, 'en');
  assert.doesNotMatch(enStrong, han);
  assert.match(enStrong, /All assessed topics passed/);
  assert.match(enStrong, /data-testid="oral-all-strong"/);

  const unassessedReport = {
    runId: 'oral-2',
    feedbackStatus: 'unassessed',
    total: 2,
    answered: 2,
    assessed: 0,
    strong: 0,
    developing: 0,
    weak: 0,
    weakTopics: [],
    weakScope: [],
    entries: [],
  };
  const zhUnassessed = renderOralReport(unassessedReport, 'zh');
  assert.doesNotMatch(zhUnassessed, /data-all-strong/);
  assert.doesNotMatch(zhUnassessed, /oral-all-strong/);
  assert.match(zhUnassessed, /优先补的知识点/);
  assert.match(zhUnassessed, /本次没有已评估的薄弱主题。/);
});

test('U42 CoachDebrief marks all-attained rounds including omitted selfAnswered and styles legend states', () => {
  const renderDebrief = (metrics, language = 'zh') => renderWithServices(CoachDebrief, {
    run: { id: 'run-w9', mode: 'path', complete: true, index: 4, total: 4, questions: 4, answered: metrics.answered, correct: metrics.gradedCorrect || 0, weakTopics: [] },
    initial: {
      headline: 'Solid mastery across this batch.',
      why: 'Every checked answer met the criteria.',
      next: 'continue_path',
      insights: [],
      metrics,
      status: { enabled: true, consent: false, ready: 0 },
    },
    autopilot: false,
    onPractice: noop,
    onContinue: noop,
    onReviewWeak: noop,
    destination: { kind: 'path', reason: 'continuing', label: 'Next batch', go: noop, note: '' },
    nextShown: true,
    plain: false,
    debriefModel: false,
    onSettings: noop,
    onProfileSettings: noop,
  }, language);

  const gradedOnly = {
    answered: 4,
    gradedAnswered: 4,
    gradedCorrect: 4,
    levels: { recall: { n: 2, met: 2 }, concept: { n: 2, met: 2 }, transfer: { n: 0, met: 0 } },
  };
  const zhGraded = renderDebrief(gradedOnly, 'zh');
  assert.match(zhGraded, /<div[^>]*data-next="continue_path"[^>]*data-all-attained="true"[^>]*class="study-reading coach-debrief"/);
  assert.match(zhGraded, /data-all-met="true"/);
  assert.match(zhGraded, /data-testid="coach-all-attained">本轮全部达标</);
  assert.match(zhGraded, /data-attained="true"/);
  assert.match(zhGraded, /data-empty="true"/);

  const enGraded = renderDebrief(gradedOnly, 'en');
  assert.doesNotMatch(enGraded, han);
  assert.match(enGraded, /data-all-attained="true"/);
  assert.match(enGraded, /All met target this round/);

  const mixedAllMet = {
    answered: 5,
    gradedAnswered: 3,
    gradedCorrect: 3,
    selfAnswered: 2,
    selfMet: 2,
    levels: { recall: { n: 2, met: 2 }, concept: { n: 2, met: 2 }, transfer: { n: 1, met: 1 } },
  };
  const zhMixed = renderDebrief(mixedAllMet, 'zh');
  assert.match(zhMixed, /data-all-attained="true"/);
  assert.equal((zhMixed.match(/data-all-met="true"/g) || []).length, 2);

  const imperfect = {
    answered: 4,
    gradedAnswered: 4,
    gradedCorrect: 3,
    levels: { recall: { n: 2, met: 2 }, concept: { n: 2, met: 1 }, transfer: { n: 0, met: 0 } },
  };
  const zhImperfect = renderDebrief(imperfect, 'zh');
  assert.doesNotMatch(zhImperfect, /data-all-attained/);
  assert.doesNotMatch(zhImperfect, /coach-all-attained/);
});
