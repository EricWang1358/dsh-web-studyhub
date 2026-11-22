// Round 38 SkeletonView safe deletion ([D] + ConfirmDialog) E2E verification:
// node --test tests/round38-skeleton-e2e.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
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

let createTuiHost = null;
let saveTuiPreferences = null;
let displayWidth = null;
let useTuiStore = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('store-') || f.startsWith('chunk-')) {
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
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round38-skel-${label}-`));
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

function resetTuiStore() {
  useTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    snapshot: null,
    binding: null,
    config: null,
    loading: true,
    refreshing: false,
    toasts: [],
    footerHints: [],
    commandPaletteOpen: false,
    helpOpen: false,
    coursePickerOpen: false,
    inboxOpen: false,
    voicePackOpen: false,
    showLaunchpad: false,
    inputCaptured: false,
    activeRunId: null,
  });
}

async function seedDeckWithCard(host, { title, course, topic, prompt }) {
  const impRes = await host.call('deck.import', {
    text: JSON.stringify({
      title,
      course,
      cards: [
        {
          kind: 'flashcard',
          topic,
          prompt,
          answer: 'Sample answer',
          explanation: 'Sample explanation',
        },
      ],
    }),
    folder: course,
  });
  assert.equal(impRes.ok, true, `deck.import failed: ${impRes.error?.message || ''}`);
  const snap = await host.call('snapshot', {});
  assert.equal(snap.ok, true, `snapshot failed: ${snap.error?.message || ''}`);
  const deckSummary = (snap.value?.decks ?? []).find((d) => d.title === title);
  assert.ok(deckSummary?.id, 'snapshot must include imported deck');
  const deckRes = await host.call('deck.get', { id: deckSummary.id });
  assert.equal(deckRes.ok, true, `deck.get failed: ${deckRes.error?.message || ''}`);
  const cardId = deckRes.value?.cards?.[0]?.id;
  assert.ok(cardId, 'deck.get must return created card id');
  return { deckId: deckSummary.id, cardId, topic };
}

async function saveTestSkeleton(host, { title, deckId, cardId, topic }) {
  const res = await host.call('skeleton.save', {
    title,
    overview: `${title} overview`,
    scope: [{ deckId, topic }],
    nodes: [
      { id: 'n-root', term: 'Root Concept', meaning: 'Top-level core concept', cards: [cardId] },
      { id: 'n-child', term: 'Child Concept', meaning: 'Detailed sub-concept', parent: 'n-root', cards: [] },
    ],
    relations: [{ from: 'n-root', to: 'n-child', type: 'part-of', note: 'Contains sub-concept' }],
  });
  assert.equal(res.ok, true, `skeleton.save failed: ${res.error?.message || ''}`);
  assert.ok(res.value?.id, 'skeleton.save must return skeleton id');
  return res.value;
}

describe('Round 38: SkeletonView safe deletion ([D] + ConfirmDialog) E2E', () => {
  after(async () => {
    if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = PREV_DSH_HOME;
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
  });

  test('1) createTuiHost integration: skeleton.save -> snapshot/skeleton.get -> skeleton.delete -> removed & unknown id error', async () => {
    const base = await makeTempDir('host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      const { deckId, cardId, topic } = await seedDeckWithCard(host, {
        title: 'Algorithms Deck',
        course: 'CS101',
        topic: 'Graphs',
        prompt: 'What is BFS?',
      });

      const saved = await saveTestSkeleton(host, {
        title: 'CS101 Graph Skeleton',
        deckId,
        cardId,
        topic,
      });

      const snap1 = await host.call('snapshot', {});
      assert.equal(snap1.ok, true);
      assert.ok(
        Array.isArray(snap1.value?.skeletons) && snap1.value.skeletons.some((s) => s.id === saved.id),
        'snapshot.skeletons must include newly saved skeleton',
      );

      const getRes = await host.call('skeleton.get', { id: saved.id });
      assert.equal(getRes.ok, true, `skeleton.get failed: ${getRes.error?.message || ''}`);
      assert.equal(getRes.value?.title, 'CS101 Graph Skeleton');

      const delRes = await host.call('skeleton.delete', { id: saved.id });
      assert.equal(delRes.ok, true, `skeleton.delete failed: ${delRes.error?.message || ''}`);
      assert.equal(delRes.value?.deleted, saved.id);

      const snap2 = await host.call('snapshot', {});
      assert.equal(snap2.ok, true);
      assert.ok(
        !(snap2.value?.skeletons ?? []).some((s) => s.id === saved.id),
        'deleted skeleton must be removed from snapshot.skeletons',
      );
      assert.ok(
        (snap2.value?.decks ?? []).some((d) => d.id === deckId),
        'decks must remain untouched after skeleton.delete',
      );

      const getAfter = await host.call('skeleton.get', { id: saved.id });
      assert.equal(getAfter.ok, false, 'skeleton.get on deleted id must fail');

      const unknownDel = await host.call('skeleton.delete', { id: 'skel_nonexistent_id' });
      assert.equal(unknownDel.ok, false, 'skeleton.delete on unknown id must fail cleanly');
      assert.ok(unknownDel.error?.message, 'unknown skeleton.delete must return an error message');
    } finally {
      await host.dispose();
    }
  });

  test('2) PTY E2E: SkeletonView [D] ConfirmDialog cancel (n/Esc) & confirm (y) in default (zh) and --ascii (en) at 120x36 & 80x24', async () => {
    const base = await makeTempDir('pty');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');

    // Pass A: default mode (zh) at 120x36 & 80x24
    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
    resetTuiStore();

    let host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
    });

    const seedZh = await seedDeckWithCard(host, {
      title: '操作系统题组',
      course: 'OS202',
      topic: '进程调度',
      prompt: '什么是时间片轮转？',
    });
    const skelZh = await saveTestSkeleton(host, {
      title: 'OS 知识骨架',
      ...seedZh,
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

      await tty.waitFor(() => useTuiStore.getState().page === 'library' && Boolean(useTuiStore.getState().snapshot), {
        label: 'Initial LibraryView ready (zh)',
      });
      tty.send('8');

      const skelScreen = await tty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'skeleton' &&
          s.includes('OS 知识骨架') &&
          s.includes('Root Concept') &&
          s.includes('D  删除'),
        { label: 'SkeletonView rendered with saved skeleton (zh)' },
      );
      tty.assertHealthyScreen(skelScreen, 120, 36, 'SkeletonView 120x36 zh');

      // Open ConfirmDialog via D, then cancel via 'n'
      tty.send('D');
      const dialogZh = await tty.waitFor(
        (s) => s.includes('确认删除知识骨架') && s.includes('图表') && s.includes('不受影响'),
        { label: 'ConfirmDialog opened via D (zh)' },
      );
      tty.assertHealthyScreen(dialogZh, 120, 36, 'ConfirmDialog 120x36 zh');

      tty.send('n');
      await tty.waitFor(
        (s) => !s.includes('确认删除知识骨架') && s.includes('OS 知识骨架') && s.includes('Root Concept'),
        { label: 'ConfirmDialog cancelled with n (zh)' },
      );
      const afterCancelN = await host.call('skeleton.get', { id: skelZh.id });
      assert.equal(afterCancelN.ok, true, 'Skeleton must remain intact after cancelling with n');

      // Open ConfirmDialog via D, then cancel via Esc
      tty.send('D');
      await tty.waitFor((s) => s.includes('确认删除知识骨架'), { label: 'ConfirmDialog re-opened for Esc (zh)' });
      tty.send('\x1b');
      await tty.waitFor(
        (s) => !s.includes('确认删除知识骨架') && s.includes('OS 知识骨架'),
        { label: 'ConfirmDialog cancelled with Esc (zh)' },
      );
      const afterCancelEsc = await host.call('skeleton.get', { id: skelZh.id });
      assert.equal(afterCancelEsc.ok, true, 'Skeleton must remain intact after cancelling with Esc');

      // Resize to 80x24 and confirm ConfirmDialog + deletion via D -> y
      tty.resize(80, 24);
      const narrowZh = await tty.waitFor(
        (s) => s.includes('OS 知识骨架') && s.split('\n').length <= 24,
        { label: 'SkeletonView 80x24 zh' },
      );
      tty.assertHealthyScreen(narrowZh, 80, 24, 'SkeletonView 80x24 zh');

      tty.send('D');
      const dialogNarrowZh = await tty.waitFor(
        (s) => s.includes('确认删除知识骨架'),
        { label: 'ConfirmDialog 80x24 zh' },
      );
      tty.assertHealthyScreen(dialogNarrowZh, 80, 24, 'ConfirmDialog 80x24 zh');

      useTuiStore.setState({ toasts: [] });
      tty.send('y');
      await tty.waitFor(
        (s) =>
          !s.includes('确认删除知识骨架') &&
          !s.includes('OS 知识骨架') &&
          s.includes('课程主题预览') &&
          useTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已删除知识骨架')),
        { label: 'Skeleton deleted via D -> y (zh)' },
      );
      const afterDeleteZh = await host.call('skeleton.get', { id: skelZh.id });
      assert.equal(afterDeleteZh.ok, false, 'Skeleton must be deleted after D -> y');

      inkInstance.unmount();
      inkInstance = null;
      tty.dispose();
      await host.dispose();

      // Pass B: --ascii mode (en) at 120x36 & 80x24
      await saveTuiPreferences({ language: 'en', asciiMode: true }, { env });
      resetTuiStore();
      host = await createTuiHost({
        libraryRoot,
        env,
        home: base,
        documentsDir: base,
        skipAutoProbe: true,
        language: 'en',
      });
      const skelEn = await saveTestSkeleton(host, {
        title: 'Compilers Skeleton',
        ...seedZh,
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

        await asciiTty.waitFor(() => useTuiStore.getState().page === 'library' && Boolean(useTuiStore.getState().snapshot), {
          label: 'ASCII LibraryView ready (en)',
        });
        asciiTty.send('8');

        const asciiWide = await asciiTty.waitFor(
          (s) =>
            useTuiStore.getState().page === 'skeleton' &&
            s.includes('Compilers Skeleton') &&
            s.includes('Root Concept') &&
            s.includes('Delete'),
          { label: 'ASCII SkeletonView 120x36 (en)' },
        );
        asciiTty.assertHealthyScreen(asciiWide, 120, 36, 'ASCII SkeletonView 120x36');
        asciiTty.assertAsciiPure(asciiWide, 'ASCII SkeletonView 120x36');

        // Press D -> cancel with n -> verify preserved
        asciiTty.send('D');
        const asciiDialog = await asciiTty.waitFor(
          (s) => s.includes('Delete Knowledge Skeleton') && s.includes('diagrams') && s.includes('untouched'),
          { label: 'ASCII ConfirmDialog 120x36' },
        );
        asciiTty.assertHealthyScreen(asciiDialog, 120, 36, 'ASCII ConfirmDialog 120x36');
        asciiTty.assertAsciiPure(asciiDialog, 'ASCII ConfirmDialog 120x36');

        asciiTty.send('n');
        await asciiTty.waitFor(
          (s) => !s.includes('Delete Knowledge Skeleton') && s.includes('Compilers Skeleton'),
          { label: 'ASCII ConfirmDialog cancelled with n' },
        );
        const preservedEn = await host.call('skeleton.get', { id: skelEn.id });
        assert.equal(preservedEn.ok, true, 'English skeleton must remain preserved after n');

        // Resize to 80x24 and confirm via D -> y
        asciiTty.resize(80, 24);
        const asciiNarrow = await asciiTty.waitFor(
          (s) => s.includes('Compilers Skeleton') && s.split('\n').length <= 24,
          { label: 'ASCII SkeletonView 80x24' },
        );
        asciiTty.assertHealthyScreen(asciiNarrow, 80, 24, 'ASCII SkeletonView 80x24');
        asciiTty.assertAsciiPure(asciiNarrow, 'ASCII SkeletonView 80x24');

        asciiTty.send('D');
        const asciiNarrowDialog = await asciiTty.waitFor(
          (s) => s.includes('Delete Knowledge Skeleton'),
          { label: 'ASCII ConfirmDialog 80x24' },
        );
        asciiTty.assertHealthyScreen(asciiNarrowDialog, 80, 24, 'ASCII ConfirmDialog 80x24');
        asciiTty.assertAsciiPure(asciiNarrowDialog, 'ASCII ConfirmDialog 80x24');

        useTuiStore.setState({ toasts: [] });
        asciiTty.send('y');
        const afterDeleteEn = await asciiTty.waitFor(
          (s) =>
            !s.includes('Delete Knowledge Skeleton') &&
            !s.includes('Compilers Skeleton') &&
            s.includes('Course Topics') &&
            useTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('Deleted skeleton')),
          { label: 'ASCII Skeleton deleted via D -> y (en)' },
        );
        asciiTty.assertHealthyScreen(afterDeleteEn, 80, 24, 'ASCII SkeletonView after deletion 80x24');
        asciiTty.assertAsciiPure(afterDeleteEn, 'ASCII SkeletonView after deletion 80x24');

        const verifyDeletedEn = await host.call('skeleton.get', { id: skelEn.id });
        assert.equal(verifyDeletedEn.ok, false, 'English skeleton must be deleted after D -> y');
      } finally {
        inkInstance?.unmount();
        inkInstance = null;
        asciiTty.dispose();
      }
    } finally {
      inkInstance?.unmount();
      tty.dispose();
      await host.dispose();
    }
  });
});
