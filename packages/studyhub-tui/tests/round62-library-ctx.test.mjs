// Round 62 Track 2: WorkspaceTab Library Context Overview & JSON Export (`library.context`, `[L]`) tests:
// `node --test tests/round62-library-ctx.test.mjs`
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
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round62-ctx-${label}-`));
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

describe('Round 62 Track 2: WorkspaceTab Library Context Overview & JSON Export', () => {
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

  test('1) createTuiHost integration: load sample course -> call library.context {} -> verify counts, courses, areas, today, focus (0 model calls)', async () => {
    fetchCalls = 0;

    const loadRes = await host.call('sample.load', { language: 'zh' });
    assert.equal(loadRes.ok, true, loadRes.error?.message);

    const ctxRes = await host.call('library.context', {});
    assert.equal(ctxRes.ok, true, ctxRes.error?.message);
    const ctx = ctxRes.value;

    assert.equal(ctx.library, libraryRoot);
    assert.match(ctx.today, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(typeof ctx.timeZone === 'string' && ctx.timeZone.length > 0);
    assert.ok(ctx.focus && typeof ctx.focus.mode === 'string');
    assert.ok(typeof ctx.focus.course === 'string' && ctx.focus.course.length > 0, 'expected sample course in focus.course');
    assert.equal(typeof ctx.focus.role, 'string');

    assert.ok(ctx.counts.sources >= 1, `expected >= 1 source, got ${ctx.counts.sources}`);
    assert.ok(ctx.counts.decks >= 1, `expected >= 1 deck, got ${ctx.counts.decks}`);
    assert.equal(typeof ctx.counts.archivedDecks, 'number');
    assert.equal(typeof ctx.counts.drafts, 'number');
    assert.ok(ctx.counts.cards >= 1, `expected >= 1 card, got ${ctx.counts.cards}`);

    assert.ok(Array.isArray(ctx.courses) && ctx.courses.length >= 1, 'expected courses array');
    assert.ok(ctx.courses.includes(ctx.focus.course), 'expected focus course in courses list');
    assert.equal(typeof ctx.coursesPage?.total, 'number');
    assert.ok(Array.isArray(ctx.areas) && ctx.areas.length >= 1, 'expected areas array');
    assert.equal(fetchCalls, 0, 'library.context must make 0 model/network calls');
  });

  test('2) PTY E2E (120x36 zh): Settings -> WorkspaceTab -> [L] LibraryContextModal -> [r] refresh -> [e] export JSON -> Esc', async () => {
    fetchCalls = 0;

    const ctxRes = await host.call('library.context', {});
    assert.equal(ctxRes.ok, true, ctxRes.error?.message);
    const expectedCtx = ctxRes.value;

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
      (s) => s.includes('当前学习库:') && s.includes('[L] 上下文'),
      { timeoutMs: 8_000, label: 'WorkspaceTab [L] 上下文 visible (120x36 zh)' },
    );
    tty.assertHealthyScreen(wsScreen, 120, 36, 'WorkspaceTab 120x36 zh');
    assert.equal(fetchCalls, 0, 'WorkspaceTab mount must trigger 0 fetch calls');

    // Open LibraryContextModal via 'L'
    tty.send('L');
    const modalScreen = await tty.waitFor(
      (s) =>
        s.includes('学习库上下文总览') &&
        s.includes(`资料 ${expectedCtx.counts.sources}`) &&
        s.includes(`题组 ${expectedCtx.counts.decks}`) &&
        s.includes(`卡片 ${expectedCtx.counts.cards}`) &&
        s.includes(expectedCtx.focus.course),
      { timeoutMs: 8_000, label: 'LibraryContextModal shows counts, focus course & courses list (120x36 zh)' },
    );
    tty.assertHealthyScreen(modalScreen, 120, 36, 'LibraryContextModal 120x36 zh');

    // Refresh via 'r'
    tty.send('r');
    const refreshedScreen = await tty.waitFor(
      (s) => s.includes('学习库上下文总览') && s.includes('可用上下文域:') && s.includes(expectedCtx.today),
      { timeoutMs: 8_000, label: 'LibraryContextModal refreshed via [r] (zh)' },
    );
    tty.assertHealthyScreen(refreshedScreen, 120, 36, 'LibraryContextModal refreshed 120x36 zh');

    // Export JSON via 'e' and verify file on disk
    const expectedPath = join(libraryRoot, 'backups', `studyhub-context-${todayLocalYmd()}.json`);
    await rm(expectedPath, { force: true });
    tty.send('e');
    const exportedScreen = await tty.waitFor(
      (s) => s.includes('studyhub-context-') && s.includes('已导出'),
      { timeoutMs: 8_000, label: 'LibraryContextModal confirms JSON export after [e] (zh)' },
    );
    tty.assertHealthyScreen(exportedScreen, 120, 36, 'LibraryContextModal exported 120x36 zh');

    const rawExported = await readFile(expectedPath, 'utf8');
    const exportedJson = JSON.parse(rawExported);
    assert.equal(exportedJson.library, libraryRoot);
    assert.equal(exportedJson.today, expectedCtx.today);
    assert.equal(exportedJson.counts.sources, expectedCtx.counts.sources);
    assert.equal(exportedJson.counts.decks, expectedCtx.counts.decks);
    assert.equal(exportedJson.counts.cards, expectedCtx.counts.cards);
    assert.equal(exportedJson.focus.course, expectedCtx.focus.course);
    assert.deepEqual(exportedJson.areas, expectedCtx.areas);

    // Close modal cleanly with Esc
    tty.send('\x1b');
    const closedScreen = await tty.waitFor(
      (s) => !s.includes('学习库上下文总览') && s.includes('[L] 上下文'),
      { timeoutMs: 5_000, label: 'LibraryContextModal closed via Esc (zh)' },
    );
    tty.assertHealthyScreen(closedScreen, 120, 36, 'WorkspaceTab after library context close 120x36 zh');
    assert.equal(fetchCalls, 0);
  });

  test('3) PTY E2E (80x24 --ascii en): Settings -> WorkspaceTab -> [L] LibraryContextModal pure ASCII -> Esc close', async () => {
    fetchCalls = 0;

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
      (s) => s.includes('Current Root:') && s.includes('[L] Context'),
      { timeoutMs: 8_000, label: 'WorkspaceTab [L] Context visible (80x24 en --ascii)' },
    );
    tty.assertHealthyScreen(wsScreen, 80, 24, 'WorkspaceTab 80x24 en --ascii');
    tty.assertAsciiPure(wsScreen, 'WorkspaceTab 80x24 en --ascii');

    // Open LibraryContextModal via 'L'
    tty.send('L');
    const modalScreen = await tty.waitFor(
      (s) =>
        s.includes('Library Context Overview') &&
        s.includes('Sources ') &&
        s.includes('Decks ') &&
        s.includes('Areas:'),
      { timeoutMs: 8_000, label: 'LibraryContextModal rendered (80x24 en --ascii)' },
    );
    tty.assertHealthyScreen(modalScreen, 80, 24, 'LibraryContextModal 80x24 en --ascii');
    tty.assertAsciiPure(modalScreen, 'LibraryContextModal 80x24 en --ascii');

    // Close modal cleanly with Esc
    tty.send('\x1b');
    const closedScreen = await tty.waitFor(
      (s) => !s.includes('Library Context Overview') && s.includes('[L] Context'),
      { timeoutMs: 5_000, label: 'LibraryContextModal closed via Esc (80x24 en --ascii)' },
    );
    tty.assertHealthyScreen(closedScreen, 80, 24, 'WorkspaceTab after library context close 80x24 en --ascii');
    tty.assertAsciiPure(closedScreen, 'WorkspaceTab after library context close 80x24 en --ascii');
    assert.equal(fetchCalls, 0);
  });
});
