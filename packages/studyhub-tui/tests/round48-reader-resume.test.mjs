// Round 48 DocumentReader Persistent Last-Read Page Memory & Automatic Resume:
// `node --test tests/round48-reader-resume.test.mjs`
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import xtermPkg from '@xterm/headless';
import { render } from 'ink';
import React from 'react';
import { tsImport } from 'tsx/esm/api';

const { Terminal } = xtermPkg;
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const distDir = resolve(pkgRoot, 'dist');

const prefsMod = await tsImport('../src/host/tui-prefs.ts', import.meta.url);

const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const { StudyHubTuiApp } = await import(pathToFileURL(join(distDir, 'App.mjs')).href);
const H = await import(pathToFileURL(join(distDir, 'host.mjs')).href);

let R = null;
for (const f of distFiles) {
  if (f.startsWith('chunk-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!R && typeof mod.displayWidth === 'function') R = mod;
  }
}
assert.ok(H?.createTuiHost, 'dist/ must export createTuiHost');
assert.ok(H?.saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(H?.loadTuiPreferences, 'dist/ must export loadTuiPreferences');
assert.ok(R?.displayWidth, 'dist/ must export displayWidth');

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round48-resume-${label}-`));
  tempDirs.push(d);
  return d;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const RESOURCE_KINDS = new Set(['FSEventWrap', 'StatWatcher', 'Timeout', 'ProcessWrap', 'TCPWrap', 'PipeWrap']);
function resourceCounts() {
  const counts = {};
  for (const kind of process.getActiveResourcesInfo()) {
    if (RESOURCE_KINDS.has(kind)) counts[kind] = (counts[kind] || 0) + 1;
  }
  return counts;
}

const UNICODE_BOX_RE = /[\u2500-\u257f]/g;
const UNICODE_BLOCK_RE = /[\u2580-\u259f]/g;
const UNICODE_BRAILLE_RE = /[\u2800-\u28ff]/g;
const FORBIDDEN_ASCII_CHROME_RE = /[›…✓✕↑↓←→•★⚑⚠☑☐●○◆▸▾☰✎]/g;

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

  async function waitFor(predicate, { timeoutMs = 8_000, label = 'condition' } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await flush();
      const screen = readScreen();
      if (predicate(screen)) return screen;
      await sleep(35);
    }
    const finalScreen = readScreen();
    throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms.\n--- SCREEN ---\n${finalScreen}\n--------------`);
  }

  function assertHealthyScreen(screen, expectedCols, expectedRows, contextLabel) {
    const lines = screen.split('\n');
    assert.ok(
      !screen.includes('页面渲染异常') && !screen.includes('View Error'),
      `${contextLabel}: ViewErrorBoundary triggered!\n${screen}`,
    );
    assert.ok(
      !screen.includes('TypeError:') && !screen.includes('ReferenceError:'),
      `${contextLabel}: Runtime JS error rendered!\n${screen}`,
    );
    assert.ok(!screen.includes('\uFFFD'), `${contextLabel}: Replacement char U+FFFD found!\n${screen}`);
    assert.ok(
      !screen.includes('\x1b'),
      `${contextLabel}: Unparsed escape sequence leaked into xterm buffer!\n${screen}`,
    );
    assert.ok(
      lines.length <= expectedRows,
      `${contextLabel}: Screen rows exceeded (${lines.length} > ${expectedRows})`,
    );
    for (let i = 0; i < lines.length; i += 1) {
      const w = R.displayWidth(lines[i]);
      assert.ok(
        w <= expectedCols,
        `${contextLabel}: Row ${i} exceeds cols (${w} > ${expectedCols}): ${JSON.stringify(lines[i])}`,
      );
    }
    const buf = term.buffer.active;
    for (let y = 0; y < term.rows; y += 1) {
      const line = buf.getLine(buf.viewportY + y);
      if (line) {
        assert.equal(
          line.isWrapped,
          false,
          `${contextLabel}: xterm soft-wrapped row ${y}: ${JSON.stringify(line.translateToString(true))}`,
        );
      }
    }
  }

  function assertAsciiPure(screen, contextLabel) {
    for (const [label, re] of [
      ['box-drawing', UNICODE_BOX_RE],
      ['block-element', UNICODE_BLOCK_RE],
      ['braille', UNICODE_BRAILLE_RE],
      ['unicode-chrome', FORBIDDEN_ASCII_CHROME_RE],
    ]) {
      const match = screen.match(re);
      assert.equal(
        match,
        null,
        `${contextLabel}: ${label} leaked in --ascii mode: ${JSON.stringify(match ? [...new Set(match)] : [])}\n${screen}`,
      );
    }
  }

  return {
    stdin,
    stdout,
    stderr,
    term,
    firstFramePromise,
    flush,
    readLines,
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

async function pollUntil(predicate, { timeoutMs = 4_000, intervalMs = 40, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await predicate();
    if (res) return res;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
}

describe('Round 48: tui-prefs lastReadPages unit validation', () => {
  test('1) parseTuiPreferences omits empty/corrupt lastReadPages and filters invalid entries cleanly', () => {
    assert.equal('lastReadPages' in prefsMod.DEFAULT_TUI_PREFERENCES, false);
    assert.equal(prefsMod.MAX_LAST_READ_PAGES, 100);

    const empty = prefsMod.parseTuiPreferences({ lastReadPages: {} });
    assert.equal('lastReadPages' in empty, false);

    for (const bad of [null, [], 'str', 42, true]) {
      const parsed = prefsMod.parseTuiPreferences({ lastReadPages: bad });
      assert.equal('lastReadPages' in parsed, false);
    }

    const longValidKey = 'k'.repeat(160);
    const overlongKey = 'x'.repeat(161);
    const parsed = prefsMod.parseTuiPreferences({
      lastReadPages: {
        '': 2,
        '   ': 4,
        [overlongKey]: 3,
        'doc-neg': -1,
        'doc-zero': 0,
        'doc-float': 2.5,
        'doc-nan': Number.NaN,
        'doc-inf': Number.POSITIVE_INFINITY,
        'doc-over-max': 50_001,
        'doc-str': '3',
        'doc-null': null,
        '  doc-alpha  ': 3,
        'doc-beta': 1,
        'doc-max': 50_000,
        [longValidKey]: 17,
      },
    });

    assert.deepEqual(parsed.lastReadPages, {
      'doc-alpha': 3,
      'doc-beta': 1,
      'doc-max': 50_000,
      [longValidKey]: 17,
    });
  });

  test('2) parseTuiPreferences caps lastReadPages at 100 entries keeping newest', () => {
    const input = {};
    for (let i = 1; i <= 125; i += 1) {
      input[`doc-${String(i).padStart(3, '0')}`] = i;
    }
    const parsed = prefsMod.parseTuiPreferences({ lastReadPages: input });
    const keys = Object.keys(parsed.lastReadPages || {});
    assert.equal(keys.length, 100);
    assert.equal(keys[0], 'doc-026');
    assert.equal(keys[99], 'doc-125');
    assert.equal(parsed.lastReadPages['doc-001'], undefined);
    assert.equal(parsed.lastReadPages['doc-025'], undefined);
    assert.equal(parsed.lastReadPages['doc-026'], 26);
    assert.equal(parsed.lastReadPages['doc-125'], 125);
  });

  test('3) saveTuiPreferences & loadTuiPreferences round-trip lastReadPages atomically', async () => {
    const base = await makeTempDir('prefs-unit');
    const location = { env: { DSH_HOME: base } };

    const saved = await prefsMod.saveTuiPreferences(
      {
        lastReadPages: {
          'doc-one': 3,
          'doc-bad': -5,
          'doc-two': 12,
        },
      },
      location,
    );
    assert.deepEqual(saved.lastReadPages, { 'doc-one': 3, 'doc-two': 12 });

    const merged = await prefsMod.saveTuiPreferences({ compactMode: true }, location);
    assert.equal(merged.compactMode, true);
    assert.deepEqual(merged.lastReadPages, { 'doc-one': 3, 'doc-two': 12 });

    const reloaded = await prefsMod.loadTuiPreferences(location);
    assert.deepEqual(reloaded, merged);

    const files = await readdir(join(base, 'study'));
    assert.deepEqual(files, ['tui.json']);
  });
});

describe('Round 48: DocumentReader persistent page resume PTY E2E', () => {
  let boxDir;
  let dshHome;
  let libraryRoot;
  let host;
  let activeTty = null;
  let activeInk = null;
  let disposed = false;
  let baselineResources;

  async function unmountActiveApp() {
    const ink = activeInk;
    const tty = activeTty;
    activeInk = null;
    activeTty = null;
    try {
      ink?.unmount();
    } catch {
      // Ignore teardown unmount errors
    }
    tty?.dispose();
  }

  async function mountApp({ initialPage = 'sources', asciiMode = false, language = 'zh' } = {}) {
    await unmountActiveApp();
    await H.saveTuiPreferences({ language, asciiMode }, { env: { DSH_HOME: dshHome } });
    const tty = createVirtualTty(120, 36);
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

  async function importThreePageMarkdown(filename, title) {
    const mdPath = join(boxDir, filename);
    await writeFile(
      mdPath,
      [
        '<!-- page: 1 -->',
        `# ${title} - Page One`,
        '',
        `R48 Page One Alpha (${title}) content for resume verification.`,
        '',
        '<!-- page: 2 -->',
        `# ${title} - Page Two`,
        '',
        `R48 Page Two Beta (${title}) content for resume verification.`,
        '',
        '<!-- page: 3 -->',
        `# ${title} - Page Three`,
        '',
        `R48 Page Three Gamma (${title}) content for resume verification.`,
        '',
      ].join('\n'),
      'utf8',
    );
    const imp = await host.call('materials.document.import', {
      path: mdPath,
      title,
      format: 'md',
    });
    assert.equal(imp.ok, true, `import failed: ${imp.error?.message || ''}`);
    assert.equal(imp.value.sourceIds.length, 3, 'Expected 3-page document');
    return imp.value;
  }

  before(async () => {
    boxDir = await makeTempDir('e2e');
    dshHome = join(boxDir, 'dsh-home');
    libraryRoot = join(boxDir, 'library');
    process.env.DSH_HOME = dshHome;
    baselineResources = resourceCounts();

    host = await H.createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(boxDir, 'home'),
      libraryRoot,
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
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

  test('1) PTY E2E (zh): advance to page 3 -> save & close -> reopen auto-resumes at 3/3 + flush on immediate Esc', async () => {
    const doc = await importThreePageMarkdown('r48-zh-doc.md', 'R48 Zh Resume Doc');
    const docKey = doc.documentId;

    const tty = await mountApp({ initialPage: 'sources', asciiMode: false, language: 'zh' });
    await tty.waitFor(
      (s) => s.includes('R48 Zh Resume Doc') && !s.includes('正在加载页面'),
      { timeoutMs: 10_000, label: 'SourcesView rendered R48 Zh Resume Doc' },
    );

    tty.send('/');
    await tty.waitFor((s) => s.includes('搜索') || s.includes('Search'), { label: 'Sources filter bar' });
    tty.send('R48 Zh Resume Doc');
    await tty.waitFor((s) => s.includes('R48 Zh Resume Doc'), { label: 'Filtered to R48 Zh Resume Doc' });
    tty.send('\r');
    await tty.waitFor(
      (s) => s.includes('R48 Zh Resume Doc') && s.includes('3 页'),
      { timeoutMs: 5_000, label: 'R48 Zh Resume Doc selected' },
    );

    // Open DocumentReader -> starts at page 1/3
    tty.send('\r');
    const p1Screen = await tty.waitFor(
      (s) => s.includes('第 1 / 3 页') && s.includes('R48 Page One Alpha'),
      { timeoutMs: 10_000, label: 'DocumentReader opened at page 1/3 (zh)' },
    );
    tty.assertHealthyScreen(p1Screen, 120, 36, 'DocumentReader page 1/3 (zh)');

    // Advance to page 2 -> page 3
    tty.send(']');
    await tty.waitFor(
      (s) => s.includes('第 2 / 3 页') && s.includes('R48 Page Two Beta'),
      { timeoutMs: 5_000, label: 'Advanced to page 2/3 (zh)' },
    );
    tty.send(']');
    const p3Screen = await tty.waitFor(
      (s) => s.includes('第 3 / 3 页') && s.includes('R48 Page Three Gamma'),
      { timeoutMs: 5_000, label: 'Advanced to page 3/3 (zh)' },
    );
    tty.assertHealthyScreen(p3Screen, 120, 36, 'DocumentReader page 3/3 (zh)');

    // Wait for debounced save to tui.json
    const persisted3 = await pollUntil(
      async () => {
        const prefs = await H.loadTuiPreferences({ env: { DSH_HOME: dshHome } });
        return prefs.lastReadPages?.[docKey] === 3 ? prefs : null;
      },
      { timeoutMs: 4_000, label: 'debounced lastReadPages[docKey] === 3' },
    );
    assert.equal(persisted3.lastReadPages[docKey], 3);

    // Close DocumentReader with Esc -> back to SourcesView
    tty.send('\x1b');
    await tty.waitFor(
      (s) => s.includes('R48 Zh Resume Doc') && !s.includes('第 3 / 3 页'),
      { timeoutMs: 8_000, label: 'Closed DocumentReader back to SourcesView (zh)' },
    );

    // Remount fresh app -> reopen DocumentReader -> auto-resumes at page 3/3 with toast
    const tty2 = await mountApp({ initialPage: 'sources', asciiMode: false, language: 'zh' });
    await tty2.waitFor(
      (s) => s.includes('R48 Zh Resume Doc') && !s.includes('正在加载页面'),
      { timeoutMs: 10_000, label: 'Remounted SourcesView (zh)' },
    );
    tty2.send('/');
    await tty2.waitFor((s) => s.includes('搜索') || s.includes('Search'), { label: 'Sources filter bar 2' });
    tty2.send('R48 Zh Resume Doc');
    await tty2.waitFor((s) => s.includes('R48 Zh Resume Doc'), { label: 'Filtered doc 2' });
    tty2.send('\r');
    await tty2.waitFor((s) => s.includes('R48 Zh Resume Doc'), { timeoutMs: 5_000, label: 'Selected doc 2' });

    tty2.send('\r');
    const resumedScreen = await tty2.waitFor(
      (s) =>
        s.includes('第 3 / 3 页') &&
        s.includes('R48 Page Three Gamma') &&
        s.includes('已恢复到上次阅读第 3 页'),
      { timeoutMs: 10_000, label: 'Auto-resumed at page 3/3 with toast (zh)' },
    );
    tty2.assertHealthyScreen(resumedScreen, 120, 36, 'DocumentReader resumed 3/3 (zh)');

    // Resize to 80x24 and verify healthy layout
    tty2.resize(80, 24);
    const narrowResumed = await tty2.waitFor(
      (s) => s.includes('3 / 3') && s.includes('R48 Page Three Gamma') && s.split('\n').length <= 24,
      { timeoutMs: 5_000, label: 'Resumed DocumentReader resized to 80x24 (zh)' },
    );
    tty2.assertHealthyScreen(narrowResumed, 80, 24, 'DocumentReader resumed 80x24 (zh)');

    // Navigate back to page 2 and immediately close with Esc (verifies flush-on-close)
    tty2.send('[');
    await tty2.waitFor(
      (s) => s.includes('2 / 3') && s.includes('R48 Page Two Beta'),
      { timeoutMs: 5_000, label: 'Navigated back to page 2/3 (zh)' },
    );
    tty2.send('\x1b');
    await tty2.waitFor(
      (s) => s.includes('R48 Zh Resume Doc') && !s.includes('R48 Page Two Beta'),
      { timeoutMs: 5_000, label: 'Closed immediately after page change (zh)' },
    );
    await pollUntil(
      async () => {
        const prefs = await H.loadTuiPreferences({ env: { DSH_HOME: dshHome } });
        return prefs.lastReadPages?.[docKey] === 2 ? prefs : null;
      },
      { timeoutMs: 4_000, label: 'flushed lastReadPages[docKey] === 2 on Esc close' },
    );

    await unmountActiveApp();
  });

  test('2) PTY E2E (--ascii en): advance to page 3 -> save & close -> reopen auto-resumes at P. 3 / 3 with zero leaks', async () => {
    const doc = await importThreePageMarkdown('r48-en-doc.md', 'R48 En Resume Doc');
    const docKey = doc.documentId;

    const tty = await mountApp({ initialPage: 'sources', asciiMode: true, language: 'en' });
    await tty.waitFor(
      (s) => s.includes('R48 En Resume Doc') && !s.includes('Loading view'),
      { timeoutMs: 10_000, label: 'SourcesView rendered R48 En Resume Doc' },
    );

    tty.send('/');
    await tty.waitFor((s) => s.includes('Filter:'), { label: 'ASCII Sources filter bar' });
    tty.send('R48 En Resume Doc');
    await tty.waitFor((s) => s.includes('R48 En Resume Doc'), { label: 'Filtered to R48 En Resume Doc' });
    tty.send('\r');
    await tty.waitFor(
      (s) => s.includes('R48 En Resume Doc') && s.includes('3p'),
      { timeoutMs: 5_000, label: 'R48 En Resume Doc selected' },
    );

    tty.send('\r');
    const p1Screen = await tty.waitFor(
      (s) => s.includes('P. 1 / 3') && s.includes('R48 Page One Alpha'),
      { timeoutMs: 10_000, label: 'ASCII DocumentReader opened at P. 1 / 3' },
    );
    tty.assertHealthyScreen(p1Screen, 120, 36, 'ASCII DocumentReader P. 1 / 3');
    tty.assertAsciiPure(p1Screen, 'ASCII DocumentReader P. 1 / 3');

    tty.send(']');
    await tty.waitFor(
      (s) => s.includes('P. 2 / 3') && s.includes('R48 Page Two Beta'),
      { timeoutMs: 5_000, label: 'ASCII DocumentReader P. 2 / 3' },
    );
    tty.send(']');
    const p3Screen = await tty.waitFor(
      (s) => s.includes('P. 3 / 3') && s.includes('R48 Page Three Gamma'),
      { timeoutMs: 5_000, label: 'ASCII DocumentReader P. 3 / 3' },
    );
    tty.assertHealthyScreen(p3Screen, 120, 36, 'ASCII DocumentReader P. 3 / 3');
    tty.assertAsciiPure(p3Screen, 'ASCII DocumentReader P. 3 / 3');

    await pollUntil(
      async () => {
        const prefs = await H.loadTuiPreferences({ env: { DSH_HOME: dshHome } });
        return prefs.lastReadPages?.[docKey] === 3 ? prefs : null;
      },
      { timeoutMs: 4_000, label: 'debounced lastReadPages[docKey] === 3 (en)' },
    );

    tty.send('\x1b');
    await tty.waitFor(
      (s) => s.includes('R48 En Resume Doc') && !s.includes('P. 3 / 3'),
      { timeoutMs: 8_000, label: 'Closed ASCII DocumentReader back to SourcesView' },
    );

    // Remount fresh app in --ascii en -> reopen -> resumes at P. 3 / 3 with English toast
    const tty2 = await mountApp({ initialPage: 'sources', asciiMode: true, language: 'en' });
    await tty2.waitFor(
      (s) => s.includes('R48 En Resume Doc') && !s.includes('Loading view'),
      { timeoutMs: 10_000, label: 'Remounted ASCII SourcesView' },
    );
    tty2.send('/');
    await tty2.waitFor((s) => s.includes('Filter:'), { label: 'ASCII filter bar 2' });
    tty2.send('R48 En Resume Doc');
    await tty2.waitFor((s) => s.includes('R48 En Resume Doc'), { label: 'Filtered ASCII doc 2' });
    tty2.send('\r');
    await tty2.waitFor((s) => s.includes('R48 En Resume Doc'), { timeoutMs: 5_000, label: 'Selected ASCII doc 2' });

    tty2.send('\r');
    const resumedScreen = await tty2.waitFor(
      (s) =>
        s.includes('P. 3 / 3') &&
        s.includes('R48 Page Three Gamma') &&
        s.includes('Resumed at page 3'),
      { timeoutMs: 10_000, label: 'ASCII DocumentReader auto-resumed at P. 3 / 3 with toast' },
    );
    tty2.assertHealthyScreen(resumedScreen, 120, 36, 'ASCII DocumentReader resumed P. 3 / 3');
    tty2.assertAsciiPure(resumedScreen, 'ASCII DocumentReader resumed P. 3 / 3');

    await unmountActiveApp();
    await host.dispose();
    await sleep(120);

    const afterResources = resourceCounts();
    for (const kind of ['FSEventWrap', 'StatWatcher', 'ProcessWrap', 'Timeout']) {
      assert.ok(
        (afterResources[kind] || 0) <= (baselineResources[kind] || 0),
        `${kind} leaked: before=${baselineResources[kind] || 0}, after=${afterResources[kind] || 0}`,
      );
    }
  });
});
