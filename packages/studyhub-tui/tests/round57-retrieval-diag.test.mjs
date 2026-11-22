// Round 57 WorkspaceTab Retrieval Index Planner & Connectivity Diagnostics tests:
// `node --test tests/round57-retrieval-diag.test.mjs`
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
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round57-diag-${label}-`));
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

describe('Round 57: WorkspaceTab Retrieval Index Planner & Connectivity Diagnostics', () => {
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
        throw new Error('Network/model call must not happen during Round 57 retrieval diagnostics tests');
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

  test('1) createTuiHost integration: retrieval.index.plan & retrieval.test builtin (0 model calls)', async () => {
    for (let i = 1; i <= 2; i += 1) {
      const mdPath = join(boxDir, `r57-diag-${i}.md`);
      await writeFile(
        mdPath,
        `# Concept ${i}\n\nRound 57 semantic retrieval planner diagnostic page ${i} content.\n`,
        'utf8',
      );
      const imp = await host.call('materials.document.import', {
        path: mdPath,
        title: `R57 Material ${i}`,
        format: 'md',
      });
      assert.equal(imp.ok, true, imp.error?.message);
    }

    const planRes = await host.call('retrieval.index.plan', {});
    assert.equal(planRes.ok, true, planRes.error?.message);
    assert.equal(planRes.value.pages, 2);
    assert.equal(planRes.value.toIndex, 2);
    assert.equal(planRes.value.unchanged, 0);
    assert.equal(planRes.value.skipped, 0);
    assert.equal(planRes.value.toRemove, 0);
    assert.ok(planRes.value.chars > 0, 'expected positive chars in index plan');
    assert.equal(typeof planRes.value.firstRun, 'boolean');
    assert.equal(typeof planRes.value.modelMb, 'number');
    assert.equal(typeof planRes.value.canIndex, 'boolean');

    const testRes = await host.call('retrieval.test', {});
    assert.equal(testRes.ok, true, testRes.error?.message);
    assert.deepEqual(testRes.value, { ok: false, reason: 'builtin' });

    assert.equal(fetchCalls, 0, 'retrieval.index.plan and retrieval.test must trigger 0 model/network calls');
  });

  test('2) PTY E2E: WorkspaceTab [t] retrieval diagnostics modal at 120x36 (zh) & 80x24 (--ascii en)', async () => {
    // 2a) 120x36 zh
    const ttyZh = await mountApp({ initialPage: 'settings', asciiMode: false, language: 'zh', cols: 120, rows: 36 });
    await ttyZh.waitFor((s) => s.includes('模型配置') && s.includes('工作区'), {
      label: 'SettingsView rendered (zh)',
    });

    ttyZh.send('2');
    const wsZh = await ttyZh.waitFor(
      (s) => s.includes('语义检索:') && s.includes('[v] 切换') && s.includes('[t] 诊断'),
      { timeoutMs: 8_000, label: 'WorkspaceTab [t] 诊断 hint visible (zh)' },
    );
    ttyZh.assertHealthyScreen(wsZh, 120, 36, 'WorkspaceTab 120x36 zh');

    ttyZh.send('t');
    const modalZh = await ttyZh.waitFor(
      (s) =>
        s.includes('语义检索诊断与索引计划') &&
        s.includes('内置词法检索 (builtin)') &&
        s.includes('总页数 2') &&
        s.includes('待索引 2') &&
        s.includes('未变更 0'),
      { timeoutMs: 8_000, label: 'Retrieval diagnostics modal rendered (zh)' },
    );
    ttyZh.assertHealthyScreen(modalZh, 120, 36, 'RetrievalDiagModal 120x36 zh');

    // Refresh inside modal with 'r'
    ttyZh.send('r');
    const refreshedZh = await ttyZh.waitFor(
      (s) =>
        !s.includes('正在刷新诊断') &&
        s.includes('语义检索诊断与索引计划') &&
        s.includes('总页数 2') &&
        s.includes('内置词法检索 (builtin)'),
      { timeoutMs: 8_000, label: 'Retrieval diagnostics modal refreshed via [r] (zh)' },
    );
    ttyZh.assertHealthyScreen(refreshedZh, 120, 36, 'RetrievalDiagModal refreshed 120x36 zh');

    // Close modal with Esc
    ttyZh.send('\x1b');
    const closedZh = await ttyZh.waitFor(
      (s) => !s.includes('语义检索诊断与索引计划') && s.includes('[t] 诊断'),
      { timeoutMs: 5_000, label: 'Retrieval diagnostics modal closed via Esc (zh)' },
    );
    ttyZh.assertHealthyScreen(closedZh, 120, 36, 'WorkspaceTab after modal close 120x36 zh');

    // 2b) 80x24 --ascii en
    const ttyEn = await mountApp({ initialPage: 'settings', asciiMode: true, language: 'en', cols: 80, rows: 24 });
    await ttyEn.waitFor((s) => s.includes('Models') && s.includes('Workspace'), {
      label: 'SettingsView rendered (en --ascii)',
    });

    ttyEn.send('2');
    const wsEn = await ttyEn.waitFor(
      (s) => s.includes('Retrieval:') && s.includes('[v] Switch') && s.includes('[t] Diag'),
      { timeoutMs: 8_000, label: 'WorkspaceTab [t] Diag hint visible 80x24 (en --ascii)' },
    );
    ttyEn.assertHealthyScreen(wsEn, 80, 24, 'WorkspaceTab 80x24 en --ascii');
    ttyEn.assertAsciiPure(wsEn, 'WorkspaceTab 80x24 en --ascii');

    ttyEn.send('t');
    const modalEn = await ttyEn.waitFor(
      (s) =>
        s.includes('Retrieval Diagnostics & Index Plan') &&
        s.includes('Built-in lexical search (builtin)') &&
        s.includes('Pages 2') &&
        s.includes('To Index 2') &&
        s.includes('Unchanged 0'),
      { timeoutMs: 8_000, label: 'Retrieval diagnostics modal rendered 80x24 (en --ascii)' },
    );
    ttyEn.assertHealthyScreen(modalEn, 80, 24, 'RetrievalDiagModal 80x24 en --ascii');
    ttyEn.assertAsciiPure(modalEn, 'RetrievalDiagModal 80x24 en --ascii');

    // Refresh inside modal with 'r'
    ttyEn.send('r');
    const refreshedEn = await ttyEn.waitFor(
      (s) =>
        !s.includes('Refreshing diagnostics') &&
        s.includes('Retrieval Diagnostics & Index Plan') &&
        s.includes('Pages 2') &&
        s.includes('Built-in lexical search (builtin)'),
      { timeoutMs: 8_000, label: 'Retrieval diagnostics modal refreshed via [r] 80x24 (en --ascii)' },
    );
    ttyEn.assertHealthyScreen(refreshedEn, 80, 24, 'RetrievalDiagModal refreshed 80x24 en --ascii');
    ttyEn.assertAsciiPure(refreshedEn, 'RetrievalDiagModal refreshed 80x24 en --ascii');

    // Close modal with 'q' (must close modal cleanly without quitting app)
    ttyEn.send('q');
    const closedEn = await ttyEn.waitFor(
      (s) => !s.includes('Retrieval Diagnostics & Index Plan') && s.includes('[t] Diag'),
      { timeoutMs: 5_000, label: 'Retrieval diagnostics modal closed via [q] 80x24 (en --ascii)' },
    );
    ttyEn.assertHealthyScreen(closedEn, 80, 24, 'WorkspaceTab after modal close 80x24 en --ascii');
    ttyEn.assertAsciiPure(closedEn, 'WorkspaceTab after modal close 80x24 en --ascii');

    assert.equal(fetchCalls, 0, 'PTY E2E must trigger 0 network/model calls');
  });
});
