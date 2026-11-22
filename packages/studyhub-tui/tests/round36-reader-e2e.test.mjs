// Round 36 Reader Lazy-Split & Web-Parity Reading Progress E2E:
// `node --test tests/round36-reader-e2e.test.mjs`
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round36-${label}-`));
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

describe('StudyHub TUI Round 36 Reader Lazy-Split & Reading Progress E2E', () => {
  let boxDir;
  let dshHome;
  let libraryRoot;
  let host;
  let docInfo;
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

    const mdPath = join(boxDir, 'r36-guide.md');
    await writeFile(
      mdPath,
      [
        '# Chapter 1: Fundamentals',
        '',
        'Core definitions and axioms for Round 36 reading progress verification.',
        '',
        '# Chapter 2: Algorithms',
        '',
        'Divide and conquer recurrence relations and dynamic programming.',
        '',
        '# Chapter 3: Practice',
        '',
        'Worked examples and checkpoint exercises.',
        '',
      ].join('\n'),
      'utf8',
    );

    const impRes = await host.call('materials.document.import', {
      path: mdPath,
      title: 'R36 Reading Progress Guide',
      format: 'md',
    });
    assert.equal(impRes.ok, true, `materials.document.import failed: ${impRes.error?.message || ''}`);
    docInfo = impRes.value;
    assert.ok(docInfo?.documentId, 'Imported document must have documentId');
    assert.ok(Array.isArray(docInfo?.sourceIds) && docInfo.sourceIds.length > 0, 'Imported document must have sourceIds');
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

  test('1) dist/ lazy-splits ReaderOutlineDrawer & ReaderNotesDrawer into separate chunks', async () => {
    const outlineChunk = distFiles.find((f) => f.startsWith('ReaderOutlineDrawer-') && f.endsWith('.mjs'));
    const notesChunk = distFiles.find((f) => f.startsWith('ReaderNotesDrawer-') && f.endsWith('.mjs'));
    const readerChunk = distFiles.find((f) => f.startsWith('DocumentReader-') && f.endsWith('.mjs'));

    assert.ok(outlineChunk, 'Expected separate ReaderOutlineDrawer-*.mjs chunk in dist/');
    assert.ok(notesChunk, 'Expected separate ReaderNotesDrawer-*.mjs chunk in dist/');
    assert.ok(readerChunk, 'Expected DocumentReader-*.mjs chunk in dist/');

    const readerCode = await readFile(join(distDir, readerChunk), 'utf8');
    // DocumentReader chunk (and its imported shared chunk if tiny wrapper) must not inline drawer UI strings
    assert.equal(readerCode.includes('Document Outline'), false, 'DocumentReader chunk must not inline ReaderOutlineDrawer');
    assert.equal(readerCode.includes('Annotations & Marks'), false, 'DocumentReader chunk must not inline ReaderNotesDrawer');
  });

  test('2) createTuiHost materials.reading.get & materials.reading.save lifecycle', async () => {
    // Add a multi-page document via source.add + materials.outline.save to verify multi-page chapter refs
    const src1Res = await host.call('source.add', {
      title: 'R36 MultiPage Ch1',
      text: 'Page 1 content covering foundational definitions and notation.',
    });
    assert.equal(src1Res.ok, true, `source.add p1 failed: ${src1Res.error?.message || ''}`);
    const src1Id = src1Res.value?.source?.id || src1Res.value?.id;
    assert.ok(src1Id, 'src1Id must exist');

    const chapters = [
      { id: 'ch-1', title: 'Chapter 1: Foundations', startPage: 1, endPage: 2 },
      { id: 'ch-2', title: 'Chapter 2: Applications', startPage: 3, endPage: 5 },
    ];

    const get0 = await host.call('materials.reading.get', {
      documentId: docInfo.documentId,
      sourceId: docInfo.sourceIds[0],
      revision: docInfo.revision,
      chapters,
    });
    assert.equal(get0.ok, true, `materials.reading.get initial failed: ${get0.error?.message || ''}`);
    assert.deepEqual(get0.value?.read, [], 'Initially 0 chapters should be read');
    assert.equal(get0.value?.count, 0);

    const saveRead = await host.call('materials.reading.save', {
      documentId: docInfo.documentId,
      sourceId: docInfo.sourceIds[0],
      revision: docInfo.revision,
      chapters,
      read: [chapters[0]],
      unread: [],
    });
    assert.equal(saveRead.ok, true, `materials.reading.save read failed: ${saveRead.error?.message || ''}`);
    assert.equal(saveRead.value?.saved, true);
    assert.deepEqual(saveRead.value?.read, ['ch-1']);

    const get1 = await host.call('materials.reading.get', {
      documentId: docInfo.documentId,
      sourceId: docInfo.sourceIds[0],
      revision: docInfo.revision,
      chapters,
    });
    assert.equal(get1.ok, true, `materials.reading.get after save failed: ${get1.error?.message || ''}`);
    assert.deepEqual(get1.value?.read, ['ch-1']);
    assert.equal(get1.value?.count, 1);

    const saveUnread = await host.call('materials.reading.save', {
      documentId: docInfo.documentId,
      sourceId: docInfo.sourceIds[0],
      revision: docInfo.revision,
      chapters,
      read: [],
      unread: [chapters[0]],
    });
    assert.equal(saveUnread.ok, true, `materials.reading.save unread failed: ${saveUnread.error?.message || ''}`);
    assert.equal(saveUnread.value?.saved, true);
    assert.deepEqual(saveUnread.value?.read, []);

    const get2 = await host.call('materials.reading.get', {
      documentId: docInfo.documentId,
      sourceId: docInfo.sourceIds[0],
      revision: docInfo.revision,
      chapters,
    });
    assert.equal(get2.ok, true, `materials.reading.get after unread failed: ${get2.error?.message || ''}`);
    assert.deepEqual(get2.value?.read, []);
    assert.equal(get2.value?.count, 0);

    // Legacy single-source reading progress test
    const legacyCh = [{ id: 'md-1-1', title: 'R36 MultiPage Ch1', startPage: 1, endPage: 1 }];
    const legRead = await host.call('materials.reading.save', {
      sourceId: src1Id,
      chapters: legacyCh,
      read: legacyCh,
      unread: [],
    });
    assert.equal(legRead.ok, true, `legacy materials.reading.save failed: ${legRead.error?.message || ''}`);
    assert.deepEqual(legRead.value?.read, ['md-1-1']);
  });

  test('3) PTY E2E: DocumentReader + lazy Outline/Notes drawers + chapter reading progress (default & --ascii)', async () => {
    // 3a) Default mode (zh, asciiMode=false)
    const tty = await mountApp({ initialPage: 'sources', asciiMode: false, language: 'zh' });
    await tty.waitFor(
      (s) => s.includes('R36 Reading Progress') && !s.includes('正在加载页面'),
      { timeoutMs: 10_000, label: 'SourcesView rendered with imported R36 guide' },
    );

    // Filter to R36 guide to guarantee selection regardless of list order, then open DocumentReader
    tty.send('/');
    await tty.waitFor((s) => s.includes('搜索') || s.includes('Search'), { label: 'Sources filter bar' });
    tty.send('R36 Reading');
    await tty.waitFor((s) => s.includes('R36 Reading'), { label: 'Filter typed' });
    tty.send('\r');
    await tty.waitFor(
      (s) => s.includes('R36 Reading Progress Guide') && s.includes('MD'),
      { timeoutMs: 5_000, label: 'R36 Reading Progress Guide selected after filter' },
    );

    tty.send('\r');
    const readerInit = await tty.waitFor(
      (s) =>
        s.includes('R36 Reading Progress Guide') &&
        s.includes('✓ 0/3') &&
        s.includes('未读') &&
        (s.includes('第 1 /') || s.includes('P. 1 /')),
      { timeoutMs: 10_000, label: 'DocumentReader opened with 0/3 reading progress' },
    );
    tty.assertHealthyScreen(readerInit, 120, 36, 'DocumentReader initial (default mode)');

    // Press 'M' to mark current chapter (Chapter 3, last matching on page 1) as read -> 1/3
    tty.send('M');
    const afterMark = await tty.waitFor(
      (s) => s.includes('✓ 1/3') && s.includes('已读'),
      { timeoutMs: 8_000, label: 'DocumentReader header updated to 1/3 read after M' },
    );
    tty.assertHealthyScreen(afterMark, 120, 36, 'DocumentReader after M toggle');

    // Press 'O' -> lazy ReaderOutlineDrawer
    tty.send('O');
    const outlineScreen = await tty.waitFor(
      (s) =>
        s.includes('文档目录大纲') &&
        s.includes('Chapter 1: Fundamentals') &&
        s.includes('Chapter 2: Algorithms') &&
        s.includes('✓ 1/3') &&
        !s.includes('正在读取目录结构'),
      { timeoutMs: 8_000, label: 'Lazy ReaderOutlineDrawer rendered with reading indicators' },
    );
    tty.assertHealthyScreen(outlineScreen, 120, 36, 'ReaderOutlineDrawer default mode');
    assert.ok(outlineScreen.includes('○ Chapter 1: Fundamentals'), 'Chapter 1 should show ○ unread');
    assert.ok(outlineScreen.includes('✓ Chapter 3: Practice'), 'Chapter 3 should show ✓ read');

    // Press Space on first row (Chapter 1) to mark it read -> 2/3
    tty.send(' ');
    const outlineMarked = await tty.waitFor(
      (s) => s.includes('✓ 2/3') && s.includes('✓ Chapter 1: Fundamentals'),
      { timeoutMs: 8_000, label: 'ReaderOutlineDrawer toggled Chapter 1 read via Space' },
    );
    tty.assertHealthyScreen(outlineMarked, 120, 36, 'ReaderOutlineDrawer after Space');

    // Close ReaderOutlineDrawer
    tty.send('\x1b');
    const afterOutlineClose = await tty.waitFor(
      (s) => !s.includes('文档目录大纲') && s.includes('✓ 2/3'),
      { timeoutMs: 8_000, label: 'ReaderOutlineDrawer closed with 2/3 progress preserved' },
    );
    tty.assertHealthyScreen(afterOutlineClose, 120, 36, 'DocumentReader after Outline close');

    // Press 'B' -> lazy ReaderNotesDrawer
    tty.send('B');
    const notesScreen = await tty.waitFor(
      (s) => s.includes('批注问答与高亮标记') && !s.includes('正在加载批注与标记'),
      { timeoutMs: 8_000, label: 'Lazy ReaderNotesDrawer rendered' },
    );
    tty.assertHealthyScreen(notesScreen, 120, 36, 'ReaderNotesDrawer default mode');

    // Close ReaderNotesDrawer
    tty.send('\x1b');
    await tty.waitFor(
      (s) => !s.includes('批注问答与高亮标记') && s.includes('✓ 2/3'),
      { timeoutMs: 8_000, label: 'ReaderNotesDrawer closed cleanly' },
    );

    // 3b) --ascii mode (en, asciiMode=true)
    const asciiTty = await mountApp({ initialPage: 'sources', asciiMode: true, language: 'en' });
    await asciiTty.waitFor(
      (s) => s.includes('R36 Reading Progress') && !s.includes('Loading'),
      { timeoutMs: 10_000, label: 'ASCII SourcesView rendered' },
    );

    asciiTty.send('/');
    await asciiTty.waitFor((s) => s.includes('Filter') || s.includes('Search'), { label: 'ASCII filter bar' });
    asciiTty.send('R36 Reading');
    await asciiTty.waitFor((s) => s.includes('R36 Reading'), { label: 'ASCII filter typed' });
    asciiTty.send('\r');
    await asciiTty.waitFor(
      (s) => s.includes('R36 Reading Progress Guide') && s.includes('MD'),
      { timeoutMs: 5_000, label: 'R36 Reading Progress Guide selected in ASCII mode' },
    );

    asciiTty.send('\r');
    const asciiReader = await asciiTty.waitFor(
      (s) =>
        s.includes('R36 Reading Progress Guide') &&
        s.includes('OK 2/3 (Read)') &&
        (s.includes('P. 1 /') || s.includes('P.1 /')),
      { timeoutMs: 10_000, label: 'ASCII DocumentReader opened with OK 2/3 (Read)' },
    );
    asciiTty.assertHealthyScreen(asciiReader, 120, 36, 'ASCII DocumentReader 120x36');
    asciiTty.assertAsciiPure(asciiReader, 'ASCII DocumentReader 120x36');

    // Open lazy ReaderOutlineDrawer in --ascii mode and verify [x] / [ ] indicators
    asciiTty.send('O');
    const asciiOutline = await asciiTty.waitFor(
      (s) =>
        s.includes('Document Outline') &&
        s.includes('OK 2/3') &&
        s.includes('[x] Chapter 1: Fundamentals') &&
        s.includes('[ ] Chapter 2: Algorithms') &&
        !s.includes('Loading outline'),
      { timeoutMs: 8_000, label: 'ASCII ReaderOutlineDrawer rendered' },
    );
    asciiTty.assertHealthyScreen(asciiOutline, 120, 36, 'ASCII ReaderOutlineDrawer 120x36');
    asciiTty.assertAsciiPure(asciiOutline, 'ASCII ReaderOutlineDrawer 120x36');

    // Press 'm' in ReaderOutlineDrawer on Chapter 1 to toggle unread -> OK 1/3 & [ ] Chapter 1
    asciiTty.send('m');
    const asciiOutlineUnmarked = await asciiTty.waitFor(
      (s) => s.includes('OK 1/3') && s.includes('[ ] Chapter 1: Fundamentals'),
      { timeoutMs: 8_000, label: 'ASCII ReaderOutlineDrawer toggled Chapter 1 unread via m' },
    );
    asciiTty.assertHealthyScreen(asciiOutlineUnmarked, 120, 36, 'ASCII ReaderOutlineDrawer after m');
    asciiTty.assertAsciiPure(asciiOutlineUnmarked, 'ASCII ReaderOutlineDrawer after m');

    asciiTty.send('\x1b');
    await asciiTty.waitFor(
      (s) => !s.includes('Document Outline') && s.includes('OK 1/3'),
      { timeoutMs: 8_000, label: 'ASCII ReaderOutlineDrawer closed' },
    );

    // Open & close lazy ReaderNotesDrawer in --ascii mode
    asciiTty.send('B');
    const asciiNotes = await asciiTty.waitFor(
      (s) => s.includes('Annotations & Marks') && !s.includes('Loading annotations'),
      { timeoutMs: 8_000, label: 'ASCII ReaderNotesDrawer rendered' },
    );
    asciiTty.assertHealthyScreen(asciiNotes, 120, 36, 'ASCII ReaderNotesDrawer 120x36');
    asciiTty.assertAsciiPure(asciiNotes, 'ASCII ReaderNotesDrawer 120x36');

    asciiTty.send('\x1b');
    await asciiTty.waitFor(
      (s) => !s.includes('Annotations & Marks') && s.includes('OK 1/3'),
      { timeoutMs: 8_000, label: 'ASCII ReaderNotesDrawer closed' },
    );

    // Resize DocumentReader to 80x24 and verify health & ASCII purity
    asciiTty.resize(80, 24);
    const asciiNarrow = await asciiTty.waitFor(
      (s) => s.includes('OK 1/3') && s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'ASCII DocumentReader resized to 80x24' },
    );
    asciiTty.assertHealthyScreen(asciiNarrow, 80, 24, 'ASCII DocumentReader 80x24');
    asciiTty.assertAsciiPure(asciiNarrow, 'ASCII DocumentReader 80x24');

    await unmountActiveApp();
  });
});
