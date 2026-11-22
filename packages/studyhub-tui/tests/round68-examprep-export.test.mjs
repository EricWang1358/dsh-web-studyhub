// Round 68 Track 2: ExamPrepView `/` live focus-topic filter & `[x]` atomic Exam Prep Markdown export
// `node --test --test-concurrency=1 tests/round68-examprep-export.test.mjs`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
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
    if (!S && mod.useTuiStore) S = mod;
  }
}
assert.ok(H?.createTuiHost, 'dist/ must export createTuiHost');
assert.ok(H?.saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(R?.displayWidth, 'dist/ must export displayWidth');
assert.ok(S?.useTuiStore, 'dist/ must export useTuiStore');
const { useTuiStore } = S;

const { formatExamPrepMarkdown } = await tsImport(
  '../src/views/examprep/ExamPrepView.tsx',
  import.meta.url,
);
assert.equal(typeof formatExamPrepMarkdown, 'function', 'ExamPrepView must export formatExamPrepMarkdown');

const PREV_DSH_HOME = process.env.DSH_HOME;
const ORIGINAL_FETCH = globalThis.fetch;
const UNICODE_UI_CHROME_RE =
  /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u27BF\u2800-\u28FF\u2190-\u21FF\u2022\u2026\u2039\u203A]/g;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-r68-${label}-`));
  tempDirs.push(d);
  return d;
}

function todayLocalYmd(now = new Date()) {
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
    await sleep(35);
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

  async function waitFor(predicate, { timeoutMs = 8_000, label = 'condition' } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await flush();
      const screen = readScreen();
      if (predicate(screen)) return screen;
      await sleep(35);
    }
    const finalScreen = readScreen();
    throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms.\n--- SCREEN ---\n${finalScreen}\n--------------`);
  }

  function assertHealthyScreen(screen, expectedCols, expectedRows, contextLabel) {
    const lines = screen.split('\n');
    assert.ok(lines.length <= expectedRows, `${contextLabel}: row count ${lines.length} > ${expectedRows}`);
    assert.ok(
      !screen.includes('页面渲染异常') && !screen.includes('View Error'),
      `${contextLabel}: ViewErrorBoundary triggered!\n${screen}`,
    );
    assert.ok(
      !screen.includes('TypeError:') && !screen.includes('ReferenceError:'),
      `${contextLabel}: Runtime JS error rendered!\n${screen}`,
    );
    assert.ok(!/\bNaN\b/.test(screen), `${contextLabel}: raw NaN leaked!\n${screen}`);
    assert.ok(!/\bundefined\b/.test(screen), `${contextLabel}: raw undefined leaked!\n${screen}`);
    assert.ok(!screen.includes('[object Object]'), `${contextLabel}: raw [object Object] leaked!\n${screen}`);
    assert.ok(!screen.includes('\uFFFD'), `${contextLabel}: Replacement char U+FFFD found!\n${screen}`);
    assert.ok(
      !screen.includes('\x1b'),
      `${contextLabel}: Unparsed escape sequence leaked into xterm buffer!\n${screen}`,
    );
    for (let i = 0; i < lines.length; i += 1) {
      const w = R.displayWidth(lines[i]);
      assert.ok(
        w <= expectedCols,
        `${contextLabel}: Row ${i} exceeds cols (${w} > ${expectedCols}): ${JSON.stringify(lines[i])}`,
      );
    }
    const buf = term.buffer.active;
    for (let y = 0; y < term.rows; y += 1) {
      const line = buf.getLine(buf.viewportY + y);
      if (line) {
        assert.equal(
          line.isWrapped,
          false,
          `${contextLabel}: xterm soft-wrapped row ${y}: ${JSON.stringify(line.translateToString(true))}`,
        );
      }
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

function resetStore({ language = 'zh', asciiMode = false, page = 'library' } = {}) {
  const prev = useTuiStore.getState();
  useTuiStore.setState({
    page,
    history: [],
    navContext: {},
    commandPaletteOpen: false,
    helpOpen: false,
    coursePickerOpen: false,
    inboxOpen: false,
    voicePackOpen: false,
    showLaunchpad: false,
    inputCaptured: false,
    toasts: [],
    preferences: {
      ...prev.preferences,
      language,
      asciiMode,
      sidebarCollapsed: false,
      showKeyHints: true,
    },
  });
}

after(async () => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

describe('Round 68 Track 2: ExamPrepView `/` live filter & `[x]` atomic Markdown export', () => {
  test('1. Pure unit test: formatExamPrepMarkdown (zh & en, topics table, crunch checklist, notes, empty state)', () => {
    const sampleTopics = [
      {
        topic: 'Virtual Memory | Paging',
        cards: 10,
        counts: { new: 1, weak: 2, learning: 1, familiar: 2, mastered: 4 },
        mastery: 0.65,
        status: 'weak',
        weakCards: [
          { deckId: 'd1', cardId: 'c1' },
          { deckId: 'd1', cardId: 'c2' },
        ],
      },
      {
        topic: 'CPU Scheduling',
        cards: 6,
        counts: { mastered: 6 },
        mastery: 1,
        status: 'done',
        weakCards: [],
      },
      {
        topic: 'Deadlock Avoidance',
        cards: 4,
        counts: { new: 4 },
        mastery: 0.1,
        status: 'todo',
        weakCards: [],
      },
      {
        topic: 'File Systems',
        cards: 0,
        counts: {},
        mastery: 0,
        status: 'none',
        weakCards: [],
      },
    ];

    const sampleCrunch = [
      { id: 'pt-1', title: 'Page Replacement Algorithms', questions: 5, weak: 1, done: '2026-11-22' },
      { id: 'pt-2', title: 'Banker Algorithm', questions: 3, weak: 0, seen: '2026-11-22', done: null },
    ];

    const zhMd = formatExamPrepMarkdown({
      course: 'OS301',
      examDate: '2026-12-18',
      topics: sampleTopics,
      crunchPoints: sampleCrunch,
      planNotes: 'Prioritize weak paging cards before mock exam.',
      lang: 'zh',
      generatedAt: '2026-11-22 14:00',
    });

    assert.ok(zhMd.includes('# StudyHub 备考计划与重点进度'));
    assert.ok(zhMd.includes('生成日期**: 2026-11-22 14:00'));
    assert.ok(zhMd.includes('课程**: OS301'));
    assert.ok(zhMd.includes('考试日期**: 2026-12-18'));
    assert.ok(zhMd.includes('共 4 项 (已掌握 1 / 薄弱 1 / 待学 1 / 缺题 1)'));
    assert.ok(zhMd.includes('| 重点主题 | 状态 | 掌握率 | 题数 | 薄弱题 |'));
    assert.ok(zhMd.includes('| Virtual Memory \\| Paging | 薄弱 | 65% | 10 | 2 |'));
    assert.ok(zhMd.includes('| CPU Scheduling | 已掌握 | 100% | 6 | 0 |'));
    assert.ok(zhMd.includes('| File Systems | 暂无题 | - | 0 | 0 |'));
    assert.ok(zhMd.includes('## 期末冲刺清单'));
    assert.ok(zhMd.includes('- [x] Page Replacement Algorithms (5题, 1错)'));
    assert.ok(zhMd.includes('- [ ] Banker Algorithm (3题, 已翻看)'));
    assert.ok(zhMd.includes('## 备考计划备注'));
    assert.ok(zhMd.includes('Prioritize weak paging cards before mock exam.'));

    const enMd = formatExamPrepMarkdown({
      course: 'OS301',
      examDate: '2026-12-18',
      topics: sampleTopics,
      crunchPoints: sampleCrunch,
      planNotes: 'Daily 30m drill.',
      lang: 'en',
      generatedAt: new Date('2026-11-22T14:00:00Z'),
    });

    assert.ok(enMd.includes('# StudyHub Exam Prep Plan & Focus Progress'));
    assert.ok(enMd.includes('Course**: OS301'));
    assert.ok(enMd.includes('Exam Date**: 2026-12-18'));
    assert.ok(enMd.includes('4 total (Done 1 / Weak 1 / Todo 1 / None 1)'));
    assert.ok(enMd.includes('| Topic | Status | Mastery | Cards | Weak |'));
    assert.ok(enMd.includes('| Virtual Memory \\| Paging | Weak | 65% | 10 | 2 |'));
    assert.ok(enMd.includes('| CPU Scheduling | Mastered | 100% | 6 | 0 |'));
    assert.ok(enMd.includes('## Final-Week Crunch'));
    assert.ok(enMd.includes('- [x] Page Replacement Algorithms (5 Q, 1 weak)'));
    assert.ok(enMd.includes('- [ ] Banker Algorithm (3 Q, seen)'));
    assert.ok(enMd.includes('## Study Plan Notes'));
    assert.ok(enMd.includes('Daily 30m drill.'));

    const emptyEn = formatExamPrepMarkdown({
      course: '',
      topics: [],
      crunchPoints: [],
      lang: 'en',
      generatedAt: '2026-11-22',
    });
    assert.ok(emptyEn.includes('Course**: All Courses'));
    assert.ok(!emptyEn.includes('Exam Date**:'));
    assert.ok(emptyEn.includes('0 total (Done 0 / Weak 0 / Todo 0 / None 0)'));
    assert.ok(emptyEn.includes('_No focus topics yet._'));
    assert.ok(!emptyEn.includes('## Final-Week Crunch'));
    assert.ok(!emptyEn.includes('## Study Plan Notes'));
  });

  test('2. @xterm/headless PTY E2E (120x36 zh): sample course -> seed 2 focus topics -> / filter -> Enter -> x export -> Esc clear (0 model calls)', async () => {
    const box = await makeTempDir('e2e-zh');
    const dshHome = join(box, 'dsh-home');
    const libraryRoot = join(box, 'library');
    await mkdir(libraryRoot, { recursive: true });
    process.env.DSH_HOME = dshHome;

    let fetchCalls = 0;
    let llmCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error('Unexpected global fetch call');
    };

    await H.saveTuiPreferences({ language: 'zh', asciiMode: false }, { env: { DSH_HOME: dshHome } });
    const host = await H.createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(box, 'home'),
      libraryRoot,
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 25,
      fetch: async () => {
        fetchCalls += 1;
        throw new Error('Unexpected host fetch call');
      },
    });
    host.streamComplete = async () => {
      llmCalls += 1;
      throw new Error('Unexpected streamComplete call');
    };

    const sampleRes = await host.call('sample.load', { language: 'zh' });
    assert.equal(sampleRes.ok, true, `sample.load failed: ${sampleRes.error?.message}`);
    const snapRes = await host.call('snapshot', {});
    assert.equal(snapRes.ok, true);
    const activeCourse =
      snapRes.value?.focus?.course ||
      snapRes.value?.courses?.[0]?.name ||
      snapRes.value?.decks?.find((d) => !d.archived && d.course)?.course;
    assert.ok(activeCourse, 'sample course must exist');

    const saveRes = await host.call('course.save', {
      name: activeCourse,
      exam: { date: '2026-12-20' },
      plan: { version: 1, notes: '先刷薄弱考点，再做模拟卷。' },
      focusTopics: ['进程调度与死锁', '虚拟内存分页'],
    });
    assert.equal(saveRes.ok, true, `course.save failed: ${saveRes.error?.message}`);
    await host.refreshSnapshot();

    resetStore({ language: 'zh', asciiMode: false, page: 'library' });
    const tty = createVirtualTty(120, 36);
    let inst = null;
    try {
      inst = render(
        React.createElement(StudyHubTuiApp, {
          host,
          autoLaunchpad: false,
          onExit: () => inst?.unmount(),
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
      await tty.waitFor((s) => !s.includes('正在打开学习库'), { label: 'LibraryView ready (zh)' });

      // Navigate to ExamPrep ('0')
      tty.send('0');
      const initialScreen = await tty.waitFor(
        (s) => {
          const hints = useTuiStore.getState().footerHints;
          return (
            useTuiStore.getState().page === 'examprep' &&
            s.includes('进程调度与死锁') &&
            s.includes('虚拟内存分页') &&
            hints.some((h) => h.key === '/' && h.label === '筛选') &&
            hints.some((h) => h.key === 'x' && h.label === '导出MD')
          );
        },
        { label: 'ExamPrepView rendered with seeded focus topics (zh)' },
      );
      const hintKeys = useTuiStore.getState().footerHints.map((h) => h.key);
      assert.ok(hintKeys.indexOf('/') > hintKeys.indexOf('d'), '`/` hint must appear after existing hints');
      assert.ok(hintKeys.indexOf('x') > hintKeys.indexOf('/'), '`x` hint must appear after `/` hint');
      tty.assertHealthyScreen(initialScreen, 120, 36, 'ExamPrepView initial 120x36 zh');

      // Press `/` to open live filter bar and filter to '虚拟内存'
      tty.send('/');
      await tty.waitFor((s) => s.includes('[筛选 2/2]'), { label: 'ExamPrep filter bar opened' });
      tty.send('虚拟内存');
      const filteredEditing = await tty.waitFor(
        (s) =>
          s.includes('[筛选 1/2]') &&
          s.includes('虚拟内存分页') &&
          !s.includes('进程调度与死锁'),
        { label: 'Filter narrowed focus topics to 虚拟内存分页' },
      );
      tty.assertHealthyScreen(filteredEditing, 120, 36, 'ExamPrepView filter editing');

      // Enter confirms filter keeping filter active
      tty.send('\r');
      const filteredConfirmed = await tty.waitFor(
        (s) => s.includes('[已筛选 1/2]') && s.includes('虚拟内存分页') && !s.includes('进程调度与死锁'),
        { label: 'Enter confirmed ExamPrep filter bar' },
      );
      tty.assertHealthyScreen(filteredConfirmed, 120, 36, 'ExamPrepView filter confirmed');

      // Press `d` to verify clamped selection targets exact filtered topic (`虚拟内存分页`), then Esc to cancel dialog
      tty.send('d');
      const confirmDeleteScreen = await tty.waitFor(
        (s) => s.includes('移除重点条目') && s.includes('虚拟内存分页'),
        { label: 'Delete confirm dialog targets filtered topic 虚拟内存分页' },
      );
      tty.assertHealthyScreen(confirmDeleteScreen, 120, 36, 'ExamPrepView confirm delete on filtered topic');
      tty.send('\u001b');
      await tty.waitFor((s) => !s.includes('移除重点条目') && s.includes('[已筛选 1/2]'), {
        label: 'Delete confirm dialog cancelled with Esc',
      });

      // Press `x` to export Markdown atomically
      const expectedExportPath = join(libraryRoot, 'backups', `studyhub-examprep-${todayLocalYmd()}.md`);
      await rm(expectedExportPath, { force: true });
      tty.send('x');
      const exportToastScreen = await tty.waitFor(
        (s) => s.includes('已导出 2 项重点'),
        { label: 'ExamPrep Markdown export toast (zh)' },
      );
      tty.assertHealthyScreen(exportToastScreen, 120, 36, 'ExamPrepView after export');

      assert.equal(fs.existsSync(expectedExportPath), true, 'studyhub-examprep-*.md must exist on disk');
      const exportedMd = await readFile(expectedExportPath, 'utf8');
      assert.ok(exportedMd.includes('# StudyHub 备考计划与重点进度'));
      assert.ok(exportedMd.includes(`课程**: ${activeCourse}`));
      assert.ok(exportedMd.includes('考试日期**: 2026-12-20'));
      assert.ok(exportedMd.includes('进程调度与死锁'));
      assert.ok(exportedMd.includes('虚拟内存分页'));
      assert.ok(exportedMd.includes('先刷薄弱考点，再做模拟卷。'));

      // Press `Esc` in normal mode to clear active filter
      tty.send('\u001b');
      const clearedScreen = await tty.waitFor(
        (s) => !s.includes('[已筛选') && s.includes('进程调度与死锁') && s.includes('虚拟内存分页'),
        { label: 'Esc cleared active filter cleanly' },
      );
      tty.assertHealthyScreen(clearedScreen, 120, 36, 'ExamPrepView filter cleared');
      assert.equal(llmCalls, 0, 'ExamPrep filter & export must make 0 LLM calls');
      assert.equal(fetchCalls, 0, 'ExamPrep filter & export must make 0 network fetch calls');
    } finally {
      try {
        inst?.unmount();
      } catch {
        // Ignore unmount error
      }
      tty.dispose();
      await host.dispose();
    }
  });

  test('3. @xterm/headless PTY E2E (80x24 --ascii en): ExamPrep (0) -> / -> x -> assertHealthyScreen + assertAsciiPure', async () => {
    const box = await makeTempDir('e2e-ascii-en');
    const dshHome = join(box, 'dsh-home');
    const libraryRoot = join(box, 'library');
    await mkdir(libraryRoot, { recursive: true });
    process.env.DSH_HOME = dshHome;

    await H.saveTuiPreferences({ language: 'en', asciiMode: true }, { env: { DSH_HOME: dshHome } });
    const host = await H.createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(box, 'home'),
      libraryRoot,
      skipAutoProbe: true,
      language: 'en',
      eventDebounceMs: 25,
    });

    resetStore({ language: 'en', asciiMode: true, page: 'library' });
    const tty = createVirtualTty(80, 24);
    let inst = null;
    try {
      inst = render(
        React.createElement(StudyHubTuiApp, {
          host,
          autoLaunchpad: false,
          onExit: () => inst?.unmount(),
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
      await tty.waitFor((s) => !s.includes('Opening library'), { label: 'LibraryView ready (en ascii)' });

      // Empty state [x] -> friendly info toast, no file written
      const expectedExportPath = join(libraryRoot, 'backups', `studyhub-examprep-${todayLocalYmd()}.md`);
      await rm(expectedExportPath, { force: true });
      useTuiStore.setState({ toasts: [] });
      tty.send('0');
      const emptyPrep = await tty.waitFor(
        (s) => useTuiStore.getState().page === 'examprep' && s.includes('No Exam Focus Points Yet'),
        { label: 'ASCII ExamPrepView 80x24 empty ready' },
      );
      tty.assertHealthyScreen(emptyPrep, 80, 24, 'ASCII ExamPrepView 80x24 empty');
      tty.assertAsciiPure(emptyPrep, 'ASCII ExamPrepView 80x24 empty');
      tty.send('x');
      const emptyToast = await tty.waitFor(
        (_s) =>
          useTuiStore
            .getState()
            .toasts.some((toast) => toast.tone === 'info' && toast.text.includes('No exam prep topics or crunch items to export')),
        { label: 'ASCII ExamPrep empty export info toast' },
      );
      tty.assertHealthyScreen(emptyToast, 80, 24, 'ASCII ExamPrepView empty export toast');
      tty.assertAsciiPure(emptyToast, 'ASCII ExamPrepView empty export toast');
      assert.equal(fs.existsSync(expectedExportPath), false, 'empty exam prep must not write markdown file');

      // Seed 2 focus topics & reload ExamPrep via 'r'
      const seedCourseRes = await host.call('course.save', {
        name: 'Systems101',
        focusTopics: ['Cache Coherence', 'Thread Synchronization'],
      });
      assert.equal(seedCourseRes.ok, true, `course.save failed: ${seedCourseRes.error?.message}`);
      await host.refreshSnapshot();
      tty.send('r');
      const prepScreen = await tty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'examprep' &&
          s.includes('Cache Coherence') &&
          s.includes('Thread Synchronization'),
        { label: 'ASCII ExamPrepView 80x24 ready' },
      );
      tty.assertHealthyScreen(prepScreen, 80, 24, 'ASCII ExamPrepView 80x24 initial');
      tty.assertAsciiPure(prepScreen, 'ASCII ExamPrepView 80x24 initial');

      // Press `/` -> type 'Cache' -> Enter
      tty.send('/');
      await tty.waitFor((s) => s.includes('[Filter 2/2]'), { label: 'ASCII ExamPrep filter bar opened' });
      tty.send('Cache');
      const filteredAscii = await tty.waitFor(
        (s) => s.includes('[Filter 1/2]') && s.includes('Cache Coherence') && !s.includes('Thread Synchronization'),
        { label: 'ASCII filter narrowed to Cache Coherence' },
      );
      tty.assertHealthyScreen(filteredAscii, 80, 24, 'ASCII ExamPrepView filter editing');
      tty.assertAsciiPure(filteredAscii, 'ASCII ExamPrepView filter editing');

      tty.send('\r');
      const confirmedAscii = await tty.waitFor(
        (s) => s.includes('[Filtered 1/2]') && s.includes('Cache Coherence'),
        { label: 'ASCII filter confirmed' },
      );
      tty.assertHealthyScreen(confirmedAscii, 80, 24, 'ASCII ExamPrepView filter confirmed');
      tty.assertAsciiPure(confirmedAscii, 'ASCII ExamPrepView filter confirmed');

      // Press `x` -> export Markdown and verify ASCII-pure toast + file on disk
      useTuiStore.setState({ toasts: [] });
      tty.send('x');
      const exportedAscii = await tty.waitFor(
        (_s) =>
          useTuiStore
            .getState()
            .toasts.some((toast) => toast.tone === 'success' && toast.text.includes('Exported 2 topic(s)')),
        { label: 'ASCII ExamPrep export toast' },
      );
      tty.assertHealthyScreen(exportedAscii, 80, 24, 'ASCII ExamPrepView after export');
      tty.assertAsciiPure(exportedAscii, 'ASCII ExamPrepView after export');
      assert.equal(fs.existsSync(expectedExportPath), true, 'ASCII export must write studyhub-examprep-*.md');

      // Press `Esc` -> clear filter
      tty.send('\u001b');
      const clearedAscii = await tty.waitFor(
        (s) => !s.includes('[Filtered') && s.includes('Cache Coherence') && s.includes('Thread Synchronization'),
        { label: 'ASCII Esc cleared filter' },
      );
      tty.assertHealthyScreen(clearedAscii, 80, 24, 'ASCII ExamPrepView cleared');
      tty.assertAsciiPure(clearedAscii, 'ASCII ExamPrepView cleared');
    } finally {
      try {
        inst?.unmount();
      } catch {
        // Ignore unmount error
      }
      tty.dispose();
      await host.dispose();
    }
  });
});
