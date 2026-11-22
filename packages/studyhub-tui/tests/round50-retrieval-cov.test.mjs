// Round 50 WorkspaceTab Semantic Retrieval Index Coverage & Provider Switch tests:
// `node --test tests/round50-retrieval-cov.test.mjs`
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round50-ret-${label}-`));
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

describe('Round 50: WorkspaceTab Retrieval Index Coverage, Provider Switch & HelpOverlay Sync', () => {
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

  async function mountApp({ initialPage = 'settings', asciiMode = false, language = 'zh', cols = 120, rows = 36 } = {}) {
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
        throw new Error('Network/model call must not happen during Round 50 retrieval coverage tests');
      },
    });
  });

  after(async () => {
    if (disposed) return;
    disposed = true;
    try {
      await unmountActiveApp();
      await host?.dispose();
    } finally {
      if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = PREV_DSH_HOME;
      await Promise.all(
        tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
      );
    }
  });

  test('1) createTuiHost integration: retrieval.index.coverage & retrieval.set builtin (0 model calls)', async () => {
    const emptyCov = await host.call('retrieval.index.coverage', {});
    assert.equal(emptyCov.ok, true, emptyCov.error?.message);
    assert.deepEqual(emptyCov.value.indexed, []);
    assert.deepEqual(emptyCov.value.stale, []);
    assert.deepEqual(emptyCov.value.missing, []);
    assert.equal(emptyCov.value.hasIndex, false);
    assert.equal(typeof emptyCov.value.canIndex, 'boolean');
    assert.equal(Boolean(emptyCov.value.building), false);

    // Seed two markdown materials
    for (let i = 1; i <= 2; i += 1) {
      const mdPath = join(boxDir, `r50-retrieval-${i}.md`);
      await writeFile(
        mdPath,
        `# Topic ${i}\n\nRetrieval coverage test material page ${i} with enough body text.\n`,
        'utf8',
      );
      const imp = await host.call('materials.document.import', {
        path: mdPath,
        title: `R50 Material ${i}`,
        format: 'md',
      });
      assert.equal(imp.ok, true, imp.error?.message);
    }

    const snap = await host.call('snapshot');
    assert.equal(snap.ok, true);
    const seededCount = snap.value.sources.length;
    assert.ok(seededCount >= 2, `expected >= 2 seeded sources, got ${seededCount}`);

    const seededCov = await host.call('retrieval.index.coverage', {});
    assert.equal(seededCov.ok, true, seededCov.error?.message);
    assert.equal(seededCov.value.indexed.length, 0);
    assert.equal(seededCov.value.stale.length, 0);
    assert.equal(seededCov.value.missing.length, seededCount);
    assert.equal(seededCov.value.hasIndex, false);
    assert.equal(typeof seededCov.value.canIndex, 'boolean');
    assert.equal(Boolean(seededCov.value.building), false);

    const setRes = await host.call('retrieval.set', { provider: 'builtin' });
    assert.equal(setRes.ok, true, setRes.error?.message);
    assert.equal(setRes.value.selected, 'builtin');
    assert.equal(setRes.value.effective, 'builtin');

    assert.equal(fetchCalls, 0, 'retrieval.index.coverage and retrieval.set must trigger 0 model/network calls');
  });

  test('2) PTY E2E: WorkspaceTab coverage + [v] provider cycle & HelpOverlay Round 50 sync at 120x36 & 80x24 (zh & --ascii en)', async () => {
    const snap = await host.call('snapshot');
    const totalSources = snap.value.sources.length;
    assert.ok(totalSources >= 2);

    // 2a) Default zh mode across 120x36 & 80x24
    const ttyZh = await mountApp({ initialPage: 'settings', asciiMode: false, language: 'zh', cols: 120, rows: 36 });
    await ttyZh.waitFor((s) => s.includes('模型配置') && s.includes('工作区'), {
      label: 'SettingsView rendered (zh)',
    });

    ttyZh.send('2');
    const wsZhWide = await ttyZh.waitFor(
      (s) =>
        s.includes('语义检索:') &&
        s.includes(`索引 0/${totalSources}`) &&
        s.includes('[v] 切换'),
      { timeoutMs: 8_000, label: 'WorkspaceTab retrieval coverage & [v] 120x36 (zh)' },
    );
    ttyZh.assertHealthyScreen(wsZhWide, 120, 36, 'WorkspaceTab retrieval 120x36 zh');

    // Press 'v' to confirm/cycle retrieval provider
    ttyZh.send('v');
    const wsZhAfterV = await ttyZh.waitFor(
      (s) => s.includes('当前仅检测到内置检索 (builtin)'),
      { timeoutMs: 5_000, label: 'WorkspaceTab [v] toast (zh)' },
    );
    ttyZh.assertHealthyScreen(wsZhAfterV, 120, 36, 'WorkspaceTab after [v] 120x36 zh');

    // Resize to 80x24 and verify compact row fits cleanly
    ttyZh.resize(80, 24);
    const wsZhNarrow = await ttyZh.waitFor(
      (s) =>
        s.includes('语义检索:') &&
        s.includes(`索引 0/${totalSources}`) &&
        s.includes('[v] 切换') &&
        s.split('\n').length <= 24,
      { timeoutMs: 5_000, label: 'WorkspaceTab retrieval coverage 80x24 (zh)' },
    );
    ttyZh.assertHealthyScreen(wsZhNarrow, 80, 24, 'WorkspaceTab retrieval 80x24 zh');

    // Open HelpOverlay ('?') and verify Round 50 entries across scroll positions
    ttyZh.resize(120, 36);
    await ttyZh.waitFor((s) => s.includes('语义检索:'), { label: 'WorkspaceTab restored 120x36 (zh)' });
    ttyZh.send('?');
    await ttyZh.waitFor((s) => s.includes('快捷键'), { label: 'HelpOverlay opened (zh)' });
    let sawSkelZh = false;
    let sawOrigZh = false;
    for (let step = 0; step < 12 && (!sawSkelZh || !sawOrigZh); step += 1) {
      ttyZh.send('\x04'); // Ctrl+D half-page scroll down
      await ttyZh.flush();
      const scr = ttyZh.readScreen();
      ttyZh.assertHealthyScreen(scr, 120, 36, `HelpOverlay scroll ${step} zh`);
      if (scr.includes('骨架互动图')) sawSkelZh = true;
      if (scr.includes('原始文件 / 目录大纲')) sawOrigZh = true;
    }
    assert.ok(sawSkelZh, 'HelpOverlay (zh) must include 骨架互动图');
    assert.ok(sawOrigZh, 'HelpOverlay (zh) must include 原始文件 / 目录大纲');
    ttyZh.send('G');
    const helpZhBottom = await ttyZh.waitFor(
      (s) => s.includes('切换语义检索提供方'),
      { timeoutMs: 5_000, label: 'HelpOverlay Round 50 Settings entry visible (zh)' },
    );
    ttyZh.assertHealthyScreen(helpZhBottom, 120, 36, 'HelpOverlay Round 50 entries zh');
    ttyZh.send('\x1b');
    await ttyZh.waitFor((s) => !s.includes('切换语义检索提供方'), { label: 'HelpOverlay closed (zh)' });

    // 2b) --ascii en mode across 120x36 & 80x24
    const ttyEn = await mountApp({ initialPage: 'settings', asciiMode: true, language: 'en', cols: 120, rows: 36 });
    await ttyEn.waitFor((s) => s.includes('Models') && s.includes('Workspace'), {
      label: 'SettingsView rendered (en --ascii)',
    });

    ttyEn.send('2');
    const wsEnWide = await ttyEn.waitFor(
      (s) =>
        s.includes('Retrieval:') &&
        s.includes(`Idx 0/${totalSources}`) &&
        s.includes('[v] Switch'),
      { timeoutMs: 8_000, label: 'WorkspaceTab retrieval coverage & [v] 120x36 (en --ascii)' },
    );
    ttyEn.assertHealthyScreen(wsEnWide, 120, 36, 'WorkspaceTab retrieval 120x36 en --ascii');
    ttyEn.assertAsciiPure(wsEnWide, 'WorkspaceTab retrieval 120x36 en --ascii');

    ttyEn.send('v');
    const wsEnAfterV = await ttyEn.waitFor(
      (s) => s.includes('Only built-in retrieval is'),
      { timeoutMs: 5_000, label: 'WorkspaceTab [v] toast (en --ascii)' },
    );
    ttyEn.assertHealthyScreen(wsEnAfterV, 120, 36, 'WorkspaceTab after [v] 120x36 en --ascii');
    ttyEn.assertAsciiPure(wsEnAfterV, 'WorkspaceTab after [v] 120x36 en --ascii');

    ttyEn.resize(80, 24);
    const wsEnNarrow = await ttyEn.waitFor(
      (s) =>
        s.includes('Retrieval:') &&
        s.includes(`Idx 0/${totalSources}`) &&
        s.includes('[v] Switch') &&
        s.split('\n').length <= 24,
      { timeoutMs: 5_000, label: 'WorkspaceTab retrieval coverage 80x24 (en --ascii)' },
    );
    ttyEn.assertHealthyScreen(wsEnNarrow, 80, 24, 'WorkspaceTab retrieval 80x24 en --ascii');
    ttyEn.assertAsciiPure(wsEnNarrow, 'WorkspaceTab retrieval 80x24 en --ascii');

    // Open HelpOverlay ('?') in --ascii en mode and check Round 50 entries + pure ASCII
    ttyEn.resize(120, 36);
    await ttyEn.waitFor((s) => s.includes('Retrieval:'), { label: 'WorkspaceTab restored 120x36 (en --ascii)' });
    ttyEn.send('?');
    await ttyEn.waitFor((s) => s.includes('Keyboard Shortcuts'), { label: 'HelpOverlay opened (en --ascii)' });
    let sawSkelEn = false;
    let sawOrigEn = false;
    for (let step = 0; step < 12 && (!sawSkelEn || !sawOrigEn); step += 1) {
      ttyEn.send('\x04'); // Ctrl+D half-page scroll down
      await ttyEn.flush();
      const scr = ttyEn.readScreen();
      ttyEn.assertHealthyScreen(scr, 120, 36, `HelpOverlay scroll ${step} en --ascii`);
      ttyEn.assertAsciiPure(scr, `HelpOverlay scroll ${step} en --ascii`);
      if (scr.includes('Skeleton diagrams')) sawSkelEn = true;
      if (scr.includes('Original file / Outline TOC')) sawOrigEn = true;
    }
    assert.ok(sawSkelEn, 'HelpOverlay (en --ascii) must include Skeleton diagrams');
    assert.ok(sawOrigEn, 'HelpOverlay (en --ascii) must include Original file / Outline TOC');
    ttyEn.send('G');
    const helpEnBottom = await ttyEn.waitFor(
      (s) => s.includes('Cycle retrieval provider'),
      { timeoutMs: 5_000, label: 'HelpOverlay Round 50 Settings entry visible (en --ascii)' },
    );
    ttyEn.assertHealthyScreen(helpEnBottom, 120, 36, 'HelpOverlay Round 50 entries en --ascii');
    ttyEn.assertAsciiPure(helpEnBottom, 'HelpOverlay Round 50 entries en --ascii');

    assert.equal(fetchCalls, 0, 'PTY E2E must trigger 0 network/model calls');
  });
});
