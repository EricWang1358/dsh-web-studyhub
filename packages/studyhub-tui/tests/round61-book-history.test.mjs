// Round 61 Track 3: BookHistoryModal (`course.book.revision { history: true }` & `course.book.revert`)
// createTuiHost integration + @xterm/headless PTY E2E tests:
// node --test --test-concurrency=1 tests/round61-book-history.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
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

// Canonical dist chunk discovery
const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const { StudyHubTuiApp } = await import(pathToFileURL(join(distDir, 'App.mjs')).href);

let H = null;
let displayWidth = null;
let useDistTuiStore = null;
let DEFAULT_PREFERENCES = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('chunk-') || f.startsWith('store-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!H && typeof mod.createTuiHost === 'function' && typeof mod.saveTuiPreferences === 'function') {
      H = {
        createTuiHost: mod.createTuiHost,
        saveTuiPreferences: mod.saveTuiPreferences,
      };
    }
    if (!displayWidth && typeof mod.displayWidth === 'function') displayWidth = mod.displayWidth;
    if (!useDistTuiStore && typeof mod.useTuiStore?.getState === 'function') useDistTuiStore = mod.useTuiStore;
    if (!DEFAULT_PREFERENCES && mod.DEFAULT_PREFERENCES) DEFAULT_PREFERENCES = mod.DEFAULT_PREFERENCES;
  }
}
assert.ok(H?.createTuiHost, 'dist/ must export createTuiHost');
assert.ok(H?.saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(displayWidth, 'dist/ must export displayWidth');
assert.ok(useDistTuiStore, 'dist/ must export useTuiStore');
assert.ok(DEFAULT_PREFERENCES, 'dist/ must export DEFAULT_PREFERENCES');

const historyChunk = distFiles.find((f) => f.startsWith('BookHistoryModal-') && f.endsWith('.mjs'));
assert.ok(historyChunk, `dist/ must emit lazy BookHistoryModal-*.mjs chunk, found: ${distFiles.join(', ')}`);
const historyChunkCode = fs.readFileSync(join(distDir, historyChunk), 'utf8');
assert.equal(/\bmarked\b/.test(historyChunkCode), false, `${historyChunk} must be marked-free`);
assert.equal(/\bcli-highlight\b/.test(historyChunkCode), false, `${historyChunk} must not bundle cli-highlight`);
assert.equal(/src\/components\/MarkdownView\.tsx/.test(historyChunkCode), false, `${historyChunk} must not bundle MarkdownView`);

const { createTuiHost, saveTuiPreferences } = H;

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round61-book-history-${label}-`));
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

const BOOK_COURSE = 'HistoryCourse';

async function seedBookLibrary(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.store.update((state) => {
    state.sources.push(
      {
        id: 'doc1-p1',
        title: 'Lecture 1 · p. 1',
        createdAt: '2026-10-01T00:00:00.000Z',
        courses: [BOOK_COURSE],
        text: 'Circuit breakers prevent cascading failures by tripping open when failure thresholds are crossed.',
        document: {
          materialId: 'doc-l1',
          page: 1,
          totalPages: 2,
          format: 'pdf',
          origin: 'converted',
          converter: 'marker',
          filename: 'lecture-1.pdf',
          chapter: { index: 0, title: 'Circuit Breaker', level: 1 },
          extractionVersion: 2,
        },
      },
      {
        id: 'doc1-p2',
        title: 'Lecture 1 · p. 2',
        createdAt: '2026-10-01T01:00:00.000Z',
        courses: [BOOK_COURSE],
        text: 'Bulkheads isolate resource pools so one slow dependency does not exhaust all threads.',
        document: {
          materialId: 'doc-l1',
          page: 2,
          totalPages: 2,
          format: 'pdf',
          origin: 'converted',
          converter: 'marker',
          filename: 'lecture-1.pdf',
          chapter: { index: 1, title: 'Bulkhead Isolation', level: 1 },
          extractionVersion: 2,
        },
      },
    );
    state.focus = { mode: 'class', course: BOOK_COURSE, role: '', jd: '', targetTopics: [] };
    const lecture = groupSourcesByDocument(state.sources).find((item) => item.sourceIds.includes('doc1-p1')).key;
    const leaves = [
      { id: 'breaker', title: 'Circuit Breaker', anchors: [`${lecture}#0`] },
      { id: 'bulkhead', title: 'Bulkhead Isolation', anchors: [`${lecture}#1`] },
    ];
    const outline = {
      ...courseOutlineMaterial({
        title: 'Outline · HistoryCourse',
        course: BOOK_COURSE,
        orderBasis: { codes: ['numbering'] },
        fingerprint: materialsFingerprint(buildOutlineIndex(state, { course: BOOK_COURSE }).allDocuments),
        nodes: [{ id: 'ch1', title: 'Resilience Patterns', children: leaves }],
        other: { anchors: [] },
        counts: { units: 2, leftover: 0, invalid: 0, repeated: 0 },
      }),
      createdAt: '2026-10-09T00:00:00.000Z',
    };
    state.sources.push(outline);
    state.sources.push({
      ...courseNotesMaterial({
        title: 'Review Book · HistoryCourse',
        course: BOOK_COURSE,
        outlineId: outline.id,
        language: 'zh',
        papers: [],
        counts: {},
        leaves: leaves.map((leaf, idx) => ({
          ...leaf,
          body: {
            fingerprint: 'b'.repeat(16),
            points: [`${leaf.title} core mechanism [^1].`],
            explain: `Detailed explanation for ${leaf.title}.`,
            cites: [{ n: 1, sourceId: idx === 0 ? 'doc1-p1' : 'doc1-p2', quote: 'failure', start: 0, end: 7 }],
          },
        })),
      }),
      createdAt: '2026-10-09T01:00:00.000Z',
    });
    openCourseBook(state, { course: BOOK_COURSE });
  });
  await service.dispose();
}

async function seedTwoEdits(host, firstText, secondText) {
  const openRes = await host.call('course.book.open', { course: BOOK_COURSE, language: 'zh' });
  assert.equal(openRes.ok, true, openRes.error?.message);
  const firstLeaf = openRes.value.nodes[0].children[0];
  const file = firstLeaf.files.gen;
  const v1 = openRes.value.files[file].version;
  const initialText = firstLeaf.gen;

  const save1 = await host.call('course.book.save', {
    course: BOOK_COURSE,
    file,
    text: firstText,
    version: v1,
  });
  assert.equal(save1.ok, true, save1.error?.message);
  const v2 = save1.value.files[file].version;

  const save2 = await host.call('course.book.save', {
    course: BOOK_COURSE,
    file,
    text: secondText,
    version: v2,
  });
  assert.equal(save2.ok, true, save2.error?.message);
  const v3 = save2.value.files[file].version;

  return { file, v1, v2, v3, initialText };
}

describe('Round 61 Track 3: BookHistoryModal (course.book.revision & course.book.revert)', () => {
  after(async () => {
    if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = PREV_DSH_HOME;
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
  });

  test('1) createTuiHost integration (0 model calls): save twice -> revision history -> revert restores prior text', async () => {
    const base = await makeTempDir('host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');
    await seedBookLibrary(libraryRoot);

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

    try {
      const firstEdit = '第一版手写讲义 R61_REV_ALPHA';
      const secondEdit = '第二版手写讲义 R61_REV_BETA';
      const { file, v1, v2, initialText } = await seedTwoEdits(host, firstEdit, secondEdit);

      const revRes = await host.call('course.book.revision', {
        course: BOOK_COURSE,
        history: true,
        file,
      });
      assert.equal(revRes.ok, true, revRes.error?.message);
      assert.equal(revRes.value.course, BOOK_COURSE);
      assert.equal(typeof revRes.value.revision, 'number');
      assert.ok((revRes.value.files?.[file] ?? 0) >= 2, 'revision.files must count saved versions');
      assert.equal(revRes.value.versions.length, 2, 'versions must contain 2 replaced snapshots');

      // Newest first: v2 (firstEdit), then v1 (initialText)
      const [latestHist, oldestHist] = revRes.value.versions;
      assert.equal(latestHist.version, v2);
      assert.equal(latestHist.text, firstEdit);
      assert.equal(latestHist.by, 'learner');
      assert.equal(latestHist.redo, false);
      assert.equal(typeof latestHist.at, 'string');
      assert.equal(oldestHist.version, v1);
      assert.equal(oldestHist.text, initialText);

      // Revert to v2 (firstEdit)
      const revertRes = await host.call('course.book.revert', {
        course: BOOK_COURSE,
        file,
        at: latestHist.at,
        entryVersion: latestHist.version,
        redo: Boolean(latestHist.redo),
      });
      assert.equal(revertRes.ok, true, revertRes.error?.message);
      assert.equal(revertRes.value.status, 'ok');
      const restoredLeaf = revertRes.value.nodes[0].children[0];
      assert.equal(restoredLeaf.gen, firstEdit);
      assert.equal(modelCalls, 0);
    } finally {
      await host.dispose();
    }
  });

  test('2) PTY E2E (120x36 zh): BookView (7) -> H -> BookHistoryModal -> j/k select -> Enter -> ConfirmDialog y -> reverted text & toast (0 model calls)', async () => {
    const base = await makeTempDir('pty-zh');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');
    await seedBookLibrary(libraryRoot);
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

    const firstEdit = '第一版历史正文 R61_ALPHA';
    const secondEdit = '最新当前正文 R61_BETA';
    const { file, v1, v2 } = await seedTwoEdits(host, firstEdit, secondEdit);

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
      await tty.waitFor((s) => s.includes(BOOK_COURSE) || s.includes('学习库'), { label: 'App load (zh)' });

      tty.send('7');
      await tty.waitFor(
        (s) =>
          useDistTuiStore.getState().page === 'book' &&
          s.includes('Resilience Patterns') &&
          s.includes('Circuit Breaker') &&
          !s.includes('正在打开复习全书'),
        { label: 'BookView loaded (zh)' },
      );

      // Select leaf 1.1 Circuit Breaker
      tty.send('j');
      const leafScreen = await tty.waitFor((s) => s.includes(secondEdit), { label: 'Leaf content visible (zh)' });
      tty.assertHealthyScreen(leafScreen, 120, 36, 'BookView leaf (zh)');

      // Press H to open BookHistoryModal
      tty.send('H');
      const modalScreen = await tty.waitFor(
        (s) =>
          s.includes('版本历史与回退') &&
          s.includes(file) &&
          s.includes(`v${v2}`) &&
          s.includes(firstEdit),
        { label: 'BookHistoryModal opened (zh)' },
      );
      tty.assertHealthyScreen(modalScreen, 120, 36, 'BookHistoryModal (zh)');

      // Exercise j/k selection: j -> v1 (initial text), k -> back to v2 (firstEdit)
      tty.send('j');
      await tty.waitFor(
        (s) => s.includes(`v${v1}`) && s.includes('Detailed explanation for Circuit Breaker'),
        { label: 'Selected older entry with j (zh)' },
      );
      tty.send('k');
      await tty.waitFor((s) => s.includes(firstEdit), { label: 'Returned to v2 with k (zh)' });

      // Press Enter -> ConfirmDialog
      tty.send('\r');
      const confirmScreen = await tty.waitFor(
        (s) => s.includes('确认恢复到此历史版本？') && s.includes(`v${v2}`),
        { label: 'ConfirmDialog opened (zh)' },
      );
      tty.assertHealthyScreen(confirmScreen, 120, 36, 'ConfirmDialog (zh)');

      // Confirm with y -> modal closes, BookView shows reverted text & success toast
      tty.send('y');
      const revertedScreen = await tty.waitFor(
        (s) =>
          !s.includes('版本历史与回退') &&
          s.includes('已恢复') &&
          s.includes(firstEdit),
        { label: 'Reverted text & toast visible (zh)' },
      );
      tty.assertHealthyScreen(revertedScreen, 120, 36, 'BookView after revert (zh)');
      assert.equal(modelCalls, 0);
    } finally {
      if (inkInstance) inkInstance.unmount();
      tty.dispose();
      await host.dispose();
    }
  });

  test('3) PTY E2E (80x24 --ascii en): BookHistoryModal opens via H, passes assertHealthyScreen + assertAsciiPure, closes cleanly on Esc', async () => {
    const base = await makeTempDir('pty-en');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');
    await seedBookLibrary(libraryRoot);
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

    // Include Unicode chrome in stored version text to verify normalizeAsciiChrome keeps --ascii pure
    const firstEdit = 'ASCII test v2 -> check ✓ …';
    const secondEdit = 'Current ASCII test v3';
    const { file } = await seedTwoEdits(host, firstEdit, secondEdit);

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
      await tty.waitFor((s) => s.includes(BOOK_COURSE) || s.includes('Library'), { label: 'App load (en)' });

      tty.send('7');
      await tty.waitFor(
        (s) =>
          useDistTuiStore.getState().page === 'book' &&
          s.includes('Resilience Patterns') &&
          s.includes('Circuit Breaker') &&
          !s.includes('Opening review book'),
        { label: 'BookView loaded (en)' },
      );

      tty.send('j');
      await tty.waitFor((s) => s.includes('AI Explain'), { label: 'Leaf selected (en)' });

      tty.send('H');
      const modalEn = await tty.waitFor(
        (s) =>
          s.includes('Revision History & Revert') &&
          s.includes(file) &&
          s.includes('ASCII test v2 -> check OK ...'),
        { label: 'BookHistoryModal opened (en)' },
      );
      tty.assertHealthyScreen(modalEn, 80, 24, 'BookHistoryModal 80x24 --ascii (en)');
      tty.assertAsciiPure(modalEn, 'BookHistoryModal 80x24 --ascii (en)');

      // Esc closes cleanly
      tty.send('\x1b');
      const closedEn = await tty.waitFor(
        (s) => !s.includes('Revision History & Revert') && s.includes('Resilience Patterns'),
        { label: 'BookHistoryModal closed on Esc (en)' },
      );
      tty.assertHealthyScreen(closedEn, 80, 24, 'BookView after Esc 80x24 --ascii (en)');
      tty.assertAsciiPure(closedEn, 'BookView after Esc 80x24 --ascii (en)');
      assert.equal(modelCalls, 0);
    } finally {
      if (inkInstance) inkInstance.unmount();
      tty.dispose();
      await host.dispose();
    }
  });
});
