// Round 72 Track 1: WrongBookView `/` Live Wrong-Card Search & Filter (0 LLM tokens):
// `node --test --test-concurrency=1 tests/round72-wrongbook-filter.test.mjs`
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
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

const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const { StudyHubTuiApp } = await import(pathToFileURL(join(distDir, 'App.mjs')).href);

let createTuiHost = null;
let saveTuiPreferences = null;
let displayWidth = null;
let useDistTuiStore = null;
let DEFAULT_PREFERENCES = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('store-') || f.startsWith('chunk-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!createTuiHost && typeof mod.createTuiHost === 'function') createTuiHost = mod.createTuiHost;
    if (!saveTuiPreferences && typeof mod.saveTuiPreferences === 'function') saveTuiPreferences = mod.saveTuiPreferences;
    if (!displayWidth && typeof mod.displayWidth === 'function') displayWidth = mod.displayWidth;
    if (!useDistTuiStore && typeof mod.useTuiStore?.getState === 'function') useDistTuiStore = mod.useTuiStore;
    if (!DEFAULT_PREFERENCES && mod.DEFAULT_PREFERENCES) DEFAULT_PREFERENCES = mod.DEFAULT_PREFERENCES;
  }
}
assert.ok(createTuiHost, 'dist/ must export createTuiHost');
assert.ok(saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(displayWidth, 'dist/ must export displayWidth');
assert.ok(useDistTuiStore, 'dist/ must export useTuiStore');
assert.ok(DEFAULT_PREFERENCES, 'dist/ must export DEFAULT_PREFERENCES');

function resetDistStore(language = 'zh', asciiMode = false) {
  useDistTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    snapshot: null,
    binding: null,
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
      language,
      asciiMode,
    },
  });
}

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];

async function makeTempDir(label) {
  const d = await mkdtemp(join(os.tmpdir(), `studyhub-r72-wb-filter-${label}-`));
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
    assert.ok(!screen.includes('\x1b'), `${label}: unparsed escape sequence leaked`);
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

function itemHaystack(item) {
  return [
    item.prompt,
    item.topic,
    item.deckTitle,
    item.errorReason,
    item.triage?.course,
    item.cardId,
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
}

function pickUniqueKeyword(targetItem, allItems) {
  const candidates = [];
  const promptText = String(targetItem.prompt || '');
  const asciiWords = promptText.match(/[A-Za-z][A-Za-z0-9_-]{3,}/g) || [];
  candidates.push(...asciiWords);
  for (let len = 4; len <= 10; len += 1) {
    for (let i = 0; i + len <= promptText.length; i += 1) {
      const slice = promptText.slice(i, i + len).trim();
      if (slice.length >= 3 && !/[\s$]/.test(slice)) candidates.push(slice);
    }
  }
  if (targetItem.topic) candidates.push(String(targetItem.topic));
  candidates.push(String(targetItem.cardId));

  for (const raw of candidates) {
    const kw = raw.trim();
    if (!kw) continue;
    const needle = kw.toLowerCase();
    const hits = allItems.filter((it) => itemHaystack(it).includes(needle));
    if (hits.length === 1 && hits[0].cardId === targetItem.cardId) {
      return kw;
    }
  }
  return String(targetItem.cardId);
}

async function answerCurrentCardWrong(tty, host, runId, cardNumberLabel) {
  const runInfo = await host.call('review.get', { runId });
  assert.equal(runInfo.ok, true, runInfo.error?.message);
  const card = runInfo.value?.card;
  assert.ok(card?.id, `Card ${cardNumberLabel} must exist in review.get`);

  if (card.kind === 'quiz' && Array.isArray(card.options) && card.options.length > 0) {
    const wrongIdx = card.options.findIndex((o) => !o.correct);
    const pick = wrongIdx >= 0 ? wrongIdx + 1 : 1;
    tty.send(String(pick));
    await tty.waitFor(
      (s) => s.includes('下一题') || s.includes('错因') || s.includes('参考答案') || s.includes('解析'),
      { timeoutMs: 6_000, label: `Card ${cardNumberLabel} MCQ wrong answer feedback` },
    );
  } else if (card.kind === 'truefalse') {
    const wrongKey = String(card.answer).toLowerCase() === 'true' ? '2' : '1';
    tty.send(wrongKey);
    await tty.waitFor(
      (s) => s.includes('下一题') || s.includes('参考答案') || s.includes('解析'),
      { timeoutMs: 6_000, label: `Card ${cardNumberLabel} TF wrong answer feedback` },
    );
  } else if (card.kind === 'cloze') {
    tty.send('__wrong_cloze__');
    await sleep(60);
    tty.send('\r');
    await tty.waitFor(
      (s) => s.includes('下一题') || s.includes('参考答案') || s.includes('解析'),
      { timeoutMs: 6_000, label: `Card ${cardNumberLabel} cloze wrong answer feedback` },
    );
  } else {
    tty.send(' ');
    await tty.waitFor(
      (s) => !s.includes('翻开答案') && (s.includes('0') || s.includes('评分') || s.includes('参考答案')),
      { timeoutMs: 6_000, label: `Card ${cardNumberLabel} flashcard flipped` },
    );
    tty.send('1');
    await tty.waitFor(
      (s) => s.includes('回答有误') || s.includes('下一题'),
      { timeoutMs: 6_000, label: `Card ${cardNumberLabel} flashcard rated 1 (wrong)` },
    );
  }
}

after(async () => {
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await Promise.all(
    tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
});

describe('Round 72 Track 1: WrongBookView `/` Live Wrong-Card Search & Filter', () => {
  test('1) @xterm/headless PTY E2E (120x36 zh): load sample -> answer 2 cards wrong -> WrongBook (4) -> `/` filter -> Enter -> Esc clears (0 model calls)', async () => {
    const base = await makeTempDir('pty-zh');
    const dshHome = join(base, 'dsh-home');
    const libraryRoot = join(base, 'library');
    process.env.DSH_HOME = dshHome;

    await saveTuiPreferences(
      { language: 'zh', asciiMode: false, theme: 'dsh-dark', mathUnicode: true, showHints: true },
      { env: { ...process.env, DSH_HOME: dshHome } },
    );

    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot,
      env: { ...process.env, DSH_HOME: dshHome },
      home: join(base, 'home'),
      documentsDir: base,
      skipAutoProbe: true,
      injectedComplete: async () => {
        modelCalls += 1;
        return 'Stub';
      },
      language: 'zh',
      eventDebounceMs: 30,
    });

    const tty = createVirtualTty(120, 36);
    let inkInst = null;
    try {
      resetDistStore('zh', false);
      inkInst = render(
        React.createElement(StudyHubTuiApp, {
          host,
          initialPage: 'library',
          initialLanguage: 'zh',
          initialAsciiMode: false,
          autoLaunchpad: true,
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
      await tty.waitFor((s) => s.includes('载入示例课程体验'), { label: 'zh Launchpad' });

      // Load sample course via 's'
      tty.send('s');
      await tty.waitFor(
        (s) => !s.includes('载入示例课程体验') && s.includes('示例 · Memento 与 Bridge'),
        { timeoutMs: 12_000, label: 'zh sample loaded' },
      );

      // Start review round on the selected sample deck and answer 2 cards wrong
      await sleep(200);
      await tty.flush();
      tty.send('\r');
      await tty.waitFor(
        (s) =>
          useDistTuiStore.getState().page === 'review' &&
          Boolean(useDistTuiStore.getState().activeRunId) &&
          !s.includes('正在加载练习') &&
          s.includes('1/'),
        { timeoutMs: 10_000, label: 'Fresh review round started' },
      );
      const activeRunId = useDistTuiStore.getState().activeRunId;
      await answerCurrentCardWrong(tty, host, activeRunId, 1);

      // Advance to card 2 if still on card 1
      const afterCard1 = await host.call('review.get', { runId: activeRunId });
      if ((afterCard1.value?.index ?? 0) === 0) {
        tty.send('\r');
        await tty.waitFor((s) => s.includes('2/'), { timeoutMs: 6_000, label: 'Advanced to card 2' });
      }
      await answerCurrentCardWrong(tty, host, activeRunId, 2);

      // End round cleanly ('q' -> 'y')
      tty.send('q');
      await tty.waitFor((s) => s.includes('结束本轮练习'), { timeoutMs: 6_000, label: 'End round dialog' });
      tty.send('y');
      await tty.waitFor((s) => !s.includes('结束本轮练习'), { timeoutMs: 6_000, label: 'Exited review round' });

      // Navigate to WrongBook ('4')
      tty.send('4');
      const wbScreen = await tty.waitFor(
        (s) =>
          s.includes('错题列表') &&
          !s.includes('正在加载错题本') &&
          useDistTuiStore.getState().footerHints.some((h) => h.key === '/' && h.label === '筛选'),
        { timeoutMs: 10_000, label: 'zh WrongBookView with `/` hint' },
      );
      tty.assertHealthyScreen(wbScreen, 120, 36, 'zh WrongBookView 120x36');

      const wbRes = await host.call('wrongbook', { course: '*', view: 'weak', offset: 0, limit: 50 });
      assert.equal(wbRes.ok, true);
      const items = wbRes.value?.items ?? [];
      assert.ok(items.length >= 2, `Expected >= 2 wrongbook items, got ${items.length}`);
      const total = items.length;
      const card1 = items[0];
      const card2 = items[1];
      const keyword = pickUniqueKeyword(card2, items);
      const card2PromptHead = String(card2.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 8);
      const card1Unique = pickUniqueKeyword(card1, items);

      // Press '/' to open inline filter bar (must NOT open CommandPalette)
      tty.send('/');
      await tty.waitFor(
        (s) =>
          !useDistTuiStore.getState().commandPaletteOpen &&
          useDistTuiStore.getState().inputCaptured &&
          s.includes(`[筛选 ${total}/${total}]`),
        { timeoutMs: 5_000, label: 'zh WrongBookView filter bar opened' },
      );

      // Type unique keyword from card 2 (lower-cased to also exercise case-insensitive matching)
      tty.send(keyword.toLowerCase());
      const filteredEditing = await tty.waitFor(
        (s) =>
          s.includes(`[筛选 1/${total}]`) &&
          (!card2PromptHead || s.includes(card2PromptHead)),
        { timeoutMs: 5_000, label: 'zh WrongBookView filtered to card 2 while editing' },
      );
      tty.assertHealthyScreen(filteredEditing, 120, 36, 'zh WrongBookView filtered editing');
      assert.equal(useDistTuiStore.getState().page, 'wrongbook', 'typing filter keyword must stay on wrongbook');

      // Press Enter to confirm/blur keeping filter active with match count badge
      tty.send('\r');
      const filteredConfirmed = await tty.waitFor(
        (s) =>
          !useDistTuiStore.getState().inputCaptured &&
          s.includes(`[筛选 1/${total}]`) &&
          (!card2PromptHead || s.includes(card2PromptHead)) &&
          useDistTuiStore.getState().page === 'wrongbook',
        { timeoutMs: 5_000, label: 'zh WrongBookView filter confirmed on Enter' },
      );
      tty.assertHealthyScreen(filteredConfirmed, 120, 36, 'zh WrongBookView filter confirmed');

      // Verify clamped selectedIndex targets the highlighted filtered item (Space selects card 2)
      tty.send(' ');
      await tty.waitFor((s) => s.includes('已选 1'), { timeoutMs: 5_000, label: 'Space selected filtered card' });
      tty.send('x');
      await tty.waitFor((s) => !s.includes('已选 1'), { timeoutMs: 5_000, label: 'x cleared selection' });

      // Press Esc in normal mode to clear filter and restore full list
      tty.send('\x1b');
      const restoredScreen = await tty.waitFor(
        (s) =>
          !s.includes('[筛选 ') &&
          (!card1Unique || s.includes(card1Unique) || s.includes(String(card1.prompt || '').slice(0, 6))),
        { timeoutMs: 5_000, label: 'zh WrongBookView filter cleared on Esc' },
      );
      tty.assertHealthyScreen(restoredScreen, 120, 36, 'zh WrongBookView restored');
      assert.equal(modelCalls, 0, 'WrongBookView `/` filter must invoke 0 model calls');
    } finally {
      try {
        inkInst?.unmount();
      } catch {
        // ignore
      }
      await host.dispose();
      tty.dispose();
    }
  });

  test('2) @xterm/headless PTY E2E (80x24 --ascii en): WrongBook (4) -> `/` filter -> Enter -> Esc -> assertHealthyScreen + assertAsciiPure', async () => {
    const base = await makeTempDir('pty-ascii-en');
    const dshHome = join(base, 'dsh-home');
    const libraryRoot = join(base, 'library');
    process.env.DSH_HOME = dshHome;

    await saveTuiPreferences(
      { language: 'en', asciiMode: true, theme: 'dsh-dark', mathUnicode: false, showHints: true },
      { env: { ...process.env, DSH_HOME: dshHome } },
    );

    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot,
      env: { ...process.env, DSH_HOME: dshHome },
      home: join(base, 'home'),
      documentsDir: base,
      skipAutoProbe: true,
      injectedComplete: async () => {
        modelCalls += 1;
        return 'Stub';
      },
      language: 'en',
      eventDebounceMs: 30,
    });

    const tty = createVirtualTty(80, 24);
    let inkInst = null;
    try {
      resetDistStore('en', true);
      inkInst = render(
        React.createElement(StudyHubTuiApp, {
          host,
          initialPage: 'library',
          initialLanguage: 'en',
          initialAsciiMode: true,
          autoLaunchpad: true,
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
      await tty.waitFor((s) => s.includes('Load the sample course'), { label: 'en Launchpad' });

      tty.send('s');
      await tty.waitFor(
        (s) => !s.includes('Load the sample course') && s.includes('Memento'),
        { timeoutMs: 12_000, label: 'en sample loaded' },
      );

      tty.send('4');
      const wbScreen = await tty.waitFor(
        (s) =>
          s.includes('Mistakes') &&
          !s.includes('Loading mistakes') &&
          useDistTuiStore.getState().footerHints.some((h) => h.key === '/' && h.label === 'Filter'),
        { timeoutMs: 10_000, label: 'en WrongBookView 80x24 with `/` hint' },
      );
      tty.assertHealthyScreen(wbScreen, 80, 24, 'en WrongBookView 80x24');
      tty.assertAsciiPure(wbScreen, 'en WrongBookView 80x24');

      const wbRes = await host.call('wrongbook', { course: '*', view: 'weak', offset: 0, limit: 50 });
      assert.equal(wbRes.ok, true);
      const items = wbRes.value?.items ?? [];
      assert.ok(items.length >= 2, `Expected >= 2 sample wrongbook items, got ${items.length}`);
      const total = items.length;
      const targetItem = items[1];
      const keyword = pickUniqueKeyword(targetItem, items);

      // Press '/' to open inline filter bar
      tty.send('/');
      const openBar = await tty.waitFor(
        (s) =>
          !useDistTuiStore.getState().commandPaletteOpen &&
          useDistTuiStore.getState().inputCaptured &&
          s.includes(`[Filter ${total}/${total}]`),
        { timeoutMs: 5_000, label: 'en WrongBookView filter bar opened 80x24' },
      );
      tty.assertHealthyScreen(openBar, 80, 24, 'en WrongBookView filter bar opened 80x24');
      tty.assertAsciiPure(openBar, 'en WrongBookView filter bar opened 80x24');

      // Type unique keyword from target item
      tty.send(keyword.toLowerCase());
      const filteredEditing = await tty.waitFor(
        (s) => s.includes(`[Filter 1/${total}]`),
        { timeoutMs: 5_000, label: 'en WrongBookView filtered 1/N while editing 80x24' },
      );
      tty.assertHealthyScreen(filteredEditing, 80, 24, 'en WrongBookView filtered editing 80x24');
      tty.assertAsciiPure(filteredEditing, 'en WrongBookView filtered editing 80x24');

      // Press Enter to confirm/blur
      tty.send('\r');
      const filteredConfirmed = await tty.waitFor(
        (s) =>
          !useDistTuiStore.getState().inputCaptured &&
          s.includes(`[Filtered 1/${total}]`) &&
          useDistTuiStore.getState().page === 'wrongbook',
        { timeoutMs: 5_000, label: 'en WrongBookView filter confirmed on Enter 80x24' },
      );
      tty.assertHealthyScreen(filteredConfirmed, 80, 24, 'en WrongBookView filter confirmed 80x24');
      tty.assertAsciiPure(filteredConfirmed, 'en WrongBookView filter confirmed 80x24');

      // Press Esc in normal mode to clear filter
      tty.send('\x1b');
      const restoredScreen = await tty.waitFor(
        (s) => !s.includes('[Filtered ') && !s.includes('[Filter '),
        { timeoutMs: 5_000, label: 'en WrongBookView filter cleared on Esc 80x24' },
      );
      tty.assertHealthyScreen(restoredScreen, 80, 24, 'en WrongBookView restored 80x24');
      tty.assertAsciiPure(restoredScreen, 'en WrongBookView restored 80x24');
      assert.equal(modelCalls, 0, 'WrongBookView `/` filter must invoke 0 model calls');
    } finally {
      try {
        inkInst?.unmount();
      } catch {
        // ignore
      }
      await host.dispose();
      tty.dispose();
    }
  });
});
