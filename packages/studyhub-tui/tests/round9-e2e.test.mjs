// Round 9 Features E2E verification: node --test tests/round9-e2e.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, describe, test } from 'node:test';
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

let H = null;
let R = null;
for (const f of distFiles) {
  if (f.startsWith('host-') || f.startsWith('chunk-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!H && typeof mod.createTuiHost === 'function') H = mod;
    if (!R && typeof mod.displayWidth === 'function') R = mod;
  }
}
assert.ok(H?.createTuiHost, 'dist/ must export createTuiHost');
assert.ok(R?.displayWidth, 'dist/ must export displayWidth');

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round9-${label}-`));
  tempDirs.push(d);
  return d;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Creates a real Ink-compatible virtual TTY backed by `@xterm/headless`.
 */
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

  async function waitFor(predicate, { timeoutMs = 8_000, label = 'condition' } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await flush();
      const screen = readScreen();
      if (predicate(screen)) return screen;
      await sleep(35);
    }
    const finalScreen = readScreen();
    throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms.\n--- SCREEN ---\n${finalScreen}\n--------------`);
  }

  function assertHealthyScreen(screen, expectedCols, contextLabel) {
    const lines = screen.split('\n');
    assert.ok(
      !screen.includes('页面渲染异常') && !screen.includes('View Error'),
      `${contextLabel}: ViewErrorBoundary triggered!\n${screen}`,
    );
    assert.ok(
      !screen.includes('TypeError:') && !screen.includes('ReferenceError:'),
      `${contextLabel}: Runtime JS error rendered!\n${screen}`,
    );
    assert.ok(!screen.includes('\uFFFD'), `${contextLabel}: Replacement char U+FFFD found!\n${screen}`);
    assert.ok(
      !screen.includes('\x1b'),
      `${contextLabel}: Unparsed escape sequence leaked into xterm buffer!\n${screen}`,
    );
    for (let i = 0; i < lines.length; i += 1) {
      const w = R.displayWidth(lines[i]);
      assert.ok(
        w <= expectedCols,
        `${contextLabel}: Row ${i} exceeds cols (${w} > ${expectedCols}): ${JSON.stringify(lines[i])}`,
      );
    }
    const buf = term.buffer.active;
    for (let y = 0; y < term.rows; y += 1) {
      const line = buf.getLine(buf.viewportY + y);
      if (line) {
        assert.equal(
          line.isWrapped,
          false,
          `${contextLabel}: xterm soft-wrapped row ${y}: ${JSON.stringify(line.translateToString(true))}`,
        );
      }
    }
  }

  return {
    stdin,
    stdout,
    stderr,
    term,
    firstFramePromise,
    flush,
    readLines,
    readScreen,
    send,
    waitFor,
    assertHealthyScreen,
    dispose: () => {
      term.dispose();
      stdin.destroy();
      stdout.destroy();
      stderr.destroy();
    },
  };
}

function createRound9StubComplete() {
  return async (_system, prompt) => {
    if (String(prompt || '').includes('OK?')) return 'OK';
    return 'Stub response.';
  };
}

/** Pick an alphanumeric/CJK search token (>= 4 chars) from `text` that matches `searchFn`. */
async function pickMatchingQuery(text, searchFn) {
  const tokens = String(text || '')
    .replace(/[`*_#[\]().,:;!?'"<>]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 4 && !w.startsWith('/'));

  // Prefer ASCII words >= 5 chars first for crisp, unambiguous terminal matching
  const sorted = [
    ...tokens.filter((w) => /^[A-Za-z][A-Za-z0-9_-]{4,}$/.test(w)),
    ...tokens.filter((w) => !/^[A-Za-z][A-Za-z0-9_-]{4,}$/.test(w)),
  ];

  for (const token of sorted) {
    const hit = await searchFn(token);
    if (hit) return token;
  }
  throw new Error(`Could not find a matching search query from text: ${String(text).slice(0, 120)}`);
}

describe('StudyHub TUI Round 9 Features E2E', () => {
  let boxDir;
  let dshHome;
  let libraryRoot;
  let host;
  let tty;
  let inkInstance;
  let disposed = false;

  async function cleanupAll() {
    if (disposed) return;
    disposed = true;
    try {
      inkInstance?.unmount();
    } catch {
      // Ignore unmount errors during teardown
    }
    await host?.dispose();
    tty?.dispose();
  }

  before(async () => {
    boxDir = await makeTempDir('main');
    dshHome = join(boxDir, 'dsh-home');
    libraryRoot = join(boxDir, 'library');
    process.env.DSH_HOME = dshHome;

    host = await H.createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(boxDir, 'home'),
      libraryRoot,
      injectedComplete: createRound9StubComplete(),
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    tty = createVirtualTty(120, 36);
    inkInstance = render(
      React.createElement(StudyHubTuiApp, {
        host,
        autoLaunchpad: true,
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
    await tty.firstFramePromise;
  });

  after(async () => {
    try {
      await cleanupAll();
    } finally {
      if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = PREV_DSH_HOME;
      await Promise.all(
        tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
      );
    }
  });

  test('1) Ctrl+K Live Full-Text Search (card.search -> review, search.content -> sources reader, Esc close)', async () => {
    await tty.waitFor(
      (s) => s.includes('载入示例课程体验') || s.includes('Load the sample course'),
      { label: 'Launchpad render' },
    );

    // Load sample course via 's'
    tty.send('s');
    await tty.waitFor(
      (s) =>
        !s.includes('载入示例课程体验') &&
        (s.includes('示例 · Memento 与 Bridge') || s.includes('Sample · Memento')),
      { timeoutMs: 12_000, label: 'Library after sample load' },
    );
    await sleep(150);
    await tty.flush();

    // Inspect real card prompt & real source passage from the loaded sample course
    const snapRes = await host.refreshSnapshot();
    const decks = (snapRes.snapshot?.decks || []).filter((d) => !d.archived && !d.systemKind);
    assert.ok(decks.length > 0, 'Sample course must load at least one active deck');

    const deckDetailRes = await host.call('deck.get', { id: decks[0].id });
    assert.equal(deckDetailRes.ok, true, 'deck.get should succeed');
    const sampleCards = deckDetailRes.value?.cards || [];
    assert.ok(sampleCards.length > 0, 'Sample deck must contain cards');

    let cardQuery = '';
    let matchedCardPrompt = '';
    for (const card of sampleCards) {
      if (!card?.prompt) continue;
      try {
        cardQuery = await pickMatchingQuery(card.prompt, async (q) => {
          const res = await host.call('card.search', { query: q, limit: 6 });
          return Boolean(res.ok && res.value?.results?.length > 0);
        });
        matchedCardPrompt = String(card.prompt);
        break;
      } catch {
        // Try next card if no isolated token matched
      }
    }
    assert.ok(cardQuery.length >= 2, `Expected valid cardQuery >= 2 chars, got "${cardQuery}"`);

    const sourceListRes = await host.call('source.list', { limit: 20 });
    assert.equal(sourceListRes.ok, true, 'source.list should succeed');
    const sources = (sourceListRes.value?.sources || []).filter((s) => !s.archived);
    assert.ok(sources.length > 0, 'Sample course must load at least one active source');

    let sourceQuery = '';
    let matchedSourceTitle = '';
    for (const src of sources) {
      const srcGetRes = await host.call('source.get', { id: src.id, limit: 2000 });
      const text = srcGetRes.ok ? String(srcGetRes.value?.text || '') : '';
      if (!text) continue;
      try {
        sourceQuery = await pickMatchingQuery(text, async (q) => {
          const res = await host.call('search.content', { query: q, limit: 6, includeSample: true });
          const hits = res.value?.groups?.sources || res.value?.results?.filter((r) => r?.kind === 'source') || [];
          return Boolean(res.ok && hits.length > 0);
        });
        matchedSourceTitle = String(src.title || src.name || src.id);
        break;
      } catch {
        // Try next source
      }
    }
    assert.ok(sourceQuery.length >= 2, `Expected valid sourceQuery >= 2 chars, got "${sourceQuery}"`);

    // 1a) Open CommandPalette with Ctrl+K (\x0b) and verify clean Esc close
    tty.send('\x0b');
    const paletteEmpty = await tty.waitFor(
      (s) => s.includes('命令面板') || s.includes('Command Palette'),
      { label: 'CommandPalette opened via Ctrl+K' },
    );
    tty.assertHealthyScreen(paletteEmpty, 120, 'CommandPalette initial');

    tty.send('\x1b');
    const paletteClosed = await tty.waitFor(
      (s) => !s.includes('命令面板') && !s.includes('Command Palette'),
      { label: 'CommandPalette closed via Esc' },
    );
    tty.assertHealthyScreen(paletteClosed, 120, 'After CommandPalette Esc close');

    // 1b) Search a real card prompt word -> select live Card hit -> navigates to Review
    tty.send('\x0b');
    await tty.waitFor(
      (s) => s.includes('命令面板') || s.includes('Command Palette'),
      { label: 'CommandPalette reopened for card search' },
    );
    tty.send(cardQuery);
    await sleep(260); // > 180ms debounce
    const cardSearchScreen = await tty.waitFor(
      (s) =>
        (s.includes('题库') || s.includes('Card')) &&
        !s.includes('正在全文检索') &&
        !s.includes('Searching'),
      { timeoutMs: 8_000, label: `Live card hit for "${cardQuery}"` },
    );
    tty.assertHealthyScreen(cardSearchScreen, 120, 'CommandPalette live card search');

    // Move selection cursor down until the highlighted row ('❯' or '>' after modal border) is a live Card hit
    let selectedCardRow = false;
    for (let step = 0; step < 24; step += 1) {
      const lines = tty.readLines();
      if (lines.some((line) => /[│|]\s*(?:❯|>)\s/.test(line) && (line.includes('题库') || line.includes('Card')))) {
        selectedCardRow = true;
        break;
      }
      tty.send('\x1b[B');
      await tty.flush();
    }
    assert.ok(selectedCardRow, `Expected to highlight a live Card hit for "${cardQuery}":\n${tty.readScreen()}`);

    tty.send('\r');
    const reviewScreen = await tty.waitFor(
      (s) =>
        !s.includes('命令面板') &&
        !s.includes('Command Palette') &&
        !s.includes('正在加载页面') &&
        !s.includes('正在准备复习队列') &&
        (s.includes('[h]讲解') || s.includes('[h]Help')) &&
        (s.includes(cardQuery) || s.includes(matchedCardPrompt.slice(0, 12))),
      { timeoutMs: 10_000, label: 'Navigated to ReviewView with matched card rendered' },
    );
    tty.assertHealthyScreen(reviewScreen, 120, 'ReviewView from CommandPalette card hit');

    // 1c) Open CommandPalette again from ReviewView -> search real source passage -> navigate to Sources / DocumentReader
    tty.send('\x0b');
    await tty.waitFor(
      (s) => s.includes('命令面板') || s.includes('Command Palette'),
      { label: 'CommandPalette opened for passage search' },
    );
    tty.send(sourceQuery);
    await sleep(260); // > 180ms debounce
    const passageSearchScreen = await tty.waitFor(
      (s) =>
        (s.includes('原文') || s.includes('Passage')) &&
        !s.includes('正在全文检索') &&
        !s.includes('Searching'),
      { timeoutMs: 8_000, label: `Live passage hit for "${sourceQuery}"` },
    );
    tty.assertHealthyScreen(passageSearchScreen, 120, 'CommandPalette live passage search');

    let selectedPassageRow = false;
    for (let step = 0; step < 24; step += 1) {
      const lines = tty.readLines();
      if (lines.some((line) => /[│|]\s*(?:❯|>)\s/.test(line) && (line.includes('原文') || line.includes('Passage')))) {
        selectedPassageRow = true;
        break;
      }
      tty.send('\x1b[B');
      await tty.flush();
    }
    assert.ok(selectedPassageRow, `Expected to highlight a live Passage hit for "${sourceQuery}":\n${tty.readScreen()}`);

    tty.send('\r');
    const readerScreen = await tty.waitFor(
      (s) =>
        !s.includes('命令面板') &&
        !s.includes('Command Palette') &&
        !s.includes('正在加载页面') &&
        !s.includes('正在读取页面内容') &&
        (s.includes('第 ') || s.includes('P. ')) &&
        (s.includes('∑ Unicode') || s.includes('TeX')) &&
        (s.includes(matchedSourceTitle.slice(0, 10)) || s.includes(sourceQuery)),
      { timeoutMs: 10_000, label: 'Navigated to DocumentReader from live passage hit' },
    );
    tty.assertHealthyScreen(readerScreen, 120, 'DocumentReader from CommandPalette passage hit');

    // Exit DocumentReader back to Sources, then navigate to Library ('1')
    tty.send('\x1b');
    await tty.waitFor(
      (s) => s.includes('资料列表') || s.includes('Materials'),
      { timeoutMs: 8_000, label: 'Back to SourcesView from DocumentReader' },
    );
  });

  test('2) Library DeckOpsModal [o]: JSON deck.import, topic deck.split, and deck.merge', async () => {
    // Navigate to LibraryView ('1')
    tty.send('1');
    const libInit = await tty.waitFor(
      (s) => (s.includes('题组列表') || s.includes('Decks')) && !s.includes('正在加载页面'),
      { timeoutMs: 8_000, label: 'LibraryView active' },
    );
    tty.assertHealthyScreen(libInit, 120, 'LibraryView initial');

    const beforeSnap = await host.refreshSnapshot();
    const beforeDecks = beforeSnap.snapshot?.decks || [];
    const activeCourse = typeof beforeSnap.snapshot?.focus?.course === 'string' ? beforeSnap.snapshot.focus.course : '';

    // Create a valid temp .json deck file with 4 quiz cards across "Topic Alpha" and "Topic Beta"
    const importTitle = 'Round9 Imported Deck';
    const splitTitle = 'Round9 Split Alpha';
    const jsonDeckPath = join(boxDir, 'round9-import-deck.json');
    const deckPayload = {
      title: importTitle,
      folder: 'Round9',
      ...(activeCourse ? { course: activeCourse } : {}),
      cards: [
        {
          kind: 'quiz',
          topic: 'Topic Alpha',
          objective: 'Understand Alpha Principle One',
          prompt: 'Which statement accurately describes Alpha Principle One?',
          answer: 'Alpha Principle One keeps state immutable.',
          hint: 'Think about snapshot safety and state mutations.',
          explanation: 'Immutable state prevents unintended side effects across callers.',
          misconception: 'Assuming Alpha Principle One mutates shared buffers in place.',
          options: [
            { id: 'a', text: 'Alpha Principle One keeps state immutable.', correct: true, explanation: 'Immutability avoids shared mutation bugs.' },
            { id: 'b', text: 'Alpha Principle One deletes previous logs.', correct: false, explanation: 'Logs are preserved rather than deleted.' },
            { id: 'c', text: 'Alpha Principle One disables validation.', correct: false, explanation: 'Validation remains active at all times.' },
          ],
        },
        {
          kind: 'quiz',
          topic: 'Topic Alpha',
          objective: 'Identify Alpha Principle Two usage',
          prompt: 'When should Alpha Principle Two be applied in practice?',
          answer: 'Apply Alpha Principle Two during boundary checks.',
          hint: 'Consider where untrusted external payloads enter the module.',
          explanation: 'Boundary checks validate inputs before internal processing begins.',
          misconception: 'Applying Alpha Principle Two only after persistence succeeds.',
          options: [
            { id: 'a', text: 'Apply Alpha Principle Two during boundary checks.', correct: true, explanation: 'Boundaries catch malformed payloads early.' },
            { id: 'b', text: 'Apply Alpha Principle Two inside CSS themes.', correct: false, explanation: 'Styling layers do not govern data boundaries.' },
            { id: 'c', text: 'Apply Alpha Principle Two only during shutdown.', correct: false, explanation: 'Waiting until shutdown skips runtime checks.' },
          ],
        },
        {
          kind: 'quiz',
          topic: 'Topic Beta',
          objective: 'Explain Beta Mechanism Core',
          prompt: 'What is the primary goal of the Beta Mechanism?',
          answer: 'Beta Mechanism decouples producers from consumers.',
          hint: 'Focus on how two subsystems communicate without direct references.',
          explanation: 'Decoupling allows producers and consumers to evolve independently.',
          misconception: 'Assuming Beta Mechanism merges all modules into one file.',
          options: [
            { id: 'a', text: 'Beta Mechanism decouples producers from consumers.', correct: true, explanation: 'Independent evolution relies on decoupling.' },
            { id: 'b', text: 'Beta Mechanism hardcodes database credentials.', correct: false, explanation: 'Credentials should never be hardcoded.' },
            { id: 'c', text: 'Beta Mechanism bypasses asynchronous queues.', correct: false, explanation: 'Queues remain supported for async workflows.' },
          ],
        },
        {
          kind: 'quiz',
          topic: 'Topic Beta',
          objective: 'Contrast Beta Strategy Tradeoff',
          prompt: 'Which tradeoff is characteristic of the Beta Strategy?',
          answer: 'Higher indirection in exchange for modularity.',
          hint: 'Compare extra abstraction layers against flexibility benefits.',
          explanation: 'Adding an abstraction layer increases indirection while improving modularity.',
          misconception: 'Believing Beta Strategy removes all abstraction layers.',
          options: [
            { id: 'a', text: 'Higher indirection in exchange for modularity.', correct: true, explanation: 'Modularity often introduces a thin indirection layer.' },
            { id: 'b', text: 'Zero memory allocation at runtime.', correct: false, explanation: 'Objects and adapters still allocate memory.' },
            { id: 'c', text: 'Single-threaded blocking I/O only.', correct: false, explanation: 'Beta Strategy works with non-blocking flows.' },
          ],
        },
      ],
    };
    await writeFile(jsonDeckPath, JSON.stringify(deckPayload, null, 2), 'utf8');

    // --- Tab 1: deck.import ---
    tty.send('o');
    const opsImportOpen = await tty.waitFor(
      (s) => s.includes('题组操作中心') || s.includes('Deck Operations'),
      { timeoutMs: 8_000, label: 'DeckOpsModal opened on Tab 1 (Import)' },
    );
    tty.assertHealthyScreen(opsImportOpen, 120, 'DeckOpsModal Tab 1 Import');

    tty.send(jsonDeckPath);
    await tty.waitFor(
      (s) =>
        s.includes(importTitle) &&
        (s.includes('4 题') || s.includes('4 cards') || s.includes('4c')),
      { timeoutMs: 8_000, label: 'DeckOpsModal JSON preview validated' },
    );

    tty.send('\r');
    const afterImportScreen = await tty.waitFor(
      (s) =>
        !s.includes('题组操作中心') &&
        !s.includes('Deck Operations') &&
        s.includes(importTitle),
      { timeoutMs: 10_000, label: 'DeckOpsModal closed after import & imported deck visible' },
    );
    tty.assertHealthyScreen(afterImportScreen, 120, 'LibraryView after deck.import');

    const afterImportSnap = await host.refreshSnapshot();
    const afterImportDecks = afterImportSnap.snapshot?.decks || [];
    assert.equal(
      afterImportDecks.length,
      beforeDecks.length + 1,
      `Decks count should increase by 1 (${beforeDecks.length} -> ${afterImportDecks.length})`,
    );
    const importedDeck = afterImportDecks.find((d) => d.title === importTitle);
    assert.ok(importedDeck, `Expected "${importTitle}" in snapshot decks`);

    // Select the newly imported deck in LibraryView using Down arrow
    let selectedImported = false;
    for (let i = 0; i < afterImportDecks.length + 2; i += 1) {
      const screen = tty.readScreen();
      if (screen.includes('Topic Alpha') && screen.includes('Topic Beta') && screen.includes(importTitle)) {
        selectedImported = true;
        break;
      }
      tty.send('\x1b[B');
      await tty.flush();
    }
    assert.ok(selectedImported, `Expected to select "${importTitle}" in LibraryView:\n${tty.readScreen()}`);

    // --- Tab 3: deck.split ---
    tty.send('o');
    await tty.waitFor(
      (s) => (s.includes('题组操作中心') || s.includes('Deck Operations')) && s.includes(importTitle),
      { timeoutMs: 8_000, label: 'DeckOpsModal reopened for split' },
    );

    // Move focus from path TextInput to tab bar via Up arrow, then press '3' for Split tab
    tty.send('\x1b[A');
    await tty.flush();
    tty.send('3');

    const splitTabScreen = await tty.waitFor(
      (s) =>
        s.includes('Topic Alpha') &&
        s.includes('Topic Beta') &&
        !s.includes('正在读取题组主题') &&
        !s.includes('Loading deck topics'),
      { timeoutMs: 8_000, label: 'DeckOpsModal Tab 3 Split topics loaded' },
    );
    tty.assertHealthyScreen(splitTabScreen, 120, 'DeckOpsModal Tab 3 Split');

    // Toggle "Topic Alpha" (first topic) via Space
    tty.send(' ');
    const topicToggledScreen = await tty.waitFor(
      (s) =>
        (s.includes('[✓] Topic Alpha') || s.includes('[x] Topic Alpha')) &&
        (s.includes('拆出: 2/4') || s.includes('Move: 2/4')),
      { timeoutMs: 8_000, label: 'Topic Alpha toggled via Space (2/4 cards)' },
    );
    tty.assertHealthyScreen(topicToggledScreen, 120, 'DeckOpsModal Tab 3 Topic toggled');

    // Advance to New Deck Title input via Enter, replace default title with splitTitle
    tty.send('\r');
    await tty.waitFor(
      (s) => s.includes(`${importTitle} - Topic Alpha`),
      { timeoutMs: 8_000, label: 'Split title input focused with prefilled name' },
    );
    tty.send('\x15'); // Ctrl+U clears from cursor (at end) to start
    await tty.flush();
    tty.send(splitTitle);
    await tty.waitFor(
      (s) => s.includes(splitTitle) && !s.includes(`${importTitle} - Topic Alpha`),
      { timeoutMs: 8_000, label: 'Custom split title typed' },
    );

    // Submit title -> ConfirmDialog -> confirm with 'y'
    tty.send('\r');
    const splitConfirmScreen = await tty.waitFor(
      (s) =>
        (s.includes('确认拆分题组') || s.includes('Confirm Split Deck')) &&
        s.includes(splitTitle),
      { timeoutMs: 8_000, label: 'Confirm Split Deck dialog rendered' },
    );
    tty.assertHealthyScreen(splitConfirmScreen, 120, 'DeckOpsModal Split ConfirmDialog');

    tty.send('y');
    const afterSplitScreen = await tty.waitFor(
      (s) =>
        !s.includes('题组操作中心') &&
        !s.includes('Deck Operations') &&
        s.includes(splitTitle),
      { timeoutMs: 10_000, label: 'DeckOpsModal closed after deck.split' },
    );
    tty.assertHealthyScreen(afterSplitScreen, 120, 'LibraryView after deck.split');

    const afterSplitSnap = await host.refreshSnapshot();
    const afterSplitDecks = afterSplitSnap.snapshot?.decks || [];
    assert.equal(
      afterSplitDecks.length,
      afterImportDecks.length + 1,
      `Decks count should increase by 1 after split (${afterImportDecks.length} -> ${afterSplitDecks.length})`,
    );
    const createdSplitDeck = afterSplitDecks.find((d) => d.title === splitTitle);
    assert.ok(createdSplitDeck, `Expected split deck "${splitTitle}" in snapshot`);

    const splitDeckGet = await host.call('deck.get', { id: createdSplitDeck.id });
    assert.equal(splitDeckGet.ok, true);
    assert.equal(splitDeckGet.value?.cards?.length, 2, 'Split deck should contain 2 cards');
    assert.ok(
      splitDeckGet.value.cards.every((c) => c.topic === 'Topic Alpha'),
      'Split deck cards should all belong to Topic Alpha',
    );

    const sourceDeckGet = await host.call('deck.get', { id: importedDeck.id });
    assert.equal(sourceDeckGet.ok, true);
    assert.equal(sourceDeckGet.value?.cards?.length, 2, 'Source deck should retain 2 remaining cards');
    assert.ok(
      sourceDeckGet.value.cards.every((c) => c.topic === 'Topic Beta'),
      'Source deck remaining cards should all belong to Topic Beta',
    );

    // --- Tab 2: deck.merge ---
    // Compute expected index of createdSplitDeck in DeckOpsModal's mergeCandidates list
    const mergeCandidates = afterSplitDecks
      .filter((d) => d.id !== importedDeck.id && !d.archived && !d.systemKind)
      .sort((a, b) => {
        const selCourse = importedDeck.course ?? '';
        const aSame = (a.course ?? '') === selCourse ? 0 : 1;
        const bSame = (b.course ?? '') === selCourse ? 0 : 1;
        if (aSame !== bSame) return aSame - bSame;
        return String(a.title ?? a.name ?? a.id).localeCompare(String(b.title ?? b.name ?? b.id));
      });
    const targetMergeIdx = mergeCandidates.findIndex((d) => d.id === createdSplitDeck.id);
    assert.ok(targetMergeIdx >= 0, 'Split deck must appear in mergeCandidates');

    tty.send('o');
    await tty.waitFor(
      (s) => s.includes('题组操作中心') || s.includes('Deck Operations'),
      { timeoutMs: 8_000, label: 'DeckOpsModal reopened for merge' },
    );

    // Focus tab bar and switch to Tab 2 (Merge)
    tty.send('\x1b[A');
    await tty.flush();
    tty.send('2');

    const mergeTabScreen = await tty.waitFor(
      (s) =>
        (s.includes('并入下方所选目标题组') || s.includes('into selected target')) &&
        s.includes(splitTitle),
      { timeoutMs: 8_000, label: 'DeckOpsModal Tab 2 Merge rendered' },
    );
    tty.assertHealthyScreen(mergeTabScreen, 120, 'DeckOpsModal Tab 2 Merge');

    for (let step = 0; step < targetMergeIdx; step += 1) {
      tty.send('\x1b[B');
      await tty.flush();
    }

    tty.send('\r');
    const mergeConfirmScreen = await tty.waitFor(
      (s) =>
        (s.includes('确认合并题组') || s.includes('Confirm Merge Decks')) &&
        s.includes(importTitle) &&
        s.includes(splitTitle),
      { timeoutMs: 8_000, label: 'Confirm Merge Decks dialog rendered' },
    );
    tty.assertHealthyScreen(mergeConfirmScreen, 120, 'DeckOpsModal Merge ConfirmDialog');

    tty.send('y');
    const afterMergeScreen = await tty.waitFor(
      (s) => !s.includes('题组操作中心') && !s.includes('Deck Operations'),
      { timeoutMs: 10_000, label: 'DeckOpsModal closed after deck.merge' },
    );
    tty.assertHealthyScreen(afterMergeScreen, 120, 'LibraryView after deck.merge');

    const afterMergeSnap = await host.refreshSnapshot();
    const afterMergeDecks = afterMergeSnap.snapshot?.decks || [];
    assert.equal(
      afterMergeDecks.length,
      afterSplitDecks.length - 1,
      `Decks count should decrease by 1 after merge (${afterSplitDecks.length} -> ${afterMergeDecks.length})`,
    );
    assert.equal(
      afterMergeDecks.some((d) => d.id === importedDeck.id),
      false,
      'Source deck should be removed after merging into target',
    );
    const mergedTarget = afterMergeDecks.find((d) => d.id === createdSplitDeck.id);
    assert.ok(mergedTarget, 'Target deck must exist after merge');
    const mergedTargetGet = await host.call('deck.get', { id: mergedTarget.id });
    assert.equal(mergedTargetGet.ok, true);
    assert.equal(mergedTargetGet.value?.cards?.length, 4, 'Merged target deck should contain all 4 cards');
  });
});
