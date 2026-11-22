// Round 41 Review Answer Draft Persistence (review.draft.save) & Card Place (card.place)
// integration + @xterm/headless PTY E2E tests:
// node --test tests/round41-review-draft.test.mjs
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
let useDistTuiStore = null;
let DEFAULT_PREFERENCES = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('store-') || f.startsWith('chunk-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!createTuiHost && typeof mod.createTuiHost === 'function') createTuiHost = mod.createTuiHost;
    if (!saveTuiPreferences && typeof mod.saveTuiPreferences === 'function') saveTuiPreferences = mod.saveTuiPreferences;
    if (!displayWidth && typeof mod.displayWidth === 'function') displayWidth = mod.displayWidth;
    if (!useDistTuiStore && typeof mod.useTuiStore?.getState === 'function') useDistTuiStore = mod.useTuiStore;
    if (!DEFAULT_PREFERENCES && mod.DEFAULT_PREFERENCES) DEFAULT_PREFERENCES = mod.DEFAULT_PREFERENCES;
  }
}
assert.ok(createTuiHost, 'dist/ must export createTuiHost');
assert.ok(saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(displayWidth, 'dist/ must export displayWidth');
assert.ok(useDistTuiStore, 'dist/ must export useTuiStore');
assert.ok(DEFAULT_PREFERENCES, 'dist/ must export DEFAULT_PREFERENCES');

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

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round41-${label}-`));
  tempDirs.push(d);
  return d;
}

const RESOURCE_KINDS = new Set(['FSEventWrap', 'StatWatcher', 'Timeout', 'ProcessWrap', 'TCPWrap', 'PipeWrap']);
function resourceCounts() {
  const counts = {};
  for (const kind of process.getActiveResourcesInfo()) {
    if (RESOURCE_KINDS.has(kind)) counts[kind] = (counts[kind] || 0) + 1;
  }
  return counts;
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

after(async () => {
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

describe('Round 41: Review Draft Persistence (review.draft.save) & Card Placement (card.place)', () => {
  test('1) createTuiHost integration: review.draft.save -> review.get preserves draft & stale/closed run returns { ok: false, stale }', async () => {
    const base = await makeTempDir('host-draft');
    const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
    const host = await createTuiHost({
      libraryRoot: join(base, 'library'),
      env,
      home: base,
      documentsDir: base,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      const sampleRes = await host.call('sample.load', { language: 'en' });
      assert.equal(sampleRes.ok, true, sampleRes.error?.message);

      const snap = await host.call('snapshot', {});
      assert.equal(snap.ok, true);
      const deck = (snap.value?.decks ?? []).find((d) => !d.systemKind);
      assert.ok(deck, 'sample course must include at least one ordinary deck');

      const startRes = await host.call('review.start', { mode: 'quiz', deckId: deck.id, fresh: true });
      assert.equal(startRes.ok, true, startRes.error?.message);
      const run = startRes.value;
      assert.ok(run?.id && run?.card?.id, 'review.start must return an active run and card');

      // Save an in-progress text + stepInputs draft
      const saveRes = await host.call('review.draft.save', {
        runId: run.id,
        cardId: run.card.id,
        index: run.index,
        draft: { text: 'Bridge separates abstraction from implementation', stepInputs: { b1: 'Bridge' } },
      });
      assert.equal(saveRes.ok, true, saveRes.error?.message);
      assert.equal(saveRes.value?.ok, true);
      assert.equal(saveRes.value?.runId, run.id);
      assert.equal(saveRes.value?.cardId, run.card.id);
      assert.equal(saveRes.value?.draft?.text, 'Bridge separates abstraction from implementation');
      assert.deepEqual(saveRes.value?.draft?.stepInputs, { b1: 'Bridge' });
      assert.equal(typeof saveRes.value?.draft?.updatedAt, 'number');

      // Verify review.get preserves draft on the active entry
      const getRes = await host.call('review.get', { runId: run.id });
      assert.equal(getRes.ok, true, getRes.error?.message);
      assert.equal(getRes.value?.draft?.text, 'Bridge separates abstraction from implementation');
      assert.deepEqual(getRes.value?.draft?.stepInputs, { b1: 'Bridge' });

      // Stale card/index returns { ok: false, stale: 'question' } cleanly
      const staleQuestion = await host.call('review.draft.save', {
        runId: run.id,
        cardId: 'non-existent-card',
        index: run.index,
        draft: { text: 'ignored' },
      });
      assert.equal(staleQuestion.ok, true, 'noWrite stale response must not throw');
      assert.equal(staleQuestion.value?.ok, false);
      assert.equal(staleQuestion.value?.stale, 'question');

      // Close the run -> stale/closed run returns { ok: false, stale: 'run' } cleanly
      const endRes = await host.call('review.end', { runId: run.id });
      assert.equal(endRes.ok, true, endRes.error?.message);

      const staleClosed = await host.call('review.draft.save', {
        runId: run.id,
        cardId: run.card.id,
        index: run.index,
        draft: { text: 'after close' },
      });
      assert.equal(staleClosed.ok, true, 'closed run draft save must fail soft via noWrite');
      assert.equal(staleClosed.value?.ok, false);
      assert.equal(staleClosed.value?.stale, 'run');

      // Unknown runId also returns { ok: false, stale: 'run' } cleanly
      const staleMissing = await host.call('review.draft.save', {
        runId: 'missing-run-id',
        cardId: run.card.id,
        index: 0,
        draft: { text: 'after missing' },
      });
      assert.equal(staleMissing.ok, true);
      assert.equal(staleMissing.value?.ok, false);
      assert.equal(staleMissing.value?.stale, 'run');
    } finally {
      await host.dispose();
    }
  });

  test('2) createTuiHost integration: card.place { deckId, cardId } returns exact placement shape', async () => {
    const base = await makeTempDir('host-place');
    const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
    const host = await createTuiHost({
      libraryRoot: join(base, 'library'),
      env,
      home: base,
      documentsDir: base,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      const sampleRes = await host.call('sample.load', { language: 'en' });
      assert.equal(sampleRes.ok, true, sampleRes.error?.message);

      const snap = await host.call('snapshot', {});
      assert.equal(snap.ok, true);
      const deck = (snap.value?.decks ?? []).find((d) => !d.systemKind);
      assert.ok(deck, 'sample library must include a non-system deck');
      const deckDetail = await host.call('deck.get', { id: deck.id });
      assert.equal(deckDetail.ok, true);
      const citedCard = (deckDetail.value?.cards ?? []).find((c) => Array.isArray(c.citations) && c.citations.length > 0);
      assert.ok(citedCard?.id, 'sample deck must include a card with source citations');

      const placeRes = await host.call('card.place', { deckId: deck.id, cardId: citedCard.id });
      assert.equal(placeRes.ok, true, placeRes.error?.message);
      const place = placeRes.value;
      assert.ok(place && typeof place === 'object', 'card.place must return an object');
      assert.ok('course' in place && typeof place.course === 'string' && place.course.length > 0, 'place.course must be non-empty string');
      assert.ok('document' in place, 'place must expose document key');
      assert.ok('chapter' in place, 'place must expose chapter key');
      assert.ok('leaf' in place, 'place must expose leaf key');
      if (place.document !== null) {
        assert.equal(typeof place.document.key, 'string');
        assert.equal(typeof place.document.title, 'string');
      }
      if (place.chapter !== null) {
        assert.equal(typeof place.chapter.key, 'string');
        assert.equal(typeof place.chapter.title, 'string');
      }
      if (place.leaf !== null) {
        assert.equal(typeof place.leaf.key, 'string');
        assert.equal(typeof place.leaf.title, 'string');
        assert.equal(typeof place.leaf.built, 'boolean');
      }

      // Unknown cardId fails soft with all-null shape
      const emptyPlace = await host.call('card.place', { deckId: deck.id, cardId: 'nonexistent-card-id' });
      assert.equal(emptyPlace.ok, true, emptyPlace.error?.message);
      assert.deepEqual(emptyPlace.value, { course: null, document: null, chapter: null, leaf: null });
    } finally {
      await host.dispose();
    }
  });

  test('3) PTY E2E: ReviewView restores pre-saved draft, debounces new edits, shows card.place in CardToolsModal (--ascii), and leaks zero handles', async () => {
    const beforeResources = resourceCounts();

    const base = await makeTempDir('pty-draft');
    const dshHome = join(base, 'dsh-home');
    process.env.DSH_HOME = dshHome;
    await saveTuiPreferences(
      { language: 'en', asciiMode: true, theme: 'tokyo-night', mathUnicode: false, showHints: true },
      { env: { ...process.env, DSH_HOME: dshHome } },
    );

    const host = await createTuiHost({
      libraryRoot: join(base, 'library'),
      env: { ...process.env, DSH_HOME: dshHome },
      home: join(base, 'home'),
      documentsDir: base,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'en',
      eventDebounceMs: 30,
    });

    const tty = createVirtualTty(120, 36);
    let inkInst = null;
    let openRunId = null;

    try {
      const sampleRes = await host.call('sample.load', { language: 'en' });
      assert.equal(sampleRes.ok, true, sampleRes.error?.message);

      // Find a sample deck whose cards are open/task (e.g. case-study deck) or move to an open/task card
      const snap = await host.call('snapshot', {});
      assert.equal(snap.ok, true);
      let targetDeckId = null;
      let targetCardId = null;
      for (const d of snap.value?.decks ?? []) {
        if (d.systemKind) continue;
        const det = await host.call('deck.get', { id: d.id });
        if (!det.ok) continue;
        const cards = det.value?.cards ?? [];
        const openFirst = cards[0] && (cards[0].kind === 'open' || cards[0].kind === 'task');
        if (openFirst) {
          targetDeckId = d.id;
          targetCardId = cards[0].id;
          break;
        }
        const anyOpen = cards.find((c) => c.kind === 'open' || c.kind === 'task');
        if (anyOpen && !targetDeckId) {
          targetDeckId = d.id;
          targetCardId = anyOpen.id;
        }
      }
      assert.ok(targetDeckId && targetCardId, 'sample library must include an open/task card');

      const startRes = await host.call('review.start', { mode: 'quiz', deckId: targetDeckId, fresh: true });
      assert.equal(startRes.ok, true, startRes.error?.message);
      let startedRun = startRes.value;
      if (startedRun.card?.kind !== 'open' && startedRun.card?.kind !== 'task') {
        const navIdx = (startedRun.navigation ?? []).findIndex((n) => n.cardId === targetCardId);
        if (navIdx >= 0) {
          const moved = await host.call('review.move', { runId: startedRun.id, index: navIdx });
          assert.equal(moved.ok, true, moved.error?.message);
          startedRun = moved.value;
        }
      }
      assert.ok(startedRun.card?.kind === 'open' || startedRun.card?.kind === 'task', `expected open/task card, got ${startedRun.card?.kind}`);
      openRunId = startedRun.id;

      // Pre-save a draft onto the first entry before mounting ReviewView
      const preSavedDraft = 'PRE_SAVED_DRAFT_R41';
      const saveRes = await host.call('review.draft.save', {
        runId: startedRun.id,
        cardId: startedRun.card.id,
        index: startedRun.index,
        draft: { text: preSavedDraft },
      });
      assert.equal(saveRes.ok, true);
      assert.equal(saveRes.value?.ok, true);

      resetDistStore('en', true, {
        page: 'review',
        activeRunId: startedRun.id,
        navContext: { runId: startedRun.id },
      });

      inkInst = render(
        React.createElement(StudyHubTuiApp, {
          host,
          initialPage: 'review',
          initialLanguage: 'en',
          initialAsciiMode: true,
          autoLaunchpad: false,
          onExit: () => inkInst?.unmount(),
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
      await tty.firstFramePromise;

      // Verify ReviewView opens the run and restores the pre-saved draft text
      const restoredScreen = await tty.waitFor(
        (s) => s.includes(preSavedDraft) && s.includes('[D]Tools'),
        { timeoutMs: 10_000, label: 'ReviewView restored pre-saved draft' },
      );
      tty.assertHealthyScreen(restoredScreen, 120, 36, 'en ASCII ReviewView restored draft');
      tty.assertAsciiPure(restoredScreen, 'en ASCII ReviewView restored draft');

      // Enter edit mode ('i'), type suffix, wait >600ms debounce, verify host persisted the updated draft
      tty.send('i');
      await tty.flush();
      tty.send('_TYPED');
      await tty.waitFor(
        (s) => s.includes(`${preSavedDraft}_TYPED`),
        { timeoutMs: 5_000, label: 'typed draft text rendered' },
      );
      await sleep(750);

      const afterTypeRun = await host.call('review.get', { runId: openRunId });
      assert.equal(afterTypeRun.ok, true);
      assert.equal(afterTypeRun.value?.draft?.text, `${preSavedDraft}_TYPED`);

      // Exit edit mode (Esc) and open CardToolsModal ('D') -> verify card.place placement summary renders cleanly
      tty.send('\x1b');
      await tty.flush();
      tty.send('D');
      const toolsScreen = await tty.waitFor(
        (s) =>
          s.includes('Card Tools') &&
          (s.includes('Source:') || s.includes('Review Book:') || s.includes('Course:')),
        { timeoutMs: 8_000, label: 'CardToolsModal with card.place placement summary' },
      );
      tty.assertHealthyScreen(toolsScreen, 120, 36, 'en ASCII CardToolsModal with placement');
      tty.assertAsciiPure(toolsScreen, 'en ASCII CardToolsModal with placement');

      tty.send('\x1b');
      await tty.waitFor(
        (s) => !s.includes('Card Tools') && s.includes(`${preSavedDraft}_TYPED`),
        { timeoutMs: 5_000, label: 'CardToolsModal closed back to ReviewView' },
      );

      // Trigger another edit and immediately unmount BEFORE 600ms debounce fires -> zero leaked timers!
      tty.send('i');
      await tty.flush();
      tty.send('_UNMOUNT');
    } finally {
      try {
        inkInst?.unmount();
      } catch {
        // ignore
      }
      await host.dispose();
      tty.dispose();
    }

    // Allow microtasks / close callbacks to settle and verify zero leaked handles
    await sleep(100);
    const afterResources = resourceCounts();
    for (const kind of RESOURCE_KINDS) {
      assert.ok(
        (afterResources[kind] || 0) <= (beforeResources[kind] || 0),
        `Leaked ${kind} handles after unmount/dispose: before=${beforeResources[kind] || 0}, after=${afterResources[kind] || 0}`,
      );
    }
  });
});
