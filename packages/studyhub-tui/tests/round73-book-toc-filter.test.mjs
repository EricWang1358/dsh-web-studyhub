// Round 73 Track 2: BookView [/] Live TOC Filter (`BookView.tsx`, 0 LLM tokens)
// @xterm/headless PTY E2E tests:
// node --test --test-concurrency=1 tests/round73-book-toc-filter.test.mjs
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import xtermPkg from '@xterm/headless';
import { render } from 'ink';
import React from 'react';
import { StudyService } from '../../../lib/service.js';
import { courseOutlineMaterial, materialsFingerprint } from '../../../lib/course-outline-book.js';
import { courseNotesMaterial } from '../../../lib/course-book.js';
import { buildOutlineIndex } from '../../../lib/course-outline-index.js';
import { groupSourcesByDocument } from '../../../lib/source-groups.js';
import { openCourseBook } from '../../../lib/course-book-files.js';

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
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('chunk-') || f.startsWith('store-')) {
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

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-r73-book-filter-${label}-`));
  tempDirs.push(d);
  return d;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const UNICODE_UI_CHROME_RE = /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u27BF\u2800-\u28FF\u2190-\u21FF\u2022\u2026\u2039\u203A]/g;

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

const BOOK_COURSE = 'TocFilterCourse';

async function seedMultiPointBook(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.store.update((state) => {
    state.sources.push(
      {
        id: 'doc1-p1',
        title: 'Systems · p. 1',
        createdAt: '2026-10-01T00:00:00.000Z',
        courses: [BOOK_COURSE],
        text: 'Raft elects leaders using randomized election timeouts and term numbers.',
        document: {
          materialId: 'doc-sys',
          page: 1,
          totalPages: 3,
          format: 'pdf',
          origin: 'converted',
          converter: 'marker',
          filename: 'systems.pdf',
          chapter: { index: 0, title: 'Raft Leader Election', level: 1 },
          extractionVersion: 2,
        },
      },
      {
        id: 'doc1-p2',
        title: 'Systems · p. 2',
        createdAt: '2026-10-01T01:00:00.000Z',
        courses: [BOOK_COURSE],
        text: 'Paxos requires majority quorums in Prepare and Accept phases.',
        document: {
          materialId: 'doc-sys',
          page: 2,
          totalPages: 3,
          format: 'pdf',
          origin: 'converted',
          converter: 'marker',
          filename: 'systems.pdf',
          chapter: { index: 1, title: 'Paxos Quorum Protocol', level: 1 },
          extractionVersion: 2,
        },
      },
      {
        id: 'doc1-p3',
        title: 'Systems · p. 3',
        createdAt: '2026-10-01T02:00:00.000Z',
        courses: [BOOK_COURSE],
        text: 'LSM trees batch writes in MemTable and merge SSTables via background compaction.',
        document: {
          materialId: 'doc-sys',
          page: 3,
          totalPages: 3,
          format: 'pdf',
          origin: 'converted',
          converter: 'marker',
          filename: 'systems.pdf',
          chapter: { index: 2, title: 'LSM Tree Compaction', level: 1 },
          extractionVersion: 2,
        },
      },
    );
    state.focus = { mode: 'class', course: BOOK_COURSE, role: '', jd: '', targetTopics: [] };
    const lecture = groupSourcesByDocument(state.sources).find((item) => item.sourceIds.includes('doc1-p1')).key;
    const ch1Leaves = [
      { id: 'raft-elect', title: 'Raft Leader Election', anchors: [`${lecture}#0`] },
      { id: 'paxos-quorum', title: 'Paxos Quorum Protocol', anchors: [`${lecture}#1`] },
    ];
    const ch2Leaves = [
      { id: 'lsm-compact', title: 'LSM Tree Compaction', anchors: [`${lecture}#2`] },
    ];
    const outline = {
      ...courseOutlineMaterial({
        title: 'Outline · TocFilterCourse',
        course: BOOK_COURSE,
        orderBasis: { codes: ['numbering'] },
        fingerprint: materialsFingerprint(buildOutlineIndex(state, { course: BOOK_COURSE }).allDocuments),
        nodes: [
          { id: 'ch1', title: 'Distributed Consensus', children: ch1Leaves },
          { id: 'ch2', title: 'Storage Engines', children: ch2Leaves },
        ],
        other: { anchors: [] },
        counts: { units: 3, leftover: 0, invalid: 0, repeated: 0 },
      }),
      createdAt: '2026-10-09T00:00:00.000Z',
    };
    state.sources.push(outline);
    const allLeaves = [...ch1Leaves, ...ch2Leaves];
    state.sources.push({
      ...courseNotesMaterial({
        title: 'Review Book · TocFilterCourse',
        course: BOOK_COURSE,
        outlineId: outline.id,
        language: 'zh',
        papers: [],
        counts: {},
        leaves: allLeaves.map((leaf, idx) => ({
          ...leaf,
          body: {
            fingerprint: 'd'.repeat(16),
            points: [`UNIQUE_BODY_${leaf.id.toUpperCase()} core summary [^1].`],
            explain: `Detailed notes for ${leaf.title} (${leaf.id}).`,
            cites: [{ n: 1, sourceId: `doc1-p${idx + 1}`, quote: 'term', start: 0, end: 4 }],
          },
        })),
      }),
      createdAt: '2026-10-09T01:00:00.000Z',
    });
    openCourseBook(state, { course: BOOK_COURSE });
  });
  await service.dispose();
}

describe('Round 73 Track 2: BookView / Live TOC Filter', () => {
  after(async () => {
    if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = PREV_DSH_HOME;
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
  });

  test('1) PTY E2E (120x36 zh): BookView (7) -> / -> filter to unique point -> Enter loads right-pane content -> Esc restores full TOC (0 model calls)', async () => {
    const base = await makeTempDir('pty-zh');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');
    await seedMultiPointBook(libraryRoot);
    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
    resetDistStore('zh', false);

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
        return '{}';
      },
    });

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
      await tty.waitFor((s) => s.includes(BOOK_COURSE) || s.includes('学习库'), { label: 'App loaded (zh)' });

      // Navigate to BookView ('7')
      tty.send('7');
      const initScreen = await tty.waitFor(
        (s) =>
          useDistTuiStore.getState().page === 'book' &&
          s.includes('Distributed Consensus') &&
          s.includes('Raft Leader Election') &&
          s.includes('LSM Tree Compaction') &&
          s.includes('精选问答') &&
          !s.includes('正在打开复习全书'),
        { label: 'BookView multi-point TOC loaded (zh)' },
      );
      tty.assertHealthyScreen(initScreen, 120, 36, 'BookView initial (zh)');

      // Press '/' to open inline TOC filter
      tty.send('/');
      const filterOpenScreen = await tty.waitFor(
        (s) => s.includes('[筛选 5/5]') && s.includes('Enter 确认 | Esc 清除'),
        { label: 'BookView filter bar opened (zh)' },
      );
      tty.assertHealthyScreen(filterOpenScreen, 120, 36, 'BookView filter bar opened (zh)');

      // Type unique point title (case-insensitive match)
      tty.send('lsm tree');
      const filteredEditingScreen = await tty.waitFor(
        (s) =>
          s.includes('[筛选 1/5]') &&
          s.includes('LSM Tree Compaction') &&
          !s.includes('Raft Leader Election') &&
          !s.includes('Paxos Quorum Protocol'),
        { label: 'Filtered TOC to 1/5 while editing (zh)' },
      );
      tty.assertHealthyScreen(filteredEditingScreen, 120, 36, 'BookView filtered editing (zh)');

      // Press Enter to confirm/blur filter -> right pane loads that exact point
      tty.send('\r');
      const confirmedScreen = await tty.waitFor(
        (s) =>
          s.includes('[筛选 1/5]') &&
          s.includes('/ 编辑 | Esc 清除') &&
          s.includes('UNIQUE_BODY_LSM-COMPACT') &&
          s.includes('Detailed notes for LSM Tree Compaction'),
        { label: 'Confirmed filter & right-pane loaded exact point (zh)' },
      );
      tty.assertHealthyScreen(confirmedScreen, 120, 36, 'BookView confirmed filter (zh)');

      // Press Esc in normal mode -> clears filter and restores full TOC
      tty.send('\x1b');
      const restoredScreen = await tty.waitFor(
        (s) =>
          !s.includes('[筛选') &&
          s.includes('Distributed Consensus') &&
          s.includes('Raft Leader Election') &&
          s.includes('Paxos Quorum Protocol') &&
          s.includes('LSM Tree Compaction'),
        { label: 'Esc cleared filter & restored full TOC (zh)' },
      );
      tty.assertHealthyScreen(restoredScreen, 120, 36, 'BookView restored TOC after Esc (zh)');
      assert.equal(modelCalls, 0);
    } finally {
      if (inkInstance) inkInstance.unmount();
      tty.dispose();
      await host.dispose();
    }
  });

  test('2) PTY E2E (80x24 --ascii en): BookView (7) -> / filter -> Enter -> Esc passes assertHealthyScreen + assertAsciiPure (0 model calls)', async () => {
    const base = await makeTempDir('pty-ascii-en');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');
    await seedMultiPointBook(libraryRoot);
    await saveTuiPreferences({ language: 'en', asciiMode: true }, { env });
    resetDistStore('en', true);

    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot,
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
      await tty.waitFor((s) => s.includes(BOOK_COURSE) || s.includes('Library'), { label: 'App loaded (en ascii)' });

      tty.send('7');
      const initScreen = await tty.waitFor(
        (s) =>
          useDistTuiStore.getState().page === 'book' &&
          s.includes('Distributed Consensus') &&
          s.includes('Raft Leader Election') &&
          !s.includes('Opening review book'),
        { label: 'BookView loaded 80x24 --ascii (en)' },
      );
      tty.assertHealthyScreen(initScreen, 80, 24, 'BookView initial 80x24 --ascii (en)');
      tty.assertAsciiPure(initScreen, 'BookView initial 80x24 --ascii (en)');
      await tty.flush(60);

      // Press '/' -> filter to Paxos
      tty.send('/');
      const filterScreen = await tty.waitFor(
        (s) => s.includes('[Filter 5/5]'),
        { label: 'Filter bar opened 80x24 --ascii (en)' },
      );
      tty.assertHealthyScreen(filterScreen, 80, 24, 'BookView filter open 80x24 --ascii (en)');
      tty.assertAsciiPure(filterScreen, 'BookView filter open 80x24 --ascii (en)');

      tty.send('paxos');
      const filteredScreen = await tty.waitFor(
        (s) => s.includes('[Filter 1/5]') && s.includes('Paxos Quorum') && !s.includes('Raft Leader'),
        { label: 'Filtered TOC to Paxos 80x24 --ascii (en)' },
      );
      tty.assertHealthyScreen(filteredScreen, 80, 24, 'BookView filtered editing 80x24 --ascii (en)');
      tty.assertAsciiPure(filteredScreen, 'BookView filtered editing 80x24 --ascii (en)');

      // Press Enter -> [Filtered 1/5] confirmed; in 80x24 single-pane mode press Enter again to view Content pane
      tty.send('\r');
      const confirmedScreen = await tty.waitFor(
        (s) => s.includes('[Filtered 1/5]') && s.includes('1.2 Paxos Quorum Protocol'),
        { label: 'Filter confirmed 80x24 --ascii (en)' },
      );
      tty.assertHealthyScreen(confirmedScreen, 80, 24, 'BookView filter confirmed 80x24 --ascii (en)');
      tty.assertAsciiPure(confirmedScreen, 'BookView filter confirmed 80x24 --ascii (en)');

      tty.send('\r');
      const contentScreen = await tty.waitFor(
        (s) => s.includes('UNIQUE_BODY_PAXOS-QUORUM'),
        { label: 'Content pane shows filtered point 80x24 --ascii (en)' },
      );
      tty.assertHealthyScreen(contentScreen, 80, 24, 'BookView filtered content 80x24 --ascii (en)');
      tty.assertAsciiPure(contentScreen, 'BookView filtered content 80x24 --ascii (en)');

      // Press Esc -> clears filter, then 'h' back to TOC -> full TOC restored
      tty.send('\x1b');
      await tty.waitFor(
        (s) => !s.includes('[Filtered'),
        { label: 'Esc cleared filter 80x24 --ascii (en)' },
      );
      tty.send('h');
      const restoredScreen = await tty.waitFor(
        (s) =>
          !s.includes('[Filtered') &&
          s.includes('Raft Leader') &&
          s.includes('Paxos Quorum'),
        { label: 'Full TOC restored 80x24 --ascii (en)' },
      );
      tty.assertHealthyScreen(restoredScreen, 80, 24, 'BookView restored 80x24 --ascii (en)');
      tty.assertAsciiPure(restoredScreen, 'BookView restored 80x24 --ascii (en)');
      assert.equal(modelCalls, 0);
    } finally {
      if (inkInstance) inkInstance.unmount();
      tty.dispose();
      await host.dispose();
    }
  });
});
