// Round 60 Track 2: WorkspaceTab manual release update check (`[A]`, snooze, offline fail-soft)
// and AppearanceTab live terminal capabilities diagnostics tests:
// `node --test tests/round60-update-caps.test.mjs`
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
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
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round60-${label}-`));
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

function makeMockReleaseResponse(version = '9.9.9', notes = 'Highlights:\n- Faster FSRS review\n- Terminal capability strip') {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({
      tag_name: `v${version}`,
      published_at: '2026-11-22T08:00:00Z',
      html_url: `https://github.com/EricWang1358/dsh-web-studyhub/releases/tag/v${version}`,
      body: notes,
      assets: [],
    }),
    body: { cancel: async () => {} },
  };
}

describe('Round 60 Track 2: WorkspaceTab Manual Update Check & AppearanceTab Terminal Capabilities', () => {
  let boxDir;
  let dshHome;
  let libraryRoot;
  let host;
  let fetchImpl;
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

    fetchImpl = async () => {
      throw new Error('Unexpected fetch in before()');
    };

    host = await H.createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(boxDir, 'home'),
      libraryRoot,
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
      fetch: async (url, init) => {
        fetchCalls += 1;
        return fetchImpl(url, init);
      },
    });

    // Replace globalThis.fetch AFTER createTuiHost loads lib/http.js so NATIVE_FETCH !== globalThis.fetch
    // and defaultLongFetch routes update.check requests through this mock instead of live HTTPS.
    globalThis.fetch = async (url, init) => {
      fetchCalls += 1;
      return fetchImpl(url, init);
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

  test('1) createTuiHost integration: update.check, update.preferences snooze/clear, offline error', async () => {
    fetchCalls = 0;
    fetchImpl = async () =>
      makeMockReleaseResponse('9.9.9', 'Release 9.9.9\n• Improved study workflow');

    const checkRes = await host.call('update.check', { force: true });
    assert.equal(checkRes.ok, true, checkRes.error?.message);
    assert.equal(checkRes.value.newer, true);
    assert.equal(checkRes.value.latest, '9.9.9');
    assert.ok(String(checkRes.value.notes).includes('Improved study workflow'));
    assert.equal(fetchCalls, 1);

    const snoozeRes = await host.call('update.preferences', { snooze: '9.9.9' });
    assert.equal(snoozeRes.ok, true, snoozeRes.error?.message);
    assert.equal(snoozeRes.value.snoozed, true);

    const unsnoozeRes = await host.call('update.preferences', { snooze: null });
    assert.equal(unsnoozeRes.ok, true, unsnoozeRes.error?.message);
    assert.equal(unsnoozeRes.value.snoozed, false);

    // Offline / failing fetch fails soft with error: 'network'
    fetchImpl = async () => {
      throw new Error('ECONNREFUSED offline');
    };
    const offlineRes = await host.call('update.check', { force: true });
    assert.equal(offlineRes.ok, true, offlineRes.error?.message);
    assert.equal(offlineRes.value.error, 'network');
  });

  test('2) PTY E2E (120x36 zh): AppearanceTab capability readout + WorkspaceTab [A] update modal & [z] snooze', async () => {
    await rm(join(dshHome, 'study', 'update.json'), { force: true });
    fetchCalls = 0;
    fetchImpl = async () =>
      makeMockReleaseResponse('9.9.9', 'New in 9.9.9:\n• Faster FSRS review • Live capabilities readout');

    const tty = await mountApp({ initialPage: 'library', asciiMode: false, language: 'zh', cols: 120, rows: 36 });
    await tty.waitFor((s) => s.includes('学习库') || s.includes('Library'), {
      timeoutMs: 8_000,
      label: 'Initial Library view rendered (zh)',
    });

    // Navigate to Settings via ','
    tty.send(',');
    await tty.waitFor((s) => s.includes('模型配置') && s.includes('TUI 外观与偏好'), {
      timeoutMs: 8_000,
      label: 'SettingsView rendered via , (zh)',
    });

    // Switch to AppearanceTab ('4')
    tty.send('4');
    const appearanceScreen = await tty.waitFor(
      (s) =>
        s.includes('终端能力与运行诊断') &&
        s.includes(process.platform) &&
        /L[0-3]\)/.test(s) &&
        /\d+x\d+/.test(s) &&
        s.includes('SGR 1006:'),
      { timeoutMs: 8_000, label: 'AppearanceTab capability readout rendered (120x36 zh)' },
    );
    tty.assertHealthyScreen(appearanceScreen, 120, 36, 'AppearanceTab 120x36 zh');
    assert.equal(fetchCalls, 0, 'AppearanceTab must trigger 0 fetch calls');

    // Switch to WorkspaceTab ('2') and verify 0 fetch calls on mount
    tty.send('2');
    const wsScreen = await tty.waitFor(
      (s) => s.includes('自动检查更新:') && s.includes('[a] 切换') && s.includes('[A] 检查更新'),
      { timeoutMs: 8_000, label: 'WorkspaceTab [A] 检查更新 visible (120x36 zh)' },
    );
    tty.assertHealthyScreen(wsScreen, 120, 36, 'WorkspaceTab 120x36 zh');
    assert.equal(fetchCalls, 0, 'WorkspaceTab mount must trigger 0 fetch calls');

    // Press 'A' to open Release Update Modal and run forced check
    tty.send('A');
    const modalScreen = await tty.waitFor(
      (s) =>
        s.includes('检查版本更新') &&
        s.includes('v9.9.9') &&
        s.includes('发现新版本') &&
        s.includes('Faster FSRS review'),
      { timeoutMs: 8_000, label: 'Release Update Modal displays mocked v9.9.9 & notes (zh)' },
    );
    tty.assertHealthyScreen(modalScreen, 120, 36, 'ReleaseUpdateModal 120x36 zh');
    assert.equal(fetchCalls, 1, 'Pressing [A] must trigger update.check fetch once');

    // Press 'z' to snooze
    tty.send('z');
    const snoozedScreen = await tty.waitFor(
      (s) => s.includes('检查版本更新') && s.includes('已推迟提醒'),
      { timeoutMs: 8_000, label: 'Release Update Modal displays snoozed status after [z] (zh)' },
    );
    tty.assertHealthyScreen(snoozedScreen, 120, 36, 'ReleaseUpdateModal snoozed 120x36 zh');

    // Press Esc to close modal cleanly
    tty.send('\x1b');
    const closedScreen = await tty.waitFor(
      (s) => !s.includes('检查版本更新') && s.includes('[A] 检查更新'),
      { timeoutMs: 5_000, label: 'Release Update Modal closed via Esc (zh)' },
    );
    tty.assertHealthyScreen(closedScreen, 120, 36, 'WorkspaceTab after update modal close 120x36 zh');
  });

  test('3) PTY E2E (80x24 --ascii en): AppearanceTab pure ASCII + WorkspaceTab [A] graceful offline modal', async () => {
    await rm(join(dshHome, 'study', 'update.json'), { force: true });
    fetchCalls = 0;
    fetchImpl = async () => {
      throw new Error('offline network error');
    };

    const tty = await mountApp({ initialPage: 'library', asciiMode: true, language: 'en', cols: 80, rows: 24 });
    await tty.waitFor((s) => s.includes('Library') || s.includes('Courses'), {
      timeoutMs: 8_000,
      label: 'Initial Library view rendered (en --ascii)',
    });

    // Navigate to Settings via ','
    tty.send(',');
    await tty.waitFor((s) => s.includes('Models') && s.includes('Appearance'), {
      timeoutMs: 8_000,
      label: 'SettingsView rendered via , (en --ascii)',
    });

    // Switch to AppearanceTab ('4')
    tty.send('4');
    const appearanceScreen = await tty.waitFor(
      (s) =>
        s.includes(`Platform: ${process.platform}`) &&
        /L[0-3]\)/.test(s) &&
        s.includes('Render: ASCII') &&
        s.includes('SGR 1006:'),
      { timeoutMs: 8_000, label: 'AppearanceTab capability readout rendered (80x24 en --ascii)' },
    );
    tty.assertHealthyScreen(appearanceScreen, 80, 24, 'AppearanceTab 80x24 en --ascii');
    tty.assertAsciiPure(appearanceScreen, 'AppearanceTab 80x24 en --ascii');
    assert.equal(fetchCalls, 0, 'AppearanceTab must trigger 0 fetch calls');

    // Switch to WorkspaceTab ('2')
    tty.send('2');
    const wsScreen = await tty.waitFor(
      (s) => s.includes('Auto Update:') && s.includes('[a] Toggle') && s.includes('[A] Check now'),
      { timeoutMs: 8_000, label: 'WorkspaceTab [A] Check now visible (80x24 en --ascii)' },
    );
    tty.assertHealthyScreen(wsScreen, 80, 24, 'WorkspaceTab 80x24 en --ascii');
    tty.assertAsciiPure(wsScreen, 'WorkspaceTab 80x24 en --ascii');
    assert.equal(fetchCalls, 0, 'WorkspaceTab mount must trigger 0 fetch calls');

    // Press 'A' under mocked offline fetch
    tty.send('A');
    const offlineModalScreen = await tty.waitFor(
      (s) =>
        s.includes('Release Update Check') &&
        s.includes('Offline / Network error'),
      { timeoutMs: 8_000, label: 'Release Update Modal displays graceful offline status (80x24 en --ascii)' },
    );
    tty.assertHealthyScreen(offlineModalScreen, 80, 24, 'ReleaseUpdateModal offline 80x24 en --ascii');
    tty.assertAsciiPure(offlineModalScreen, 'ReleaseUpdateModal offline 80x24 en --ascii');
    assert.ok(fetchCalls >= 1, 'Pressing [A] should attempt fetch');

    // Close modal cleanly with Esc
    tty.send('\x1b');
    const closedScreen = await tty.waitFor(
      (s) => !s.includes('Release Update Check') && s.includes('[A] Check now'),
      { timeoutMs: 5_000, label: 'Release Update Modal closed via Esc (80x24 en --ascii)' },
    );
    tty.assertHealthyScreen(closedScreen, 80, 24, 'WorkspaceTab after offline modal close 80x24 en --ascii');
    tty.assertAsciiPure(closedScreen, 'WorkspaceTab after offline modal close 80x24 en --ascii');
  });
});
