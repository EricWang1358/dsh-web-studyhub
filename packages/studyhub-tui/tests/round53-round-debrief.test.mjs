// Round 53 RoundSummary Post-Round AI Coach Debrief (coach.debrief) with P2 ConfirmDialog guard
// createTuiHost integration + @xterm/headless PTY E2E tests:
// node --test --test-concurrency=1 tests/round53-round-debrief.test.mjs
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

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round53-${label}-`));
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

function createDebriefStubComplete(onCall) {
  return async (_system, prompt) => {
    onCall?.();
    let defaultNext = 'continue_path';
    try {
      const parsed = JSON.parse(prompt);
      if (typeof parsed?.defaultNext === 'string' && parsed.defaultNext) {
        defaultNext = parsed.defaultNext;
      }
    } catch {
      // use default
    }
    return JSON.stringify({
      headline: 'Stubbed AI Coach Headline',
      why: 'Stubbed AI Coach explanation grounded in this round performance.',
      next: defaultNext,
      summary: 'Learner summary updated from round debrief.',
      bullets: [],
    });
  };
}

async function seedFlashcardRun(host, language = 'zh', count = 1) {
  const sampleRes = await host.call('sample.load', { language });
  assert.equal(sampleRes.ok, true, sampleRes.error?.message);
  const deckId = sampleRes.value?.deckId;
  assert.ok(deckId, 'sample.load must expose deckId');

  const deckRes = await host.call('deck.get', { id: deckId });
  assert.equal(deckRes.ok, true, deckRes.error?.message);
  const flashcards = (deckRes.value?.cards || []).filter((c) => c.kind === 'flashcard');
  assert.ok(flashcards.length >= count, `sample deck must have at least ${count} flashcards`);

  const scope = flashcards.slice(0, count).map((c) => ({ deckId, cardId: c.id }));
  const startRes = await host.call('review.start', {
    mode: 'path',
    scope,
    fresh: true,
  });
  assert.equal(startRes.ok, true, startRes.error?.message);
  const run = startRes.value;
  assert.ok(run?.id, 'review.start must return a run id');
  return { deckId, run, cards: flashcards.slice(0, count) };
}

after(async () => {
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

describe('Round 53: RoundSummary Post-Round Coaching Debrief (coach.debrief) with P2 ConfirmDialog Guard', () => {
  test('1) createTuiHost integration: coach.debrief returns version 2 debrief, caches on second call (0 extra model calls), and rejects exam runs', async () => {
    const base = await makeTempDir('host-int');
    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot: join(base, 'library'),
      env: { ...process.env, DSH_HOME: join(base, 'dsh-home') },
      home: base,
      documentsDir: base,
      injectedComplete: createDebriefStubComplete(() => {
        modelCalls += 1;
      }),
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      const { deckId, run } = await seedFlashcardRun(host, 'en', 3);
      assert.equal(modelCalls, 0, 'seeding run must make 0 model calls');

      let currentRun = run;
      const total = currentRun.navigation?.length ?? 0;
      assert.equal(total, 3, 'seeded path run must have 3 cards');
      for (let i = 0; i < total; i += 1) {
        if (currentRun.index !== i) {
          const moved = await host.call('review.move', { runId: currentRun.id, index: i });
          assert.equal(moved.ok, true, moved.error?.message);
          currentRun = moved.value;
        }
        const cardId = currentRun.card?.id || currentRun.navigation?.[i]?.cardId;
        assert.ok(cardId, `run must expose active cardId at step ${i}`);
        const rev = await host.call('review.reveal', { runId: currentRun.id, cardId });
        assert.equal(rev.ok, true, rev.error?.message);
        const ans = await host.call('review.answer', { runId: currentRun.id, cardId, grade: 4 });
        assert.equal(ans.ok, true, ans.error?.message);
        currentRun = ans.value;
      }
      assert.equal(currentRun.answered, 3, 'all 3 cards must be answered');
      assert.equal(modelCalls, 0, 'answering flashcards must make 0 model calls');

      // First coach.debrief call with >= 3 answered invokes light model once
      const firstDebrief = await host.call('coach.debrief', { runId: run.id });
      assert.equal(firstDebrief.ok, true, firstDebrief.error?.message);
      assert.equal(firstDebrief.value?.version, 2);
      assert.equal(firstDebrief.value?.answered, 3);
      assert.equal(firstDebrief.value?.headline, 'Stubbed AI Coach Headline');
      assert.equal(firstDebrief.value?.why, 'Stubbed AI Coach explanation grounded in this round performance.');
      assert.equal(firstDebrief.value?.next, 'continue_path');
      assert.equal(modelCalls, 1, 'first coach.debrief with 3 answered must make exactly 1 model call');

      // Second coach.debrief call hits run.debrief cache with 0 extra model calls
      const secondDebrief = await host.call('coach.debrief', { runId: run.id });
      assert.equal(secondDebrief.ok, true, secondDebrief.error?.message);
      assert.equal(secondDebrief.value?.version, 2);
      assert.equal(secondDebrief.value?.headline, firstDebrief.value?.headline);
      assert.equal(secondDebrief.value?.why, firstDebrief.value?.why);
      assert.equal(secondDebrief.value?.next, firstDebrief.value?.next);
      assert.equal(modelCalls, 1, 'cached coach.debrief must trigger 0 extra model calls');

      // Exam run must reject coach.debrief with 0 model calls
      const examStart = await host.call('review.start', { mode: 'exam', deckId, count: 2, fresh: true });
      assert.equal(examStart.ok, true, examStart.error?.message);
      const examDebrief = await host.call('coach.debrief', { runId: examStart.value.id });
      assert.equal(examDebrief.ok, false, 'coach.debrief must reject exam mode');
      assert.match(String(examDebrief.error?.message || ''), /模拟考试请看成绩单/);
      assert.equal(modelCalls, 1, 'rejected exam coach.debrief must trigger 0 extra model calls');
    } finally {
      await host.dispose();
    }
  });

  test('2) @xterm/headless PTY E2E: RoundSummary [d] -> ConfirmDialog (n cancels with 0 calls, y loads debrief modal, Esc/d closes) at 120x36 (zh) and 80x24 (--ascii en)', async () => {
    const beforeResources = resourceCounts();

    // Part A: 120x36 zh
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
        injectedComplete: createDebriefStubComplete(() => {
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
        const { run } = await seedFlashcardRun(host, 'zh', 1);

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

        await tty.waitFor(
          (s) => s.includes('按 [Space] 或 [Enter] 翻开答案'),
          { timeoutMs: 10_000, label: 'zh ReviewView 1-card flashcard ready' },
        );

        tty.send(' ');
        await tty.waitFor(
          (s) => s.includes('答案与解析') && s.includes('良好'),
          { timeoutMs: 8_000, label: 'zh ReviewView revealed' },
        );

        tty.send('3');
        const summaryScreen = await tty.waitFor(
          (s) => s.includes('本轮练习总结') && s.includes('AI复盘') && !s.includes('加载本轮回顾'),
          { timeoutMs: 10_000, label: 'zh RoundSummary rendered with [d] AI复盘 hint' },
        );
        tty.assertHealthyScreen(summaryScreen, 120, 36, '120x36 zh RoundSummary');

        const callsBeforeD = modelCalls;
        tty.send('d');
        const confirmScreen = await tty.waitFor(
          (s) =>
            s.includes('AI 教练本轮复盘') &&
            s.includes('获取点评 (y)') &&
            s.replace(/\s+/g, ' ').includes('教练本轮复盘点评'),
          { timeoutMs: 5_000, label: 'zh ConfirmDialog opened on [d]' },
        );
        tty.assertHealthyScreen(confirmScreen, 120, 36, '120x36 zh ConfirmDialog');
        assert.equal(modelCalls, callsBeforeD, 'opening ConfirmDialog must make 0 model calls');

        // Press 'n' -> cancels cleanly with 0 model calls
        tty.send('n');
        const cancelledScreen = await tty.waitFor(
          (s) => s.includes('本轮练习总结') && !s.includes('获取点评 (y)'),
          { timeoutMs: 5_000, label: 'zh ConfirmDialog cancelled with [n]' },
        );
        tty.assertHealthyScreen(cancelledScreen, 120, 36, '120x36 zh after cancel');
        assert.equal(modelCalls, callsBeforeD, 'cancelling ConfirmDialog must make 0 model calls');

        // Press 'd' then 'y' -> loads debrief modal
        tty.send('d');
        await tty.waitFor(
          (s) => s.includes('获取点评 (y)'),
          { timeoutMs: 5_000, label: 'zh ConfirmDialog reopened' },
        );
        tty.send('y');
        const debriefScreen = await tty.waitFor(
          (s) =>
            s.includes('AI 教练本轮复盘') &&
            s.includes('建议下一步') &&
            (s.includes('状态不错') || s.includes('继续学习路径')) &&
            s.includes('原因分析'),
          { timeoutMs: 8_000, label: 'zh DebriefModal rendered' },
        );
        tty.assertHealthyScreen(debriefScreen, 120, 36, '120x36 zh DebriefModal');

        // Esc closes debrief modal back to RoundSummary
        tty.send('\x1b');
        const closedScreen = await tty.waitFor(
          (s) => s.includes('本轮练习总结') && s.includes('查看复盘') && !s.includes('原因分析'),
          { timeoutMs: 5_000, label: 'zh DebriefModal closed via Esc' },
        );
        tty.assertHealthyScreen(closedScreen, 120, 36, '120x36 zh after Esc close');

        // Pressing 'd' again opens cached debrief directly without ConfirmDialog
        tty.send('d');
        const reopenedScreen = await tty.waitFor(
          (s) => s.includes('AI 教练本轮复盘') && s.includes('原因分析') && !s.includes('获取点评 (y)'),
          { timeoutMs: 5_000, label: 'zh DebriefModal reopened from cache directly' },
        );
        tty.assertHealthyScreen(reopenedScreen, 120, 36, '120x36 zh cached DebriefModal');
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
        injectedComplete: createDebriefStubComplete(() => {
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
        const { run } = await seedFlashcardRun(host, 'en', 1);

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

        await tty.waitFor(
          (s) => s.includes('Press [Space] or [Enter] to flip card'),
          { timeoutMs: 10_000, label: 'en ASCII ReviewView 1-card flashcard ready' },
        );

        tty.send(' ');
        await tty.waitFor(
          (s) => s.includes('Good'),
          { timeoutMs: 8_000, label: 'en ASCII ReviewView revealed' },
        );

        tty.send('3');
        const summaryScreen = await tty.waitFor(
          (s) => s.includes('Round Summary') && s.includes('Debrief') && !s.includes('Loading look-back'),
          { timeoutMs: 10_000, label: 'en ASCII RoundSummary rendered' },
        );
        tty.assertHealthyScreen(summaryScreen, 80, 24, '80x24 en ASCII RoundSummary');
        tty.assertAsciiPure(summaryScreen, '80x24 en ASCII RoundSummary');

        const callsBeforeD = modelCalls;
        tty.send('d');
        const confirmScreen = await tty.waitFor(
          (s) =>
            s.includes('AI Coach Round Debrief') &&
            s.includes('Get Debrief (y)') &&
            s.replace(/\s+/g, ' ').includes('Request AI Coach debrief'),
          { timeoutMs: 5_000, label: 'en ASCII ConfirmDialog opened on [d]' },
        );
        tty.assertHealthyScreen(confirmScreen, 80, 24, '80x24 en ASCII ConfirmDialog');
        tty.assertAsciiPure(confirmScreen, '80x24 en ASCII ConfirmDialog');
        assert.equal(modelCalls, callsBeforeD, 'opening ConfirmDialog must make 0 model calls');

        // Press 'n' -> cancels cleanly
        tty.send('n');
        const cancelledScreen = await tty.waitFor(
          (s) => s.includes('Round Summary') && !s.includes('Get Debrief (y)'),
          { timeoutMs: 5_000, label: 'en ASCII ConfirmDialog cancelled with [n]' },
        );
        tty.assertHealthyScreen(cancelledScreen, 80, 24, '80x24 en ASCII after cancel');
        tty.assertAsciiPure(cancelledScreen, '80x24 en ASCII after cancel');
        assert.equal(modelCalls, callsBeforeD, 'cancelling ConfirmDialog must make 0 model calls');

        // Press 'd' then 'y' -> invokes coach.debrief & shows DebriefModal
        tty.send('d');
        await tty.waitFor(
          (s) => s.includes('Get Debrief (y)'),
          { timeoutMs: 5_000, label: 'en ASCII ConfirmDialog reopened' },
        );
        tty.send('y');
        const debriefScreen = await tty.waitFor(
          (s) =>
            s.includes('AI Coach Debrief') &&
            s.includes('Next:') &&
            s.includes('Why:') &&
            (s.includes('Good momentum') || s.includes('Continue Path')),
          { timeoutMs: 8_000, label: 'en ASCII DebriefModal rendered' },
        );
        tty.assertHealthyScreen(debriefScreen, 80, 24, '80x24 en ASCII DebriefModal');
        tty.assertAsciiPure(debriefScreen, '80x24 en ASCII DebriefModal');

        // Press 'd' (or Esc) closes DebriefModal cleanly back to RoundSummary
        tty.send('d');
        const closedScreen = await tty.waitFor(
          (s) => s.includes('Round Summary') && !s.includes('AI Coach Debrief'),
          { timeoutMs: 5_000, label: 'en ASCII DebriefModal closed with [d]' },
        );
        tty.assertHealthyScreen(closedScreen, 80, 24, '80x24 en ASCII after [d] close');
        tty.assertAsciiPure(closedScreen, '80x24 en ASCII after [d] close');
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
