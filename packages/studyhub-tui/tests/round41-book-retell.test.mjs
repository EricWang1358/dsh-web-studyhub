// Round 41 BookView Feynman Retell (book.retell + BookRetellModal + P2 ConfirmDialog quota guard) Integration & PTY E2E:
// node --test tests/round41-book-retell.test.mjs
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
let useTuiStore = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('chunk-') || f.startsWith('store-')) {
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
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round41-${label}-`));
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

const BOOK_COURSE = 'RetellCourse';

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
        title: 'Outline · RetellCourse',
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
        title: 'Review Book · RetellCourse',
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

describe('Round 41: BookView Feynman Retell (book.retell + BookRetellModal + P2 ConfirmDialog)', () => {
  after(async () => {
    if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = PREV_DSH_HOME;
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
  });

  test('1) createTuiHost integration: book.retell with injectedComplete -> retold aggregate persists in course.book.open & raw text never stored', async () => {
    const base = await makeTempDir('host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');
    await seedBookLibrary(libraryRoot);

    const SECRET_RAW_TEXT = 'SECRET_FEYNMAN_WORDING_NEVER_PERSIST_99182';
    let modelCalls = 0;
    let capturedPrompt = '';

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
      injectedComplete: async (_system, prompt) => {
        modelCalls += 1;
        capturedPrompt = String(prompt ?? '');
        return JSON.stringify({
          passed: true,
          right: ['Accurately explained why the circuit breaker trips open to stop cascading failures.'],
          missed: [],
          wrong: [],
          cite: null,
        });
      },
    });

    try {
      const beforeOpen = await host.call('course.book.open', { course: BOOK_COURSE, language: 'zh' });
      assert.equal(beforeOpen.ok, true, beforeOpen.error?.message);
      const leaf = beforeOpen.value.nodes[0].children[0];
      assert.equal(leaf.retold, undefined);

      const retellRes = await host.call('book.retell', {
        course: BOOK_COURSE,
        hid: leaf.hid,
        text: SECRET_RAW_TEXT,
        language: 'zh',
      });
      assert.equal(retellRes.ok, true, retellRes.error?.message);
      assert.equal(modelCalls, 1);
      assert.ok(capturedPrompt.includes('Circuit Breaker'), 'point material should be sent to model');
      assert.equal(retellRes.value.passed, true);
      assert.equal(retellRes.value.gap, 'none');
      assert.equal(retellRes.value.record?.tries, 1);
      assert.equal(retellRes.value.record?.passes, 1);
      assert.equal(retellRes.value.record?.gap, 'none');

      const afterOpen = await host.call('course.book.open', { course: BOOK_COURSE, language: 'zh' });
      assert.equal(afterOpen.ok, true, afterOpen.error?.message);
      const updatedLeaf = afterOpen.value.nodes[0].children[0];
      assert.equal(updatedLeaf.retold?.tries, 1);
      assert.equal(updatedLeaf.retold?.passes, 1);
      assert.equal(updatedLeaf.retold?.gap, 'none');
      assert.equal(JSON.stringify(afterOpen.value).includes(SECRET_RAW_TEXT), false, 'raw retell text must never appear in book');

      const exported = await host.call('export');
      assert.equal(exported.ok, true, exported.error?.message);
      assert.equal(JSON.stringify(exported.value).includes(SECRET_RAW_TEXT), false, 'raw retell text must never persist in library export');
    } finally {
      await host.dispose();
    }
  });

  test('2) PTY E2E (zh + --ascii en): T on chapter toast -> T on leaf -> ConfirmDialog quota guard (0 calls on cancel) -> confirm -> 3-part verdict + badge update', async () => {
    // Part A: Default zh mode
    const baseZh = await makeTempDir('pty-zh');
    const envZh = { DSH_HOME: join(baseZh, 'dsh-home') };
    process.env.DSH_HOME = envZh.DSH_HOME;
    const libZh = join(baseZh, 'library');
    await seedBookLibrary(libZh);
    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env: envZh });

    let zhModelCalls = 0;
    const ZH_SECRET = 'ZH_SECRET_EXPLANATION_42';
    const hostZh = await createTuiHost({
      libraryRoot: libZh,
      env: envZh,
      home: baseZh,
      documentsDir: baseZh,
      skipAutoProbe: true,
      language: 'zh',
      injectedComplete: async () => {
        zhModelCalls += 1;
        return JSON.stringify({
          passed: true,
          right: ['讲清了熔断器在故障率过高时自动断开保护下游的核心机制'],
          missed: [],
          wrong: [],
          cite: null,
        });
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
      await ttyZh.waitFor((s) => s.includes('RetellCourse') || s.includes('学习库'), { label: 'App load (zh)' });

      // Navigate to BookView ('7')
      ttyZh.send('7');
      const bookScreen = await ttyZh.waitFor(
        (s) =>
          useTuiStore.getState().page === 'book' &&
          s.includes('Resilience Patterns') &&
          s.includes('Circuit Breaker') &&
          !s.includes('正在打开复习全书'),
        { label: 'BookView rendered (zh)' },
      );
      ttyZh.assertHealthyScreen(bookScreen, 120, 36, 'BookView initial (zh)');

      // Press 'T' while chapter header (index 0) is selected -> friendly toast, modal stays closed
      ttyZh.send('T');
      const nonLeafToast = await ttyZh.waitFor(
        (s) => s.includes('章节标题不支持费曼复述'),
        { label: 'Non-leaf toast on T (zh)' },
      );
      ttyZh.assertHealthyScreen(nonLeafToast, 120, 36, 'Non-leaf toast (zh)');
      assert.equal(zhModelCalls, 0);

      // Move down to leaf '1.1 Circuit Breaker' and press 'T'
      ttyZh.send('j');
      await ttyZh.waitFor((s) => s.includes('Linked questions:') || s.includes('关联题目:'), { label: 'Leaf selected (zh)' });

      ttyZh.send('T');
      const retellModal = await ttyZh.waitFor(
        (s) =>
          s.includes('用自己的话讲一遍') &&
          s.includes('1.1 Circuit Breaker') &&
          s.includes('0/4000'),
        { label: 'BookRetellModal opened (zh)' },
      );
      ttyZh.assertHealthyScreen(retellModal, 120, 36, 'BookRetellModal 120x36 (zh)');

      // Check 80x24 responsiveness
      ttyZh.resize(80, 24);
      const modalNarrow = await ttyZh.waitFor(
        (s) => s.includes('用自己的话讲一遍') && s.split('\n').length <= 24,
        { label: 'BookRetellModal 80x24 (zh)' },
      );
      ttyZh.assertHealthyScreen(modalNarrow, 80, 24, 'BookRetellModal 80x24 (zh)');
      ttyZh.resize(120, 36);
      await ttyZh.waitFor((s) => s.includes('1.1 Circuit Breaker'), { label: 'BookRetellModal restored 120x36 (zh)' });

      // Type explanation and submit -> ConfirmDialog quota guard opens
      ttyZh.send(ZH_SECRET);
      await ttyZh.waitFor((s) => s.includes(`${ZH_SECRET.length}/4000`), { label: 'Draft typed (zh)' });

      ttyZh.send('\r');
      const confirmScreen = await ttyZh.waitFor(
        (s) =>
          s.includes('确认提交费曼复述评估') &&
          s.includes('1 次 AI 模型调用') &&
          s.includes('不会保存你的原话'),
        { label: 'ConfirmDialog quota guard opened (zh)' },
      );
      ttyZh.assertHealthyScreen(confirmScreen, 120, 36, 'ConfirmDialog quota guard (zh)');
      assert.equal(zhModelCalls, 0, 'ConfirmDialog must not call model before confirmation');

      // Cancel ConfirmDialog with 'n' -> 0 model calls, draft preserved
      ttyZh.send('n');
      await ttyZh.waitFor(
        (s) => !s.includes('确认提交费曼复述评估') && s.includes(`${ZH_SECRET.length}/4000`),
        { label: 'ConfirmDialog canceled with n (zh)' },
      );
      assert.equal(zhModelCalls, 0, 'Canceling ConfirmDialog must result in 0 AI model calls');

      // Submit via Ctrl+S (\x13) and confirm with 'y'
      ttyZh.send('\x13');
      await ttyZh.waitFor((s) => s.includes('确认提交费曼复述评估'), { label: 'ConfirmDialog reopened via Ctrl+S (zh)' });
      ttyZh.send('y');

      const verdictScreen = await ttyZh.waitFor(
        (s) =>
          !s.includes('确认提交费曼复述评估') &&
          s.includes('讲清楚过') &&
          s.includes('1. 讲对了') &&
          s.includes('2. 遗漏与需纠正') &&
          s.includes('3. 下一步提示') &&
          s.includes('讲清了熔断器在故障率过高时自动断开保护下游的核心机制'),
        { label: '3-part Feynman verdict rendered (zh)' },
      );
      ttyZh.assertHealthyScreen(verdictScreen, 120, 36, 'Verdict rendered (zh)');
      assert.equal(zhModelCalls, 1, 'Confirming ConfirmDialog must trigger exactly 1 AI model call');

      // Close modal -> BookView refreshed with 讲清楚过 badge immediately visible
      ttyZh.send('\x1b');
      const afterClose = await ttyZh.waitFor(
        (s) => !s.includes('用自己的话讲一遍') && s.includes('✓ 讲清楚过'),
        { label: 'BookView updated with 讲清楚过 badge (zh)' },
      );
      ttyZh.assertHealthyScreen(afterClose, 120, 36, 'BookView badge updated (zh)');

      // Verify raw text never persisted in library export
      const exportedZh = await hostZh.call('export');
      assert.equal(exportedZh.ok, true);
      assert.equal(JSON.stringify(exportedZh.value).includes(ZH_SECRET), false, 'zh raw draft must never persist');

      inkInstance.unmount();
      inkInstance = null;
      ttyZh.dispose();
      await hostZh.dispose();

      // Part B: --ascii en mode
      const baseEn = await makeTempDir('pty-en');
      const envEn = { DSH_HOME: join(baseEn, 'dsh-home') };
      process.env.DSH_HOME = envEn.DSH_HOME;
      const libEn = join(baseEn, 'library');
      await seedBookLibrary(libEn);
      await saveTuiPreferences({ language: 'en', asciiMode: true }, { env: envEn });

      let enModelCalls = 0;
      const EN_SECRET = 'EN_SECRET_EXPLANATION_88';
      const hostEn = await createTuiHost({
        libraryRoot: libEn,
        env: envEn,
        home: baseEn,
        documentsDir: baseEn,
        skipAutoProbe: true,
        language: 'en',
        injectedComplete: async () => {
          enModelCalls += 1;
          return JSON.stringify({
            passed: true,
            right: ['Clearly explained how circuit breakers stop cascading failures.'],
            missed: [],
            wrong: [],
            cite: null,
          });
        },
      });
      const ttyEn = createVirtualTty(120, 36);
      try {
        inkInstance = render(React.createElement(StudyHubTuiApp, { host: hostEn, asciiMode: true }), {
          stdin: ttyEn.stdin,
          stdout: ttyEn.stdout,
          stderr: ttyEn.stderr,
          exitOnCtrlC: false,
          patchConsole: false,
        });
        await ttyEn.firstFramePromise;
        await ttyEn.waitFor((s) => s.includes('RetellCourse') || s.includes('Library'), { label: 'ASCII app load (en)' });

        ttyEn.send('7');
        const asciiBook = await ttyEn.waitFor(
          (s) =>
            useTuiStore.getState().page === 'book' &&
            s.includes('Resilience Patterns') &&
            s.includes('Circuit Breaker') &&
            !s.includes('Opening review book'),
          { label: 'ASCII BookView loaded (en)' },
        );
        ttyEn.assertHealthyScreen(asciiBook, 120, 36, 'ASCII BookView (en)');
        ttyEn.assertAsciiPure(asciiBook, 'ASCII BookView (en)');

        // Press 'T' on chapter header -> friendly English toast + ASCII pure
        ttyEn.send('T');
        const asciiToast = await ttyEn.waitFor(
          (s) => s.includes('Chapter headers cannot be retold'),
          { label: 'ASCII non-leaf toast (en)' },
        );
        ttyEn.assertHealthyScreen(asciiToast, 120, 36, 'ASCII non-leaf toast (en)');
        ttyEn.assertAsciiPure(asciiToast, 'ASCII non-leaf toast (en)');

        // Select leaf and open BookRetellModal with 'T'
        ttyEn.send('j');
        await ttyEn.waitFor((s) => s.includes('Linked questions:'), { label: 'ASCII leaf selected (en)' });
        ttyEn.send('T');
        const asciiModal = await ttyEn.waitFor(
          (s) =>
            s.includes('Feynman Retell') &&
            s.includes('1.1 Circuit Breaker') &&
            s.includes('0/4000'),
          { label: 'ASCII BookRetellModal opened (en)' },
        );
        ttyEn.assertHealthyScreen(asciiModal, 120, 36, 'ASCII BookRetellModal (en)');
        ttyEn.assertAsciiPure(asciiModal, 'ASCII BookRetellModal (en)');

        // Type explanation -> submit -> ConfirmDialog -> Esc cancel -> 0 calls
        ttyEn.send(EN_SECRET);
        await ttyEn.waitFor((s) => s.includes(`${EN_SECRET.length}/4000`), { label: 'ASCII draft typed (en)' });
        ttyEn.send('\r');
        const asciiConfirm = await ttyEn.waitFor(
          (s) =>
            s.includes('Confirm Feynman Retell Check') &&
            s.includes('1 AI model call') &&
            s.includes('never persisted'),
          { label: 'ASCII ConfirmDialog opened (en)' },
        );
        ttyEn.assertHealthyScreen(asciiConfirm, 120, 36, 'ASCII ConfirmDialog (en)');
        ttyEn.assertAsciiPure(asciiConfirm, 'ASCII ConfirmDialog (en)');
        assert.equal(enModelCalls, 0);

        ttyEn.send('\x1b');
        await ttyEn.waitFor(
          (s) => !s.includes('Confirm Feynman Retell Check') && s.includes(`${EN_SECRET.length}/4000`),
          { label: 'ASCII ConfirmDialog canceled on Esc (en)' },
        );
        assert.equal(enModelCalls, 0, 'Esc cancel on ConfirmDialog must make 0 AI model calls');

        // Re-submit & confirm -> 1 model call -> 3-part verdict + ASCII pure
        ttyEn.send('\r');
        await ttyEn.waitFor((s) => s.includes('Confirm Feynman Retell Check'), { label: 'ASCII ConfirmDialog reopened (en)' });
        ttyEn.send('y');

        const asciiVerdict = await ttyEn.waitFor(
          (s) =>
            !s.includes('Confirm Feynman Retell Check') &&
            s.includes('+ Retold (Pass)') &&
            s.includes('1. What You Got Right') &&
            s.includes('2. Missing & Needs Correction') &&
            s.includes('3. Tip & Next Step') &&
            s.includes('Clearly explained how circuit breakers stop cascading failures.'),
          { label: 'ASCII 3-part verdict rendered (en)' },
        );
        ttyEn.assertHealthyScreen(asciiVerdict, 120, 36, 'ASCII verdict (en)');
        ttyEn.assertAsciiPure(asciiVerdict, 'ASCII verdict (en)');
        assert.equal(enModelCalls, 1);

        // Close modal -> + Retold badge visible & ASCII pure
        ttyEn.send('\x1b');
        const asciiAfterClose = await ttyEn.waitFor(
          (s) => !s.includes('Feynman Retell') && s.includes('+ Retold'),
          { label: 'ASCII BookView updated with + Retold badge (en)' },
        );
        ttyEn.assertHealthyScreen(asciiAfterClose, 120, 36, 'ASCII BookView badge (en)');
        ttyEn.assertAsciiPure(asciiAfterClose, 'ASCII BookView badge (en)');

        const exportedEn = await hostEn.call('export');
        assert.equal(exportedEn.ok, true);
        assert.equal(JSON.stringify(exportedEn.value).includes(EN_SECRET), false, 'en raw draft must never persist');
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
