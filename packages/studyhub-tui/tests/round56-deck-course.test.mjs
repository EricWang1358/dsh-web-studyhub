// Round 56 Task 1: DeckManageModal Reassign Deck Course (`deck.course` via [C], 0 tokens)
// host integration + @xterm/headless PTY E2E tests:
// node --test --test-concurrency=1 tests/round56-deck-course.test.mjs
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

// Canonical dist chunk discovery
const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const { StudyHubTuiApp } = await import(pathToFileURL(join(distDir, 'App.mjs')).href);

let H = null;
let R = null;
let S = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('chunk-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!H && typeof mod.createTuiHost === 'function' && typeof mod.saveTuiPreferences === 'function') H = mod;
    if (!R && typeof mod.displayWidth === 'function') R = mod;
    if (!S && mod.useTuiStore?.getState && mod.DEFAULT_PREFERENCES) S = mod;
  }
}
assert.ok(H?.createTuiHost, 'dist/ must export createTuiHost');
assert.ok(H?.saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(R?.displayWidth, 'dist/ must export displayWidth');
assert.ok(S?.useTuiStore, 'dist/ must export useTuiStore');
assert.ok(S?.DEFAULT_PREFERENCES, 'dist/ must export DEFAULT_PREFERENCES');

const { createTuiHost, saveTuiPreferences } = H;
const { displayWidth } = R;
const { useTuiStore: useDistTuiStore, DEFAULT_PREFERENCES } = S;

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round56-${label}-`));
  tempDirs.push(d);
  return d;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const UNICODE_UI_CHROME_RE = /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u27BF\u2800-\u28FF\u2190-\u21FF\u2022\u2026\u2039\u203A]/g;

function resetDistStore(language = 'zh', asciiMode = false, extra = {}) {
  useDistTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    snapshot: null,
    binding: null,
    config: null,
    loading: false,
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
    preferences: {
      ...DEFAULT_PREFERENCES,
      language,
      asciiMode,
    },
    ...extra,
  });
}

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

function fakeDiscovery() {
  const result = () => [
    { id: 'agy', supported: true, status: 'not-installed', executablePath: null, version: null, reasonCode: 'not-installed', reason: '' },
    { id: 'claude', supported: false, status: 'coming-soon', executablePath: null, version: null, reasonCode: 'coming-soon-not-installed', reason: '' },
    { id: 'codex', supported: true, status: 'not-installed', executablePath: null, version: null, reasonCode: 'not-installed', reason: '' },
  ];
  return {
    async scan() {
      return result();
    },
    getCached: () => result(),
    findReadyPath: () => '',
    findReadyAgyPath: () => '',
    findReadyCodexPath: () => '',
  };
}

async function seedDeck(host, { title, course, prompt = 'What is a vector space?', answer = 'A set closed under linear combinations.' }) {
  const imp = await host.call('deck.import', {
    text: JSON.stringify({
      title,
      course,
      cards: [
        { kind: 'flashcard', prompt, answer, topic: 'Basics' },
      ],
    }),
  });
  assert.equal(imp.ok, true, `deck.import failed: ${imp.error?.message}`);
  const snapRes = await host.refreshSnapshot();
  const deck = (snapRes.snapshot?.decks ?? []).find((d) => !d.archived && !d.systemKind && d.title === title);
  assert.ok(deck, `Seeded deck "${title}" must exist in snapshot`);
  return deck;
}

after(async () => {
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

describe('Round 56: DeckManageModal Reassign Deck Course (deck.course via [C])', () => {
  test('1) createTuiHost integration (0 model calls): deck.course updates deck & snapshot, blank course returns normalized error', async () => {
    const base = await makeTempDir('host');
    const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');

    let aiCalls = 0;
    const host = await createTuiHost({
      libraryRoot,
      env,
      home: join(base, 'home'),
      documentsDir: base,
      discovery: fakeDiscovery(),
      injectedComplete: async () => {
        aiCalls += 1;
        return '{}';
      },
      skipAutoProbe: true,
      language: 'zh',
    });

    try {
      const deck = await seedDeck(host, {
        title: '矩阵与行列式',
        course: '高等数学',
      });

      const moveRes = await host.call('deck.course', {
        id: deck.id,
        course: '线性代数',
      });
      assert.equal(moveRes.ok, true, `deck.course failed: ${moveRes.error?.message}`);
      assert.deepEqual(moveRes.value, { id: deck.id, course: '线性代数' });

      const afterSnap = await host.refreshSnapshot();
      const updated = (afterSnap.snapshot?.decks ?? []).find((d) => d.id === deck.id);
      assert.ok(updated, 'Updated deck must remain in snapshot');
      assert.equal(updated.course, '线性代数', 'Snapshot deck.course must reflect reassigned course');

      const blankRes = await host.call('deck.course', {
        id: deck.id,
        course: '   ',
      });
      assert.equal(blankRes.ok, false, 'Blank course name must return an error');
      assert.ok(
        typeof blankRes.error?.message === 'string' && blankRes.error.message.trim().length > 0,
        'Blank course must return normalized error message',
      );

      const unchangedSnap = await host.refreshSnapshot();
      const unchanged = (unchangedSnap.snapshot?.decks ?? []).find((d) => d.id === deck.id);
      assert.equal(unchanged?.course, '线性代数', 'Blank course rejection must preserve existing course');
      assert.equal(aiCalls, 0, 'deck.course flow must make 0 model calls');
    } finally {
      await host.dispose();
    }
  });

  test('2a) @xterm/headless PTY E2E (120x36 zh): Library -> m -> C -> Esc cancel -> C -> type new course + Enter', async () => {
    const base = await makeTempDir('e2e-zh');
    const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');

    let aiCalls = 0;
    resetDistStore('zh', false);
    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });

    const host = await createTuiHost({
      env,
      home: join(base, 'home'),
      libraryRoot,
      discovery: fakeDiscovery(),
      injectedComplete: async () => {
        aiCalls += 1;
        return '{}';
      },
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    const deck = await seedDeck(host, {
      title: '特征值基础练习',
      course: '微积分',
    });
    await seedDeck(host, {
      title: '离散集合论',
      course: '离散数学',
    });

    const tty = createVirtualTty(120, 36);
    const inkInstance = render(
      React.createElement(StudyHubTuiApp, {
        host,
        autoLaunchpad: false,
        onExit: () => inkInstance.unmount(),
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

    try {
      await tty.firstFramePromise;
      const libScreen = await tty.waitFor(
        (s) => s.includes('特征值基础练习') && s.includes('微积分'),
        { timeoutMs: 8_000, label: 'LibraryView zh ready with seeded deck' },
      );
      tty.assertHealthyScreen(libScreen, 120, 36, 'LibraryView zh 120x36');

      // Press m -> open DeckManageModal
      tty.send('m');
      const modalScreen = await tty.waitFor(
        (s) => s.includes('题组管理') && s.includes('特征值基础练习') && s.includes('C 改课程'),
        { timeoutMs: 8_000, label: 'DeckManageModal browse zh with C hint' },
      );
      tty.assertHealthyScreen(modalScreen, 120, 36, 'DeckManageModal browse zh 120x36');

      // Press C -> open course sub-mode -> Esc cancels cleanly
      tty.send('C');
      const courseInputScreen = await tty.waitFor(
        (s) => s.includes('修改题组所属课程') && s.includes('已有课程:') && s.includes('微积分'),
        { timeoutMs: 8_000, label: 'DeckManageModal course sub-mode zh' },
      );
      tty.assertHealthyScreen(courseInputScreen, 120, 36, 'DeckManageModal course sub-mode zh');

      tty.send('\u001b');
      const afterCancelScreen = await tty.waitFor(
        (s) => !s.includes('修改题组所属课程') && s.includes('题组管理') && s.includes('C 改课程'),
        { timeoutMs: 8_000, label: 'Esc cancelled course sub-mode back to browse' },
      );
      tty.assertHealthyScreen(afterCancelScreen, 120, 36, 'DeckManageModal browse after Esc zh');

      const snapAfterCancel = await host.refreshSnapshot();
      assert.equal(
        (snapAfterCancel.snapshot?.decks ?? []).find((d) => d.id === deck.id)?.course,
        '微积分',
        'Esc cancel must leave course unchanged',
      );

      // Press C again -> Ctrl+U clear -> type '线性代数' + Enter
      tty.send('C');
      await tty.waitFor((s) => s.includes('修改题组所属课程'), { timeoutMs: 8_000, label: 'course sub-mode reopened zh' });

      tty.send('\x15');
      await tty.flush();
      tty.send('线性代数');
      await tty.flush();
      tty.send('\r');

      const afterSubmitScreen = await tty.waitFor(
        (s) =>
          !s.includes('修改题组所属课程') &&
          s.includes('已将题组归入课程「线性代数」') &&
          useDistTuiStore.getState().toasts.some(
            (toast) => toast.tone === 'success' && toast.text.includes('线性代数'),
          ),
        { timeoutMs: 8_000, label: 'Deck course updated toast in zh mode' },
      );
      tty.assertHealthyScreen(afterSubmitScreen, 120, 36, 'DeckManageModal after course submit zh');

      const finalSnap = await host.refreshSnapshot();
      const persisted = (finalSnap.snapshot?.decks ?? []).find((d) => d.id === deck.id);
      assert.equal(persisted?.course, '线性代数', 'Reassigned course must persist in library snapshot');
      assert.equal(aiCalls, 0, 'PTY zh course reassignment must make 0 model calls');
    } finally {
      try {
        inkInstance.unmount();
      } catch {
        // ignore teardown error
      }
      await host.dispose();
      tty.dispose();
    }
  });

  test('2b) @xterm/headless PTY E2E (80x24 --ascii en): Library -> m -> C -> Esc cancel -> blank reject -> type course + Enter, 100% ASCII pure', async () => {
    const base = await makeTempDir('e2e-en-ascii');
    const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');

    let aiCalls = 0;
    resetDistStore('en', true);
    await saveTuiPreferences({ language: 'en', asciiMode: true }, { env });

    const host = await createTuiHost({
      env,
      home: join(base, 'home'),
      libraryRoot,
      discovery: fakeDiscovery(),
      injectedComplete: async () => {
        aiCalls += 1;
        return '{}';
      },
      skipAutoProbe: true,
      language: 'en',
      eventDebounceMs: 30,
    });

    const deck = await seedDeck(host, {
      title: 'Eigenvalue Practice',
      course: 'Calculus',
    });
    await seedDeck(host, {
      title: 'Graph Theory Basics',
      course: 'Discrete Math',
    });

    const tty = createVirtualTty(80, 24);
    const inkInstance = render(
      React.createElement(StudyHubTuiApp, {
        host,
        autoLaunchpad: false,
        onExit: () => inkInstance.unmount(),
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

    try {
      await tty.firstFramePromise;
      const libScreen = await tty.waitFor(
        (s) => s.includes('Eigenvalue Practice') && s.includes('Calculus'),
        { timeoutMs: 8_000, label: 'LibraryView en 80x24 ready' },
      );
      tty.assertHealthyScreen(libScreen, 80, 24, 'LibraryView --ascii en 80x24');
      tty.assertAsciiPure(libScreen, 'LibraryView --ascii en 80x24');

      // Press m -> open DeckManageModal
      tty.send('m');
      const modalScreen = await tty.waitFor(
        (s) => s.includes('Manage Deck') && s.includes('Eigenvalue Practice'),
        { timeoutMs: 8_000, label: 'DeckManageModal en 80x24' },
      );
      tty.assertHealthyScreen(modalScreen, 80, 24, 'DeckManageModal --ascii en 80x24');
      tty.assertAsciiPure(modalScreen, 'DeckManageModal --ascii en 80x24');

      // Press C -> open course sub-mode -> Esc cancel
      tty.send('C');
      const courseScreen = await tty.waitFor(
        (s) => s.includes('Reassign deck course') && s.includes('Existing:') && s.includes('Calculus'),
        { timeoutMs: 8_000, label: 'DeckManageModal course sub-mode en 80x24' },
      );
      tty.assertHealthyScreen(courseScreen, 80, 24, 'Course sub-mode --ascii en 80x24');
      tty.assertAsciiPure(courseScreen, 'Course sub-mode --ascii en 80x24');

      tty.send('\u001b');
      const cancelledScreen = await tty.waitFor(
        (s) => !s.includes('Reassign deck course') && s.includes('Manage Deck'),
        { timeoutMs: 8_000, label: 'Esc cancelled course sub-mode en 80x24' },
      );
      tty.assertHealthyScreen(cancelledScreen, 80, 24, 'After Esc cancel --ascii en 80x24');
      tty.assertAsciiPure(cancelledScreen, 'After Esc cancel --ascii en 80x24');

      // Press C -> clear with Ctrl+U -> submit blank -> warning toast -> type 'Linear Algebra' + Enter
      tty.send('C');
      await tty.waitFor((s) => s.includes('Reassign deck course'), { timeoutMs: 8_000, label: 'course reopened en' });

      tty.send('\x15');
      await tty.flush();
      tty.send('\r');
      await tty.waitFor(
        () =>
          useDistTuiStore.getState().toasts.some(
            (toast) => toast.tone === 'warning' && toast.text.includes('cannot be empty'),
          ),
        { timeoutMs: 8_000, label: 'Blank course warning toast in en mode' },
      );

      tty.send('Linear Algebra');
      await tty.flush();
      tty.send('\r');

      const updatedScreen = await tty.waitFor(
        (s) =>
          !s.includes('Reassign deck course') &&
          s.includes('Moved deck to course') &&
          useDistTuiStore.getState().toasts.some(
            (toast) => toast.tone === 'success' && toast.text === 'Moved deck to course "Linear Algebra"',
          ),
        { timeoutMs: 8_000, label: 'Deck course updated toast in --ascii en mode' },
      );
      tty.assertHealthyScreen(updatedScreen, 80, 24, 'After course submit --ascii en 80x24');
      tty.assertAsciiPure(updatedScreen, 'After course submit --ascii en 80x24');

      const finalSnap = await host.refreshSnapshot();
      const persisted = (finalSnap.snapshot?.decks ?? []).find((d) => d.id === deck.id);
      assert.equal(persisted?.course, 'Linear Algebra', 'Reassigned course must persist in library snapshot');
      assert.equal(aiCalls, 0, 'PTY --ascii en course reassignment must make 0 model calls');
    } finally {
      try {
        inkInstance.unmount();
      } catch {
        // ignore teardown error
      }
      await host.dispose();
      tty.dispose();
    }
  });
});
