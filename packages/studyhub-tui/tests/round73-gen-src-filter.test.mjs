// Round 73 Track 3: GenerateView `/` live material filter preserving multi-selection
// node --test --test-concurrency=1 tests/round73-gen-src-filter.test.mjs
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
import { tsImport } from 'tsx/esm/api';

const { Terminal } = xtermPkg;
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const distDir = resolve(pkgRoot, 'dist');

const { filterMaterialGroups } = await tsImport('../src/views/generate/GenerateView.tsx', import.meta.url);

// Canonical dist chunk discovery
const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const { StudyHubTuiApp } = await import(pathToFileURL(join(distDir, 'App.mjs')).href);

let createTuiHost = null;
let saveTuiPreferences = null;
let displayWidth = null;
let useTuiStore = null;
let DEFAULT_PREFERENCES = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('store-') || f.startsWith('chunk-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!createTuiHost && typeof mod.createTuiHost === 'function') createTuiHost = mod.createTuiHost;
    if (!saveTuiPreferences && typeof mod.saveTuiPreferences === 'function') saveTuiPreferences = mod.saveTuiPreferences;
    if (!displayWidth && typeof mod.displayWidth === 'function') displayWidth = mod.displayWidth;
    if (!useTuiStore && typeof mod.useTuiStore?.getState === 'function') useTuiStore = mod.useTuiStore;
    if (!DEFAULT_PREFERENCES && mod.DEFAULT_PREFERENCES) DEFAULT_PREFERENCES = mod.DEFAULT_PREFERENCES;
  }
}
assert.ok(createTuiHost, 'dist/ must export createTuiHost');
assert.ok(saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(displayWidth, 'dist/ must export displayWidth');
assert.ok(useTuiStore, 'dist/ must export useTuiStore');
assert.ok(DEFAULT_PREFERENCES, 'dist/ must export DEFAULT_PREFERENCES');

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round73-gen-src-filter-${label}-`));
  tempDirs.push(d);
  return d;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const UNICODE_UI_CHROME_RE = /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u27BF\u2800-\u28FF\u2190-\u21FF\u2022\u2026\u2039\u203A]/g;

function resetDistStore(language = 'zh', asciiMode = false) {
  useTuiStore.setState({
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
    assert.ok(!screen.includes('\uFFFD'), `${label}: replacement char U+FFFD leaked`);
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

describe('Round 73 Track 3: GenerateView / live material filter preserving multi-selection', () => {
  after(async () => {
    if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = PREV_DSH_HOME;
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
  });

  test('1) filterMaterialGroups unit test filters case-insensitively across title, courses, folder, and format', () => {
    const docs = [
      {
        key: 'doc:os-1',
        title: 'Virtual Memory & TLB',
        format: 'pdf',
        pageCount: 10,
        sourceIds: ['s1'],
        pages: [{ sourceId: 's1', page: 1, title: 'p1', chars: 500 }],
        courses: ['CS301'],
        folder: 'Lectures',
        cardCount: 0,
        chars: 500,
        pinned: false,
        archived: false,
      },
      {
        key: 'doc:net-2',
        title: 'Raft Consensus Lab',
        format: 'md',
        pageCount: 2,
        sourceIds: ['s2'],
        pages: [{ sourceId: 's2', page: 1, title: 'p1', chars: 400 }],
        courses: ['CS402'],
        folder: 'Labs',
        cardCount: 0,
        chars: 400,
        pinned: false,
        archived: false,
      },
    ];

    assert.equal(filterMaterialGroups(docs, '').length, 2);
    assert.equal(filterMaterialGroups(docs, '   ').length, 2);
    assert.deepEqual(filterMaterialGroups(docs, 'RAFT').map((d) => d.key), ['doc:net-2']);
    assert.deepEqual(filterMaterialGroups(docs, 'cs301').map((d) => d.key), ['doc:os-1']);
    assert.deepEqual(filterMaterialGroups(docs, 'lectures').map((d) => d.key), ['doc:os-1']);
    assert.deepEqual(filterMaterialGroups(docs, 'MD').map((d) => d.key), ['doc:net-2']);
    assert.deepEqual(filterMaterialGroups(docs, 'nonexistent'), []);
  });

  test('2) PTY E2E (120x36 zh): seed 2 sources -> Space on source 1 -> / filter to source 2 -> Enter -> Space on source 2 -> Esc clears -> BOTH remain selected (0 model calls)', async () => {
    const base = await makeTempDir('pty-zh');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
    resetDistStore('zh', false);

    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot: join(base, 'library'),
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
      injectedComplete: async () => {
        modelCalls += 1;
        return '{}';
      },
    });

    const add1 = await host.call('source.add', {
      title: 'A1 操作系统内存管理讲义',
      text: '# Virtual Memory\nPage table walk and TLB hit/miss.',
      courses: ['CS301'],
      format: 'md',
    });
    assert.equal(add1.ok, true, add1.error?.message);

    const add2 = await host.call('source.add', {
      title: 'B2 分布式系统 Raft 共识笔记',
      text: '# Raft Consensus\nLeader election and log replication invariants.',
      courses: ['CS301'],
      format: 'md',
    });
    assert.equal(add2.ok, true, add2.error?.message);

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

      await tty.waitFor(() => useTuiStore.getState().page === 'library' && Boolean(useTuiStore.getState().snapshot), {
        label: 'zh LibraryView ready',
      });

      // Navigate to GenerateView ('3')
      tty.send('3');
      const genScreen = await tty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'generate' &&
          s.includes('新建出题任务') &&
          s.includes('A1 操作系统内存管理讲义') &&
          s.includes('B2 分布式系统 Raft 共识笔记'),
        { label: 'zh GenerateView ready with both sources' },
      );
      tty.assertHealthyScreen(genScreen, 120, 36, 'zh GenerateView initial');
      assert.equal(modelCalls, 0);

      // Select source 1 (A1) with Space -> ☑ on A1 and 1p in Panel badge
      tty.send(' ');
      await tty.waitFor((s) => s.includes('☑ [MD] A1') && s.includes('Space 勾选)  1p'), {
        label: 'zh source 1 selected',
      });

      // Press '/' to open live material filter
      tty.send('/');
      await tty.waitFor((s) => s.includes('[筛选 2/2]'), { label: 'zh filter bar opened' });

      // Type 'raft' to filter to source 2 (case-insensitive)
      tty.send('raft');
      const filteredTyping = await tty.waitFor(
        (s) =>
          s.includes('[筛选 1/2]') &&
          s.includes('B2 分布式系统 Raft 共识笔记') &&
          !s.includes('A1 操作系统内存管理讲义'),
        { label: 'zh filtered to source 2 while typing' },
      );
      tty.assertHealthyScreen(filteredTyping, 120, 36, 'zh GenerateView filter typing');

      // Press Enter to confirm filter (keeps filter active, blurs input)
      tty.send('\r');
      await tty.waitFor((s) => s.includes('[筛选 1/2]') && s.includes('/ 编辑 | Esc 清除'), {
        label: 'zh filter confirmed with Enter',
      });

      // Press Space to select source 2 -> 2p selected (source 1 preserved!)
      tty.send(' ');
      await tty.waitFor(
        (s) => s.includes('Space 勾选)  2p') && s.includes('☑ [MD] B2'),
        { label: 'zh source 2 selected while source 1 preserved (2p)' },
      );

      // Verify `a` toggles only visible filtered item without dropping hidden source 1
      tty.send('a');
      await tty.waitFor(
        (s) => s.includes('Space 勾选)  1p') && s.includes('☐ [MD] B2'),
        { label: 'zh [a] deselects visible source 2 without dropping hidden source 1' },
      );
      tty.send('a');
      await tty.waitFor(
        (s) => s.includes('Space 勾选)  2p') && s.includes('☑ [MD] B2'),
        { label: 'zh [a] re-selects visible source 2 (2p)' },
      );

      // Press Esc to clear filter -> both sources visible and BOTH remain selected (2p, two ☑)
      tty.send('\x1b');
      const restored = await tty.waitFor(
        (s) =>
          !s.includes('[筛选') &&
          s.includes('Space 勾选)  2p') &&
          s.includes('☑ [MD] A1') &&
          s.includes('☑ [MD] B2'),
        { label: 'zh Esc cleared filter and preserved both selections' },
      );
      tty.assertHealthyScreen(restored, 120, 36, 'zh GenerateView after Esc clear');
      assert.equal(modelCalls, 0, 'Filtering and selecting materials must make 0 model calls');
    } finally {
      inkInstance?.unmount();
      inkInstance = null;
      tty.dispose();
      await host.dispose();
    }
  });

  test('3) PTY E2E (80x24 --ascii en): GenerateView (3) -> / filter -> Enter -> Esc -> assertHealthyScreen + assertAsciiPure', async () => {
    const base = await makeTempDir('pty-en-ascii');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    await saveTuiPreferences({ language: 'en', asciiMode: true }, { env });
    resetDistStore('en', true);

    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot: join(base, 'library'),
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'en',
      injectedComplete: async () => {
        modelCalls += 1;
        return '{}';
      },
    });

    const add1 = await host.call('source.add', {
      title: 'OS Virtual Memory',
      text: 'Paging and TLB architecture.',
      courses: ['CS301'],
      format: 'md',
    });
    assert.equal(add1.ok, true, add1.error?.message);

    const add2 = await host.call('source.add', {
      title: 'Raft Consensus Guide',
      text: 'Term numbers and AppendEntries RPC.',
      courses: ['CS301'],
      format: 'md',
    });
    assert.equal(add2.ok, true, add2.error?.message);

    const tty = createVirtualTty(80, 24);
    let inkInstance = null;
    try {
      inkInstance = render(React.createElement(StudyHubTuiApp, { host, asciiMode: true }), {
        stdin: tty.stdin,
        stdout: tty.stdout,
        stderr: tty.stderr,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await tty.firstFramePromise;

      await tty.waitFor(() => useTuiStore.getState().page === 'library' && Boolean(useTuiStore.getState().snapshot), {
        label: 'en --ascii LibraryView ready',
      });

      tty.send('3');
      const genInit = await tty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'generate' &&
          s.includes('New Generation') &&
          s.includes('OS Virtual') &&
          s.includes('Raft Consen'),
        { label: 'en --ascii GenerateView ready' },
      );
      tty.assertHealthyScreen(genInit, 80, 24, 'en --ascii GenerateView initial 80x24');
      tty.assertAsciiPure(genInit, 'en --ascii GenerateView initial 80x24');

      // Open filter with '/'
      tty.send('/');
      const filterOpen = await tty.waitFor((s) => s.includes('[Filter 2/2]'), {
        label: 'en --ascii filter bar open',
      });
      tty.assertHealthyScreen(filterOpen, 80, 24, 'en --ascii filter bar open 80x24');
      tty.assertAsciiPure(filterOpen, 'en --ascii filter bar open 80x24');

      // Type 'raft'
      tty.send('raft');
      const filterTyping = await tty.waitFor(
        (s) => s.includes('[Filter 1/2]') && s.includes('Raft Consen') && !s.includes('OS Virtual'),
        { label: 'en --ascii filtered to Raft' },
      );
      tty.assertHealthyScreen(filterTyping, 80, 24, 'en --ascii filter typing 80x24');
      tty.assertAsciiPure(filterTyping, 'en --ascii filter typing 80x24');

      // Confirm with Enter
      tty.send('\r');
      const filterConfirmed = await tty.waitFor((s) => s.includes('[Filtered 1/2]'), {
        label: 'en --ascii filter confirmed',
      });
      tty.assertHealthyScreen(filterConfirmed, 80, 24, 'en --ascii filter confirmed 80x24');
      tty.assertAsciiPure(filterConfirmed, 'en --ascii filter confirmed 80x24');

      // Select filtered item with Space
      tty.send(' ');
      await tty.waitFor((s) => s.includes('[x]') && s.includes('1p'), {
        label: 'en --ascii filtered item selected',
      });

      // Clear with Esc
      tty.send('\x1b');
      const cleared = await tty.waitFor(
        (s) => !s.includes('[Filtered') && s.includes('OS Virtual') && s.includes('Raft Consen') && s.includes('1p'),
        { label: 'en --ascii filter cleared with Esc' },
      );
      tty.assertHealthyScreen(cleared, 80, 24, 'en --ascii after Esc clear 80x24');
      tty.assertAsciiPure(cleared, 'en --ascii after Esc clear 80x24');
      assert.equal(modelCalls, 0);
    } finally {
      inkInstance?.unmount();
      inkInstance = null;
      tty.dispose();
      await host.dispose();
    }
  });
});
