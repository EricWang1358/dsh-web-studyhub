// Round 67 Track 3: ExamSetup [x] atomic Exam History Markdown Report export tests
// `node --test --test-concurrency=1 tests/round67-exam-export.test.mjs`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
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
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('chunk-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!H && typeof mod.createTuiHost === 'function' && typeof mod.saveTuiPreferences === 'function') H = mod;
    if (!R && typeof mod.displayWidth === 'function') R = mod;
  }
}
assert.ok(H?.createTuiHost, 'dist/ must export createTuiHost');
assert.ok(H?.saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(R?.displayWidth, 'dist/ must export displayWidth');

// Bundle pure helper formatExamHistoryMarkdown from ExamSetup.tsx for unit tests
const bundleDir = fs.mkdtempSync(join(os.tmpdir(), 'studyhub-r67-exam-'));
const bundleFile = join(bundleDir, 'exam-helper.mjs');
await build({
  stdin: {
    contents: `export { formatExamHistoryMarkdown } from './src/views/exam/ExamSetup.tsx';`,
    resolveDir: pkgRoot,
    loader: 'ts',
  },
  outfile: bundleFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  logLevel: 'silent',
  absWorkingDir: pkgRoot,
});
fs.symlinkSync(join(pkgRoot, 'node_modules'), join(bundleDir, 'node_modules'), 'junction');
const { formatExamHistoryMarkdown } = await import(pathToFileURL(bundleFile).href);

const PREV_DSH_HOME = process.env.DSH_HOME;
const ORIGINAL_FETCH = globalThis.fetch;
const tempDirs = [bundleDir];

async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-r67-${label}-`));
  tempDirs.push(d);
  return d;
}

function todayLocalYmd() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
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
    assert.ok(!screen.includes('\uFFFD'), `${label}: replacement char U+FFFD leaked`);
    for (let i = 0; i < lines.length; i += 1) {
      const w = R.displayWidth(lines[i]);
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

describe('Round 67 Track 3: ExamSetup [x] Atomic Exam History Markdown Report Export', () => {
  let boxDir;
  let dshHome;
  let libraryRoot;
  let host;
  let fetchCalls = 0;
  let activeTty = null;
  let activeInk = null;
  let disposed = false;

  async function unmountActiveApp() {
    const ink = activeInk;
    const tty = activeTty;
    activeInk = null;
    activeTty = null;
    try {
      ink?.unmount();
    } catch {
      // Ignore unmount errors during test teardown
    }
    tty?.dispose();
  }

  async function mountApp({ initialPage = 'library', asciiMode = false, language = 'zh', cols = 120, rows = 36 } = {}) {
    await unmountActiveApp();
    await H.saveTuiPreferences({ language, asciiMode }, { env: { DSH_HOME: dshHome } });
    host.setLanguage(language);
    const tty = createVirtualTty(cols, rows);
    let inkInstance = null;
    inkInstance = render(
      React.createElement(StudyHubTuiApp, {
        host,
        initialPage,
        initialLanguage: language,
        initialAsciiMode: asciiMode,
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
    activeTty = tty;
    activeInk = inkInstance;
    await tty.firstFramePromise;
    return tty;
  }

  before(async () => {
    boxDir = await makeTempDir('main');
    dshHome = join(boxDir, 'dsh-home');
    libraryRoot = join(boxDir, 'library');
    await mkdir(libraryRoot, { recursive: true });
    process.env.DSH_HOME = dshHome;

    host = await H.createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(boxDir, 'home'),
      libraryRoot,
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
      fetch: async () => {
        fetchCalls += 1;
        throw new Error('Unexpected fetch call');
      },
    });

    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error('Unexpected global fetch call');
    };

    await host.refreshSnapshot();
  });

  after(async () => {
    if (disposed) return;
    disposed = true;
    try {
      await unmountActiveApp();
      await host?.dispose();
    } finally {
      globalThis.fetch = ORIGINAL_FETCH;
      if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = PREV_DSH_HOME;
      await Promise.all(
        tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
      );
    }
  });

  test('1) Pure unit test: formatExamHistoryMarkdown (zh & en, selected attempt detail + summary table + empty case)', () => {
    const sampleHistory = [
      {
        runId: 'run-written-1',
        kind: 'written',
        mode: 'written',
        title: '[选择题卷] 操作系统 | 核心考点',
        scope: 'Operating Systems | Core',
        scorePct: 85,
        score: '85%',
        answered: 17,
        total: 20,
        durationMs: 750_000,
        submittedAt: '2026-11-22T10:30:00.000Z',
      },
      {
        runId: 'run-case-1',
        kind: 'written',
        mode: 'case',
        examKinds: 'case',
        title: '[案例卷] 临床诊断分析',
        scope: 'Clinical Case Deck',
        scorePct: 75,
        score: '75%',
        answered: 4,
        total: 4,
        durationMs: 1_200_000,
        submittedAt: '2026-11-21T16:15:00.000Z',
      },
      {
        runId: 'run-oral-1',
        kind: 'oral',
        mode: 'oral',
        title: '[口试] Examiner',
        scope: 'Examiner',
        score: '4/5★',
        assessed: 5,
        strong: 4,
        total: 5,
        duration: '08:20',
        submittedAt: '2026-11-20T09:00:00.000Z',
      },
    ];

    const mdZh = formatExamHistoryMarkdown({
      history: sampleHistory,
      selectedAttempt: sampleHistory[0],
      lang: 'zh',
      generatedAt: '2026-11-22',
    });
    assert.ok(mdZh.includes('# StudyHub 模拟考试历史报告'));
    assert.ok(mdZh.includes('生成日期**: 2026-11-22'));
    assert.ok(mdZh.includes('考试记录总数**: 3'));
    assert.ok(mdZh.includes('平均正确率 / 得分**: 80%'));
    assert.ok(mdZh.includes('## 当前选中记录'));
    assert.ok(mdZh.includes('选择题卷 (written)'));
    assert.ok(mdZh.includes('85%'));
    assert.ok(mdZh.includes('17/20'));
    assert.ok(mdZh.includes('12:30'));
    assert.ok(mdZh.includes('2026-11-22T10:30:00.000Z'));
    assert.ok(mdZh.includes('## 考试历史汇总'));
    assert.ok(mdZh.includes('| # | 日期 | 模式 | 范围 / 标题 | 成绩 / 正确率 | 用时 |'));
    assert.ok(mdZh.includes('Operating Systems \\| Core'), 'pipe characters must be escaped in Markdown table');
    assert.ok(mdZh.includes('案例卷 (case)'));
    assert.ok(mdZh.includes('口试 (oral)'));
    assert.ok(mdZh.includes('08:20'));

    const mdEn = formatExamHistoryMarkdown({
      history: sampleHistory,
      selectedAttempt: sampleHistory[1],
      lang: 'en',
      generatedAt: '2026-11-22',
    });
    assert.ok(mdEn.includes('# StudyHub Exam History Report'));
    assert.ok(mdEn.includes('Generated**: 2026-11-22'));
    assert.ok(mdEn.includes('Total Exam Records**: 3'));
    assert.ok(mdEn.includes('Average Accuracy / Score**: 80%'));
    assert.ok(mdEn.includes('## Selected Attempt'));
    assert.ok(mdEn.includes('Case Paper (case)'));
    assert.ok(mdEn.includes('4/4'));
    assert.ok(mdEn.includes('20:00'));
    assert.ok(mdEn.includes('## Exam Attempts Summary'));
    assert.ok(mdEn.includes('| # | Date | Mode | Scope / Title | Score / Accuracy | Duration |'));

    const mdEmptyZh = formatExamHistoryMarkdown({ history: [], selectedAttempt: null, lang: 'zh', generatedAt: '2026-11-22' });
    assert.ok(mdEmptyZh.includes('考试记录总数**: 0'));
    assert.ok(mdEmptyZh.includes('平均正确率 / 得分**: -'));
    assert.ok(!mdEmptyZh.includes('## 当前选中记录'));
    assert.ok(mdEmptyZh.includes('暂无模拟考试记录'));

    const mdEmptyEn = formatExamHistoryMarkdown({ history: [], selectedAttempt: null, lang: 'en', generatedAt: '2026-11-22' });
    assert.ok(mdEmptyEn.includes('Total Exam Records**: 0'));
    assert.ok(!mdEmptyEn.includes('## Selected Attempt'));
    assert.ok(mdEmptyEn.includes('No exam history records'));
  });

  test('2) PTY E2E (120x36 zh): Exam [5] empty toast -> seed completed exam -> [x] writes studyhub-exam-*.md (0 model calls)', async () => {
    fetchCalls = 0;
    const expectedPath = join(libraryRoot, 'backups', `studyhub-exam-${todayLocalYmd()}.md`);
    await rm(expectedPath, { force: true });

    const tty = await mountApp({ initialPage: 'library', asciiMode: false, language: 'zh', cols: 120, rows: 36 });
    await tty.waitFor((s) => s.includes('Memento') || s.includes('学习库'), {
      timeoutMs: 10_000,
      label: 'Initial Library view loaded (zh)',
    });

    // Navigate to Exam ('5') while library has 0 exam records
    tty.send('5');
    const examEmptyScreen = await tty.waitFor(
      (s) => s.includes('组卷设置') && s.includes('历史考卷') && s.includes('导出记录') && s.includes('暂无考试记录'),
      { timeoutMs: 8_000, label: 'ExamSetup rendered at 120x36 (zh) empty' },
    );
    tty.assertHealthyScreen(examEmptyScreen, 120, 36, 'ExamSetup initial empty zh 120x36');

    // Empty history export -> friendly info toast, no file written
    tty.send('x');
    const emptyToastScreen = await tty.waitFor(
      (s) => s.includes('暂无可导出的模拟考试记录'),
      { timeoutMs: 5_000, label: 'ExamSetup [x] empty warning toast (zh)' },
    );
    tty.assertHealthyScreen(emptyToastScreen, 120, 36, 'ExamSetup empty export toast zh 120x36');
    assert.equal(fs.existsSync(expectedPath), false, 'empty history must not create report file');

    // Load sample course & seed a completed written exam attempt through StudyRuntime host (0 model calls)
    const sampleRes = await host.call('sample.load', { language: 'zh' });
    assert.equal(sampleRes.ok, true, `sample.load failed: ${sampleRes.error?.message}`);
    const snapBefore = await host.call('snapshot');
    assert.equal(snapBefore.ok, true);
    const eligibleDeck = (snapBefore.value?.decks ?? []).find(
      (d) => !d.archived && Number(d.examCount ?? d.cardCount ?? 0) > 0,
    );
    assert.ok(eligibleDeck?.id, 'sample course must have an eligible exam deck');

    const startRes = await host.call('review.start', {
      mode: 'exam',
      examKinds: 'all',
      count: 2,
      limitMinutes: 15,
      scope: [{ deckId: eligibleDeck.id }],
      fresh: true,
    });
    assert.equal(startRes.ok, true, `review.start exam failed: ${startRes.error?.message}`);
    const run = startRes.value;
    if (run.card?.id && Array.isArray(run.card.options) && run.card.options.length > 0) {
      const ansRes = await host.call('review.answer', {
        runId: run.id,
        cardId: run.card.id,
        selected: [run.card.options[0].id],
      });
      assert.equal(ansRes.ok, true, `review.answer failed: ${ansRes.error?.message}`);
    }
    const submitRes = await host.call('exam.submit', { runId: run.id });
    assert.equal(submitRes.ok, true, `exam.submit failed: ${submitRes.error?.message}`);
    await host.refreshSnapshot();

    // Wait for Past Exams panel in ExamSetup to reflect the submitted attempts
    const seededScreen = await tty.waitFor(
      (s) => s.includes('选择题卷') && s.includes('%') && !s.includes('暂无考试记录'),
      { timeoutMs: 8_000, label: 'ExamSetup history updated after exam.submit (zh)' },
    );
    tty.assertHealthyScreen(seededScreen, 120, 36, 'ExamSetup with seeded history zh 120x36');

    // Press 'x' to export atomic Markdown report
    tty.send('x');
    const exportedScreen = await tty.waitFor(
      (s) => s.includes('已导出') && s.includes('条模考记录'),
      { timeoutMs: 8_000, label: 'ExamSetup [x] export success toast (zh)' },
    );
    tty.assertHealthyScreen(exportedScreen, 120, 36, 'ExamSetup after [x] export zh 120x36');

    const mdContent = await readFile(expectedPath, 'utf8');
    assert.ok(mdContent.includes('# StudyHub 模拟考试历史报告'), 'exported report has zh title');
    assert.ok(mdContent.includes('考试记录总数**: 2'), 'exported report has record count');
    assert.ok(mdContent.includes('## 当前选中记录'), 'exported report has selected attempt section');
    assert.ok(mdContent.includes('## 考试历史汇总'), 'exported report has summary table');
    assert.ok(mdContent.includes('| # | 日期 | 模式 | 范围 / 标题 | 成绩 / 正确率 | 用时 |'));
    assert.match(mdContent, /\d+%/, 'exported report contains score percentage');
    assert.equal(fetchCalls, 0, 'ExamSetup [x] export must make 0 model/network calls');
  });

  test('3) PTY E2E (80x24 --ascii en): Exam [5] -> [x] passes assertHealthyScreen & assertAsciiPure', async () => {
    fetchCalls = 0;
    const expectedPath = join(libraryRoot, 'backups', `studyhub-exam-${todayLocalYmd()}.md`);
    await rm(expectedPath, { force: true });

    const tty = await mountApp({ initialPage: 'library', asciiMode: true, language: 'en', cols: 80, rows: 24 });
    await tty.waitFor((s) => s.includes('Library') || s.includes('Memento') || s.includes('Courses'), {
      timeoutMs: 10_000,
      label: 'Initial Library view loaded (en --ascii)',
    });

    // Navigate to Exam ('5')
    tty.send('5');
    const examScreen = await tty.waitFor(
      (s) => s.includes('Exam Setup') && s.includes('History') && s.includes('1:Written MCQ'),
      { timeoutMs: 8_000, label: 'ExamSetup rendered at 80x24 (en --ascii)' },
    );
    tty.assertHealthyScreen(examScreen, 80, 24, 'ExamSetup initial en ascii 80x24');
    tty.assertAsciiPure(examScreen, 'ExamSetup initial en ascii 80x24 pure');

    // Press 'x' to export exam history Markdown report
    tty.send('x');
    const exportedScreen = await tty.waitFor(
      (s) => s.includes('Exported 2 exam'),
      { timeoutMs: 8_000, label: 'ExamSetup [x] showed ASCII-safe export toast (en --ascii 80x24)' },
    );
    tty.assertHealthyScreen(exportedScreen, 80, 24, 'ExamSetup after [x] export en ascii 80x24');
    tty.assertAsciiPure(exportedScreen, 'ExamSetup after [x] export en ascii 80x24 pure');

    const mdContent = await readFile(expectedPath, 'utf8');
    assert.ok(mdContent.includes('# StudyHub Exam History Report'), 'exported report has en title');
    assert.ok(mdContent.includes('Total Exam Records**: 2'), 'exported report has en count');
    assert.ok(mdContent.includes('## Selected Attempt'), 'exported report has selected attempt section');
    assert.ok(mdContent.includes('## Exam Attempts Summary'), 'exported report has summary table');
    assert.ok(mdContent.includes('| # | Date | Mode | Scope / Title | Score / Accuracy | Duration |'));
    assert.match(mdContent, /\d+%/, 'exported report contains score percentage');
    assert.equal(fetchCalls, 0, 'ExamSetup [x] (--ascii en) must make 0 model/network calls');
  });
});
