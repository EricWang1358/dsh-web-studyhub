// Round 66 Track 2: DashboardView [d] usage window cycling (7d/30d/90d) & [x] atomic Markdown report export tests
// `node --test --test-concurrency=1 tests/round66-dashboard-export.test.mjs`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import path, { dirname, join, resolve } from 'node:path';
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

// Bundle pure helper formatDashboardMarkdownReport from DashboardView.tsx for unit tests
const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyhub-r66-dashboard-'));
const bundleFile = path.join(bundleDir, 'dashboard-helper.mjs');
await build({
  stdin: {
    contents: `export { formatDashboardMarkdownReport } from './src/views/dashboard/DashboardView.tsx';`,
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
fs.symlinkSync(path.join(pkgRoot, 'node_modules'), path.join(bundleDir, 'node_modules'), 'junction');
const { formatDashboardMarkdownReport } = await import(pathToFileURL(bundleFile).href);

const PREV_DSH_HOME = process.env.DSH_HOME;
const ORIGINAL_FETCH = globalThis.fetch;
const tempDirs = [bundleDir];

async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-r66-${label}-`));
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

describe('Round 66 Track 2: DashboardView [d] Usage Window & [x] Markdown Report Export', () => {
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

    const sampleRes = await host.call('sample.load', { language: 'zh' });
    assert.equal(sampleRes.ok, true, `sample.load failed: ${sampleRes.error?.message}`);
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

  test('1) Pure unit test: formatDashboardMarkdownReport renders zh & en KPI, forecast, top-15 weak topics, course breakdown & token usage', () => {
    const sampleWeak = Array.from({ length: 20 }, (_, i) => ({
      deckId: `deck-${i + 1}`,
      deckTitle: `Deck ${i + 1}`,
      course: i % 2 === 0 ? 'Operating Systems' : 'Algorithms | Core',
      topic: `Topic #${i + 1}`,
      wrong: 20 - i,
      lastAt: '2026-11-22',
      cards: [{ deckId: `deck-${i + 1}`, cardId: `c-${i + 1}` }],
    }));

    const sampleInput = {
      stats: {
        today: '2026-11-22',
        totals: {
          cards: 120,
          mastered: 72,
          due: 14,
          weak: 20,
          attempts: 340,
          recentRate: 86,
          activeDays: 18,
          streak: 6,
        },
        forecast: {
          days: [
            { date: '2026-11-22', count: 14, overdue: 3 },
            { date: '2026-11-23', count: 9, overdue: 0 },
            { date: '2026-11-24', count: 11, overdue: 0 },
          ],
        },
        weakTopics: sampleWeak,
      },
      dailyPlan: {
        date: '2026-11-22',
        budgetMinutes: 45,
        spentMinutes: 25,
      },
      usage: {
        days: 90,
        total: {
          calls: 42,
          uncachedInputTokens: 12_000,
          outputTokens: 3_500,
          cacheReadTokens: 4_000,
          cacheWriteTokens: 500,
        },
        byFeature: {
          review_help: {
            calls: 30,
            uncachedInputTokens: 9_000,
            outputTokens: 2_500,
            cacheReadTokens: 3_000,
            cacheWriteTokens: 500,
          },
          generate: {
            calls: 12,
            uncachedInputTokens: 3_000,
            outputTokens: 1_000,
            cacheReadTokens: 1_000,
            cacheWriteTokens: 0,
          },
        },
      },
      usageDays: 90,
      courseRows: [
        { rawCourse: 'Operating Systems', label: 'Operating Systems', masteryPct: 82, totalCards: 70, dueCount: 8, weakCount: 10 },
        { rawCourse: 'Algorithms', label: 'Algorithms', masteryPct: 68, totalCards: 50, dueCount: 6, weakCount: 10 },
      ],
      focusCourse: 'Operating Systems',
      generatedAt: '2026-11-22',
    };

    const mdZh = formatDashboardMarkdownReport({ ...sampleInput, lang: 'zh' });
    assert.ok(mdZh.includes('# StudyHub 学习进度报告'));
    assert.ok(mdZh.includes('生成日期: 2026-11-22'));
    assert.ok(mdZh.includes('当前课程: Operating Systems'));
    assert.ok(mdZh.includes('今日学习时长: 25 / 45 分钟'));
    assert.ok(mdZh.includes('## 核心指标 (KPI)'));
    assert.ok(mdZh.includes('| 总题数 (Total Cards) | 120 |'));
    assert.ok(mdZh.includes('| 已掌握 (Mastered) | 72 |'));
    assert.ok(mdZh.includes('| 今日到期 (Due Today) | 14 |'));
    assert.ok(mdZh.includes('| 薄弱题 (Weak) | 20 |'));
    assert.ok(mdZh.includes('| 累计作答 (Attempts) | 340 |'));
    assert.ok(mdZh.includes('| 正确率 (Accuracy) | 86% |'));
    assert.ok(mdZh.includes('| 活跃天数 (Active Days) | 18 |'));
    assert.ok(mdZh.includes('| 连续学习 (Streak) | 6 天 |'));
    assert.ok(mdZh.includes('## 未来 7 日复习预测'));
    assert.ok(mdZh.includes('2026-11-22 (今日)'));
    assert.ok(mdZh.includes('## 薄弱知识点 (Top 15)'));
    assert.ok(mdZh.includes('Topic #15'));
    assert.ok(!mdZh.includes('Topic #16'), 'weak topics table must cap at top 15');
    assert.ok(mdZh.includes('Algorithms \\| Core'), 'pipe characters must be escaped in Markdown tables');
    assert.ok(mdZh.includes('## 各课程掌握度'));
    assert.ok(mdZh.includes('| Operating Systems | 82% | 70 | 8 | 10 |'));
    assert.ok(mdZh.includes('## AI Token 用量汇总 (90天)'));
    assert.ok(mdZh.includes('统计窗口: 90 天'));
    assert.ok(mdZh.includes('调用次数: 42'));
    assert.ok(mdZh.includes('总 Token: 20000 (20.0K)'));
    assert.ok(mdZh.includes('| review_help | 30 | 15000 |'));

    const mdEn = formatDashboardMarkdownReport({
      ...sampleInput,
      lang: 'en',
      focusCourse: null,
      stats: { ...sampleInput.stats, forecast: { days: [] } },
      usageDays: 7,
    });
    assert.ok(mdEn.includes('# StudyHub Study Progress Report'));
    assert.ok(mdEn.includes('- Date: 2026-11-22'));
    assert.ok(!mdEn.includes('Focus Course:'), 'focusCourse omitted when null');
    assert.ok(mdEn.includes('## Key Metrics (KPI)'));
    assert.ok(mdEn.includes('| Total Cards | 120 |'));
    assert.ok(mdEn.includes('| Streak | 6d |'));
    assert.ok(!mdEn.includes('## 7-Day Review Forecast'), 'forecast section omitted when forecast days empty');
    assert.ok(mdEn.includes('## Weak Topics (Top 15)'));
    assert.ok(mdEn.includes('## Per-Course Mastery'));
    assert.ok(mdEn.includes('## AI Token Usage Summary (7d)'));
    assert.ok(mdEn.includes('- Window: 7d'));
    assert.ok(mdEn.includes('- Calls: 42'));
  });

  test('2) PTY E2E (120x36 zh): Dashboard [6] -> [d] cycles 30->90->7 -> [x] writes atomic Markdown report (0 model calls)', async () => {
    fetchCalls = 0;
    const expectedPath = join(libraryRoot, 'backups', `studyhub-report-${todayLocalYmd()}.md`);
    await rm(expectedPath, { force: true });

    const tty = await mountApp({ initialPage: 'library', asciiMode: false, language: 'zh', cols: 120, rows: 36 });
    await tty.waitFor((s) => s.includes('Memento') || s.includes('学习库'), {
      timeoutMs: 10_000,
      label: 'Initial Library view loaded (zh)',
    });

    // Navigate to Dashboard ('6')
    tty.send('6');
    const dash30 = await tty.waitFor(
      (s) => s.includes('学习统计与掌握度') && s.includes('用量:30天') && s.includes('30天)') && s.includes('导出报告'),
      { timeoutMs: 8_000, label: 'DashboardView rendered at 30d default (zh 120x36)' },
    );
    tty.assertHealthyScreen(dash30, 120, 36, 'DashboardView initial 30d zh 120x36');

    // Cycle usage window: 30 -> 90
    tty.send('d');
    const dash90 = await tty.waitFor(
      (s) => s.includes('用量:90天') && s.includes('90天)') && s.includes('最近 90 天'),
      { timeoutMs: 8_000, label: 'DashboardView cycled usage window to 90d (zh)' },
    );
    tty.assertHealthyScreen(dash90, 120, 36, 'DashboardView 90d zh 120x36');

    // Cycle usage window: 90 -> 7
    tty.send('d');
    const dash7 = await tty.waitFor(
      (s) => s.includes('用量:7天') && s.includes('7天)') && s.includes('最近 7 天'),
      { timeoutMs: 8_000, label: 'DashboardView cycled usage window to 7d (zh)' },
    );
    tty.assertHealthyScreen(dash7, 120, 36, 'DashboardView 7d zh 120x36');

    // Export Markdown report via [x]
    tty.send('x');
    const exportedScreen = await tty.waitFor(
      (s) => s.includes('已导出报告'),
      { timeoutMs: 8_000, label: 'DashboardView [x] showed export toast (zh)' },
    );
    tty.assertHealthyScreen(exportedScreen, 120, 36, 'DashboardView after [x] export zh 120x36');

    const mdContent = await readFile(expectedPath, 'utf8');
    assert.ok(mdContent.includes('# StudyHub 学习进度报告'), 'exported report has zh title');
    assert.ok(mdContent.includes('## 核心指标 (KPI)'), 'exported report has KPI table');
    assert.ok(mdContent.includes('| 总题数 (Total Cards) |'), 'exported report has Total Cards row');
    assert.ok(mdContent.includes('## 各课程掌握度'), 'exported report has course breakdown');
    assert.ok(mdContent.includes('## AI Token 用量汇总 (7天)'), 'exported report reflects active 7d usage window');
    assert.equal(fetchCalls, 0, 'Dashboard [d] & [x] must make 0 model/network calls');
  });

  test('3) PTY E2E (80x24 --ascii en): Dashboard [6] -> [d] -> [x] passes assertHealthyScreen & assertAsciiPure', async () => {
    fetchCalls = 0;
    const expectedPath = join(libraryRoot, 'backups', `studyhub-report-${todayLocalYmd()}.md`);
    await rm(expectedPath, { force: true });

    const tty = await mountApp({ initialPage: 'library', asciiMode: true, language: 'en', cols: 80, rows: 24 });
    await tty.waitFor((s) => s.includes('Library') || s.includes('Memento') || s.includes('Courses'), {
      timeoutMs: 10_000,
      label: 'Initial Library view loaded (en --ascii)',
    });

    // Navigate to Dashboard ('6')
    tty.send('6');
    const dash30 = await tty.waitFor(
      (s) => s.includes('Study Analytics') && s.includes('/30d)'),
      { timeoutMs: 8_000, label: 'DashboardView rendered at 80x24 (en --ascii)' },
    );
    tty.assertHealthyScreen(dash30, 80, 24, 'DashboardView initial 30d en ascii 80x24');
    tty.assertAsciiPure(dash30, 'DashboardView initial 30d en ascii 80x24 pure');

    // Cycle usage window: 30 -> 90
    tty.send('d');
    const dash90 = await tty.waitFor(
      (s) => s.includes('/90d)') && s.includes('90d'),
      { timeoutMs: 8_000, label: 'DashboardView cycled to 90d at 80x24 (en --ascii)' },
    );
    tty.assertHealthyScreen(dash90, 80, 24, 'DashboardView 90d en ascii 80x24');
    tty.assertAsciiPure(dash90, 'DashboardView 90d en ascii 80x24 pure');

    // Export Markdown report via [x]
    tty.send('x');
    const exportedScreen = await tty.waitFor(
      (s) => s.includes('Exported MD'),
      { timeoutMs: 8_000, label: 'DashboardView [x] showed ASCII-safe export toast (en --ascii 80x24)' },
    );
    tty.assertHealthyScreen(exportedScreen, 80, 24, 'DashboardView after [x] export en ascii 80x24');
    tty.assertAsciiPure(exportedScreen, 'DashboardView after [x] export en ascii 80x24 pure');

    const mdContent = await readFile(expectedPath, 'utf8');
    assert.ok(mdContent.includes('# StudyHub Study Progress Report'), 'exported report has en title');
    assert.ok(mdContent.includes('## Key Metrics (KPI)'), 'exported report has en KPI table');
    assert.ok(mdContent.includes('## Per-Course Mastery'), 'exported report has en course breakdown');
    assert.ok(mdContent.includes('## AI Token Usage Summary (90d)'), 'exported report reflects active 90d usage window');
    assert.equal(fetchCalls, 0, 'Dashboard [d] & [x] (--ascii en) must make 0 model/network calls');
  });
});
