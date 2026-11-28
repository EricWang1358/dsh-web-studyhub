import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { withStudy } from './helpers/study-services.mjs';

const uiMod = await loadUi(`
  export { default as WrittenSetup } from './ui/exam/WrittenSetup.jsx';
  export { default as Exam } from './ui/Exam.jsx';
  export { default as ExamCoachPage } from './ui/ExamCoachPage.jsx';
  export { default as Skeleton } from './ui/Skeleton.jsx';
  export { default as BookPointGaps } from './ui/book/BookPointGaps.jsx';
  export { StatsView, default as Dashboard } from './ui/Dashboard.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

const h = React.createElement;
const noop = () => {};
const han = /[\u3400-\u9fff]/;
const render = (element, lang = 'zh', services = {}) => {
  uiMod.setUiLanguage(lang);
  try {
    return renderToStaticMarkup(withStudy(uiMod.StudyServicesContext, element, services));
  } finally {
    uiMod.setUiLanguage('zh');
  }
};

const sampleDecks = [
  { id: 'd1', title: 'CS5224 · Midterm', course: 'CS5224', examCount: 20, examQuizCount: 12, examMultiCount: 8, available: 20 },
  { id: 'd2', title: 'CS5224 · Final', course: 'CS5224', examCount: 15, examQuizCount: 10, examMultiCount: 5, available: 15 },
];

test('WrittenSetup folds scope & count controls when ready, auto-opens when blocked, and translates cleanly', () => {
  const baseProps = {
    data: { root: 'ux', courses: [], decks: sampleDecks, focus: { course: 'CS5224' } },
    header: null,
    recent: null,
    decks: sampleDecks,
    deckNames: { d1: 'Midterm', d2: 'Final' },
    picked: new Set(['d1', 'd2']),
    onPick: noop,
    kinds: { quiz: 22, multi: 13 },
    typeMode: 'all',
    onTypeMode: noop,
    count: 20,
    onCount: noop,
    limit: { minutes: 30, defaults: { minutes: 30, source: 'default' }, course: 'CS5224' },
    onLimit: noop,
    busy: false,
    error: '',
    flashOnly: false,
    onStart: noop,
    onCreate: noop,
    onExit: noop,
  };

  const readyHtml = render(h(uiMod.WrittenSetup, baseProps));
  assert.match(readyHtml, /<details class="es-tune"(?![^>]*\sopen)/, 'details.es-tune is closed by default when canStart is true');
  assert.match(readyHtml, /调整试卷范围与题数/);
  assert.match(readyHtml, /20 题 · 限时 30 分钟 · 已选 2 个题组/);
  assert.match(readyHtml, /开始考试/);

  const noPickHtml = render(h(uiMod.WrittenSetup, { ...baseProps, picked: new Set() }));
  assert.match(noPickHtml, /<details class="es-tune"\s+open=""/, 'details.es-tune opens automatically when no deck is picked');

  const noTypeHtml = render(h(uiMod.WrittenSetup, { ...baseProps, kinds: { quiz: 22, multi: 0 }, typeMode: 'multi' }));
  assert.match(noTypeHtml, /<details class="es-tune"\s+open=""/, 'details.es-tune opens automatically when typeAvailable is 0');

  const enReady = render(h(uiMod.WrittenSetup, baseProps), 'en');
  assert.match(enReady, /Adjust scope &amp; question count/);
  assert.doesNotMatch(enReady.replace(/<style[\s\S]*?<\/style>/g, '').replace(/CS5224/g, ''), han);
});

test('Exam case tab surfaces direct 用当前资料出一套案例卷 action even when past case papers exist', () => {
  const caseData = {
    root: 'ux-case',
    model: { ready: true },
    courses: [{ id: 'c1', name: 'CS5224', exam: { format: 'open-book-case' } }],
    focus: { course: 'CS5224', courses: [{ name: 'CS5224' }] },
    decks: [
      { id: 'case-1', title: 'Past Case 1', format: 'case-study', course: 'CS5224', caseMarks: 20, count: 2 },
    ],
    sources: [{ id: 's1', title: 'Lecture 1', course: 'CS5224' }],
    runs: [],
  };
  const zhHtml = render(h(uiMod.Exam, {
    data: caseData,
    initialKind: 'case',
    onExit: noop,
    onCreate: noop,
    onCreateCase: noop,
  }));
  assert.match(zhHtml, /Past Case 1/);
  assert.match(zhHtml, /用当前资料出一套案例卷/);
  assert.match(zhHtml, /<button[^>]*>[\s\S]*用当前资料出一套案例卷/);

  const enHtml = render(h(uiMod.Exam, {
    data: caseData,
    initialKind: 'case',
    onExit: noop,
    onCreate: noop,
    onCreateCase: noop,
  }), 'en');
  assert.match(enHtml, /Create a case paper from current materials/);
  assert.doesNotMatch(enHtml.replace(/<style[\s\S]*?<\/style>/g, '').replace(/CS5224|Past Case 1|Lecture 1/g, ''), han);
});

test('Exam case tab invokes onCreateCase when 用当前资料出一套案例卷 is clicked', async () => {
  const interactive = await import('./helpers/react-harness.mjs');
  await interactive.withBrowserGlobals(async () => {
    const mod = await interactive.loadInteractiveUi(`
      export { default as Exam } from './ui/Exam.jsx';
      export { StudyServicesContext } from './ui/study-context.jsx';
      export { setUiLanguage } from './ui/i18n.js';
    `);
    mod.exports.setUiLanguage('zh');
    let caseCreated = 0;
    const hi = mod.React.createElement;
    const services = { call: async () => ({}), act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };
    const caseData = {
      root: 'ux-case-click',
      model: { ready: true },
      courses: [{ id: 'c1', name: 'CS5224', exam: { format: 'open-book-case' } }],
      focus: { course: 'CS5224', courses: [{ name: 'CS5224' }] },
      decks: [{ id: 'case-1', title: 'Past Case 1', format: 'case-study', course: 'CS5224', caseMarks: 20, count: 2 }],
      sources: [{ id: 's1', title: 'Lecture 1', course: 'CS5224' }],
      runs: [],
    };
    const mounted = mod.mount(() => hi(
      mod.exports.StudyServicesContext.Provider,
      { value: services },
      hi(mod.exports.Exam, {
        data: caseData,
        initialKind: 'case',
        onExit: noop,
        onCreate: noop,
        onCreateCase: () => { caseCreated += 1; },
      }),
    ));
    try {
      await mounted.flush(4);
      const btn = mounted.find((n) => n.type === 'button' && mounted.text(n).includes('用当前资料出一套案例卷'));
      assert.ok(btn, '用当前资料出一套案例卷 button renders');
      await mounted.act(() => interactive.click(btn));
      assert.equal(caseCreated, 1, 'clicking button calls onCreateCase');
    } finally {
      mounted.unmount();
    }
  });
});

test('ExamCoachPage presents 2 calm steps, replaces engineering jargon, and folds advanced checks', () => {
  const coachHtml = render(h(uiMod.ExamCoachPage, {
    data: {
      root: 'ux-coach',
      model: { ready: true },
      courses: [{ name: 'OS' }],
      sources: [{ id: 's1', title: 'Notes', course: 'OS' }],
      decks: [],
      focus: { course: 'OS' },
    },
    onGoGenerate: noop,
  }));
  assert.match(coachHtml, /1\. 分析考法与样卷/);
  assert.match(coachHtml, /2\. 生成针对练习/);
  assert.doesNotMatch(coachHtml, /规格版本|考察任务族|解法暴露|三层证据分界/);

  const enCoach = render(h(uiMod.ExamCoachPage, {
    data: {
      root: 'ux-coach',
      model: { ready: true },
      courses: [{ name: 'OS' }],
      sources: [{ id: 's1', title: 'Notes', course: 'OS' }],
      decks: [],
      focus: { course: 'OS' },
    },
    onGoGenerate: noop,
  }), 'en');
  assert.match(enCoach, /1\. Analyze patterns &amp; samples/);
  assert.match(enCoach, /2\. Generate practice/);
  assert.doesNotMatch(enCoach.replace(/<style[\s\S]*?<\/style>/g, '').replace(/\bOS\b/g, ''), han);
});

test('BookPointGaps defaults to a compact single-line details disclosure and opens while filling', () => {
  const report = {
    status: 'ok',
    points: 4,
    covered: 2,
    uncovered: 2,
    uncoverable: 0,
    unplaced: 0,
    more: 0,
    list: [{ id: 'p1', hid: 'h1', title: 'Point 1', coverable: true, prereqs: [], dependents: 0 }],
    topUp: { pointIds: ['p1'], questions: 1 },
    chapters: [{ id: 'ch1', hid: 'hc1', title: 'Ch 1', points: 4, covered: 2, uncovered: 2, sections: [], missing: [] }],
  };
  const folded = render(h(uiMod.BookPointGaps, { course: 'OS', report, onTopUp: noop, onGo: noop }));
  assert.match(folded, /<details class="book-gaps__fold"(?![^>]*\sopen)/, 'compact disclosure starts closed');
  assert.match(folded, /<summary class="book-gaps__summary">[\s\S]*知识点查缺[\s\S]*2\/4/);

  const running = render(h(uiMod.BookPointGaps, {
    course: 'OS',
    report,
    fillingJob: { id: 'j1', status: 'running' },
    onTopUp: noop,
    onGo: noop,
    onOpenTask: noop,
  }));
  assert.match(running, /<details class="book-gaps__fold"\s+open=""/, 'disclosure opens automatically while job runs');
});

test('Dashboard folds retired workflow history and cross-course ModelUsage into quiet disclosures', () => {
  const stats = {
    today: '2026-10-02',
    totals: { attempts: 10, activeDays: 3, streak: 2, due: 4, gradedRate: 80, gradedAttempts: 5, selfRate: 80, selfAttempts: 5, oralAttempts: 0, oralStrong: 0 },
    heatmap: [],
    trend: [],
    forecast: { days: [], later: 0 },
    mastery: { windowDays: 30, minAnswers: 3, levels: [], kinds: [] },
    weakTopics: [],
  };
  const statsHtml = render(h(uiMod.StatsView, {
    stats,
    course: '*',
    data: {
      decks: [],
      focus: {},
      workflowSessions: [{ id: 'w1', topic: 'Raft', course: 'DS', updatedAt: '2026-10-01T00:00:00Z' }],
      workflowSessionTotal: 1,
    },
    onOpenWorkflowSession: noop,
    onStartScope: noop,
  }));
  assert.match(statsHtml, /<details class="dash-fold"(?![^>]*\sopen)[^>]*>[\s\S]*历史学习流记录/);

  const dashHtml = render(h(uiMod.Dashboard, {
    data: { root: 'ux-dash', decks: [], focus: { course: '*', courses: [] } },
    onStartScope: noop,
  }));
  assert.match(dashHtml, /<details class="dash-fold dash-usage-fold"(?![^>]*\sopen)[^>]*>[\s\S]*模型用量[\s\S]*跨课程汇总/);

  const enDashHtml = render(h(uiMod.Dashboard, {
    data: { root: 'ux-dash', decks: [], focus: { course: '*', courses: [] } },
    onStartScope: noop,
  }), 'en');
  assert.match(enDashHtml, /Model usage[\s\S]*Across all courses/);
  assert.doesNotMatch(enDashHtml.replace(/<style[\s\S]*?<\/style>/g, ''), han);
});

test('Skeleton places primary visual before folded 调整与扩展骨架 controls', async () => {
  const skeleton = {
    id: 'sk-1',
    title: 'Distributed Consensus',
    overview: 'Overview text',
    scope: [{ deckId: 'd1', topic: 'Raft' }],
    nodes: [{ id: 'n1', term: 'Raft', meaning: 'Consensus protocol', cards: [] }],
    relations: [],
    sequences: [],
    diagrams: [],
  };
  const call = async (action) => {
    if (action === 'skeleton.topics') return { topics: [], groups: { groups: [], ungrouped: [] } };
    if (action === 'skeleton.list') return { skeletons: [{ id: 'sk-1', title: 'Distributed Consensus', nodes: 1, relations: 0, sequences: 0, cardIds: [], decks: 1, updatedAt: '2026-10-01T00:00:00Z' }] };
    if (action === 'skeleton.get') return skeleton;
    return {};
  };
  const interactive = await import('./helpers/react-harness.mjs');
  await interactive.withBrowserGlobals(async () => {
    const mod = await interactive.loadInteractiveUi(`
      export { default as Skeleton } from './ui/Skeleton.jsx';
      export { StudyServicesContext } from './ui/study-context.jsx';
      export { setUiLanguage } from './ui/i18n.js';
    `);
    mod.exports.setUiLanguage('zh');
    const hi = mod.React.createElement;
    const services = { call, act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };
    const mounted = mod.mount(() => hi(
      mod.exports.StudyServicesContext.Provider,
      { value: services },
      hi(mod.exports.Skeleton, {
        data: { root: 'sk-test', focus: { course: '*' }, skeletons: [{ id: 'sk-1', title: 'Distributed Consensus', nodes: 1, relations: 0, sequences: 0, cardIds: [], decks: 1, updatedAt: '2026-10-01T00:00:00Z' }] },
        focusId: 'sk-1',
        onFocus: noop,
        onPractice: noop,
      }),
    ));
    try {
      await mounted.flush(8);
      const viewSwitch = mounted.find((n) => n.props?.className?.includes('sk-view-switch'));
      const fold = mounted.find((n) => n.type === 'details' && n.props?.className === 'skeleton-extend-fold');
      assert.ok(viewSwitch, 'skeleton view switch renders');
      assert.ok(fold, 'skeleton-extend-fold renders');
      assert.equal(Boolean(fold.props.open), false, 'skeleton-extend-fold starts closed');
      const allNodes = mounted.findAll(() => true);
      assert.ok(allNodes.indexOf(viewSwitch) < allNodes.indexOf(fold), 'view switch & spine appear before folded adjust/extend controls');
      assert.match(mounted.text(fold), /调整与扩展骨架/);
    } finally {
      mounted.unmount();
    }
  });
});

test('ExamCoachPage saves dirty quota/crunch edits before direct generate and when leaving Step 2', async () => {
  const interactive = await import('./helpers/react-harness.mjs');
  await interactive.withBrowserGlobals(async () => {
    const mod = await interactive.loadInteractiveUi(`
      export { default as ExamCoachPage } from './ui/ExamCoachPage.jsx';
      export { StudyServicesContext } from './ui/study-context.jsx';
      export { setUiLanguage } from './ui/i18n.js';
    `);
    mod.exports.setUiLanguage('zh');
    const hi = mod.React.createElement;
    let stored = {
      specVersion: 'v1',
      stage: 'evidence',
      templateName: '期末',
      crunchMode: { enabled: false, remainingMinutes: 120 },
      taskFamilies: [
        {
          id: 'fam-a',
          title: '索引边界',
          origin: 'source-fact',
          primaryFormat: 'quiz',
          allowedFormats: ['quiz'],
          allowFormSubstitute: false,
          quota: 2,
          quotaUnit: 'question',
          questionsPerUnit: 1,
          priority: 'high',
          timeBudgetSec: 90,
          reasoningSteps: ['读题'],
          rubricPoints: [],
          confirmations: {},
          sample: { format: 'quiz', stem: '题干', answer: '答案', rubric: '' },
        },
      ],
    };
    const calls = [];
    const generated = [];
    const call = async (action, args = {}) => {
      calls.push({ action, args });
      if (action === 'coach.calibration.get') return { spec: stored, evidence: null };
      if (action === 'coach.calibration.save') {
        const { course: _course, uiLanguage: _lang, ...patch } = args;
        stored = { ...stored, ...patch };
        return { spec: stored, evidence: null };
      }
      if (action === 'coach.calibration.buildRequest') {
        const q = stored.taskFamilies[0]?.quota ?? 0;
        return { coachSpecVersion: stored.specVersion, totalCount: q, kindCounts: { quiz: q }, request: { count: q, course: args.course } };
      }
      return {};
    };
    const services = {
      call,
      act: async (action, req, cb) => {
        generated.push({ action, req });
        cb?.();
      },
      busy: false,
      notify: noop,
      askInChat: noop,
      host: {},
      openSettings: noop,
      navigate: noop,
      openModal: noop,
    };
    const mounted = mod.mount(() => hi(
      mod.exports.StudyServicesContext.Provider,
      { value: services },
      hi(mod.exports.ExamCoachPage, {
        data: { root: 'ux-coach-dirty', model: { ready: true }, courses: [{ name: 'OS' }], focus: { course: 'OS' }, sources: [], decks: [], attempts: [] },
      }),
    ));
    try {
      await mounted.flush(6);
      const quotaInput = mounted.find((n) => n.type === 'input' && n.props?.type === 'number' && n.props.min === 0 && n.props.max === 50);
      assert.ok(quotaInput, 'quota input renders inside ec-advanced-fold');
      await mounted.act(() => quotaInput.props.onChange({ target: { value: '7' } }));
      await mounted.flush(4);

      const directBtn = mounted.find((n) => n.type === 'button' && mounted.text(n).includes('按校准方案立即出题'));
      assert.ok(directBtn, 'direct generate button renders');
      await mounted.act(() => interactive.click(directBtn));
      await mounted.flush(6);

      const saveIdx = calls.findIndex((c) => c.action === 'coach.calibration.save' && c.args.taskFamilies?.[0]?.quota === 7);
      const buildIdx = calls.findIndex((c) => c.action === 'coach.calibration.buildRequest');
      assert.ok(saveIdx >= 0, 'dirty quota was saved before building request');
      assert.ok(buildIdx > saveIdx, 'buildRequest ran after dirty save');
      assert.deepEqual(generated, [{ action: 'generate', req: { count: 7, course: 'OS' } }]);

      // Also verify leaving Step 2 (stage === 'evidence') saves dirty edits instead of dropping them.
      await mounted.act(() => quotaInput.props.onChange({ target: { value: '5' } }));
      await mounted.flush(4);
      const stages = mounted.find((n) => n.props?.label === '教练阶段' && typeof n.props.onChange === 'function');
      await mounted.act(() => stages.props.onChange('analyze'));
      await mounted.flush(6);
      const lastSave = calls.filter((c) => c.action === 'coach.calibration.save').at(-1);
      assert.equal(lastSave.args.stage, 'analyze');
      assert.equal(lastSave.args.taskFamilies?.[0]?.quota, 5, 'dirty quota persisted when leaving Step 2');
    } finally {
      mounted.unmount();
    }
  });
});
