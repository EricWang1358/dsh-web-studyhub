// Round 42 BookView Chapter/Point Mock Paper ([M] -> book.mock.plan + book.mock -> ExamView) & Section Q&A (BookQaModal -> course.outline.qa):
// node --test tests/round42-book-mock.test.mjs
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
import { followupDigest } from '../../../lib/followup.js';

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
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round42-${label}-`));
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

const BOOK_COURSE = 'MockCourse';
const P1_TEXT = 'Circuit breakers prevent cascading failures by tripping open when failure thresholds are crossed.';
const P2_TEXT = 'Bulkheads isolate resource pools so one slow dependency does not exhaust all threads.';

async function seedMockBookLibrary(root) {
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
        text: P1_TEXT,
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
        text: P2_TEXT,
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
    const mcqCard = {
      id: 'q-mcq-1',
      kind: 'quiz',
      topic: 'Circuit Breaker',
      prompt: 'When does a circuit breaker trip open?',
      options: [
        { id: 'a', text: 'When failure threshold is crossed', correct: true },
        { id: 'b', text: 'Only on manual restart', correct: false },
      ],
      citations: [{ sourceId: 'doc1-p1', quote: 'tripping open when failure thresholds are crossed' }],
    };
    mcqCard.followups = [
      {
        id: 'fu-cb-1',
        question: 'Why does half-open state probe before closing?',
        answer: 'Half-open limits probe traffic so a recovering downstream service is not flooded.',
        at: '2026-10-02T00:00:00.000Z',
        digest: followupDigest(mcqCard),
      },
    ];
    state.decks.push({
      id: 'deck-mock-1',
      title: 'Resilience Questions',
      course: BOOK_COURSE,
      cards: [
        mcqCard,
        {
          id: 'q-multi-2',
          kind: 'multi',
          topic: 'Circuit Breaker',
          prompt: 'Which benefits do circuit breakers provide?',
          options: [
            { id: 'a', text: 'Stop cascading failures', correct: true },
            { id: 'b', text: 'Fail fast when downstream is down', correct: true },
            { id: 'c', text: 'Double network bandwidth', correct: false },
          ],
          citations: [{ sourceId: 'doc1-p1', quote: 'Circuit breakers prevent cascading failures' }],
        },
        {
          id: 'q-flash-3',
          kind: 'flashcard',
          topic: 'Circuit Breaker',
          prompt: 'Name the three states of a circuit breaker.',
          answer: 'Closed, Open, Half-Open.',
          citations: [{ sourceId: 'doc1-p1', quote: 'Circuit breakers prevent cascading failures' }],
        },
        {
          id: 'q-bulk-flash',
          kind: 'flashcard',
          topic: 'Bulkhead Isolation',
          prompt: 'What does a bulkhead isolate?',
          answer: 'Resource pools such as thread or connection pools.',
          citations: [{ sourceId: 'doc1-p2', quote: 'Bulkheads isolate resource pools' }],
        },
      ],
    });
    state.focus = { mode: 'class', course: BOOK_COURSE, role: '', jd: '', targetTopics: [] };
    const lecture = groupSourcesByDocument(state.sources).find((item) => item.sourceIds.includes('doc1-p1')).key;
    const leaves = [
      { id: 'breaker', title: 'Circuit Breaker', anchors: [`${lecture}#0`] },
      { id: 'bulkhead', title: 'Bulkhead Isolation', anchors: [`${lecture}#1`] },
    ];
    const outline = {
      ...courseOutlineMaterial({
        title: 'Outline · MockCourse',
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
        title: 'Review Book · MockCourse',
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
            cites: [{ n: 1, sourceId: idx === 0 ? 'doc1-p1' : 'doc1-p2', quote: 'isolate', start: 0, end: 7 }],
          },
        })),
      }),
      createdAt: '2026-10-09T01:00:00.000Z',
    });
    openCourseBook(state, { course: BOOK_COURSE });
  });
  await service.dispose();
}

describe('Round 42: BookView Mock Paper Planner ([M] -> book.mock.plan + book.mock -> ExamView) & Section Q&A', () => {
  after(async () => {
    if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = PREV_DSH_HOME;
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
  });

  test('1) createTuiHost integration: course.book.open -> book.mock.plan -> book.mock -> course.outline.qa', async () => {
    const base = await makeTempDir('host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');
    await seedMockBookLibrary(libraryRoot);

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
    });

    try {
      const opened = await host.call('course.book.open', { course: BOOK_COURSE, language: 'zh' });
      assert.equal(opened.ok, true, opened.error?.message);
      const breaker = opened.value.nodes[0].children[0];
      const bulkhead = opened.value.nodes[0].children[1];
      assert.equal(breaker.title, 'Circuit Breaker');
      assert.equal(bulkhead.title, 'Bulkhead Isolation');

      // 0-token plan for Circuit Breaker (2 choice + 1 flashcard skipped)
      const planRes = await host.call('book.mock.plan', {
        course: BOOK_COURSE,
        pointIds: [breaker.hid],
      });
      assert.equal(planRes.ok, true, planRes.error?.message);
      assert.equal(planRes.value.status, 'ok');
      assert.equal(planRes.value.questions, 3);
      assert.equal(planRes.value.eligible, 2);
      assert.equal(planRes.value.count, 2);
      assert.equal(planRes.value.leftOut?.flashcard, 1);

      // 0-token plan for Bulkhead Isolation (0 choice questions)
      const emptyPlan = await host.call('book.mock.plan', {
        course: BOOK_COURSE,
        pointIds: [bulkhead.hid],
      });
      assert.equal(emptyPlan.ok, true, emptyPlan.error?.message);
      assert.equal(emptyPlan.value.eligible, 0);
      assert.equal(emptyPlan.value.count, 0);

      // Start mock exam via book.mock
      const mockRes = await host.call('book.mock', {
        course: BOOK_COURSE,
        pointIds: planRes.value.points,
        count: planRes.value.count,
      });
      assert.equal(mockRes.ok, true, mockRes.error?.message);
      assert.ok(mockRes.value?.id, 'book.mock must return exam run id');
      assert.equal(mockRes.value?.mode, 'exam');
      assert.equal(mockRes.value?.total, 2);

      const snapRes = await host.call('snapshot');
      assert.equal(snapRes.ok, true);
      const openExam = (snapRes.value?.runs ?? []).find((r) => r.id === mockRes.value.id);
      assert.ok(openExam, 'snapshot.runs must include newly started book.mock exam run');
      assert.equal(openExam.mode, 'exam');

      // Inspect section Q&A via course.outline.qa
      const qaRes = await host.call('course.outline.qa', {
        course: BOOK_COURSE,
        keys: [breaker.key],
      });
      assert.equal(qaRes.ok, true, qaRes.error?.message);
      assert.equal(qaRes.value.status, 'ok');
      assert.equal(qaRes.value.items.length, 1);
      assert.equal(qaRes.value.items[0].kind, 'card');
      assert.ok(qaRes.value.items[0].question.includes('half-open'));
    } finally {
      await host.dispose();
    }
  });

  test('2) PTY E2E (zh + --ascii en): BookView [M] plan ConfirmDialog -> n/Esc cancel -> confirm -> ExamView + BookQaModal section Q&A', async () => {
    // Part A: Default zh mode
    const baseZh = await makeTempDir('pty-zh');
    const envZh = { DSH_HOME: join(baseZh, 'dsh-home') };
    process.env.DSH_HOME = envZh.DSH_HOME;
    const libZh = join(baseZh, 'library');
    await seedMockBookLibrary(libZh);
    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env: envZh });

    const hostZh = await createTuiHost({
      libraryRoot: libZh,
      env: envZh,
      home: baseZh,
      documentsDir: baseZh,
      skipAutoProbe: true,
      language: 'zh',
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
      await ttyZh.waitFor((s) => s.includes('MockCourse') || s.includes('学习库'), { label: 'App load (zh)' });

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

      // Move to leaf '1.1 Circuit Breaker' and press 'M'
      ttyZh.send('j');
      await ttyZh.waitFor((s) => s.includes('关联题目:') || s.includes('Linked questions:'), { label: 'Leaf selected (zh)' });

      ttyZh.send('M');
      const confirmZh = await ttyZh.waitFor(
        (s) => {
          const flat = s.replace(/\s+/g, ' ');
          return (
            flat.includes('章节模拟卷确认') &&
            flat.includes('规划 2') &&
            flat.includes('道选择题') &&
            flat.includes('30 分钟') &&
            flat.includes('已跳过 1') &&
            flat.includes('道非选择题')
          );
        },
        { label: 'Mock ConfirmDialog opened (zh)' },
      );
      ttyZh.assertHealthyScreen(confirmZh, 120, 36, 'Mock ConfirmDialog 120x36 (zh)');

      // 80x24 responsiveness check
      ttyZh.resize(80, 24);
      const confirmNarrow = await ttyZh.waitFor(
        (s) => s.includes('章节模拟卷确认') && s.split('\n').length <= 24,
        { label: 'Mock ConfirmDialog 80x24 (zh)' },
      );
      ttyZh.assertHealthyScreen(confirmNarrow, 80, 24, 'Mock ConfirmDialog 80x24 (zh)');
      ttyZh.resize(120, 36);
      await ttyZh.waitFor((s) => s.includes('章节模拟卷确认'), { label: 'Mock ConfirmDialog restored 120x36 (zh)' });

      // Cancel cleanly on 'n' -> stays on BookView
      ttyZh.send('n');
      await ttyZh.waitFor(
        (s) => !s.includes('章节模拟卷确认') && useTuiStore.getState().page === 'book',
        { label: 'Mock ConfirmDialog canceled with n (zh)' },
      );

      // Open BookQaModal ('P') and verify section Q&A from course.outline.qa is visible
      ttyZh.send('P');
      const qaScreenZh = await ttyZh.waitFor(
        (s) => s.includes('本节问答 1') && s.includes('Why does half-open state probe'),
        { label: 'BookQaModal section Q&A rendered (zh)' },
      );
      ttyZh.assertHealthyScreen(qaScreenZh, 120, 36, 'BookQaModal section Q&A (zh)');
      ttyZh.send('\x1b');
      await ttyZh.waitFor((s) => !s.includes('本节问答 1'), { label: 'BookQaModal closed (zh)' });

      // Re-open [M] and confirm with 'y' -> creates exam run, refreshes snapshot, navigates to ExamView
      ttyZh.send('M');
      await ttyZh.waitFor((s) => s.includes('章节模拟卷确认'), { label: 'Mock ConfirmDialog reopened (zh)' });
      ttyZh.send('y');
      const examScreenZh = await ttyZh.waitFor(
        (s) =>
          useTuiStore.getState().page === 'exam' &&
          s.includes('继续未交卷考试'),
        { label: 'Navigated to ExamView with active mock run (zh)' },
      );
      ttyZh.assertHealthyScreen(examScreenZh, 120, 36, 'ExamView after book.mock (zh)');

      inkInstance.unmount();
      inkInstance = null;
      ttyZh.dispose();
      await hostZh.dispose();

      // Part B: --ascii en mode
      const baseEn = await makeTempDir('pty-en');
      const envEn = { DSH_HOME: join(baseEn, 'dsh-home') };
      process.env.DSH_HOME = envEn.DSH_HOME;
      const libEn = join(baseEn, 'library');
      await seedMockBookLibrary(libEn);
      await saveTuiPreferences({ language: 'en', asciiMode: true }, { env: envEn });

      const hostEn = await createTuiHost({
        libraryRoot: libEn,
        env: envEn,
        home: baseEn,
        documentsDir: baseEn,
        skipAutoProbe: true,
        language: 'en',
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
        await ttyEn.waitFor((s) => s.includes('MockCourse') || s.includes('Library'), { label: 'ASCII app load (en)' });

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

        // Move to leaf 1.1 Circuit Breaker, then 1.2 Bulkhead Isolation (0 choice questions) -> press M -> info toast
        ttyEn.send('j');
        await ttyEn.waitFor((s) => s.includes('Linked questions: 3'), {
          label: 'Circuit Breaker leaf selected first (en)',
        });
        ttyEn.send('j');
        await ttyEn.waitFor((s) => s.includes('Bulkhead Isolation') && s.includes('Linked questions: 1'), {
          label: 'Bulkhead leaf selected (en)',
        });
        ttyEn.send('M');
        const noChoiceToast = await ttyEn.waitFor(
          (s) => s.includes('Mock exam needs choice Qs'),
          { label: 'No choice questions info toast (en)' },
        );
        ttyEn.assertHealthyScreen(noChoiceToast, 120, 36, 'No choice toast (en)');
        ttyEn.assertAsciiPure(noChoiceToast, 'No choice toast (en)');

        // Move back up to 1.1 Circuit Breaker -> press M -> ConfirmDialog -> cancel on Esc
        ttyEn.send('k');
        await ttyEn.waitFor((s) => s.includes('Linked questions: 3'), { label: 'Circuit Breaker selected (en)' });
        ttyEn.send('M');
        const confirmEn = await ttyEn.waitFor(
          (s) => {
            const flat = s.replace(/\s+/g, ' ');
            return (
              flat.includes('Chapter Mock Exam') &&
              flat.includes('Planned 2') &&
              flat.includes('choice questions') &&
              flat.includes('30 min limit') &&
              flat.includes('1 non-choice skipped')
            );
          },
          { label: 'ASCII Mock ConfirmDialog opened (en)' },
        );
        ttyEn.assertHealthyScreen(confirmEn, 120, 36, 'ASCII Mock ConfirmDialog (en)');
        ttyEn.assertAsciiPure(confirmEn, 'ASCII Mock ConfirmDialog (en)');

        ttyEn.send('\x1b');
        const afterCancelEn = await ttyEn.waitFor(
          (s) => !s.includes('Chapter Mock Exam') && useTuiStore.getState().page === 'book',
          { label: 'ASCII Mock ConfirmDialog canceled on Esc (en)' },
        );
        ttyEn.assertHealthyScreen(afterCancelEn, 120, 36, 'ASCII BookView after Esc cancel (en)');
        ttyEn.assertAsciiPure(afterCancelEn, 'ASCII BookView after Esc cancel (en)');

        // Open BookQaModal ('P') -> verify section Q&A in ASCII mode
        ttyEn.send('P');
        const qaScreenEn = await ttyEn.waitFor(
          (s) => s.includes('Section 1') && s.includes('Why does half-open state probe'),
          { label: 'ASCII BookQaModal section Q&A (en)' },
        );
        ttyEn.assertHealthyScreen(qaScreenEn, 120, 36, 'ASCII BookQaModal (en)');
        ttyEn.assertAsciiPure(qaScreenEn, 'ASCII BookQaModal (en)');
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
