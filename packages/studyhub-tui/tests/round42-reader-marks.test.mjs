// Round 42 Reader Marks Lifecycle & PTY E2E:
// `node --test tests/round42-reader-marks.test.mjs`
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
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round42-marks-${label}-`));
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

describe('StudyHub TUI Round 42 Reading Marks Lifecycle & PTY E2E', () => {
  let boxDir;
  let dshHome;
  let libraryRoot;
  let host;
  let e2eDoc;
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

  test('1) createTuiHost marks lifecycle: save -> list -> seen (rereadAt) -> reread query -> delete & stale purge', async () => {
    const v1Path = join(boxDir, 'r42-host-v1.md');
    await writeFile(
      v1Path,
      [
        '# Chapter 1: Invariants',
        '',
        'A loop invariant holds before the loop begins and after every iteration.',
        '',
        'Termination guarantees the algorithm finishes in finite steps.',
        '',
      ].join('\n'),
      'utf8',
    );

    const impV1 = await host.call('materials.document.import', {
      path: v1Path,
      title: 'R42 Host Marks Guide',
      format: 'md',
    });
    assert.equal(impV1.ok, true, `import v1 failed: ${impV1.error?.message || ''}`);
    const docId = impV1.value.documentId;
    const rev1 = impV1.value.revision;
    const src1 = impV1.value.sourceIds[0];

    // Save two marks on v1
    const save1 = await host.call('materials.marks.save', {
      documentId: docId,
      revision: rev1,
      style: 'highlight',
      selection: {
        documentId: docId,
        revision: rev1,
        sourceId: src1,
        quote: 'loop invariant holds before the loop begins',
      },
    });
    assert.equal(save1.ok, true, `marks.save 1 failed: ${save1.error?.message || ''}`);
    assert.equal(save1.value?.status, 'saved');
    const mark1Id = save1.value?.item?.id;
    assert.ok(mark1Id, 'Saved mark 1 must have id');

    const save2 = await host.call('materials.marks.save', {
      documentId: docId,
      revision: rev1,
      style: 'bold',
      selection: {
        documentId: docId,
        revision: rev1,
        sourceId: src1,
        quote: 'Termination guarantees the algorithm finishes',
      },
    });
    assert.equal(save2.ok, true, `marks.save 2 failed: ${save2.error?.message || ''}`);
    assert.equal(save2.value?.status, 'saved');
    const mark2Id = save2.value?.item?.id;
    assert.ok(mark2Id, 'Saved mark 2 must have id');

    // Verify in materials.marks.list
    const list1 = await host.call('materials.marks.list', { documentId: docId, revision: rev1 });
    assert.equal(list1.ok, true);
    assert.equal(list1.value?.count, 2);
    assert.equal(list1.value?.items?.find((m) => m.id === mark1Id)?.rereadAt, undefined);

    // Mark #1 as reread via materials.marks.seen
    const seenRes = await host.call('materials.marks.seen', {
      documentId: docId,
      revision: rev1,
      id: mark1Id,
    });
    assert.equal(seenRes.ok, true, `marks.seen failed: ${seenRes.error?.message || ''}`);
    assert.equal(seenRes.value?.status, 'saved');
    assert.ok(seenRes.value?.item?.rereadAt, 'materials.marks.seen must set rereadAt');
    assert.ok(Number.isFinite(Date.parse(seenRes.value.item.rereadAt)), 'rereadAt must be valid ISO timestamp');

    const list2 = await host.call('materials.marks.list', { documentId: docId, revision: rev1 });
    assert.equal(list2.ok, true);
    assert.equal(
      list2.value?.items?.find((m) => m.id === mark1Id)?.rereadAt,
      seenRes.value.item.rereadAt,
      'materials.marks.list must persist rereadAt',
    );

    // Verify library-level materials.marks.reread query responds cleanly
    const rereadList = await host.call('materials.marks.reread', {});
    assert.equal(rereadList.ok, true, `marks.reread failed: ${rereadList.error?.message || ''}`);
    assert.ok(Array.isArray(rereadList.value?.items));
    assert.equal(typeof rereadList.value?.count, 'number');

    // Delete mark #1
    const del1 = await host.call('materials.marks.delete', {
      documentId: docId,
      revision: rev1,
      ids: [mark1Id],
    });
    assert.equal(del1.ok, true, `marks.delete failed: ${del1.error?.message || ''}`);
    assert.equal(del1.value?.deleted, 1);

    const list3 = await host.call('materials.marks.list', { documentId: docId, revision: rev1 });
    assert.equal(list3.ok, true);
    assert.equal(list3.value?.count, 1);
    assert.equal(list3.value?.items?.some((m) => m.id === mark1Id), false);

    // Re-import a new revision onto the same documentId where mark2's quote was rewritten -> becomes stale
    const v2Path = join(boxDir, 'r42-host-v2.md');
    await writeFile(
      v2Path,
      [
        '# Chapter 1: Invariants (Revised)',
        '',
        'Completely rewritten chapter text with no matching prior quotes.',
        '',
      ].join('\n'),
      'utf8',
    );
    const impV2 = await host.call('materials.document.import', {
      documentId: docId,
      path: v2Path,
      title: 'R42 Host Marks Guide',
      format: 'md',
    });
    assert.equal(impV2.ok, true, `import v2 failed: ${impV2.error?.message || ''}`);
    const rev2 = impV2.value.revision;
    assert.notEqual(rev2, rev1);

    const listStale = await host.call('materials.marks.list', { documentId: docId, revision: rev2 });
    assert.equal(listStale.ok, true);
    assert.ok(Array.isArray(listStale.value?.stale) && listStale.value.stale.length > 0, 'Expected stale marks from v1');
    assert.equal(listStale.value.stale[0].count, 1);

    // Purge stale marks
    const purgeRes = await host.call('materials.marks.delete', {
      documentId: docId,
      revision: rev2,
      stale: true,
    });
    assert.equal(purgeRes.ok, true, `marks.delete stale failed: ${purgeRes.error?.message || ''}`);
    assert.equal(purgeRes.value?.deleted, 1);
    assert.equal(purgeRes.value?.stale, true);

    const listAfterPurge = await host.call('materials.marks.list', { documentId: docId, revision: rev2 });
    assert.equal(listAfterPurge.ok, true);
    assert.deepEqual(listAfterPurge.value?.stale, []);
  });

  test('2) PTY E2E: ReaderNotesDrawer Marks tab [r] reread, [d] delete & [S] stale purge (default zh & --ascii en)', async () => {
    // Prepare a dedicated E2E document with 1 stale mark (v1) + 1 active mark (v2)
    const e2eV1 = join(boxDir, 'r42-e2e-v1.md');
    await writeFile(
      e2eV1,
      '# E2E Marks v1\n\nLegacy passage from revision one that will become stale.\n',
      'utf8',
    );
    const imp1 = await host.call('materials.document.import', {
      path: e2eV1,
      title: 'R42 E2E Marks Doc',
      format: 'md',
    });
    assert.equal(imp1.ok, true);
    const docId = imp1.value.documentId;
    await host.call('materials.marks.save', {
      documentId: docId,
      revision: imp1.value.revision,
      style: 'underline',
      selection: {
        documentId: docId,
        revision: imp1.value.revision,
        sourceId: imp1.value.sourceIds[0],
        quote: 'Legacy passage from revision one',
      },
    });

    const e2eV2 = join(boxDir, 'r42-e2e-v2.md');
    await writeFile(
      e2eV2,
      '# E2E Marks v2\n\nAlpha highlight passage for Round 42 PTY verification.\n',
      'utf8',
    );
    const imp2 = await host.call('materials.document.import', {
      documentId: docId,
      path: e2eV2,
      title: 'R42 E2E Marks Doc',
      format: 'md',
    });
    assert.equal(imp2.ok, true);
    e2eDoc = imp2.value;

    const saveZhMark = await host.call('materials.marks.save', {
      documentId: docId,
      revision: e2eDoc.revision,
      style: 'highlight',
      selection: {
        documentId: docId,
        revision: e2eDoc.revision,
        sourceId: e2eDoc.sourceIds[0],
        quote: 'Alpha highlight passage for Round 42',
      },
    });
    assert.equal(saveZhMark.ok, true);
    assert.equal(saveZhMark.value?.status, 'saved');

    // 2a) Default mode (zh, asciiMode=false)
    const tty = await mountApp({ initialPage: 'sources', asciiMode: false, language: 'zh' });
    await tty.waitFor(
      (s) => s.includes('R42 E2E Marks Doc') && !s.includes('正在加载页面'),
      { timeoutMs: 10_000, label: 'SourcesView rendered with R42 E2E Marks Doc' },
    );

    tty.send('/');
    await tty.waitFor((s) => s.includes('搜索') || s.includes('Search'), { label: 'Sources filter bar' });
    tty.send('R42 E2E Marks');
    await tty.waitFor((s) => s.includes('R42 E2E Marks'), { label: 'Filter typed' });
    tty.send('\r');
    await tty.waitFor(
      (s) => s.includes('R42 E2E Marks Doc') && s.includes('MD'),
      { timeoutMs: 5_000, label: 'R42 E2E Marks Doc selected' },
    );

    // Open DocumentReader then ReaderNotesDrawer ('B'), switch to Marks tab ('\t')
    tty.send('\r');
    await tty.waitFor(
      (s) =>
        s.includes('R42 E2E Marks Doc') &&
        s.includes('Alpha highlight passage') &&
        (s.includes('B  批注') || s.includes('O  目录')),
      { timeoutMs: 10_000, label: 'DocumentReader opened R42 E2E Marks Doc' },
    );

    tty.send('B');
    await tty.waitFor(
      (s) => s.includes('批注问答与高亮标记') && !s.includes('正在加载批注与标记'),
      { timeoutMs: 8_000, label: 'ReaderNotesDrawer opened' },
    );

    tty.send('\t');
    const marksTabScreen = await tty.waitFor(
      (s) =>
        s.includes('高亮标记 (1)') &&
        s.includes('Alpha highlight passage') &&
        s.includes('旧版标记 1'),
      { timeoutMs: 8_000, label: 'Marks tab rendered with saved mark and stale count' },
    );
    tty.assertHealthyScreen(marksTabScreen, 120, 36, 'ReaderNotesDrawer Marks tab (zh)');

    // Press 'r' to mark as reread
    tty.send('r');
    const afterRereadScreen = await tty.waitFor(
      (s) => s.includes('[已重读]') && s.includes('重读时间'),
      { timeoutMs: 8_000, label: 'Mark marked as reread with [已重读] badge' },
    );
    tty.assertHealthyScreen(afterRereadScreen, 120, 36, 'ReaderNotesDrawer after [r] reread (zh)');

    // Press 'd' to open Delete ConfirmDialog, then cancel with 'n'
    tty.send('d');
    const deleteConfirmScreen = await tty.waitFor(
      (s) => s.includes('删除标记') && s.includes('确定要删除这条标记吗'),
      { timeoutMs: 5_000, label: 'Delete Mark ConfirmDialog opened (zh)' },
    );
    tty.assertHealthyScreen(deleteConfirmScreen, 120, 36, 'Delete Mark ConfirmDialog (zh)');

    tty.send('n');
    const afterCancelScreen = await tty.waitFor(
      (s) => !s.includes('确定要删除这条标记吗') && s.includes('高亮标记 (1)') && s.includes('Alpha highlight passage'),
      { timeoutMs: 5_000, label: 'Delete Mark ConfirmDialog cancelled cleanly (zh)' },
    );
    tty.assertHealthyScreen(afterCancelScreen, 120, 36, 'ReaderNotesDrawer after cancel delete (zh)');

    // Press 'd' again and confirm with 'y'
    tty.send('d');
    await tty.waitFor((s) => s.includes('删除标记'), { timeoutMs: 5_000, label: 'Delete Mark ConfirmDialog reopened' });
    tty.send('y');
    const afterDeleteScreen = await tty.waitFor(
      (s) => s.includes('高亮标记 (0)') && s.includes('暂无高亮标记'),
      { timeoutMs: 8_000, label: 'Mark deleted cleanly after ConfirmDialog confirm (zh)' },
    );
    tty.assertHealthyScreen(afterDeleteScreen, 120, 36, 'ReaderNotesDrawer after delete confirm (zh)');

    // Press 'S' to open Purge Stale Marks ConfirmDialog and confirm with 'y'
    tty.send('S');
    const purgeDialogScreen = await tty.waitFor(
      (s) => s.includes('清除旧版本标记') && s.includes('失效标记'),
      { timeoutMs: 5_000, label: 'Purge Stale Marks ConfirmDialog opened (zh)' },
    );
    tty.assertHealthyScreen(purgeDialogScreen, 120, 36, 'Purge Stale ConfirmDialog (zh)');

    tty.send('y');
    const afterPurgeScreen = await tty.waitFor(
      (s) => !s.includes('清除旧版本标记') && !s.includes('旧版标记 1'),
      { timeoutMs: 8_000, label: 'Stale marks purged cleanly (zh)' },
    );
    tty.assertHealthyScreen(afterPurgeScreen, 120, 36, 'ReaderNotesDrawer after stale purge (zh)');

    tty.send('\x1b');
    await tty.waitFor((s) => !s.includes('批注问答与高亮标记'), { timeoutMs: 5_000, label: 'Drawer closed (zh)' });

    // 2b) --ascii mode (en, asciiMode=true)
    const saveEnMark = await host.call('materials.marks.save', {
      documentId: docId,
      revision: e2eDoc.revision,
      style: 'bold',
      selection: {
        documentId: docId,
        revision: e2eDoc.revision,
        sourceId: e2eDoc.sourceIds[0],
        quote: 'Alpha highlight passage for Round 42',
      },
    });
    assert.equal(saveEnMark.ok, true);

    const asciiTty = await mountApp({ initialPage: 'sources', asciiMode: true, language: 'en' });
    await asciiTty.waitFor(
      (s) => s.includes('R42 E2E Marks Doc') && !s.includes('Loading'),
      { timeoutMs: 10_000, label: 'ASCII SourcesView rendered' },
    );

    asciiTty.send('/');
    await asciiTty.waitFor((s) => s.includes('Filter') || s.includes('Search'), { label: 'ASCII filter bar' });
    asciiTty.send('R42 E2E Marks');
    await asciiTty.waitFor((s) => s.includes('R42 E2E Marks'), { label: 'ASCII filter typed' });
    asciiTty.send('\r');
    await asciiTty.waitFor(
      (s) => s.includes('R42 E2E Marks Doc') && s.includes('MD'),
      { timeoutMs: 5_000, label: 'ASCII R42 E2E Marks Doc selected' },
    );

    asciiTty.send('\r');
    await asciiTty.waitFor(
      (s) =>
        s.includes('R42 E2E Marks Doc') &&
        s.includes('Alpha highlight passage') &&
        (s.includes('B  Notes') || s.includes('O  Outline')),
      { timeoutMs: 10_000, label: 'ASCII DocumentReader opened' },
    );

    asciiTty.send('B');
    await asciiTty.waitFor(
      (s) => s.includes('Annotations & Marks') && !s.includes('Loading annotations'),
      { timeoutMs: 8_000, label: 'ASCII ReaderNotesDrawer opened' },
    );

    asciiTty.send('\t');
    const asciiMarksTab = await asciiTty.waitFor(
      (s) => s.includes('Marks (1)') && s.includes('Alpha highlight passage'),
      { timeoutMs: 8_000, label: 'ASCII Marks tab rendered' },
    );
    asciiTty.assertHealthyScreen(asciiMarksTab, 120, 36, 'ASCII Marks tab 120x36');
    asciiTty.assertAsciiPure(asciiMarksTab, 'ASCII Marks tab 120x36');

    // [r] reread in --ascii mode
    asciiTty.send('r');
    const asciiReread = await asciiTty.waitFor(
      (s) => s.includes('[Reread]') && s.includes('Marked as reread'),
      { timeoutMs: 8_000, label: 'ASCII Mark marked as reread' },
    );
    asciiTty.assertHealthyScreen(asciiReread, 120, 36, 'ASCII Marks tab after [r]');
    asciiTty.assertAsciiPure(asciiReread, 'ASCII Marks tab after [r]');

    // [d] Delete ConfirmDialog cancel + confirm in --ascii mode
    asciiTty.send('d');
    const asciiDeletePrompt = await asciiTty.waitFor(
      (s) => s.includes('Delete Mark') && s.includes('Delete this mark?'),
      { timeoutMs: 5_000, label: 'ASCII Delete Mark ConfirmDialog opened' },
    );
    asciiTty.assertHealthyScreen(asciiDeletePrompt, 120, 36, 'ASCII Delete Mark ConfirmDialog');
    asciiTty.assertAsciiPure(asciiDeletePrompt, 'ASCII Delete Mark ConfirmDialog');

    asciiTty.send('n');
    await asciiTty.waitFor(
      (s) => !s.includes('Delete this mark?') && s.includes('Marks (1)'),
      { timeoutMs: 5_000, label: 'ASCII Delete Mark cancelled' },
    );

    asciiTty.send('d');
    await asciiTty.waitFor((s) => s.includes('Delete Mark'), { timeoutMs: 5_000, label: 'ASCII Delete Mark reopened' });
    asciiTty.send('y');
    const asciiAfterDelete = await asciiTty.waitFor(
      (s) => s.includes('Marks (0)') && s.includes('No marks yet'),
      { timeoutMs: 8_000, label: 'ASCII Mark deleted cleanly' },
    );
    asciiTty.assertHealthyScreen(asciiAfterDelete, 120, 36, 'ASCII Marks tab after delete');
    asciiTty.assertAsciiPure(asciiAfterDelete, 'ASCII Marks tab after delete');

    // Resize to 80x24 and verify health & ASCII purity
    asciiTty.resize(80, 24);
    const asciiNarrow = await asciiTty.waitFor(
      (s) => s.includes('Annotations & Marks') && s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'ASCII ReaderNotesDrawer resized to 80x24' },
    );
    asciiTty.assertHealthyScreen(asciiNarrow, 80, 24, 'ASCII ReaderNotesDrawer 80x24');
    asciiTty.assertAsciiPure(asciiNarrow, 'ASCII ReaderNotesDrawer 80x24');

    await unmountActiveApp();
  });
});
