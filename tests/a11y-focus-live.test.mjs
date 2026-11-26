import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { reviewParts } from './helpers/review-render.mjs';
import { nativeSelects } from './helpers/native-selects.mjs';
import { click, loadInteractiveUi, withBrowserGlobals } from './helpers/react-harness.mjs';

const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: {
    contents: `
      export { default as QuestionRun, buildFeedbackAnnouncement } from './ui/review/QuestionRun.jsx';
      export { focusQuestionHeading } from './ui/review/usePinQuestion.js';
      export { default as ChoiceFeedback } from './ui/ChoiceFeedback.jsx';
      export { default as ExplanationFollowup } from './ui/ExplanationFollowup.jsx';
      export { default as RoundLookBack } from './ui/review/RoundLookBack.jsx';
      export { default as Exam, examTimeWarning } from './ui/Exam.jsx';
      export { CaseReport, caseGradingAnnouncement } from './ui/CaseResult.jsx';
      export { StatsView, nextHeatmapIndex } from './ui/Dashboard.jsx';
      export { StudyServicesContext } from './ui/study-context.jsx';
      export { setQueryData } from './ui/host-query.js';
      export { ENGLISH_SOURCES, mergeCatalogues, setUiLanguage, uiCatalogue } from './ui/i18n.js';
    `,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['react', 'react-dom'],
  plugins: [nativeSelects],
  loader: { '.css': 'text' },
  logLevel: 'silent',
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, mod, mod.exports);
const uiMod = mod.exports;
Object.assign(uiMod.uiCatalogue(), uiMod.mergeCatalogues(uiMod.ENGLISH_SOURCES).catalogue);

const h = React.createElement;
const noop = () => {};
const han = /[\u3400-\u9fff]/;

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

function renderWithServices(el, lang = 'zh', services = baseServices) {
  uiMod.setUiLanguage(lang);
  try {
    return renderToStaticMarkup(h(uiMod.StudyServicesContext.Provider, { value: services }, el));
  } finally {
    uiMod.setUiLanguage('zh');
  }
}

test('ChoiceFeedback exposes tabIndex=-1 for programmatic focus and omits conditional role="status" by default', () => {
  const card = { id: 'q1', kind: 'quiz', prompt: 'Pick one', options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] };
  const solution = { options: [{ id: 'a', correct: true }, { id: 'b', correct: false }] };
  const html = renderWithServices(h(uiMod.ChoiceFeedback, {
    card,
    options: card.options,
    feedback: { selected: ['a'], correct: true },
    solution,
    multiple: false,
  }));
  assert.match(html, /class="choice-feedback"[^>]*tabindex="-1"/);
  assert.doesNotMatch(html, /class="choice-feedback"[^>]*role="status"/, 'no conditional role=status; pre-mounted announcer owns live status');
  const liveHtml = renderWithServices(h(uiMod.ChoiceFeedback, {
    card,
    options: card.options,
    feedback: { selected: ['a'], correct: true },
    solution,
    multiple: false,
    live: true,
  }));
  assert.match(liveHtml, /class="choice-feedback"[^>]*role="status"/);
});

test('QuestionRun pre-mounts polite aria-live slot, marks prompt heading focusable, and moves prereq button outside <summary>', () => {
  const choiceCard = {
    id: 'q1',
    kind: 'quiz',
    topic: 'Distributed',
    prompt: 'What does quorum intersection ensure?',
    options: [{ id: 'a', text: 'Overlap' }, { id: 'b', text: 'Zero latency' }],
  };
  const prerequisites = [
    { deckId: 'd1', cardId: 'p1', prompt: 'What is a quorum?', level: 'weak' },
    { deckId: 'd1', cardId: 'p2', prompt: 'What is replication?', level: 'mastered' },
  ];
  const unansweredParts = reviewParts({
    data: { sources: [] },
    run: { id: 'r1', index: 0, total: 2, mode: 'path', card: choiceCard, prerequisites, revealed: false, feedback: null },
  });
  const beforeHtml = renderWithServices(
    h(uiMod.QuestionRun, unansweredParts.props),
    'zh',
    unansweredParts.services,
  );
  assert.match(beforeHtml, /<div class="sh-visually-hidden" role="status" aria-live="polite" aria-atomic="true" data-live-announcer="question-run"><\/div>/, 'pre-mounted empty live region exists before answering');
  assert.match(beforeHtml, /<div class="question" role="heading" aria-level="2" tabindex="-1" data-question-heading="">/, 'prompt heading is focusable with tabIndex=-1');
  assert.match(beforeHtml, /<div class="prereq-strip"><div class="prereq-strip__head">/, 'prereq strip uses flex header wrapper instead of nested button in summary');
  assert.doesNotMatch(beforeHtml, /<summary[\s\S]*?<button/, 'no interactive button nested inside <summary>');
  assert.match(beforeHtml, /class="sh-btn [^"]*prereq-strip__action"[^>]*>先学前置/);

  const answeredParts = reviewParts({
    data: { sources: [] },
    run: {
      id: 'r1',
      index: 0,
      total: 2,
      mode: 'path',
      card: choiceCard,
      revealed: true,
      feedback: { correct: true, selected: ['a'], nextDue: new Date(Date.now() + 3 * 86400_000).toISOString(), level: 'learning' },
      solution: { answer: 'Overlap', explanation: 'R + W > N', options: [{ id: 'a', correct: true }, { id: 'b', correct: false }] },
    },
  });
  const afterHtml = renderWithServices(
    h(uiMod.QuestionRun, answeredParts.props),
    'zh',
    answeredParts.services,
  );
  assert.match(afterHtml, /<div class="next-due-focus" tabindex="-1"><div class="next-due next-due--verdict"/, 'verdict block is wrapped in a focusable container without conditional role=status');
  assert.doesNotMatch(afterHtml, /next-due--verdict"[^>]*role="status"/);
});

test('focusQuestionHeading focuses prompt heading quietly with preventScroll and respects open dialogs', () => {
  const prevDoc = globalThis.document;
  try {
    const calls = [];
    const heading = {
      tabIndex: 0,
      attrs: {},
      getAttribute(name) { return this.attrs[name] ?? null; },
      focus(opts) { calls.push(opts); },
    };
    const root = {
      querySelector(sel) {
        return sel.includes('[data-question-heading]') ? heading : null;
      },
    };
    globalThis.document = { body: {}, activeElement: null };
    const focused = uiMod.focusQuestionHeading(root);
    assert.equal(focused, heading);
    assert.equal(heading.tabIndex, -1);
    assert.deepEqual(calls, [{ preventScroll: true }]);

    // Skips when focus is inside an open dialog
    globalThis.document = {
      body: {},
      activeElement: { closest: (sel) => (sel.includes('dialog') ? {} : null) },
    };
    assert.equal(uiMod.focusQuestionHeading(root), null);
    assert.equal(calls.length, 1);
  } finally {
    if (prevDoc === undefined) delete globalThis.document;
    else globalThis.document = prevDoc;
  }
});

test('buildFeedbackAnnouncement produces clean ZH and EN announcements for choice, cloze, grade, rubric, and failure', () => {
  const futureDue = new Date(Date.now() + 3 * 86400_000).toISOString();
  uiMod.setUiLanguage('zh');
  try {
    assert.equal(uiMod.buildFeedbackAnnouncement({ run: { feedback: null }, choice: true }), '');
    const choiceRight = uiMod.buildFeedbackAnnouncement({
      run: {
        feedback: { correct: true, selected: ['a'], nextDue: futureDue },
        solution: { options: [{ id: 'a', correct: true }] },
      },
      choice: true,
    });
    assert.match(choiceRight, /答对了/);
    assert.match(choiceRight, /下次大约 3 天后再见/);

    const clozeMulti = uiMod.buildFeedbackAnnouncement({
      run: {
        feedback: {
          correct: false,
          retryQueued: true,
          details: [{ id: 'b1', correct: true }, { id: 'b2', correct: false }],
          nextDue: futureDue,
        },
      },
      isCloze: true,
    });
    assert.match(clozeMulti, /答对 1\/2 空/);
    assert.match(clozeMulti, /这道题放到了本轮最后，会再出现一次/);

    const flashGrade = uiMod.buildFeedbackAnnouncement({
      run: { feedback: { grade: 4, correct: true, nextDue: futureDue } },
    });
    assert.match(flashGrade, /已记 4 分 · 3 天后再见/);

    const rubricDone = uiMod.buildFeedbackAnnouncement({
      run: { feedback: { rubric: { total: 7.5, max: 10 }, nextDue: futureDue } },
    });
    assert.match(rubricDone, /批改完成，得分 7\.5\/10 分/);

    const gradeFail = uiMod.buildFeedbackAnnouncement({
      run: { feedback: null },
      gradeTask: { status: 'failed', message: 'timeout' },
    });
    assert.match(gradeFail, /批改失败：timeout/);

    uiMod.setUiLanguage('en');
    for (const text of [
      uiMod.buildFeedbackAnnouncement({
        run: { feedback: { correct: false, selected: ['b'], retryQueued: true, nextDue: futureDue }, solution: { options: [{ id: 'a', correct: true }] } },
        choice: true,
      }),
      uiMod.buildFeedbackAnnouncement({
        run: { feedback: { grade: 5, correct: true, nextDue: futureDue } },
      }),
      uiMod.buildFeedbackAnnouncement({
        run: { feedback: { rubric: { total: 8, max: 10 }, nextDue: futureDue } },
      }),
      uiMod.buildFeedbackAnnouncement({
        run: { feedback: null },
        gradeTask: { status: 'failed', message: '' },
      }),
    ]) {
      assert.ok(text.length > 0);
      assert.doesNotMatch(text, han, `unexpected Han in English announcement: ${text}`);
    }
  } finally {
    uiMod.setUiLanguage('zh');
  }
});

test('ExplanationFollowup and RoundLookBack avoid illegal headings inside <summary>', () => {
  const followupHtml = renderWithServices(h(uiMod.ExplanationFollowup, {
    run: {
      deckId: 'd1',
      card: { id: 'c1' },
      solution: { followups: [{ id: 'f1', question: 'Why does Raft need term numbers?', answer: 'To detect stale leaders.' }] },
    },
    readOnly: true,
  }));
  assert.match(followupHtml, /<summary>[\s\S]*?<span class="followup-item__title">Why does Raft need term numbers\?<\/span>/);
  assert.doesNotMatch(followupHtml, /<summary>[\s\S]*?<h[1-6]\b/, 'no heading inside ExplanationFollowup <summary>');

  uiMod.setQueryData('review.lookBack', { runId: 'run-pass' }, {
    rows: [{
      number: 1,
      entryIndex: 0,
      deckId: 'd1',
      cardId: 'c1',
      kind: 'quiz',
      status: 'right',
      card: { id: 'c1', kind: 'quiz', prompt: 'Q1?', options: [{ id: 'a', text: 'Yes' }] },
      feedback: { selected: ['a'], correct: true },
      solution: { options: [{ id: 'a', correct: true }] },
    }],
  });
  const lookBackHtml = renderWithServices(h(uiMod.RoundLookBack, {
    run: { id: 'run-pass', mode: 'path', navigation: [{ answered: true }], correctionsPending: 0 },
    collapsible: true,
  }));
  assert.match(lookBackHtml, /<summary class="round-look-back__summary"><span class="round-look-back__title">本轮题目<\/span>/);
  assert.doesNotMatch(lookBackHtml, /<summary[^>]*>[\s\S]*?<h[1-6]\b/, 'no heading inside RoundLookBack <summary>');
});

test('Exam pre-mounts polite/assertive live slots, makes prompt heading focusable, and announces time milestones in ZH/EN', async (t) => {
  const setupHtml = renderWithServices(h(uiMod.Exam, {
    data: { root: 'r', decks: [], runs: [], exams: [], focus: { courses: [] } },
    onExit: noop,
  }));
  assert.match(setupHtml, /<div class="sh-visually-hidden" role="status" aria-live="polite" aria-atomic="true" data-live-announcer="exam-status"><\/div>/);

  const nowMs = 1_700_000_000_000;
  t.mock.method(Date, 'now', () => nowMs);
  const startedAt = new Date(nowMs - 6 * 60_000).toISOString();
  const q1 = {
    id: 'exam-run-1',
    mode: 'exam',
    title: 'Distributed Systems Exam',
    startedAt,
    limitMs: 10 * 60_000,
    index: 0,
    total: 2,
    deckId: 'd1',
    card: {
      id: 'q1',
      kind: 'quiz',
      topic: 'Consensus',
      prompt: 'First exam prompt?',
      options: [{ id: 'a', text: 'Option A' }, { id: 'b', text: 'Option B' }],
    },
    picks: [{ deckId: 'd1', cardId: 'q1', selected: [] }, { deckId: 'd1', cardId: 'q2', selected: [] }],
  };
  const q2 = {
    ...q1,
    index: 1,
    card: {
      id: 'q2',
      kind: 'quiz',
      topic: 'Replication',
      prompt: 'Second exam prompt?',
      options: [{ id: 'a', text: 'Option C' }, { id: 'b', text: 'Option D' }],
    },
  };
  const interactive = await loadInteractiveUi(`
    export { default as Exam } from './ui/Exam.jsx';
    export { StudyServicesContext } from './ui/study-context.jsx';
    export { setUiLanguage } from './ui/i18n.js';
  `);
  await withBrowserGlobals(async () => {
    interactive.exports.setUiLanguage('zh');
    const services = {
      ...baseServices,
      call: async (action, args) => {
        if (action === 'review.get' && args?.runId === 'exam-run-1') return q1;
        if (action === 'review.move' && args?.runId === 'exam-run-1') return q2;
        return {};
      },
    };
    const ih = interactive.React.createElement;
    const mounted = interactive.mount(() => ih(
      interactive.exports.StudyServicesContext.Provider,
      { value: services },
      ih(interactive.exports.Exam, {
        data: { root: 'r', decks: [], runs: [], exams: [], focus: { courses: [] } },
        initialRunId: 'exam-run-1',
        onExit: noop,
      }),
    ));
    try {
      await mounted.flush(6);
      const statusLive = mounted.find((n) => n.props?.['data-live-announcer'] === 'exam-status');
      assert.ok(statusLive, 'exam-status live slot renders while running');
      assert.equal(statusLive.props.role, 'status');
      assert.equal(statusLive.props['aria-live'], 'polite');
      assert.equal(statusLive.props['aria-atomic'], 'true');
      assert.match(mounted.text(statusLive), /模拟考试已开始，共 2 题/);

      const timerLive = mounted.find((n) => n.props?.['data-live-announcer'] === 'exam-timer');
      assert.ok(timerLive, 'exam-timer assertive live slot renders in timed written run');
      assert.equal(timerLive.props.role, 'alert');
      assert.equal(timerLive.props['aria-live'], 'assertive');
      assert.equal(timerLive.props['aria-atomic'], 'true');
      assert.match(mounted.text(timerLive), /考试剩余不足 5 分钟/);

      const promptHeading = mounted.find((n) => typeof n.props?.className === 'string' && n.props.className.split(/\s+/).includes('exam-prompt'));
      assert.ok(promptHeading, 'exam prompt heading renders in running phase');
      assert.equal(promptHeading.props.role, 'heading');
      assert.equal(promptHeading.props['aria-level'], 2);
      assert.equal(promptHeading.props.tabIndex, -1);
      assert.match(mounted.text(promptHeading), /First exam prompt\?/);

      const focusCalls = [];
      promptHeading.ref.current.focus = (opts) => focusCalls.push(opts);
      const nextBtn = mounted.find((n) => n.type === 'button' && mounted.text(n).includes('下一题'));
      assert.ok(nextBtn, 'next question button renders');
      await mounted.act(() => click(nextBtn));
      await mounted.flush(6);

      const nextPrompt = mounted.find((n) => typeof n.props?.className === 'string' && n.props.className.split(/\s+/).includes('exam-prompt'));
      assert.match(mounted.text(nextPrompt), /Second exam prompt\?/);
      assert.deepEqual(focusCalls, [{ preventScroll: true }], 'moving to next exam question quietly focuses .exam-prompt');
    } finally {
      mounted.unmount();
    }
  });

  uiMod.setUiLanguage('zh');
  try {
    assert.deepEqual(uiMod.examTimeWarning(10 * 60_000, false), { key: '', text: '' });
    assert.equal(uiMod.examTimeWarning(4 * 60_000, false).key, '5m');
    assert.match(uiMod.examTimeWarning(4 * 60_000, false).text, /5 分钟/);
    assert.equal(uiMod.examTimeWarning(45_000, false).key, '1m');
    assert.match(uiMod.examTimeWarning(45_000, false).text, /1 分钟/);
    assert.equal(uiMod.examTimeWarning(0, true).key, 'expired');
    assert.match(uiMod.examTimeWarning(0, true).text, /自动交卷/);

    uiMod.setUiLanguage('en');
    for (const ms of [4 * 60_000, 45_000, 0]) {
      const msg = uiMod.examTimeWarning(ms, ms === 0);
      assert.ok(msg.text.length > 0);
      assert.doesNotMatch(msg.text, han, `unexpected Han in English exam warning: ${msg.text}`);
    }
  } finally {
    uiMod.setUiLanguage('zh');
  }
});

test('CaseReport pre-mounts polite live announcer and announces async grading progress, completion, and failures', () => {
  const pendingPaper = {
    total: 0,
    max: 10,
    pending: 2,
    weakest: [],
    pacing: { readingMs: 60_000, writingMs: 120_000, writingMinutes: 10, unanswered: [], overBudget: [], rows: [] },
    questions: [
      { n: 1, cardId: 'q1', deckId: 'd1', prompt: 'Q1', status: 'pending', total: null, marks: 5 },
      { n: 2, cardId: 'q2', deckId: 'd1', prompt: 'Q2', status: 'pending', total: null, marks: 5 },
    ],
  };
  const html = renderWithServices(h(uiMod.CaseReport, {
    report: { runId: 'case-1', case: pendingPaper },
    busy: false,
    assistTasks: [{ mode: 'grade', runId: 'case-1', cardId: 'q1', status: 'running' }],
  }));
  assert.match(html, /<div class="sh-visually-hidden" role="status" aria-live="polite" aria-atomic="true" data-live-announcer="case-grading"><\/div>/);
  assert.doesNotMatch(html, /class="case-report__pending"[^>]*role="status"/);

  uiMod.setUiLanguage('zh');
  try {
    const start = { runId: 'case-1', phase: 'running', graded: 0 };
    assert.equal(uiMod.caseGradingAnnouncement(null, { ...start, total: 2, scoreTotal: 0, scoreMax: 10, errors: [] }), '');
    assert.equal(uiMod.caseGradingAnnouncement(start, { ...start, total: 2, scoreTotal: 0, scoreMax: 10, errors: [] }), null);
    assert.match(
      uiMod.caseGradingAnnouncement(start, { runId: 'case-1', phase: 'running', graded: 1, total: 2, scoreTotal: 4, scoreMax: 10, errors: [] }),
      /已批改 1\/2 题/,
    );
    assert.match(
      uiMod.caseGradingAnnouncement({ runId: 'case-1', phase: 'running', graded: 1 }, { runId: 'case-1', phase: 'done', graded: 2, total: 2, scoreTotal: 8.5, scoreMax: 10, errors: [] }),
      /全部批改完成，共得 8\.5\/10 分/,
    );
    assert.match(
      uiMod.caseGradingAnnouncement(start, { runId: 'case-1', phase: 'failed', graded: 0, total: 2, scoreTotal: 0, scoreMax: 10, errors: ['模型超时'] }),
      /批改失败：模型超时/,
    );
    assert.match(
      uiMod.caseGradingAnnouncement(start, { runId: 'case-1', phase: 'interrupted', graded: 0, total: 2, scoreTotal: 0, scoreMax: 10, errors: [] }),
      /上次批改没有完成/,
    );

    uiMod.setUiLanguage('en');
    for (const msg of [
      uiMod.caseGradingAnnouncement(start, { runId: 'case-1', phase: 'running', graded: 1, total: 2, scoreTotal: 4, scoreMax: 10, errors: [] }),
      uiMod.caseGradingAnnouncement(start, { runId: 'case-1', phase: 'done', graded: 2, total: 2, scoreTotal: 8, scoreMax: 10, errors: [] }),
      uiMod.caseGradingAnnouncement(start, { runId: 'case-1', phase: 'failed', graded: 0, total: 2, scoreTotal: 0, scoreMax: 10, errors: ['timeout'] }),
      uiMod.caseGradingAnnouncement(start, { runId: 'case-1', phase: 'interrupted', graded: 0, total: 2, scoreTotal: 0, scoreMax: 10, errors: [] }),
    ]) {
      assert.ok(msg.length > 0);
      assert.doesNotMatch(msg, han, `unexpected Han in English case grading announcement: ${msg}`);
    }
  } finally {
    uiMod.setUiLanguage('zh');
  }
});

test('Dashboard heatmap eliminates 100+ Tab-stop trap with single roving tabIndex and arrow navigation', () => {
  const heatmap = Array.from({ length: 14 * 7 }, (_, i) => ({
    date: `2026-07-${String(i + 1).padStart(2, '0')}`,
    count: i % 5 === 0 ? 3 : 0,
  }));
  const stats = {
    today: '2026-10-02',
    totals: { attempts: 60, activeDays: 20, streak: 4, due: 5, gradedRate: 80, gradedAttempts: 40, selfRate: 75, selfAttempts: 20, oralAttempts: 0, oralStrong: 0 },
    heatmap,
    trend: [],
    forecast: { days: [], later: 0 },
    mastery: { windowDays: 30, minAnswers: 3, levels: [], kinds: [] },
    weakTopics: [],
  };
  const html = renderWithServices(h(uiMod.StatsView, {
    stats,
    course: '*',
    data: { decks: [], focus: {} },
    onStartScope: noop,
    onLibrary: noop,
    onCreate: noop,
    onSources: noop,
  }));
  const heatBlock = html.match(/<div class="dash-heat"[\s\S]*?<div class="dash-heat-legend"/)?.[0] || '';
  assert.ok(heatBlock.length > 0, 'heatmap rendered');
  assert.match(heatBlock, /class="dash-heat" role="group"/, 'heatmap uses role="group" instead of hiding focusable cells under role="img"');
  assert.doesNotMatch(heatBlock, /class="dash-heat" role="img"/);
  assert.equal((heatBlock.match(/tabindex="0"/g) || []).length, 1, 'exactly 1 Tab stop in the entire heatmap');
  assert.equal((heatBlock.match(/tabindex="-1"/g) || []).length, heatmap.length - 1, 'remaining cells are roving focus targets');
  assert.match(heatBlock, /aria-label="近 14 周的每日作答次数热力图：20 个活跃日 · 累计作答 60 次，用方向键查看每天记录"/);

  const enHtml = renderWithServices(h(uiMod.StatsView, {
    stats,
    course: '*',
    data: { decks: [], focus: {} },
    onStartScope: noop,
    onLibrary: noop,
    onCreate: noop,
    onSources: noop,
  }), 'en');
  const enHeatBlock = enHtml.match(/<div class="dash-heat"[\s\S]*?<div class="dash-heat-legend"/)?.[0] || '';
  assert.doesNotMatch(enHeatBlock.replace(/<[^>]+>/g, ' '), han);
  assert.match(enHeatBlock, /20 active days · 60 attempts in total\. Use arrow keys to inspect each day\./);

  // Roving navigation math on 7-row column-major grid
  assert.equal(uiMod.nextHeatmapIndex(10, 'ArrowDown', 98), 11);
  assert.equal(uiMod.nextHeatmapIndex(10, 'ArrowUp', 98), 9);
  assert.equal(uiMod.nextHeatmapIndex(10, 'ArrowRight', 98), 17);
  assert.equal(uiMod.nextHeatmapIndex(10, 'ArrowLeft', 98), 3);
  assert.equal(uiMod.nextHeatmapIndex(10, 'Home', 98), 0);
  assert.equal(uiMod.nextHeatmapIndex(10, 'End', 98), 97);
  assert.equal(uiMod.nextHeatmapIndex(0, 'ArrowUp', 98), 0);
  assert.equal(uiMod.nextHeatmapIndex(2, 'ArrowLeft', 98), 0);
  assert.equal(uiMod.nextHeatmapIndex(97, 'ArrowDown', 98), 97);
  assert.equal(uiMod.nextHeatmapIndex(95, 'ArrowRight', 98), 97);
  assert.equal(uiMod.nextHeatmapIndex(10, 'Tab', 98), null);
  assert.equal(uiMod.nextHeatmapIndex(0, 'ArrowDown', 0), null);
});
