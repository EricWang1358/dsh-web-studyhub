// Round 54 CardToolsModal Failed Rewrite Retry (coach.rewrite.retry) with P2 ConfirmDialog Guard
// + HelpOverlay & docs/KEYBINDINGS.md sync
// createTuiHost integration + @xterm/headless PTY E2E tests:
// node --test --test-concurrency=1 tests/round54-card-retry.test.mjs
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
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round54-${label}-`));
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

describe('Round 54: CardToolsModal [R] Failed Rewrite Retry (coach.rewrite.retry) with P2 Guard & HelpOverlay Sync', () => {
  test('1) createTuiHost integration: coach.rewrite.retry on card without failed rewrite returns normalized error with 0 model calls', async () => {
    const base = await makeTempDir('host-int');
    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot: join(base, 'library'),
      env: { ...process.env, DSH_HOME: join(base, 'dsh-home') },
      home: base,
      documentsDir: base,
      injectedComplete: async () => {
        modelCalls += 1;
        throw new Error('Unexpected model call during coach.rewrite.retry negative test');
      },
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'zh',
    });

    try {
      const { deckId, cards } = await seedFlashcardRun(host, 'zh', 1);
      const cardId = cards[0].id;
      assert.equal(modelCalls, 0, 'seeding sample deck must make 0 model calls');

      const retryRes = await host.call('coach.rewrite.retry', { deckId, cardId });
      assert.equal(retryRes.ok, false, 'coach.rewrite.retry without failed rewrite must fail cleanly');
      assert.match(String(retryRes.error?.message || ''), /没有待重试的改题/);
      assert.equal(modelCalls, 0, 'coach.rewrite.retry without failed rewrite must trigger 0 model calls');
    } finally {
      await host.dispose();
    }
  });

  test('2) @xterm/headless PTY E2E: CardToolsModal [R] -> P2 ConfirmDialog (n cancels 0 calls, y handles error toast) + HelpOverlay at 120x36 (zh) & 80x24 (--ascii en)', async () => {
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
        injectedComplete: async () => {
          modelCalls += 1;
          throw new Error('Unexpected model call in Round 54 zh PTY E2E');
        },
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
          { timeoutMs: 10_000, label: 'zh ReviewView ready' },
        );

        // Open CardToolsModal via [D]
        tty.send('D');
        const menuScreen = await tty.waitFor(
          (s) => s.includes('题目工具箱') && s.includes('[R] 重试失败的 AI 改题') && s.includes('coach.rewrite.retry'),
          { timeoutMs: 8_000, label: 'zh CardToolsModal menu rendered with [R]' },
        );
        tty.assertHealthyScreen(menuScreen, 120, 36, '120x36 zh CardToolsModal menu');
        assert.equal(modelCalls, 0, 'opening CardToolsModal must make 0 model calls');

        // Press [R] -> P2 ConfirmDialog opens with 0 model calls
        tty.send('R');
        const confirmScreen = await tty.waitFor(
          (s) =>
            s.includes('重试 AI 改题任务') &&
            s.includes('确认重试 (y)') &&
            s.includes('coach.rewrite.retry'),
          { timeoutMs: 5_000, label: 'zh ConfirmDialog opened on [R]' },
        );
        tty.assertHealthyScreen(confirmScreen, 120, 36, '120x36 zh ConfirmDialog');
        assert.equal(modelCalls, 0, 'opening P2 ConfirmDialog must make 0 model calls');

        // Press [n] -> cancels cleanly back to menu with 0 model calls
        tty.send('n');
        const cancelledScreen = await tty.waitFor(
          (s) => s.includes('[R] 重试失败的 AI 改题') && !s.includes('确认重试 (y)'),
          { timeoutMs: 5_000, label: 'zh ConfirmDialog cancelled via [n]' },
        );
        tty.assertHealthyScreen(cancelledScreen, 120, 36, '120x36 zh CardToolsModal after cancel');
        assert.equal(modelCalls, 0, 'cancelling ConfirmDialog must make 0 model calls');

        // Press [R] then [y] -> calls coach.rewrite.retry, handles no-pending-rewrite cleanly with toast/info feedback
        tty.send('R');
        await tty.waitFor(
          (s) => s.includes('确认重试 (y)'),
          { timeoutMs: 5_000, label: 'zh ConfirmDialog reopened on [R]' },
        );
        tty.send('y');
        const retryResultScreen = await tty.waitFor(
          (s) =>
            s.includes('[R] 重试失败的 AI 改题') &&
            !s.includes('确认重试 (y)') &&
            s.includes('没有待重试的改题'),
          { timeoutMs: 8_000, label: 'zh coach.rewrite.retry handled cleanly with error toast/info' },
        );
        tty.assertHealthyScreen(retryResultScreen, 120, 36, '120x36 zh after coach.rewrite.retry');
        assert.equal(modelCalls, 0, 'coach.rewrite.retry without failed task must make 0 model calls');

        // Close CardToolsModal via Esc and verify HelpOverlay [?]
        tty.send('\x1b');
        await tty.waitFor(
          (s) => !s.includes('题目工具箱') && s.includes('按 [Space] 或 [Enter] 翻开答案'),
          { timeoutMs: 5_000, label: 'zh CardToolsModal closed' },
        );

        tty.send('?');
        const helpOpenScreen = await tty.waitFor(
          (s) => s.includes('快捷键') && s.includes('全局'),
          { timeoutMs: 5_000, label: 'zh HelpOverlay opened' },
        );
        tty.assertHealthyScreen(helpOpenScreen, 120, 36, '120x36 zh HelpOverlay');

        let helpReviewScreen = helpOpenScreen;
        for (let step = 0; step < 12 && !helpReviewScreen.includes('卡片工具 (编辑/反馈/重试改题)'); step += 1) {
          tty.send('\x04');
          await tty.flush();
          helpReviewScreen = tty.readScreen();
        }
        assert.ok(
          helpReviewScreen.includes('卡片工具 (编辑/反馈/重试改题)'),
          `zh HelpOverlay must include updated Review [D] label.\n${helpReviewScreen}`,
        );
        tty.assertHealthyScreen(helpReviewScreen, 120, 36, '120x36 zh HelpOverlay Review [D]');

        let helpNotesScreen = helpReviewScreen;
        for (
          let step = 0;
          step < 16 && !(helpNotesScreen.includes('AI起草笔记正文') && helpNotesScreen.includes('停止笔记/每日总结生成'));
          step += 1
        ) {
          tty.send('\x04');
          await tty.flush();
          helpNotesScreen = tty.readScreen();
        }
        assert.ok(
          helpNotesScreen.includes('AI起草笔记正文') && helpNotesScreen.includes('停止笔记/每日总结生成'),
          `zh HelpOverlay must include Skeleton & Notes [g] and [C] labels.\n${helpNotesScreen}`,
        );
        tty.assertHealthyScreen(helpNotesScreen, 120, 36, '120x36 zh HelpOverlay Skeleton & Notes');

        tty.send('\x1b');
        await tty.waitFor(
          (s) => !s.includes('快捷键'),
          { timeoutMs: 5_000, label: 'zh HelpOverlay closed' },
        );
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
        injectedComplete: async () => {
          modelCalls += 1;
          throw new Error('Unexpected model call in Round 54 en --ascii PTY E2E');
        },
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
          { timeoutMs: 10_000, label: 'en ASCII ReviewView ready' },
        );

        // Open CardToolsModal via [D]
        tty.send('D');
        const menuScreen = await tty.waitFor(
          (s) => s.includes('Card Tools') && s.includes('[R] Retry Failed AI Rewrite') && s.includes('coach.rewrite.retry'),
          { timeoutMs: 8_000, label: 'en ASCII CardToolsModal menu rendered with [R]' },
        );
        tty.assertHealthyScreen(menuScreen, 80, 24, '80x24 en ASCII CardToolsModal menu');
        tty.assertAsciiPure(menuScreen, '80x24 en ASCII CardToolsModal menu');
        assert.equal(modelCalls, 0);

        // Press [R] -> P2 ConfirmDialog opens with 0 model calls
        tty.send('R');
        const confirmScreen = await tty.waitFor(
          (s) =>
            s.includes('Retry Failed AI Rewrite') &&
            s.includes('Retry (y)') &&
            s.includes('coach.rewrite.retry'),
          { timeoutMs: 5_000, label: 'en ASCII ConfirmDialog opened on [R]' },
        );
        tty.assertHealthyScreen(confirmScreen, 80, 24, '80x24 en ASCII ConfirmDialog');
        tty.assertAsciiPure(confirmScreen, '80x24 en ASCII ConfirmDialog');
        assert.equal(modelCalls, 0);

        // Press [n] -> cancels back to menu with 0 model calls
        tty.send('n');
        const cancelledScreen = await tty.waitFor(
          (s) => s.includes('[R] Retry Failed AI Rewrite') && !s.includes('Retry (y)'),
          { timeoutMs: 5_000, label: 'en ASCII ConfirmDialog cancelled via [n]' },
        );
        tty.assertHealthyScreen(cancelledScreen, 80, 24, '80x24 en ASCII after cancel');
        tty.assertAsciiPure(cancelledScreen, '80x24 en ASCII after cancel');
        assert.equal(modelCalls, 0);

        // Press [R] then [y] -> handles no-pending-rewrite cleanly
        tty.send('R');
        await tty.waitFor(
          (s) => s.includes('Retry (y)'),
          { timeoutMs: 5_000, label: 'en ASCII ConfirmDialog reopened on [R]' },
        );
        tty.send('y');
        const retryResultScreen = await tty.waitFor(
          (s) =>
            s.includes('[R] Retry Failed AI Rewrite') &&
            !s.includes('Retry (y)') &&
            s.includes('没有待重试的改题'),
          { timeoutMs: 8_000, label: 'en ASCII coach.rewrite.retry handled cleanly' },
        );
        tty.assertHealthyScreen(retryResultScreen, 80, 24, '80x24 en ASCII after retry');
        tty.assertAsciiPure(retryResultScreen, '80x24 en ASCII after retry');
        assert.equal(modelCalls, 0);

        // Close CardToolsModal and verify HelpOverlay in --ascii mode
        tty.send('\x1b');
        await tty.waitFor(
          (s) => !s.includes('Card Tools') && s.includes('Press [Space] or [Enter] to flip card'),
          { timeoutMs: 5_000, label: 'en ASCII CardToolsModal closed' },
        );

        tty.send('?');
        const helpOpenScreen = await tty.waitFor(
          (s) => s.includes('Keyboard Shortcuts') && s.includes('Global'),
          { timeoutMs: 5_000, label: 'en ASCII HelpOverlay opened' },
        );
        tty.assertHealthyScreen(helpOpenScreen, 80, 24, '80x24 en ASCII HelpOverlay');
        tty.assertAsciiPure(helpOpenScreen, '80x24 en ASCII HelpOverlay');

        let helpReviewScreen = helpOpenScreen;
        for (let step = 0; step < 20 && !helpReviewScreen.includes('Card tools (edit/feedback/retry)'); step += 1) {
          tty.send('\x04');
          await tty.flush();
          helpReviewScreen = tty.readScreen();
        }
        assert.ok(
          helpReviewScreen.includes('Card tools (edit/feedback/retry)'),
          `en ASCII HelpOverlay must include updated Review [D] label.\n${helpReviewScreen}`,
        );
        tty.assertHealthyScreen(helpReviewScreen, 80, 24, '80x24 en ASCII HelpOverlay Review [D]');
        tty.assertAsciiPure(helpReviewScreen, '80x24 en ASCII HelpOverlay Review [D]');

        let helpNotesScreen = helpReviewScreen;
        for (
          let step = 0;
          step < 30 && !(helpNotesScreen.includes('AI draft note') && helpNotesScreen.includes('Stop note / recap gen'));
          step += 1
        ) {
          tty.send('\x04');
          await tty.flush();
          helpNotesScreen = tty.readScreen();
        }
        assert.ok(
          helpNotesScreen.includes('AI draft note') && helpNotesScreen.includes('Stop note / recap gen'),
          `en ASCII HelpOverlay must include Skeleton & Notes [g] and [C] labels.\n${helpNotesScreen}`,
        );
        tty.assertHealthyScreen(helpNotesScreen, 80, 24, '80x24 en ASCII HelpOverlay Skeleton & Notes');
        tty.assertAsciiPure(helpNotesScreen, '80x24 en ASCII HelpOverlay Skeleton & Notes');
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
