// Consolidated Dashboard Domain Suite
// Merges: round42-dashboard-map, round45-study-graph, round66-dashboard-export, round74-dashboard-filter
// node --test tests/domain-dashboard.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { render } from 'ink';
import React from 'react';
import {
  cloneSampleLibrary,
  createTempTracker,
  createVirtualTty,
  disposeTerminalPool,
  distDir,
  findExportedBackupFile,
  loadDistRuntime,
  pkgRoot,
  sanitizedTestEnv,
} from './helpers/virtual-tty.mjs';

const { StudyHubTuiApp, createTuiHost, saveTuiPreferences } = await loadDistRuntime();
assert.ok(StudyHubTuiApp, 'dist/ must export StudyHubTuiApp');
assert.ok(createTuiHost, 'dist/ must export createTuiHost');
assert.ok(saveTuiPreferences, 'dist/ must export saveTuiPreferences');

const storeFile = (await readdir(distDir)).find((f) => f.startsWith('store-') && f.endsWith('.mjs'));
assert.ok(storeFile, 'dist/ must include store-*.mjs');
const { useTuiStore: useDistTuiStore, DEFAULT_PREFERENCES } = await import(
  pathToFileURL(join(distDir, storeFile)).href
);
assert.ok(useDistTuiStore, 'dist/store-*.mjs must export useTuiStore');
assert.ok(DEFAULT_PREFERENCES, 'dist/store-*.mjs must export DEFAULT_PREFERENCES');

const PREV_DSH_HOME = process.env.DSH_HOME;
const ORIGINAL_FETCH = globalThis.fetch;
const temps = createTempTracker('studyhub-tui-dashboard-');

// Bundle pure DashboardView helpers from TypeScript source for unit tests
const dashBundleDir = await temps.make('dashboard-unit');
const dashBundleFile = join(dashBundleDir, 'dashboard-helpers.mjs');
await build({
  stdin: {
    contents: `export { formatDashboardMarkdownReport, filterDashboardDrillItems } from './src/views/dashboard/DashboardView.tsx';`,
    resolveDir: pkgRoot,
    loader: 'ts',
  },
  outfile: dashBundleFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  logLevel: 'silent',
  absWorkingDir: pkgRoot,
});
fs.symlinkSync(join(pkgRoot, 'node_modules'), join(dashBundleDir, 'node_modules'), 'junction');
const { formatDashboardMarkdownReport, filterDashboardDrillItems } = await import(
  pathToFileURL(dashBundleFile).href
);
assert.equal(typeof formatDashboardMarkdownReport, 'function', 'DashboardView must export formatDashboardMarkdownReport');
assert.equal(typeof filterDashboardDrillItems, 'function', 'DashboardView must export filterDashboardDrillItems');

function resetDistStore(language = 'zh', asciiMode = false, extra = {}) {
  useDistTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    snapshot: null,
    binding: null,
    config: null,
    desktopConfig: null,
    loading: false,
    refreshing: false,
    toasts: [],
    footerHints: [],
    commandPaletteOpen: false,
    helpOpen: false,
    coursePickerOpen: false,
    inboxOpen: false,
    voicePackOpen: false,
    showLaunchpad: false,
    inputCaptured: false,
    activeRunId: null,
    preferences: {
      ...DEFAULT_PREFERENCES,
      recentCommands: [...(DEFAULT_PREFERENCES.recentCommands ?? [])],
      language,
      asciiMode,
    },
    ...extra,
  });
}

after(async () => {
  globalThis.fetch = ORIGINAL_FETCH;
  resetDistStore('zh', false);
  disposeTerminalPool();
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await temps.cleanup();
});

function fakeDiscovery() {
  const result = () => [
    { id: 'agy', supported: true, status: 'not-installed', executablePath: null, version: null, reasonCode: 'not-installed', reason: '' },
    { id: 'claude', supported: false, status: 'coming-soon', executablePath: null, version: null, reasonCode: 'coming-soon-not-installed', reason: '' },
    { id: 'codex', supported: true, status: 'not-installed', executablePath: null, version: null, reasonCode: 'not-installed', reason: '' },
  ];
  return {
    async scan() {
      return result();
    },
    getCached: () => result(),
    findReadyPath: () => '',
    findReadyAgyPath: () => '',
    findReadyCodexPath: () => '',
  };
}

function todayLocalYmd() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function seedSampleAndExtraDeck(host) {
  const sampleRes = await host.call('sample.status', {});
  assert.equal(sampleRes.ok, true, `sample.status failed: ${sampleRes.error?.message}`);
  assert.equal(sampleRes.value?.loaded, true, 'sample library must be pre-seeded via cloneSampleLibrary');

  const deckRes = await host.call('deck.import', {
    text: JSON.stringify({
      title: 'Operating Systems Core',
      course: 'Operating Systems',
      cards: [
        {
          kind: 'flashcard',
          prompt: 'What is a page fault in virtual memory?',
          answer: 'A trap triggered when accessing a page not currently mapped in physical RAM.',
          topic: 'Virtual Memory',
        },
        {
          kind: 'flashcard',
          prompt: 'Which scheduling algorithm can cause starvation?',
          answer: 'Shortest Job First (SJF) can starve long jobs when short jobs keep arriving.',
          topic: 'CPU Scheduling',
        },
      ],
    }),
    folder: 'Operating Systems',
  });
  assert.equal(deckRes.ok, true, `deck.import failed: ${deckRes.error?.message}`);
  assert.equal(deckRes.value?.failed, 0, `deck.import had failures: ${JSON.stringify(deckRes.value?.results)}`);
  await host.refreshSnapshot();
}

async function seedSampleAndLinkedCards(host) {
  const sampleRes = await host.call('sample.status', {});
  assert.equal(sampleRes.ok, true, `sample.status failed: ${sampleRes.error?.message}`);
  assert.equal(sampleRes.value?.loaded, true, 'sample library must be pre-seeded via cloneSampleLibrary');

  const deckRes = await host.call('deck.import', {
    text: JSON.stringify({
      title: 'Operating Systems Core',
      course: 'Operating Systems',
      cards: [
        {
          kind: 'flashcard',
          prompt: 'Virtual Memory Paging',
          answer: 'Maps virtual pages to physical frames via page tables.',
          topic: 'Memory',
        },
        {
          kind: 'flashcard',
          prompt: 'TLB Shootdown',
          answer: 'Invalidates stale TLB entries across cores after page table updates.',
          topic: 'Caching',
        },
      ],
    }),
    folder: 'Operating Systems',
  });
  assert.equal(deckRes.ok, true, `deck.import failed: ${deckRes.error?.message}`);
  assert.equal(deckRes.value?.failed, 0, `deck.import had failures: ${JSON.stringify(deckRes.value?.results)}`);

  const deckId = deckRes.value?.results?.[0]?.deckId;
  assert.ok(deckId, 'deck.import must return deckId');
  const getRes = await host.call('deck.get', { id: deckId });
  assert.equal(getRes.ok, true, `deck.get failed: ${getRes.error?.message}`);
  const cards = getRes.value?.cards ?? [];
  assert.equal(cards.length, 2, 'imported deck must have 2 cards');
  const prereqCard = cards.find((c) => c.prompt.includes('Virtual Memory Paging'));
  const depCard = cards.find((c) => c.prompt.includes('TLB Shootdown'));
  assert.ok(prereqCard && depCard, 'both seeded cards must exist');

  const linkRes = await host.call('card.link', {
    deckId,
    cardId: depCard.id,
    requires: { deckId, cardId: prereqCard.id },
  });
  assert.equal(linkRes.ok, true, `card.link failed: ${linkRes.error?.message}`);
  assert.equal(linkRes.value?.linked, true, 'card.link must return linked=true');

  await host.refreshSnapshot();
  return { deckId, prereqCardId: prereqCard.id, depCardId: depCard.id };
}

async function seedCourseCards(host, { title, course, cards }) {
  const courseRes = await host.call('course.save', { name: course });
  assert.equal(courseRes.ok, true, `course.save(${course}) failed: ${courseRes.error?.message || ''}`);

  const importRes = await host.call('deck.import', {
    text: JSON.stringify({
      title,
      course,
      cards: cards.map((c) => ({
        kind: 'flashcard',
        prompt: c.prompt,
        answer: c.answer,
        topic: c.topic,
      })),
    }),
    folder: course,
  });
  assert.equal(importRes.ok, true, `deck.import failed: ${importRes.error?.message || ''}`);
  assert.equal(importRes.value?.failed, 0, `deck.import had failures: ${JSON.stringify(importRes.value?.results)}`);

  const deckId = importRes.value?.results?.[0]?.deckId;
  assert.ok(deckId, 'deck.import must return deckId');

  const deckGet = await host.call('deck.get', { id: deckId });
  assert.equal(deckGet.ok, true, `deck.get failed: ${deckGet.error?.message || ''}`);
  const importedCards = deckGet.value?.cards ?? [];

  for (const spec of cards) {
    const failCount = spec.failCount ?? 0;
    if (failCount <= 0) continue;
    const card = importedCards.find((c) => c.topic === spec.topic);
    assert.ok(card?.id, `imported deck must contain card for topic ${spec.topic}`);

    for (let i = 0; i < failCount; i += 1) {
      const startRes = await host.call('review.start', {
        mode: 'path',
        scope: [{ deckId, cardId: card.id }],
        fresh: true,
      });
      assert.equal(startRes.ok, true, `review.start failed: ${startRes.error?.message || ''}`);
      const run = startRes.value;
      assert.ok(run?.id, 'review.start must return run id');

      const revRes = await host.call('review.reveal', { runId: run.id, cardId: card.id });
      assert.equal(revRes.ok, true, `review.reveal failed: ${revRes.error?.message || ''}`);

      const ansRes = await host.call('review.answer', { runId: run.id, cardId: card.id, grade: 1 });
      assert.equal(ansRes.ok, true, `review.answer(grade=1) failed: ${ansRes.error?.message || ''}`);
    }
  }

  return { deckId };
}

describe('Round 42: Dashboard Knowledge Mastery Map', () => {
  test('1) createTuiHost integration: map {} returns expected today, next, mastery, and decks/topics structure', async () => {
    const base = await temps.make('r42-host');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
    const libraryRoot = join(base, 'library');
    await cloneSampleLibrary('en', libraryRoot);
    const host = await createTuiHost({
      env,
      home: join(base, 'home'),
      libraryRoot,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
    });

    try {
      await seedSampleAndExtraDeck(host);

      const mapRes = await host.call('map', {});
      assert.equal(mapRes.ok, true, `map {} failed: ${mapRes.error?.message}`);
      const m = mapRes.value;
      assert.ok(m && typeof m === 'object', 'map result must be an object');
      assert.ok(m.today && typeof m.today === 'object', 'map.today must exist');
      assert.ok(m.mastery && typeof m.mastery === 'object', 'map.mastery must exist');
      assert.ok(m.mastery.library && typeof m.mastery.library.value === 'number', 'map.mastery.library.value must be numeric');
      assert.ok(m.mastery.library.cards > 0, 'map.mastery.library.cards must be > 0');
      assert.ok(Array.isArray(m.decks) && m.decks.length >= 2, 'map.decks must include sample + seeded decks');

      const osDeck = m.decks.find((d) => d.title === 'Operating Systems Core');
      assert.ok(osDeck, 'Operating Systems Core deck should appear in map.decks');
      assert.equal(osDeck.total, 2);
      assert.equal(typeof osDeck.mastery, 'number');
      assert.equal(typeof osDeck.due, 'number');
      assert.ok(osDeck.counts && typeof osDeck.counts.new === 'number');
      assert.ok(Array.isArray(osDeck.topics) && osDeck.topics.length === 2, 'osDeck.topics must have 2 topics');
      assert.deepEqual(
        osDeck.topics.map((tp) => tp.name),
        ['Virtual Memory', 'CPU Scheduling'],
      );
      for (const tp of osDeck.topics) {
        assert.equal(tp.total, 1);
        assert.equal(typeof tp.mastery, 'number');
        assert.equal(typeof tp.due, 'number');
        assert.ok(['todo', 'active', 'done'].includes(tp.status));
      }
      assert.ok(m.next && typeof m.next.topic === 'string', 'map.next should recommend next topic');
    } finally {
      await host.dispose();
    }
  });

  test('2) E2E UI (zh, 120x36 & 80x24): DashboardView [m] opens StudyMapModal, filters with [/], Esc clears filter, and Enter launches practice', async () => {
    const base = await temps.make('r42-ui-zh');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
    process.env.DSH_HOME = env.DSH_HOME;

    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
    const libraryRoot = join(base, 'library');
    await cloneSampleLibrary('zh', libraryRoot);
    const host = await createTuiHost({
      env,
      home: join(base, 'home'),
      libraryRoot,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
    });
    await seedSampleAndExtraDeck(host);

    const tty = createVirtualTty(120, 36);
    resetDistStore('zh', false);
    const app = render(React.createElement(StudyHubTuiApp, { host }), {
      stdout: tty.stdout,
      stdin: tty.stdin,
      stderr: tty.stderr,
      interactive: true,
      exitOnCtrlC: false,
      patchConsole: false,
    });

    try {
      await tty.waitFor((s) => s.includes('Memento'), { timeoutMs: 10_000, label: 'Initial view loaded' });

      // Navigate to DashboardView ('6')
      tty.send('6');
      const dashScreen = await tty.waitFor(
        (s) => s.includes('学习统计与掌握度') && s.includes('知识地图'),
        { timeoutMs: 8_000, label: 'DashboardView rendered with [m] Map hint' },
      );
      tty.assertHealthyScreen(dashScreen, 120, 36, 'DashboardView zh 120x36');

      // Open lazy StudyMapModal ('m')
      tty.send('m');
      const mapScreen = await tty.waitFor(
        (s) => s.includes('知识掌握地图') && s.includes('Operating Systems Core') && s.includes('Virtual Memory'),
        { timeoutMs: 8_000, label: 'StudyMapModal opened and loaded (zh)' },
      );
      tty.assertHealthyScreen(mapScreen, 120, 36, 'StudyMapModal zh 120x36');

      // Navigate down & filter with '/', then verify 80x24 narrow layout & Esc clearing filter before Esc closing modal
      tty.send('j');
      await tty.flush();
      tty.send('/');
      await tty.waitFor((s) => s.includes('筛选:'), { timeoutMs: 5_000, label: 'Filter input opened' });
      tty.send('CPU Scheduling');
      await tty.waitFor((s) => s.includes('CPU Scheduling') && !s.includes('Virtual Memory'), {
        timeoutMs: 5_000,
        label: 'Filter narrowed rows to CPU Scheduling',
      });

      tty.resize(80, 24);
      const narrowFiltered = await tty.waitFor(
        (s) => s.includes('CPU Scheduling') && !s.includes('Virtual Memory') && s.split('\n').length <= 24,
        { timeoutMs: 5_000, label: 'StudyMapModal filtered at 80x24 (zh)' },
      );
      tty.assertHealthyScreen(narrowFiltered, 80, 24, 'StudyMapModal filtered zh 80x24');

      // First Esc inside filter input clears filter & returns to list focus; second Esc closes StudyMapModal
      tty.send('\x1b');
      await tty.waitFor((s) => s.includes('Virtual Memory') && s.includes('CPU Scheduling'), {
        timeoutMs: 5_000,
        label: 'Filter cleared on Esc at 80x24',
      });
      tty.send('\x1b');
      const closedScreen = await tty.waitFor(
        (s) => !s.includes('知识掌握地图') && s.includes('学习统计与掌握度'),
        { timeoutMs: 8_000, label: 'StudyMapModal closed on Esc (zh 80x24)' },
      );
      tty.assertHealthyScreen(closedScreen, 80, 24, 'DashboardView after Esc zh 80x24');

      // Resize back to 120x36, re-open StudyMapModal, filter to Virtual Memory, Enter to apply, and Enter to start practice in ReviewView
      tty.resize(120, 36);
      tty.send('m');
      await tty.waitFor((s) => s.includes('知识掌握地图') && s.includes('Virtual Memory'), {
        timeoutMs: 8_000,
        label: 'StudyMapModal reopened',
      });
      tty.send('/');
      await tty.waitFor((s) => s.includes('筛选:'), { timeoutMs: 5_000, label: 'Filter input reopened' });
      tty.send('Virtual Memory');
      await tty.waitFor((s) => s.includes('Virtual Memory') && !s.includes('CPU Scheduling'), {
        timeoutMs: 5_000,
        label: 'Filtered to Virtual Memory',
      });
      tty.send('\r');
      await tty.waitFor((s) => s.includes('Enter 练习') && !s.includes('应用筛选'), {
        timeoutMs: 5_000,
        label: 'Returned to list focus after filter Enter',
      });
      // Move selection to Virtual Memory topic row (row 0=Course, 1=Deck, 2=Topic) and launch practice
      tty.send('j');
      await tty.flush();
      tty.send('j');
      await tty.flush();
      tty.send('\r');
      const reviewScreen = await tty.waitFor(
        (s) => useDistTuiStore.getState().page === 'review' && (s.includes('page fault') || s.includes('Virtual Memory')),
        { timeoutMs: 8_000, label: 'Practice launched into ReviewView from StudyMapModal' },
      );
      tty.assertHealthyScreen(reviewScreen, 120, 36, 'ReviewView launched from StudyMapModal zh');
      assert.equal(useDistTuiStore.getState().page, 'review');
    } finally {
      app.unmount();
      tty.dispose();
      await host.dispose();
    }
  });
});

describe('Round 45: StudyMapModal Tab 2 Prerequisite & Topic Dependency Graph', () => {
  test('1) createTuiHost integration: sample.status + card.link + graph {} returns nodes & prerequisite edge', async () => {
    const base = await temps.make('r45-host');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
    const libraryRoot = join(base, 'library');
    await cloneSampleLibrary('en', libraryRoot);
    const host = await createTuiHost({
      env,
      home: join(base, 'home'),
      libraryRoot,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
    });

    try {
      const { deckId, prereqCardId, depCardId } = await seedSampleAndLinkedCards(host);

      const graphRes = await host.call('graph', {});
      assert.equal(graphRes.ok, true, `graph {} failed: ${graphRes.error?.message}`);
      const g = graphRes.value;
      assert.ok(g && typeof g === 'object', 'graph result must be an object');
      assert.equal(g.mode, 'structure');
      assert.ok(Array.isArray(g.nodes) && g.nodes.length > 0, 'graph.nodes must be non-empty');
      assert.ok(Array.isArray(g.edges) && g.edges.length > 0, 'graph.edges must be non-empty');

      const expectedPreId = `card:${JSON.stringify([deckId, prereqCardId])}`;
      const expectedDepId = `card:${JSON.stringify([deckId, depCardId])}`;

      const deckNode = g.nodes.find((n) => n.id === `deck:${deckId}` && n.kind === 'deck');
      const preNode = g.nodes.find((n) => n.id === expectedPreId && n.kind === 'card');
      const depNode = g.nodes.find((n) => n.id === expectedDepId && n.kind === 'card');
      assert.ok(deckNode, 'Operating Systems Core deck node must exist in graph.nodes');
      assert.ok(preNode, 'prerequisite card node must exist in graph.nodes');
      assert.ok(depNode, 'dependent card node must exist in graph.nodes');

      const prereqEdge = g.edges.find(
        (e) => e.type === 'prereq' && e.from === expectedDepId && e.to === expectedPreId,
      );
      assert.ok(prereqEdge, 'graph.edges must include prereq edge from dependent card to prerequisite card');
    } finally {
      await host.dispose();
    }
  });

  test('2) E2E UI (zh, 120x36 & 80x24): DashboardView [m] -> Tab 2 renders Prerequisite Graph, filters, refreshes, launches practice, closes on Esc', async () => {
    const base = await temps.make('r45-ui-zh');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
    process.env.DSH_HOME = env.DSH_HOME;

    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
    const libraryRoot = join(base, 'library');
    await cloneSampleLibrary('zh', libraryRoot);
    const host = await createTuiHost({
      env,
      home: join(base, 'home'),
      libraryRoot,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
    });
    await seedSampleAndLinkedCards(host);

    const tty = createVirtualTty(120, 36);
    resetDistStore('zh', false);
    const app = render(React.createElement(StudyHubTuiApp, { host }), {
      stdout: tty.stdout,
      stdin: tty.stdin,
      stderr: tty.stderr,
      interactive: true,
      exitOnCtrlC: false,
      patchConsole: false,
    });

    try {
      await tty.waitFor((s) => s.includes('Memento'), { timeoutMs: 10_000, label: 'Initial view loaded' });

      // Navigate to DashboardView ('6')
      tty.send('6');
      await tty.waitFor(
        (s) => s.includes('学习统计与掌握度') && s.includes('知识地图'),
        { timeoutMs: 8_000, label: 'DashboardView rendered' },
      );

      // Open StudyMapModal ('m') - Tab 1 active by default
      tty.send('m');
      const tab1Screen = await tty.waitFor(
        (s) => s.includes('知识掌握地图') && s.includes('1:知识地图') && s.includes('2:前置依赖图'),
        { timeoutMs: 8_000, label: 'StudyMapModal opened on Tab 1 (zh)' },
      );
      tty.assertHealthyScreen(tab1Screen, 120, 36, 'StudyMapModal Tab 1 zh 120x36');

      // Switch to Tab 2 via '2'
      tty.send('2');
      const tab2Screen = await tty.waitFor(
        (s) =>
          s.includes('条前置边') &&
          s.includes('→') &&
          s.includes('Virtual Memory Paging') &&
          s.includes('TLB Shootdown'),
        { timeoutMs: 8_000, label: 'Tab 2 Prerequisite Graph loaded (zh)' },
      );
      tty.assertHealthyScreen(tab2Screen, 120, 36, 'StudyMapModal Tab 2 zh 120x36');

      // Refresh with 'r' and wait for reload cycle to settle before sending '/'
      tty.send('r');
      await tty.waitFor((s) => s.includes('正在加载依赖图谱'), { timeoutMs: 1_500, label: 'Tab 2 spinner on reload' }).catch(() => {});
      await tty.waitFor(
        (s) => !s.includes('正在加载依赖图谱') && s.includes('条前置边') && s.includes('Virtual Memory Paging'),
        { timeoutMs: 8_000, label: 'Tab 2 reloaded via [r]' },
      );

      // Filter with '/'
      tty.send('/');
      await tty.waitFor((s) => s.includes('筛选:'), { timeoutMs: 5_000, label: 'Filter bar opened on Tab 2' });
      tty.send('TLB Shootdown');
      const filteredTab2 = await tty.waitFor(
        (s) => s.includes('TLB Shootdown') && s.includes('→'),
        { timeoutMs: 5_000, label: 'Tab 2 filtered to TLB Shootdown edge' },
      );
      tty.assertHealthyScreen(filteredTab2, 120, 36, 'StudyMapModal Tab 2 filtered zh 120x36');
      tty.send('\r');
      await tty.waitFor((s) => s.includes('Enter 练习') && !s.includes('应用筛选'), {
        timeoutMs: 5_000,
        label: 'Exited filter focus on Tab 2',
      });

      // Switch back to Tab 1 via Tab, then forward to Tab 2 via Tab
      tty.send('\t');
      await tty.waitFor((s) => s.includes('按课程、题组与考点查看掌握度') || s.includes('全库'), {
        timeoutMs: 5_000,
        label: 'Switched back to Tab 1 via Tab',
      });
      tty.send('\t');
      await tty.waitFor((s) => s.includes('条前置边'), {
        timeoutMs: 5_000,
        label: 'Switched to Tab 2 via Tab',
      });

      // Resize to 80x24 -> verify Tab 2 narrow layout, '/' filter + Esc clear, and Esc closes StudyMapModal
      tty.resize(80, 24);
      const narrowTab2 = await tty.waitFor(
        (s) => s.includes('条前置边') && s.includes('TLB Shootdown') && s.split('\n').length <= 24,
        { timeoutMs: 5_000, label: 'StudyMapModal Tab 2 at 80x24' },
      );
      tty.assertHealthyScreen(narrowTab2, 80, 24, 'StudyMapModal Tab 2 zh 80x24');

      tty.send('/');
      await tty.waitFor((s) => s.includes('筛选:'), { timeoutMs: 5_000, label: 'Filter bar opened at 80x24' });
      tty.send('TLB');
      const narrowFiltered = await tty.waitFor(
        (s) => s.includes('TLB Shootdown') && s.split('\n').length <= 24,
        { timeoutMs: 5_000, label: 'Filtered Tab 2 at 80x24' },
      );
      tty.assertHealthyScreen(narrowFiltered, 80, 24, 'StudyMapModal Tab 2 filtered zh 80x24');

      tty.send('\x1b');
      await tty.waitFor((s) => !s.includes('筛选:') && s.includes('22 节点') && s.includes('Virtual Memory Paging'), {
        timeoutMs: 5_000,
        label: 'Filter cleared on Esc at 80x24',
      });

      // Second Esc closes StudyMapModal cleanly
      tty.send('\x1b');
      const closedScreen = await tty.waitFor(
        (s) => !s.includes('知识掌握地图') && s.includes('学习统计与掌握度'),
        { timeoutMs: 8_000, label: 'StudyMapModal closed on Esc from Tab 2 (zh 80x24)' },
      );
      tty.assertHealthyScreen(closedScreen, 80, 24, 'DashboardView after Esc zh 80x24');

      // Resize back to 120x36, re-open, switch to Tab 2, filter to TLB Shootdown, and press Enter to launch practice
      tty.resize(120, 36);
      tty.send('m');
      await tty.waitFor((s) => s.includes('2:前置依赖图'), { timeoutMs: 8_000, label: 'StudyMapModal reopened' });
      tty.send('2');
      await tty.waitFor((s) => s.includes('Virtual Memory Paging'), { timeoutMs: 8_000, label: 'Tab 2 loaded again' });
      tty.send('/');
      await tty.waitFor((s) => s.includes('筛选:'), { timeoutMs: 5_000, label: 'Filter opened' });
      tty.send('TLB Shootdown');
      await tty.waitFor((s) => s.includes('TLB Shootdown'), { timeoutMs: 5_000, label: 'Filtered to TLB edge' });
      tty.send('\r');
      await tty.waitFor((s) => s.includes('Enter 练习') && !s.includes('应用筛选'), {
        timeoutMs: 5_000,
        label: 'Filter applied',
      });
      tty.send('\r');
      const reviewScreen = await tty.waitFor(
        (s) => useDistTuiStore.getState().page === 'review' && (s.includes('Virtual Memory Paging') || s.includes('TLB Shootdown')),
        { timeoutMs: 8_000, label: 'ReviewView launched from Tab 2 edge' },
      );
      tty.assertHealthyScreen(reviewScreen, 120, 36, 'ReviewView launched from Tab 2 zh 120x36');
      assert.equal(useDistTuiStore.getState().page, 'review');
    } finally {
      app.unmount();
      tty.dispose();
      await host.dispose();
    }
  });
});

describe('Round 66 Track 2: DashboardView [d] Usage Window & [x] Markdown Report Export', () => {
  let boxDir;
  let dshHome;
  let libraryRoot;
  let host;
  let fetchCalls = 0;
  let activeTty = null;
  let activeInk = null;
  let disposed = false;

  async function unmountActiveApp() {
    const ink = activeInk;
    const tty = activeTty;
    activeInk = null;
    activeTty = null;
    try {
      ink?.unmount();
    } catch {
      // Ignore unmount errors during test teardown
    }
    tty?.dispose();
  }

  async function mountApp({ initialPage = 'library', asciiMode = false, language = 'zh', cols = 120, rows = 36 } = {}) {
    await unmountActiveApp();
    resetDistStore(language, asciiMode, { loading: true });
    await saveTuiPreferences({ language, asciiMode }, { env: { DSH_HOME: dshHome } });
    host.setLanguage(language);
    const tty = createVirtualTty(cols, rows);
    let inkInstance = null;
    inkInstance = render(
      React.createElement(StudyHubTuiApp, {
        host,
        initialPage,
        initialLanguage: language,
        initialAsciiMode: asciiMode,
        autoLaunchpad: false,
        onExit: () => inkInstance?.unmount(),
      }),
      {
        stdin: tty.stdin,
        stdout: tty.stdout,
        stderr: tty.stderr,
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );
    activeTty = tty;
    activeInk = inkInstance;
    await tty.firstFramePromise;
    await tty.waitFor(
      () => Boolean(useDistTuiStore.getState().snapshot) && !useDistTuiStore.getState().loading,
      { timeoutMs: 10_000, label: `App boot settled (${language} ${cols}x${rows})` },
    );
    await tty.flush();
    return tty;
  }

  before(async () => {
    boxDir = await temps.make('r66-main');
    dshHome = join(boxDir, 'dsh-home');
    libraryRoot = join(boxDir, 'library');
    await cloneSampleLibrary('zh', libraryRoot);
    process.env.DSH_HOME = dshHome;

    host = await createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(boxDir, 'home'),
      libraryRoot,
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
      fetch: async () => {
        fetchCalls += 1;
        throw new Error('Unexpected fetch call');
      },
    });

    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error('Unexpected global fetch call');
    };

    const sampleRes = await host.call('sample.status', {});
    assert.equal(sampleRes.ok, true, `sample.status failed: ${sampleRes.error?.message}`);
    assert.equal(sampleRes.value?.loaded, true, 'sample library must be pre-seeded via cloneSampleLibrary');
    await host.refreshSnapshot();
  });

  after(async () => {
    if (disposed) return;
    disposed = true;
    try {
      await unmountActiveApp();
      await host?.dispose();
    } finally {
      globalThis.fetch = ORIGINAL_FETCH;
    }
  });

  test('1) Pure unit test: formatDashboardMarkdownReport renders zh & en KPI, forecast, top-15 weak topics, course breakdown & token usage', () => {
    const sampleWeak = Array.from({ length: 20 }, (_, i) => ({
      deckId: `deck-${i + 1}`,
      deckTitle: `Deck ${i + 1}`,
      course: i % 2 === 0 ? 'Operating Systems' : 'Algorithms | Core',
      topic: `Topic #${i + 1}`,
      wrong: 20 - i,
      lastAt: '2026-11-22',
      cards: [{ deckId: `deck-${i + 1}`, cardId: `c-${i + 1}` }],
    }));

    const sampleInput = {
      stats: {
        today: '2026-11-22',
        totals: {
          cards: 120,
          mastered: 72,
          due: 14,
          weak: 20,
          attempts: 340,
          recentRate: 86,
          activeDays: 18,
          streak: 6,
        },
        forecast: {
          days: [
            { date: '2026-11-22', count: 14, overdue: 3 },
            { date: '2026-11-23', count: 9, overdue: 0 },
            { date: '2026-11-24', count: 11, overdue: 0 },
          ],
        },
        weakTopics: sampleWeak,
      },
      dailyPlan: {
        date: '2026-11-22',
        budgetMinutes: 45,
        spentMinutes: 25,
      },
      usage: {
        days: 90,
        total: {
          calls: 42,
          uncachedInputTokens: 12_000,
          outputTokens: 3_500,
          cacheReadTokens: 4_000,
          cacheWriteTokens: 500,
        },
        byFeature: {
          review_help: {
            calls: 30,
            uncachedInputTokens: 9_000,
            outputTokens: 2_500,
            cacheReadTokens: 3_000,
            cacheWriteTokens: 500,
          },
          generate: {
            calls: 12,
            uncachedInputTokens: 3_000,
            outputTokens: 1_000,
            cacheReadTokens: 1_000,
            cacheWriteTokens: 0,
          },
        },
      },
      usageDays: 90,
      courseRows: [
        { rawCourse: 'Operating Systems', label: 'Operating Systems', masteryPct: 82, totalCards: 70, dueCount: 8, weakCount: 10 },
        { rawCourse: 'Algorithms', label: 'Algorithms', masteryPct: 68, totalCards: 50, dueCount: 6, weakCount: 10 },
      ],
      focusCourse: 'Operating Systems',
      generatedAt: '2026-11-22',
    };

    const mdZh = formatDashboardMarkdownReport({ ...sampleInput, lang: 'zh' });
    assert.ok(mdZh.includes('# StudyHub 学习进度报告'));
    assert.ok(mdZh.includes('生成日期: 2026-11-22'));
    assert.ok(mdZh.includes('当前课程: Operating Systems'));
    assert.ok(mdZh.includes('今日学习时长: 25 / 45 分钟'));
    assert.ok(mdZh.includes('## 核心指标 (KPI)'));
    assert.ok(mdZh.includes('| 总题数 (Total Cards) | 120 |'));
    assert.ok(mdZh.includes('| 已掌握 (Mastered) | 72 |'));
    assert.ok(mdZh.includes('| 今日到期 (Due Today) | 14 |'));
    assert.ok(mdZh.includes('| 薄弱题 (Weak) | 20 |'));
    assert.ok(mdZh.includes('| 累计作答 (Attempts) | 340 |'));
    assert.ok(mdZh.includes('| 正确率 (Accuracy) | 86% |'));
    assert.ok(mdZh.includes('| 活跃天数 (Active Days) | 18 |'));
    assert.ok(mdZh.includes('| 连续学习 (Streak) | 6 天 |'));
    assert.ok(mdZh.includes('## 未来 7 日复习预测'));
    assert.ok(mdZh.includes('2026-11-22 (今日)'));
    assert.ok(mdZh.includes('## 薄弱知识点 (Top 15)'));
    assert.ok(mdZh.includes('Topic #15'));
    assert.ok(!mdZh.includes('Topic #16'), 'weak topics table must cap at top 15');
    assert.ok(mdZh.includes('Algorithms \\| Core'), 'pipe characters must be escaped in Markdown tables');
    assert.ok(mdZh.includes('## 各课程掌握度'));
    assert.ok(mdZh.includes('| Operating Systems | 82% | 70 | 8 | 10 |'));
    assert.ok(mdZh.includes('## AI Token 用量汇总 (90天)'));
    assert.ok(mdZh.includes('统计窗口: 90 天'));
    assert.ok(mdZh.includes('调用次数: 42'));
    assert.ok(mdZh.includes('总 Token: 20000 (20.0K)'));
    assert.ok(mdZh.includes('| review_help | 30 | 15000 |'));

    const mdEn = formatDashboardMarkdownReport({
      ...sampleInput,
      lang: 'en',
      focusCourse: null,
      stats: { ...sampleInput.stats, forecast: { days: [] } },
      usageDays: 7,
    });
    assert.ok(mdEn.includes('# StudyHub Study Progress Report'));
    assert.ok(mdEn.includes('- Date: 2026-11-22'));
    assert.ok(!mdEn.includes('Focus Course:'), 'focusCourse omitted when null');
    assert.ok(mdEn.includes('## Key Metrics (KPI)'));
    assert.ok(mdEn.includes('| Total Cards | 120 |'));
    assert.ok(mdEn.includes('| Mastered | 72 |'));
    assert.ok(mdEn.includes('| Due Today | 14 |'));
    assert.ok(mdEn.includes('| Weak | 20 |'));
    assert.ok(mdEn.includes('| Attempts | 340 |'));
    assert.ok(mdEn.includes('| Accuracy | 86% |'));
    assert.ok(mdEn.includes('| Active Days | 18 |'));
    assert.ok(mdEn.includes('| Streak | 6d |'));
    assert.ok(!mdEn.includes('## 7-Day Review Forecast'), 'forecast section omitted when forecast days empty');
    assert.ok(mdEn.includes('## Weak Topics (Top 15)'));
    assert.ok(mdEn.includes('Topic #1'));
    assert.ok(mdEn.includes('Topic #15'));
    assert.ok(!mdEn.includes('Topic #16'));
    assert.ok(mdEn.includes('Algorithms \\| Core'));
    assert.ok(mdEn.includes('## Per-Course Mastery'));
    assert.ok(mdEn.includes('| Operating Systems | 82% | 70 | 8 | 10 |'));
    assert.ok(mdEn.includes('| Algorithms | 68% | 50 | 6 | 10 |'));
    assert.ok(mdEn.includes('## AI Token Usage Summary (7d)'));
    assert.ok(mdEn.includes('- Window: 7d'));
    assert.ok(mdEn.includes('- Calls: 42'));
    assert.ok(mdEn.includes('20000 (20.0K)'));
    assert.ok(mdEn.includes('| review_help | 30 | 15000 |'));
    assert.ok(mdEn.includes('| generate | 12 | 5000 |'));

    const mdEmpty = formatDashboardMarkdownReport({
      stats: { today: '2026-11-22', totals: {}, forecast: { days: [] }, weakTopics: [] },
      dailyPlan: null,
      usage: null,
      usageDays: 30,
      courseRows: [],
      focusCourse: null,
      generatedAt: '2026-11-22',
      lang: 'en',
    });
    assert.ok(mdEmpty.includes('# StudyHub Study Progress Report'));
    assert.ok(mdEmpty.includes('| Total Cards | 0 |'));
    assert.ok(mdEmpty.includes('No weak topics') || mdEmpty.includes('## Key Metrics'));
    assert.ok(mdZh.includes('| generate | 12 | 5000 |'));
    assert.ok(mdZh.includes('| Algorithms | 68% | 50 | 6 | 10 |'));
    assert.ok(mdZh.includes('2026-11-23'));
    assert.ok(mdZh.includes('2026-11-24'));
    assert.ok(mdZh.includes('Topic #1'));
    assert.ok(mdZh.includes('Operating Systems'));

    const mdEn90 = formatDashboardMarkdownReport({ ...sampleInput, lang: 'en', usageDays: 90 });
    assert.ok(mdEn90.includes('# StudyHub Study Progress Report'), '90d EN title missing');
    assert.ok(mdEn90.includes('## Key Metrics (KPI)'), '90d EN KPI heading missing');
    assert.ok(mdEn90.includes('## Per-Course Mastery'), '90d EN per-course mastery missing');
    assert.ok(mdEn90.includes('## AI Token Usage Summary (90d)'), '90d EN usage summary heading missing');
    assert.ok(mdEn90.includes('- Window: 90d'), '90d EN usage window missing');
    assert.ok(mdEn90.includes('- Calls: 42'), '90d EN calls missing');
    assert.ok(mdEn90.includes('| Total Cards | 120 |'), '90d EN Total Cards missing');
  });

  test('2) PTY E2E (120x36 & 80x24 zh): Dashboard [6] -> [d] cycles 30->90->7 -> [x] writes atomic Markdown report (0 model calls)', async () => {
    fetchCalls = 0;
    const backupsDir = join(libraryRoot, 'backups');
    await rm(backupsDir, { recursive: true, force: true });

    const tty = await mountApp({ initialPage: 'library', asciiMode: false, language: 'zh', cols: 120, rows: 36 });
    await tty.waitFor((s) => s.includes('Memento') || s.includes('学习库'), {
      timeoutMs: 10_000,
      label: 'Initial Library view loaded (zh)',
    });

    // Navigate to Dashboard ('6')
    tty.send('6');
    const dash30 = await tty.waitFor(
      (s) => s.includes('学习统计与掌握度') && s.includes('用量:30天') && s.includes('30天)') && s.includes('导出报告'),
      { timeoutMs: 8_000, label: 'DashboardView rendered at 30d default (zh 120x36)' },
    );
    tty.assertHealthyScreen(dash30, 120, 36, 'DashboardView initial 30d zh 120x36');

    // Cycle usage window: 30 -> 90
    tty.send('d');
    const dash90 = await tty.waitFor(
      (s) => s.includes('用量:90天') && s.includes('90天)') && s.includes('最近 90 天'),
      { timeoutMs: 8_000, label: 'DashboardView cycled usage window to 90d (zh)' },
    );
    tty.assertHealthyScreen(dash90, 120, 36, 'DashboardView 90d zh 120x36');

    // Cycle usage window: 90 -> 7 and verify narrow 80x24 layout before [x] export
    tty.send('d');
    const dash7 = await tty.waitFor(
      (s) => s.includes('用量:7天') && s.includes('7天)') && s.includes('最近 7 天'),
      { timeoutMs: 8_000, label: 'DashboardView cycled usage window to 7d (zh)' },
    );
    tty.assertHealthyScreen(dash7, 120, 36, 'DashboardView 7d zh 120x36');

    tty.resize(80, 24);
    const dash7Narrow = await tty.waitFor(
      (s) => s.includes('7天') && s.split('\n').length <= 24,
      { timeoutMs: 5_000, label: 'DashboardView 7d at 80x24 (zh)' },
    );
    tty.assertHealthyScreen(dash7Narrow, 80, 24, 'DashboardView 7d zh 80x24');

    // Export Markdown report via [x] at 80x24
    tty.send('x');
    const exportedScreen = await tty.waitFor(
      (s) => s.includes('已导出报告'),
      { timeoutMs: 8_000, label: 'DashboardView [x] showed export toast (zh 80x24)' },
    );
    tty.assertHealthyScreen(exportedScreen, 80, 24, 'DashboardView after [x] export zh 80x24');

    const exportedInfo = await findExportedBackupFile(backupsDir, 'studyhub-report', 'md', todayLocalYmd());
    assert.ok(exportedInfo, `expected studyhub-report-${todayLocalYmd()}-HHmmss.md in ${backupsDir}`);
    const mdContent = await readFile(exportedInfo.path, 'utf8');
    assert.ok(mdContent.includes('# StudyHub 学习进度报告'), 'exported report has zh title');
    assert.ok(mdContent.includes('## 核心指标 (KPI)'), 'exported report has KPI table');
    assert.ok(mdContent.includes('| 总题数 (Total Cards) |'), 'exported report has Total Cards row');
    assert.ok(mdContent.includes('## 各课程掌握度'), 'exported report has course breakdown');
    assert.ok(mdContent.includes('## AI Token 用量汇总 (7天)'), 'exported report reflects active 7d usage window');
    assert.ok(mdContent.includes('| 已掌握 (Mastered) |'), 'exported report has Mastered row');
    assert.ok(mdContent.includes('| 正确率 (Accuracy) |'), 'exported report has Accuracy row');
    assert.ok(mdContent.includes('| 活跃天数 (Active Days) |'), 'exported report has Active Days row');
    assert.ok(mdContent.includes('统计窗口: 7 天'), 'exported report has 7d window');
    assert.equal(useDistTuiStore.getState().page, 'dashboard');
    assert.equal(fetchCalls, 0, 'Dashboard [d] & [x] must make 0 model/network calls');
  });
});

describe('Round 74 Track 2: DashboardView `/` Live Drill Filter', () => {
  let boxDir;
  let dshHome;
  let libraryRoot;
  let host;
  let fetchCalls = 0;
  let activeTty = null;
  let activeInk = null;
  let disposed = false;

  async function unmountActiveApp() {
    const ink = activeInk;
    const tty = activeTty;
    activeInk = null;
    activeTty = null;
    try {
      ink?.unmount();
    } catch {
      // Ignore unmount errors during test teardown
    }
    tty?.dispose();
  }

  async function mountApp({ initialPage = 'library', asciiMode = false, language = 'zh', cols = 120, rows = 36 } = {}) {
    await unmountActiveApp();
    resetDistStore(language, asciiMode, { loading: true });
    await saveTuiPreferences({ language, asciiMode }, { env: { DSH_HOME: dshHome } });
    host.setLanguage(language);
    const tty = createVirtualTty(cols, rows);
    let inkInstance = null;
    inkInstance = render(
      React.createElement(StudyHubTuiApp, {
        host,
        initialPage,
        initialLanguage: language,
        initialAsciiMode: asciiMode,
        autoLaunchpad: false,
        onExit: () => inkInstance?.unmount(),
      }),
      {
        stdin: tty.stdin,
        stdout: tty.stdout,
        stderr: tty.stderr,
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );
    activeTty = tty;
    activeInk = inkInstance;
    await tty.firstFramePromise;
    await tty.waitFor(
      () => Boolean(useDistTuiStore.getState().snapshot) && !useDistTuiStore.getState().loading,
      { timeoutMs: 10_000, label: `App boot settled (${language} ${cols}x${rows})` },
    );
    await tty.flush();
    return tty;
  }

  before(async () => {
    boxDir = await temps.make('r74-main');
    dshHome = join(boxDir, 'dsh-home');
    libraryRoot = join(boxDir, 'library');
    await mkdir(libraryRoot, { recursive: true });
    process.env.DSH_HOME = dshHome;

    host = await createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(boxDir, 'home'),
      libraryRoot,
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
      fetch: async () => {
        fetchCalls += 1;
        throw new Error('Unexpected fetch call');
      },
    });

    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error('Unexpected global fetch call');
    };

    // Seed 2 weak topics under focused course 'Algo' + a second course 'OS系统' => 4 drill items total.
    await seedCourseCards(host, {
      title: 'Algo Deck',
      course: 'Algo',
      cards: [
        {
          topic: '动态规划 Dynamic Prog',
          prompt: 'Define optimal substructure in DP.',
          answer: 'Optimal solution contains optimal solutions to subproblems.',
          failCount: 2,
        },
        {
          topic: '虚拟内存 Virtual Memory',
          prompt: 'What is a page fault in virtual memory?',
          answer: 'An exception raised when accessing a page not mapped in physical RAM.',
          failCount: 1,
        },
      ],
    });

    await seedCourseCards(host, {
      title: 'OS Deck',
      course: 'OS系统',
      cards: [
        {
          topic: 'Process Scheduling',
          prompt: 'What is preemptive scheduling?',
          answer: 'Scheduler can interrupt a running process.',
          failCount: 0,
        },
      ],
    });

    const focusAlgo = await host.call('focus.set', { course: 'Algo' });
    assert.equal(focusAlgo.ok, true, `focus.set('Algo') failed: ${focusAlgo.error?.message || ''}`);
    await host.refreshSnapshot();
  });

  after(async () => {
    if (disposed) return;
    disposed = true;
    try {
      await unmountActiveApp();
      await host?.dispose();
    } finally {
      globalThis.fetch = ORIGINAL_FETCH;
    }
  });

  test('1) Pure unit tests: filterDashboardDrillItems handles empty query, CJK match, EN case-insensitive match, and no match', () => {
    const items = [
      {
        kind: 'weak',
        key: 'weak:d1:dp:0',
        course: '数据结构与算法',
        topic: '动态规划状态转移',
        wrong: 3,
        cardCount: 2,
        cards: [{ deckId: 'd1', cardId: 'c1' }],
      },
      {
        kind: 'weak',
        key: 'weak:d2:vm:1',
        course: 'Operating Systems',
        topic: 'Virtual Memory Paging',
        wrong: 1,
        cardCount: 1,
        cards: [{ deckId: 'd2', cardId: 'c2' }],
      },
      {
        kind: 'course',
        key: 'course:数据结构与算法',
        course: '数据结构与算法',
        label: '数据结构与算法',
        masteryPct: 75,
        totalCards: 20,
        dueCount: 4,
        weakCount: 2,
      },
      {
        kind: 'course',
        key: 'course:Operating Systems',
        course: 'Operating Systems',
        label: 'Operating Systems',
        masteryPct: 88,
        totalCards: 15,
        dueCount: 1,
        weakCount: 1,
      },
    ];

    assert.strictEqual(filterDashboardDrillItems(items, ''), items, 'empty query must return items unchanged');
    assert.strictEqual(filterDashboardDrillItems(items, '   \t '), items, 'whitespace query must return items unchanged');

    const cjkTopic = filterDashboardDrillItems(items, '状态转移');
    assert.equal(cjkTopic.length, 1);
    assert.equal(cjkTopic[0].kind, 'weak');
    assert.deepEqual(cjkTopic.map((x) => x.key), ['weak:d1:dp:0']);

    const cjkCourse = filterDashboardDrillItems(items, '算法');
    assert.equal(cjkCourse.length, 2);
    assert.deepEqual(cjkCourse.map((x) => x.key), ['weak:d1:dp:0', 'course:数据结构与算法']);

    const enCourse = filterDashboardDrillItems(items, 'OPERATING');
    assert.equal(enCourse.length, 2);
    assert.deepEqual(enCourse.map((x) => x.key), ['weak:d2:vm:1', 'course:Operating Systems']);

    const enTopic = filterDashboardDrillItems(items, 'pAgInG');
    assert.equal(enTopic.length, 1);
    assert.equal(enTopic[0].topic, 'Virtual Memory Paging');
    assert.deepEqual(enTopic.map((x) => x.key), ['weak:d2:vm:1']);

    const none = filterDashboardDrillItems(items, 'quantum-computing-xyz');
    assert.equal(none.length, 0);
    assert.deepEqual(none, []);

    const emptyItems = [];
    assert.equal(filterDashboardDrillItems(emptyItems, 'dp').length, 0);
    assert.deepEqual(filterDashboardDrillItems(emptyItems, 'dp'), []);
    assert.deepEqual(filterDashboardDrillItems(items, '  operating  ').map((x) => x.key), ['weak:d2:vm:1', 'course:Operating Systems']);
    assert.deepEqual(filterDashboardDrillItems(items, 'Memory').map((x) => x.key), ['weak:d2:vm:1']);
  });

  test('2) PTY E2E (zh, 120x36 & 80x24): Dashboard `/` inline filter, live narrow, Enter commit/drill, [p] drill, no-match empty state, Esc clear', async () => {
    fetchCalls = 0;
    const tty = await mountApp({ initialPage: 'library', asciiMode: false, language: 'zh', cols: 120, rows: 36 });
    await tty.waitFor((s) => s.includes('学习库') || s.includes('Algo Deck'), {
      timeoutMs: 10_000,
      label: 'Initial Library view loaded (zh)',
    });

    // Navigate to Dashboard ('6')
    tty.send('6');
    const dashInitial = await tty.waitFor(
      (s) =>
        useDistTuiStore.getState().page === 'dashboard' &&
        s.includes('学习统计与掌握度') &&
        s.includes('动态规划 Dynamic Prog') &&
        s.includes('虚拟内存 Virtual Memory') &&
        useDistTuiStore.getState().footerHints.some((h) => h.key === '/' && h.label === '筛选'),
      { timeoutMs: 8_000, label: 'DashboardView loaded with weak & course drill items (zh 120x36)' },
    );
    tty.assertHealthyScreen(dashInitial, 120, 36, 'DashboardView initial zh 120x36');

    // Press '/' -> opens inline filter TextInput inside bottom panel, CommandPalette stays closed
    tty.send('/');
    const filterOpened = await tty.waitFor(
      (s) =>
        useDistTuiStore.getState().inputCaptured === true &&
        useDistTuiStore.getState().commandPaletteOpen === false &&
        s.includes('[筛选 4/4]'),
      { timeoutMs: 8_000, label: 'DashboardView `/` inline filter bar opened (zh)' },
    );
    tty.assertHealthyScreen(filterOpened, 120, 36, 'DashboardView filter opened zh 120x36');

    // Type 'memory' (contains 'm' & 'r' view shortcuts: must NOT open Map modal or refresh)
    tty.send('memory');
    const filteredLive = await tty.waitFor(
      (s) =>
        s.includes('[筛选 1/4]') &&
        s.includes('筛选: memory (1/4)') &&
        s.includes('虚拟内存 Virtual Memory') &&
        !s.includes('动态规划 Dynamic Prog'),
      { timeoutMs: 8_000, label: 'Live filter narrowed to Virtual Memory (1/4) without triggering m/r shortcuts' },
    );
    tty.assertHealthyScreen(filteredLive, 120, 36, 'DashboardView live filtered zh 120x36');

    // Press Esc while filterOpen -> clears filterQuery and closes input box
    tty.send('\x1b');
    const escClearedOpen = await tty.waitFor(
      (s) =>
        useDistTuiStore.getState().inputCaptured === false &&
        !s.includes('[筛选 ') &&
        !s.includes('筛选: memory') &&
        s.includes('动态规划 Dynamic Prog') &&
        s.includes('虚拟内存 Virtual Memory'),
      { timeoutMs: 8_000, label: 'Esc cleared filterQuery and closed filter input box (zh)' },
    );
    tty.assertHealthyScreen(escClearedOpen, 120, 36, 'DashboardView after Esc in open filter zh 120x36');

    // Re-open with '/', type '虚拟', commit with Enter -> input box closes, filter stays applied
    tty.send('/');
    await tty.waitFor((s) => s.includes('[筛选 4/4]'), { timeoutMs: 8_000, label: 'Re-open filter bar (zh)' });
    tty.send('虚拟');
    await tty.waitFor((s) => s.includes('[筛选 1/4]'), { timeoutMs: 8_000, label: 'Live filter CJK 虚拟 -> 1/4' });

    tty.send('\r');
    const committedScreen = await tty.waitFor(
      (s) =>
        useDistTuiStore.getState().inputCaptured === false &&
        !s.includes('[筛选 ') &&
        s.includes('筛选: 虚拟 (1/4)') &&
        s.includes('虚拟内存 Virtual Memory') &&
        !s.includes('动态规划 Dynamic Prog'),
      { timeoutMs: 8_000, label: 'Enter closed input box while keeping filterQuery applied (zh)' },
    );
    tty.assertHealthyScreen(committedScreen, 120, 36, 'DashboardView filter committed zh 120x36');

    // Press 'p' to drill the filtered item -> must launch review for Virtual Memory card (NOT Dynamic Prog)
    tty.send('p');
    const reviewScreen = await tty.waitFor(
      (s) => useDistTuiStore.getState().page === 'review' && s.includes('page fault in virtual memory'),
      { timeoutMs: 8_000, label: 'Drilling filtered item with [p] launched ReviewView for Virtual Memory card' },
    );
    tty.assertHealthyScreen(reviewScreen, 120, 36, 'ReviewView launched from filtered Dashboard item zh 120x36');

    // Return to Dashboard via Backspace (digits 0-9 are claimed inside ReviewView per #1351)
    tty.send('\x7f');
    await tty.waitFor(
      (s) => useDistTuiStore.getState().page === 'dashboard' && s.includes('动态规划 Dynamic Prog'),
      { timeoutMs: 8_000, label: 'Returned to DashboardView (zh)' },
    );
    tty.send('/');
    await tty.waitFor((s) => s.includes('[筛选 4/4]'), { timeoutMs: 8_000, label: 'Open filter before Esc-when-closed test' });
    tty.send('OS');
    await tty.waitFor((s) => s.includes('[筛选 1/4]'), { timeoutMs: 8_000, label: 'Live filter OS -> 1/4' });
    tty.send('\r');
    await tty.waitFor(
      (s) =>
        useDistTuiStore.getState().inputCaptured === false &&
        s.includes('筛选: OS (1/4)') &&
        s.includes('[课程] OS系统') &&
        !s.includes('虚拟内存 Virtual Memory'),
      { timeoutMs: 8_000, label: 'Committed OS course filter' },
    );
    tty.send('\x1b');
    const clearedClosed = await tty.waitFor(
      (s) => !s.includes('筛选: OS') && s.includes('动态规划 Dynamic Prog') && s.includes('虚拟内存 Virtual Memory'),
      { timeoutMs: 8_000, label: 'Esc cleared applied filter when !filterOpen (zh)' },
    );
    tty.assertHealthyScreen(clearedClosed, 120, 36, 'DashboardView Esc cleared committed filter zh 120x36');

    // Resize to 80x24: verify drillListRows budget, no-match empty state + Esc clear, and second Enter drill via VirtualList onSelect
    tty.resize(80, 24);
    const dashNarrow = await tty.waitFor(
      (s) => s.includes('Dynamic Prog') && s.split('\n').length <= 24,
      { timeoutMs: 5_000, label: 'DashboardView resized to 80x24 (zh)' },
    );
    tty.assertHealthyScreen(dashNarrow, 80, 24, 'DashboardView initial zh 80x24');

    tty.send('/');
    const narrowFilterOpened = await tty.waitFor(
      (s) => useDistTuiStore.getState().inputCaptured === true && s.includes('[筛选 4/4]') && s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'DashboardView `/` filter opened at 80x24 (zh)' },
    );
    tty.assertHealthyScreen(narrowFilterOpened, 80, 24, 'DashboardView filter opened zh 80x24');

    tty.send('nomatch-xyz');
    const emptyFilterScreen = await tty.waitFor(
      (s) => s.includes('[筛选 0/4]') && s.includes('没有匹配') && s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'Empty filter state rendered cleanly at 80x24 (zh)' },
    );
    tty.assertHealthyScreen(emptyFilterScreen, 80, 24, 'DashboardView empty filter zh 80x24');

    tty.send('\x1b');
    const clearedNarrow = await tty.waitFor(
      (s) => !s.includes('[筛选 ') && s.includes('Dynamic Prog') && s.includes('Virtual Memory') && s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'Esc cleared no-match filter at 80x24 (zh)' },
    );
    tty.assertHealthyScreen(clearedNarrow, 80, 24, 'DashboardView cleared filter zh 80x24');

    // Filter to 'virtual', commit with first Enter, then drill with second Enter at 80x24
    tty.send('/');
    await tty.waitFor((s) => s.includes('[筛选 4/4]'), { timeoutMs: 8_000, label: 'Re-open filter at 80x24 (zh)' });
    tty.send('virtual');
    await tty.waitFor((s) => s.includes('[筛选 1/4]') && s.includes('Virtual Memory'), {
      timeoutMs: 8_000,
      label: 'Filtered to virtual at 80x24 (zh)',
    });
    tty.send('\r');
    const committedNarrow = await tty.waitFor(
      (s) => useDistTuiStore.getState().inputCaptured === false && !s.includes('[筛选 ') && s.includes('筛选: virtual (1/4)'),
      { timeoutMs: 8_000, label: 'First Enter committed filter at 80x24 (zh)' },
    );
    tty.assertHealthyScreen(committedNarrow, 80, 24, 'DashboardView committed filter zh 80x24');

    tty.send('\r');
    const reviewNarrow = await tty.waitFor(
      (s) => useDistTuiStore.getState().page === 'review' && s.includes('page fault in virtual memory'),
      { timeoutMs: 8_000, label: 'Second Enter launched ReviewView for filtered Virtual Memory item at 80x24' },
    );
    tty.assertHealthyScreen(reviewNarrow, 80, 24, 'ReviewView launched via Enter zh 80x24');
    assert.equal(useDistTuiStore.getState().page, 'review');
    assert.equal(fetchCalls, 0, 'Dashboard `/` filter E2E must make 0 network calls');
  });
});
