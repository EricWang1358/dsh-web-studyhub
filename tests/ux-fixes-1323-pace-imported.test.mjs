import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';
import { extractLearnerPace, libraryPaceForecast, todayPaceSummary } from '../lib/pace/forecast.js';
import { studyStats, wrongBook } from '../lib/insights.js';
import { recapGroups } from '../lib/daily-recap.js';
import { attemptPassed } from '../lib/course-method-progress.js';
import { loadUi } from './helpers/ui-module.mjs';

const uiMod = await loadUi(`
  export { computeTodayPace } from './ui/review/today-pace.js';
  export { resolveForecastView, buildSliceForecast } from './ui/pace/format-pace.js';
  export { default as DeskIntro } from './ui/study-map/DeskIntro.jsx';
  export { default as MasteryMap } from './ui/mastery-map/MasteryMap.jsx';
`);

test('#1323-1: snapshot todayPace summary counts >100 attempts and ignores voided/implicit so 100 & 108 goals complete', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'study-1323-1-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const service = new StudyService(dir);
  t.after(() => service.dispose());

  const now = Date.now();
  const isoNow = new Date(now).toISOString();

  await service.store.update((s) => {
    s.courses = [{ id: 'c1', name: 'Algorithms' }];
    s.decks = [{
      id: 'd1',
      title: 'DP',
      course: 'Algorithms',
      cards: [{ id: 'card-1', kind: 'quiz', topic: 'DP', prompt: 'Q?', answer: 'A' }],
    }];
    // 108 valid attempts today + 5 voided + 5 implicit -> last-100 slice would drop below 100!
    for (let i = 0; i < 108; i += 1) {
      s.attempts.push({
        id: `att-valid-${i}`,
        deckId: 'd1',
        quiz_id: 'card-1',
        topic: 'DP',
        timestamp: isoNow,
        grade: 4,
        assessment: 'graded',
        elapsed_ms: 40_000,
      });
    }
    for (let i = 0; i < 5; i += 1) {
      s.attempts.push({
        id: `att-void-${i}`,
        deckId: 'd1',
        quiz_id: 'card-1',
        timestamp: isoNow,
        grade: 1,
        voidedAt: isoNow,
        elapsed_ms: 40_000,
      });
      s.attempts.push({
        id: `att-imp-${i}`,
        deckId: 'd1',
        quiz_id: 'card-1',
        timestamp: isoNow,
        grade: 4,
        implicit: true,
        elapsed_ms: 40_000,
      });
    }
  });

  const snap = await service.call('snapshot', {});
  assert.equal(snap.attempts.length, 100, 'snapshot attempts slice stays bounded at 100');
  assert.equal(snap.todayPace.todayCount, 108, 'snapshot todayPace summary preserves full-day valid count');

  const pace108 = uiMod.computeTodayPace({
    attempts: snap.attempts,
    summary: snap.todayPace,
    goal: 108,
    now,
  });
  assert.equal(pace108.todayCount, 108);
  assert.equal(pace108.goalMet, true, '108-card goal is achieved via todayPace summary');

  const pace100 = uiMod.computeTodayPace({
    attempts: snap.attempts,
    summary: snap.todayPace,
    goal: 100,
    now,
  });
  assert.equal(pace100.goalMet, true, 'built-in 100-card goal is not blocked by trailing voided/implicit rows');

  // Stale-date summary falls back cleanly to attempts[]
  const stale = uiMod.computeTodayPace({
    attempts: [{ timestamp: isoNow, grade: 4, elapsed_ms: 30_000 }],
    summary: { date: '2000-01-01', todayCount: 999 },
    goal: 30,
    now,
  });
  assert.equal(stale.todayCount, 1);
});

test('#1323-2: empty/uncategorized course hides library pace, custom workMinutes recomputes pomodoros O(1), sample attempts never pollute pace', () => {
  const now = Date.now();
  const dayMs = 86_400_000;

  // 1) Sample attempts from 21 days ago must NOT defeat day-1 span protection, and sample decks stay out of library total
  const state = {
    courses: [
      { id: 'c-sample', name: '示例课程', sample: true },
      { id: 'c-real', name: '操作系统' },
      { id: 'c-empty', name: '空白新课' },
    ],
    decks: [
      {
        id: 'd-sample',
        title: '示例题组',
        course: '示例课程',
        sample: true,
        cards: [{ id: 'sc1', kind: 'quiz', topic: 'Sample', prompt: 'S?' }],
      },
      {
        id: 'd-real',
        title: 'OS 题组',
        course: '操作系统',
        cards: Array.from({ length: 10 }, (_, i) => ({ id: `rc-${i}`, kind: 'quiz', topic: 'OS', prompt: `Q${i}?` })),
      },
    ],
    attempts: [
      // 21-day-old sample attempt + recent sample attempts
      { id: 'sa-old', deckId: 'd-sample', quiz_id: 'sc1', timestamp: new Date(now - 21 * dayMs).toISOString(), grade: 4, elapsed_ms: 30_000, sample: true },
      { id: 'sa-1', deckId: 'd-sample', quiz_id: 'sc1', timestamp: new Date(now - 2 * dayMs).toISOString(), grade: 4, elapsed_ms: 30_000, sample: true },
      // Brand new real learner did 30 cards TODAY only (day 1)
      ...Array.from({ length: 30 }, (_, i) => ({
        id: `ra-${i}`,
        deckId: 'd-real',
        quiz_id: `rc-${i % 10}`,
        timestamp: new Date(now - 60_000).toISOString(),
        grade: 4,
        elapsed_ms: 40_000,
      })),
    ],
  };

  const pace = extractLearnerPace(state.attempts, { now });
  assert.equal(pace.spanDays7d, 1, 'day-1 learner is NOT averaged over 7 days due to 21-day-old sample attempts');
  assert.equal(pace.dailyAttempts, 30, 'dailyAttempts reflects actual day-1 pace (30/day), not 30/7');

  const forecast = libraryPaceForecast(state, { now });
  assert.equal(forecast.library.total, 10, 'library forecast excludes sample decks');
  assert.equal(forecast.courses['示例课程']?.total, 1, 'viewing sample course directly still has its own forecast');
  assert.equal(forecast.courses['空白新课'], undefined, 'empty course has no entry');

  // 2) DeskIntro on an empty course must NOT fall back to forecast.library
  const emptyDeskHtml = renderToStaticMarkup(React.createElement(uiMod.DeskIntro, {
    data: {
      focus: { course: '空白新课', courses: [{ name: '空白新课' }, { name: '操作系统' }] },
      paceForecast: forecast,
      next: null,
    },
    home: { route: null, starter: null, headline: '空白新课', plan: { kind: 'empty', also: [] }, alternatives: [], otherRuns: [], otherCourse: null },
    mastery: { primary: null },
    start: () => {},
    resume: () => {},
    endRun: () => {},
    onFocus: () => {},
  }));
  assert.doesNotMatch(emptyDeskHtml, /data-pace-meta=/, 'empty course must NOT display library-wide paceForecast');

  // 3) Custom workMinutes (45 min vs 25 min) recomputes pomodoros & exam.requiredDailyPomodoros O(1)
  const entry = {
    status: 'active',
    total: 30,
    remaining: 30,
    passes: 60,
    pomodoros: 5,
    hours: 2.1,
    days: 17,
    floor: 17,
    exam: { date: '2026-12-01', daysLeft: 10, behind: true, requiredDailyCards: 18, requiredDailyPomodoros: 1 },
  };
  const basePace = { medianCardSec: 60, focusMinutes: 25, reworkFactor: 1.25, dailyAttempts: 10 };
  const view25 = uiMod.resolveForecastView(entry, basePace);
  const view45 = uiMod.resolveForecastView(entry, basePace, { focusMinutes: 45 });
  assert.equal(view25.focusMin, 25);
  assert.equal(view45.focusMin, 45);
  assert.ok(view45.pomodoros < view25.pomodoros, `45-min pomodoros (${view45.pomodoros}) must be fewer than 25-min (${view25.pomodoros})`);
  assert.ok(view45.exam.requiredDailyPomodoros < view25.exam.requiredDailyPomodoros || view45.exam.requiredDailyPomodoros === 0.5);

  const slice25 = uiMod.buildSliceForecast({ count: 30, paceForecast: { pace: basePace }, focusMinutes: 25 });
  const slice45 = uiMod.buildSliceForecast({ count: 30, paceForecast: { pace: basePace }, focusMinutes: 45 });
  assert.ok(slice45.pomodoros < slice25.pomodoros, 'slice forecast respects custom workMinutes');
});

test('#1323-5: imported historical mistakes stay in WrongBook & weakTopics without inflating today goal, stats, pace, or daily recap', () => {
  const now = Date.now();
  const isoNow = new Date(now).toISOString();
  const cards = Array.from({ length: 30 }, (_, i) => ({
    id: `imp-c-${i}`,
    kind: 'quiz',
    topic: 'TCP',
    prompt: `Imported Q ${i}?`,
    answer: 'A',
  }));
  const importedAttempts = cards.map((card, i) => ({
    id: `imp-att-${i}`,
    deckId: 'd-net',
    quiz_id: card.id,
    topic: card.topic,
    timestamp: isoNow,
    grade: 1,
    assessment: 'graded',
    imported: 'mistake',
    elapsed_ms: 0,
  }));
  const state = {
    courses: [{ id: 'c-net', name: '计网' }],
    decks: [{ id: 'd-net', title: 'TCP 错题', course: '计网', cards }],
    attempts: importedAttempts,
    runs: [],
    notes: [],
  };

  // 1) todayPaceSummary & computeTodayPace ignore imported mistakes
  const summary = todayPaceSummary(state.attempts, { now });
  assert.equal(summary.todayCount, 0, 'todayPaceSummary ignores imported mistakes');
  const todayPace = uiMod.computeTodayPace({ attempts: state.attempts, goal: 30, now });
  assert.equal(todayPace.todayCount, 0, 'computeTodayPace ignores imported mistakes');
  assert.equal(todayPace.goalMet, false);

  // 2) extractLearnerPace ignores imported mistakes (reworkFactor stays default 1.25, not 2.0)
  const pace = extractLearnerPace(state.attempts, { now });
  assert.equal(pace.attempts7d, 0);
  assert.equal(pace.attempts14d, 0);
  assert.equal(pace.reworkFactor, 1.25);

  // 3) studyStats excludes imported mistakes from attempts/streak/heatmap/rate, while keeping weak & weakTopics consistent
  const stats = studyStats(state, { course: '计网' }, new Date(now));
  assert.equal(stats.totals.attempts, 0);
  assert.equal(stats.totals.streak, 0);
  assert.equal(stats.heatmap.at(-1)?.count, 0);
  assert.equal(stats.totals.correctRate, null);
  assert.equal(stats.totals.weak, 30, 'imported mistakes still count as weak cards');
  assert.equal(stats.weakTopics.length, 1, 'weakTopics still surfaces imported weak topic');
  assert.equal(stats.weakTopics[0].wrong, 30);

  // 4) WrongBook still lists imported mistakes under view="weak"
  const wb = wrongBook(state, { course: '计网', view: 'weak' });
  assert.equal(wb.total, 30, 'imported mistakes still enter WrongBook weak');

  // 5) Daily recap excludes imported mistakes
  const recap = recapGroups(state, { now: new Date(now) });
  assert.equal(recap.groups.length, 0, 'imported mistakes do not trigger daily recap');

  // 6) Course method progress never counts imported mistakes as answered
  assert.equal(attemptPassed(importedAttempts[0], 'answered'), false);
  assert.equal(attemptPassed(importedAttempts[0], 'right'), false);
});
