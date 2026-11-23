// Round 74 Track 2: DashboardView `/` live drill filter unit + @xterm/headless PTY E2E tests
// `node --test --test-concurrency=1 tests/round74-dashboard-filter.test.mjs`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import path, { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import xtermPkg from '@xterm/headless';
import { render } from 'ink';
import React from 'react';

const { Terminal } = xtermPkg;
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const distDir = resolve(pkgRoot, 'dist');

const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const { StudyHubTuiApp } = await import(pathToFileURL(join(distDir, 'App.mjs')).href);

let H = null;
let R = null;
let S = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('chunk-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!H && typeof mod.createTuiHost === 'function' && typeof mod.saveTuiPreferences === 'function') H = mod;
    if (!R && typeof mod.displayWidth === 'function') R = mod;
    if (!S && typeof mod.useTuiStore === 'function') S = mod;
  }
}
assert.ok(H?.createTuiHost, 'dist/ must export createTuiHost');
assert.ok(H?.saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(R?.displayWidth, 'dist/ must export displayWidth');
assert.ok(S?.useTuiStore, 'dist/ must export useTuiStore');

// Bundle pure helper filterDashboardDrillItems from DashboardView.tsx for unit tests
const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyhub-r74-dashboard-'));
const bundleFile = path.join(bundleDir, 'dashboard-filter-helper.mjs');
await build({
  stdin: {
    contents: `export { filterDashboardDrillItems } from './src/views/dashboard/DashboardView.tsx';`,
    resolveDir: pkgRoot,
    loader: 'ts',
  },
  outfile: bundleFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  logLevel: 'silent',
  absWorkingDir: pkgRoot,
});
fs.symlinkSync(path.join(pkgRoot, 'node_modules'), path.join(bundleDir, 'node_modules'), 'junction');
const { filterDashboardDrillItems } = await import(pathToFileURL(bundleFile).href);

const PREV_DSH_HOME = process.env.DSH_HOME;
const ORIGINAL_FETCH = globalThis.fetch;
const tempDirs = [bundleDir];

async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-r74-${label}-`));
  tempDirs.push(d);
  return d;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const UNICODE_UI_CHROME_RE = /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u27BF\u2800-\u28FF\u2190-\u21FF\u2022\u2026\u2039\u203A]/g;

function createVirtualTty(cols = 120, rows = 36) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;

  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = cols;
  stdout.rows = rows;
  stdout.getColorDepth = () => 24;

  const stderr = new PassThrough();
  stderr.isTTY = true;
  stderr.columns = cols;
  stderr.rows = rows;

  const term = new Terminal({
    cols,
    rows,
    allowProposedApi: true,
    convertEol: true,
  });

  let pendingWrites = Promise.resolve();
  let firstFrameResolve = null;
  let firstFrameSettled = false;
  const firstFramePromise = new Promise((resolveFn) => {
    firstFrameResolve = resolveFn;
  });

  stdout.on('data', (chunk) => {
    const str = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    pendingWrites = pendingWrites.then(
      () =>
        new Promise((resolveWrite) => {
          term.write(str, () => {
            if (!firstFrameSettled) {
              firstFrameSettled = true;
              firstFrameResolve?.();
            }
            resolveWrite();
          });
        }),
    );
  });

  async function flush() {
    await sleep(30);
    await pendingWrites;
  }

  function readLines() {
    const buf = term.buffer.active;
    const lines = [];
    for (let y = 0; y < term.rows; y += 1) {
      const line = buf.getLine(buf.viewportY + y);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines;
  }

  function readScreen() {
    return readLines().join('\n');
  }

  function send(data) {
    stdin.write(data);
  }

  async function waitFor(predicate, { timeoutMs = 10_000, label = 'condition' } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await flush();
      const screen = readScreen();
      if (predicate(screen)) return screen;
      await sleep(30);
    }
    const finalScreen = readScreen();
    throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms.\n--- SCREEN ---\n${finalScreen}\n--------------`);
  }

  function assertHealthyScreen(screen, expectedCols, expectedRows, label) {
    const lines = screen.split('\n');
    assert.ok(lines.length <= expectedRows, `${label}: row count ${lines.length} > ${expectedRows}`);
    assert.ok(!screen.includes('页面渲染异常') && !screen.includes('View Error'), `${label}: error boundary triggered`);
    assert.ok(!screen.includes('TypeError:') && !screen.includes('ReferenceError:'), `${label}: runtime JS error`);
    assert.ok(!/\bNaN\b/.test(screen), `${label}: raw NaN leaked`);
    assert.ok(!/\bundefined\b/.test(screen), `${label}: raw undefined leaked`);
    assert.ok(!screen.includes('[object Object]'), `${label}: raw [object Object] leaked`);
    assert.ok(!screen.includes('\uFFFD'), `${label}: replacement char U+FFFD leaked`);
    for (let i = 0; i < lines.length; i += 1) {
      const w = R.displayWidth(lines[i]);
      assert.ok(w <= expectedCols, `${label}: row ${i} width ${w} > ${expectedCols}: ${JSON.stringify(lines[i])}`);
    }
  }

  function assertAsciiPure(screen, label) {
    const matches = screen.match(UNICODE_UI_CHROME_RE);
    assert.ok(!matches, `${label}: leaked non-ASCII UI chrome: ${JSON.stringify([...new Set(matches || [])])}\n${screen}`);
  }

  return {
    stdin,
    stdout,
    stderr,
    firstFramePromise,
    flush,
    readScreen,
    send,
    waitFor,
    assertHealthyScreen,
    assertAsciiPure,
    dispose: () => {
      term.dispose();
      stdin.destroy();
      stdout.destroy();
      stderr.destroy();
    },
  };
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
    await H.saveTuiPreferences({ language, asciiMode }, { env: { DSH_HOME: dshHome } });
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
    return tty;
  }

  before(async () => {
    boxDir = await makeTempDir('main');
    dshHome = join(boxDir, 'dsh-home');
    libraryRoot = join(boxDir, 'library');
    await mkdir(libraryRoot, { recursive: true });
    process.env.DSH_HOME = dshHome;

    host = await H.createTuiHost({
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
      if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = PREV_DSH_HOME;
      await Promise.all(
        tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
      );
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
    assert.deepEqual(cjkTopic.map((x) => x.key), ['weak:d1:dp:0']);

    const cjkCourse = filterDashboardDrillItems(items, '算法');
    assert.deepEqual(cjkCourse.map((x) => x.key), ['weak:d1:dp:0', 'course:数据结构与算法']);

    const enCourse = filterDashboardDrillItems(items, 'OPERATING');
    assert.deepEqual(enCourse.map((x) => x.key), ['weak:d2:vm:1', 'course:Operating Systems']);

    const enTopic = filterDashboardDrillItems(items, 'pAgInG');
    assert.deepEqual(enTopic.map((x) => x.key), ['weak:d2:vm:1']);

    const none = filterDashboardDrillItems(items, 'quantum-computing-xyz');
    assert.deepEqual(none, []);
  });

  test('2) PTY E2E (120x36 zh): Dashboard `/` opens inline filter, live narrows, Enter commits + p drills filtered item, Esc clears', async () => {
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
        S.useTuiStore.getState().page === 'dashboard' &&
        s.includes('学习统计与掌握度') &&
        s.includes('动态规划 Dynamic Prog') &&
        s.includes('虚拟内存 Virtual Memory') &&
        S.useTuiStore.getState().footerHints.some((h) => h.key === '/' && h.label === '筛选'),
      { timeoutMs: 8_000, label: 'DashboardView loaded with weak & course drill items (zh 120x36)' },
    );
    tty.assertHealthyScreen(dashInitial, 120, 36, 'DashboardView initial zh 120x36');

    // Press '/' -> opens inline filter TextInput inside bottom panel, CommandPalette stays closed
    tty.send('/');
    const filterOpened = await tty.waitFor(
      (s) =>
        S.useTuiStore.getState().inputCaptured === true &&
        S.useTuiStore.getState().commandPaletteOpen === false &&
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
        S.useTuiStore.getState().inputCaptured === false &&
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
        S.useTuiStore.getState().inputCaptured === false &&
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
      (s) => S.useTuiStore.getState().page === 'review' && s.includes('page fault in virtual memory'),
      { timeoutMs: 8_000, label: 'Drilling filtered item with [p] launched ReviewView for Virtual Memory card' },
    );
    tty.assertHealthyScreen(reviewScreen, 120, 36, 'ReviewView launched from filtered Dashboard item zh 120x36');

    // Return to Dashboard via '6' and test Esc clearing an applied filter when !filterOpen
    tty.send('6');
    await tty.waitFor(
      (s) => S.useTuiStore.getState().page === 'dashboard' && s.includes('动态规划 Dynamic Prog'),
      { timeoutMs: 8_000, label: 'Returned to DashboardView (zh)' },
    );
    tty.send('/');
    await tty.waitFor((s) => s.includes('[筛选 4/4]'), { timeoutMs: 8_000, label: 'Open filter before Esc-when-closed test' });
    tty.send('OS');
    await tty.waitFor((s) => s.includes('[筛选 1/4]'), { timeoutMs: 8_000, label: 'Live filter OS -> 1/4' });
    tty.send('\r');
    await tty.waitFor(
      (s) =>
        S.useTuiStore.getState().inputCaptured === false &&
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
    assert.equal(fetchCalls, 0, 'Dashboard `/` filter E2E (zh) must make 0 network calls');
  });

  test('3) PTY E2E (80x24 --ascii en): `/` filter respects drillListRows budget, Enter launches filtered review, pure ASCII chrome', async () => {
    fetchCalls = 0;
    const tty = await mountApp({ initialPage: 'library', asciiMode: true, language: 'en', cols: 80, rows: 24 });
    await tty.waitFor((s) => s.includes('Library') || s.includes('Algo Deck'), {
      timeoutMs: 10_000,
      label: 'Initial Library view loaded (en --ascii)',
    });

    // Navigate to Dashboard ('6')
    tty.send('6');
    const dashInitial = await tty.waitFor(
      (s) =>
        S.useTuiStore.getState().page === 'dashboard' &&
        s.includes('Study Analytics') &&
        s.includes('Dynamic Prog') &&
        s.includes('Virtual Memory'),
      { timeoutMs: 8_000, label: 'DashboardView loaded at 80x24 (en --ascii)' },
    );
    tty.assertHealthyScreen(dashInitial, 80, 24, 'DashboardView initial en ascii 80x24');
    tty.assertAsciiPure(dashInitial, 'DashboardView initial en ascii 80x24 pure');

    // Open filter with '/' -> 1-row bar must not overflow drillListPanelH
    tty.send('/');
    const filterOpened = await tty.waitFor(
      (s) =>
        S.useTuiStore.getState().inputCaptured === true &&
        s.includes('[Filter 4/4]'),
      { timeoutMs: 8_000, label: 'DashboardView `/` filter opened at 80x24 (en --ascii)' },
    );
    tty.assertHealthyScreen(filterOpened, 80, 24, 'DashboardView filter opened en ascii 80x24');
    tty.assertAsciiPure(filterOpened, 'DashboardView filter opened en ascii 80x24 pure');

    // Type 'virtual' -> narrows to 1/4, commit with Enter -> launch with Enter
    tty.send('virtual');
    const filteredScreen = await tty.waitFor(
      (s) =>
        s.includes('[Filter 1/4]') &&
        s.includes('Filter: virtual (1/4)') &&
        s.includes('Virtual Memory') &&
        !s.includes('Dynamic Prog'),
      { timeoutMs: 8_000, label: 'DashboardView live filtered to virtual (1/4) at 80x24' },
    );
    tty.assertHealthyScreen(filteredScreen, 80, 24, 'DashboardView live filtered en ascii 80x24');
    tty.assertAsciiPure(filteredScreen, 'DashboardView live filtered en ascii 80x24 pure');

    // First Enter closes filter input while keeping filter applied
    tty.send('\r');
    const committedScreen = await tty.waitFor(
      (s) =>
        S.useTuiStore.getState().inputCaptured === false &&
        !s.includes('[Filter ') &&
        s.includes('Filter: virtual (1/4)') &&
        s.includes('Virtual Memory'),
      { timeoutMs: 8_000, label: 'First Enter committed filter at 80x24 (en --ascii)' },
    );
    tty.assertHealthyScreen(committedScreen, 80, 24, 'DashboardView committed filter en ascii 80x24');
    tty.assertAsciiPure(committedScreen, 'DashboardView committed filter en ascii 80x24 pure');

    // Second Enter drills the filtered item via VirtualList onSelect
    tty.send('\r');
    const reviewScreen = await tty.waitFor(
      (s) => S.useTuiStore.getState().page === 'review' && s.includes('page fault in virtual memory'),
      { timeoutMs: 8_000, label: 'Second Enter launched ReviewView for filtered Virtual Memory item' },
    );
    tty.assertHealthyScreen(reviewScreen, 80, 24, 'ReviewView launched via Enter en ascii 80x24');
    tty.assertAsciiPure(reviewScreen, 'ReviewView launched via Enter en ascii 80x24 pure');

    // Return to Dashboard and verify no-match empty state + Esc clear in --ascii mode
    tty.send('6');
    await tty.waitFor(
      (s) => S.useTuiStore.getState().page === 'dashboard' && s.includes('Dynamic Prog'),
      { timeoutMs: 8_000, label: 'Returned to DashboardView (en --ascii)' },
    );
    tty.send('/');
    await tty.waitFor((s) => s.includes('[Filter 4/4]'), { timeoutMs: 8_000, label: 'Re-open filter (en --ascii)' });
    tty.send('nomatch-xyz');
    const emptyFilterScreen = await tty.waitFor(
      (s) => s.includes('[Filter 0/4]') && s.includes('No topics or courses matching'),
      { timeoutMs: 8_000, label: 'Empty filter state rendered cleanly at 80x24 (en --ascii)' },
    );
    tty.assertHealthyScreen(emptyFilterScreen, 80, 24, 'DashboardView empty filter en ascii 80x24');
    tty.assertAsciiPure(emptyFilterScreen, 'DashboardView empty filter en ascii 80x24 pure');

    tty.send('\x1b');
    const clearedScreen = await tty.waitFor(
      (s) => !s.includes('[Filter ') && s.includes('Dynamic Prog') && s.includes('Virtual Memory'),
      { timeoutMs: 8_000, label: 'Esc cleared no-match filter (en --ascii)' },
    );
    tty.assertHealthyScreen(clearedScreen, 80, 24, 'DashboardView cleared filter en ascii 80x24');
    tty.assertAsciiPure(clearedScreen, 'DashboardView cleared filter en ascii 80x24 pure');
    assert.equal(fetchCalls, 0, 'Dashboard `/` filter E2E (en --ascii) must make 0 network calls');
  });
});
