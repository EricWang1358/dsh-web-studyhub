// Round 44 Mark Passage Modal & End-to-End Mark Save PTY E2E:
// `node --test tests/round44-mark-save.test.mjs`
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
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round44-mark-save-${label}-`));
  tempDirs.push(d);
  return d;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

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

describe('StudyHub TUI Round 44 MarkPassageModal & Mark Save PTY E2E', () => {
  let boxDir;
  let dshHome;
  let libraryRoot;
  let host;
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

  before(async () => {
    boxDir = await makeTempDir('main');
    dshHome = join(boxDir, 'dsh-home');
    libraryRoot = join(boxDir, 'library');
    process.env.DSH_HOME = dshHome;

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

  test('1) PTY E2E (zh 120x36 & 80x24): DocumentReader [H] -> MarkPassageModal -> save/unchanged/ambiguous -> ReaderNotesDrawer live', async () => {
    const mdPath = join(boxDir, 'r44-mark-zh.md');
    await writeFile(
      mdPath,
      [
        '# Round 44 Invariants',
        '',
        'Unique theorem alpha states that convergence holds monotonically.',
        '',
        'Second distinct lemma beta bounds the residual error cleanly.',
        '',
        'Repeated ambiguous phrase.',
        '',
        'Repeated ambiguous phrase.',
        '',
      ].join('\n'),
      'utf8',
    );

    const imp = await host.call('materials.document.import', {
      path: mdPath,
      title: 'R44 Zh Mark Doc',
      format: 'md',
    });
    assert.equal(imp.ok, true, `import failed: ${imp.error?.message || ''}`);
    const docId = imp.value.documentId;
    const rev = imp.value.revision;

    const tty = await mountApp({ initialPage: 'sources', asciiMode: false, language: 'zh' });
    await tty.waitFor(
      (s) => s.includes('R44 Zh Mark Doc') && !s.includes('正在加载页面'),
      { timeoutMs: 10_000, label: 'SourcesView rendered with R44 Zh Mark Doc' },
    );

    tty.send('/');
    await tty.waitFor((s) => s.includes('搜索') || s.includes('Search'), { label: 'Sources filter bar' });
    tty.send('R44 Zh Mark');
    await tty.waitFor((s) => s.includes('R44 Zh Mark Doc'), { label: 'Filtered to R44 Zh Mark Doc' });
    tty.send('\r');
    await tty.waitFor(
      (s) => s.includes('R44 Zh Mark Doc') && s.includes('MD'),
      { timeoutMs: 5_000, label: 'R44 Zh Mark Doc selected' },
    );

    // Open DocumentReader
    tty.send('\r');
    const readerScreen = await tty.waitFor(
      (s) =>
        s.includes('R44 Zh Mark Doc') &&
        s.includes('Unique theorem alpha') &&
        s.includes('标记段落'),
      { timeoutMs: 10_000, label: 'DocumentReader opened with [H] 标记段落 footer hint' },
    );
    tty.assertHealthyScreen(readerScreen, 120, 36, 'DocumentReader with [H] hint (zh)');

    // Press 'H' to open lazy MarkPassageModal
    tty.send('H');
    const modalScreen = await tty.waitFor(
      (s) =>
        s.includes('标记当前页段落') &&
        s.includes('1:荧光笔') &&
        s.includes('2:下划线') &&
        s.includes('3:加粗') &&
        s.includes('4:待出题') &&
        s.includes('Unique theorem alpha'),
      { timeoutMs: 8_000, label: 'MarkPassageModal opened (zh)' },
    );
    tty.assertHealthyScreen(modalScreen, 120, 36, 'MarkPassageModal open (zh)');

    // Navigate with 'j' to "Unique theorem alpha..." (index 1) and select style '3' (加粗)
    tty.send('j');
    await tty.waitFor(
      (s) => s.includes('(2/5)') && s.includes('选中段落'),
      { timeoutMs: 5_000, label: 'Moved to passage 2 with j' },
    );
    tty.send('3');
    await tty.waitFor(
      (s) => s.includes('当前样式: 加粗') && s.includes('选中段落: 加粗'),
      { timeoutMs: 5_000, label: 'Selected Bold style with key 3' },
    );

    // Press Enter to save mark
    tty.send('\r');
    const afterSaveScreen = await tty.waitFor(
      (s) => !s.includes('标记当前页段落') && s.includes('已添加加粗标记'),
      { timeoutMs: 8_000, label: 'Mark saved toast and modal closed (zh)' },
    );
    tty.assertHealthyScreen(afterSaveScreen, 120, 36, 'DocumentReader after mark save (zh)');

    // Verify materials.marks.list persisted the new mark
    const listRes = await host.call('materials.marks.list', { documentId: docId, revision: rev });
    assert.equal(listRes.ok, true);
    assert.equal(listRes.value?.count, 1);
    assert.equal(listRes.value?.items?.[0]?.style, 'bold');
    assert.equal(
      listRes.value?.items?.[0]?.selection?.quote,
      'Unique theorem alpha states that convergence holds monotonically.',
    );

    // Open ReaderNotesDrawer (B -> Tab) and verify new mark renders live
    tty.send('B');
    await tty.waitFor(
      (s) => s.includes('批注问答与高亮标记') && !s.includes('正在加载批注与标记'),
      { timeoutMs: 8_000, label: 'ReaderNotesDrawer opened (zh)' },
    );
    tty.send('\t');
    const drawerMarksScreen = await tty.waitFor(
      (s) => s.includes('高亮标记 (1)') && s.includes('Unique theorem alpha') && s.includes('加粗'),
      { timeoutMs: 8_000, label: 'ReaderNotesDrawer Marks tab renders newly saved mark live (zh)' },
    );
    tty.assertHealthyScreen(drawerMarksScreen, 120, 36, 'ReaderNotesDrawer live mark (zh)');

    // Close drawer
    tty.send('\x1b');
    await tty.waitFor((s) => !s.includes('批注问答与高亮标记'), { timeoutMs: 5_000, label: 'Drawer closed' });

    // Reopen MarkPassageModal to verify unchanged + ambiguous handling + 80x24 layout
    tty.send('H');
    await tty.waitFor((s) => s.includes('标记当前页段落'), { timeoutMs: 5_000, label: 'MarkPassageModal reopened' });
    tty.send('j');
    await tty.waitFor((s) => s.includes('(2/5)'), { timeoutMs: 5_000, label: 'Moved to passage 2 on reopen' });
    tty.send('3');
    await tty.waitFor((s) => s.includes('(2/5)') && s.includes('当前样式: 加粗'), { label: 'Same passage & style' });
    tty.send('\r');
    await tty.waitFor(
      (s) => s.includes('该段落已存在相同样式(加粗)标记'),
      { timeoutMs: 5_000, label: 'Unchanged toast shown cleanly' },
    );

    // Move to repeated passage (index 3) and verify ambiguous toast
    tty.send('j');
    await tty.waitFor((s) => s.includes('(3/5)'), { timeoutMs: 5_000, label: 'Moved to passage 3' });
    tty.send('j');
    await tty.waitFor((s) => s.includes('(4/5)'), { timeoutMs: 5_000, label: 'Moved to repeated passage' });
    tty.send('\r');
    await tty.waitFor(
      (s) => s.includes('出现多次') || s.includes('multiple times'),
      { timeoutMs: 5_000, label: 'Ambiguous toast shown cleanly' },
    );

    // Resize open MarkPassageModal to 80x24 and verify healthy layout
    tty.resize(80, 24);
    const narrowScreen = await tty.waitFor(
      (s) => s.includes('标记当前页段落') && s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'MarkPassageModal resized to 80x24 (zh)' },
    );
    tty.assertHealthyScreen(narrowScreen, 80, 24, 'MarkPassageModal 80x24 (zh)');

    await unmountActiveApp();
  });

  test('2) PTY E2E (--ascii en 120x36 & 80x24): MarkPassageModal Tab cycle, save, ReaderNotesDrawer live & 100% ASCII purity', async () => {
    const mdPath = join(boxDir, 'r44-mark-en.md');
    await writeFile(
      mdPath,
      [
        '# Round 44 ASCII Guide',
        '',
        'First orthogonal projection preserves Euclidean distance.',
        '',
        'Second spectral decomposition diagonalizes symmetric matrices.',
        '',
      ].join('\n'),
      'utf8',
    );

    const imp = await host.call('materials.document.import', {
      path: mdPath,
      title: 'R44 En Mark Doc',
      format: 'md',
    });
    assert.equal(imp.ok, true, `import failed: ${imp.error?.message || ''}`);
    const docId = imp.value.documentId;
    const rev = imp.value.revision;

    const asciiTty = await mountApp({ initialPage: 'sources', asciiMode: true, language: 'en' });
    await asciiTty.waitFor(
      (s) => s.includes('R44 En Mark Doc') && !s.includes('Loading'),
      { timeoutMs: 10_000, label: 'ASCII SourcesView rendered' },
    );

    asciiTty.send('/');
    await asciiTty.waitFor((s) => s.includes('Filter') || s.includes('Search'), { label: 'ASCII filter bar' });
    asciiTty.send('R44 En Mark');
    await asciiTty.waitFor((s) => s.includes('R44 En Mark Doc'), { label: 'ASCII filter typed' });
    asciiTty.send('\r');
    await asciiTty.waitFor(
      (s) => s.includes('R44 En Mark Doc') && s.includes('MD'),
      { timeoutMs: 5_000, label: 'ASCII R44 En Mark Doc selected' },
    );

    // Open DocumentReader
    asciiTty.send('\r');
    const readerEn = await asciiTty.waitFor(
      (s) =>
        s.includes('R44 En Mark Doc') &&
        s.includes('First orthogonal projection') &&
        s.includes('H  Mark'),
      { timeoutMs: 10_000, label: 'ASCII DocumentReader opened with H Mark hint' },
    );
    asciiTty.assertHealthyScreen(readerEn, 120, 36, 'ASCII DocumentReader 120x36');
    asciiTty.assertAsciiPure(readerEn, 'ASCII DocumentReader 120x36');

    // Open MarkPassageModal via 'H'
    asciiTty.send('H');
    const modalEn = await asciiTty.waitFor(
      (s) =>
        s.includes('Mark Passage') &&
        s.includes('1:Highlight') &&
        s.includes('2:Underline') &&
        s.includes('3:Bold') &&
        s.includes('4:Queue') &&
        s.includes('First orthogonal projection'),
      { timeoutMs: 8_000, label: 'ASCII MarkPassageModal opened' },
    );
    asciiTty.assertHealthyScreen(modalEn, 120, 36, 'ASCII MarkPassageModal 120x36');
    asciiTty.assertAsciiPure(modalEn, 'ASCII MarkPassageModal 120x36');

    // Resize to 80x24 while MarkPassageModal is open
    asciiTty.resize(80, 24);
    const modalNarrow = await asciiTty.waitFor(
      (s) => s.includes('Mark Passage') && s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'ASCII MarkPassageModal resized to 80x24' },
    );
    asciiTty.assertHealthyScreen(modalNarrow, 80, 24, 'ASCII MarkPassageModal 80x24');
    asciiTty.assertAsciiPure(modalNarrow, 'ASCII MarkPassageModal 80x24');

    // Move to passage 3 ("Second spectral decomposition...") with j, j and cycle style with Tab (Highlight -> Underline)
    asciiTty.send('j');
    await asciiTty.waitFor((s) => s.includes('(2/3)'), { timeoutMs: 5_000, label: 'Selected passage 2 at 80x24' });
    asciiTty.send('j');
    await asciiTty.waitFor((s) => s.includes('(3/3)'), { timeoutMs: 5_000, label: 'Selected passage 3 at 80x24' });
    asciiTty.send('\t');
    const afterTab = await asciiTty.waitFor(
      (s) => s.includes('Style: Underline') && s.includes('Selected: Underline'),
      { timeoutMs: 5_000, label: 'Tab cycled style to Underline' },
    );
    asciiTty.assertHealthyScreen(afterTab, 80, 24, 'ASCII MarkPassageModal after Tab 80x24');
    asciiTty.assertAsciiPure(afterTab, 'ASCII MarkPassageModal after Tab 80x24');

    // Resize back to 120x36 and press Enter to save
    asciiTty.resize(120, 36);
    await asciiTty.waitFor((s) => s.includes('Mark Passage') && s.includes('Style: Underline'), {
      timeoutMs: 5_000,
      label: 'Restored 120x36',
    });
    asciiTty.send('\r');
    const savedEn = await asciiTty.waitFor(
      (s) => !s.includes('Mark Passage') && s.includes('Saved Underline mark'),
      { timeoutMs: 8_000, label: 'ASCII Saved Underline mark toast' },
    );
    asciiTty.assertHealthyScreen(savedEn, 120, 36, 'ASCII DocumentReader after save');
    asciiTty.assertAsciiPure(savedEn, 'ASCII DocumentReader after save');

    // Verify persistence via materials.marks.list
    const listEn = await host.call('materials.marks.list', { documentId: docId, revision: rev });
    assert.equal(listEn.ok, true);
    assert.equal(listEn.value?.count, 1);
    assert.equal(listEn.value?.items?.[0]?.style, 'underline');
    assert.equal(
      listEn.value?.items?.[0]?.selection?.quote,
      'Second spectral decomposition diagonalizes symmetric matrices.',
    );

    // Open ReaderNotesDrawer (B -> Tab) and verify live rendering + ASCII purity
    asciiTty.send('B');
    await asciiTty.waitFor(
      (s) => s.includes('Annotations & Marks') && !s.includes('Loading annotations'),
      { timeoutMs: 8_000, label: 'ASCII ReaderNotesDrawer opened' },
    );
    asciiTty.send('\t');
    const drawerEn = await asciiTty.waitFor(
      (s) =>
        s.includes('Marks (1)') &&
        s.includes('Second spectral decomposition') &&
        s.includes('Underline'),
      { timeoutMs: 8_000, label: 'ASCII ReaderNotesDrawer Marks tab shows new mark live' },
    );
    asciiTty.assertHealthyScreen(drawerEn, 120, 36, 'ASCII ReaderNotesDrawer live mark 120x36');
    asciiTty.assertAsciiPure(drawerEn, 'ASCII ReaderNotesDrawer live mark 120x36');

    await unmountActiveApp();
  });

  test('3) Host integration: materials.marks.save queue-full limit (40) status contract', async () => {
    const lines = ['# Queue Limit Doc', ''];
    for (let i = 1; i <= 42; i += 1) {
      lines.push(`Unique queue passage number ${i} for limit verification.`);
    }
    const qPath = join(boxDir, 'r44-queue-limit.md');
    await writeFile(qPath, lines.join('\n'), 'utf8');

    const imp = await host.call('materials.document.import', {
      path: qPath,
      title: 'R44 Queue Limit Doc',
      format: 'md',
    });
    assert.equal(imp.ok, true);
    const docId = imp.value.documentId;
    const rev = imp.value.revision;
    const srcId = imp.value.sourceIds[0];

    for (let i = 1; i <= 40; i += 1) {
      const res = await host.call('materials.marks.save', {
        documentId: docId,
        revision: rev,
        sourceId: srcId,
        style: 'queue',
        selection: {
          documentId: docId,
          revision: rev,
          sourceId: srcId,
          quote: `Unique queue passage number ${i} for limit verification.`,
        },
      });
      assert.equal(res.ok, true);
      assert.equal(res.value?.status, 'saved');
    }

    const overflow = await host.call('materials.marks.save', {
      documentId: docId,
      revision: rev,
      sourceId: srcId,
      style: 'queue',
      selection: {
        documentId: docId,
        revision: rev,
        sourceId: srcId,
        quote: 'Unique queue passage number 41 for limit verification.',
      },
    });
    assert.equal(overflow.ok, true);
    assert.equal(overflow.value?.status, 'queue-full');
    assert.equal(overflow.value?.limit, 40);
  });
});
