// Round 56 Task 3: NotesView CSDN Publish Assist (`note.preparePublish` & `note.lookup`, 0 model calls!)
// & HelpOverlay Round 56 parity E2E verification:
// `node --test tests/round56-note-publish.test.mjs`
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

const { createTuiHost, saveTuiPreferences } = H;
const { displayWidth } = R;
const { useTuiStore } = S;

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round56-note-publish-${label}-`));
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

  function resize(newCols, newRows) {
    stdout.columns = newCols;
    stdout.rows = newRows;
    stderr.columns = newCols;
    stderr.rows = newRows;
    term.resize(newCols, newRows);
    stdout.emit('resize');
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
    resize,
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

function resetTuiStore() {
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
  });
}

describe('Round 56: NotesView CSDN Publish Assist & HelpOverlay Parity', () => {
  after(async () => {
    if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = PREV_DSH_HOME;
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
  });

  test('1) createTuiHost integration (0 model calls, offline-safe): note.preparePublish & note.lookup without csdnHome', async () => {
    const base = await makeTempDir('host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');

    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
      injectedComplete: async () => {
        modelCalls += 1;
        throw new Error('Model must not be called during note.preparePublish or note.lookup');
      },
    });

    try {
      const sampleRes = await host.call('sample.load', { language: 'zh' });
      assert.equal(sampleRes.ok, true, `sample.load failed: ${sampleRes.error?.message || ''}`);

      const snapRes = await host.call('library.snapshot', {});
      assert.equal(snapRes.ok, true, 'library.snapshot failed');
      const deckSummary = snapRes.value?.decks?.find((d) => !d.archived) || snapRes.value?.decks?.[0];
      assert.ok(deckSummary?.id, 'sample library must contain a deck');
      const deckRes = await host.call('deck.get', { id: deckSummary.id });
      assert.equal(deckRes.ok, true, 'deck.get failed');
      const card = deckRes.value?.cards?.[0];
      assert.ok(card?.id, 'sample deck must contain a card');

      const createRes = await host.call('note.create', {
        title: 'Round 56 Offline Publish Assist Draft',
        cards: [{ deckId: deckSummary.id, cardId: card.id }],
        language: 'zh',
      });
      assert.equal(createRes.ok, true, `note.create failed: ${createRes.error?.message || ''}`);
      const draft = createRes.value;
      assert.equal(draft?.status, 'draft');

      // Without csdnHome configured: preparePublish returns autoLookupReady: false cleanly (0 network, 0 model calls)
      const prepRes = await host.call('note.preparePublish', { id: draft.id });
      assert.equal(prepRes.ok, true, `note.preparePublish failed: ${prepRes.error?.message || ''}`);
      assert.equal(prepRes.value?.autoLookupReady, false);
      assert.ok(
        typeof prepRes.value?.reason === 'string' && prepRes.value.reason.includes('尚未设置 CSDN 公开主页'),
        `expected missing CSDN home reason, got: ${JSON.stringify(prepRes.value)}`,
      );

      // Without csdnHome configured: lookup throws/returns normalized missing-home error (0 network, 0 model calls)
      const lookupRes = await host.call('note.lookup', {
        id: draft.id,
        expectedRevision: draft.revision ?? 0,
      });
      assert.equal(lookupRes.ok, false, 'note.lookup must fail when csdnHome is not set');
      assert.ok(
        lookupRes.error?.message?.includes('请先设置 CSDN 公开博客主页'),
        `expected normalized missing-home error, got: ${lookupRes.error?.message || ''}`,
      );

      assert.equal(modelCalls, 0, 'note.preparePublish & note.lookup must trigger 0 model calls');
    } finally {
      await host.dispose();
    }
  });

  test('2) @xterm/headless PTY E2E: NotesView Link Modal Ctrl+P / Ctrl+L & HelpOverlay Round 56 parity at 120x36 zh & 80x24 --ascii en', async () => {
    const base = await makeTempDir('pty');
    const dshHome = join(base, 'dsh-home');
    const env = { DSH_HOME: dshHome };
    const libraryRoot = join(base, 'library');

    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
      injectedComplete: async () => {
        modelCalls += 1;
        throw new Error('Model must not be called in Round 56 PTY test');
      },
    });

    try {
      const sampleRes = await host.call('sample.load', { language: 'zh' });
      assert.equal(sampleRes.ok, true, 'sample.load must succeed');
      const snapRes = await host.call('library.snapshot', {});
      const deckSummary = snapRes.value?.decks?.find((d) => !d.archived) || snapRes.value?.decks?.[0];
      assert.ok(deckSummary?.id, 'deck required');
      const deckRes = await host.call('deck.get', { id: deckSummary.id });
      assert.equal(deckRes.ok, true, 'deck.get failed');
      const card = deckRes.value?.cards?.[0];
      assert.ok(card?.id, 'card required');

      // Seed a draft note with NO csdnHome configured
      const created = await host.call('note.create', {
        title: 'R56 Publish Assist Note',
        cards: [{ deckId: deckSummary.id, cardId: card.id }],
        language: 'zh',
      });
      assert.equal(created.ok, true, `note.create failed: ${created.error?.message || ''}`);

      const passes = [
        { name: 'default zh', language: 'zh', asciiMode: false },
        { name: '--ascii en', language: 'en', asciiMode: true },
      ];

      for (const pass of passes) {
        process.env.DSH_HOME = dshHome;
        await saveTuiPreferences({ language: pass.language, asciiMode: pass.asciiMode }, { env });
        host.setLanguage(pass.language);
        resetTuiStore();

        const tty = createVirtualTty(120, 36);
        let inkInstance = null;
        try {
          inkInstance = render(
            React.createElement(StudyHubTuiApp, {
              host,
              initialPage: 'notes',
              initialLanguage: pass.language,
              initialAsciiMode: pass.asciiMode,
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
          await tty.firstFramePromise;

          const initial = await tty.waitFor(
            (s) => s.includes('R56 Publish Assist Note'),
            { label: `NotesView initial (${pass.name})` },
          );
          tty.assertHealthyScreen(initial, 120, 36, `NotesView 120x36 (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(initial, `NotesView 120x36 (${pass.name})`);

          // Open Link Modal via [L]
          tty.send('L');
          const linkModal = await tty.waitFor(
            (s) =>
              (pass.language === 'zh' ? s.includes('关联公开文章链接') : s.includes('Link Published Article URL')) &&
              s.includes('Ctrl+P') &&
              s.includes('Ctrl+L') &&
              (pass.language === 'zh' ? s.includes('准备发布') && s.includes('自动查找') : s.includes('Prepare') && s.includes('Lookup')),
            { label: `Link modal open with Ctrl+P / Ctrl+L hints (${pass.name})` },
          );
          tty.assertHealthyScreen(linkModal, 120, 36, `Link Modal 120x36 (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(linkModal, `Link Modal 120x36 (${pass.name})`);

          // Press Ctrl+P (0x10) without CSDN home -> graceful feedback (0 network, 0 model calls)
          tty.send('\x10');
          const afterPrep = await tty.waitFor(
            (s) => s.includes('尚未设置 CSDN 公开主页'),
            { label: `Ctrl+P missing CSDN home feedback (${pass.name})` },
          );
          tty.assertHealthyScreen(afterPrep, 120, 36, `Link Modal after Ctrl+P (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(afterPrep, `Link Modal after Ctrl+P (${pass.name})`);

          // Press Ctrl+L (0x0c) without CSDN home -> graceful missing-home error
          tty.send('\x0c');
          const afterLookup = await tty.waitFor(
            (s) => s.includes('请先设置 CSDN 公开博客主页'),
            { label: `Ctrl+L missing CSDN home error (${pass.name})` },
          );
          tty.assertHealthyScreen(afterLookup, 120, 36, `Link Modal after Ctrl+L (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(afterLookup, `Link Modal after Ctrl+L (${pass.name})`);

          // Press Esc -> closes Link Modal cleanly
          tty.send('\x1b');
          const afterEsc = await tty.waitFor(
            (s) => !s.includes('关联公开文章链接') && !s.includes('Link Published Article URL'),
            { label: `Link Modal Esc close (${pass.name})` },
          );
          tty.assertHealthyScreen(afterEsc, 120, 36, `NotesView after Esc (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(afterEsc, `NotesView after Esc (${pass.name})`);

          // Open HelpOverlay via [?] and scroll to verify Round 56 entries
          tty.send('?');
          const helpOpen = await tty.waitFor(
            (s) => (pass.language === 'zh' ? s.includes('快捷键') : s.includes('Keyboard Shortcuts')),
            { label: `HelpOverlay open (${pass.name})` },
          );
          tty.assertHealthyScreen(helpOpen, 120, 36, `HelpOverlay 120x36 (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(helpOpen, `HelpOverlay 120x36 (${pass.name})`);

          // Scroll HelpOverlay to locate Round 56 Library [m: C], Generate [W], and Skeleton/Notes [L]
          const expectedEntries =
            pass.language === 'zh'
              ? ['题组更改所属课程', '填入课程薄弱知识点', '发布与查找链接']
              : ['Deck change course', 'Fill weak topics', 'Publish & lookup'];
          const seenEntries = new Set();
          for (const screenLine of [helpOpen]) {
            for (const entry of expectedEntries) {
              if (screenLine.includes(entry)) seenEntries.add(entry);
            }
          }
          for (let step = 0; step < 12 && seenEntries.size < expectedEntries.length; step += 1) {
            tty.send('\x04'); // Ctrl+D half-page scroll
            await sleep(40);
            await tty.flush();
            const scrolled = tty.readScreen();
            tty.assertHealthyScreen(scrolled, 120, 36, `HelpOverlay scroll #${step} (${pass.name})`);
            if (pass.asciiMode) tty.assertAsciiPure(scrolled, `HelpOverlay scroll #${step} (${pass.name})`);
            for (const entry of expectedEntries) {
              if (scrolled.includes(entry)) seenEntries.add(entry);
            }
          }
          assert.deepEqual(
            [...seenEntries].sort(),
            [...expectedEntries].sort(),
            `HelpOverlay missing Round 56 entries (${pass.name})`,
          );

          // Close HelpOverlay via Esc
          tty.send('\x1b');
          await tty.waitFor(
            (s) => !s.includes('快捷键') && !s.includes('Keyboard Shortcuts'),
            { label: `HelpOverlay Esc close (${pass.name})` },
          );

          // Resize to 80x24 and verify compact Link modal & HelpOverlay
          tty.resize(80, 24);
          await sleep(80);
          await tty.flush();
          const compactScreen = tty.readScreen();
          tty.assertHealthyScreen(compactScreen, 80, 24, `NotesView 80x24 (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(compactScreen, `NotesView 80x24 (${pass.name})`);

          tty.send('L');
          const compactModal = await tty.waitFor(
            (s) =>
              (pass.language === 'zh' ? s.includes('关联公开文章链接') : s.includes('Link Published Article URL')) &&
              s.includes('Ctrl+P') &&
              s.includes('Ctrl+L'),
            { label: `Link modal 80x24 (${pass.name})` },
          );
          tty.assertHealthyScreen(compactModal, 80, 24, `Link Modal 80x24 (${pass.name})`);
          if (pass.asciiMode) tty.assertAsciiPure(compactModal, `Link Modal 80x24 (${pass.name})`);

          tty.send('\x1b');
          await tty.waitFor(
            (s) => !s.includes('关联公开文章链接') && !s.includes('Link Published Article URL'),
            { label: `Link modal Esc close 80x24 (${pass.name})` },
          );
        } finally {
          try {
            inkInstance?.unmount();
          } catch {
            // ignore unmount errors
          }
          tty.dispose();
        }
      }

      assert.equal(modelCalls, 0, 'PTY flow must trigger 0 model calls');
    } finally {
      await host.dispose();
    }
  });
});
