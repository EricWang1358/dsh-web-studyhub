// Round 55 ExamCoachView Manual Coach Prep Queue Flush (coach.prepare, P2 ConfirmDialog)
// + Live Queue Status Pill integration & @xterm/headless PTY E2E tests:
// node --test tests/round55-coach-prep.test.mjs
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
assert.ok(H, 'dist/ must export createTuiHost and saveTuiPreferences');
assert.ok(displayWidth, 'dist/ must export displayWidth');
assert.ok(useDistTuiStore, 'dist/ must export useTuiStore');
assert.ok(DEFAULT_PREFERENCES, 'dist/ must export DEFAULT_PREFERENCES');

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
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round55-${label}-`));
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

function fakeDiscovery() {
  const result = () => [
    { id: 'agy', supported: true, status: 'not-installed', executablePath: null, version: null, reasonCode: 'not-installed', reason: '' },
    { id: 'claude', supported: false, status: 'coming-soon', executablePath: null, version: null, reasonCode: 'coming-soon-not-installed', reason: '' },
    { id: 'codex', supported: true, status: 'not-installed', executablePath: null, version: null, reasonCode: 'not-installed', reason: '' },
  ];
  return {
    async scan() {
      return result();
    },
    getCached: () => result(),
    findReadyPath: () => '',
    findReadyAgyPath: () => '',
    findReadyCodexPath: () => '',
  };
}

after(async () => {
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

describe('Round 55: ExamCoachView Manual Coach Prep Queue Flush (coach.prepare) & Live Queue Status Pill', () => {
  test('1) createTuiHost integration (0 AI calls): coach.prepare {} returns valid CoachStatusResult', async () => {
    const base = await makeTempDir('host');
    const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');

    let aiCalls = 0;
    const host = await H.createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      providerDiscovery: fakeDiscovery(),
      injectedComplete: async () => {
        aiCalls += 1;
        return '';
      },
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      const sampleRes = await host.call('sample.load', { language: 'en' });
      assert.equal(sampleRes.ok, true, sampleRes.error?.message);

      const prepRes = await host.call('coach.prepare', {});
      assert.equal(prepRes.ok, true, prepRes.error?.message);
      assert.equal(typeof prepRes.value, 'object');
      assert.ok(prepRes.value !== null, 'coach.prepare must return an object');
      assert.equal(typeof prepRes.value.enabled, 'boolean');
      assert.equal(typeof prepRes.value.ready, 'number');
      assert.equal(typeof prepRes.value.preparing, 'boolean');
      assert.ok(Array.isArray(prepRes.value.tasks), 'coachStatus.tasks must be an array');
      assert.equal(aiCalls, 0, 'coach.prepare {} on empty queue must make 0 model calls');
    } finally {
      await host.dispose();
    }
  });

  test('2) PTY E2E at 120x36 zh & 80x24 --ascii en: [f] P2 ConfirmDialog, n/Esc cancel (0 calls), y flush + toast + live pill', async () => {
    // 2a) zh at 120x36
    const zhBase = await makeTempDir('pty-zh');
    const zhDshHome = join(zhBase, 'dsh-home');
    process.env.DSH_HOME = zhDshHome;
    await H.saveTuiPreferences(
      { language: 'zh', asciiMode: false, theme: 'tokyo-night', mathUnicode: true, showHints: true },
      { env: { ...process.env, DSH_HOME: zhDshHome } },
    );

    let zhAiCalls = 0;
    const zhHost = await H.createTuiHost({
      libraryRoot: join(zhBase, 'library'),
      env: { ...process.env, DSH_HOME: zhDshHome },
      home: join(zhBase, 'home'),
      documentsDir: zhBase,
      providerDiscovery: fakeDiscovery(),
      injectedComplete: async () => {
        zhAiCalls += 1;
        return '';
      },
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    const zhTty = createVirtualTty(120, 36);
    let zhInk = null;
    try {
      resetDistStore('zh', false);
      zhInk = render(
        React.createElement(StudyHubTuiApp, {
          host: zhHost,
          initialPage: 'library',
          initialLanguage: 'zh',
          initialAsciiMode: false,
          autoLaunchpad: true,
          onExit: () => zhInk?.unmount(),
        }),
        {
          stdin: zhTty.stdin,
          stdout: zhTty.stdout,
          stderr: zhTty.stderr,
          interactive: true,
          exitOnCtrlC: false,
          patchConsole: false,
        },
      );
      await zhTty.firstFramePromise;

      await zhTty.waitFor((s) => s.includes('载入示例课程体验'), { label: 'zh Launchpad render' });
      zhTty.send('s');
      await zhTty.waitFor(
        (s) => !s.includes('载入示例课程体验') && s.includes('示例 · Memento 与 Bridge'),
        { timeoutMs: 12_000, label: 'zh sample loaded' },
      );

      zhTty.send('9');
      const zhCoach = await zhTty.waitFor(
        (s) => s.includes('考试教练') && s.includes('校准与考法') && s.includes('备题 0') && !s.includes('正在加载'),
        { timeoutMs: 10_000, label: 'zh ExamCoachView rendered with live queue status pill' },
      );
      zhTty.assertHealthyScreen(zhCoach, 120, 36, 'zh ExamCoachView initial');

      // Press [f] -> opens P2 ConfirmDialog with 0 model calls
      zhTty.send('f');
      const zhConfirm1 = await zhTty.waitFor(
        (s) => s.includes('触发教练后台备题队列') && s.includes('coach.prepare'),
        { timeoutMs: 5_000, label: 'zh ConfirmDialog opened via f' },
      );
      zhTty.assertHealthyScreen(zhConfirm1, 120, 36, 'zh flush prep ConfirmDialog');
      assert.equal(zhAiCalls, 0, 'opening flush prep ConfirmDialog must make 0 model calls');

      // Press [n] -> cancels cleanly with 0 model calls
      zhTty.send('n');
      const zhCancelledN = await zhTty.waitFor(
        (s) => !s.includes('触发教练后台备题队列') && s.includes('考试教练'),
        { timeoutMs: 5_000, label: 'zh ConfirmDialog cancelled via n' },
      );
      zhTty.assertHealthyScreen(zhCancelledN, 120, 36, 'zh after n cancel');
      assert.equal(zhAiCalls, 0, 'cancelling flush prep via n must make 0 model calls');

      // Press [f] -> [Esc] -> cancels cleanly with 0 model calls
      zhTty.send('f');
      await zhTty.waitFor((s) => s.includes('触发教练后台备题队列'), { timeoutMs: 5_000, label: 'zh ConfirmDialog reopened for Esc' });
      zhTty.send('\x1b');
      await zhTty.waitFor(
        (s) => !s.includes('触发教练后台备题队列') && s.includes('考试教练'),
        { timeoutMs: 5_000, label: 'zh ConfirmDialog cancelled via Esc' },
      );
      assert.equal(zhAiCalls, 0, 'cancelling flush prep via Esc must make 0 model calls');

      // Press [f] -> [y] -> triggers coach.prepare & shows success toast
      zhTty.send('f');
      await zhTty.waitFor((s) => s.includes('触发教练后台备题队列'), { timeoutMs: 5_000, label: 'zh ConfirmDialog reopened for y' });
      zhTty.send('y');
      const zhFlushed = await zhTty.waitFor(
        (s) => !s.includes('触发教练后台备题队列') && s.includes('已触发教练备题队列（就绪 0 题）'),
        { timeoutMs: 8_000, label: 'zh coach.prepare success toast' },
      );
      zhTty.assertHealthyScreen(zhFlushed, 120, 36, 'zh after coach.prepare flush');
      assert.equal(zhAiCalls, 0, 'flushing empty prep queue must make 0 model calls');

      // Switch to Variants tab (2) -> verify footer hint + live pill
      zhTty.send('2');
      const zhVariants = await zhTty.waitFor(
        (s) => s.includes('教练备题池') && s.includes('立即备题') && s.includes('待备队列: 0'),
        { timeoutMs: 5_000, label: 'zh Variants tab with live queue status & f hint' },
      );
      zhTty.assertHealthyScreen(zhVariants, 120, 36, 'zh Variants tab 120x36');
    } finally {
      try {
        zhInk?.unmount();
      } catch {
        // ignore
      }
      await zhHost.dispose();
      zhTty.dispose();
    }

    // 2b) --ascii en at 80x24
    const enBase = await makeTempDir('pty-ascii-en');
    const enDshHome = join(enBase, 'dsh-home');
    process.env.DSH_HOME = enDshHome;
    await H.saveTuiPreferences(
      { language: 'en', asciiMode: true, theme: 'tokyo-night', mathUnicode: false, showHints: true },
      { env: { ...process.env, DSH_HOME: enDshHome } },
    );

    let enAiCalls = 0;
    const enHost = await H.createTuiHost({
      libraryRoot: join(enBase, 'library'),
      env: { ...process.env, DSH_HOME: enDshHome },
      home: join(enBase, 'home'),
      documentsDir: enBase,
      providerDiscovery: fakeDiscovery(),
      injectedComplete: async () => {
        enAiCalls += 1;
        return '';
      },
      skipAutoProbe: true,
      language: 'en',
      eventDebounceMs: 30,
    });

    const enTty = createVirtualTty(80, 24);
    let enInk = null;
    try {
      resetDistStore('en', true);
      enInk = render(
        React.createElement(StudyHubTuiApp, {
          host: enHost,
          initialPage: 'library',
          initialLanguage: 'en',
          initialAsciiMode: true,
          autoLaunchpad: true,
          onExit: () => enInk?.unmount(),
        }),
        {
          stdin: enTty.stdin,
          stdout: enTty.stdout,
          stderr: enTty.stderr,
          interactive: true,
          exitOnCtrlC: false,
          patchConsole: false,
        },
      );
      await enTty.firstFramePromise;

      await enTty.waitFor((s) => s.includes('Load the sample course'), { label: 'en Launchpad render' });
      enTty.send('s');
      await enTty.waitFor(
        (s) => !s.includes('Load the sample course') && s.includes('Memento'),
        { timeoutMs: 12_000, label: 'en sample loaded' },
      );

      enTty.send('9');
      const enCoach = await enTty.waitFor(
        (s) => s.includes('Exam Coach') && s.includes('Calibration') && s.includes('Prep 0') && !s.includes('Loading'),
        { timeoutMs: 10_000, label: 'en ExamCoachView rendered at 80x24' },
      );
      enTty.assertHealthyScreen(enCoach, 80, 24, 'en ASCII ExamCoachView 80x24');
      enTty.assertAsciiPure(enCoach, 'en ASCII ExamCoachView 80x24');

      // Press [f] -> P2 ConfirmDialog opens with 0 model calls
      enTty.send('f');
      const enConfirm = await enTty.waitFor(
        (s) => s.includes('Flush Coach Prep Queue') && s.includes('coach.prepare'),
        { timeoutMs: 5_000, label: 'en ConfirmDialog opened via f at 80x24' },
      );
      enTty.assertHealthyScreen(enConfirm, 80, 24, 'en ASCII flush prep ConfirmDialog 80x24');
      enTty.assertAsciiPure(enConfirm, 'en ASCII flush prep ConfirmDialog 80x24');
      assert.equal(enAiCalls, 0, 'en opening ConfirmDialog must make 0 model calls');

      // Press [n] -> cancels cleanly with 0 model calls
      enTty.send('n');
      const enCancelled = await enTty.waitFor(
        (s) => !s.includes('Flush Coach Prep Queue') && s.includes('Exam Coach'),
        { timeoutMs: 5_000, label: 'en ConfirmDialog cancelled via n at 80x24' },
      );
      enTty.assertHealthyScreen(enCancelled, 80, 24, 'en ASCII after n cancel 80x24');
      enTty.assertAsciiPure(enCancelled, 'en ASCII after n cancel 80x24');
      assert.equal(enAiCalls, 0, 'en cancelling via n must make 0 model calls');

      // Press [f] -> [y] -> triggers coach.prepare & shows success toast
      // (at 80 cols ToastStack width=32 truncates text to 26 cols: "Coach prep queue flushe...")
      enTty.send('f');
      await enTty.waitFor((s) => s.includes('Flush Coach Prep Queue'), { timeoutMs: 5_000, label: 'en ConfirmDialog reopened for y' });
      enTty.send('y');
      const enFlushed = await enTty.waitFor(
        (s) => !s.includes('Flush Coach Prep Queue') && s.includes('Coach prep queue flushe'),
        { timeoutMs: 8_000, label: 'en coach.prepare success toast at 80x24' },
      );
      assert.ok(
        useDistTuiStore.getState().toasts.some((t) => t.text === 'Coach prep queue flushed (0 ready)' && t.tone === 'success'),
        'expected exact full success toast in store',
      );
      enTty.assertHealthyScreen(enFlushed, 80, 24, 'en ASCII after coach.prepare flush 80x24');
      enTty.assertAsciiPure(enFlushed, 'en ASCII after coach.prepare flush 80x24');
      assert.equal(enAiCalls, 0, 'en flushing empty prep queue must make 0 model calls');

      // Switch to Variants tab (2) -> verify footer hint + live pill at 80x24 (single-pane list, then Detail pane)
      enTty.send('2');
      const enVariantsList = await enTty.waitFor(
        (s) => s.includes('Weak Cards Variant Status') && s.includes('Prep Queue') && s.includes('Coach Queue'),
        { timeoutMs: 5_000, label: 'en Variants tab list with live pill & Prep Queue hint at 80x24' },
      );
      enTty.assertHealthyScreen(enVariantsList, 80, 24, 'en ASCII Variants tab list 80x24');
      enTty.assertAsciiPure(enVariantsList, 'en ASCII Variants tab list 80x24');
      enTty.send('\t');
      const enVariants = await enTty.waitFor(
        (s) => s.includes('Prepared Variant Pool') && s.includes('Prep Queue') && s.includes('Queued: 0'),
        { timeoutMs: 5_000, label: 'en Variants detail pane with live pill & Queued count at 80x24' },
      );
      enTty.assertHealthyScreen(enVariants, 80, 24, 'en ASCII Variants tab 80x24');
      enTty.assertAsciiPure(enVariants, 'en ASCII Variants tab 80x24');
    } finally {
      try {
        enInk?.unmount();
      } catch {
        // ignore
      }
      await enHost.dispose();
      enTty.dispose();
    }
  });
});
