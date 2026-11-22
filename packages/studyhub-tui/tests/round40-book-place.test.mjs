// Round 40 BookView Unplaced Section Placement (course.book.place) Integration & PTY E2E:
// node --test tests/round40-book-place.test.mjs
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
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round40-${label}-`));
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

const BOOK_COURSE = 'PlaceCourse';

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
        title: 'Outline · PlaceCourse',
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
        title: 'Review Book · PlaceCourse',
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
  });
  await service.dispose();
}

async function createUnplacedFromSecondLeaf(host, noteText) {
  const openRes = await host.call('course.book.open', { course: BOOK_COURSE, language: 'zh' });
  assert.equal(openRes.ok, true, openRes.error?.message);
  const [alpha, beta] = openRes.value.nodes[0].children;
  const betaMine = beta.files.mine;
  const betaVer = openRes.value.files[betaMine].version;

  const saved = await host.call('course.book.save', {
    course: BOOK_COURSE,
    file: betaMine,
    text: noteText,
    version: betaVer,
  });
  assert.equal(saved.ok, true, saved.error?.message);

  const deleted = await host.call('course.book.delete', {
    course: BOOK_COURSE,
    hid: beta.hid,
    children: 'promote',
    version: openRes.value.structureVersion,
  });
  assert.equal(deleted.ok, true, deleted.error?.message);
  return { alpha, beta, structureVersion: deleted.value.structureVersion };
}

describe('Round 40: BookView Unplaced Section Placement (course.book.place)', () => {
  after(async () => {
    if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = PREV_DSH_HOME;
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
  });

  test('1) createTuiHost integration: open -> save learner text -> delete leaf -> verify unplaced -> course.book.place -> verify moved & cleared', async () => {
    const base = await makeTempDir('host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');
    await seedBookLibrary(libraryRoot);

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
    });

    try {
      const noteText = 'Learner summary note preserved across deletion.';
      const { alpha } = await createUnplacedFromSecondLeaf(host, noteText);

      const afterDelete = await host.call('course.book.open', { course: BOOK_COURSE, language: 'zh' });
      assert.equal(afterDelete.ok, true, afterDelete.error?.message);
      assert.equal(afterDelete.value.nodes[0].children.length, 1);
      assert.match(afterDelete.value.unplaced?.text ?? '', /Learner summary note preserved across deletion/);
      assert.equal(afterDelete.value.unplaced?.sections?.length, 1);

      const sec = afterDelete.value.unplaced.sections[0];
      assert.equal(sec.title, 'Beta Boundaries');

      const placed = await host.call('course.book.place', {
        course: BOOK_COURSE,
        section: sec.id,
        toHid: alpha.hid,
        version: afterDelete.value.structureVersion,
      });
      assert.equal(placed.ok, true, placed.error?.message);
      assert.equal(placed.value.write, 'placed');
      assert.equal(placed.value.hid, alpha.hid);

      const afterPlace = await host.call('course.book.open', { course: BOOK_COURSE, language: 'zh' });
      assert.equal(afterPlace.ok, true, afterPlace.error?.message);
      assert.equal(afterPlace.value.unplaced?.text?.trim(), '');
      assert.deepEqual(afterPlace.value.unplaced?.sections, []);
      const destNode = afterPlace.value.nodes[0].children.find((n) => n.hid === alpha.hid);
      assert.ok(destNode, 'Destination leaf must exist');
      assert.match(destNode.mine ?? '', /Learner summary note preserved across deletion/);
    } finally {
      await host.dispose();
    }
  });

  test('2) PTY E2E (zh + --ascii en): BookView U empty toast -> U modal open -> Esc cancel -> U + Enter places cleanly', async () => {
    const baseZh = await makeTempDir('pty-zh');
    const envZh = { DSH_HOME: join(baseZh, 'dsh-home') };
    process.env.DSH_HOME = envZh.DSH_HOME;
    const libZh = join(baseZh, 'library');
    await seedBookLibrary(libZh);

    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env: envZh });
    const hostZh = await createTuiHost({
      libraryRoot: libZh,
      env: envZh,
      home: baseZh,
      documentsDir: baseZh,
      skipAutoProbe: true,
      language: 'zh',
    });

    const ttyZh = createVirtualTty(120, 36);
    let inkInstance = null;
    try {
      inkInstance = render(React.createElement(StudyHubTuiApp, { host: hostZh, asciiMode: false }), {
        stdin: ttyZh.stdin,
        stdout: ttyZh.stdout,
        stderr: ttyZh.stderr,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await ttyZh.firstFramePromise;
      await ttyZh.waitFor((s) => s.includes('PlaceCourse') || s.includes('学习库'), { label: 'App initial load (zh)' });

      // Navigate to BookView ('7')
      ttyZh.send('7');
      const bookScreen = await ttyZh.waitFor(
        (s) =>
          useTuiStore.getState().page === 'book' &&
          s.includes('Core Architecture') &&
          s.includes('Alpha Basics') &&
          !s.includes('正在打开复习全书'),
        { label: 'BookView rendered (zh)' },
      );
      ttyZh.assertHealthyScreen(bookScreen, 120, 36, 'BookView empty unplaced (zh)');

      // Press 'U' when unplaced is empty -> friendly toast
      ttyZh.send('U');
      const emptyToast = await ttyZh.waitFor(
        (s) => s.includes('当前没有未归位段落'),
        { label: 'Empty unplaced toast (zh)' },
      );
      ttyZh.assertHealthyScreen(emptyToast, 120, 36, 'Empty unplaced toast (zh)');

      // Create an unplaced section via host, then press 'r' to refresh BookView
      await createUnplacedFromSecondLeaf(hostZh, 'ZH placed section body text.');
      ttyZh.send('r');
      await ttyZh.waitFor(
        (s) => s.includes('未归位 1') && !s.includes('Beta Boundaries'),
        { label: 'BookView refreshed with Unplaced 1 (zh)' },
      );

      // Press 'U' -> BookStructureModal opens in 'place' mode
      ttyZh.send('U');
      const modalWide = await ttyZh.waitFor(
        (s) =>
          s.includes('归位未归位段落') &&
          s.includes('1. 选择未归位段落') &&
          s.includes('2. 选择目标知识点') &&
          s.includes('Beta Boundaries') &&
          s.includes('Alpha Basics'),
        { label: 'Place modal opened 120x36 (zh)' },
      );
      ttyZh.assertHealthyScreen(modalWide, 120, 36, 'Place modal 120x36 (zh)');

      // Check 80x24 responsiveness
      ttyZh.resize(80, 24);
      const modalNarrow = await ttyZh.waitFor(
        (s) => s.includes('归位未归位段落') && s.split('\n').length <= 24,
        { label: 'Place modal 80x24 (zh)' },
      );
      ttyZh.assertHealthyScreen(modalNarrow, 80, 24, 'Place modal 80x24 (zh)');

      ttyZh.resize(120, 36);
      await ttyZh.waitFor((s) => s.includes('归位未归位段落'), { label: 'Place modal restored 120x36 (zh)' });

      // Esc cancels cleanly
      ttyZh.send('\x1b');
      const afterEsc = await ttyZh.waitFor(
        (s) => !s.includes('归位未归位段落') && s.includes('未归位 1'),
        { label: 'Place modal canceled on Esc (zh)' },
      );
      ttyZh.assertHealthyScreen(afterEsc, 120, 36, 'After Esc cancel (zh)');

      // Re-open with 'U' and press Enter to place cleanly
      ttyZh.send('U');
      await ttyZh.waitFor((s) => s.includes('归位未归位段落'), { label: 'Place modal reopened (zh)' });
      ttyZh.send('\r');
      const afterPlace = await ttyZh.waitFor(
        (s) =>
          !s.includes('归位未归位段落') &&
          !s.includes('未归位 1') &&
          s.includes('ZH placed section body text.'),
        { label: 'Section placed into Alpha Basics (zh)' },
      );
      ttyZh.assertHealthyScreen(afterPlace, 120, 36, 'After place (zh)');

      inkInstance.unmount();
      inkInstance = null;
      ttyZh.dispose();
      await hostZh.dispose();

      // Part B: --ascii en mode
      const baseEn = await makeTempDir('pty-en');
      const envEn = { DSH_HOME: join(baseEn, 'dsh-home') };
      process.env.DSH_HOME = envEn.DSH_HOME;
      const libEn = join(baseEn, 'library');
      await seedBookLibrary(libEn);

      await saveTuiPreferences({ language: 'en', asciiMode: true }, { env: envEn });
      const hostEn = await createTuiHost({
        libraryRoot: libEn,
        env: envEn,
        home: baseEn,
        documentsDir: baseEn,
        skipAutoProbe: true,
        language: 'en',
      });
      const ttyEn = createVirtualTty(120, 36);
      try {
        inkInstance = render(React.createElement(StudyHubTuiApp, { host: hostEn, asciiMode: true }), {
          stdin: ttyEn.stdin,
          stdout: ttyEn.stdout,
          stderr: ttyEn.stderr,
          exitOnCtrlC: false,
          patchConsole: false,
        });
        await ttyEn.firstFramePromise;
        await ttyEn.waitFor((s) => s.includes('PlaceCourse') || s.includes('Library'), { label: 'ASCII app load (en)' });

        ttyEn.send('7');
        const asciiBook = await ttyEn.waitFor(
          (s) =>
            useTuiStore.getState().page === 'book' &&
            s.includes('Core Architecture') &&
            !s.includes('Opening review book'),
          { label: 'ASCII BookView loaded (en)' },
        );
        ttyEn.assertHealthyScreen(asciiBook, 120, 36, 'ASCII BookView (en)');
        ttyEn.assertAsciiPure(asciiBook, 'ASCII BookView (en)');

        // Empty unplaced -> friendly English toast
        ttyEn.send('U');
        const asciiEmptyToast = await ttyEn.waitFor(
          (s) => s.includes('No unplaced sections to place'),
          { label: 'ASCII empty unplaced toast (en)' },
        );
        ttyEn.assertHealthyScreen(asciiEmptyToast, 120, 36, 'ASCII empty toast (en)');
        ttyEn.assertAsciiPure(asciiEmptyToast, 'ASCII empty toast (en)');

        // Create unplaced section and refresh
        await createUnplacedFromSecondLeaf(hostEn, 'EN placed section body text.');
        ttyEn.send('r');
        await ttyEn.waitFor(
          (s) => s.includes('Unplaced 1') && !s.includes('Beta Boundaries'),
          { label: 'ASCII BookView refreshed with Unplaced 1 (en)' },
        );

        // Open Place modal -> verify ASCII purity -> Esc cancels -> U -> Enter places
        ttyEn.send('U');
        const asciiModal = await ttyEn.waitFor(
          (s) =>
            s.includes('Place Unplaced Section') &&
            s.includes('1. Unplaced Section') &&
            s.includes('2. Target Leaf Point') &&
            s.includes('Beta Boundaries') &&
            s.includes('Alpha Basics'),
          { label: 'ASCII Place modal opened (en)' },
        );
        ttyEn.assertHealthyScreen(asciiModal, 120, 36, 'ASCII Place modal 120x36 (en)');
        ttyEn.assertAsciiPure(asciiModal, 'ASCII Place modal 120x36 (en)');

        ttyEn.send('\x1b');
        await ttyEn.waitFor(
          (s) => !s.includes('Place Unplaced Section') && s.includes('Unplaced 1'),
          { label: 'ASCII Place modal closed on Esc (en)' },
        );

        ttyEn.send('U');
        await ttyEn.waitFor((s) => s.includes('Place Unplaced Section'), { label: 'ASCII Place modal reopened (en)' });
        ttyEn.send('\r');
        const asciiAfterPlace = await ttyEn.waitFor(
          (s) =>
            !s.includes('Place Unplaced Section') &&
            !s.includes('Unplaced 1') &&
            s.includes('EN placed section body text.'),
          { label: 'ASCII Section placed cleanly (en)' },
        );
        ttyEn.assertHealthyScreen(asciiAfterPlace, 120, 36, 'ASCII After place (en)');
        ttyEn.assertAsciiPure(asciiAfterPlace, 'ASCII After place (en)');
      } finally {
        inkInstance?.unmount();
        inkInstance = null;
        ttyEn.dispose();
        await hostEn.dispose();
      }
    } finally {
      inkInstance?.unmount();
      ttyZh.dispose();
      await hostZh.dispose();
    }
  });
});
