// Round 37 SourcesView Pinned Material Reordering ([ / ]) E2E verification:
// node --test tests/round37-sources-e2e.test.mjs
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
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round37-${label}-`));
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

function sourceListText(screen) {
  const lines = screen.split('\n');
  const headerIdx = lines.findIndex((l) => l.includes('资料列表') || l.includes('Materials'));
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

async function addTextSource(host, title, text) {
  const res = await host.call('source.add', { title, text });
  assert.equal(res.ok, true, `source.add(${title}) failed: ${res.error?.message || ''}`);
  const id = res.value?.source?.id || res.value?.id;
  assert.ok(id, `source.add(${title}) must return source id`);
  return `source:${id}`;
}

describe('Round 37: SourcesView pinned material reordering ([ / ]) E2E', () => {
  after(async () => {
    if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = PREV_DSH_HOME;
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
  });

  test('1) createTuiHost integration: pin multiple sources, reorder with source.pin.move, verify persisted order', async () => {
    const base = await makeTempDir('host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');

    let host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      const keyA = await addTextSource(host, 'Alpha Notes', 'Alpha notes text');
      const keyB = await addTextSource(host, 'Beta Slides', 'Beta slides text');
      const keyC = await addTextSource(host, 'Gamma Paper', 'Gamma paper text');

      // Pin all 3 sources in A -> B -> C order
      for (const key of [keyA, keyB, keyC]) {
        const pinRes = await host.call('source.pin', { key, pinned: true });
        assert.equal(pinRes.ok, true, pinRes.error?.message);
      }

      const snap1 = await host.call('snapshot', {});
      assert.equal(snap1.ok, true);
      assert.deepEqual(snap1.value?.settings?.materialPins, [keyA, keyB, keyC]);

      // Reject moving next to an invalid/unpinned key
      const badMove = await host.call('source.pin.move', { key: keyA, before: 'source:nonexistent' });
      assert.equal(badMove.ok, false, 'source.pin.move must reject non-pinned target');

      // Move C before A -> [C, A, B]
      const moveBefore = await host.call('source.pin.move', { key: keyC, before: keyA });
      assert.equal(moveBefore.ok, true, moveBefore.error?.message);
      assert.deepEqual(moveBefore.value?.pins, [keyC, keyA, keyB]);

      // Move C after B -> [A, B, C]
      const moveAfter = await host.call('source.pin.move', { key: keyC, after: keyB });
      assert.equal(moveAfter.ok, true, moveAfter.error?.message);
      assert.deepEqual(moveAfter.value?.pins, [keyA, keyB, keyC]);

      // Move B to front -> [B, A, C]
      const moveFront = await host.call('source.pin.move', { key: keyB, front: true });
      assert.equal(moveFront.ok, true, moveFront.error?.message);
      assert.deepEqual(moveFront.value?.pins, [keyB, keyA, keyC]);

      const snap2 = await host.call('snapshot', {});
      assert.equal(snap2.ok, true);
      assert.deepEqual(snap2.value?.settings?.materialPins, [keyB, keyA, keyC]);

      // Re-open host on same libraryRoot to confirm persistence on disk
      await host.dispose();
      host = await createTuiHost({
        libraryRoot,
        env,
        home: base,
        documentsDir: base,
        skipAutoProbe: true,
        language: 'en',
      });
      const reloadedSnap = await host.call('snapshot', {});
      assert.equal(reloadedSnap.ok, true);
      assert.deepEqual(
        reloadedSnap.value?.settings?.materialPins,
        [keyB, keyA, keyC],
        'persisted pinned order must survive host reload',
      );
    } finally {
      await host.dispose();
    }
  });

  test('2) PTY E2E: SourcesView [ / ] handles unpinned/pinned materials, keeps focus, and passes 120x36 & 80x24 (--ascii & default)', async () => {
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

    const keyA = await addTextSource(host, 'Alpha Notes', 'Alpha notes body');
    const keyB = await addTextSource(host, 'Beta Slides', 'Beta slides body');
    await addTextSource(host, 'Gamma Paper', 'Gamma paper body');

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

      // Navigate to SourcesView via '2'
      await tty.waitFor(() => useTuiStore.getState().page === 'library' && Boolean(useTuiStore.getState().snapshot), {
        label: 'Initial LibraryView ready',
      });
      tty.send('2');
      const initialScreen = await tty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'sources' &&
          s.includes('Alpha Notes') &&
          s.includes('Beta Slides') &&
          s.includes('Gamma Paper') &&
          s.includes('[/]'),
        { label: 'SourcesView initial render with 3 materials and [/] hint' },
      );
      tty.assertHealthyScreen(initialScreen, 120, 36, 'SourcesView initial 120x36');

      // 1. Pressing '[' / ']' on unpinned source shows friendly toast and does NOT navigate away
      useTuiStore.setState({ toasts: [] });
      tty.send('[');
      await tty.waitFor(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('请先按 [p] 置顶资料后再调整顺序')),
        { label: 'Unpinned [ toast in zh' },
      );
      assert.equal(useTuiStore.getState().page, 'sources', '[ must be claimed by SourcesView');

      useTuiStore.setState({ toasts: [] });
      tty.send(']');
      await tty.waitFor(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('请先按 [p] 置顶资料后再调整顺序')),
        { label: 'Unpinned ] toast in zh' },
      );
      assert.equal(useTuiStore.getState().page, 'sources', '] must be claimed by SourcesView');

      // 2. Pin Beta Slides (index 1) -> moves to pinned index 0
      tty.send('j');
      await tty.flush();
      useTuiStore.setState({ toasts: [] });
      tty.send('p');
      await tty.waitFor(
        () =>
          useTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已置顶')) &&
          JSON.stringify(useTuiStore.getState().snapshot?.settings?.materialPins ?? []) === JSON.stringify([keyB]),
        { label: 'Pinned Beta Slides' },
      );

      // Boundary toast on single pinned item
      useTuiStore.setState({ toasts: [] });
      tty.send('[');
      await tty.waitFor(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('已经是第一个置顶资料')),
        { label: 'First pinned boundary toast' },
      );

      // 3. Move to Alpha Notes (now index 1) and pin it -> materialPins = [keyB, keyA], cursor stays on Alpha Notes (index 1)
      tty.send('j');
      await tty.flush();
      useTuiStore.setState({ toasts: [] });
      tty.send('p');
      await tty.waitFor(
        () =>
          JSON.stringify(useTuiStore.getState().snapshot?.settings?.materialPins ?? []) === JSON.stringify([keyB, keyA]) &&
          useTuiStore.getState().toasts.some((toast) => toast.text.includes('置顶')),
        { label: 'Pinned Alpha Notes second' },
      );
      await tty.flush();

      // Last pinned boundary toast on Alpha Notes (index 1)
      useTuiStore.setState({ toasts: [] });
      tty.send(']');
      await tty.waitFor(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('已经是最后一个置顶资料')),
        { label: 'Last pinned boundary toast' },
      );

      // Move Alpha Notes up with '[' -> [keyA, keyB], focus stays on Alpha Notes
      useTuiStore.setState({ toasts: [] });
      tty.send('[');
      await tty.waitFor(
        () =>
          useTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已上移置顶「Alpha Notes」')) &&
          JSON.stringify(useTuiStore.getState().snapshot?.settings?.materialPins ?? []) === JSON.stringify([keyA, keyB]),
        { label: 'Moved Alpha Notes up with [' },
      );
      const afterUpScreen = await tty.waitFor(
        (s) => {
          const list = sourceListText(s);
          const idxA = list.indexOf('Alpha Notes');
          const idxB = list.indexOf('Beta Slides');
          return idxA >= 0 && idxB > idxA;
        },
        { label: 'Updated pinned order rendered after [' },
      );
      tty.assertHealthyScreen(afterUpScreen, 120, 36, 'SourcesView after [');

      // Confirm focus stayed on Alpha Notes (now index 0): '[' triggers first-pinned toast
      useTuiStore.setState({ toasts: [] });
      tty.send('[');
      await tty.waitFor(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('已经是第一个置顶资料')),
        { label: 'Confirm focus stayed on moved Alpha Notes at index 0' },
      );

      // Move Alpha Notes back down with ']' -> [keyB, keyA]
      useTuiStore.setState({ toasts: [] });
      tty.send(']');
      await tty.waitFor(
        () =>
          useTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已下移置顶「Alpha Notes」')) &&
          JSON.stringify(useTuiStore.getState().snapshot?.settings?.materialPins ?? []) === JSON.stringify([keyB, keyA]),
        { label: 'Moved Alpha Notes down with ]' },
      );
      const afterDownScreen = await tty.waitFor(
        (s) => {
          const list = sourceListText(s);
          const idxB = list.indexOf('Beta Slides');
          const idxA = list.indexOf('Alpha Notes');
          return idxB >= 0 && idxA > idxB;
        },
        { label: 'Restored pinned order rendered after ]' },
      );
      tty.assertHealthyScreen(afterDownScreen, 120, 36, 'SourcesView after ]');

      // Check narrow 80x24 layout in default mode
      tty.resize(80, 24);
      const narrowDefault = await tty.waitFor(
        (s) => s.includes('Beta Slides') && s.includes('Alpha Notes') && s.split('\n').length <= 24,
        { label: 'SourcesView 80x24 default mode' },
      );
      tty.assertHealthyScreen(narrowDefault, 80, 24, 'SourcesView 80x24 default');

      inkInstance.unmount();
      inkInstance = null;
      tty.dispose();
      await host.dispose();

      // 4. Dedicated --ascii mode & 80x24 verification in English (preserving [keyB, keyA] pins, keyC unpinned)
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

        await asciiTty.waitFor(() => useTuiStore.getState().page === 'library' && Boolean(useTuiStore.getState().snapshot), {
          label: 'ASCII LibraryView ready',
        });
        asciiTty.send('2');
        const asciiWide = await asciiTty.waitFor(
          (s) =>
            useTuiStore.getState().page === 'sources' &&
            s.includes('Beta Slides') &&
            s.includes('Alpha Notes') &&
            s.includes('Gamma Paper') &&
            s.includes('[/]'),
          { label: 'ASCII SourcesView 120x36' },
        );
        asciiTty.assertHealthyScreen(asciiWide, 120, 36, 'ASCII SourcesView 120x36');
        asciiTty.assertAsciiPure(asciiWide, 'ASCII SourcesView 120x36');

        // Boundary at pinned index 0 (Beta Slides)
        asciiTty.send('[');
        await asciiTty.waitFor(
          () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('Already the first pinned material')),
          { label: 'ASCII English first-pinned boundary toast' },
        );
        asciiTty.assertAsciiPure(asciiTty.readScreen(), 'ASCII SourcesView after boundary [');

        // Reorder Beta Slides down with ']' -> [keyA, keyB]
        asciiTty.send(']');
        await asciiTty.waitFor(
          () =>
            useTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('Moved pinned "Beta Slides" down')) &&
            JSON.stringify(useTuiStore.getState().snapshot?.settings?.materialPins ?? []) === JSON.stringify([keyA, keyB]),
          { label: 'ASCII English ] move down' },
        );
        asciiTty.assertAsciiPure(asciiTty.readScreen(), 'ASCII SourcesView after ]');

        // Move to unpinned Gamma Paper (index 2) and press '[' -> unpinned toast
        asciiTty.send('j');
        await asciiTty.flush();
        asciiTty.send('[');
        await asciiTty.waitFor(
          () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('Press [p] to pin this material before reordering')),
          { label: 'ASCII English unpinned [ toast' },
        );
        asciiTty.assertAsciiPure(asciiTty.readScreen(), 'ASCII SourcesView unpinned [');

        // Resize to 80x24 and verify ASCII purity + screen health
        asciiTty.resize(80, 24);
        const asciiNarrow = await asciiTty.waitFor(
          (s) => s.includes('Alpha Notes') && s.includes('Beta Slides') && s.split('\n').length <= 24,
          { label: 'ASCII SourcesView 80x24' },
        );
        asciiTty.assertHealthyScreen(asciiNarrow, 80, 24, 'ASCII SourcesView 80x24');
        asciiTty.assertAsciiPure(asciiNarrow, 'ASCII SourcesView 80x24');
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
