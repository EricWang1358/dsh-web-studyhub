// Round 53 Task 1: DeckOpsModal P2 Silent AI Quota Leak Guard & On-Demand [g]/[a] Merge Suggestions
// host integration + @xterm/headless PTY E2E tests:
// node --test --test-concurrency=1 tests/round53-deck-merge-guard.test.mjs
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
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round53-${label}-`));
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

async function seedTwoCourseDecks(host, course = 'Linear Algebra') {
  const d1 = await host.call('deck.import', {
    text: JSON.stringify({
      title: 'Matrices Part 1',
      course,
      cards: [
        { kind: 'flashcard', prompt: 'What is matrix rank?', answer: 'Dimension of column space.', topic: 'Matrices' },
      ],
    }),
    folder: course,
  });
  assert.equal(d1.ok, true, `deck.import 1 failed: ${d1.error?.message}`);

  const d2 = await host.call('deck.import', {
    text: JSON.stringify({
      title: 'Matrices Part 2',
      course,
      cards: [
        { kind: 'flashcard', prompt: 'What is matrix trace?', answer: 'Sum of diagonal entries.', topic: 'Matrices' },
      ],
    }),
    folder: course,
  });
  assert.equal(d2.ok, true, `deck.import 2 failed: ${d2.error?.message}`);

  const focusRes = await host.call('focus.set', { course });
  assert.equal(focusRes.ok, true, `focus.set failed: ${focusRes.error?.message}`);

  const snapRes = await host.refreshSnapshot();
  const decks = (snapRes.snapshot?.decks ?? []).filter((d) => !d.archived && !d.systemKind && d.course === course);
  assert.equal(decks.length, 2, 'Expected 2 active decks in seeded course');
  return decks;
}

after(async () => {
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

describe('Round 53: DeckOpsModal P2 AI Merge Suggestion Guard', () => {
  test('1) @xterm/headless E2E (120x36 zh): 0 auto AI calls on Tab 2 mount -> [g] Confirm -> [n] cancel -> [g]+[y] suggest -> [a]+[y] merge', async () => {
    const base = await makeTempDir('e2e-zh');
    const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');

    let aiCalls = 0;
    const trackingComplete = async (system, prompt) => {
      aiCalls += 1;
      const parsed = JSON.parse(String(prompt || '{}'));
      const decks = Array.isArray(parsed.decks) ? parsed.decks : [];
      if (String(system || '').includes('Inspect the deck titles') && decks.length >= 2) {
        return JSON.stringify({
          proposals: [
            {
              targetId: decks[1].id,
              sourceIds: [decks[0].id],
              reason: 'Duplicate Matrices topics',
            },
          ],
        });
      }
      return JSON.stringify({ proposals: [] });
    };

    resetDistStore('zh', false);
    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });

    const host = await createTuiHost({
      env,
      home: join(base, 'home'),
      libraryRoot,
      discovery: fakeDiscovery(),
      injectedComplete: trackingComplete,
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    const decks = await seedTwoCourseDecks(host, 'Linear Algebra');
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
        (s) => s.includes('Matrices Part 1') && s.includes('Matrices Part 2'),
        { timeoutMs: 8_000, label: 'LibraryView with 2 seeded decks' },
      );
      tty.assertHealthyScreen(libScreen, 120, 36, 'LibraryView zh');
      assert.equal(aiCalls, 0, 'LibraryView mount must make 0 AI calls');

      // Open DeckOpsModal via [o]
      tty.send('o');
      await tty.waitFor(
        (s) => s.includes('题组操作中心') && s.includes('导入 JSON'),
        { timeoutMs: 8_000, label: 'DeckOpsModal Tab 1 Import' },
      );

      // Focus tab bar with Up Arrow, then switch to Tab 2 (Merge)
      tty.send('\x1b[A');
      await tty.flush();
      tty.send('2');

      const mergeTabScreen = await tty.waitFor(
        (s) => s.includes('并入下方所选目标题组') && s.includes('AI合并建议'),
        { timeoutMs: 8_000, label: 'DeckOpsModal Tab 2 Merge' },
      );
      tty.assertHealthyScreen(mergeTabScreen, 120, 36, 'DeckOpsModal Tab 2 Merge zh');

      // Wait briefly to guarantee no background useEffect fires deck.merge.suggest
      await sleep(300);
      await tty.flush();
      assert.equal(aiCalls, 0, 'Opening Tab 2 Merge MUST make 0 automatic AI calls');

      // Press [g] -> P2 ConfirmDialog opens with 0 AI calls
      tty.send('g');
      const confirmSuggestScreen = await tty.waitFor(
        (s) => s.includes('AI 分析并推荐题组合并') && s.includes('deck.merge.suggest'),
        { timeoutMs: 8_000, label: 'P2 ConfirmDialog for deck.merge.suggest' },
      );
      tty.assertHealthyScreen(confirmSuggestScreen, 120, 36, 'ConfirmDialog suggest-merge zh');
      assert.equal(aiCalls, 0, 'Opening P2 ConfirmDialog with [g] must still make 0 AI calls');

      // Press [n] -> cancels cleanly with 0 AI calls
      tty.send('n');
      await tty.waitFor(
        (s) => !s.includes('AI 分析并推荐题组合并') && s.includes('并入下方所选目标题组'),
        { timeoutMs: 8_000, label: 'ConfirmDialog cancelled back to Tab 2' },
      );
      await sleep(150);
      await tty.flush();
      assert.equal(aiCalls, 0, 'Cancelling ConfirmDialog with [n] must make 0 AI calls');

      // Press [g] then [y] -> invokes deck.merge.suggest exactly once and renders suggestion banner + [a] hint
      tty.send('g');
      await tty.waitFor(
        (s) => s.includes('AI 分析并推荐题组合并'),
        { timeoutMs: 8_000, label: 'P2 ConfirmDialog reopened' },
      );
      tty.send('y');

      const suggestedScreen = await tty.waitFor(
        (s) =>
          s.includes('[a] 应用建议') &&
          s.includes('Duplicate Matrice') &&
          s.includes('应用建议'),
        { timeoutMs: 8_000, label: 'AI merge suggestion banner rendered' },
      );
      tty.assertHealthyScreen(suggestedScreen, 120, 36, 'DeckOpsModal Tab 2 with suggestion zh');
      assert.equal(aiCalls, 1, 'Confirming [g] -> [y] must invoke model exactly once');

      // Press [a] -> opens existing Confirm Merge Decks dialog without calling model again
      tty.send('a');
      const confirmApplyScreen = await tty.waitFor(
        (s) =>
          s.includes('确认合并题组') &&
          s.includes(decks[0].title) &&
          s.includes(decks[1].title),
        { timeoutMs: 8_000, label: 'Confirm Merge Decks opened via [a]' },
      );
      tty.assertHealthyScreen(confirmApplyScreen, 120, 36, 'Confirm Merge Decks zh');
      assert.equal(aiCalls, 1, 'Pressing [a] to apply proposal must make 0 extra AI calls');

      // Confirm merge with [y] -> merges source into target and closes modal
      tty.send('y');
      await tty.waitFor(
        (s) => !s.includes('题组操作中心') && !s.includes('确认合并题组'),
        { timeoutMs: 10_000, label: 'DeckOpsModal closed after applying suggestion merge' },
      );
      const afterSnap = await host.refreshSnapshot();
      const remaining = (afterSnap.snapshot?.decks ?? []).filter((d) => !d.archived && !d.systemKind && d.course === 'Linear Algebra');
      assert.equal(remaining.length, 1, 'Expected 1 merged deck remaining after applying suggestion');
      assert.equal(remaining[0].id, decks[1].id, 'Target deck should survive merge');
      const mergedDetail = await host.call('deck.get', { id: decks[1].id });
      assert.equal(mergedDetail.ok, true);
      assert.equal(mergedDetail.value?.cards?.length, 2, 'Merged deck must preserve all 2 cards');
      assert.equal(aiCalls, 1, 'Total AI calls for entire flow must remain 1');
    } finally {
      try {
        inkInstance.unmount();
      } catch {
        // Ignore unmount error on teardown
      }
      await host.dispose();
      tty.dispose();
    }
  });

  test('2) @xterm/headless E2E (80x24 --ascii en): 0 auto calls, P2 guard, banner & hints 100% ASCII pure', async () => {
    const base = await makeTempDir('e2e-ascii');
    const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');

    let aiCalls = 0;
    const trackingComplete = async (system, prompt) => {
      aiCalls += 1;
      const parsed = JSON.parse(String(prompt || '{}'));
      const decks = Array.isArray(parsed.decks) ? parsed.decks : [];
      if (String(system || '').includes('Inspect the deck titles') && decks.length >= 2) {
        return JSON.stringify({
          proposals: [
            {
              targetId: decks[1].id,
              sourceIds: [decks[0].id],
              reason: 'Same topic',
            },
          ],
        });
      }
      return JSON.stringify({ proposals: [] });
    };

    resetDistStore('en', true);
    await saveTuiPreferences({ language: 'en', asciiMode: true }, { env });

    const host = await createTuiHost({
      env,
      home: join(base, 'home'),
      libraryRoot,
      discovery: fakeDiscovery(),
      injectedComplete: trackingComplete,
      skipAutoProbe: true,
      language: 'en',
      eventDebounceMs: 30,
    });

    await seedTwoCourseDecks(host, 'Linear Algebra');
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
      await tty.waitFor(
        (s) => s.includes('Matrices Part 1') && s.includes('Matrices Part 2'),
        { timeoutMs: 8_000, label: 'LibraryView en 80x24' },
      );

      tty.send('o');
      await tty.waitFor(
        (s) => s.includes('Deck Operations') && s.includes('Import JSON'),
        { timeoutMs: 8_000, label: 'DeckOpsModal en' },
      );

      tty.send('\x1b[A');
      await tty.flush();
      tty.send('2');

      const mergeScreen = await tty.waitFor(
        (s) => s.includes('into selected target') && s.includes('AI Suggest'),
        { timeoutMs: 8_000, label: 'DeckOpsModal Tab 2 Merge en 80x24' },
      );
      tty.assertHealthyScreen(mergeScreen, 80, 24, 'Tab 2 Merge --ascii en 80x24');
      tty.assertAsciiPure(mergeScreen, 'Tab 2 Merge --ascii en 80x24');

      await sleep(300);
      await tty.flush();
      assert.equal(aiCalls, 0, 'Opening Tab 2 Merge in --ascii en must make 0 AI calls');

      tty.send('g');
      const confirmScreen = await tty.waitFor(
        (s) => s.includes('AI Suggest Deck Merges') && s.includes('deck.merge.suggest'),
        { timeoutMs: 8_000, label: 'ConfirmDialog suggest-merge en 80x24' },
      );
      tty.assertHealthyScreen(confirmScreen, 80, 24, 'ConfirmDialog --ascii en 80x24');
      tty.assertAsciiPure(confirmScreen, 'ConfirmDialog --ascii en 80x24');
      assert.equal(aiCalls, 0);

      tty.send('n');
      await tty.waitFor(
        (s) => !s.includes('AI Suggest Deck Merges') && s.includes('into selected target'),
        { timeoutMs: 8_000, label: 'Cancelled suggest-merge en' },
      );
      assert.equal(aiCalls, 0);

      tty.send('g');
      await tty.waitFor((s) => s.includes('AI Suggest Deck Merges'), { timeoutMs: 8_000 });
      tty.send('y');

      const suggestedScreen = await tty.waitFor(
        (s) => s.includes('* [a] Apply') && s.includes('Suggested merge:') && s.includes('a Apply'),
        { timeoutMs: 8_000, label: 'Suggestion banner rendered en 80x24' },
      );
      tty.assertHealthyScreen(suggestedScreen, 80, 24, 'Tab 2 with suggestion --ascii en 80x24');
      tty.assertAsciiPure(suggestedScreen, 'Tab 2 with suggestion --ascii en 80x24');
      assert.equal(aiCalls, 1, 'Expected exactly 1 AI call after [g] -> [y]');

      tty.send('a');
      const applyConfirmScreen = await tty.waitFor(
        (s) => s.includes('Confirm Merge Decks') && s.includes('Matrices Part 1'),
        { timeoutMs: 8_000, label: 'Confirm Merge Decks en 80x24' },
      );
      tty.assertHealthyScreen(applyConfirmScreen, 80, 24, 'Confirm Merge Decks --ascii en 80x24');
      tty.assertAsciiPure(applyConfirmScreen, 'Confirm Merge Decks --ascii en 80x24');
      assert.equal(aiCalls, 1);

      tty.send('n');
      await tty.waitFor((s) => !s.includes('Confirm Merge Decks'), { timeoutMs: 8_000 });
      tty.send('\x1b');
      await tty.waitFor((s) => !s.includes('Deck Operations'), { timeoutMs: 8_000 });
    } finally {
      try {
        inkInstance.unmount();
      } catch {
        // Ignore unmount error on teardown
      }
      await host.dispose();
      tty.dispose();
    }
  });

  test('3) createTuiHost deck.merge.suggest handles too-few-decks (0 AI calls) and unavailable model', async () => {
    const base = await makeTempDir('host-guards');
    const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');

    let aiCalls = 0;
    const host1 = await createTuiHost({
      env,
      home: join(base, 'home'),
      libraryRoot,
      discovery: fakeDiscovery(),
      injectedComplete: async () => {
        aiCalls += 1;
        return '{"proposals":[]}';
      },
      skipAutoProbe: true,
      language: 'en',
    });
    try {
      await host1.call('deck.import', {
        text: JSON.stringify({
          title: 'Solo Deck',
          course: 'Physics',
          cards: [{ kind: 'flashcard', prompt: 'F = ?', answer: 'ma', topic: 'Mechanics' }],
        }),
        folder: 'Physics',
      });
      await host1.call('focus.set', { course: 'Physics' });
      const resFew = await host1.call('deck.merge.suggest', {});
      assert.equal(resFew.ok, true);
      assert.equal(resFew.value?.method, 'too-few-decks');
      assert.deepEqual(resFew.value?.proposals, []);
      assert.equal(aiCalls, 0, 'too-few-decks must make 0 AI calls');
    } finally {
      await host1.dispose();
    }

    const base2 = await makeTempDir('host-unavail');
    const env2 = { ...process.env, DSH_HOME: join(base2, 'dsh-home') };
    const host2 = await createTuiHost({
      env: env2,
      home: join(base2, 'home'),
      libraryRoot: join(base2, 'library'),
      discovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'en',
    });
    try {
      await seedTwoCourseDecks(host2, 'Calculus');
      const resUnavail = await host2.call('deck.merge.suggest', {});
      assert.equal(resUnavail.ok, true);
      assert.equal(resUnavail.value?.method, 'unavailable');
      assert.deepEqual(resUnavail.value?.proposals, []);
    } finally {
      await host2.dispose();
    }
  });
});
