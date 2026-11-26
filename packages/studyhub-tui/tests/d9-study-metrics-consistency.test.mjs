// #1354 D9 Single-Source Study Metrics Consistency Guardrail & Regression Suite:
// Verifies due, weak/wrong, new, mastered, mastery %, and course matching all derive from
// `src/selectors/study-metrics.ts` and stay 100% identical across TopBar, SideNav, LibraryView,
// TodayHub, DailyBriefing, RoundConfigModal, CommandPalette, DashboardView, CLI --stats, and CLI --due.
//
// node --test packages/studyhub-tui/tests/d9-study-metrics-consistency.test.mjs
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { Box, render } from 'ink';
import React from 'react';
import stripAnsi from 'strip-ansi';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const [
  { StudyService },
  { summarize },
  { studyMap, studyStats },
  { createTuiHost },
  shellData,
  { TopBar },
  { SideNav },
  { buildPaletteItems },
  { LibraryView },
  { buildTodayHubMetrics },
  { buildDailyBriefing },
  { DashboardView },
  { buildStatsSummary },
  { buildDueReport },
  storeMod,
] = await Promise.all([
  import('../../../lib/service.js'),
  import('../../../lib/mastery.js'),
  import('../../../lib/insights.js'),
  import('../src/host/tui-host.ts'),
  import('../src/shell/data.ts'),
  import('../src/shell/TopBar.tsx'),
  import('../src/shell/SideNav.tsx'),
  import('../src/shell/CommandPalette.tsx'),
  import('../src/views/library/LibraryView.tsx'),
  import('../src/views/library/today-hub.ts'),
  import('../src/views/library/daily-briefing.ts'),
  import('../src/views/dashboard/DashboardView.tsx'),
  import('../src/cli-args.ts'),
  import('../src/cli-commands.ts'),
  import('../src/state/store.ts'),
]);

const { dueToday, wrongCount, listCourses } = shellData;
const { useTuiStore, DEFAULT_PREFERENCES } = storeMod;

function makeAdversarialSnapshot() {
  return {
    revision: 12,
    focus: { course: 'OS' },
    today: { due: 42, weak: 33, reviewed: 3, goal: 20 },
    courses: [
      { id: 'c-os', name: 'OS', dueCount: 999, deckCount: 99 },
      { id: 'c-net', name: 'Networks', dueCount: 888, deckCount: 88 },
    ],
    decks: [
      {
        id: 'd-os-1',
        title: 'OS Scheduling',
        course: 'OS',
        count: 10,
        cardCount: 10,
        due: 9,
        dueCount: 9,
        wrong: 5,
        wrongCount: 5,
        newCount: 7,
      },
      {
        id: 'd-os-2',
        title: 'OS Virtual Memory',
        course: ' OS ', // deliberate surrounding whitespace
        count: 6,
        cardCount: 6,
        due: 4,
        dueCount: 4,
        wrong: 4,
        wrongCount: 4,
        newCount: 3,
      },
      {
        id: 'd-net-1',
        title: 'TCP Congestion',
        course: 'Networks',
        count: 6,
        cardCount: 6,
        due: 6,
        dueCount: 6,
        wrong: 7,
        wrongCount: 7,
        newCount: 2,
      },
      {
        id: 'd-slain',
        title: 'Slain Deck',
        course: 'OS',
        systemKind: 'slain',
        count: 50,
        cardCount: 50,
        due: 99,
        dueCount: 99,
        wrong: 88,
        wrongCount: 88,
      },
      {
        id: 'd-archived',
        title: 'Old OS',
        course: 'OS',
        archived: true,
        count: 30,
        cardCount: 30,
        due: 77,
        dueCount: 77,
        wrong: 66,
        wrongCount: 66,
      },
    ],
    progress: {
      'd-os-1': {
        total: 10,
        due: 2,
        mastery: 26,
        counts: { new: 6, weak: 1, learning: 1, familiar: 0, mastered: 2 },
      },
      'd-os-2': {
        total: 6,
        due: 1,
        mastery: 18,
        counts: { new: 3, weak: 2, learning: 0, familiar: 1, mastered: 0 },
      },
      'd-net-1': {
        total: 6,
        due: 4,
        mastery: 24,
        counts: { new: 2, weak: 3, learning: 0, familiar: 0, mastered: 1 },
      },
      'd-slain': {
        total: 50,
        due: 50,
        mastery: 100,
        counts: { new: 0, weak: 40, learning: 0, familiar: 0, mastered: 10 },
      },
    },
    sources: [],
    drafts: [],
    jobs: [],
    notes: [],
  };
}

function mountInk(element, { cols = 120, rows = 36 } = {}) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;

  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = cols;
  stdout.rows = rows;
  stdout.getColorDepth = () => 1;

  let latest = '';
  stdout.on('data', (chunk) => {
    const plain = stripAnsi(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    if (plain.trim()) latest = plain;
  });

  const inst = render(element, { stdout, stdin, interactive: true, exitOnCtrlC: false, patchConsole: false });
  return {
    frame: () => latest,
    write: (text) => stdin.write(text),
    async waitFor(pred, timeoutMs = 4000, label = 'frame') {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (pred(latest)) return latest;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`Timed out waiting for ${label}; last frame:\n${latest}`);
    },
    cleanup() {
      inst.unmount();
    },
  };
}

describe('#1354 D9 Single-Source Study Metrics Consistency', () => {
  test('1. All selectors, palette, courses, hub, briefing, and CLI agree on due & weak (excluding systemKind/archived and normalizing course)', () => {
    const snap = makeAdversarialSnapshot();

    // Focused course "OS": d-os-1 (due 2, weak 1) + d-os-2 " OS " (due 1, weak 2) => due 3, weak 3
    assert.equal(dueToday(snap, 'OS'), 3, 'dueToday(OS) must sum progress.due across trimmed course and exclude systemKind/archived');
    assert.equal(wrongCount(snap, 'OS'), 3, 'wrongCount(OS) must sum progress.counts.weak across trimmed course and exclude systemKind/archived');

    const hub = buildTodayHubMetrics({ snapshot: snap, course: 'OS', activeRunId: null });
    assert.equal(hub.due, 3, 'TodayHub due must equal dueToday(OS)');
    assert.equal(hub.wrong, 3, 'TodayHub wrong must equal wrongCount(OS)');

    const brief = buildDailyBriefing({ snapshot: snap, course: 'OS', lang: 'zh', now: new Date('2026-06-01T10:00:00Z') });
    assert.ok(brief?.reason.includes('共 3 题到期'), `DailyBriefing totalDue must be 3, got: ${brief?.reason}`);

    // Course list dueCount must come from active decks' progress.due (OS=3, Networks=4), NOT stale raw c.dueCount (999/888)
    const courses = listCourses(snap);
    const osCourse = courses.find((c) => c.key === 'OS');
    const netCourse = courses.find((c) => c.key === 'Networks');
    assert.equal(osCourse?.dueCount, 3, 'listCourses(OS).dueCount must match single-source due (3, not stale 999)');
    assert.equal(netCourse?.dueCount, 4, 'listCourses(Networks).dueCount must match single-source due (4, not stale 888)');

    // CommandPalette entity hints must show single-source due counts (OS=3, d-os-1=2, d-os-2=1)
    const paletteItems = buildPaletteItems(
      {
        ...useTuiStore.getState(),
        page: 'library',
        snapshot: snap,
        preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: true },
      },
      { refresh: async () => {}, loadSample: async () => {}, importSource: () => {}, openModelSettings: () => {}, setCourse: async () => {}, createCourse: async () => {}, quit: () => {} },
      [],
      { mode: 'embedded', call: async () => ({ ok: true, value: {} }), snapshot: async () => snap, getConfig: () => ({}), close: async () => {} },
    );
    const paletteOs = paletteItems.find((it) => it.id === 'course:OS');
    const paletteDeck1 = paletteItems.find((it) => it.id === 'deck:d-os-1');
    const paletteDeck2 = paletteItems.find((it) => it.id === 'deck:d-os-2');
    assert.equal(paletteOs?.hint, '3 待复习', 'CommandPalette course hint must show single-source due (3)');
    assert.ok(paletteDeck1?.hint?.includes('2 待复习'), `CommandPalette deck 1 hint must show progress.due=2, got: ${paletteDeck1?.hint}`);
    assert.ok(paletteDeck2?.hint?.includes('1 待复习'), `CommandPalette deck 2 hint must show progress.due=1, got: ${paletteDeck2?.hint}`);

    // Global (all active non-system courses): due = 2 + 1 + 4 = 7, weak = 1 + 2 + 3 = 6
    // Library-wide numbers count the system decks too (backend stats.totals / studyMap / wrongBook do): 7 + slain 50.
    assert.equal(dueToday(snap), 57, 'global dueToday must be 57 (system decks counted library-wide, archived excluded)');
    assert.equal(wrongCount(snap), 46, 'global wrongCount must be 46 (6 + slain 40; archived excluded)');

    const cliStats = buildStatsSummary({ libraryRoot: '/tmp/lib', snapshot: snap });
    assert.equal(cliStats.counts.due, 57, 'CLI --stats due must equal global dueToday (57)');
    assert.equal(cliStats.counts.weak, 46, 'CLI --stats weak must equal global wrongCount (46)');

    const cliDue = buildDueReport({ libraryRoot: '/tmp/lib', snapshot: snap });
    assert.equal(cliDue.totals.due, 57, 'CLI --due total due must equal global dueToday (57)');
    assert.equal(cliDue.totals.weak, 46, 'CLI --due total weak must equal global wrongCount (46)');
  });

  test('2. Zero-due & zero-weak active decks never leak stale snapshot.today.due / today.weak in TUI or CLI', () => {
    const zeroSnap = {
      today: { due: 12, weak: 8 },
      courses: [{ name: 'Math' }],
      decks: [
        { id: 'd1', title: 'Calculus', course: 'Math', count: 5, cardCount: 5, due: 5, wrong: 3 },
      ],
      progress: {
        d1: { total: 5, due: 0, mastery: 80, counts: { new: 1, weak: 0, learning: 0, familiar: 0, mastered: 4 } },
      },
      sources: [],
      notes: [],
      drafts: [],
    };

    assert.equal(dueToday(zeroSnap), 0, 'dueToday must stay 0 when progress.due is 0');
    assert.equal(wrongCount(zeroSnap), 0, 'wrongCount must stay 0 when progress.counts.weak is 0');

    const cliStats = buildStatsSummary({ libraryRoot: '/tmp/lib', snapshot: zeroSnap });
    assert.equal(cliStats.counts.due, 0, 'CLI --stats must NOT fall back to stale today.due when all active decks have progress.due=0');
    assert.equal(cliStats.counts.weak, 0, 'CLI --stats must NOT fall back to stale today.weak when all active decks have progress.counts.weak=0');

    const cliDue = buildDueReport({ libraryRoot: '/tmp/lib', snapshot: zeroSnap });
    assert.equal(cliDue.totals.due, 0);
    assert.equal(cliDue.totals.weak, 0);
  });

  test('3. Mastery % matches backend lib/mastery.js weighted summarize() formula even when progress.mastery is omitted', async () => {
    const selectors = await import('../src/selectors/study-metrics.ts');
    const items = [
      { card: {}, level: 'new' },
      { card: {}, level: 'weak' },
      { card: {}, level: 'learning' },
      { card: {}, level: 'learning' },
      { card: {}, level: 'familiar' },
      { card: {}, level: 'familiar' },
      { card: {}, level: 'mastered' },
    ];
    const backend = summarize(items, Date.now());
    // Backend weighted mastery: (0 + 0.15 + 0.90 + 1.50 + 1.00) / 7 = 51% (unweighted mastered/total would be 14%!)
    assert.equal(backend.mastery, 51);

    const snapWithoutMasteryField = {
      decks: [{ id: 'd-w', title: 'Weighted', course: 'CS', count: 7, cardCount: 7 }],
      progress: {
        'd-w': {
          total: 7,
          due: 2,
          counts: { ...backend.counts },
        },
      },
    };

    const deckM = selectors.selectDeckMetrics(snapWithoutMasteryField.decks[0], snapWithoutMasteryField.progress);
    const summaryM = selectors.selectStudySummary(snapWithoutMasteryField, 'CS');
    const cliDue = buildDueReport({ libraryRoot: '/tmp/lib', snapshot: snapWithoutMasteryField });

    assert.equal(deckM.mastery, backend.mastery, 'selectDeckMetrics must match lib/mastery.js weighted mastery (51%, not 14%)');
    assert.equal(summaryM.masteryPct, backend.mastery, 'selectStudySummary must match lib/mastery.js weighted mastery');
    assert.equal(cliDue.decks[0]?.mastery, backend.mastery, 'CLI --due mastery must match lib/mastery.js weighted mastery');
  });

  test('4. Same-screen Ink render: TopBar, SideNav, and LibraryView render identical course-scoped due & wrong counts', async (t) => {
    const prevState = useTuiStore.getState();
    const snap = makeAdversarialSnapshot();
    useTuiStore.setState({
      page: 'library',
      snapshot: snap,
      activeRunId: null,
      practiceStack: [],
      preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: true, proactiveHints: true },
      toasts: [],
    });
    t.after(() => useTuiStore.setState(prevState));

    const stubHost = {
      mode: 'embedded',
      call: async () => ({ ok: true, value: {} }),
      snapshot: async () => snap,
      getConfig: () => ({ effective: { ready: false } }),
      close: async () => {},
    };

    const h = mountInk(
      React.createElement(
        Box,
        { flexDirection: 'column', width: 120, height: 36 },
        React.createElement(TopBar, { width: 120 }),
        React.createElement(
          Box,
          { flexDirection: 'row', width: 120, height: 34 },
          React.createElement(SideNav, { width: 22, height: 34 }),
          React.createElement(LibraryView, { host: stubHost, width: 98, height: 34, isActive: false }),
        ),
      ),
      { cols: 120, rows: 36 },
    );
    t.after(() => h.cleanup());

    const frame = await h.waitFor((s) => s.includes('OS Scheduling') && s.includes('到期复习('), 5000, 'same-screen library render');
    assert.ok(frame.includes('今日 3'), `TopBar must show focused due=3, frame:\n${frame}`);
    assert.ok(frame.includes('到期复习(3)'), `LibraryView TodayHub must show due=3, frame:\n${frame}`);
    assert.ok(frame.includes('错题巩固(3)'), `LibraryView TodayHub must show weak=3, frame:\n${frame}`);
    // SideNav (left 22 cols, excluding TopBar row) Learning Library badge must show 3 (NOT 7) and WrongBook badge must show 3 (NOT 94 or 6)
    const bodyLines = frame.split('\n').slice(1);
    const navLibSlice = (bodyLines.find((line) => line.slice(0, 22).includes('学习库')) ?? '').slice(0, 22);
    const navWrongSlice = (bodyLines.find((line) => line.slice(0, 22).includes('错题本')) ?? '').slice(0, 22);
    assert.ok(/\b3\b/.test(navLibSlice) && !/\b7\b/.test(navLibSlice), `SideNav Library badge must match focused due=3, got: ${navLibSlice}`);
    assert.ok(/\b3\b/.test(navWrongSlice) && !/\b(6|94|104)\b/.test(navWrongSlice), `SideNav WrongBook badge must match focused weak=3, got: ${navWrongSlice}`);
  });

  test('5. Live Ink render: DashboardView excludes systemKind decks and matches focused course due & weak counts', async (t) => {
    const prevState = useTuiStore.getState();
    const snap = makeAdversarialSnapshot();
    useTuiStore.setState({
      page: 'dashboard',
      snapshot: snap,
      preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: true },
      toasts: [],
    });
    t.after(() => useTuiStore.setState(prevState));

    // Stub host where stats returns empty totals so Dashboard relies directly on snapshot selectors
    const stubHost = {
      mode: 'embedded',
      call: async (action) => {
        if (action === 'stats') return { ok: true, value: { heatmap: [], weakTopics: [], forecast: { days: [] } } };
        if (action === 'usage.summary') return { ok: true, value: { total: { calls: 0, inputTokens: 0, outputTokens: 0 } } };
        return { ok: true, value: {} };
      },
      snapshot: async () => snap,
      getConfig: () => ({ effective: { ready: false } }),
      close: async () => {},
    };

    const h = mountInk(
      React.createElement(DashboardView, { host: stubHost, width: 120, height: 34, isActive: false }),
      { cols: 120, rows: 34 },
    );
    t.after(() => h.cleanup());

    const frame = await h.waitFor((s) => s.includes('今日到期') && s.includes('总题数'), 5000, 'DashboardView render');
    assert.ok(frame.includes('2 个题组'), `Dashboard must count only 2 active non-system OS decks (excluding slain/archived), frame:\n${frame}`);
    assert.ok(frame.includes('薄弱 3 题'), `Dashboard must show focused weak=3 (not 0 or 43), frame:\n${frame}`);
    assert.ok(!frame.includes('Slain Deck'), 'Dashboard must not show slain system deck');
  });

  test('6. Real StudyService library: TUI and CLI numbers equal backend studyStats / studyMap, library-wide and per course (parked courses, sub-courses, system decks)', async (t) => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'studyhub-d9-real-'));
    t.after(() => rm(base, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 }));
    const libraryRoot = path.join(base, 'library');
    await mkdir(libraryRoot, { recursive: true });

    const past = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const future = new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString();
    const card = (id, extra = {}) => ({ id, kind: 'short_answer', topic: 'T', prompt: `Q-${id}`, answer: `A-${id}`, ...extra });
    const due = { review: { due_at: past, interval_days: 1, repetitions: 1 } };
    const later = { review: { due_at: future, interval_days: 30, repetitions: 3 } };

    const seed = new StudyService(libraryRoot, { complete: async () => '{}' });
    await seed.store.update((s) => {
      s.courses.push(
        { id: 'c-os', name: 'OS', active: true },
        { id: 'c-net', name: 'NET', active: true },
        // Parked course with an alias; its sub-course and the alias inherit the parking (lib/course-active.js).
        { id: 'c-old', name: 'OLD', active: false, aliases: ['Legacy'] },
        // A parked sub-course inside an active course.
        { id: 'c-net-arc', name: 'NET / Archive', active: false },
      );
      s.decks.push(
        { id: 'd-os', title: 'OS', course: 'OS', cards: [card('o1', due), card('o2', due), card('o3', later), card('o4', { suspended: true, ...due })] },
        { id: 'd-os-lab', title: 'OS Lab', course: 'OS / Lab', cards: [card('l1', due)] },
        { id: 'd-net', title: 'NET', course: 'NET', cards: [card('n1', due), card('n2')] },
        { id: 'd-net-arc', title: 'NET old', course: 'NET / Archive', cards: [card('na1', due)] },
        { id: 'd-old', title: 'OLD', course: 'OLD', cards: [card('x1', due), card('x2', due)] },
        { id: 'd-old-ch', title: 'OLD ch1', course: 'OLD / Ch1', cards: [card('y1', due)] },
        { id: 'd-legacy', title: 'Legacy', course: 'Legacy', cards: [card('g1', due)] },
        { id: 'd-arch', title: 'Arch', course: 'OS', archived: true, cards: [card('r1', due)] },
        { id: 'd-allsusp', title: 'All suspended', course: 'NET', cards: [card('e1', { suspended: true }), card('e2', { suspended: true })] },
        { id: 'd-coach', title: '为你定制', systemKind: 'coach', cards: [card('v0'), card('v1')] },
        { id: 'd-slain', title: 'Slain', course: 'OS', systemKind: 'slain', cards: [card('s1', due)] },
      );
      const attempt = (deckId, quizId, grade) => ({ id: `a-${quizId}`, deckId, quiz_id: quizId, grade, correct: grade >= 3, timestamp: past });
      s.attempts.push(
        attempt('d-os', 'o1', 1), attempt('d-os', 'o2', 4), attempt('d-os', 'o3', 5), attempt('d-os-lab', 'l1', 1),
        attempt('d-net', 'n1', 1), attempt('d-net-arc', 'na1', 1), attempt('d-old', 'x1', 1), attempt('d-old', 'x2', 4),
        attempt('d-old-ch', 'y1', 1), attempt('d-legacy', 'g1', 1), attempt('d-arch', 'r1', 1),
        attempt('d-coach', 'v0', 1), attempt('d-coach', 'v1', 1), attempt('d-slain', 's1', 1),
      );
    });
    const state = await seed.store.read();
    await seed.dispose?.();

    const host = await createTuiHost({
      libraryRoot,
      env: { DSH_HOME: path.join(base, 'dsh-home') },
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
    });
    t.after(() => host.dispose());
    const snapRes = await host.call('snapshot');
    assert.equal(snapRes.ok, true, `real snapshot should succeed: ${snapRes.error?.message}`);
    const snap = snapRes.value;
    const selectors = await import('../src/selectors/study-metrics.ts');

    const backend = (course) => {
      const { totals } = studyStats(state, course === null ? {} : { course });
      return { cards: totals.cards, due: totals.due, weak: totals.weak, mastered: totals.mastered };
    };
    const tui = (course) => {
      const s = selectors.selectStudySummary(snap, course);
      return { cards: s.totalCards, due: s.due, weak: s.weak, mastered: s.mastered };
    };
    const cliDue = (course) => {
      const r = buildDueReport({ libraryRoot, snapshot: snap, ...(course === null ? {} : { courseFilter: course }) }).totals;
      return { cards: r.totalCards, due: r.due, weak: r.weak };
    };
    const withoutMastered = ({ mastered, ...rest }) => rest;

    // Library-wide: parked courses (with their sub-courses and aliases) leave the numbers; system decks stay in.
    const all = backend(null);
    assert.ok(all.cards > 0 && all.due > 0 && all.weak > 0, `the fixture must give non-zero backend totals: ${JSON.stringify(all)}`);
    assert.deepEqual(tui(null), all, 'selectStudySummary(library) = studyStats(state).totals');
    assert.equal(dueToday(snap), all.due, 'dueToday (TopBar / SideNav / assistant, no course) = studyStats due');
    assert.equal(wrongCount(snap), all.weak, 'wrongCount (no course) = studyStats weak');
    const stats = buildStatsSummary({ libraryRoot, snapshot: snap }).counts;
    assert.deepEqual({ cards: stats.cards, due: stats.due, weak: stats.weak }, withoutMastered(all), 'CLI --stats = studyStats totals');
    assert.deepEqual(cliDue(null), withoutMastered(all), 'CLI --due = studyStats totals');
    const hub = buildTodayHubMetrics({ snapshot: snap, course: null, activeRunId: null });
    assert.deepEqual({ due: hub.due, weak: hub.wrong }, { due: all.due, weak: all.weak }, 'TodayHub (no course) = studyStats');
    const libraryMastery = studyMap(state).mastery.library;
    assert.equal(selectors.selectStudySummary(snap, null).masteryPct, libraryMastery.value, 'library mastery % = studyMap mastery.library');
    assert.equal(selectors.selectStudySummary(snap, null).totalCards, libraryMastery.cards);

    // Per course: a course holds its sub-courses (`OS / Lab`); an active course leaves out a parked sub-course;
    // a parked course chosen by name reads what it holds. System decks never count in a course.
    for (const course of ['OS', 'NET', 'OLD', 'OS / Lab']) {
      const want = backend(course);
      assert.deepEqual(tui(course), want, `selectStudySummary(${course}) = studyStats(state, { course: ${course} }).totals`);
      assert.equal(dueToday(snap, course), want.due, `dueToday(${course})`);
      assert.equal(wrongCount(snap, course), want.weak, `wrongCount(${course})`);
      const row = selectors.selectCourseMetrics(snap).find((c) => c.key === course);
      assert.deepEqual(
        { cards: row?.totalCards, due: row?.dueCount, weak: row?.weakCount, mastered: row?.masteredCount },
        want,
        `course picker row ${course} = studyStats(course)`,
      );
    }
    assert.deepEqual(cliDue('OS'), withoutMastered(backend('OS')), 'CLI --due --course OS holds OS / Lab, not the slain deck');
    assert.deepEqual(cliDue('OLD'), withoutMastered(backend('OLD')), 'CLI --due --course OLD reads the parked course it names');
    const focusMastery = studyMap({ ...state, focus: { ...(state.focus ?? {}), course: 'OS' } }).mastery.course;
    assert.equal(selectors.selectStudySummary(snap, 'OS').masteryPct, focusMastery.value, 'course mastery % = studyMap mastery.course');
  });
  test('7. Suspended cards: every screen weights mastery by the learnable cards the backend counts (11 cards, 2 learnable => 50%, not 91%)', async (t) => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'studyhub-d9-suspended-'));
    t.after(() => rm(base, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 }));
    const libraryRoot = path.join(base, 'library');
    await mkdir(libraryRoot, { recursive: true });

    const pastIso = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const futureIso = new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString();
    const card = (id, extra = {}) => ({ id, kind: 'short_answer', topic: 'T', prompt: `Q-${id}`, answer: `A-${id}`, ...extra });

    const seed = new StudyService(libraryRoot, { complete: async () => '{}' });
    await seed.store.update((s) => {
      s.courses.push({ id: 'c-os', name: 'OS' });
      s.decks.push(
        {
          // 10 cards in the inventory, 9 of them suspended: 1 learnable card, mastered (self-graded 5).
          id: 'd-big',
          title: 'Mostly Suspended',
          course: 'OS',
          cards: [
            card('b0', { review: { due_at: futureIso, interval_days: 30, repetitions: 3 } }),
            ...Array.from({ length: 9 }, (_, i) => card(`b${i + 1}`, { suspended: true })),
          ],
        },
        // 1 card, never studied: learnable and new (0%).
        { id: 'd-small', title: 'Fresh', course: 'OS', cards: [card('s0')] },
      );
      s.attempts.push({ id: 'a-b0', deckId: 'd-big', quiz_id: 'b0', grade: 5, correct: true, timestamp: pastIso });
    });
    const state = await seed.store.read();
    await seed.dispose?.();

    // Backend truth: lib/insights.js studyMap() card-weighted mastery over unsuspended cards.
    const backend = studyMap(state).mastery.library;
    assert.deepEqual(backend, { value: 50, cards: 2 }, 'backend counts 2 learnable cards at 50%');

    const host = await createTuiHost({
      libraryRoot,
      env: { DSH_HOME: path.join(base, 'dsh-home') },
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
    });
    t.after(() => host.dispose());

    const snapRes = await host.call('snapshot');
    assert.equal(snapRes.ok, true, `real snapshot should succeed: ${snapRes.error?.message}`);
    const snap = snapRes.value;
    // The real host keeps the inventory (`count`, incl. suspended) apart from the learnable `progress.total`.
    assert.equal(snap.decks.find((d) => d.id === 'd-big')?.count, 10);
    assert.equal(snap.progress['d-big']?.total, 1);

    const selectors = await import('../src/selectors/study-metrics.ts');
    const summary = selectors.selectStudySummary(snap, 'OS');
    assert.equal(summary.masteryPct, backend.value, 'selectStudySummary mastery % must equal the backend (50%, not 91%)');
    assert.equal(summary.totalCards, backend.cards, 'cards shown next to the % must be the learnable population');
    const course = selectors.selectCourseMetrics(snap).find((c) => c.key === 'OS');
    assert.equal(course?.masteryPct, backend.value, 'selectCourseMetrics mastery % must equal the backend');
    assert.equal(course?.totalCards, backend.cards);
    assert.equal(buildStatsSummary({ libraryRoot, snapshot: snap }).counts.cards, backend.cards, 'CLI --stats cards');
    const due = buildDueReport({ libraryRoot, snapshot: snap });
    assert.equal(due.totals.totalCards, backend.cards, 'CLI --due total cards');
    assert.equal(due.decks.find((d) => d.id === 'd-big')?.total, 1, 'CLI --due per-deck cards = learnable');

    // Fallback path (no backend progress): the deck row's learnable fields are used, never the raw inventory.
    const noProgress = { ...snap, progress: {} };
    const fallbackBig = selectors.selectDeckMetrics(noProgress.decks.find((d) => d.id === 'd-big'), {});
    assert.equal(fallbackBig.total, 1, 'without progress, total = the deck row unsuspended cards, not the inventory count');

    // Live screens: LibraryView KPI and DashboardView show the same % for the same library.
    const prevState = useTuiStore.getState();
    useTuiStore.setState({
      page: 'library',
      snapshot: { ...snap, focus: { ...(snap.focus ?? {}), course: 'OS' } },
      activeRunId: null,
      practiceStack: [],
      preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: true },
      toasts: [],
    });
    t.after(() => useTuiStore.setState(prevState));

    const lib = mountInk(React.createElement(LibraryView, { host, width: 120, height: 34, isActive: false }), { cols: 120, rows: 34 });
    const libFrame = await lib.waitFor((s) => s.includes('掌握度:'), 5000, 'LibraryView KPI');
    lib.cleanup();
    assert.match(libFrame, /掌握度:\s*50%/, `LibraryView KPI must show 50%, frame:\n${libFrame}`);

    const dash = mountInk(React.createElement(DashboardView, { host, width: 120, height: 34, isActive: false }), { cols: 120, rows: 34 });
    const dashFrame = await dash.waitFor((s) => s.includes('平均掌握度') || s.includes('掌握 '), 8000, 'DashboardView KPI');
    dash.cleanup();
    assert.ok(dashFrame.includes('50%'), `DashboardView must show 50%, frame:\n${dashFrame}`);
    assert.ok(!dashFrame.includes('91%'), `DashboardView must not show the inventory-weighted 91%, frame:\n${dashFrame}`);
  });

  test('8. Library-wide numbers count the system decks (为你定制, 斩题组) like the backend; a course view leaves them out', async (t) => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'studyhub-d9-coach-'));
    t.after(() => rm(base, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 }));
    const libraryRoot = path.join(base, 'library');
    await mkdir(libraryRoot, { recursive: true });

    const pastIso = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const futureIso = new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString();
    const card = (id, extra = {}) => ({ id, kind: 'short_answer', topic: 'T', prompt: `Q-${id}`, answer: `A-${id}`, ...extra });

    const seed = new StudyService(libraryRoot, { complete: async () => '{}' });
    await seed.store.update((s) => {
      s.courses.push({ id: 'c-os', name: 'OS' });
      s.decks.push(
        // One mastered card in a course deck.
        { id: 'd-os', title: 'OS basics', course: 'OS', cards: [card('o0', { review: { due_at: futureIso, interval_days: 30, repetitions: 3 } })] },
        // The coach deck (为你定制): two variant cards, both answered wrong.
        { id: 'd-coach', title: '为你定制', systemKind: 'coach', cards: [card('v0'), card('v1')] },
        // A slain deck filed under the course: the course view must still leave it out.
        { id: 'd-slain', title: '斩题组', course: 'OS', systemKind: 'slain', cards: [card('s0', { review: { due_at: pastIso, interval_days: 1, repetitions: 1 } })] },
      );
      s.attempts.push(
        { id: 'a-o0', deckId: 'd-os', quiz_id: 'o0', grade: 5, correct: true, timestamp: pastIso },
        { id: 'a-v0', deckId: 'd-coach', quiz_id: 'v0', grade: 1, correct: false, timestamp: pastIso },
        { id: 'a-v1', deckId: 'd-coach', quiz_id: 'v1', grade: 1, correct: false, timestamp: pastIso },
        { id: 'a-s0', deckId: 'd-slain', quiz_id: 's0', grade: 1, correct: false, timestamp: pastIso },
      );
    });
    const state = await seed.store.read();
    await seed.dispose?.();
    const library = studyStats(state).totals;
    const osOnly = studyStats(state, { course: 'OS' }).totals;
    const libraryMastery = studyMap(state).mastery.library;
    // The fixture is only useful while the backend itself tells the two scopes apart.
    assert.ok(library.weak > osOnly.weak && library.cards > osOnly.cards, `backend must count system decks library-wide only: ${JSON.stringify({ library, osOnly })}`);

    const host = await createTuiHost({
      libraryRoot,
      env: { DSH_HOME: path.join(base, 'dsh-home') },
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
    });
    t.after(() => host.dispose());
    const snapRes = await host.call('snapshot');
    assert.equal(snapRes.ok, true, `real snapshot should succeed: ${snapRes.error?.message}`);
    const snap = snapRes.value;

    const selectors = await import('../src/selectors/study-metrics.ts');
    const all = selectors.selectStudySummary(snap, null);
    assert.deepEqual(
      { cards: all.totalCards, due: all.due, weak: all.weak },
      { cards: library.cards, due: library.due, weak: library.weak },
      'library-wide numbers = studyStats(state).totals, system decks included',
    );
    assert.equal(all.masteryPct, libraryMastery.value, 'library-wide mastery % = studyMap mastery.library');
    assert.equal(wrongCount(snap), library.weak, 'SideNav / assistant wrongCount (no course) = studyStats weak');
    assert.equal(all.deckCount, 1, 'the deck list itself still shows learner decks only');

    const osView = selectors.selectStudySummary(snap, 'OS');
    assert.deepEqual(
      { cards: osView.totalCards, due: osView.due, weak: osView.weak },
      { cards: osOnly.cards, due: osOnly.due, weak: osOnly.weak },
      'a course view = studyStats(state, { course }).totals: the slain deck filed under OS is left out',
    );
  });

  test('9. With a focus course, the assistant read-only stats and the library deck list follow the course scope SideNav uses (sub-courses included)', async (t) => {
    const { AssistantPanel, _resetAssistantSessionMemory } = await import('../src/shell/AssistantPanel.tsx');
    const snap = {
      revision: 3,
      focus: { course: 'OS' },
      today: { due: 99, weak: 99 },
      courses: [
        { id: 'c-os', name: 'OS', active: true },
        { id: 'c-lab', name: 'OS / Lab', active: true },
        { id: 'c-net', name: 'NET', active: true },
      ],
      decks: [
        { id: 'd-os', title: 'OS Scheduling', course: 'OS', count: 3, available: 3 },
        { id: 'd-lab', title: 'OS Lab Shell', course: 'OS / Lab', count: 2, available: 2 },
        { id: 'd-net', title: 'TCP Congestion', course: 'NET', count: 6, available: 6 },
      ],
      progress: {
        'd-os': { total: 3, due: 2, mastery: 20, counts: { new: 1, weak: 1, learning: 1, familiar: 0, mastered: 0 } },
        'd-lab': { total: 2, due: 1, mastery: 10, counts: { new: 1, weak: 1, learning: 0, familiar: 0, mastered: 0 } },
        'd-net': { total: 6, due: 4, mastery: 30, counts: { new: 2, weak: 3, learning: 0, familiar: 0, mastered: 1 } },
      },
      sources: [],
      drafts: [],
      jobs: [],
      notes: [],
    };
    // OS holds OS / Lab (due 2 + 1, weak 1 + 1); the whole library also holds NET (due 7, weak 5).
    assert.equal(dueToday(snap, 'OS'), 3);
    assert.equal(wrongCount(snap, 'OS'), 2);
    assert.equal(dueToday(snap), 7);

    const prevState = useTuiStore.getState();
    t.after(() => useTuiStore.setState(prevState));
    const stubHost = {
      mode: 'embedded',
      call: async () => ({ ok: true, value: {} }),
      snapshot: async () => snap,
      getConfig: () => ({ effective: { ready: false } }),
      close: async () => {},
    };

    _resetAssistantSessionMemory();
    useTuiStore.setState({
      page: 'library',
      snapshot: snap,
      activeRunId: null,
      practiceStack: [],
      assistantOpen: true,
      assistantFocused: true,
      assistantTab: 'assistant',
      assistantStage: 'question',
      assistantFullscreen: false,
      assistantCardContext: null,
      inputCaptured: false,
      preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: true },
      toasts: [],
    });
    const panel = mountInk(
      React.createElement(Box, { width: 110, height: 34 }, React.createElement(AssistantPanel, { host: stubHost, isActive: true, width: 110, height: 34, docked: true, onClose: () => {} })),
      { cols: 110, rows: 34 },
    );
    try {
      await panel.waitFor((s) => s.includes('AI 助手'), 5000, 'assistant panel');
      panel.write('i');
      await new Promise((r) => setTimeout(r, 40));
      panel.write('今天有多少题到期');
      await new Promise((r) => setTimeout(r, 50));
      panel.write('\r');
      const frame = await panel.waitFor((s) => s.includes('今日到期'), 5000, 'assistant read-only stats');
      assert.match(frame, /今日到期\s*3\s*题/, `assistant due must be the focus course's 3, frame:\n${frame}`);
      assert.match(frame, /待巩固错题\s*2\s*题/, `assistant weak must be the focus course's 2, frame:\n${frame}`);
    } finally {
      panel.cleanup();
    }

    const lib = mountInk(React.createElement(LibraryView, { host: stubHost, width: 120, height: 34, isActive: false }), { cols: 120, rows: 34 });
    t.after(() => lib.cleanup());
    const libFrame = await lib.waitFor((s) => s.includes('OS Scheduling'), 5000, 'library deck list');
    assert.ok(libFrame.includes('OS Lab Shell'), `the OS deck list must hold the OS / Lab deck, frame:\n${libFrame}`);
    assert.ok(!libFrame.includes('TCP Congestion'), `the OS deck list must not hold NET decks, frame:\n${libFrame}`);
  });

  test('10. The daily briefing never pushes a parked course: it ranks and totals the decks the scope counts', () => {
    const snap = {
      courses: [
        { id: 'c-os', name: 'OS', active: true },
        { id: 'c-old', name: 'OLD', active: false },
        { id: 'c-os-old', name: 'OS / Old', active: false },
      ],
      decks: [
        { id: 'd-os', title: 'OS Scheduling', course: 'OS', count: 3, available: 3 },
        // The backend marks these decks `inactive` (lib/course-active.js): a parked course, and a parked sub-course of OS.
        { id: 'd-old', title: 'Old Course', course: 'OLD', inactive: true, count: 9, available: 9 },
        { id: 'd-os-old', title: 'OS Old Chapter', course: 'OS / Old', inactive: true, count: 9, available: 9 },
      ],
      progress: {
        'd-os': { total: 3, due: 2, mastery: 20, counts: { new: 1, weak: 1, learning: 1, familiar: 0, mastered: 0 } },
        'd-old': { total: 9, due: 9, mastery: 0, counts: { new: 0, weak: 9, learning: 0, familiar: 0, mastered: 0 } },
        'd-os-old': { total: 9, due: 8, mastery: 0, counts: { new: 0, weak: 9, learning: 0, familiar: 0, mastered: 0 } },
      },
    };
    const now = new Date('2026-06-01T10:00:00Z');
    for (const course of [null, 'OS']) {
      assert.equal(dueToday(snap, course), 2, `dueToday(${course}) leaves the parked decks out`);
      const brief = buildDailyBriefing({ snapshot: snap, course, lang: 'zh', now });
      assert.deepEqual(brief?.target, { kind: 'deck', deckId: 'd-os', deckTitle: 'OS Scheduling' }, `briefing (${course}) must not push a parked deck`);
      assert.ok(!brief?.reason.includes('共'), `briefing (${course}) totals only the counted decks (2 due, one deck), got: ${brief?.reason}`);
    }
  });
});
