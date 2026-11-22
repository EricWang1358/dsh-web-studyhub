// Round 57 Task 1: BookView AI Section Explain / Add Paragraph (`generation.courseBook.explain`, P2 ConfirmDialog quota guard)
// Integration & @xterm/headless PTY E2E verification:
// `node --test tests/round57-book-explain.test.mjs`
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

let H = null;
let displayWidth = null;
let useDistTuiStore = null;
let DEFAULT_PREFERENCES = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('chunk-')) {
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
if (!useDistTuiStore || !DEFAULT_PREFERENCES) {
  for (const f of distFiles) {
    if (f.startsWith('store-')) {
      const mod = await import(pathToFileURL(join(distDir, f)).href);
      if (!useDistTuiStore && typeof mod.useTuiStore?.getState === 'function') useDistTuiStore = mod.useTuiStore;
      if (!DEFAULT_PREFERENCES && mod.DEFAULT_PREFERENCES) DEFAULT_PREFERENCES = mod.DEFAULT_PREFERENCES;
    }
  }
}
assert.ok(H?.createTuiHost, 'dist/ must export createTuiHost');
assert.ok(H?.saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(displayWidth, 'dist/ must export displayWidth');
assert.ok(useDistTuiStore, 'dist/ must export useTuiStore');
assert.ok(DEFAULT_PREFERENCES, 'dist/ must export DEFAULT_PREFERENCES');

const { createTuiHost, saveTuiPreferences } = H;

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

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round57-book-explain-${label}-`));
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

const BOOK_COURSE = 'ExplainCourse';

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
        title: 'Outline · ExplainCourse',
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
        title: 'Review Book · ExplainCourse',
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

describe('Round 57: BookView AI Section Explain / Add Paragraph (generation.courseBook.explain + BookExplainModal)', () => {
  after(async () => {
    if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = PREV_DSH_HOME;
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
  });

  test('1) createTuiHost integration (0 model calls): validates missing book/point/request cleanly with normalized error codes', async () => {
    assert.ok(
      distFiles.some((f) => f.startsWith('BookExplainModal-') && f.endsWith('.mjs')),
      'BookExplainModal must be lazy-split into dist/BookExplainModal-*.mjs',
    );

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
      const noBookRes = await host.call('generation.courseBook.explain', {
        course: 'MissingCourse',
        heading: 'h1',
        mode: 'here',
        instruction: '补充直觉例子',
        language: 'zh',
      });
      assert.equal(noBookRes.ok, false);
      assert.equal(noBookRes.error?.code, 'course-book-ai-no-book');
      assert.ok(noBookRes.error?.message, 'missing book must return normalized error message');
      assert.equal(modelCalls, 0);

      const noPointRes = await host.call('generation.courseBook.explain', {
        course: BOOK_COURSE,
        heading: 'nonexistent-hid',
        mode: 'here',
        instruction: 'Add intuition example',
        language: 'en',
      });
      assert.equal(noPointRes.ok, false);
      assert.equal(noPointRes.error?.code, 'course-book-ai-no-point');
      assert.ok(noPointRes.error?.message, 'missing point must return normalized error message');
      assert.equal(modelCalls, 0);

      const openRes = await host.call('course.book.open', { course: BOOK_COURSE, language: 'zh' });
      assert.equal(openRes.ok, true, openRes.error?.message);
      const leafHid = openRes.value.nodes[0].children[0].hid;

      const noRequestRes = await host.call('generation.courseBook.explain', {
        course: BOOK_COURSE,
        heading: leafHid,
        mode: 'here',
        instruction: '   ',
        language: 'zh',
      });
      assert.equal(noRequestRes.ok, false);
      assert.equal(noRequestRes.error?.code, 'course-book-ai-no-request');
      assert.equal(modelCalls, 0);
    } finally {
      await host.dispose();
    }
  });

  test('2) PTY E2E (120x36 zh & 80x24 --ascii en): E guard -> BookExplainModal -> ConfirmDialog (n cancels, 0 calls) -> mode switch (2/explain) -> Esc close', async () => {
    // Part A: 120x36 zh
    const baseZh = await makeTempDir('pty-zh');
    const envZh = { DSH_HOME: join(baseZh, 'dsh-home') };
    process.env.DSH_HOME = envZh.DSH_HOME;
    const libZh = join(baseZh, 'library');
    await seedBookLibrary(libZh);
    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env: envZh });
    resetDistStore('zh', false);

    let zhModelCalls = 0;
    const hostZh = await createTuiHost({
      libraryRoot: libZh,
      env: envZh,
      home: baseZh,
      documentsDir: baseZh,
      skipAutoProbe: true,
      language: 'zh',
      injectedComplete: async () => {
        zhModelCalls += 1;
        return '{}';
      },
    });

    const ttyZh = createVirtualTty(120, 36);
    let inkInstance = null;
    try {
      inkInstance = render(React.createElement(StudyHubTuiApp, { host: hostZh, asciiMode: false }), {
        stdin: ttyZh.stdin,
        stdout: ttyZh.stdout,
        stderr: ttyZh.stderr,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await ttyZh.firstFramePromise;
      await ttyZh.waitFor((s) => s.includes(BOOK_COURSE) || s.includes('学习库'), { label: 'App load (zh)' });

      ttyZh.send('7');
      const bookScreen = await ttyZh.waitFor(
        (s) =>
          useDistTuiStore.getState().page === 'book' &&
          s.includes('Resilience Patterns') &&
          s.includes('Circuit Breaker') &&
          !s.includes('正在打开复习全书'),
        { label: 'BookView loaded (zh)' },
      );
      ttyZh.assertHealthyScreen(bookScreen, 120, 36, 'BookView initial (zh)');

      // Pressing 'E' on chapter header notifies info & does not open modal
      ttyZh.send('E');
      const nonLeafToast = await ttyZh.waitFor(
        (s) => s.includes('请先在目录中选择一个具体知识点（叶子节点）'),
        { label: 'Non-leaf info toast on E (zh)' },
      );
      ttyZh.assertHealthyScreen(nonLeafToast, 120, 36, 'Non-leaf toast (zh)');
      assert.equal(zhModelCalls, 0);

      // Select leaf node -> footer shows AI讲解 -> press 'E'
      ttyZh.send('j');
      await ttyZh.waitFor((s) => s.includes('AI讲解'), { label: 'Leaf selected with AI讲解 hint (zh)' });

      ttyZh.send('E');
      const modalZh = await ttyZh.waitFor(
        (s) =>
          s.includes('AI 补充复习全书讲解') &&
          s.includes('1.1 Circuit Breaker') &&
          s.includes('1: 补充段落 (here)') &&
          s.includes('2: 深入讲解 (explain)') &&
          s.includes('0/600'),
        { label: 'BookExplainModal opened (zh)' },
      );
      ttyZh.assertHealthyScreen(modalZh, 120, 36, 'BookExplainModal 120x36 (zh)');
      assert.equal(zhModelCalls, 0);

      // Enter instruction & submit -> P2 ConfirmDialog opens (0 model calls)
      ttyZh.send('Add intuitive example');
      await ttyZh.waitFor((s) => s.includes('21/600'), { label: 'Instruction typed (zh)' });
      ttyZh.send('\r');
      const confirmZh = await ttyZh.waitFor(
        (s) =>
          s.includes('开始生成') &&
          s.includes('Add intuitive example') &&
          s.includes('1: 补充段落 (here)'),
        { label: 'ConfirmDialog opened (zh)' },
      );
      ttyZh.assertHealthyScreen(confirmZh, 120, 36, 'ConfirmDialog 120x36 (zh)');
      assert.equal(zhModelCalls, 0);

      // Press 'n' -> cancels back to form (0 model calls)
      ttyZh.send('n');
      await ttyZh.waitFor(
        (s) => !s.includes('开始生成') && s.includes('21/600'),
        { label: 'ConfirmDialog canceled with n (zh)' },
      );
      assert.equal(zhModelCalls, 0);

      // Switch mode to 'explain' via UpArrow + '2' -> pre-filled with leaf title
      ttyZh.send('\x1b[A');
      await ttyZh.flush();
      ttyZh.send('2');
      const explainModeZh = await ttyZh.waitFor(
        (s) => s.includes('深入讲解词句 (words)') && s.includes('Circuit Breaker') && s.includes('15/600'),
        { label: 'Mode switched to 2/explain (zh)' },
      );
      ttyZh.assertHealthyScreen(explainModeZh, 120, 36, 'Mode explain 120x36 (zh)');
      assert.equal(zhModelCalls, 0);

      // Esc closes modal cleanly
      ttyZh.send('\x1b');
      const closedZh = await ttyZh.waitFor(
        (s) => !s.includes('AI 补充复习全书讲解') && s.includes('Resilience Patterns'),
        { label: 'BookExplainModal closed on Esc (zh)' },
      );
      ttyZh.assertHealthyScreen(closedZh, 120, 36, 'BookView after Esc (zh)');
      assert.equal(zhModelCalls, 0);

      inkInstance.unmount();
      inkInstance = null;
      ttyZh.dispose();
      await hostZh.dispose();

      // Part B: 80x24 --ascii en
      const baseEn = await makeTempDir('pty-en');
      const envEn = { DSH_HOME: join(baseEn, 'dsh-home') };
      process.env.DSH_HOME = envEn.DSH_HOME;
      const libEn = join(baseEn, 'library');
      await seedBookLibrary(libEn);
      await saveTuiPreferences({ language: 'en', asciiMode: true }, { env: envEn });
      resetDistStore('en', true);

      let enModelCalls = 0;
      const hostEn = await createTuiHost({
        libraryRoot: libEn,
        env: envEn,
        home: baseEn,
        documentsDir: baseEn,
        skipAutoProbe: true,
        language: 'en',
        injectedComplete: async () => {
          enModelCalls += 1;
          return '{}';
        },
      });
      const ttyEn = createVirtualTty(80, 24);
      try {
        inkInstance = render(React.createElement(StudyHubTuiApp, { host: hostEn, asciiMode: true }), {
          stdin: ttyEn.stdin,
          stdout: ttyEn.stdout,
          stderr: ttyEn.stderr,
          exitOnCtrlC: false,
          patchConsole: false,
        });
        await ttyEn.firstFramePromise;
        await ttyEn.waitFor((s) => s.includes(BOOK_COURSE) || s.includes('Library'), { label: 'App load (en ascii)' });

        ttyEn.send('7');
        const bookEn = await ttyEn.waitFor(
          (s) =>
            useDistTuiStore.getState().page === 'book' &&
            s.includes('Resilience Patterns') &&
            s.includes('Circuit Breaker') &&
            !s.includes('Opening review book'),
          { label: 'BookView loaded (en ascii)' },
        );
        ttyEn.assertHealthyScreen(bookEn, 80, 24, 'BookView 80x24 (en ascii)');
        ttyEn.assertAsciiPure(bookEn, 'BookView 80x24 (en ascii)');

        // Non-leaf 'E' toast (toastW=32 at 80 cols truncates toast to ~26 chars)
        ttyEn.send('E');
        const toastEn = await ttyEn.waitFor(
          (s) => s.includes('Select a specific knowl'),
          { label: 'Non-leaf info toast on E (en ascii)' },
        );
        ttyEn.assertHealthyScreen(toastEn, 80, 24, 'Non-leaf toast 80x24 (en ascii)');
        ttyEn.assertAsciiPure(toastEn, 'Non-leaf toast 80x24 (en ascii)');
        assert.equal(enModelCalls, 0);

        // Select leaf & press 'E'
        ttyEn.send('j');
        await ttyEn.waitFor((s) => s.includes('AI Explain') || s.includes('Linked questions:'), { label: 'Leaf selected (en ascii)' });
        ttyEn.send('E');
        const modalEn = await ttyEn.waitFor(
          (s) =>
            s.includes('AI Explain Review Book Point') &&
            s.includes('1: Add paragraph (here)') &&
            s.includes('2: Explain phrase (explain)'),
          { label: 'BookExplainModal opened 80x24 (en ascii)' },
        );
        ttyEn.assertHealthyScreen(modalEn, 80, 24, 'BookExplainModal 80x24 (en ascii)');
        ttyEn.assertAsciiPure(modalEn, 'BookExplainModal 80x24 (en ascii)');
        assert.equal(enModelCalls, 0);

        // Enter instruction & submit -> P2 ConfirmDialog -> n cancels
        ttyEn.send('Add step');
        await ttyEn.waitFor((s) => s.includes('8/600'), { label: 'Instruction typed (en ascii)' });
        ttyEn.send('\r');
        const confirmEn = await ttyEn.waitFor(
          (s) => s.includes('Start AI') && s.includes('Add step'),
          { label: 'ConfirmDialog opened 80x24 (en ascii)' },
        );
        ttyEn.assertHealthyScreen(confirmEn, 80, 24, 'ConfirmDialog 80x24 (en ascii)');
        ttyEn.assertAsciiPure(confirmEn, 'ConfirmDialog 80x24 (en ascii)');
        assert.equal(enModelCalls, 0);

        ttyEn.send('n');
        await ttyEn.waitFor(
          (s) => !s.includes('Start AI') && s.includes('8/600'),
          { label: 'ConfirmDialog canceled with n (en ascii)' },
        );
        assert.equal(enModelCalls, 0);

        // Switch mode via Tab -> explain mode -> Esc closes cleanly
        ttyEn.send('\t');
        const explainEn = await ttyEn.waitFor(
          (s) => s.includes('Phrase / concept (words):') && s.includes('15/600'),
          { label: 'Mode switched via Tab (en ascii)' },
        );
        ttyEn.assertHealthyScreen(explainEn, 80, 24, 'Mode explain 80x24 (en ascii)');
        ttyEn.assertAsciiPure(explainEn, 'Mode explain 80x24 (en ascii)');

        ttyEn.send('\x1b');
        const closedEn = await ttyEn.waitFor(
          (s) => !s.includes('AI Explain Review Book Point') && s.includes('Resilience Patterns'),
          { label: 'BookExplainModal closed on Esc (en ascii)' },
        );
        ttyEn.assertHealthyScreen(closedEn, 80, 24, 'BookView after Esc (en ascii)');
        ttyEn.assertAsciiPure(closedEn, 'BookView after Esc (en ascii)');
        assert.equal(enModelCalls, 0);
      } finally {
        inkInstance?.unmount();
        inkInstance = null;
        ttyEn.dispose();
        await hostEn.dispose();
      }
    } finally {
      inkInstance?.unmount();
      ttyZh.dispose();
      await hostZh.dispose();
    }
  });
});
