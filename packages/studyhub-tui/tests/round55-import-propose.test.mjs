// Round 55 Task 2: DeckOpsModal Tab 1 (Import JSON) On-Demand AI Filing Proposal (draft.import.propose)
// host integration + @xterm/headless PTY E2E tests:
// node --test --test-concurrency=1 tests/round55-import-propose.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round55-${label}-`));
  tempDirs.push(d);
  return d;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const UNICODE_UI_CHROME_RE = /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u27BF\u2800-\u28FF\u2190-\u21FF\u2022\u2026\u2039\u203A\u00B7]/g;

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

async function seedCourseDeck(host, title = 'Eigenvalues Core', course = 'Linear Algebra') {
  const res = await host.call('deck.import', {
    text: JSON.stringify({
      title,
      course,
      cards: [
        { kind: 'flashcard', prompt: 'Define an eigenvalue.', answer: 'Scalar lambda with Av = lambda v.', topic: 'Eigenvalues' },
      ],
    }),
    folder: course,
  });
  assert.equal(res.ok, true, `deck.import failed: ${res.error?.message}`);
  const snapRes = await host.refreshSnapshot();
  const deck = (snapRes.snapshot?.decks ?? []).find((d) => !d.archived && !d.systemKind && d.title === title);
  assert.ok(deck, `Expected seeded deck "${title}"`);
  return deck;
}

after(async () => {
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

describe('Round 55: DeckOpsModal Tab 1 On-Demand AI Filing Proposal', () => {
  test('1) createTuiHost draft.import.propose returns AI filing metadata (with model) and rules fallback (without model)', async () => {
    const base = await makeTempDir('host-int');
    const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');

    let aiCalls = 0;
    const hostAi = await createTuiHost({
      env,
      home: join(base, 'home'),
      libraryRoot,
      discovery: fakeDiscovery(),
      injectedComplete: async (system, prompt) => {
        aiCalls += 1;
        const parsed = JSON.parse(String(prompt || '{}'));
        const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
        const match = candidates.find((c) => c.course === 'Linear Algebra') ?? candidates[0];
        assert.ok(String(system || '').includes('Suggest filing metadata'));
        return JSON.stringify({
          title: 'Eigenvalue Practice Set',
          course: 'Linear Algebra',
          mergeTargetId: match?.id ?? null,
        });
      },
      skipAutoProbe: true,
      language: 'en',
    });

    const deckPayload = JSON.stringify({
      title: 'raw-eigen-upload',
      cards: [
        { kind: 'flashcard', prompt: 'What is the characteristic polynomial?', answer: 'det(A - lambda I)', topic: 'Eigenvalues' },
      ],
    });

    try {
      const targetDeck = await seedCourseDeck(hostAi, 'Eigenvalues Core', 'Linear Algebra');
      assert.equal(aiCalls, 0, 'Seeding deck must make 0 AI calls');

      const aiRes = await hostAi.call('draft.import.propose', { text: deckPayload });
      assert.equal(aiRes.ok, true, `draft.import.propose failed: ${aiRes.error?.message}`);
      assert.equal(aiCalls, 1, 'draft.import.propose must invoke model once');
      assert.equal(aiRes.value?.method, 'ai');
      assert.equal(aiRes.value?.originalTitle, 'raw-eigen-upload');
      assert.equal(aiRes.value?.title, 'Eigenvalue Practice Set');
      assert.equal(aiRes.value?.course, 'Linear Algebra');
      assert.equal(aiRes.value?.mergeTargetId, targetDeck.id);
    } finally {
      await hostAi.dispose();
    }

    const baseRules = await makeTempDir('host-rules');
    const envRules = { ...process.env, DSH_HOME: join(baseRules, 'dsh-home') };
    const hostRules = await createTuiHost({
      env: envRules,
      home: join(baseRules, 'home'),
      libraryRoot: join(baseRules, 'library'),
      discovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'en',
    });
    try {
      await seedCourseDeck(hostRules, 'Calc Core', 'Calculus');
      await hostRules.call('focus.set', { course: 'Calculus' });
      const rulesRes = await hostRules.call('draft.import.propose', { text: deckPayload });
      assert.equal(rulesRes.ok, true, `draft.import.propose rules failed: ${rulesRes.error?.message}`);
      assert.equal(rulesRes.value?.method, 'rules');
      assert.equal(rulesRes.value?.originalTitle, 'raw-eigen-upload');
      assert.equal(rulesRes.value?.title, 'raw-eigen-upload');
      assert.equal(rulesRes.value?.course, 'Calculus');
      assert.equal(rulesRes.value?.mergeTargetId, null);
    } finally {
      await hostRules.dispose();
    }
  });

  test('2) @xterm/headless PTY E2E (120x36 zh & 80x24 --ascii en): 0 auto calls, Ctrl+G P2 guard, n cancel, y propose + course fill + banner', async () => {
    // --- Scenario A: 120x36 zh ---
    {
      const base = await makeTempDir('e2e-zh');
      const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
      const libraryRoot = join(base, 'library');

      let aiCalls = 0;
      let capturedTargetId = null;
      const trackingComplete = async (system, prompt) => {
        aiCalls += 1;
        const parsed = JSON.parse(String(prompt || '{}'));
        const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
        const match = candidates.find((c) => c.course === 'Linear Algebra') ?? candidates[0];
        capturedTargetId = match?.id ?? null;
        assert.ok(String(system || '').includes('Suggest filing metadata'));
        return JSON.stringify({
          title: '特征值精选题组',
          course: 'Linear Algebra',
          mergeTargetId: capturedTargetId,
        });
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

      const seededDeck = await seedCourseDeck(host, 'Eigenvalues Core', 'Linear Algebra');
      const jsonPath = join(base, 'eigen-import.json');
      await writeFile(
        jsonPath,
        JSON.stringify(
          {
            title: 'Raw Eigen Draft',
            cards: [
              { kind: 'flashcard', prompt: 'What is trace(A)?', answer: 'Sum of eigenvalues.', topic: 'Eigenvalues' },
              { kind: 'flashcard', prompt: 'What is det(A)?', answer: 'Product of eigenvalues.', topic: 'Eigenvalues' },
            ],
          },
          null,
          2,
        ),
        'utf8',
      );

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
        await tty.waitFor((s) => s.includes('Eigenvalues Core'), { timeoutMs: 8_000, label: 'LibraryView seeded zh' });
        assert.equal(aiCalls, 0);

        // Open DeckOpsModal Tab 1
        tty.send('o');
        const tab1Open = await tty.waitFor(
          (s) => s.includes('题组操作中心') && s.includes('Ctrl+G') && s.includes('AI归档建议'),
          { timeoutMs: 8_000, label: 'DeckOpsModal Tab 1 zh' },
        );
        tty.assertHealthyScreen(tab1Open, 120, 36, 'DeckOpsModal Tab 1 zh');

        // Ctrl+G before valid path -> info toast, 0 calls
        tty.send('\u0007');
        await tty.waitFor(
          (s) => s.includes('请先输入有效的 JSON 题组文件路径'),
          { timeoutMs: 8_000, label: 'Info toast on empty path Ctrl+G zh' },
        );
        assert.equal(aiCalls, 0, 'Ctrl+G with empty path must make 0 AI calls');

        // Enter valid JSON path -> wait for JSON preview -> verify 0 model calls
        tty.send(jsonPath);
        const previewScreen = await tty.waitFor(
          (s) => s.includes('Raw Eigen Draft') && s.includes('2 题'),
          { timeoutMs: 8_000, label: 'JSON preview validated zh' },
        );
        tty.assertHealthyScreen(previewScreen, 120, 36, 'Tab 1 JSON preview zh');
        await sleep(220);
        await tty.flush();
        assert.equal(aiCalls, 0, 'JSON preview load must make 0 automatic AI calls');

        // Press Ctrl+G -> P2 ConfirmDialog appears with 0 model calls
        tty.send('\u0007');
        const confirmScreen = await tty.waitFor(
          (s) => s.includes('AI 建议导入归档信息') && s.includes('draft.import.propose') && s.includes('Raw Eigen Draft'),
          { timeoutMs: 8_000, label: 'P2 ConfirmDialog opened via Ctrl+G zh' },
        );
        tty.assertHealthyScreen(confirmScreen, 120, 36, 'ConfirmDialog propose-import zh');
        assert.equal(aiCalls, 0, 'Opening ConfirmDialog must make 0 AI calls');

        // Press n -> cancels cleanly with 0 model calls
        tty.send('n');
        await tty.waitFor(
          (s) => !s.includes('AI 建议导入归档信息') && s.includes('本地题组 JSON 路径'),
          { timeoutMs: 8_000, label: 'ConfirmDialog cancelled with n zh' },
        );
        await sleep(150);
        await tty.flush();
        assert.equal(aiCalls, 0, 'Cancelling ConfirmDialog with n must make 0 AI calls');

        // Move focus to Course Override TextInput, press Ctrl+G then y -> executes draft.import.propose once
        tty.send('\x1b[B'); // DownArrow -> course field
        await tty.flush();
        tty.send('\u0007'); // Ctrl+G works while course TextInput has focus
        await tty.waitFor(
          (s) => s.includes('AI 建议导入归档信息'),
          { timeoutMs: 8_000, label: 'ConfirmDialog reopened from course field zh' },
        );
        tty.send('y');

        const proposedScreen = await tty.waitFor(
          (s) =>
            s.includes('建议归属: 课程 Linear Algebra') &&
            s.includes('标题 特征值精选题组') &&
            s.includes(seededDeck.title),
          { timeoutMs: 8_000, label: 'Proposal banner + auto-populated course zh' },
        );
        tty.assertHealthyScreen(proposedScreen, 120, 36, 'Tab 1 with proposal zh');
        assert.equal(aiCalls, 1, 'Confirming Ctrl+G -> y must invoke model exactly once');
        assert.equal(capturedTargetId, seededDeck.id);

        // Changing filePath resets importProposal banner
        tty.send('\x1b[A'); // UpArrow -> path field
        await tty.flush();
        tty.send('x');
        await tty.waitFor(
          (s) => !s.includes('建议归属:'),
          { timeoutMs: 8_000, label: 'Proposal cleared when filePath changes zh' },
        );
        assert.equal(aiCalls, 1, 'Editing path after proposal must make 0 extra AI calls');
      } finally {
        try {
          inkInstance.unmount();
        } catch {
          // Ignore unmount error on teardown
        }
        await host.dispose();
        tty.dispose();
      }
    }

    // --- Scenario B: 80x24 --ascii en ---
    {
      const base = await makeTempDir('e2e-ascii');
      const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
      const libraryRoot = join(base, 'library');

      let aiCalls = 0;
      const trackingComplete = async (_system, prompt) => {
        aiCalls += 1;
        const parsed = JSON.parse(String(prompt || '{}'));
        const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
        const match = candidates.find((c) => c.course === 'Math') ?? candidates[0];
        return JSON.stringify({
          title: 'Eigen Set',
          course: 'Math',
          mergeTargetId: match?.id ?? null,
        });
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

      const seededDeck = await seedCourseDeck(host, 'Eigen Core', 'Math');
      const jsonPath = join(base, 'eigen-ascii.json');
      await writeFile(
        jsonPath,
        JSON.stringify({
          title: 'ASCII Eigen Draft',
          cards: [
            { kind: 'flashcard', prompt: 'Define spectral radius.', answer: 'Max |lambda|.', topic: 'Eigenvalues' },
          ],
        }),
        'utf8',
      );

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
        await tty.waitFor((s) => s.includes('Eigen Core'), { timeoutMs: 8_000, label: 'LibraryView seeded en' });

        tty.send('o');
        const tab1Screen = await tty.waitFor(
          (s) => s.includes('Deck Operations') && s.includes('Ctrl+G AI Filing'),
          { timeoutMs: 8_000, label: 'DeckOpsModal Tab 1 en 80x24' },
        );
        tty.assertHealthyScreen(tab1Screen, 80, 24, 'Tab 1 --ascii en 80x24');
        tty.assertAsciiPure(tab1Screen, 'Tab 1 --ascii en 80x24');

        tty.send(jsonPath);
        const previewScreen = await tty.waitFor(
          (s) => s.includes('ASCII Eigen Draft') && s.includes('[OK] 1c'),
          { timeoutMs: 8_000, label: 'JSON preview en 80x24' },
        );
        tty.assertHealthyScreen(previewScreen, 80, 24, 'Tab 1 preview --ascii en 80x24');
        tty.assertAsciiPure(previewScreen, 'Tab 1 preview --ascii en 80x24');
        await sleep(220);
        await tty.flush();
        assert.equal(aiCalls, 0, 'JSON preview in --ascii en must make 0 AI calls');

        tty.send('\u0007');
        const confirmScreen = await tty.waitFor(
          (s) => s.includes('AI Suggest Import Filing') && s.includes('draft.import.propose'),
          { timeoutMs: 8_000, label: 'ConfirmDialog propose-import en 80x24' },
        );
        tty.assertHealthyScreen(confirmScreen, 80, 24, 'ConfirmDialog --ascii en 80x24');
        tty.assertAsciiPure(confirmScreen, 'ConfirmDialog --ascii en 80x24');
        assert.equal(aiCalls, 0);

        tty.send('n');
        await tty.waitFor((s) => !s.includes('AI Suggest Import Filing'), { timeoutMs: 8_000, label: 'ConfirmDialog cancelled en' });
        assert.equal(aiCalls, 0);

        tty.send('\u0007');
        await tty.waitFor((s) => s.includes('AI Suggest Import Filing'), { timeoutMs: 8_000 });
        tty.send('y');

        const proposedScreen = await tty.waitFor(
          (s) =>
            s.includes('* Suggested: Course Math') &&
            s.includes('Title Eigen Set') &&
            s.includes(`Merge:${seededDeck.title}`),
          { timeoutMs: 8_000, label: 'Proposal banner rendered --ascii en 80x24' },
        );
        tty.assertHealthyScreen(proposedScreen, 80, 24, 'Tab 1 with proposal --ascii en 80x24');
        tty.assertAsciiPure(proposedScreen, 'Tab 1 with proposal --ascii en 80x24');
        assert.equal(aiCalls, 1, 'Expected exactly 1 AI call after Ctrl+G -> y');
      } finally {
        try {
          inkInstance.unmount();
        } catch {
          // Ignore unmount error on teardown
        }
        await host.dispose();
        tty.dispose();
      }
    }
  });
});
