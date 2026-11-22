// Round 45 ReaderOutlineDrawer [X] clear & WorkspaceTab [a] update.preferences host + PTY E2E tests:
// `node --test tests/round45-outline-update.test.mjs`
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
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('store-') || f.startsWith('chunk-')) {
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
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round45-${label}-`));
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

describe('Round 45: ReaderOutlineDrawer [X] clear & WorkspaceTab [a] update.preferences', () => {
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

  async function mountApp({ initialPage = 'sources', asciiMode = false, language = 'zh', cols = 120, rows = 36 } = {}) {
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
        throw new Error('Network call must not happen during Round 45 tests');
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

  test('1) createTuiHost integration: materials.outline.save -> clear & update.preferences autoCheck toggle (0 network calls)', async () => {
    const docPath = join(boxDir, 'r45-host-outline.md');
    await writeFile(
      docPath,
      [
        '# Heading One Alpha',
        '',
        'First section details for Round 45 outline clear verification.',
        '',
        '# Heading Two Beta',
        '',
        'Second section details for Round 45 outline clear verification.',
        '',
      ].join('\n'),
      'utf8',
    );

    const imp = await host.call('materials.document.import', {
      path: docPath,
      title: 'R45 Host Outline Doc',
      format: 'md',
    });
    assert.equal(imp.ok, true, `import failed: ${imp.error?.message || ''}`);
    const docId = imp.value.documentId;
    const rev = imp.value.revision;

    const saved = await host.call('materials.outline.save', {
      documentId: docId,
      revision: rev,
      mode: 'chapters',
      entries: [
        { title: 'Saved AI Chapter 1', level: 1, startBlock: 0 },
        { title: 'Saved AI Chapter 2', level: 1, startBlock: 2 },
      ],
    });
    assert.equal(saved.ok, true, `outline.save failed: ${saved.error?.message || ''}`);
    assert.equal(saved.value.saved, true);
    assert.equal(saved.value.outline?.entries?.length, 2);

    const docBefore = await host.call('materials.document.get', { documentId: docId, revision: rev });
    assert.equal(docBefore.ok, true);
    assert.equal(docBefore.value.outline?.entries?.length, 2);
    assert.equal(docBefore.value.outline?.entries?.[0]?.title, 'Saved AI Chapter 1');

    const cleared = await host.call('materials.outline.clear', { documentId: docId, revision: rev });
    assert.equal(cleared.ok, true, `outline.clear failed: ${cleared.error?.message || ''}`);
    assert.equal(cleared.value.cleared, true);
    assert.equal(cleared.value.hadSegmentation, false);

    const clearedAgain = await host.call('materials.outline.clear', { documentId: docId, revision: rev });
    assert.equal(clearedAgain.ok, true);
    assert.equal(clearedAgain.value.cleared, false);

    const docAfter = await host.call('materials.document.get', { documentId: docId, revision: rev });
    assert.equal(docAfter.ok, true);
    assert.equal(docAfter.value.outline, undefined);

    // update.preferences { autoCheck: false } -> { autoCheck: true } (0 network calls)
    const prefInit = await host.call('update.preferences', {});
    assert.equal(prefInit.ok, true, `update.preferences read failed: ${prefInit.error?.message || ''}`);
    assert.equal(prefInit.value.autoCheck, true);

    const prefOff = await host.call('update.preferences', { autoCheck: false });
    assert.equal(prefOff.ok, true, `update.preferences false failed: ${prefOff.error?.message || ''}`);
    assert.equal(prefOff.value.autoCheck, false);

    const prefReadOff = await host.call('update.preferences', {});
    assert.equal(prefReadOff.ok, true);
    assert.equal(prefReadOff.value.autoCheck, false);

    const prefOn = await host.call('update.preferences', { autoCheck: true });
    assert.equal(prefOn.ok, true, `update.preferences true failed: ${prefOn.error?.message || ''}`);
    assert.equal(prefOn.value.autoCheck, true);

    assert.equal(fetchCalls, 0, 'update.preferences and outline operations must trigger 0 network calls');
  });

  test('2) PTY E2E: ReaderOutlineDrawer [X] ConfirmDialog cancel/confirm & WorkspaceTab [a] toggle at 120x36 & 80x24 (zh & --ascii en)', async () => {
    const e2ePath = join(boxDir, 'r45-e2e-outline.md');
    await writeFile(
      e2ePath,
      [
        '# Fallback Alpha',
        '',
        'Alpha body paragraph for Round 45 reader outline verification.',
        '',
        '# Fallback Beta',
        '',
        'Beta body paragraph for Round 45 reader outline verification.',
        '',
      ].join('\n'),
      'utf8',
    );
    const imp = await host.call('materials.document.import', {
      path: e2ePath,
      title: 'R45 E2E Outline Doc',
      format: 'md',
    });
    assert.equal(imp.ok, true, `import e2e doc failed: ${imp.error?.message || ''}`);
    const docId = imp.value.documentId;
    const rev = imp.value.revision;

    const saveOutline = async () => {
      const res = await host.call('materials.outline.save', {
        documentId: docId,
        revision: rev,
        mode: 'chapters',
        entries: [
          { title: 'Custom Chapter One', level: 1, startBlock: 0 },
          { title: 'Custom Chapter Two', level: 1, startBlock: 2 },
        ],
      });
      assert.equal(res.ok, true, `saveOutline failed: ${res.error?.message || ''}`);
    };

    // 2a) Default zh mode across 120x36 & 80x24
    await saveOutline();
    await host.call('update.preferences', { autoCheck: true });

    const ttyZh = await mountApp({ initialPage: 'sources', asciiMode: false, language: 'zh', cols: 120, rows: 36 });
    await ttyZh.waitFor(
      (s) => s.includes('R45 E2E Outline Doc') && !s.includes('正在加载页面'),
      { timeoutMs: 10_000, label: 'SourcesView rendered (zh)' },
    );

    ttyZh.send('/');
    await ttyZh.waitFor((s) => s.includes('搜索') || s.includes('Search'), { label: 'Sources filter bar (zh)' });
    ttyZh.send('R45 E2E Outline');
    await ttyZh.waitFor((s) => s.includes('R45 E2E Outline'), { label: 'Filter typed (zh)' });
    ttyZh.send('\r');
    await ttyZh.waitFor(
      (s) => s.includes('R45 E2E Outline Doc') && s.includes('MD'),
      { timeoutMs: 5_000, label: 'R45 E2E Outline Doc selected (zh)' },
    );

    // Open DocumentReader -> ReaderOutlineDrawer ('O')
    ttyZh.send('\r');
    await ttyZh.waitFor(
      (s) => s.includes('R45 E2E Outline Doc') && s.includes('Alpha body paragraph') && s.includes('O  目录'),
      { timeoutMs: 10_000, label: 'DocumentReader opened (zh)' },
    );
    await sleep(50);

    ttyZh.send('O');
    const outlineZh = await ttyZh.waitFor(
      (s) => s.includes('文档目录大纲') && s.includes('Custom Chapter One') && s.includes('AI 目录'),
      { timeoutMs: 8_000, label: 'ReaderOutlineDrawer opened with AI outline (zh)' },
    );
    ttyZh.assertHealthyScreen(outlineZh, 120, 36, 'ReaderOutlineDrawer 120x36 zh');

    // Press uppercase 'X' -> ConfirmDialog opens, then cancel with 'n'
    ttyZh.send('X');
    const clearConfirmZh = await ttyZh.waitFor(
      (s) => s.includes('清除自定义 AI 目录') && s.includes('清除目录'),
      { timeoutMs: 5_000, label: 'ReaderOutlineDrawer clear ConfirmDialog (zh)' },
    );
    ttyZh.assertHealthyScreen(clearConfirmZh, 120, 36, 'Outline clear ConfirmDialog 120x36 zh');

    ttyZh.send('n');
    await ttyZh.waitFor(
      (s) => !s.includes('清除自定义 AI 目录') && s.includes('Custom Chapter One'),
      { timeoutMs: 5_000, label: 'Outline clear ConfirmDialog cancelled (zh)' },
    );

    // Resize to 80x24 and confirm clear with 'X' -> 'y'
    ttyZh.resize(80, 24);
    const outlineZhNarrow = await ttyZh.waitFor(
      (s) => s.includes('Custom Chapter One') && s.split('\n').length <= 24,
      { timeoutMs: 5_000, label: 'ReaderOutlineDrawer resized 80x24 (zh)' },
    );
    ttyZh.assertHealthyScreen(outlineZhNarrow, 80, 24, 'ReaderOutlineDrawer 80x24 zh');

    ttyZh.send('X');
    const clearConfirmZhNarrow = await ttyZh.waitFor(
      (s) => s.includes('清除自定义 AI 目录') && s.split('\n').length <= 24,
      { timeoutMs: 5_000, label: 'ReaderOutlineDrawer clear ConfirmDialog 80x24 (zh)' },
    );
    ttyZh.assertHealthyScreen(clearConfirmZhNarrow, 80, 24, 'Outline clear ConfirmDialog 80x24 zh');

    ttyZh.send('y');
    const afterClearZh = await ttyZh.waitFor(
      (s) =>
        !s.includes('清除目录') &&
        s.includes('Fallback Alpha') &&
        s.includes('标题提取') &&
        s.includes('已清除自定义 AI 目录'),
      { timeoutMs: 8_000, label: 'Outline cleared and reverted to headings (zh)' },
    );
    ttyZh.assertHealthyScreen(afterClearZh, 80, 24, 'ReaderOutlineDrawer after clear 80x24 zh');

    const docAfterZhClear = await host.call('materials.document.get', { documentId: docId, revision: rev });
    assert.equal(docAfterZhClear.value?.outline, undefined);

    // Close drawer -> close reader -> switch to Settings (',') -> WorkspaceTab ('2')
    ttyZh.send('\x1b');
    await ttyZh.waitFor((s) => !s.includes('文档目录大纲'), { label: 'Outline drawer closed (zh)' });
    ttyZh.send('\x1b');
    await ttyZh.waitFor((s) => s.includes('资料列表'), { label: 'Reader closed (zh)' });

    ttyZh.send(',');
    await ttyZh.waitFor((s) => s.includes('模型配置') && s.includes('工作区'), { label: 'SettingsView (zh)' });
    ttyZh.send('2');
    const wsZhNarrow = await ttyZh.waitFor(
      (s) => s.includes('自动检查更新:') && s.includes('已开启 ✓') && s.includes('[a]'),
      { timeoutMs: 8_000, label: 'WorkspaceTab 80x24 (zh)' },
    );
    ttyZh.assertHealthyScreen(wsZhNarrow, 80, 24, 'WorkspaceTab 80x24 zh');

    // Toggle [a] off at 80x24 -> on at 120x36
    ttyZh.send('a');
    const wsZhOff = await ttyZh.waitFor(
      (s) => s.includes('自动检查更新:') && s.includes('已关闭') && s.includes('已关闭自动检查更新'),
      { timeoutMs: 5_000, label: 'Auto update toggled off (zh)' },
    );
    ttyZh.assertHealthyScreen(wsZhOff, 80, 24, 'WorkspaceTab autoCheck off 80x24 zh');
    assert.equal((await host.call('update.preferences', {})).value?.autoCheck, false);

    ttyZh.resize(120, 36);
    await ttyZh.waitFor((s) => s.includes('自动检查更新:') && s.includes('已关闭'), { label: 'WorkspaceTab 120x36 (zh)' });
    ttyZh.send('a');
    const wsZhOn = await ttyZh.waitFor(
      (s) => s.includes('自动检查更新:') && s.includes('已开启 ✓') && s.includes('已开启自动检查更新'),
      { timeoutMs: 5_000, label: 'Auto update toggled on (zh)' },
    );
    ttyZh.assertHealthyScreen(wsZhOn, 120, 36, 'WorkspaceTab autoCheck on 120x36 zh');
    assert.equal((await host.call('update.preferences', {})).value?.autoCheck, true);

    // 2b) --ascii en mode across 120x36 & 80x24
    await saveOutline();
    await host.call('update.preferences', { autoCheck: true });

    const ttyEn = await mountApp({ initialPage: 'sources', asciiMode: true, language: 'en', cols: 120, rows: 36 });
    await ttyEn.waitFor(
      (s) => s.includes('R45 E2E Outline Doc') && !s.includes('Loading view'),
      { timeoutMs: 10_000, label: 'SourcesView rendered (en --ascii)' },
    );

    ttyEn.send('/');
    await ttyEn.waitFor((s) => s.includes('Filter: Title') || s.includes('Search'), { label: 'Sources filter bar (en --ascii)' });
    ttyEn.send('R45 E2E Outline');
    await ttyEn.waitFor((s) => s.includes('R45 E2E Outline'), { label: 'Filter typed (en --ascii)' });
    ttyEn.send('\r');
    await ttyEn.waitFor(
      (s) => s.includes('R45 E2E Outline Doc') && s.includes('MD'),
      { timeoutMs: 5_000, label: 'R45 E2E Outline Doc selected (en --ascii)' },
    );

    ttyEn.send('\r');
    await ttyEn.waitFor(
      (s) => s.includes('R45 E2E Outline Doc') && s.includes('Alpha body paragraph') && s.includes('O  TOC'),
      { timeoutMs: 10_000, label: 'DocumentReader opened (en --ascii)' },
    );
    await sleep(50);

    ttyEn.send('O');
    const outlineEn = await ttyEn.waitFor(
      (s) => s.includes('Document Outline') && s.includes('Custom Chapter One') && s.includes('AI Outline'),
      { timeoutMs: 8_000, label: 'ReaderOutlineDrawer opened (en --ascii)' },
    );
    ttyEn.assertHealthyScreen(outlineEn, 120, 36, 'ReaderOutlineDrawer 120x36 en --ascii');
    ttyEn.assertAsciiPure(outlineEn, 'ReaderOutlineDrawer 120x36 en --ascii');

    ttyEn.send('X');
    const clearConfirmEn = await ttyEn.waitFor(
      (s) => s.includes('Clear Custom AI Outline') && s.includes('Clear Outline'),
      { timeoutMs: 5_000, label: 'ReaderOutlineDrawer clear ConfirmDialog (en --ascii)' },
    );
    ttyEn.assertHealthyScreen(clearConfirmEn, 120, 36, 'Outline clear ConfirmDialog 120x36 en --ascii');
    ttyEn.assertAsciiPure(clearConfirmEn, 'Outline clear ConfirmDialog 120x36 en --ascii');

    // Cancel via Esc -> outline intact
    ttyEn.send('\x1b');
    await ttyEn.waitFor(
      (s) => !s.includes('Clear Custom AI Outline') && s.includes('Custom Chapter One'),
      { timeoutMs: 5_000, label: 'Outline clear ConfirmDialog cancelled via Esc (en --ascii)' },
    );

    // Confirm via X -> y
    ttyEn.send('X');
    await ttyEn.waitFor((s) => s.includes('Clear Custom AI Outline'), { label: 'Outline clear ConfirmDialog reopened (en --ascii)' });
    ttyEn.send('y');
    const afterClearEn = await ttyEn.waitFor(
      (s) =>
        !s.includes('Clear Custom AI Outline') &&
        s.includes('Fallback Alpha') &&
        s.includes('Headings') &&
        s.includes('Custom outline cleared'),
      { timeoutMs: 8_000, label: 'Outline cleared (en --ascii)' },
    );
    ttyEn.assertHealthyScreen(afterClearEn, 120, 36, 'ReaderOutlineDrawer after clear 120x36 en --ascii');
    ttyEn.assertAsciiPure(afterClearEn, 'ReaderOutlineDrawer after clear 120x36 en --ascii');

    ttyEn.send('\x1b');
    await ttyEn.waitFor((s) => !s.includes('Document Outline'), { label: 'Outline drawer closed (en --ascii)' });
    ttyEn.send('\x1b');
    await ttyEn.waitFor((s) => s.includes('Materials'), { label: 'Reader closed (en --ascii)' });

    ttyEn.send(',');
    await ttyEn.waitFor((s) => s.includes('Models') && s.includes('Workspace'), { label: 'SettingsView (en --ascii)' });
    ttyEn.send('2');
    const wsEnWide = await ttyEn.waitFor(
      (s) => s.includes('Auto Update:') && s.includes('On +') && s.includes('[a] Toggle'),
      { timeoutMs: 8_000, label: 'WorkspaceTab 120x36 (en --ascii)' },
    );
    ttyEn.assertHealthyScreen(wsEnWide, 120, 36, 'WorkspaceTab 120x36 en --ascii');
    ttyEn.assertAsciiPure(wsEnWide, 'WorkspaceTab 120x36 en --ascii');

    ttyEn.send('a');
    const wsEnOff = await ttyEn.waitFor(
      (s) => s.includes('Auto Update:') && s.includes('Off') && s.includes('Auto update check disabled'),
      { timeoutMs: 5_000, label: 'Auto update toggled off (en --ascii)' },
    );
    ttyEn.assertHealthyScreen(wsEnOff, 120, 36, 'WorkspaceTab autoCheck off 120x36 en --ascii');
    ttyEn.assertAsciiPure(wsEnOff, 'WorkspaceTab autoCheck off 120x36 en --ascii');

    ttyEn.resize(80, 24);
    const wsEnNarrow = await ttyEn.waitFor(
      (s) => s.includes('Auto Update:') && s.includes('Off') && s.split('\n').length <= 24,
      { timeoutMs: 5_000, label: 'WorkspaceTab 80x24 (en --ascii)' },
    );
    ttyEn.assertHealthyScreen(wsEnNarrow, 80, 24, 'WorkspaceTab 80x24 en --ascii');
    ttyEn.assertAsciiPure(wsEnNarrow, 'WorkspaceTab 80x24 en --ascii');

    assert.equal(fetchCalls, 0, 'PTY E2E must trigger 0 network calls');
  });
});
