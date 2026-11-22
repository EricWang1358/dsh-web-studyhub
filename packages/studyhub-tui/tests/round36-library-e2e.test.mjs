// Round 36 LibraryView Deck Reordering ([ / ]) E2E verification:
// node --test tests/round36-library-e2e.test.mjs
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

let createTuiHost = null;
let saveTuiPreferences = null;
let displayWidth = null;
let useTuiStore = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('store-') || f.startsWith('chunk-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!createTuiHost && typeof mod.createTuiHost === 'function') createTuiHost = mod.createTuiHost;
    if (!saveTuiPreferences && typeof mod.saveTuiPreferences === 'function') saveTuiPreferences = mod.saveTuiPreferences;
    if (!displayWidth && typeof mod.displayWidth === 'function') displayWidth = mod.displayWidth;
    if (!useTuiStore && typeof mod.useTuiStore?.getState === 'function') useTuiStore = mod.useTuiStore;
  }
}
assert.ok(createTuiHost, 'dist/ must export createTuiHost');
assert.ok(saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(displayWidth, 'dist/ must export displayWidth');
assert.ok(useTuiStore, 'dist/ must export useTuiStore');

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round36-${label}-`));
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

function deckListTextAfterHeader(screen) {
  const lines = screen.split('\n');
  const headerIdx = lines.findIndex((l) => l.includes('题组列表') || l.includes('Decks'));
  if (headerIdx < 0) return screen;
  return lines.slice(headerIdx + 1).join('\n');
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

describe('Round 36: LibraryView deck reordering ([ / ]) E2E', () => {
  after(async () => {
    if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = PREV_DSH_HOME;
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
  });

  test('1) createTuiHost integration: load sample course, swap first two decks with deck.reorder, verify snapshot, swap back', async () => {
    const base = await makeTempDir('host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      const sampleRes = await host.call('sample.load', { language: 'en' });
      assert.equal(sampleRes.ok, true, sampleRes.error?.message);

      const initialSnap = await host.call('snapshot', {});
      assert.equal(initialSnap.ok, true, initialSnap.error?.message);
      const initialIds = (initialSnap.value?.decks ?? []).map((d) => d.id);
      assert.ok(initialIds.length >= 2, `Expected at least 2 sample decks, got ${initialIds.length}`);

      // Reject incomplete ids payload cleanly
      const badRes = await host.call('deck.reorder', { ids: [initialIds[0]] });
      assert.equal(badRes.ok, false, 'deck.reorder must reject incomplete ids');

      // Swap first two decks
      const swappedIds = [initialIds[1], initialIds[0], ...initialIds.slice(2)];
      const swapRes = await host.call('deck.reorder', { ids: swappedIds });
      assert.equal(swapRes.ok, true, swapRes.error?.message);

      const afterSwapSnap = await host.call('snapshot', {});
      assert.equal(afterSwapSnap.ok, true);
      assert.deepEqual(
        (afterSwapSnap.value?.decks ?? []).map((d) => d.id),
        swappedIds,
        'snapshot must reflect swapped deck order',
      );

      // Swap back
      const restoreRes = await host.call('deck.reorder', { ids: initialIds });
      assert.equal(restoreRes.ok, true, restoreRes.error?.message);

      const restoredSnap = await host.call('snapshot', {});
      assert.equal(restoredSnap.ok, true);
      assert.deepEqual(
        (restoredSnap.value?.decks ?? []).map((d) => d.id),
        initialIds,
        'snapshot must reflect restored deck order',
      );
    } finally {
      await host.dispose();
    }
  });

  test('2) PTY E2E: LibraryView [ / ] reorders sample decks, keeps focus on moved deck, and handles boundaries + --ascii', async () => {
    const base = await makeTempDir('pty');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');

    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
    resetTuiStore();

    let host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
    });

    const sampleRes = await host.call('sample.load', { language: 'zh' });
    assert.equal(sampleRes.ok, true, sampleRes.error?.message);
    const snap0 = await host.call('snapshot', {});
    assert.equal(snap0.ok, true);
    const initialIds = (snap0.value?.decks ?? []).map((d) => d.id);
    assert.ok(initialIds.length >= 2, 'sample course must provide at least 2 decks');
    const firstDeckTitle = snap0.value.decks[0].title;
    const secondDeckTitle = snap0.value.decks[1].title;

    const tty = createVirtualTty(120, 36);
    let inkInstance = null;
    try {
      inkInstance = render(React.createElement(StudyHubTuiApp, { host, asciiMode: false }), {
        stdin: tty.stdin,
        stdout: tty.stdout,
        stderr: tty.stderr,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await tty.firstFramePromise;

      const firstPrefix = firstDeckTitle.slice(0, 10);
      const secondPrefix = secondDeckTitle.slice(0, 10);
      const initialScreen = await tty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'library' &&
          s.includes(firstDeckTitle) &&
          s.includes(secondPrefix) &&
          s.includes('[/]'),
        { label: 'LibraryView initial render with sample decks and [/] hint' },
      );
      tty.assertHealthyScreen(initialScreen, 120, 36, 'LibraryView initial 120x36');
      const initialList = deckListTextAfterHeader(initialScreen);
      assert.ok(
        initialList.indexOf(firstPrefix) >= 0 && initialList.indexOf(firstPrefix) < initialList.indexOf(secondPrefix),
        'first sample deck must appear before second sample deck initially',
      );

      // Press '[' at index 0 -> friendly boundary toast, stays on library, no crash
      tty.send('[');
      await tty.waitFor(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('已经是第一个题组')),
        { label: 'Boundary toast when pressing [ at index 0' },
      );
      assert.equal(useTuiStore.getState().page, 'library', '[ must be claimed by LibraryView and not navigate away');
      tty.assertHealthyScreen(tty.readScreen(), 120, 36, 'LibraryView after [ at index 0');

      // Press ']' -> moves first deck down, updates snapshot order, shows toast, keeps focus on moved deck
      tty.send(']');
      await tty.waitFor(
        () =>
          useTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes(`已下移「${firstDeckTitle}」`)) &&
          (useTuiStore.getState().snapshot?.decks ?? [])[1]?.id === initialIds[0],
        { label: 'Moved first deck down with ]' },
      );
      const afterDownScreen = await tty.waitFor(
        (s) => {
          const list = deckListTextAfterHeader(s);
          const idx1 = list.indexOf(secondPrefix);
          const idx0 = list.indexOf(firstPrefix);
          return idx1 >= 0 && idx0 > idx1 && s.includes(firstDeckTitle);
        },
        { label: 'Updated deck order rendered after ]' },
      );
      tty.assertHealthyScreen(afterDownScreen, 120, 36, 'LibraryView after ]');

      // Verify selection stayed on moved deck (now at last index): pressing ']' again shows last-deck boundary toast
      tty.send(']');
      await tty.waitFor(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('已经是最后一个题组')),
        { label: 'Boundary toast confirming focus stayed on moved deck at last index' },
      );

      // Press '[' -> moves the deck back up to index 0
      tty.send('[');
      await tty.waitFor(
        () =>
          useTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes(`已上移「${firstDeckTitle}」`)) &&
          (useTuiStore.getState().snapshot?.decks ?? [])[0]?.id === initialIds[0],
        { label: 'Moved deck back up with [' },
      );
      const afterUpScreen = await tty.waitFor(
        (s) => {
          const list = deckListTextAfterHeader(s);
          const idx0 = list.indexOf(firstPrefix);
          const idx1 = list.indexOf(secondPrefix);
          return idx0 >= 0 && idx1 > idx0 && s.includes(firstDeckTitle);
        },
        { label: 'Restored deck order rendered after [' },
      );
      tty.assertHealthyScreen(afterUpScreen, 120, 36, 'LibraryView after [');

      inkInstance.unmount();
      inkInstance = null;
      tty.dispose();
      await host.dispose();

      // Dedicated --ascii mode & 80x24 verification in English
      await saveTuiPreferences({ language: 'en', asciiMode: true }, { env });
      resetTuiStore();
      host = await createTuiHost({
        libraryRoot,
        env,
        home: base,
        documentsDir: base,
        skipAutoProbe: true,
        language: 'en',
      });
      await host.call('sample.remove', {});
      const sampleEn = await host.call('sample.load', { language: 'en' });
      assert.equal(sampleEn.ok, true, sampleEn.error?.message);
      const snapEn = await host.call('snapshot', {});
      const enIds = (snapEn.value?.decks ?? []).map((d) => d.id);
      const enFirst = snapEn.value.decks[0].title;
      const enSecond = snapEn.value.decks[1].title;

      const asciiTty = createVirtualTty(120, 36);
      try {
        inkInstance = render(React.createElement(StudyHubTuiApp, { host, asciiMode: true }), {
          stdin: asciiTty.stdin,
          stdout: asciiTty.stdout,
          stderr: asciiTty.stderr,
          exitOnCtrlC: false,
          patchConsole: false,
        });
        await asciiTty.firstFramePromise;

        const enFirstPrefix = enFirst.slice(0, 10);
        const enSecondPrefix = enSecond.slice(0, 10);
        const asciiWide = await asciiTty.waitFor(
          (s) => s.includes(enFirstPrefix) && s.includes(enSecondPrefix) && s.includes('[/]'),
          { label: 'ASCII LibraryView 120x36' },
        );
        asciiTty.assertHealthyScreen(asciiWide, 120, 36, 'ASCII LibraryView 120x36');
        asciiTty.assertAsciiPure(asciiWide, 'ASCII LibraryView 120x36');

        // Boundary at index 0 in English ASCII mode
        asciiTty.send('[');
        await asciiTty.waitFor(
          () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('Already the first deck')),
          { label: 'ASCII English boundary toast' },
        );
        asciiTty.assertAsciiPure(asciiTty.readScreen(), 'ASCII LibraryView after boundary [');

        // Reorder down in ASCII mode and check 80x24 narrow layout
        asciiTty.send(']');
        await asciiTty.waitFor(
          () =>
            useTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes(`Moved "${enFirst}" down`)) &&
            (useTuiStore.getState().snapshot?.decks ?? [])[1]?.id === enIds[0],
          { label: 'ASCII English ] move down' },
        );
        asciiTty.assertAsciiPure(asciiTty.readScreen(), 'ASCII LibraryView after ]');

        asciiTty.resize(80, 24);
        const asciiNarrow = await asciiTty.waitFor(
          (s) => s.includes(enFirstPrefix) && s.includes(enSecondPrefix) && s.split('\n').length <= 24,
          { label: 'ASCII LibraryView 80x24' },
        );
        asciiTty.assertHealthyScreen(asciiNarrow, 80, 24, 'ASCII LibraryView 80x24');
        asciiTty.assertAsciiPure(asciiNarrow, 'ASCII LibraryView 80x24');
      } finally {
        inkInstance?.unmount();
        inkInstance = null;
        asciiTty.dispose();
      }
    } finally {
      inkInstance?.unmount();
      tty.dispose();
      await host.dispose();
    }
  });
});
