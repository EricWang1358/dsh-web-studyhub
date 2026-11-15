import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

const m = await loadUi(`
  export { selectTodayFocusStrip } from './ui/board/today-focus-strip.js';
  export { default as TodayFocusStrip } from './ui/board/TodayFocusStrip.jsx';
  export { StudyProgressPanel } from './ui/guided-study/StudyProgressPanel.jsx';
  export { default as GuidedStudyWorkbench } from './ui/guided-study/GuidedStudyWorkbench.jsx';
  export { default as WrittenReport } from './ui/exam/WrittenReport.jsx';
  export { default as MasteryBar } from './ui/study-map/MasteryBar.jsx';
  export { default as FocusProgressLine } from './ui/study-map/FocusProgressLine.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

const h = React.createElement;
const noop = () => {};
const han = /[\u3400-\u9fff]/;
const render = (type, props, language = 'zh') => {
  m.setUiLanguage(language);
  try {
    return renderToStaticMarkup(h(type, props));
  } finally {
    m.setUiLanguage('zh');
  }
};

/* U35: Daily focus budget goal-reached positive feedback & EN copy hygiene. */
test('U35: TodayFocusStrip celebrates focus budget completion calmly when focused >= planned', () => {
  const libWithWeak = {
    focus: { progress: { topics: [{ topic: 'Locks', mastery: 40, counts: { weak: 1 }, weakCards: ['q1'] }] } },
  };
  const under = m.selectTodayFocusStrip({ library: libWithWeak, budgetMinutes: 45, focusedMinutes: 30 });
  assert.equal(under.budget.met, false);
  const exact = m.selectTodayFocusStrip({ library: libWithWeak, budgetMinutes: 45, focusedMinutes: 45 });
  assert.equal(exact.budget.met, true);
  const over = m.selectTodayFocusStrip({ library: libWithWeak, budgetMinutes: 45, focusedMinutes: 60 });
  assert.equal(over.budget.met, true);
  const noFocus = m.selectTodayFocusStrip({ library: libWithWeak, budgetMinutes: 45, focusedMinutes: null });
  assert.equal(noFocus.budget.met, false);
  const emptyHidden = m.selectTodayFocusStrip({ library: {}, budgetMinutes: 45, focusedMinutes: null });
  assert.equal(emptyHidden.visible, false);
  assert.equal(emptyHidden.budget, null);

  const htmlUnder = render(m.TodayFocusStrip, { library: libWithWeak, budgetMinutes: 45, focusedMinutes: 30 });
  assert.doesNotMatch(htmlUnder, /data-testid="focus-budget-met"/);
  assert.doesNotMatch(htmlUnder, /data-goal-met="true"/);

  const htmlMet = render(m.TodayFocusStrip, { library: { settings: {} }, budgetMinutes: 45, focusedMinutes: 45 });
  assert.match(htmlMet, /data-goal-met="true"/);
  assert.match(htmlMet, /data-testid="focus-budget-met"/);
  assert.match(htmlMet, /已达标/);
  assert.match(htmlMet, /data-tone="success"/);

  const htmlEn = render(m.TodayFocusStrip, { library: { settings: {} }, budgetMinutes: 45, focusedMinutes: 50 }, 'en');
  assert.match(htmlEn, /Goal met/);
  assert.doesNotMatch(htmlEn, han);
});

/* U36: Guided Study progress bar, all-passed milestone & immediate card verdict strip. */
test('U36: StudyProgressPanel shows visual progress only after measurement and highlights all-passed state', () => {
  const unread = render(m.StudyProgressPanel, {
    progress: { displayLine: '检验项共 2 项', lectureCoveredCount: 0, nextDayDueCount: 0, items: [] },
    estimate: { status: 'estimating' },
  });
  assert.doesNotMatch(unread, /progress-goal-bar/, 'before first read, do not render a progress bar');
  assert.doesNotMatch(unread, /data-all-passed="true"/);

  const partial = render(m.StudyProgressPanel, {
    progress: { displayLine: 'x', totalCount: 3, independentPassedCount: 1, independentRatio: 1 / 3, lectureCoveredCount: 1, nextDayDueCount: 0, items: [] },
    estimate: { status: 'estimated', minMinutes: 5, maxMinutes: 10 },
  });
  assert.match(partial, /progress-goal-bar/);
  assert.match(partial, /data-tone="accent"/);
  assert.doesNotMatch(partial, /data-all-passed="true"/);

  const done = render(m.StudyProgressPanel, {
    progress: { displayLine: 'x', totalCount: 3, independentPassedCount: 3, independentRatio: 1, lectureCoveredCount: 2, nextDayDueCount: 1, items: [] },
    estimate: { status: 'completed' },
  });
  assert.match(done, /data-all-passed="true"/);
  assert.match(done, /progress-goal-bar/);
  assert.match(done, /data-tone="success"/);
  assert.match(done, /data-completed="true"/);
});

test('U36: GuidedStudyWorkbench displays verdict banner for graded and self-rated cards without CJK in EN', () => {
  const choiceCard = { id: 'q1', kind: 'quiz', prompt: 'Q1', options: [{ id: 'a', text: 'A', correct: true }] };
  const flashCard = { id: 'f1', kind: 'flashcard', prompt: 'F1' };
  const session = { id: 's1', courseId: 'CS101', status: 'active', goal: { title: 'Trees' } };

  const gradedOk = render(m.GuidedStudyWorkbench, {
    session,
    run: { id: 'r1', card: choiceCard, feedback: { correct: true } },
    onNext: noop,
  });
  assert.match(gradedOk, /data-testid="guided-card-verdict"[^>]*data-tone="success"/);
  assert.match(gradedOk, /回答正确/);

  const gradedMiss = render(m.GuidedStudyWorkbench, {
    session,
    run: { id: 'r1', card: choiceCard, feedback: { correct: false } },
    onNext: noop,
  });
  assert.match(gradedMiss, /data-testid="guided-card-verdict"[^>]*data-tone="warning"/);
  assert.match(gradedMiss, /这道题还没过关/);

  const selfOk = render(m.GuidedStudyWorkbench, {
    session,
    run: { id: 'r1', card: flashCard, revealed: true, feedback: { grade: 3, correct: true } },
    onNext: noop,
  });
  assert.match(selfOk, /data-testid="guided-card-verdict"[^>]*data-tone="success"/);
  assert.match(selfOk, /已记录掌握，会计入检验与复习排期/);

  const selfMiss = render(m.GuidedStudyWorkbench, {
    session,
    run: { id: 'r1', card: flashCard, revealed: true, feedback: { grade: 1, correct: false } },
    onNext: noop,
  });
  assert.match(selfMiss, /data-testid="guided-card-verdict"[^>]*data-tone="warning"/);
  assert.match(selfMiss, /已记入待巩固，先看解析或带回主会话/);

  for (const fb of [{ correct: true }, { correct: false }]) {
    const enChoice = render(m.GuidedStudyWorkbench, { session, run: { id: 'r1', card: choiceCard, feedback: fb }, onNext: noop }, 'en');
    assert.doesNotMatch(enChoice, han);
    const enFlash = render(m.GuidedStudyWorkbench, { session, run: { id: 'r1', card: flashCard, revealed: true, feedback: fb }, onNext: noop }, 'en');
    assert.doesNotMatch(enFlash, han);
  }
});

/* U37: Written Exam Report all-correct recognition, score delta chip & heading polish. */
test('U37: WrittenReport highlights 100% all-correct exams and positive score improvement vs previous attempt', () => {
  const perfectReport = {
    runId: 'r1',
    scorePct: 100,
    correct: 10,
    total: 10,
    answered: 10,
    durationMs: 240000,
    comparison: { scorePct: 80, deltaPct: 20 },
    byTopic: [
      { deckId: 'd1', deckTitle: 'OS', topic: 'Locks', correct: 5, total: 5 },
      { deckId: 'd1', deckTitle: 'OS', topic: 'Paging', correct: 5, total: 5 },
    ],
    wrong: [],
    skipped: [],
    weakScope: [],
  };

  const zh = render(m.WrittenReport, { report: perfectReport, busy: false, pathNote: '', error: '', onExit: noop, onAgain: noop });
  assert.match(zh, /result-hero sh-paper-card sh-paper-card--roomy"[^>]*data-all-correct="true"/);
  assert.match(zh, /data-testid="exam-all-correct"[^>]*>本次全部答对</);
  assert.match(zh, /data-testid="exam-score-up"[^>]*>较上次 \+20%</);
  assert.match(zh, /class="result-weak"[^>]*data-all-correct="true"/);
  assert.match(zh, /<h2>全部主题均已达标<\/h2>/);
  assert.match(zh, /data-tone="success" role="progressbar"/);

  const en = render(m.WrittenReport, { report: perfectReport, busy: false, pathNote: '', error: '', onExit: noop, onAgain: noop }, 'en');
  assert.match(en, /All correct this exam/);
  assert.match(en, /\+20% vs last exam/);
  assert.match(en, /All tested topics attained/);
  assert.doesNotMatch(en, han);

  const zeroEmpty = render(m.WrittenReport, {
    report: { ...perfectReport, scorePct: 0, correct: 0, total: 0, answered: 0, comparison: null, byTopic: [] },
    busy: false, pathNote: '', error: '', onExit: noop, onAgain: noop,
  });
  assert.doesNotMatch(zeroEmpty, /data-all-correct="true"/);
  assert.match(zeroEmpty, /<h2>下次先练这些主题<\/h2>/);

  const lower = render(m.WrittenReport, {
    report: { ...perfectReport, scorePct: 70, correct: 7, comparison: { scorePct: 80, deltaPct: -10 }, byTopic: [{ deckId: 'd1', deckTitle: 'OS', topic: 'Locks', correct: 7, total: 10 }] },
    busy: false, pathNote: '', error: '', onExit: noop, onAgain: noop,
  });
  assert.doesNotMatch(lower, /exam-score-up/);
  assert.doesNotMatch(lower, /exam-all-correct/);
});

/* U38: Study Map mastered value tone & FocusProgressLine hookless all-mastered marker. */
test('U38: MasteryBar marks mastered nodes and FocusProgressLine stays hookless while showing All mastered', () => {
  const zeroHtml = render(m.MasteryBar, {
    node: { counts: { mastered: 0, familiar: 0, learning: 0, weak: 0, new: 4 }, mastery: 0, status: 'todo' },
  });
  assert.match(zeroHtml, /mastery-value zero/);
  assert.doesNotMatch(zeroHtml, /is-mastered/);

  const masteredHtml = render(m.MasteryBar, {
    node: { counts: { mastered: 4, familiar: 0, learning: 0, weak: 0, new: 0 }, mastery: 100, status: 'done' },
  });
  assert.match(masteredHtml, /mastery-value is-mastered">100%/);

  const focusAllDone = {
    course: 'OS',
    total: 2,
    done: 2,
    weak: 0,
    none: 0,
    weakScope: [],
    topics: [
      { topic: 'Locks', cards: 2, counts: { mastered: 2, familiar: 0, learning: 0, weak: 0, new: 0 }, mastery: 100, status: 'done', weakCards: [] },
      { topic: 'Paging', cards: 2, counts: { mastered: 2, familiar: 0, learning: 0, weak: 0, new: 0 }, mastery: 100, status: 'done', weakCards: [] },
    ],
  };

  // Direct call verifies zero React hooks inside FocusProgressLine.
  const directTree = m.FocusProgressLine({ progress: focusAllDone, courseId: 'c1', lock: false, start: noop, onCourseSettings: noop });
  assert.ok(directTree && typeof directTree === 'object');

  const zhFocus = render(m.FocusProgressLine, { progress: focusAllDone, courseId: 'c1', lock: false, start: noop, onCourseSettings: noop });
  assert.match(zhFocus, /<p class="focus-progress" data-all-mastered="true">/);
  assert.match(zhFocus, /data-testid="focus-all-mastered"[\s\S]*全部已掌握/);
  assert.doesNotMatch(zhFocus, /\btitle=/);

  const enFocus = render(m.FocusProgressLine, { progress: focusAllDone, courseId: 'c1', lock: false, start: noop, onCourseSettings: noop }, 'en');
  assert.match(enFocus, /All mastered/);
  assert.doesNotMatch(enFocus, han);
});
