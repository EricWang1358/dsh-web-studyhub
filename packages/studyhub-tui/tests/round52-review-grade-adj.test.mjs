// Round 52 Review Manual AI Grade Adjust (review.grade.adjust) & Delayed Correction Ack (review.correction.ack)
// helper unit + createTuiHost integration + @xterm/headless PTY E2E tests:
// node --test --test-concurrency=1 tests/round52-review-grade-adj.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import path, { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import xtermPkg from '@xterm/headless';
import { render } from 'ink';
import React from 'react';

const { Terminal } = xtermPkg;
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const distDir = resolve(pkgRoot, 'dist');

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
const { useTuiStore: useDistTuiStore, DEFAULT_PREFERENCES } = S;

// Bundle pure review-helpers for unit verification
const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyhub-r52-helpers-'));
const bundleFile = path.join(bundleDir, 'review-helpers.mjs');
await build({
  stdin: {
    contents: `export { extractFeedback, canAdjustAiGrade } from './src/views/review/review-helpers.ts';`,
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
const Helpers = await import(pathToFileURL(bundleFile).href);

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round52-${label}-`));
  tempDirs.push(d);
  return d;
}

const RESOURCE_KINDS = new Set(['FSEventWrap', 'StatWatcher', 'Timeout', 'ProcessWrap', 'TCPWrap', 'PipeWrap']);
function resourceCounts() {
  const counts = {};
  for (const kind of process.getActiveResourcesInfo()) {
    if (RESOURCE_KINDS.has(kind)) counts[kind] = (counts[kind] || 0) + 1;
  }
  return counts;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const UNICODE_UI_CHROME_RE = /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u27BF\u2800-\u28FF\u2190-\u21FF\u2022\u2026\u2039\u203A]/g;

function resetDistStore(language = 'zh', asciiMode = false, extra = {}) {
  useDistTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    snapshot: null,
    binding: null,
    config: null,
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
      language,
      asciiMode,
    },
    ...extra,
  });
}

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

function createRubricStubComplete(onCall) {
  return async (_system, prompt) => {
    onCall?.();
    let cardId = 'card-1';
    let criteriaIds = ['c1'];
    try {
      const m = /"questions"\s*:\s*\[\s*\{[\s\S]*?"cardId"\s*:\s*"([^"]+)"/.exec(prompt);
      if (m) cardId = m[1];
      const critMatches = [...prompt.matchAll(/"id"\s*:\s*"([^"]+)"/g)].map((x) => x[1]);
      if (critMatches.length > 0) criteriaIds = critMatches;
    } catch {
      // use defaults
    }
    return JSON.stringify({
      questions: [
        {
          cardId,
          criteria: criteriaIds.map((id) => ({
            id,
            score: 0,
            evidence: [],
            covered: [],
            missing: ['Key reasoning step'],
            suggestion: 'Explain the core mechanism clearly',
          })),
          summary: 'Missing core mechanism',
        },
      ],
      summary: 'Partial attempt',
    });
  };
}

async function seedPendingRubricRun(host, language = 'zh') {
  const sampleRes = await host.call('sample.load', { language });
  assert.equal(sampleRes.ok, true, sampleRes.error?.message);
  const caseDeckId = sampleRes.value?.caseDeckId;
  assert.ok(caseDeckId, 'sample.load must expose caseDeckId');

  const startRes = await host.call('review.start', { mode: 'quiz', deckId: caseDeckId, fresh: true });
  assert.equal(startRes.ok, true, startRes.error?.message);
  const run = startRes.value;
  assert.ok(run?.id && run?.card?.id, 'review.start must return active run');
  assert.ok((run.navigation?.length ?? 0) >= 2, 'case deck must have at least 2 questions');

  const card0Id = run.card.id;
  const card1Id = run.navigation[1].cardId;

  // Move to index 1 so grading card0 occurs after leaving it -> correctionPending: true when grade <= 1
  const move1 = await host.call('review.move', { runId: run.id, index: 1 });
  assert.equal(move1.ok, true, move1.error?.message);

  const gradeRes = await host.call('card.grade', {
    deckId: caseDeckId,
    cardId: card0Id,
    runId: run.id,
    answer: 'Brief incomplete draft',
    language,
  });
  assert.equal(gradeRes.ok, true, gradeRes.error?.message);
  assert.equal(gradeRes.value?.correctionPending, true, 'grading card0 after moving away with grade<=1 must set correctionPending');

  // Move back to index 0 so card0 is active with correctionPending: true
  const move0 = await host.call('review.move', { runId: run.id, index: 0 });
  assert.equal(move0.ok, true, move0.error?.message);

  return { caseDeckId, run: move0.value, card0Id, card1Id };
}

after(async () => {
  fs.rmSync(bundleDir, { recursive: true, force: true });
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

describe('Round 52: ReviewView Manual AI Grade Adjust (review.grade.adjust) & Delayed Correction Ack (review.correction.ack)', () => {
  test('1) Helper unit tests + createTuiHost integration: extractFeedback/canAdjustAiGrade, card.grade -> review.correction.ack -> review.grade.adjust (0 model calls)', async () => {
    // Unit tests for extractFeedback & canAdjustAiGrade
    assert.equal(Helpers.extractFeedback(null), null);
    const fbRubric = Helpers.extractFeedback({
      feedback: {
        grade: 2,
        rubric: { total: 4, max: 10 },
        gradeOriginal: 0,
        adjustedAt: '2026-11-22T10:00:00.000Z',
        correctionPending: true,
        correctionSeenAt: '2026-11-22T10:01:00.000Z',
      },
    });
    assert.equal(fbRubric?.hasRubric, true);
    assert.equal(fbRubric?.taskCheck, false);
    assert.equal(fbRubric?.gradeOriginal, 0);
    assert.equal(fbRubric?.adjustedAt, '2026-11-22T10:00:00.000Z');
    assert.equal(fbRubric?.correctionPending, true);
    assert.equal(fbRubric?.correctionSeenAt, '2026-11-22T10:01:00.000Z');

    const fbTask = Helpers.extractFeedback({
      feedback: { grade: 3, rubric: { total: 5, max: 5 }, taskCheck: { counts: { satisfied: 1 } } },
    });
    assert.equal(fbTask?.hasRubric, true);
    assert.equal(fbTask?.taskCheck, true);

    assert.equal(Helpers.canAdjustAiGrade({ mode: 'quiz' }, { retry: false }, fbRubric), true);
    assert.equal(Helpers.canAdjustAiGrade({ mode: 'exam' }, { retry: false }, fbRubric), false);
    assert.equal(Helpers.canAdjustAiGrade({ mode: 'quiz', closedAt: '2026-11-22T10:05:00.000Z' }, { retry: false }, fbRubric), false);
    assert.equal(Helpers.canAdjustAiGrade({ mode: 'quiz', closed: true }, { retry: false }, fbRubric), false);
    assert.equal(Helpers.canAdjustAiGrade({ mode: 'quiz' }, { retry: true }, fbRubric), false);
    assert.equal(Helpers.canAdjustAiGrade({ mode: 'quiz' }, null, fbRubric), false);
    assert.equal(Helpers.canAdjustAiGrade({ mode: 'quiz' }, { retry: false }, fbTask), false);
    assert.equal(Helpers.canAdjustAiGrade({ mode: 'quiz' }, { retry: false }, { hasRubric: false, taskCheck: false }), false);

    // Host integration
    const base = await makeTempDir('host-int');
    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot: join(base, 'library'),
      env: { ...process.env, DSH_HOME: join(base, 'dsh-home') },
      home: base,
      documentsDir: base,
      injectedComplete: createRubricStubComplete(() => {
        modelCalls += 1;
      }),
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      const { caseDeckId, run, card0Id, card1Id } = await seedPendingRubricRun(host, 'en');
      assert.equal(modelCalls, 1, 'card.grade should have made 1 model call');

      const fb0 = Helpers.extractFeedback(run);
      assert.equal(fb0?.hasRubric, true);
      assert.equal(fb0?.correctionPending, true);
      assert.equal(fb0?.grade, 0);
      assert.equal(Helpers.canAdjustAiGrade(run, { retry: run.retry }, fb0), true);

      // Grade card1 while still ON index 1 -> left=false, so correctionPending is NOT set
      await host.call('review.move', { runId: run.id, index: 1 });
      const grade1Res = await host.call('card.grade', {
        deckId: caseDeckId,
        cardId: card1Id,
        runId: run.id,
        answer: 'Another brief answer',
        language: 'en',
      });
      assert.equal(grade1Res.ok, true, grade1Res.error?.message);
      assert.notEqual(grade1Res.value?.correctionPending, true);
      assert.equal(modelCalls, 2);

      // Guard: review.correction.ack on card1 (!correctionPending) must fail cleanly
      const ackGuard = await host.call('review.correction.ack', {
        runId: run.id,
        entryIndex: 1,
        cardId: card1Id,
      });
      assert.equal(ackGuard.ok, false, 'review.correction.ack must reject when !correctionPending');

      // Acknowledge pending correction on card0 -> 0 model calls, sets correctionPending=false & correctionSeenAt
      const ackRes = await host.call('review.correction.ack', {
        runId: run.id,
        entryIndex: 0,
        cardId: card0Id,
      });
      assert.equal(ackRes.ok, true, ackRes.error?.message);
      assert.equal(modelCalls, 2, 'review.correction.ack must use 0 model calls');

      // Move to index 0 to inspect card0 feedback after ack
      const back0 = await host.call('review.move', { runId: run.id, index: 0 });
      assert.equal(back0.ok, true);
      const fb0AfterAck = Helpers.extractFeedback(back0.value);
      assert.equal(fb0AfterAck?.correctionPending, false);
      assert.equal(typeof fb0AfterAck?.correctionSeenAt, 'string');

      // Adjust AI grade from 0 -> 4 -> 0 model calls, preserves gradeOriginal=0, updates grade=4 & adjustedAt
      const adjRes = await host.call('review.grade.adjust', {
        runId: run.id,
        entryIndex: 0,
        cardId: card0Id,
        grade: 4,
      });
      assert.equal(adjRes.ok, true, adjRes.error?.message);
      assert.equal(modelCalls, 2, 'review.grade.adjust must use 0 model calls');
      const fb0AfterAdj = Helpers.extractFeedback(adjRes.value);
      assert.equal(fb0AfterAdj?.gradeOriginal, 0);
      assert.equal(fb0AfterAdj?.grade, 4);
      assert.equal(fb0AfterAdj?.correct, true);
      assert.equal(typeof fb0AfterAdj?.adjustedAt, 'string');
    } finally {
      await host.dispose();
    }
  });

  test('2) @xterm/headless PTY E2E: ReviewView [K] correction ack & [J] grade adjust modal at 120x36 (zh) and 80x24 (--ascii en) with zero handle leaks', async () => {
    const beforeResources = resourceCounts();

    // Part A: 120x36 default zh
    {
      const base = await makeTempDir('pty-zh');
      const dshHome = join(base, 'dsh-home');
      process.env.DSH_HOME = dshHome;
      await saveTuiPreferences(
        { language: 'zh', asciiMode: false, theme: 'dsh-dark', mathUnicode: false, showHints: true },
        { env: { ...process.env, DSH_HOME: dshHome } },
      );

      let modelCalls = 0;
      const host = await createTuiHost({
        libraryRoot: join(base, 'library'),
        env: { ...process.env, DSH_HOME: dshHome },
        home: join(base, 'home'),
        documentsDir: base,
        injectedComplete: createRubricStubComplete(() => {
          modelCalls += 1;
        }),
        providerDiscovery: fakeDiscovery(),
        skipAutoProbe: true,
        language: 'zh',
        eventDebounceMs: 30,
      });

      const tty = createVirtualTty(120, 36);
      let inkInst = null;
      try {
        const { run } = await seedPendingRubricRun(host, 'zh');
        const callsBeforeUi = modelCalls;

        resetDistStore('zh', false, {
          page: 'review',
          activeRunId: run.id,
          navContext: { runId: run.id },
        });

        inkInst = render(
          React.createElement(StudyHubTuiApp, {
            host,
            initialPage: 'review',
            initialLanguage: 'zh',
            initialAsciiMode: false,
            autoLaunchpad: false,
            onExit: () => inkInst?.unmount(),
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
        await tty.firstFramePromise;

        const initialScreen = await tty.waitFor(
          (s) => s.includes('待确认订正 · 按 [K] 确认并加入本轮重练') && s.includes('J  改分') && s.includes('K  确认订正'),
          { timeoutMs: 10_000, label: 'zh ReviewView correction pending notice & [K]/[J] hints' },
        );
        tty.assertHealthyScreen(initialScreen, 120, 36, '120x36 zh initial correctionPending');

        // Press 'K' to acknowledge correction
        tty.send('K');
        const afterAckScreen = await tty.waitFor(
          (s) => s.includes('已确认订正并加入本轮重练') && !s.includes('待确认订正'),
          { timeoutMs: 8_000, label: 'zh ReviewView after [K] correction ack' },
        );
        tty.assertHealthyScreen(afterAckScreen, 120, 36, '120x36 zh after [K] ack');

        // Press 'J' to open manual grade adjust modal, then pick '4'
        tty.send('J');
        const modalScreen = await tty.waitFor(
          (s) => s.includes('手动调整 AI 评分') && s.includes('[4]'),
          { timeoutMs: 5_000, label: 'zh GradeAdjustModal opened' },
        );
        tty.assertHealthyScreen(modalScreen, 120, 36, '120x36 zh GradeAdjustModal');

        tty.send('4');
        const afterAdjScreen = await tty.waitFor(
          (s) => s.includes('已改分 4 (AI 原评 0)') && s.includes('已将 AI 评分调整为 4'),
          { timeoutMs: 8_000, label: 'zh ReviewView after [J] -> 4 adjust' },
        );
        tty.assertHealthyScreen(afterAdjScreen, 120, 36, '120x36 zh after grade adjust');
        assert.equal(modelCalls, callsBeforeUi, 'ack & adjust in UI must trigger 0 model calls');
      } finally {
        try {
          inkInst?.unmount();
        } catch {
          // ignore
        }
        await host.dispose();
        tty.dispose();
      }
    }

    // Part B: 80x24 --ascii en
    {
      const base = await makeTempDir('pty-en-ascii');
      const dshHome = join(base, 'dsh-home');
      process.env.DSH_HOME = dshHome;
      await saveTuiPreferences(
        { language: 'en', asciiMode: true, theme: 'dsh-dark', mathUnicode: false, showHints: true },
        { env: { ...process.env, DSH_HOME: dshHome } },
      );

      let modelCalls = 0;
      const host = await createTuiHost({
        libraryRoot: join(base, 'library'),
        env: { ...process.env, DSH_HOME: dshHome },
        home: join(base, 'home'),
        documentsDir: base,
        injectedComplete: createRubricStubComplete(() => {
          modelCalls += 1;
        }),
        providerDiscovery: fakeDiscovery(),
        skipAutoProbe: true,
        language: 'en',
        eventDebounceMs: 30,
      });

      const tty = createVirtualTty(80, 24);
      let inkInst = null;
      try {
        const { run } = await seedPendingRubricRun(host, 'en');
        const callsBeforeUi = modelCalls;

        resetDistStore('en', true, {
          page: 'review',
          activeRunId: run.id,
          navContext: { runId: run.id },
        });

        inkInst = render(
          React.createElement(StudyHubTuiApp, {
            host,
            initialPage: 'review',
            initialLanguage: 'en',
            initialAsciiMode: true,
            autoLaunchpad: false,
            onExit: () => inkInst?.unmount(),
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
        await tty.firstFramePromise;

        const initialScreen = await tty.waitFor(
          (s) => s.includes('Correction pending') && s.includes('[K]') && s.includes('J  Adjust') && s.includes('K  Ack fix'),
          { timeoutMs: 10_000, label: 'en ASCII ReviewView correction pending notice' },
        );
        tty.assertHealthyScreen(initialScreen, 80, 24, '80x24 en ASCII initial');
        tty.assertAsciiPure(initialScreen, '80x24 en ASCII initial');

        // Acknowledge pending correction with [K]
        tty.send('K');
        const afterAckScreen = await tty.waitFor(
          (s) => s.includes('Correction acknowledged') && !s.includes('Correction pending'),
          { timeoutMs: 8_000, label: 'en ASCII ReviewView after [K]' },
        );
        tty.assertHealthyScreen(afterAckScreen, 80, 24, '80x24 en ASCII after [K]');
        tty.assertAsciiPure(afterAckScreen, '80x24 en ASCII after [K]');

        // Open GradeAdjustModal with [J], navigate with 'j' to grade 4, confirm with Enter
        tty.send('J');
        const modalScreen = await tty.waitFor(
          (s) => s.includes('Adjust AI Grade') && s.includes('[4] Good'),
          { timeoutMs: 5_000, label: 'en ASCII GradeAdjustModal opened' },
        );
        tty.assertHealthyScreen(modalScreen, 80, 24, '80x24 en ASCII GradeAdjustModal');
        tty.assertAsciiPure(modalScreen, '80x24 en ASCII GradeAdjustModal');

        // Esc cancels cleanly, then reopen and select with j/Enter
        tty.send('\x1b');
        await tty.waitFor(
          (s) => !s.includes('Adjust AI Grade'),
          { timeoutMs: 5_000, label: 'en ASCII GradeAdjustModal Esc cancel' },
        );
        tty.send('J');
        await tty.waitFor(
          (s) => s.includes('Adjust AI Grade'),
          { timeoutMs: 5_000, label: 'en ASCII GradeAdjustModal reopened' },
        );
        for (let step = 0; step < 4; step += 1) {
          tty.send('j');
          await sleep(40);
        }
        await tty.flush();
        tty.send('\r');

        const afterAdjScreen = await tty.waitFor(
          (s) => s.includes('Adjusted 4 (AI: 0)') && s.includes('Adjusted AI grade to 4'),
          { timeoutMs: 8_000, label: 'en ASCII ReviewView after j+Enter grade 4 adjust' },
        );
        tty.assertHealthyScreen(afterAdjScreen, 80, 24, '80x24 en ASCII after grade adjust');
        tty.assertAsciiPure(afterAdjScreen, '80x24 en ASCII after grade adjust');
        assert.equal(modelCalls, callsBeforeUi, 'ack & adjust in UI must trigger 0 model calls');
      } finally {
        try {
          inkInst?.unmount();
        } catch {
          // ignore
        }
        await host.dispose();
        tty.dispose();
      }
    }

    await sleep(100);
    const afterResources = resourceCounts();
    for (const kind of RESOURCE_KINDS) {
      assert.ok(
        (afterResources[kind] || 0) <= (beforeResources[kind] || 0),
        `Leaked ${kind} handles after unmount/dispose: before=${beforeResources[kind] || 0}, after=${afterResources[kind] || 0}`,
      );
    }
  });
});
