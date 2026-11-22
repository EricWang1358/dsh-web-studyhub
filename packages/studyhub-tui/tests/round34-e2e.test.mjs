// Round 34 BookView Structure Management E2E verification:
// node --test tests/round34-e2e.test.mjs
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import xtermPkg from '@xterm/headless';
import { render } from 'ink';
import React from 'react';
import { StudyService } from '../../../lib/service.js';
import { courseOutlineMaterial, materialsFingerprint } from '../../../lib/course-outline-book.js';
import { courseNotesMaterial } from '../../../lib/course-book.js';
import { buildOutlineIndex } from '../../../lib/course-outline-index.js';
import { groupSourcesByDocument } from '../../../lib/source-groups.js';
import { openCourseBook } from '../../../lib/course-book-files.js';

const { Terminal } = xtermPkg;
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const distDir = resolve(pkgRoot, 'dist');

const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const { StudyHubTuiApp } = await import(pathToFileURL(join(distDir, 'App.mjs')).href);

let createTuiHost = null;
let saveTuiPreferences = null;
let displayWidth = null;
let useTuiStore = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('chunk-') || f.startsWith('store-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!createTuiHost && typeof mod.createTuiHost === 'function') createTuiHost = mod.createTuiHost;
    if (!saveTuiPreferences && typeof mod.saveTuiPreferences === 'function') saveTuiPreferences = mod.saveTuiPreferences;
    if (!displayWidth && typeof mod.displayWidth === 'function') displayWidth = mod.displayWidth;
    if (!useTuiStore && typeof mod.useTuiStore?.getState === 'function') useTuiStore = mod.useTuiStore;
  }
}
assert.ok(createTuiHost, 'dist/ must export createTuiHost');
assert.ok(saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(displayWidth, 'dist/ must export displayWidth');
assert.ok(useTuiStore, 'dist/ must export useTuiStore');

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round34-${label}-`));
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
    for (let i = 0; i < lines.length; i += 1) {
      const w = displayWidth(lines[i]);
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

const BOOK_COURSE = 'StructArch';

async function seedBookLibrary(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.store.update((state) => {
    state.sources.push(
      {
        id: 'doc1-p1',
        title: 'Lecture 1 · p. 1',
        createdAt: '2026-10-01T00:00:00.000Z',
        courses: [BOOK_COURSE],
        text: 'Alpha Architecture defines components and connectors.',
        document: {
          materialId: 'doc-l1',
          page: 1,
          totalPages: 2,
          format: 'pdf',
          origin: 'converted',
          converter: 'marker',
          filename: 'lecture-1.pdf',
          chapter: { index: 0, title: 'Alpha Basics', level: 1 },
          extractionVersion: 2,
        },
      },
      {
        id: 'doc1-p2',
        title: 'Lecture 1 · p. 2',
        createdAt: '2026-10-01T01:00:00.000Z',
        courses: [BOOK_COURSE],
        text: 'Beta Boundaries separate domain rules from infrastructure.',
        document: {
          materialId: 'doc-l1',
          page: 2,
          totalPages: 2,
          format: 'pdf',
          origin: 'converted',
          converter: 'marker',
          filename: 'lecture-1.pdf',
          chapter: { index: 1, title: 'Beta Boundaries', level: 1 },
          extractionVersion: 2,
        },
      },
    );
    state.focus = { mode: 'class', course: BOOK_COURSE, role: '', jd: '', targetTopics: [] };
    const lecture = groupSourcesByDocument(state.sources).find((item) => item.sourceIds.includes('doc1-p1')).key;
    const leaves = [
      { id: 'alpha', title: 'Alpha Basics', anchors: [`${lecture}#0`] },
      { id: 'beta', title: 'Beta Boundaries', anchors: [`${lecture}#1`] },
    ];
    const outline = {
      ...courseOutlineMaterial({
        title: 'Outline · StructArch',
        course: BOOK_COURSE,
        orderBasis: { codes: ['numbering'] },
        fingerprint: materialsFingerprint(buildOutlineIndex(state, { course: BOOK_COURSE }).allDocuments),
        nodes: [{ id: 'ch1', title: 'Core Architecture', children: leaves }],
        other: { anchors: [] },
        counts: { units: 2, leftover: 0, invalid: 0, repeated: 0 },
      }),
      createdAt: '2026-10-09T00:00:00.000Z',
    };
    state.sources.push(outline);
    state.sources.push({
      ...courseNotesMaterial({
        title: 'Review Book · StructArch',
        course: BOOK_COURSE,
        outlineId: outline.id,
        language: 'zh',
        papers: [],
        counts: {},
        leaves: leaves.map((leaf, idx) => ({
          ...leaf,
          body: {
            fingerprint: 'a'.repeat(16),
            points: [`${leaf.title} key point [^1].`],
            explain: `Detailed notes for ${leaf.title}.`,
            cites: [{ n: 1, sourceId: idx === 0 ? 'doc1-p1' : 'doc1-p2', quote: 'Alpha', start: 0, end: 5 }],
          },
        })),
      }),
      createdAt: '2026-10-09T01:00:00.000Z',
    });
    openCourseBook(state, { course: BOOK_COURSE });
    const record = state.sources.find((s) => s.provenance === 'course-book-doc');
    record.bookDoc.files['beta.mine.md'] = { version: 1, text: 'My custom note on Beta Boundaries.' };
  });
  await service.dispose();
}

describe('Round 34: BookView structure management host integration & PTY E2E', () => {
  after(async () => {
    if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = PREV_DSH_HOME;
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
  });

  test('1) createTuiHost integration: course.book.open -> rename -> move -> delete -> revert -> rebuild undo', async () => {
    const base = await makeTempDir('host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');
    await seedBookLibrary(libraryRoot);

    let host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
    });

    try {
      const open0 = await host.call('course.book.open', { course: BOOK_COURSE, language: 'zh' });
      assert.equal(open0.ok, true, open0.error?.message);
      assert.equal(open0.value.status, 'ok');
      assert.ok(Number.isInteger(open0.value.structureVersion) && open0.value.structureVersion >= 1);
      const v0 = open0.value.structureVersion;
      const ch = open0.value.nodes[0];
      assert.equal(ch.children.length, 2);
      const [alpha, beta] = ch.children;

      // Rename first point
      const renamed = await host.call('course.book.rename', {
        course: BOOK_COURSE,
        hid: alpha.hid,
        title: 'Alpha Foundations',
        version: v0,
      });
      assert.equal(renamed.ok, true, renamed.error?.message);
      assert.equal(renamed.value.write, 'renamed');
      assert.equal(renamed.value.structureVersion, v0 + 1);

      const open1 = await host.call('course.book.open', { course: BOOK_COURSE, language: 'zh' });
      assert.equal(open1.ok, true);
      assert.equal(open1.value.nodes[0].children[0].title, 'Alpha Foundations');

      // Move second point before first
      const moved = await host.call('course.book.move', {
        course: BOOK_COURSE,
        hid: beta.hid,
        beforeHid: alpha.hid,
        version: renamed.value.structureVersion,
      });
      assert.equal(moved.ok, true, moved.error?.message);
      assert.equal(moved.value.write, 'moved');
      assert.equal(moved.value.structureVersion, v0 + 2);

      const open2 = await host.call('course.book.open', { course: BOOK_COURSE, language: 'zh' });
      assert.equal(open2.ok, true);
      assert.equal(open2.value.nodes[0].children[0].hid, beta.hid);
      assert.equal(open2.value.nodes[0].children[1].hid, alpha.hid);

      // Delete beta (promote children) -> learner mine note preserved in unplaced
      const deleted = await host.call('course.book.delete', {
        course: BOOK_COURSE,
        hid: beta.hid,
        children: 'promote',
        version: moved.value.structureVersion,
      });
      assert.equal(deleted.ok, true, deleted.error?.message);
      assert.equal(deleted.value.write, 'deleted');
      assert.equal(deleted.value.structureVersion, v0 + 3);

      const open3 = await host.call('course.book.open', { course: BOOK_COURSE, language: 'zh' });
      assert.equal(open3.ok, true);
      assert.equal(open3.value.nodes[0].children.length, 1);
      assert.equal(open3.value.nodes[0].children[0].hid, alpha.hid);
      assert.match(open3.value.unplaced?.text ?? '', /My custom note on Beta Boundaries/);

      // Revert last structure edit ('book.structure') -> beta restored
      const reverted = await host.call('course.book.revert', {
        course: BOOK_COURSE,
        file: 'book.structure',
      });
      assert.equal(reverted.ok, true, reverted.error?.message);
      assert.equal(reverted.value.write, 'reverted');

      const open4 = await host.call('course.book.open', { course: BOOK_COURSE, language: 'zh' });
      assert.equal(open4.ok, true);
      assert.equal(open4.value.nodes[0].children.length, 2);
      assert.equal(open4.value.nodes[0].children[0].hid, beta.hid);

      // Seed a rebuilt outline that triggers rebuild-pending, then test course.book.rebuild { action: 'undo', outlineId }
      await host.dispose();
      const service = new StudyService(libraryRoot);
      await service.call('snapshot');
      await service.store.update((state) => {
        const lecture = groupSourcesByDocument(state.sources).find((item) => item.sourceIds.includes('doc1-p1')).key;
        const rebuiltOutline = {
          ...courseOutlineMaterial({
            title: 'Outline · StructArch v2',
            course: BOOK_COURSE,
            orderBasis: { codes: ['numbering'] },
            fingerprint: materialsFingerprint(buildOutlineIndex(state, { course: BOOK_COURSE }).allDocuments),
            nodes: [{ id: 'ch1', title: 'Core Architecture', children: [{ id: 'alpha', title: 'Alpha Renamed By Outline', anchors: [`${lecture}#0`] }] }],
            other: { anchors: [] },
            counts: { units: 1, leftover: 0, invalid: 0, repeated: 0 },
          }),
          createdAt: '2026-10-10T00:00:00.000Z',
        };
        const oldOutline = state.sources.find((s) => s.provenance === 'course-outline' && !s.archived);
        if (oldOutline) oldOutline.archived = true;
        state.sources.push(rebuiltOutline);
      });
      await service.dispose();

      host = await createTuiHost({
        libraryRoot,
        env,
        home: base,
        documentsDir: base,
        skipAutoProbe: true,
        language: 'zh',
      });

      const pendingOpen = await host.call('course.book.open', { course: BOOK_COURSE, language: 'zh' });
      assert.equal(pendingOpen.ok, true);
      assert.equal(pendingOpen.value.status, 'rebuild-pending');
      const outlineId = pendingOpen.value.moves?.outlineId ?? pendingOpen.value.rebuildPending?.outlineId;
      assert.ok(outlineId, 'pending outlineId must be returned');

      const undone = await host.call('course.book.rebuild', { course: BOOK_COURSE, action: 'undo', outlineId });
      assert.equal(undone.ok, true, undone.error?.message);

      const afterUndo = await host.call('course.book.open', { course: BOOK_COURSE, language: 'zh' });
      assert.equal(afterUndo.ok, true);
      assert.equal(afterUndo.value.status, 'ok');
      assert.equal(afterUndo.value.nodes[0].children.length, 2);
    } finally {
      await host.dispose();
    }
  });

  test('2) PTY E2E: BookView (7) -> R (BookStructureModal Esc & Rename) -> D (ConfirmDialog n cancel) + --ascii purity', async () => {
    const base = await makeTempDir('pty');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');
    await seedBookLibrary(libraryRoot);

    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
    let host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
    });

    const tty = createVirtualTty(120, 36);
    let inkInstance = null;
    try {
      inkInstance = render(React.createElement(StudyHubTuiApp, { host, asciiMode: false }), {
        stdin: tty.stdin,
        stdout: tty.stdout,
        stderr: tty.stderr,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await tty.firstFramePromise;
      await tty.waitFor((s) => s.includes('StructArch') || s.includes('学习库'), { label: 'App initial load' });

      // Navigate to BookView ('7')
      tty.send('7');
      const bookScreen = await tty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'book' &&
          s.includes('Core Architecture') &&
          s.includes('Alpha Basics') &&
          !s.includes('正在打开复习全书'),
        { label: 'BookView rendered with TOC' },
      );
      tty.assertHealthyScreen(bookScreen, 120, 36, 'BookView TOC');

      // Press '[' on first top-level node -> boundary toast without mutating
      tty.send('[');
      await tty.waitFor((s) => s.includes('已经是同级第一个节点'), { label: 'Boundary move toast' });

      // Press 'R' -> BookStructureModal opens at 120x36 & 80x24, Esc cancels cleanly
      tty.send('R');
      const modalWide = await tty.waitFor(
        (s) => s.includes('重命名目录节点') && s.includes('Core Architecture'),
        { label: 'BookStructureModal opened' },
      );
      tty.assertHealthyScreen(modalWide, 120, 36, 'BookStructureModal 120x36');

      tty.resize(80, 24);
      const modalNarrow = await tty.waitFor(
        (s) => s.includes('重命名目录节点') && s.split('\n').length <= 24,
        { label: 'BookStructureModal at 80x24' },
      );
      tty.assertHealthyScreen(modalNarrow, 80, 24, 'BookStructureModal 80x24');

      tty.resize(120, 36);
      await tty.waitFor((s) => s.includes('重命名目录节点'), { label: 'BookStructureModal restored 120x36' });

      tty.send('\x1b');
      const afterRenameEsc = await tty.waitFor(
        (s) => !s.includes('重命名目录节点') && s.includes('Core Architecture'),
        { label: 'BookStructureModal closed on Esc' },
      );
      tty.assertHealthyScreen(afterRenameEsc, 120, 36, 'BookView after Rename Esc');

      // Press 'D' -> ConfirmDialog delete opens stating notes kept in 未归位, press 'n' cancels cleanly
      tty.send('D');
      const deleteDialog = await tty.waitFor(
        (s) => s.includes('删除目录节点') && s.includes('未归位'),
        { label: 'Delete ConfirmDialog opened' },
      );
      tty.assertHealthyScreen(deleteDialog, 120, 36, 'Delete ConfirmDialog');

      tty.send('n');
      const afterDeleteCancel = await tty.waitFor(
        (s) => !s.includes('删除目录节点') && s.includes('Core Architecture') && s.includes('Alpha Basics'),
        { label: 'Delete ConfirmDialog canceled with n' },
      );
      tty.assertHealthyScreen(afterDeleteCancel, 120, 36, 'BookView after Delete cancel');

      // Verify BookStructureModal actual rename commit via R -> type -> Enter
      tty.send('R');
      await tty.waitFor((s) => s.includes('重命名目录节点'), { label: 'BookStructureModal reopened for rename' });
      tty.send('\x15'); // Ctrl+U clears line
      tty.send('Architecture Core');
      await tty.waitFor((s) => s.includes('Architecture Core'), { label: 'New title typed' });
      tty.send('\r');
      const afterRenameSave = await tty.waitFor(
        (s) => !s.includes('重命名目录节点') && s.includes('Architecture Core'),
        { label: 'BookView updated after rename' },
      );
      tty.assertHealthyScreen(afterRenameSave, 120, 36, 'BookView after rename save');

      inkInstance.unmount();
      inkInstance = null;
      tty.dispose();
      await host.dispose();

      // Dedicated --ascii purity check for BookView + BookStructureModal + Delete ConfirmDialog
      await saveTuiPreferences({ language: 'en', asciiMode: true }, { env });
      host = await createTuiHost({
        libraryRoot,
        env,
        home: base,
        documentsDir: base,
        skipAutoProbe: true,
        language: 'en',
      });
      const asciiTty = createVirtualTty(120, 36);
      try {
        inkInstance = render(React.createElement(StudyHubTuiApp, { host, asciiMode: true }), {
          stdin: asciiTty.stdin,
          stdout: asciiTty.stdout,
          stderr: asciiTty.stderr,
          exitOnCtrlC: false,
          patchConsole: false,
        });
        await asciiTty.firstFramePromise;
        await asciiTty.waitFor((s) => s.includes('StructArch') || s.includes('Library'), { label: 'ASCII app load' });

        asciiTty.send('7');
        const asciiBook = await asciiTty.waitFor(
          (s) => useTuiStore.getState().page === 'book' && s.includes('Architecture Core') && !s.includes('Opening review book'),
          { label: 'ASCII BookView loaded' },
        );
        asciiTty.assertHealthyScreen(asciiBook, 120, 36, 'ASCII BookView');
        asciiTty.assertAsciiPure(asciiBook, 'ASCII BookView');

        asciiTty.send('R');
        const asciiRename = await asciiTty.waitFor((s) => s.includes('Rename Book Node'), { label: 'ASCII BookStructureModal' });
        asciiTty.assertHealthyScreen(asciiRename, 120, 36, 'ASCII BookStructureModal');
        asciiTty.assertAsciiPure(asciiRename, 'ASCII BookStructureModal');
        asciiTty.send('\x1b');
        await asciiTty.waitFor((s) => !s.includes('Rename Book Node'), { label: 'ASCII BookStructureModal closed' });

        asciiTty.send('D');
        const asciiDelete = await asciiTty.waitFor((s) => s.includes('Delete TOC Node'), { label: 'ASCII Delete ConfirmDialog' });
        asciiTty.assertHealthyScreen(asciiDelete, 120, 36, 'ASCII Delete ConfirmDialog');
        asciiTty.assertAsciiPure(asciiDelete, 'ASCII Delete ConfirmDialog');
        asciiTty.send('n');
        await asciiTty.waitFor((s) => !s.includes('Delete TOC Node'), { label: 'ASCII Delete ConfirmDialog closed' });
      } finally {
        inkInstance?.unmount();
        asciiTty.dispose();
      }
    } finally {
      inkInstance?.unmount();
      tty.dispose();
      await host.dispose();
    }
  });
});
