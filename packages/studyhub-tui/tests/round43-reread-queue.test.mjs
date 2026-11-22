// Round 43 SourcesView Reread Marks Queue (RereadQueueModal) E2E verification:
// node --test tests/round43-reread-queue.test.mjs
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import xtermPkg from '@xterm/headless';
import { render } from 'ink';
import React from 'react';
import { StudyService } from '../../../lib/service.js';

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
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round43-${label}-`));
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

const DAY_MS = 86_400_000;
const COURSE_NAME = 'CS101';
const QUOTE_ALPHA = 'Invariant preservation guarantees safety across iterations';
const QUOTE_BETA = 'Amortized potential bounds total sequence cost tightly';
const QUOTE_GAMMA = 'Binary heaps maintain partial order in logarithmic time';

async function seedRereadFixture(base, libraryRoot, env, quotes) {
  const docDir = join(base, 'docs');
  await mkdir(docDir, { recursive: true });
  const mdPath = join(docDir, 'algorithms-reread.md');
  await writeFile(
    mdPath,
    [
      '# Algorithms Fundamentals',
      '',
      `${QUOTE_ALPHA}.`,
      '',
      `${QUOTE_BETA}.`,
      '',
      `${QUOTE_GAMMA}.`,
      '',
    ].join('\n'),
    'utf8',
  );

  const host = await createTuiHost({
    libraryRoot,
    env,
    home: base,
    documentsDir: base,
    skipAutoProbe: true,
    language: 'en',
  });

  let documentId;
  let revision;
  let sourceId;
  const markIds = [];
  try {
    const imp = await host.call('materials.document.import', {
      path: mdPath,
      title: 'Algorithms Notes',
      format: 'md',
    });
    assert.equal(imp.ok, true, `materials.document.import failed: ${imp.error?.message || ''}`);
    documentId = imp.value.documentId;
    revision = imp.value.revision;
    sourceId = imp.value.sourceIds[0];
    assert.ok(documentId && revision && sourceId, 'Imported document must return documentId, revision, sourceId');

    const assign = await host.call('source.courses.set', {
      assignments: [{ id: sourceId, courses: [COURSE_NAME] }],
    });
    assert.equal(assign.ok, true, `source.courses.set failed: ${assign.error?.message || ''}`);

    for (const { quote, style } of quotes) {
      const saved = await host.call('materials.marks.save', {
        documentId,
        revision,
        style,
        selection: { documentId, revision, sourceId, quote },
      });
      assert.equal(saved.ok, true, `materials.marks.save(${style}) failed: ${saved.error?.message || ''}`);
      assert.equal(saved.value?.status, 'saved');
      markIds.push(saved.value.item.id);
    }
  } finally {
    await host.dispose();
  }

  // Backdate mark.at by 5 days and link weak questions so materials.marks.reread returns them immediately.
  const oldIso = new Date(Date.now() - 5 * DAY_MS).toISOString();
  const service = new StudyService(libraryRoot);
  try {
    await service.call('snapshot');
    await service.store.update((state) => {
      const doc = state.documents.find((d) => d.id === documentId);
      const ver = doc?.versions?.find((v) => v.revision === revision);
      assert.ok(ver?.marks?.items?.length >= quotes.length, 'Expected persisted marks on document version');
      for (const item of ver.marks.items) {
        item.at = oldIso;
      }
      state.decks.push({
        id: 'deck-reread-cs101',
        title: 'Algorithms Weak Deck',
        course: COURSE_NAME,
        cards: [
          {
            id: 'card-weak-1',
            kind: 'flashcard',
            topic: 'Algorithms Fundamentals',
            prompt: 'Why does an invariant guarantee safety?',
            answer: 'Because it holds at initialization and every iteration.',
            citations: [{ sourceId, quote: QUOTE_ALPHA }],
          },
        ],
      });
      state.attempts.push({
        deckId: 'deck-reread-cs101',
        quiz_id: 'card-weak-1',
        grade: 1,
        at: oldIso,
      });
    });
  } finally {
    service.dispose();
  }

  return { documentId, revision, sourceId, markIds };
}

describe('Round 43: SourcesView Reread Marks Queue (RereadQueueModal) E2E', () => {
  after(async () => {
    if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = PREV_DSH_HOME;
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
  });

  test('1) createTuiHost integration: import source -> materials.marks.save -> materials.marks.reread -> materials.marks.seen', async () => {
    const base = await makeTempDir('host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');

    const { documentId, revision, sourceId, markIds } = await seedRereadFixture(base, libraryRoot, env, [
      { quote: QUOTE_ALPHA, style: 'highlight' },
      { quote: QUOTE_BETA, style: 'bold' },
    ]);

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      const before = await host.call('materials.marks.reread', { course: COURSE_NAME });
      assert.equal(before.ok, true, `materials.marks.reread failed: ${before.error?.message || ''}`);
      assert.equal(before.value?.count, 2, `Expected 2 due marks, got ${before.value?.count}`);
      assert.equal(before.value?.total, 2);

      const first = before.value.items.find((it) => it.id === markIds[0]);
      assert.ok(first, 'First saved mark must appear in materials.marks.reread');
      assert.equal(first.title, 'Algorithms Notes');
      assert.equal(first.style, 'highlight');
      assert.equal(first.selection?.sourceId, sourceId);
      assert.equal(first.selection?.quote, QUOTE_ALPHA);
      assert.equal(first.documentId, documentId);
      assert.equal(first.revision, revision);
      assert.ok((first.risk?.weak ?? 0) >= 1, 'Expected weak risk count >= 1');

      const seenRes = await host.call('materials.marks.seen', {
        documentId,
        sourceId,
        revision,
        id: markIds[0],
      });
      assert.equal(seenRes.ok, true, `materials.marks.seen failed: ${seenRes.error?.message || ''}`);
      assert.equal(seenRes.value?.status, 'saved');
      assert.ok(seenRes.value?.item?.rereadAt, 'materials.marks.seen must stamp rereadAt');

      const after = await host.call('materials.marks.reread', { course: COURSE_NAME });
      assert.equal(after.ok, true);
      assert.equal(after.value?.count, 1, 'Seen mark must leave the reread queue for 3 days');
      assert.equal(after.value?.items[0]?.id, markIds[1]);
    } finally {
      await host.dispose();
    }
  });

  test('2) PTY E2E: SourcesView [R] opens lazy RereadQueueModal, [r] marks seen, [Enter] opens DocumentReader, [Esc] closes at 120x36 & 80x24 (zh & --ascii en)', async () => {
    const base = await makeTempDir('pty');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');

    await seedRereadFixture(base, libraryRoot, env, [
      { quote: QUOTE_ALPHA, style: 'highlight' },
      { quote: QUOTE_BETA, style: 'bold' },
      { quote: QUOTE_GAMMA, style: 'highlight' },
    ]);

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
        label: 'Initial LibraryView ready',
      });
      tty.send('2');

      const sourcesScreen = await tty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'sources' &&
          s.includes('Algorithms Notes') &&
          s.includes('重读清单'),
        { label: 'SourcesView ready with Reread footer hint' },
      );
      tty.assertHealthyScreen(sourcesScreen, 120, 36, 'SourcesView zh 120x36');

      // Press R to open lazy RereadQueueModal
      tty.send('R');
      const modalScreen = await tty.waitFor(
        (s) =>
          s.includes('今日重读清单') &&
          s.includes('Invariant preservation') &&
          s.includes('Amortized potential'),
        { label: 'RereadQueueModal rendered in zh 120x36' },
      );
      tty.assertHealthyScreen(modalScreen, 120, 36, 'RereadQueueModal zh 120x36');

      // Press r to mark first item seen and reload queue (3 -> 2)
      useTuiStore.setState({ toasts: [] });
      tty.send('r');
      await tty.waitFor(
        (s) =>
          useTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已标记为重读')) &&
          s.includes('今日推荐 2'),
        { label: 'Marked reread via [r] in zh' },
      );
      tty.assertHealthyScreen(tty.readScreen(), 120, 36, 'RereadQueueModal after [r] zh 120x36');

      // Press Esc to close modal cleanly back to SourcesView
      tty.send('\u001b');
      await tty.waitFor(
        (s) => !s.includes('今日重读清单') && s.includes('学习资料库'),
        { label: 'Esc closes RereadQueueModal cleanly' },
      );

      // Resize to 80x24, reopen modal with R, then press Enter to open DocumentReader
      tty.resize(80, 24);
      await tty.flush();
      tty.send('R');
      const narrowModal = await tty.waitFor(
        (s) => s.includes('今日重读清单') && s.includes('今日推荐 2'),
        { label: 'RereadQueueModal rendered in zh 80x24' },
      );
      tty.assertHealthyScreen(narrowModal, 80, 24, 'RereadQueueModal zh 80x24');

      tty.send('\r');
      const readerScreen = await tty.waitFor(
        (s) => !s.includes('今日重读清单') && s.includes('Algorithms Notes') && s.includes('Invariant preservation'),
        { label: 'Enter opens DocumentReader from RereadQueueModal' },
      );
      tty.assertHealthyScreen(readerScreen, 80, 24, 'DocumentReader opened from RereadQueueModal 80x24');

      inkInstance.unmount();
      inkInstance = null;
      tty.dispose();
      await host.dispose();

      // Switch to --ascii & English mode (2 due marks remain today)
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
          label: 'ASCII LibraryView ready',
        });
        asciiTty.send('2');
        const asciiSources = await asciiTty.waitFor(
          (s) => useTuiStore.getState().page === 'sources' && s.includes('Algorithms Notes') && s.includes('Reread'),
          { label: 'ASCII SourcesView ready' },
        );
        asciiTty.assertHealthyScreen(asciiSources, 120, 36, 'ASCII SourcesView 120x36');
        asciiTty.assertAsciiPure(asciiSources, 'ASCII SourcesView 120x36');

        asciiTty.send('R');
        const asciiWideModal = await asciiTty.waitFor(
          (s) => s.includes('Reread Marks Queue') && s.includes('Due 2'),
          { label: 'ASCII RereadQueueModal 120x36' },
        );
        asciiTty.assertHealthyScreen(asciiWideModal, 120, 36, 'ASCII RereadQueueModal 120x36');
        asciiTty.assertAsciiPure(asciiWideModal, 'ASCII RereadQueueModal 120x36');

        // Resize to 80x24 and mark remaining 2 marks seen -> clean empty state
        asciiTty.resize(80, 24);
        const asciiNarrowModal = await asciiTty.waitFor(
          (s) => s.includes('Reread Marks Queue') && s.includes('Due 2') && s.split('\n').length <= 24,
          { label: 'ASCII RereadQueueModal 80x24' },
        );
        asciiTty.assertHealthyScreen(asciiNarrowModal, 80, 24, 'ASCII RereadQueueModal 80x24');
        asciiTty.assertAsciiPure(asciiNarrowModal, 'ASCII RereadQueueModal 80x24');

        useTuiStore.setState({ toasts: [] });
        asciiTty.send('r');
        await asciiTty.waitFor(
          (s) =>
            useTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('Marked as reread')) &&
            s.includes('Due 1'),
          { label: 'ASCII [r] marks first remaining item seen' },
        );
        asciiTty.assertAsciiPure(asciiTty.readScreen(), 'ASCII RereadQueueModal after 1st [r]');

        useTuiStore.setState({ toasts: [] });
        asciiTty.send('r');
        const asciiEmpty = await asciiTty.waitFor(
          (s) =>
            useTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('Marked as reread')) &&
            s.includes('No marks due for reread today'),
          { label: 'ASCII [r] marks last item seen and renders empty state' },
        );
        asciiTty.assertHealthyScreen(asciiEmpty, 80, 24, 'ASCII RereadQueueModal empty state 80x24');
        asciiTty.assertAsciiPure(asciiEmpty, 'ASCII RereadQueueModal empty state 80x24');

        asciiTty.send('\u001b');
        const afterEsc = await asciiTty.waitFor(
          (s) => !s.includes('Reread Marks Queue') && s.includes('Algorithms Notes'),
          { label: 'ASCII Esc closes RereadQueueModal cleanly' },
        );
        asciiTty.assertAsciiPure(afterEsc, 'ASCII SourcesView after Esc');
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
