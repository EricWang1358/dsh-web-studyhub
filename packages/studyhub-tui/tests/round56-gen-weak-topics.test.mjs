// Round 56 Task 2: GenerateView Weak Topics Quick-Fill (generate.weakTopics, 0 tokens!)
// Host integration + unit tests + @xterm/headless PTY E2E at 120x36 (zh) & 80x24 (--ascii en):
// node --test --test-concurrency=1 tests/round56-gen-weak-topics.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import xtermPkg from '@xterm/headless';
import { render } from 'ink';
import React from 'react';
import { tsImport } from 'tsx/esm/api';

const { Terminal } = xtermPkg;
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const distDir = resolve(pkgRoot, 'dist');

const { formatWeakTopicNames } = await tsImport('../src/views/generate/GenerateView.tsx', import.meta.url);

// Canonical dist chunk discovery
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
    if (!S && mod.useTuiStore?.getState && mod.DEFAULT_PREFERENCES) S = mod;
  }
}
assert.ok(H?.createTuiHost, 'dist/ must export createTuiHost');
assert.ok(H?.saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(R?.displayWidth, 'dist/ must export displayWidth');
assert.ok(S?.useTuiStore, 'dist/ must export useTuiStore');
assert.ok(S?.DEFAULT_PREFERENCES, 'dist/ must export DEFAULT_PREFERENCES');

const { createTuiHost, saveTuiPreferences } = H;
const { displayWidth } = R;
const { useTuiStore, DEFAULT_PREFERENCES } = S;

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round56-weak-topics-${label}-`));
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
    for (let i = 0; i < lines.length; i += 1) {
      const w = displayWidth(lines[i]);
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

function resetTuiStore(preferencesOverride = {}) {
  useTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    snapshot: null,
    binding: null,
    config: null,
    loading: true,
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
    preferences: { ...DEFAULT_PREFERENCES, ...preferencesOverride },
  });
}

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

async function seedLibraryWithWeakTopic(host, course = 'Algorithms') {
  const courseRes = await host.call('course.save', { name: course });
  assert.equal(courseRes.ok, true, `course.save(${course}) failed: ${courseRes.error?.message || ''}`);

  const deckRes = await host.call('deck.import', {
    text: JSON.stringify({
      title: 'Algorithms Core Deck',
      course,
      cards: [
        {
          kind: 'flashcard',
          prompt: 'What two properties characterize Dynamic Programming?',
          answer: 'Optimal substructure and overlapping subproblems.',
          topic: 'Dynamic Programming',
        },
        {
          kind: 'flashcard',
          prompt: 'What property enables Greedy Algorithms?',
          answer: 'Greedy choice property and optimal substructure.',
          topic: 'Greedy Algorithms',
        },
      ],
    }),
    folder: course,
  });
  assert.equal(deckRes.ok, true, `deck.import failed: ${deckRes.error?.message || ''}`);
  assert.equal(deckRes.value?.failed, 0, `deck.import had failures: ${JSON.stringify(deckRes.value?.results)}`);

  const srcRes = await host.call('source.add', {
    title: 'Algorithms Lecture Notes',
    text: '# Dynamic Programming\n## Optimal Substructure\n## Overlapping Subproblems\n',
    courses: [course],
  });
  assert.equal(srcRes.ok, true, `source.add failed: ${srcRes.error?.message || ''}`);

  const deckId = deckRes.value?.results?.[0]?.deckId;
  assert.ok(deckId, `deck.import must return deckId: ${JSON.stringify(deckRes.value)}`);

  const deckGet = await host.call('deck.get', { id: deckId });
  assert.equal(deckGet.ok, true, `deck.get failed: ${deckGet.error?.message || ''}`);
  const dpCard = (deckGet.value?.cards || []).find((c) => c.topic === 'Dynamic Programming');
  assert.ok(dpCard?.id, 'Dynamic Programming card must exist in imported deck');

  const startRes = await host.call('review.start', {
    mode: 'path',
    scope: [{ deckId, cardId: dpCard.id }],
    fresh: true,
  });
  assert.equal(startRes.ok, true, `review.start failed: ${startRes.error?.message || ''}`);
  const run = startRes.value;
  assert.ok(run?.id, 'review.start must return run id');

  const revRes = await host.call('review.reveal', { runId: run.id, cardId: dpCard.id });
  assert.equal(revRes.ok, true, `review.reveal failed: ${revRes.error?.message || ''}`);

  const ansRes = await host.call('review.answer', { runId: run.id, cardId: dpCard.id, grade: 1 });
  assert.equal(ansRes.ok, true, `review.answer(grade=1) failed: ${ansRes.error?.message || ''}`);

  await host.refreshSnapshot();
  return { deckId, dpCardId: dpCard.id };
}

describe('Round 56: GenerateView Weak Topics Quick-Fill (generate.weakTopics, 0 tokens)', () => {
  after(async () => {
    if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = PREV_DSH_HOME;
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
  });

  test('1) unit + createTuiHost integration: formatWeakTopicNames & generate.weakTopics returns failed topic with 0 model calls', async () => {
    assert.deepEqual(formatWeakTopicNames(null), []);
    assert.deepEqual(formatWeakTopicNames({}), []);
    assert.deepEqual(
      formatWeakTopicNames({
        topics: [
          '  Dynamic Programming  ',
          { topic: 'Graph Traversal', weak: 3 },
          { name: 'Dynamic Programming' },
          { name: 'Divide and Conquer', wrong: 2, total: 4 },
          { topic: '' },
          '',
          42,
          null,
          'T1',
          'T2',
          'T3',
          'T4',
          'T5',
          'T6',
          'T7',
        ],
      }),
      ['Dynamic Programming', 'Graph Traversal', 'Divide and Conquer', 'T1', 'T2', 'T3', 'T4', 'T5'],
      'formatWeakTopicNames must normalize, deduplicate, skip empty entries, and cap at 8',
    );
    assert.deepEqual(
      formatWeakTopicNames(['Alpha', { topic: 'Beta' }, { name: 'Alpha' }]),
      ['Alpha', 'Beta'],
    );

    const base = await makeTempDir('host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    let modelCalls = 0;

    const host = await createTuiHost({
      libraryRoot: join(base, 'library'),
      env,
      home: base,
      documentsDir: base,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'en',
      injectedComplete: async () => {
        modelCalls += 1;
        throw new Error('generate.weakTopics must never invoke model');
      },
    });

    try {
      await seedLibraryWithWeakTopic(host, 'Algorithms');
      assert.equal(modelCalls, 0, 'seeding failed review attempt must make 0 model calls');

      const scopedRes = await host.call('generate.weakTopics', { course: 'Algorithms' });
      assert.equal(scopedRes.ok, true, `generate.weakTopics failed: ${scopedRes.error?.message || ''}`);
      assert.equal(modelCalls, 0, 'generate.weakTopics must make 0 model calls');
      const scopedTopics = formatWeakTopicNames(scopedRes.value);
      assert.ok(scopedTopics.includes('Dynamic Programming'), `Expected Dynamic Programming in ${JSON.stringify(scopedRes.value)}`);
      assert.ok(!scopedTopics.includes('Greedy Algorithms'), 'Unattempted topic must not be marked weak');

      const allRes = await host.call('generate.weakTopics', {});
      assert.equal(allRes.ok, true, `generate.weakTopics({}) failed: ${allRes.error?.message || ''}`);
      assert.equal(modelCalls, 0, 'generate.weakTopics({}) must make 0 model calls');
      assert.ok(formatWeakTopicNames(allRes.value).includes('Dynamic Programming'));
    } finally {
      await host.dispose();
    }
  });

  test('2) PTY E2E: GenerateView weak topic indicator + [W] quick-fill at 120x36 (zh) & 80x24 (--ascii en) with 0 model calls', async () => {
    // --- Part A: 120x36 zh ---
    const baseZh = await makeTempDir('pty-zh');
    const envZh = { DSH_HOME: join(baseZh, 'dsh-home') };
    process.env.DSH_HOME = envZh.DSH_HOME;
    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env: envZh });
    resetTuiStore({ language: 'zh', asciiMode: false });

    let zhModelCalls = 0;
    const hostZh = await createTuiHost({
      libraryRoot: join(baseZh, 'library'),
      env: envZh,
      home: baseZh,
      documentsDir: baseZh,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'zh',
      injectedComplete: async () => {
        zhModelCalls += 1;
        throw new Error('Weak topics quick-fill must make 0 model calls');
      },
    });

    await seedLibraryWithWeakTopic(hostZh, 'Algorithms');

    const ttyZh = createVirtualTty(120, 36);
    let inkInstance = null;
    try {
      inkInstance = render(React.createElement(StudyHubTuiApp, { host: hostZh, asciiMode: false }), {
        stdin: ttyZh.stdin,
        stdout: ttyZh.stdout,
        stderr: ttyZh.stderr,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await ttyZh.firstFramePromise;
      await ttyZh.waitFor(() => useTuiStore.getState().page === 'library' && Boolean(useTuiStore.getState().snapshot), {
        label: 'zh LibraryView ready',
      });

      // Open GenerateView ('3')
      ttyZh.send('3');
      const genZh = await ttyZh.waitFor(
        (s) =>
          useTuiStore.getState().page === 'generate' &&
          s.includes('新建出题任务') &&
          s.includes('薄弱点:') &&
          s.includes('Dynamic Programming') &&
          s.includes('[W 填入]'),
        { label: 'zh GenerateView weak topic indicator visible at 120x36' },
      );
      ttyZh.assertHealthyScreen(genZh, 120, 36, 'zh GenerateView 120x36');
      assert.equal(zhModelCalls, 0, 'Entering GenerateView and loading weakTopics must make 0 model calls');
      assert.ok(
        useTuiStore.getState().footerHints.some((h) => h.key === 'W' && h.label.includes('填薄弱点')),
        'Footer hints must advertise W when not editing text',
      );

      // Press 'W' -> fills focus field + shows success toast, 0 model calls
      useTuiStore.setState({ toasts: [] });
      ttyZh.send('W');
      const filledZh = await ttyZh.waitFor(
        (s) =>
          useTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已填入 1 个薄弱知识点到出题重点')) &&
          s.includes('（无，按材料自动规划重点）') === false &&
          s.includes('Dynamic Programming'),
        { label: 'zh [W] fills Dynamic Programming into focus field' },
      );
      ttyZh.assertHealthyScreen(filledZh, 120, 36, 'zh GenerateView after [W] 120x36');
      assert.equal(zhModelCalls, 0, '[W] quick-fill must make 0 model calls');

      // Pressing 'W' again deduplicates cleanly and shows info toast
      useTuiStore.setState({ toasts: [] });
      ttyZh.send('W');
      await ttyZh.waitFor(
        () => useTuiStore.getState().toasts.some((toast) => toast.tone === 'info' && toast.text.includes('出题重点中')),
        { label: 'zh duplicate [W] press notifies info without duplicating' },
      );
      assert.equal(zhModelCalls, 0);
    } finally {
      inkInstance?.unmount();
      inkInstance = null;
      ttyZh.dispose();
      await hostZh.dispose();
    }

    // --- Part B: 80x24 --ascii en ---
    const baseEn = await makeTempDir('pty-en');
    const envEn = { DSH_HOME: join(baseEn, 'dsh-home') };
    process.env.DSH_HOME = envEn.DSH_HOME;
    await saveTuiPreferences({ language: 'en', asciiMode: true }, { env: envEn });
    resetTuiStore({ language: 'en', asciiMode: true });

    let enModelCalls = 0;
    const hostEn = await createTuiHost({
      libraryRoot: join(baseEn, 'library'),
      env: envEn,
      home: baseEn,
      documentsDir: baseEn,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'en',
      injectedComplete: async () => {
        enModelCalls += 1;
        throw new Error('Weak topics quick-fill must make 0 model calls');
      },
    });

    await seedLibraryWithWeakTopic(hostEn, 'Algorithms');
    const emptyCourseRes = await hostEn.call('course.save', { name: 'Empty Course' });
    assert.equal(emptyCourseRes.ok, true);
    await hostEn.refreshSnapshot();

    const ttyEn = createVirtualTty(80, 24);
    try {
      inkInstance = render(React.createElement(StudyHubTuiApp, { host: hostEn, asciiMode: true }), {
        stdin: ttyEn.stdin,
        stdout: ttyEn.stdout,
        stderr: ttyEn.stderr,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await ttyEn.firstFramePromise;
      await ttyEn.waitFor(() => useTuiStore.getState().page === 'library' && Boolean(useTuiStore.getState().snapshot), {
        label: 'en --ascii LibraryView ready',
      });

      ttyEn.send('3');
      const genEn = await ttyEn.waitFor(
        (s) =>
          useTuiStore.getState().page === 'generate' &&
          s.includes('New Generation') &&
          s.includes('Weak:') &&
          s.includes('Dynamic Programming') &&
          s.includes('[W Fill]'),
        { label: 'en --ascii GenerateView weak topic indicator visible at 80x24' },
      );
      ttyEn.assertHealthyScreen(genEn, 80, 24, 'en --ascii GenerateView 80x24');
      ttyEn.assertAsciiPure(genEn, 'en --ascii GenerateView 80x24');
      assert.equal(enModelCalls, 0);

      // Press 'W' -> fills focus field + shows success toast, 0 model calls
      useTuiStore.setState({ toasts: [] });
      ttyEn.send('W');
      const filledEn = await ttyEn.waitFor(
        (s) =>
          useTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('Added 1 weak topic(s) to focus')) &&
          !s.includes('(None -- auto plan') &&
          !s.includes('(None — auto plan') &&
          s.includes('Dynamic Programming'),
        { label: 'en --ascii [W] fills Dynamic Programming into focus field at 80x24' },
      );
      ttyEn.assertHealthyScreen(filledEn, 80, 24, 'en --ascii GenerateView after [W] 80x24');
      ttyEn.assertAsciiPure(filledEn, 'en --ascii GenerateView after [W] 80x24');
      assert.equal(enModelCalls, 0);

      // Switch course via 'c' to Empty Course -> weak topics empty -> [W] shows info toast
      for (let i = 0; i < 4 && !ttyEn.readScreen().includes('Empty Course'); i += 1) {
        ttyEn.send('c');
        await ttyEn.flush();
      }
      await ttyEn.waitFor(
        (s) => s.includes('Empty Course') && !s.includes('[W Fill]'),
        { label: 'en --ascii switched to Empty Course with no weak topics' },
      );
      useTuiStore.setState({ toasts: [] });
      ttyEn.send('W');
      const emptyToastEn = await ttyEn.waitFor(
        () => useTuiStore.getState().toasts.some((toast) => toast.tone === 'info' && toast.text.includes('No weak topics recorded for this course yet')),
        { label: 'en --ascii [W] on course with no weak topics shows info toast' },
      );
      ttyEn.assertHealthyScreen(emptyToastEn, 80, 24, 'en --ascii empty weak topics 80x24');
      ttyEn.assertAsciiPure(emptyToastEn, 'en --ascii empty weak topics 80x24');
      assert.equal(enModelCalls, 0);
    } finally {
      inkInstance?.unmount();
      inkInstance = null;
      ttyEn.dispose();
      await hostEn.dispose();
    }
  });
});
