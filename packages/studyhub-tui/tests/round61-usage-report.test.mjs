// Round 61 Track 1: WorkspaceTab local Usage Frequency Report, Pause/Resume, and Export
// (`usage.frequency.report`, `usage.frequency.set { paused }`, `usage.frequency.export`) tests:
// `node --test tests/round61-usage-report.test.mjs`
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, describe, test } from 'node:test';
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

const PREV_DSH_HOME = process.env.DSH_HOME;
const ORIGINAL_FETCH = globalThis.fetch;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round61-${label}-`));
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

describe('Round 61 Track 1: WorkspaceTab Usage Frequency Report, Pause/Resume & Export', () => {
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

  test('1) createTuiHost integration: enable, record, report (7/30/all), pause/resume, and export with 0 model calls', async () => {
    fetchCalls = 0;
    const today = todayLocalYmd();

    const enableRes = await host.call('usage.frequency.set', { enabled: true });
    assert.equal(enableRes.ok, true, enableRes.error?.message);
    assert.equal(enableRes.value.enabled, true);
    assert.equal(enableRes.value.paused, false);

    const recRes = await host.call('usage.frequency.record', {
      records: [
        { key: 'review.option', area: 'review', day: today, n: 12 },
        { key: 'review.flip', area: 'review', day: today, n: 8 },
        { key: 'nav.library', area: 'library', day: today, n: 5 },
      ],
    });
    assert.equal(recRes.ok, true, recRes.error?.message);
    assert.equal(recRes.value.accepted, 3);
    assert.equal(recRes.value.rejected, 0);

    for (const period of [7, 30, 'all']) {
      const reportRes = await host.call('usage.frequency.report', { period, language: 'zh' });
      assert.equal(reportRes.ok, true, reportRes.error?.message);
      assert.equal(reportRes.value.period, period);
      assert.equal(reportRes.value.summary.interactions, 25);
      assert.equal(reportRes.value.summary.daysWithData, 1);
      assert.equal(reportRes.value.summary.distinctControls, 3);
      assert.equal(reportRes.value.ranking[0].key, 'review.option');
      assert.equal(reportRes.value.ranking[0].count, 12);
      assert.ok(Array.isArray(reportRes.value.observations) && reportRes.value.observations.length >= 1);
    }

    const pauseRes = await host.call('usage.frequency.set', { paused: true });
    assert.equal(pauseRes.ok, true, pauseRes.error?.message);
    assert.equal(pauseRes.value.enabled, true);
    assert.equal(pauseRes.value.paused, true);

    const resumeRes = await host.call('usage.frequency.set', { paused: false });
    assert.equal(resumeRes.ok, true, resumeRes.error?.message);
    assert.equal(resumeRes.value.enabled, true);
    assert.equal(resumeRes.value.paused, false);

    const exportRes = await host.call('usage.frequency.export', { format: 'json', period: 30, language: 'en' });
    assert.equal(exportRes.ok, true, exportRes.error?.message);
    assert.match(exportRes.value.filename, /^studyhub-usage-\d{4}-\d{2}-\d{2}\.json$/);
    assert.equal(exportRes.value.mime, 'application/json');
    const parsed = JSON.parse(exportRes.value.content);
    assert.equal(parsed.app, 'StudyHub');
    assert.equal(parsed.summary.interactions, 25);
    assert.equal(parsed.controls.length, 3);
    assert.equal(fetchCalls, 0, 'usage frequency operations must make 0 network/model calls');
  });

  test('2) PTY E2E (120x36 zh): Settings -> WorkspaceTab -> [i] UsageReportModal -> [1] 7d -> [p] pause -> [e] export JSON -> Esc', async () => {
    fetchCalls = 0;
    const statusRes = await host.call('usage.frequency.set', { enabled: true, paused: false });
    assert.equal(statusRes.ok, true, statusRes.error?.message);

    const tty = await mountApp({ initialPage: 'library', asciiMode: false, language: 'zh', cols: 120, rows: 36 });
    await tty.waitFor((s) => s.includes('学习库') || s.includes('Library'), {
      timeoutMs: 8_000,
      label: 'Initial Library view rendered (zh)',
    });

    // Navigate to Settings via ',' and switch to WorkspaceTab ('2')
    tty.send(',');
    await tty.waitFor((s) => s.includes('模型配置') && s.includes('学习库与工作区'), {
      timeoutMs: 8_000,
      label: 'SettingsView rendered via , (zh)',
    });

    tty.send('2');
    const wsScreen = await tty.waitFor(
      (s) => s.includes('使用频率记录:') && s.includes('[i] 报表'),
      { timeoutMs: 8_000, label: 'WorkspaceTab [i] 报表 visible (120x36 zh)' },
    );
    tty.assertHealthyScreen(wsScreen, 120, 36, 'WorkspaceTab 120x36 zh');
    assert.equal(fetchCalls, 0, 'WorkspaceTab mount must trigger 0 fetch calls');

    // Open UsageReportModal via 'i'
    tty.send('i');
    const modalScreen = await tty.waitFor(
      (s) =>
        s.includes('本地使用频率报表') &&
        s.includes('运行中') &&
        s.includes('互动 25 次') &&
        s.includes('选择答案选项'),
      { timeoutMs: 8_000, label: 'UsageReportModal displays stats & top controls (120x36 zh)' },
    );
    tty.assertHealthyScreen(modalScreen, 120, 36, 'UsageReportModal 120x36 zh');

    // Switch period to 7d via '1'
    tty.send('1');
    const period7Screen = await tty.waitFor(
      (s) => s.includes('本地使用频率报表') && s.includes('最近 7 天') && s.includes('互动 25 次'),
      { timeoutMs: 8_000, label: 'UsageReportModal switched to 7d period via [1] (zh)' },
    );
    tty.assertHealthyScreen(period7Screen, 120, 36, 'UsageReportModal 7d 120x36 zh');

    // Toggle pause via 'p'
    tty.send('p');
    const pausedScreen = await tty.waitFor(
      (s) => s.includes('本地使用频率报表') && s.includes('已暂停'),
      { timeoutMs: 8_000, label: 'UsageReportModal displays Paused status after [p] (zh)' },
    );
    tty.assertHealthyScreen(pausedScreen, 120, 36, 'UsageReportModal paused 120x36 zh');

    // Export JSON via 'e' and verify file on disk
    const expectedPath = join(libraryRoot, 'backups', `studyhub-usage-${todayLocalYmd()}.json`);
    await rm(expectedPath, { force: true });
    tty.send('e');
    const exportedScreen = await tty.waitFor(
      (s) => s.includes('studyhub-usage-') && s.includes('已导出'),
      { timeoutMs: 8_000, label: 'UsageReportModal confirms JSON export after [e] (zh)' },
    );
    tty.assertHealthyScreen(exportedScreen, 120, 36, 'UsageReportModal exported 120x36 zh');

    const rawExported = await readFile(expectedPath, 'utf8');
    const exportedJson = JSON.parse(rawExported);
    assert.equal(exportedJson.app, 'StudyHub');
    assert.equal(exportedJson.period, 7);
    assert.equal(exportedJson.summary.interactions, 25);
    assert.equal(exportedJson.controls[0].key, 'review.option');

    // Close modal cleanly with Esc
    tty.send('\x1b');
    const closedScreen = await tty.waitFor(
      (s) => !s.includes('本地使用频率报表') && s.includes('[i] 报表'),
      { timeoutMs: 5_000, label: 'UsageReportModal closed via Esc (zh)' },
    );
    tty.assertHealthyScreen(closedScreen, 120, 36, 'WorkspaceTab after usage report close 120x36 zh');
    assert.equal(fetchCalls, 0);
  });

  test('3) PTY E2E (80x24 --ascii en): UsageReportModal pure ASCII, period [3] All, Esc close', async () => {
    fetchCalls = 0;
    const statusRes = await host.call('usage.frequency.set', { enabled: true, paused: false });
    assert.equal(statusRes.ok, true, statusRes.error?.message);

    const tty = await mountApp({ initialPage: 'library', asciiMode: true, language: 'en', cols: 80, rows: 24 });
    await tty.waitFor((s) => s.includes('Library') || s.includes('Courses'), {
      timeoutMs: 8_000,
      label: 'Initial Library view rendered (en --ascii)',
    });

    // Navigate to Settings via ',' and switch to WorkspaceTab ('2')
    tty.send(',');
    await tty.waitFor((s) => s.includes('Models') && s.includes('Workspace'), {
      timeoutMs: 8_000,
      label: 'SettingsView rendered via , (en --ascii)',
    });

    tty.send('2');
    const wsScreen = await tty.waitFor(
      (s) => s.includes('Usage Frequency:') && s.includes('[i] Report'),
      { timeoutMs: 8_000, label: 'WorkspaceTab [i] Report visible (80x24 en --ascii)' },
    );
    tty.assertHealthyScreen(wsScreen, 80, 24, 'WorkspaceTab 80x24 en --ascii');
    tty.assertAsciiPure(wsScreen, 'WorkspaceTab 80x24 en --ascii');

    // Open UsageReportModal via 'i'
    tty.send('i');
    const modalScreen = await tty.waitFor(
      (s) =>
        s.includes('Usage Frequency Report') &&
        s.includes('Active') &&
        s.includes('Interactions: 25') &&
        s.includes('Top Controls:'),
      { timeoutMs: 8_000, label: 'UsageReportModal rendered (80x24 en --ascii)' },
    );
    tty.assertHealthyScreen(modalScreen, 80, 24, 'UsageReportModal 80x24 en --ascii');
    tty.assertAsciiPure(modalScreen, 'UsageReportModal 80x24 en --ascii');

    // Switch period to All via '3'
    tty.send('3');
    const allScreen = await tty.waitFor(
      (s) => s.includes('Usage Frequency Report') && s.includes('All time') && s.includes('Interactions: 25'),
      { timeoutMs: 8_000, label: 'UsageReportModal switched to All time via [3] (80x24 en --ascii)' },
    );
    tty.assertHealthyScreen(allScreen, 80, 24, 'UsageReportModal All 80x24 en --ascii');
    tty.assertAsciiPure(allScreen, 'UsageReportModal All 80x24 en --ascii');

    // Close modal cleanly with Esc
    tty.send('\x1b');
    const closedScreen = await tty.waitFor(
      (s) => !s.includes('Usage Frequency Report') && s.includes('[i] Report'),
      { timeoutMs: 5_000, label: 'UsageReportModal closed via Esc (80x24 en --ascii)' },
    );
    tty.assertHealthyScreen(closedScreen, 80, 24, 'WorkspaceTab after usage report close 80x24 en --ascii');
    tty.assertAsciiPure(closedScreen, 'WorkspaceTab after usage report close 80x24 en --ascii');
    assert.equal(fetchCalls, 0);
  });
});
