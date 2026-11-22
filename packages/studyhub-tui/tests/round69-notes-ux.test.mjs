// Round 69 Track 3: NotesView `/` live keyword filter + atomic Markdown export E2E tests:
// `node --test --test-concurrency=1 tests/round69-notes-ux.test.mjs`
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
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
    if (!S && typeof mod.useTuiStore?.getState === 'function') S = mod;
  }
}
if (!S) {
  for (const f of distFiles) {
    if (f.startsWith('store-')) {
      const mod = await import(pathToFileURL(join(distDir, f)).href);
      if (typeof mod.useTuiStore?.getState === 'function') {
        S = mod;
        break;
      }
    }
  }
}
assert.ok(H?.createTuiHost, 'dist/ must export createTuiHost');
assert.ok(H?.saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(R?.displayWidth, 'dist/ must export displayWidth');
assert.ok(S?.useTuiStore, 'dist/ must export useTuiStore');
const { useTuiStore } = S;

const PREV_DSH_HOME = process.env.DSH_HOME;
const UNICODE_UI_CHROME_RE =
  /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u27BF\u2800-\u28FF\u2190-\u21FF\u2022\u2026\u2039\u203A]/g;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-r69-notes-${label}-`));
  tempDirs.push(d);
  return d;
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
    await sleep(35);
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
      await sleep(35);
    }
    const finalScreen = readScreen();
    throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms.\n--- SCREEN ---\n${finalScreen}\n--------------`);
  }

  function assertHealthyScreen(screen, expectedCols, expectedRows, contextLabel) {
    const lines = screen.split('\n');
    assert.ok(lines.length <= expectedRows, `${contextLabel}: row count ${lines.length} > ${expectedRows}`);
    assert.ok(
      !screen.includes('页面渲染异常') && !screen.includes('View Error'),
      `${contextLabel}: ViewErrorBoundary triggered!\n${screen}`,
    );
    assert.ok(
      !screen.includes('TypeError:') && !screen.includes('ReferenceError:'),
      `${contextLabel}: Runtime JS error rendered!\n${screen}`,
    );
    assert.ok(!/\bNaN\b/.test(screen), `${contextLabel}: raw NaN leaked!\n${screen}`);
    assert.ok(!/\bundefined\b/.test(screen), `${contextLabel}: raw undefined leaked!\n${screen}`);
    assert.ok(!screen.includes('[object Object]'), `${contextLabel}: raw [object Object] leaked!\n${screen}`);
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

function resetStore({ language = 'zh', asciiMode = false, page = 'library' } = {}) {
  const prev = useTuiStore.getState();
  useTuiStore.setState({
    page,
    history: [],
    navContext: {},
    commandPaletteOpen: false,
    helpOpen: false,
    coursePickerOpen: false,
    inboxOpen: false,
    voicePackOpen: false,
    showLaunchpad: false,
    inputCaptured: false,
    toasts: [],
    preferences: {
      ...prev.preferences,
      language,
      asciiMode,
      sidebarCollapsed: false,
      showKeyHints: true,
    },
  });
}

async function seedSampleWithTwoNotes(base, { language = 'zh', asciiMode = false } = {}) {
  const dshHome = join(base, 'dsh-home');
  process.env.DSH_HOME = dshHome;
  const env = { DSH_HOME: dshHome };
  const libraryRoot = join(base, 'library');

  let modelCalls = 0;
  const host = await H.createTuiHost({
    libraryRoot,
    env,
    home: base,
    documentsDir: base,
    skipAutoProbe: true,
    language,
    injectedComplete: async () => {
      modelCalls += 1;
      throw new Error('Unexpected LLM call in NotesView filter/export test');
    },
  });

  const sampleRes = await host.call('sample.load', { language });
  assert.equal(sampleRes.ok, true, `sample.load failed: ${sampleRes.error?.message || ''}`);

  const snapRes = await host.call('library.snapshot', {});
  assert.equal(snapRes.ok, true, 'library.snapshot failed');
  const deckSummary = snapRes.value?.decks?.find((d) => !d.archived) || snapRes.value?.decks?.[0];
  assert.ok(deckSummary?.id, 'sample library must contain a deck');
  const deckRes = await host.call('deck.get', { id: deckSummary.id });
  assert.equal(deckRes.ok, true, 'deck.get failed');
  const card = deckRes.value?.cards?.[0];
  assert.ok(card?.id, 'sample deck must contain a card');

  const note2Title = 'R69 Beta';
  const note2Markdown = '# R69 Beta\n\nUnique keyword: R69_ATOMIC_EXPORT_BODY\nAtomic write check.\n';
  const n2 = await host.call('note.create', {
    title: note2Title,
    cards: [{ deckId: deckSummary.id, cardId: card.id }],
    prefill: false,
    language,
  });
  assert.equal(n2.ok, true, `note.create 2 failed: ${n2.error?.message || ''}`);
  const s2 = await host.call('note.save', {
    id: n2.value.id,
    title: note2Title,
    markdown: note2Markdown,
    expectedRevision: n2.value.revision ?? 0,
  });
  assert.equal(s2.ok, true, `note.save 2 failed: ${s2.error?.message || ''}`);

  await sleep(25);

  const n1 = await host.call('note.create', {
    title: 'R69 Alpha',
    cards: [{ deckId: deckSummary.id, cardId: card.id }],
    prefill: false,
    language,
  });
  assert.equal(n1.ok, true, `note.create 1 failed: ${n1.error?.message || ''}`);
  const s1 = await host.call('note.save', {
    id: n1.value.id,
    title: 'R69 Alpha',
    markdown: '# R69 Alpha\n\nAlpha virtual memory paging overview.\n',
    expectedRevision: n1.value.revision ?? 0,
  });
  assert.equal(s1.ok, true, `note.save 1 failed: ${s1.error?.message || ''}`);

  await H.saveTuiPreferences(
    {
      language,
      asciiMode,
      sidebarCollapsed: false,
      showKeyHints: true,
    },
    env,
  );

  return {
    host,
    libraryRoot,
    note2Title,
    note2Markdown,
    getModelCalls: () => modelCalls,
  };
}

after(async () => {
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

describe('Round 69 Track 3: NotesView `/` live filter & atomic Markdown export', () => {
  test('1. PTY E2E (120x36 zh): seed 2 notes -> n -> / filter to note 2 -> Enter -> x + Enter atomic export (zero .tmp) -> Esc clears filter (0 model calls)', async () => {
    const base = await makeTempDir('zh-120x36');
    const seeded = await seedSampleWithTwoNotes(base, { language: 'zh', asciiMode: false });

    resetStore({ language: 'zh', asciiMode: false, page: 'library' });
    const tty = createVirtualTty(120, 36);
    const app = render(
      React.createElement(StudyHubTuiApp, {
        host: seeded.host,
        initialPage: 'library',
        showLaunchpad: false,
        onExit: () => {},
      }),
      {
        stdin: tty.stdin,
        stdout: tty.stdout,
        stderr: tty.stderr,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );

    try {
      await tty.firstFramePromise;
      await tty.waitFor(
        (s) => s.includes('示例 · Memento 与 Bridge') && !s.includes('正在打开学习库') && !s.includes('正在加载页面'),
        { label: 'LibraryView ready' },
      );

      // Navigate to NotesView via 'n'
      tty.send('n');
      const notesReady = await tty.waitFor(
        (s) =>
          s.includes('R69 Alpha') &&
          s.includes('R69 Beta') &&
          !s.includes('载入笔记中') &&
          !s.includes('正在加载页面'),
        { label: 'NotesView with both seeded notes' },
      );
      tty.assertHealthyScreen(notesReady, 120, 36, 'NotesView initial (120x36 zh)');

      // Press '/' to open live keyword filter
      tty.send('/');
      await tty.waitFor((s) => /\[筛选\s+\d+\/\d+\]/.test(s), { label: 'NotesView filter bar opened' });

      // Filter by keyword matching note 2's markdown body
      tty.send('R69_ATOMIC_EXPORT_BODY');
      const filteredEditing = await tty.waitFor(
        (s) =>
          /\[筛选\s+1\/\d+\]/.test(s) &&
          s.includes('R69 Beta') &&
          !s.includes('R69 Alpha'),
        { label: 'NotesView live-filtered to note 2 while typing' },
      );
      tty.assertHealthyScreen(filteredEditing, 120, 36, 'NotesView filter editing');

      // Press Enter to confirm/blur keeping filter active
      tty.send('\r');
      const filteredConfirmed = await tty.waitFor(
        (s) =>
          /\[已筛选\s+1\/\d+\]/.test(s) &&
          s.includes('R69 Beta') &&
          s.includes('R69_ATOMIC_EXPORT_BODY'),
        { label: 'NotesView filter confirmed with [已筛选 1/Y] badge and note 2 selected' },
      );
      tty.assertHealthyScreen(filteredConfirmed, 120, 36, 'NotesView filter confirmed');

      // Press 'x' to open export modal for the filtered note 2
      tty.send('x');
      const exportModal = await tty.waitFor(
        (s) => s.includes('导出 Markdown 笔记') && s.includes('R69 Beta'),
        { label: 'Export modal opened for filtered note 2' },
      );
      tty.assertHealthyScreen(exportModal, 120, 36, 'NotesView export modal');

      // Press Enter to confirm atomic export
      tty.send('\r');
      const afterExport = await tty.waitFor(
        (s) => !s.includes('导出 Markdown 笔记') && s.includes('已导出到'),
        { label: 'Export completed and toast displayed' },
      );
      tty.assertHealthyScreen(afterExport, 120, 36, 'NotesView after atomic export');

      // Verify exact .md file on disk with zero .tmp leftovers
      const exportsDir = join(seeded.libraryRoot, 'exports');
      const entries = await readdir(exportsDir);
      assert.deepEqual(entries, ['R69-Beta.md']);
      assert.equal(entries.filter((name) => name.includes('.tmp')).length, 0, 'must leave zero .tmp files');
      const written = await readFile(join(exportsDir, 'R69-Beta.md'), 'utf8');
      assert.equal(written, seeded.note2Markdown);

      // Press Esc in normal mode to clear active filter
      tty.send('\x1b');
      const afterClear = await tty.waitFor(
        (s) =>
          !s.includes('[已筛选') &&
          !s.includes('[筛选') &&
          s.includes('R69 Alpha') &&
          s.includes('R69 Beta'),
        { label: 'Esc cleared filter in normal mode' },
      );
      tty.assertHealthyScreen(afterClear, 120, 36, 'NotesView after Esc clear');
      assert.equal(seeded.getModelCalls(), 0, 'Must make 0 LLM calls');
    } finally {
      app.unmount();
      tty.dispose();
    }
  });

  test('2. PTY E2E (80x24 --ascii en): NotesView -> / filter -> Esc clear -> assertHealthyScreen + assertAsciiPure', async () => {
    const base = await makeTempDir('en-80x24-ascii');
    const seeded = await seedSampleWithTwoNotes(base, { language: 'en', asciiMode: true });

    resetStore({ language: 'en', asciiMode: true, page: 'library' });
    const tty = createVirtualTty(80, 24);
    const app = render(
      React.createElement(StudyHubTuiApp, {
        host: seeded.host,
        initialPage: 'library',
        showLaunchpad: false,
        onExit: () => {},
      }),
      {
        stdin: tty.stdin,
        stdout: tty.stdout,
        stderr: tty.stderr,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );

    try {
      await tty.firstFramePromise;
      await tty.waitFor(
        (s) => s.includes('Sample · Memento and Bridge') && !s.includes('Opening library') && !s.includes('Loading view'),
        { label: 'LibraryView ready (80x24 --ascii en)' },
      );

      // Navigate to NotesView via 'n'
      tty.send('n');
      const notesInit = await tty.waitFor(
        (s) =>
          s.includes('R69 Alpha') &&
          s.includes('R69 Beta') &&
          !s.includes('Loading notes'),
        { label: 'NotesView rendered (80x24 --ascii en)' },
      );
      tty.assertHealthyScreen(notesInit, 80, 24, 'NotesView initial (80x24 --ascii en)');
      tty.assertAsciiPure(notesInit, 'NotesView initial (80x24 --ascii en)');

      // Open filter via '/'
      tty.send('/');
      await tty.waitFor((s) => /\[Filter\s+\d+\/\d+\]/.test(s), { label: 'Filter bar opened (en)' });

      // Type keyword matching note 2
      tty.send('R69_ATOMIC_EXPORT_BODY');
      const filtered = await tty.waitFor(
        (s) =>
          /\[Filter\s+1\/\d+\]/.test(s) &&
          s.includes('R69 Beta') &&
          !s.includes('R69 Alpha'),
        { label: 'Filtered to note 2 (80x24 --ascii en)' },
      );
      tty.assertHealthyScreen(filtered, 80, 24, 'NotesView filtered (80x24 --ascii en)');
      tty.assertAsciiPure(filtered, 'NotesView filtered (80x24 --ascii en)');

      // Esc while editing clears filter & closes bar
      tty.send('\x1b');
      const cleared = await tty.waitFor(
        (s) =>
          !s.includes('[Filter') &&
          !s.includes('[Filtered') &&
          s.includes('R69 Alpha') &&
          s.includes('R69 Beta'),
        { label: 'Esc cleared filter (80x24 --ascii en)' },
      );
      tty.assertHealthyScreen(cleared, 80, 24, 'NotesView cleared (80x24 --ascii en)');
      tty.assertAsciiPure(cleared, 'NotesView cleared (80x24 --ascii en)');
      assert.equal(seeded.getModelCalls(), 0, 'Must make 0 LLM calls');
    } finally {
      app.unmount();
      tty.dispose();
    }
  });
});
