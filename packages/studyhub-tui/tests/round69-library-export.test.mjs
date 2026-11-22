// Round 69 Track 2: LibraryView [x] Atomic Deck Study Sheet Markdown Export (0 LLM tokens):
// `node --test --test-concurrency=1 tests/round69-library-export.test.mjs`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
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

// Bundle LibraryView from TypeScript source to unit-test formatDeckMarkdown directly
const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyhub-r69-lib-unit-'));
const bundleFile = path.join(bundleDir, 'library.mjs');
await build({
  stdin: {
    contents: `export { formatDeckMarkdown } from './src/views/library/LibraryView.tsx';`,
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
const LibraryMod = await import(pathToFileURL(bundleFile).href);
assert.equal(typeof LibraryMod.formatDeckMarkdown, 'function', 'LibraryView must export formatDeckMarkdown');

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
const tempDirs = [bundleDir];

async function makeTempDir(label) {
  const d = await mkdtemp(join(os.tmpdir(), `studyhub-r69-lib-${label}-`));
  tempDirs.push(d);
  return d;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const UNICODE_UI_CHROME_RE = /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u27BF\u2800-\u28FF\u2190-\u21FF\u2022\u2026\u2039\u203A]/g;

function todayLocalYmd() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
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

after(async () => {
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await Promise.all(
    tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
});

describe('Round 69 Track 2: LibraryView [x] Atomic Deck Study Sheet Markdown Export', () => {
  test('1) Unit: formatDeckMarkdown renders zh & en study sheets with MCQ options, cloze, flashcard, hidden <details> answers/hints/explanations & empty deck', () => {
    const sampleDeck = {
      id: 'deck-os-1',
      title: 'Operating Systems: Virtual Memory',
      course: 'CS301 Operating Systems',
      cards: [
        {
          id: 'c1',
          kind: 'quiz',
          topic: 'TLB & Page Table',
          prompt: 'Which hardware cache speeds up virtual-to-physical address translation?',
          options: [
            { id: 'a', text: 'L1 Data Cache', correct: false },
            { id: 'b', text: 'Translation Lookaside Buffer (TLB)', correct: true },
            { id: 'c', text: 'Write Buffer', correct: false },
          ],
          hint: 'Think about page table entry caching.',
          explanation: 'The TLB caches recent virtual-to-physical page number mappings.',
        },
        {
          id: 'c2',
          kind: 'cloze',
          topic: 'Page Fault',
          cloze: {
            text: 'When a referenced page is not in RAM, the MMU triggers a {{b1}}.',
            answers: [{ id: 'b1', value: 'page fault' }],
          },
          hint: 'A trap handled by the OS kernel.',
          explanation: 'The OS loads the missing page from backing store and updates the PTE.',
        },
        {
          id: 'c3',
          kind: 'flashcard',
          topic: 'Thrashing',
          prompt: 'Define thrashing in virtual memory systems.',
          answer: 'Excessive paging where the CPU spends more time swapping pages than executing instructions.',
          explanation: 'Usually caused by working-set size exceeding available physical frames.',
        },
      ],
    };

    const zhMd = LibraryMod.formatDeckMarkdown({
      deck: sampleDeck,
      lang: 'zh',
      generatedAt: '2026-11-22 22:00',
    });
    assert.ok(zhMd.includes('# Operating Systems: Virtual Memory'), 'zh deck title missing');
    assert.ok(zhMd.includes('**课程**: CS301 Operating Systems'), 'zh course missing');
    assert.ok(zhMd.includes('**生成日期**: 2026-11-22 22:00'), 'zh date missing');
    assert.ok(zhMd.includes('**题目数量**: 3'), 'zh card count missing');
    assert.ok(zhMd.includes('## 1. TLB & Page Table'), 'card 1 heading missing');
    assert.ok(zhMd.includes('`quiz` `TLB & Page Table`'), 'card 1 badges missing');
    assert.ok(zhMd.includes('- **A.** L1 Data Cache') && zhMd.includes('- **B.** Translation Lookaside Buffer (TLB)'), 'MCQ options missing');
    // Correct option marker must NOT leak in the question options list before <details>
    const beforeDetails1 = zhMd.slice(0, zhMd.indexOf('<details>'));
    assert.ok(!beforeDetails1.includes('参考答案') && !beforeDetails1.includes('Reference Answer'), 'answer leaked outside <details>');
    assert.ok(zhMd.includes('## 2. Page Fault'), 'card 2 heading missing');
    assert.ok(zhMd.includes('When a referenced page is not in RAM, the MMU triggers a {{b1}}.'), 'cloze text missing');
    assert.ok(zhMd.includes('## 3. Thrashing'), 'card 3 heading missing');
    assert.ok(zhMd.includes('<summary>参考答案与解析 / Answer & Explanation</summary>'), 'zh <summary> missing');
    assert.ok(zhMd.includes('**参考答案**: B. Translation Lookaside Buffer (TLB)'), 'MCQ answer inside <details> missing');
    assert.ok(zhMd.includes('**参考答案**: page fault'), 'cloze answer inside <details> missing');
    assert.ok(zhMd.includes('**参考答案**: Excessive paging'), 'flashcard answer inside <details> missing');
    assert.ok(zhMd.includes('**提示**: Think about page table entry caching.'), 'hint inside <details> missing');
    assert.ok(zhMd.includes('The TLB caches recent virtual-to-physical page number mappings.'), 'explanation inside <details> missing');
    assert.ok(zhMd.includes('</details>'), '</details> closing tag missing');

    const enMd = LibraryMod.formatDeckMarkdown({
      deck: sampleDeck,
      lang: 'en',
      generatedAt: new Date(2026, 10, 22, 9, 5),
    });
    assert.ok(enMd.includes('**Course**: CS301 Operating Systems'), 'en course missing');
    assert.ok(enMd.includes('**Generated**: 2026-11-22 09:05'), 'en formatted Date missing');
    assert.ok(enMd.includes('**Cards**: 3'), 'en card count missing');
    assert.ok(enMd.includes('**Reference Answer**: B. Translation Lookaside Buffer (TLB)'), 'en reference answer missing');
    assert.ok(enMd.includes('**Hint**: Think about page table entry caching.'), 'en hint missing');
    assert.ok(enMd.includes('**Explanation**:'), 'en explanation heading missing');

    const emptyMd = LibraryMod.formatDeckMarkdown({
      deck: { id: 'empty-1', title: 'Empty Deck', course: '', cards: [] },
      lang: 'en',
      generatedAt: '2026-11-22 10:00',
    });
    assert.ok(emptyMd.includes('# Empty Deck'));
    assert.ok(emptyMd.includes('**Course**: General'));
    assert.ok(emptyMd.includes('**Cards**: 0'));
    assert.ok(emptyMd.includes('No cards in this deck.'));
  });

  test('2) @xterm/headless PTY E2E (120x36 zh): load sample -> LibraryView select first deck -> [x] exports studyhub-deck-*.md (0 model calls)', async () => {
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
      const libScreen = await tty.waitFor(
        (s) =>
          !s.includes('载入示例课程体验') &&
          s.includes('示例 · Memento 与 Bridge') &&
          useDistTuiStore.getState().footerHints.some((h) => h.key === 'x' && h.label === '导出MD'),
        { timeoutMs: 12_000, label: 'zh LibraryView with sample deck & [x] hint' },
      );
      tty.assertHealthyScreen(libScreen, 120, 36, 'zh LibraryView 120x36');

      const snapDecks = useDistTuiStore.getState().snapshot?.decks ?? [];
      const firstDeck = snapDecks.find((d) => !d.archived && !d.systemKind);
      assert.ok(firstDeck?.id, 'sample course must provide at least one deck');
      const deckDetailRes = await host.call('deck.get', { id: firstDeck.id });
      assert.equal(deckDetailRes.ok, true, deckDetailRes.error?.message);
      const firstCardPrompt = String(
        deckDetailRes.value?.cards?.[0]?.cloze?.text || deckDetailRes.value?.cards?.[0]?.prompt || '',
      )
        .trim()
        .slice(0, 18);

      const expectedPath = join(libraryRoot, 'backups', `studyhub-deck-${todayLocalYmd()}.md`);
      tty.send('x');
      const afterExport = await tty.waitFor(
        (s) =>
          fs.existsSync(expectedPath) &&
          useDistTuiStore
            .getState()
            .toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已导出') && toast.text.includes(expectedPath)) &&
          s.includes('已导出'),
        { timeoutMs: 10_000, label: 'zh LibraryView [x] export toast & file on disk' },
      );
      tty.assertHealthyScreen(afterExport, 120, 36, 'zh LibraryView after [x] export');

      const exportedMd = await readFile(expectedPath, 'utf8');
      assert.ok(exportedMd.includes(`# ${firstDeck.title}`), 'exported MD must have selected deck title');
      assert.ok(exportedMd.includes('<details>'), 'exported MD must contain <details>');
      assert.ok(exportedMd.includes('<summary>参考答案与解析 / Answer & Explanation</summary>'), 'exported MD must contain <summary>');
      assert.ok(exportedMd.includes('</details>'), 'exported MD must contain </details>');
      if (firstCardPrompt) {
        assert.ok(exportedMd.includes(firstCardPrompt), `exported MD must include card prompt "${firstCardPrompt}"`);
      }
      assert.equal(modelCalls, 0, 'LibraryView [x] export must invoke 0 model calls');
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

  test('3) @xterm/headless PTY E2E (80x24 --ascii en): LibraryView -> [x] export -> assertHealthyScreen + assertAsciiPure + valid .md', async () => {
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
      const libScreen = await tty.waitFor(
        (s) =>
          !s.includes('Load the sample course') &&
          s.includes('Memento') &&
          useDistTuiStore.getState().footerHints.some((h) => h.key === 'x' && h.label === 'Export'),
        { timeoutMs: 12_000, label: 'en LibraryView 80x24 with sample deck & [x] hint' },
      );
      tty.assertHealthyScreen(libScreen, 80, 24, 'en LibraryView 80x24');
      tty.assertAsciiPure(libScreen, 'en LibraryView 80x24');

      const expectedPath = join(libraryRoot, 'backups', `studyhub-deck-${todayLocalYmd()}.md`);
      tty.send('x');
      const afterExport = await tty.waitFor(
        () =>
          fs.existsSync(expectedPath) &&
          useDistTuiStore
            .getState()
            .toasts.some(
              (toast) =>
                toast.tone === 'success' &&
                toast.text.includes('Exported') &&
                toast.text.includes('card(s) ->') &&
                toast.text.includes(expectedPath),
            ),
        { timeoutMs: 10_000, label: 'en LibraryView [x] export toast & file on disk' },
      );
      tty.assertHealthyScreen(afterExport, 80, 24, 'en LibraryView after [x] export 80x24');
      tty.assertAsciiPure(afterExport, 'en LibraryView after [x] export 80x24');

      const exportedMd = await readFile(expectedPath, 'utf8');
      assert.ok(exportedMd.includes('# '), 'exported MD must have deck title heading');
      assert.ok(exportedMd.includes('**Course**:'), 'exported MD must have en Course metadata');
      assert.ok(exportedMd.includes('## 1.'), 'exported MD must have numbered card');
      assert.ok(exportedMd.includes('<details>'), 'exported MD must contain <details>');
      assert.ok(exportedMd.includes('<summary>参考答案与解析 / Answer & Explanation</summary>'), 'exported MD must contain <summary>');
      assert.ok(exportedMd.includes('</details>'), 'exported MD must contain </details>');
      assert.equal(modelCalls, 0, 'LibraryView [x] export must invoke 0 model calls');
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
