// Round 58 WorkspaceTab Local Hybrid Retrieval Preview & HF Mirror Endpoint tests:
// `node --test tests/round58-retrieval-tools.test.mjs`
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
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round58-ret-${label}-`));
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

describe('Round 58: WorkspaceTab Local Hybrid Retrieval Preview & HF Mirror Endpoint', () => {
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
        throw new Error('Network/model call must not happen during Round 58 retrieval tools tests');
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

  test('1) createTuiHost integration: retrieval.preview (localHybrid) & retrieval.endpoint.set (0 model calls)', async () => {
    const mdPath = join(boxDir, 'r58-qft.md');
    await writeFile(
      mdPath,
      '# Quantum Computing\n\nThe Quantum Fourier Transform algorithm maps amplitudes into phase frequencies.\n',
      'utf8',
    );
    const imp = await host.call('materials.document.import', {
      path: mdPath,
      title: 'Quantum Notes',
      format: 'md',
    });
    assert.equal(imp.ok, true, imp.error?.message);

    const emptyRes = await host.call('retrieval.preview', { query: '', localHybrid: true, limit: 5 });
    assert.equal(emptyRes.ok, false);
    assert.ok(emptyRes.error?.message?.includes('请先写下要检索的主题'));

    const prevRes = await host.call('retrieval.preview', {
      query: 'Quantum Fourier',
      localHybrid: true,
      limit: 5,
    });
    assert.equal(prevRes.ok, true, prevRes.error?.message);
    assert.equal(prevRes.value.provider, 'builtin');
    assert.ok(prevRes.value.hits >= 1, `expected hits >= 1, got ${prevRes.value.hits}`);
    assert.ok(Array.isArray(prevRes.value.pages) && prevRes.value.pages.length >= 1, 'expected matched pages');
    assert.ok(
      prevRes.value.pages[0].snippet?.includes('Quantum Fourier'),
      `expected snippet to include Quantum Fourier, got ${JSON.stringify(prevRes.value.pages[0])}`,
    );

    const setRes = await host.call('retrieval.endpoint.set', { endpoint: 'https://hf-mirror.com' });
    assert.equal(setRes.ok, true, setRes.error?.message);
    assert.equal(setRes.value.hfEndpoint, 'https://hf-mirror.com');

    const statusAfterSet = await host.call('retrieval.status', {});
    assert.equal(statusAfterSet.ok, true, statusAfterSet.error?.message);
    assert.equal(statusAfterSet.value.hfEndpoint, 'https://hf-mirror.com');

    const resetRes = await host.call('retrieval.endpoint.set', { endpoint: '' });
    assert.equal(resetRes.ok, true, resetRes.error?.message);
    assert.equal(resetRes.value.hfEndpoint, undefined);

    assert.equal(fetchCalls, 0, 'retrieval.preview and retrieval.endpoint.set must trigger 0 model/network calls');
  });

  test('2) PTY E2E: WorkspaceTab [t] -> [s] local preview search & [m] HF mirror editor at 120x36 (zh) & 80x24 (--ascii en)', async () => {
    // 2a) 120x36 zh
    const ttyZh = await mountApp({ initialPage: 'settings', asciiMode: false, language: 'zh', cols: 120, rows: 36 });
    await ttyZh.waitFor((s) => s.includes('模型配置') && s.includes('工作区'), {
      label: 'SettingsView rendered (zh)',
    });

    ttyZh.send('2');
    await ttyZh.waitFor(
      (s) => s.includes('语义检索:') && s.includes('[t] 诊断'),
      { timeoutMs: 8_000, label: 'WorkspaceTab [t] 诊断 visible (zh)' },
    );

    ttyZh.send('t');
    const modalZh = await ttyZh.waitFor(
      (s) =>
        s.includes('语义检索诊断与索引计划') &&
        s.includes('模型镜像: 默认 (HuggingFace)') &&
        s.includes('试搜') &&
        s.includes('镜像源'),
      { timeoutMs: 8_000, label: 'RetrievalDiagModal summary rendered (zh)' },
    );
    ttyZh.assertHealthyScreen(modalZh, 120, 36, 'RetrievalDiagModal summary 120x36 zh');

    // [s] -> Esc returns to summary without closing modal
    ttyZh.send('s');
    await ttyZh.waitFor(
      (s) => s.includes('输入本地混合检索试搜主题'),
      { timeoutMs: 5_000, label: 'preview-input opened (zh)' },
    );
    ttyZh.send('\x1b');
    await ttyZh.waitFor(
      (s) => s.includes('语义检索诊断与索引计划') && !s.includes('输入本地混合检索试搜主题'),
      { timeoutMs: 5_000, label: 'Esc returned from preview-input to summary (zh)' },
    );

    // [s] -> type 'Quantum Fourier' + Enter -> preview hits render
    ttyZh.send('s');
    await ttyZh.waitFor(
      (s) => s.includes('输入本地混合检索试搜主题'),
      { timeoutMs: 5_000, label: 'preview-input reopened (zh)' },
    );
    ttyZh.send('Quantum Fourier');
    await ttyZh.waitFor((s) => s.includes('Quantum Fourier'), {
      timeoutMs: 3_000,
      label: 'preview-input typed Quantum Fourier (zh)',
    });
    ttyZh.send('\r');
    const previewZh = await ttyZh.waitFor(
      (s) =>
        s.includes('试搜命中') &&
        s.includes('Quantum Fourier') &&
        s.includes('Quantum Notes'),
      { timeoutMs: 8_000, label: 'preview hits rendered in summary (zh)' },
    );
    ttyZh.assertHealthyScreen(previewZh, 120, 36, 'RetrievalDiagModal preview hits 120x36 zh');

    // [m] -> type 'https://hf-mirror.com' + Enter -> saved & displayed
    ttyZh.send('m');
    await ttyZh.waitFor(
      (s) => s.includes('设置模型下载镜像地址'),
      { timeoutMs: 5_000, label: 'endpoint-input opened (zh)' },
    );
    ttyZh.send('https://hf-mirror.com');
    await ttyZh.waitFor((s) => s.includes('https://hf-mirror.com'), {
      timeoutMs: 3_000,
      label: 'endpoint-input typed hf-mirror (zh)',
    });
    ttyZh.send('\r');
    const mirrorSavedZh = await ttyZh.waitFor(
      (s) =>
        s.includes('模型镜像: https://hf-mirror.com') &&
        s.includes('已保存模型下载镜像'),
      { timeoutMs: 8_000, label: 'HF mirror saved & displayed (zh)' },
    );
    ttyZh.assertHealthyScreen(mirrorSavedZh, 120, 36, 'RetrievalDiagModal mirror saved 120x36 zh');

    const persisted = await host.call('retrieval.status', {});
    assert.equal(persisted.ok, true);
    assert.equal(persisted.value.hfEndpoint, 'https://hf-mirror.com');

    // 2b) 80x24 --ascii en (verifies persisted hfEndpoint, preview search, reset to default, and pure ASCII)
    const ttyEn = await mountApp({ initialPage: 'settings', asciiMode: true, language: 'en', cols: 80, rows: 24 });
    await ttyEn.waitFor((s) => s.includes('Models') && s.includes('Workspace'), {
      label: 'SettingsView rendered (en --ascii)',
    });

    ttyEn.send('2');
    await ttyEn.waitFor(
      (s) => s.includes('Retrieval:') && s.includes('[t] Diag'),
      { timeoutMs: 8_000, label: 'WorkspaceTab [t] Diag visible (en --ascii)' },
    );

    ttyEn.send('t');
    const modalEn = await ttyEn.waitFor(
      (s) =>
        s.includes('Retrieval Diagnostics & Index Plan') &&
        s.includes('HF Endpoint: https://hf-mirror.com') &&
        s.includes('Search') &&
        s.includes('Mirror'),
      { timeoutMs: 8_000, label: 'RetrievalDiagModal summary rendered 80x24 (en --ascii)' },
    );
    ttyEn.assertHealthyScreen(modalEn, 80, 24, 'RetrievalDiagModal summary 80x24 en --ascii');
    ttyEn.assertAsciiPure(modalEn, 'RetrievalDiagModal summary 80x24 en --ascii');

    // [s] -> type 'Quantum Fourier' + Enter -> preview hits render at 80x24
    ttyEn.send('s');
    await ttyEn.waitFor(
      (s) => s.includes('Enter topic for local hybrid search preview'),
      { timeoutMs: 5_000, label: 'preview-input opened 80x24 (en --ascii)' },
    );
    ttyEn.send('Quantum Fourier');
    await ttyEn.waitFor((s) => s.includes('Quantum Fourier'), {
      timeoutMs: 3_000,
      label: 'preview-input typed Quantum Fourier 80x24 (en --ascii)',
    });
    ttyEn.send('\r');
    const previewEn = await ttyEn.waitFor(
      (s) =>
        s.includes('Search Preview') &&
        s.includes('Quantum Notes') &&
        s.includes('Quantum Fourier'),
      { timeoutMs: 8_000, label: 'preview hits rendered 80x24 (en --ascii)' },
    );
    ttyEn.assertHealthyScreen(previewEn, 80, 24, 'RetrievalDiagModal preview hits 80x24 en --ascii');
    ttyEn.assertAsciiPure(previewEn, 'RetrievalDiagModal preview hits 80x24 en --ascii');

    // [m] -> Ctrl+U clears pre-filled endpoint -> Enter resets to Default
    ttyEn.send('m');
    await ttyEn.waitFor(
      (s) => s.includes('Set HuggingFace mirror endpoint') && s.includes('https://hf-mirror.com'),
      { timeoutMs: 5_000, label: 'endpoint-input pre-filled 80x24 (en --ascii)' },
    );
    ttyEn.send('\x15');
    await ttyEn.waitFor(
      (s) => s.includes('Set HuggingFace mirror endpoint') && s.includes('(empty resets to default)'),
      { timeoutMs: 3_000, label: 'endpoint-input cleared via Ctrl+U 80x24 (en --ascii)' },
    );
    ttyEn.send('\r');
    const resetEn = await ttyEn.waitFor(
      (s) =>
        s.includes('HF Endpoint: Default') &&
        s.includes('Reset HF endpoint'),
      { timeoutMs: 8_000, label: 'HF mirror reset to Default 80x24 (en --ascii)' },
    );
    ttyEn.assertHealthyScreen(resetEn, 80, 24, 'RetrievalDiagModal mirror reset 80x24 en --ascii');
    ttyEn.assertAsciiPure(resetEn, 'RetrievalDiagModal mirror reset 80x24 en --ascii');

    const afterReset = await host.call('retrieval.status', {});
    assert.equal(afterReset.ok, true);
    assert.equal(afterReset.value.hfEndpoint, undefined);

    ttyEn.send('\x1b');
    const closedEn = await ttyEn.waitFor(
      (s) => !s.includes('Retrieval Diagnostics & Index Plan') && s.includes('[t] Diag'),
      { timeoutMs: 5_000, label: 'RetrievalDiagModal closed via Esc 80x24 (en --ascii)' },
    );
    ttyEn.assertHealthyScreen(closedEn, 80, 24, 'WorkspaceTab after modal close 80x24 en --ascii');
    ttyEn.assertAsciiPure(closedEn, 'WorkspaceTab after modal close 80x24 en --ascii');

    assert.equal(fetchCalls, 0, 'PTY E2E must trigger 0 network/model calls');
  });
});
