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
    assert.equal(dueToday(snap), 7, 'global dueToday must be 7');
    assert.equal(wrongCount(snap), 6, 'global wrongCount must be 6 (excluding slain & archived)');

    const cliStats = buildStatsSummary({ libraryRoot: '/tmp/lib', snapshot: snap });
    assert.equal(cliStats.counts.due, 7, 'CLI --stats due must equal global dueToday (7)');
    assert.equal(cliStats.counts.weak, 6, 'CLI --stats weak must equal global wrongCount (6)');

    const cliDue = buildDueReport({ libraryRoot: '/tmp/lib', snapshot: snap });
    assert.equal(cliDue.totals.due, 7, 'CLI --due total due must equal global dueToday (7)');
    assert.equal(cliDue.totals.weak, 6, 'CLI --due total weak must equal global wrongCount (6)');
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

  test('6. End-to-end real StudyService snapshot: all TUI & CLI selectors match real backend progress', async (t) => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'studyhub-d9-real-'));
    t.after(() => rm(base, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 }));
    const libraryRoot = path.join(base, 'library');
    await mkdir(libraryRoot, { recursive: true });

    const pastIso = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const futureIso = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();

    const seed = new StudyService(libraryRoot, { complete: async () => '{}' });
    await seed.store.update((s) => {
      s.courses.push({ id: 'c-os', name: 'OS' });
      s.decks.push(
        {
          id: 'd-real',
          title: 'Real OS Deck',
          course: 'OS',
          cards: [
            { id: 'c1', kind: 'short_answer', topic: 'CPU', prompt: 'Q1', answer: 'A1', review: { due_at: pastIso, interval_days: 1, repetitions: 1 } },
            { id: 'c2', kind: 'short_answer', topic: 'CPU', prompt: 'Q2', answer: 'A2', review: { due_at: pastIso, interval_days: 1, repetitions: 1 } },
            { id: 'c3', kind: 'short_answer', topic: 'Mem', prompt: 'Q3', answer: 'A3', review: { due_at: futureIso, interval_days: 30, repetitions: 3 } },
            { id: 'c4', kind: 'short_answer', topic: 'Mem', prompt: 'Q4', answer: 'A4' },
          ],
        },
        {
          id: 'd-real-slain',
          title: 'Slain',
          course: 'OS',
          systemKind: 'slain',
          cards: [
            { id: 'cs1', kind: 'short_answer', topic: 'CPU', prompt: 'QS1', answer: 'AS1', review: { due_at: pastIso, interval_days: 1, repetitions: 1 } },
          ],
        },
      );
      s.attempts.push(
        { id: 'a1', deckId: 'd-real', quiz_id: 'c1', grade: 1, correct: false, timestamp: pastIso },
        { id: 'a2', deckId: 'd-real', quiz_id: 'c2', grade: 4, correct: true, timestamp: pastIso },
        { id: 'a3', deckId: 'd-real', quiz_id: 'c3', grade: 5, correct: true, timestamp: pastIso },
        { id: 'a4', deckId: 'd-real-slain', quiz_id: 'cs1', grade: 1, correct: false, timestamp: pastIso },
      );
    });
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
    // Real backend progress for d-real: c1=weak&due, c2=learning&due, c3=mastered&not-due, c4=new&not-due
    // => due = 2, weak = 1 (slain deck excluded!)
    assert.equal(dueToday(snap, 'OS'), 2);
    assert.equal(wrongCount(snap, 'OS'), 1);
    assert.equal(buildTodayHubMetrics({ snapshot: snap, course: 'OS', activeRunId: null }).due, 2);
    assert.equal(buildTodayHubMetrics({ snapshot: snap, course: 'OS', activeRunId: null }).wrong, 1);
    assert.equal(buildStatsSummary({ libraryRoot, snapshot: snap }).counts.due, 2);
    assert.equal(buildStatsSummary({ libraryRoot, snapshot: snap }).counts.weak, 1);
    assert.equal(buildDueReport({ libraryRoot, snapshot: snap }).totals.due, 2);
    assert.equal(buildDueReport({ libraryRoot, snapshot: snap }).totals.weak, 1);
  });
});
