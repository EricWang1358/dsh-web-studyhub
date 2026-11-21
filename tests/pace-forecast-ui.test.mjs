import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadUi } from "./helpers/ui-module.mjs";
import { withStudy } from "./helpers/study-services.mjs";

const m = await loadUi(`
  export { default as PaceMeta } from './ui/pace/PaceMeta.jsx';
  export * from './ui/pace/format-pace.js';
  export { default as DeskIntro } from './ui/study-map/DeskIntro.jsx';
  export { default as DeckRow } from './ui/study-map/DeckRow.jsx';
  export { default as MasteryMap } from './ui/mastery-map/MasteryMap.jsx';
  export { default as RoundSetup } from './ui/review/RoundSetup.jsx';
  export { estimateSlicePace } from './ui/review/round-setup.js';
  export { default as Manage } from './ui/Manage.jsx';
  export { default as Review } from './ui/Review.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

const HAN = /[\u3400-\u9fff]/;
const stripTags = (html) => html.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const inLanguage = (lang, fn) => {
  m.setUiLanguage(lang);
  try {
    return fn();
  } finally {
    m.setUiLanguage("zh");
  }
};

function samplePaceForecast() {
  return {
    asOf: "2026-11-22",
    pace: {
      focusMinutes: 25,
      breakMinutes: 5,
      medianCardSec: 50,
      cardSecSource: "observed",
      cardsPerPomodoro: 30,
      attempts7d: 210,
      activeDays7d: 7,
      spanDays7d: 7,
      dailyAttempts: 30,
      attempts14d: 400,
      passRate14d: 0.85,
      reworkFactor: 1.18,
      coldStart: false,
      lowSample: false,
    },
    spacing: { normal: 17, focus: 10 },
    library: {
      status: "active",
      total: 300,
      remaining: 200,
      passes: 520,
      pomodoros: 25,
      hours: 10.4,
      days: 23,
      maxDays: 28,
      floor: 17,
    },
    courses: {
      Algorithms: {
        status: "active",
        total: 180,
        remaining: 150,
        passes: 400,
        pomodoros: 25,
        hours: 10.4,
        days: 23,
        maxDays: 28,
        floor: 17,
        exam: {
          date: "2026-12-05",
          daysLeft: 13,
          behind: true,
          spacingTight: true,
          requiredDailyCards: 40,
          requiredDailyPomodoros: 1.5,
        },
      },
    },
    decks: {
      "d-1": {
        status: "active",
        total: 60,
        remaining: 48,
        passes: 112,
        pomodoros: 6,
        hours: 2.5,
        days: 21,
        maxDays: 25,
        floor: 17,
      },
      "d-done": {
        status: "mastered",
        total: 20,
      },
    },
  };
}

test("PaceMeta formats slice, deck, and course copy cleanly in ZH and EN with zero Han leakage in EN", () => {
  const pf = samplePaceForecast();

  // Slice (active)
  const slice = m.buildSliceForecast({ count: 20, range: "new", paceForecast: pf, deckId: "d-1" });
  const zhSlice = inLanguage("zh", () => renderToStaticMarkup(React.createElement(m.PaceMeta, { variant: "slice", forecast: slice, pace: pf.pace, asOf: pf.asOf })));
  assert.match(stripTags(zhSlice), /这批还需约 \d+(?:\.\d+)? 个番茄，间隔复习完约 2 周后稳固/);
  const enSlice = inLanguage("en", () => renderToStaticMarkup(React.createElement(m.PaceMeta, { variant: "slice", forecast: slice, pace: pf.pace, asOf: pf.asOf })));
  assert.match(stripTags(enSlice), /pomodoros? left for this batch; solid in ~2 weeks with spaced review/);
  assert.equal(HAN.test(stripTags(enSlice)), false, `unexpected Han characters in EN slice: ${stripTags(enSlice)}`);

  // Deck (active)
  const zhDeck = inLanguage("zh", () => renderToStaticMarkup(React.createElement(m.PaceMeta, { variant: "deck", forecast: pf.decks["d-1"], pace: pf.pace, asOf: pf.asOf })));
  assert.match(stripTags(zhDeck), /按最近进度约 3 周学稳 · 约 6 个番茄/);
  const enDeck = inLanguage("en", () => renderToStaticMarkup(React.createElement(m.PaceMeta, { variant: "deck", forecast: pf.decks["d-1"], pace: pf.pace, asOf: pf.asOf })));
  assert.match(stripTags(enDeck), /At recent pace, solid in ~3 weeks · ~6 pomodoros/);
  assert.equal(HAN.test(stripTags(enDeck)), false, `unexpected Han characters in EN deck: ${stripTags(enDeck)}`);

  // Course with exam behind + uncoveredPoints + overrideDailyCards
  const zhCourse = inLanguage("zh", () => renderToStaticMarkup(React.createElement(m.PaceMeta, {
    variant: "course",
    forecast: pf.courses.Algorithms,
    pace: pf.pace,
    asOf: pf.asOf,
    uncoveredPoints: 3,
  })));
  const zhCourseText = stripTags(zhCourse);
  assert.match(zhCourseText, /按近 7 天节奏，大概 12 月中旬学稳（约 25 个番茄）/);
  assert.match(zhCourseText, /不含 3 个尚无题目的知识点/);
  assert.match(zhCourseText, /每天加到约 1\.5 个番茄可考前学稳/);

  const enCourse = inLanguage("en", () => renderToStaticMarkup(React.createElement(m.PaceMeta, {
    variant: "course",
    forecast: pf.courses.Algorithms,
    pace: pf.pace,
    asOf: pf.asOf,
    uncoveredPoints: 3,
  })));
  const enCourseText = stripTags(enCourse);
  assert.match(enCourseText, /At your 7-day pace, solid around mid-Dec \(~25 pomodoros\)/);
  assert.match(enCourseText, /excludes 3 knowledge points without questions/);
  assert.match(enCourseText, /~1\.5 pomodoros\/day to be solid before the exam/);
  assert.equal(HAN.test(enCourseText), false, `unexpected Han characters in EN course: ${enCourseText}`);

  // Override daily cards preview ("按每天 100 题算")
  const zhOverride = inLanguage("zh", () => renderToStaticMarkup(React.createElement(m.PaceMeta, {
    variant: "course",
    forecast: pf.courses.Algorithms,
    pace: pf.pace,
    asOf: pf.asOf,
    overrideDailyCards: 100,
  })));
  assert.match(stripTags(zhOverride), /按每天 100 题算/);
  const enOverride = inLanguage("en", () => renderToStaticMarkup(React.createElement(m.PaceMeta, {
    variant: "course",
    forecast: pf.courses.Algorithms,
    pace: pf.pace,
    asOf: pf.asOf,
    overrideDailyCards: 100,
  })));
  assert.match(stripTags(enOverride), /At 100 cards\/day/);
  assert.equal(HAN.test(stripTags(enOverride)), false);

  // Cold-start copy
  const coldEntry = { status: "cold-start", total: 60, remaining: 60, passes: 180, pomodoros: 7.5, hours: 3.1, days: 17, floor: 17 };
  const coldPace = { ...pf.pace, dailyAttempts: 0, coldStart: true, lowSample: true };
  const zhCold = inLanguage("zh", () => renderToStaticMarkup(React.createElement(m.PaceMeta, { variant: "course", forecast: coldEntry, pace: coldPace })));
  assert.match(stripTags(zhCold), /还需约 7\.5 个番茄/);
  const enCold = inLanguage("en", () => renderToStaticMarkup(React.createElement(m.PaceMeta, { variant: "course", forecast: coldEntry, pace: coldPace })));
  assert.match(stripTags(enCold), /~7\.5 pomodoros remaining/);
  assert.equal(HAN.test(stripTags(enCold)), false);
});

test("DeskIntro renders 1 calm course mastery ETA line from data.paceForecast", () => {
  const pf = samplePaceForecast();
  const data = {
    root: "/tmp/lib",
    focus: { course: "Algorithms", courses: [{ name: "Algorithms", active: true }] },
    decks: [{ id: "d-1", title: "DP", available: 60 }],
    paceForecast: pf,
    next: null,
  };
  const home = {
    route: null,
    starter: null,
    headline: "Algorithms",
    plan: { kind: "ready", also: [] },
    alternatives: [],
    otherRuns: [],
    otherCourse: () => "",
  };
  const mastery = {
    primary: { value: 42, node: { total: 180, counts: { mastered: 30, familiar: 20, learning: 50, weak: 10, new: 70 } } },
    course: { value: 42, cards: 180 },
    whole: null,
    name: "Algorithms",
    others: false,
  };
  const html = renderToStaticMarkup(withStudy(m.StudyServicesContext, React.createElement(m.DeskIntro, {
    data,
    home,
    mastery,
    start: () => {},
    resume: () => {},
    endRun: () => {},
  })));
  assert.match(html, /data-pace-meta="course"/);
  assert.match(stripTags(html), /按近 7 天节奏，大概 12 月中旬学稳（约 25 个番茄）/);
});

test("DeckRow renders inline deck ETA without nesting interactive elements, and hides mastered decks", () => {
  const pf = samplePaceForecast();
  const tree = { selected: new Set(), toggleOpen: () => {}, toggleSelect: () => {} };
  const actions = { start: () => {}, resume: () => {}, manage: () => {}, archiveDeck: () => {}, restoreDeck: () => {}, removeDeck: () => {} };

  const activeHtml = renderToStaticMarkup(withStudy(m.StudyServicesContext, React.createElement(m.DeckRow, {
    deck: { id: "d-1", title: "Dynamic Programming", available: 60 },
    progress: { total: 60, mastery: 35, due: 5, counts: { mastered: 12, familiar: 8, learning: 10, weak: 5, new: 25 }, topics: [] },
    open: false,
    tree,
    runFor: () => null,
    actions,
    paceForecast: pf,
  })));
  assert.match(activeHtml, /data-pace-meta="deck"/);
  assert.match(stripTags(activeHtml), /按最近进度约 3 周学稳 · 约 6 个番茄/);
  // Must render as non-focusable inline span inside <button class="map-name">
  assert.doesNotMatch(activeHtml, /<span[^>]*data-pace-meta="deck"[^>]*tabIndex/);

  // Mastered deck stays quiet (hidden in DeckRow)
  const doneHtml = renderToStaticMarkup(withStudy(m.StudyServicesContext, React.createElement(m.DeckRow, {
    deck: { id: "d-done", title: "Sorting", available: 20 },
    progress: { total: 20, mastery: 100, due: 0, counts: { mastered: 20, familiar: 0, learning: 0, weak: 0, new: 0 }, topics: [] },
    open: false,
    tree,
    runFor: () => null,
    actions,
    paceForecast: pf,
  })));
  assert.doesNotMatch(doneHtml, /data-pace-meta="deck"/);
});

test("MasteryMap shows course ETA with uncovered knowledge-point caveat in ZH and EN", () => {
  const pf = samplePaceForecast();
  const outline = {
    status: "ok",
    course: "Algorithms",
    total: 10,
    placed: 10,
    summary: { total: 10, counts: { mastered: 2, familiar: 2, learning: 3, weak: 1, new: 2 }, due: 2, weak: 1, fresh: 2, percent: 45, state: "learning" },
    book: {
      id: "bk-1",
      nodes: [
        {
          key: "ch1",
          title: "Graphs",
          total: 10,
          counts: { mastered: 2, familiar: 2, learning: 3, weak: 1, new: 2 },
          due: 2,
          mastery: 45,
          children: [
            { key: "p1", title: "BFS", total: 10, counts: { mastered: 2, familiar: 2, learning: 3, weak: 1, new: 2 }, due: 2, mastery: 45 },
            { key: "p2", title: "Max Flow", total: 0, counts: { mastered: 0, familiar: 0, learning: 0, weak: 0, new: 0 }, due: 0, mastery: 0 },
            { key: "p3", title: "NP-Completeness", total: 0, counts: { mastered: 0, familiar: 0, learning: 0, weak: 0, new: 0 }, due: 0, mastery: 0 },
          ],
        },
      ],
    },
  };

  const zhHtml = inLanguage("zh", () =>
    renderToStaticMarkup(withStudy(m.StudyServicesContext, React.createElement(m.MasteryMap, { outline, course: "Algorithms", paceForecast: pf }))),
  );
  assert.match(zhHtml, /data-pace-meta="course"/);
  assert.match(stripTags(zhHtml), /不含 2 个尚无题目的知识点/);

  const enHtml = inLanguage("en", () =>
    renderToStaticMarkup(withStudy(m.StudyServicesContext, React.createElement(m.MasteryMap, { outline, course: "Algorithms", paceForecast: pf }))),
  );
  assert.match(stripTags(enHtml), /excludes 2 knowledge points without questions/);
  assert.equal(HAN.test(stripTags(enHtml)), false, `unexpected Han characters in EN MasteryMap: ${stripTags(enHtml)}`);
});

test("RoundSetup, Manage, and Review round-complete summary render pace ETA cleanly", () => {
  const pf = samplePaceForecast();
  const data = {
    root: "/tmp/lib",
    focus: { course: "Algorithms" },
    decks: [{ id: "d-1", title: "DP", available: 60, count: 60 }],
    progress: { "d-1": { topics: [] } },
    sources: [],
    settings: { practice: { roundSize: 20 } },
    paceForecast: pf,
  };

  // RoundSetup (defaultOpen)
  const setupHtml = renderToStaticMarkup(withStudy(m.StudyServicesContext, React.createElement(m.RoundSetup, {
    data,
    context: { course: "Algorithms", scope: [{ deckId: "d-1" }] },
    chapterRefs: [{ deckId: "d-1" }],
    onStart: async () => {},
    defaultOpen: true,
  })));
  assert.match(setupHtml, /data-pace-meta="slice"/);
  assert.match(stripTags(setupHtml), /这批还需约 \d+(?:\.\d+)? 个番茄/);

  // Manage deck page
  const manageHtml = renderToStaticMarkup(withStudy(m.StudyServicesContext, React.createElement(m.Manage, {
    openDraft: () => {},
    setPage: () => {},
    managedDeck: { id: "d-1", title: "DP", folder: "Algorithms", cards: [{ id: "c1", kind: "quiz", prompt: "Q1", topic: "T1" }] },
    decks: [{ id: "d-1", title: "DP", folder: "Algorithms" }],
    sources: [],
    setManagedDeck: () => {},
    folderDraft: "Algorithms",
    setFolderDraft: () => {},
    onRemoveDeck: () => {},
    paceForecast: pf,
  })));
  assert.match(manageHtml, /data-pace-meta="deck"/);
  assert.match(stripTags(manageHtml), /按最近进度约 3 周学稳 · 约 6 个番茄/);

  // Review round-complete summary (non-exam)
  const reviewHtml = renderToStaticMarkup(withStudy(m.StudyServicesContext, React.createElement(m.Review, {
    session: {
      run: {
        id: "run-1",
        mode: "path",
        deckId: "d-1",
        scope: [{ deckId: "d-1" }],
        complete: true,
        questions: 20,
        total: 20,
        answered: 20,
        correct: 16,
        entries: [],
      },
      entry: null,
      skippedIndices: [],
      actions: {},
    },
    data,
    shellTitle: "DP",
    links: {},
  })));
  assert.match(reviewHtml, /data-pace-meta="slice"/);
  assert.match(stripTags(reviewHtml), /这批还需约 \d+(?:\.\d+)? 个番茄/);
});
