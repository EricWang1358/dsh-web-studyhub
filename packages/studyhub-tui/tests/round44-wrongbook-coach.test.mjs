// Round 44 WrongBook Coach Variant Practice (coach.practice via [V]) & HelpOverlay/KEYBINDINGS sync
// integration + @xterm/headless PTY E2E tests:
// node --test tests/round44-wrongbook-coach.test.mjs
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
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('chunk-') || f.startsWith('store-')) {
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

function resetDistStore(language = 'zh', asciiMode = false) {
  useDistTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    snapshot: null,
    binding: null,
    desktopConfig: null,
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
  });
}

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round44-wb-${label}-`));
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

function createVariantStubComplete() {
  return async (_system, prompt) => {
    const raw = String(prompt || '');
    if (raw.includes('OK?')) return 'OK';
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return '{}';
    }
    if (!Array.isArray(parsed?.targets)) return '{}';
    const ev = Array.isArray(parsed.evidence) && parsed.evidence.length > 0 ? parsed.evidence[0] : null;
    const rawText = String(ev?.text || '');
    const quote = rawText.replace(/\s+/g, ' ').trim().slice(0, 48);
    // Pick a verbatim slice directly from ev.text (>= 12 chars) so validateDeck citation check passes.
    const verbatim = rawText.length >= 24 ? rawText.slice(0, Math.min(48, rawText.length)) : quote;
    const cards = parsed.targets.map((target, idx) => {
      const kind = target.kind === 'truefalse' || target.kind === 'open' || target.kind === 'task' ? target.kind : 'quiz';
      const base = {
        target: idx,
        kind,
        topic: target.card?.topic || 'Design Patterns',
        objective: target.card?.objective || 'Distinguish structural intent',
        prompt: `Variant practice question #${idx + 1} for ${target.card?.topic || 'Design Patterns'}: which statement matches the source?`,
        answer: kind === 'truefalse' ? 'true' : 'First verified option',
        hint: 'Check the core boundary described in the passage.',
        explanation: 'Directly supported by the cited material excerpt.',
        misconception: 'Confusing unrelated responsibilities.',
        citations: ev && verbatim.length >= 12 ? [{ sourceId: ev.sourceId, quote: verbatim }] : [],
      };
      if (kind === 'truefalse') {
        return {
          ...base,
          options: [
            { id: 'true', text: 'True', correct: true, explanation: 'Matches the cited text.' },
            { id: 'false', text: 'False', correct: false, explanation: 'Contradicts the cited text.' },
          ],
        };
      }
      if (kind === 'open' || kind === 'task') {
        return {
          ...base,
          rubric: '1. State the exact responsibility; 2. Explain why alternatives fail.',
        };
      }
      return {
        ...base,
        options: [
          { id: 'a', text: 'First verified option', correct: true, explanation: 'Consistent with the cited passage.' },
          { id: 'b', text: 'Second distractor option', correct: false, explanation: 'Violates encapsulation boundary.' },
          { id: 'c', text: 'Third distractor option', correct: false, explanation: 'Applies to a different pattern.' },
        ],
      };
    });
    return JSON.stringify({ cards });
  };
}

after(async () => {
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

describe('Round 44: WrongBook Coach Variant Practice ([V] / coach.practice)', () => {
  test('1) createTuiHost integration: coach.practice errors cleanly when none ready, then starts review run when prepared variant is ready', async () => {
    const base = await makeTempDir('host');
    const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
    const host = await createTuiHost({
      libraryRoot: join(base, 'library'),
      env,
      home: base,
      documentsDir: base,
      providerDiscovery: fakeDiscovery(),
      injectedComplete: createVariantStubComplete(),
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      const sampleRes = await host.call('sample.load', { language: 'en' });
      assert.equal(sampleRes.ok, true, sampleRes.error?.message);

      // No prepared variants ready yet -> clean error
      const emptyPractice = await host.call('coach.practice', {});
      assert.equal(emptyPractice.ok, false, 'coach.practice must fail cleanly when no variants are ready');
      assert.ok(
        emptyPractice.error?.message?.includes('No custom question is ready yet') ||
          emptyPractice.error?.message?.includes('还没有备好的定制题'),
        `unexpected error message: ${emptyPractice.error?.message}`,
      );

      // Locate a wrongbook item and queue + prepare a variant
      const wb = await host.call('wrongbook', { course: '*', view: 'weak', offset: 0, limit: 20 });
      assert.equal(wb.ok, true, wb.error?.message);
      const target = wb.value?.items?.[0];
      assert.ok(target?.deckId && target?.cardId, 'sample course should have at least 1 wrongbook item');

      const varRes = await host.call('coach.variants', {
        cards: [{ deckId: target.deckId, cardId: target.cardId }],
        consent: true,
      });
      assert.equal(varRes.ok, true, varRes.error?.message);
      assert.equal(varRes.value?.queued, 1, 'coach.variants should queue 1 variant');

      const prepStatus = await host.call('coach.prepare', {});
      assert.equal(prepStatus.ok, true, prepStatus.error?.message);
      assert.ok((prepStatus.value?.ready ?? 0) >= 1, 'coach.prepare should produce at least 1 ready variant');

      // Scoped to a non-matching originCardId still returns clean error without consuming ready variant
      const missPractice = await host.call('coach.practice', { originCardIds: ['nonexistent-origin-id'] });
      assert.equal(missPractice.ok, false);

      // Scoped to target.cardId succeeds and starts a review run
      const runRes = await host.call('coach.practice', { originCardIds: [target.cardId] });
      assert.equal(runRes.ok, true, runRes.error?.message);
      assert.ok(runRes.value?.id, 'coach.practice should return started review run id');
      assert.ok((runRes.value?.total ?? 0) >= 1, 'started run should have total >= 1');
      assert.ok(runRes.value?.card?.id, 'started run should have active card');

      const getRun = await host.call('review.get', { runId: runRes.value.id });
      assert.equal(getRun.ok, true, getRun.error?.message);
      assert.equal(getRun.value?.id, runRes.value.id);
      assert.equal(getRun.value?.card?.id, runRes.value.card.id);
    } finally {
      await host.dispose();
    }
  });

  test('2) PTY E2E: WrongBookView [V] shows helpful toast when no variants ready (zh & --ascii en at 120x36 & 80x24) and launches ReviewView when ready', async () => {
    // 2a) Default zh mode at 120x36 & 80x24
    const zhBase = await makeTempDir('pty-zh');
    const zhDshHome = join(zhBase, 'dsh-home');
    process.env.DSH_HOME = zhDshHome;
    await saveTuiPreferences(
      { language: 'zh', asciiMode: false, theme: 'tokyo-night', mathUnicode: true, showHints: true },
      { env: { ...process.env, DSH_HOME: zhDshHome } },
    );

    const zhHost = await createTuiHost({
      libraryRoot: join(zhBase, 'library'),
      env: { ...process.env, DSH_HOME: zhDshHome },
      home: join(zhBase, 'home'),
      documentsDir: zhBase,
      providerDiscovery: fakeDiscovery(),
      injectedComplete: createVariantStubComplete(),
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    const zhTty = createVirtualTty(120, 36);
    let zhInk = null;
    try {
      resetDistStore('zh', false);
      zhInk = render(
        React.createElement(StudyHubTuiApp, {
          host: zhHost,
          initialPage: 'library',
          initialLanguage: 'zh',
          initialAsciiMode: false,
          autoLaunchpad: true,
          onExit: () => zhInk?.unmount(),
        }),
        {
          stdin: zhTty.stdin,
          stdout: zhTty.stdout,
          stderr: zhTty.stderr,
          interactive: true,
          exitOnCtrlC: false,
          patchConsole: false,
        },
      );
      await zhTty.firstFramePromise;

      await zhTty.waitFor((s) => s.includes('载入示例课程体验'), { label: 'zh Launchpad render' });
      zhTty.send('s');
      await zhTty.waitFor(
        (s) => !s.includes('载入示例课程体验') && s.includes('示例 · Memento 与 Bridge'),
        { timeoutMs: 12_000, label: 'zh sample loaded' },
      );

      zhTty.send('4');
      const zhWb = await zhTty.waitFor(
        (s) => s.includes('错题列表') && !s.includes('正在加载错题本'),
        { timeoutMs: 10_000, label: 'zh WrongBookView rendered' },
      );
      zhTty.assertHealthyScreen(zhWb, 120, 36, 'zh WrongBookView 120x36');

      // Press V when no variants ready -> helpful toast guiding to ExamCoach (9) [g]
      zhTty.send('V');
      const zhToastWide = await zhTty.waitFor(
        (s) => s.includes('无变式') && s.includes('考试教练(9)[g]'),
        { timeoutMs: 6_000, label: 'zh WrongBook [V] no-variants toast at 120x36' },
      );
      zhTty.assertHealthyScreen(zhToastWide, 120, 36, 'zh WrongBook [V] toast 120x36');

      // Verify HelpOverlay includes Round 44 [V] shortcut at 120x36 (two-column view)
      zhTty.send('?');
      await zhTty.waitFor((s) => s.includes('快捷键'), { timeoutMs: 6_000, label: 'zh HelpOverlay opened' });
      zhTty.send('\x06\x06'); // Ctrl+F full-page scroll to Wrong Book section in HelpOverlay ScrollView
      const zhHelp = await zhTty.waitFor(
        (s) => {
          if (s.includes('快捷键') && s.includes('练错题变式')) return true;
          zhTty.send('\x04');
          return false;
        },
        { timeoutMs: 6_000, label: 'zh HelpOverlay shows Round 44 Wrong Book [V]' },
      );
      zhTty.assertHealthyScreen(zhHelp, 120, 36, 'zh HelpOverlay 120x36');
      zhTty.send('\x1b');
      await zhTty.waitFor((s) => !s.includes('快捷键'), { timeoutMs: 5_000, label: 'zh HelpOverlay closed' });

      // Verify 80x24 narrow layout
      zhTty.resize(80, 24);
      const zhNarrow = await zhTty.waitFor(
        (s) => s.includes('错题列表') && s.split('\n').length <= 24,
        { timeoutMs: 6_000, label: 'zh WrongBookView at 80x24' },
      );
      zhTty.assertHealthyScreen(zhNarrow, 80, 24, 'zh WrongBookView 80x24');

      zhTty.send('V');
      const zhToastNarrow = await zhTty.waitFor(
        (s) => s.includes('无变式') && s.includes('考试教练(9)[g]'),
        { timeoutMs: 6_000, label: 'zh WrongBook [V] no-variants toast at 80x24' },
      );
      zhTty.assertHealthyScreen(zhToastNarrow, 80, 24, 'zh WrongBook [V] toast 80x24');
    } finally {
      try {
        zhInk?.unmount();
      } catch {
        // ignore
      }
      await zhHost.dispose();
      zhTty.dispose();
    }

    // 2b) --ascii en mode at 120x36 & 80x24 (no-variants toast + happy-path launch to ReviewView)
    const enBase = await makeTempDir('pty-ascii-en');
    const enDshHome = join(enBase, 'dsh-home');
    process.env.DSH_HOME = enDshHome;
    await saveTuiPreferences(
      { language: 'en', asciiMode: true, theme: 'tokyo-night', mathUnicode: false, showHints: true },
      { env: { ...process.env, DSH_HOME: enDshHome } },
    );

    const enHost = await createTuiHost({
      libraryRoot: join(enBase, 'library'),
      env: { ...process.env, DSH_HOME: enDshHome },
      home: join(enBase, 'home'),
      documentsDir: enBase,
      providerDiscovery: fakeDiscovery(),
      injectedComplete: createVariantStubComplete(),
      skipAutoProbe: true,
      language: 'en',
      eventDebounceMs: 30,
    });

    const enTty = createVirtualTty(120, 36);
    let enInk = null;
    try {
      resetDistStore('en', true);
      enInk = render(
        React.createElement(StudyHubTuiApp, {
          host: enHost,
          initialPage: 'library',
          initialLanguage: 'en',
          initialAsciiMode: true,
          autoLaunchpad: true,
          onExit: () => enInk?.unmount(),
        }),
        {
          stdin: enTty.stdin,
          stdout: enTty.stdout,
          stderr: enTty.stderr,
          interactive: true,
          exitOnCtrlC: false,
          patchConsole: false,
        },
      );
      await enTty.firstFramePromise;

      await enTty.waitFor((s) => s.includes('Load the sample course'), { label: 'en Launchpad render' });
      enTty.send('s');
      await enTty.waitFor(
        (s) => !s.includes('Load the sample course') && s.includes('Memento'),
        { timeoutMs: 12_000, label: 'en sample loaded' },
      );

      enTty.send('4');
      const enWb = await enTty.waitFor(
        (s) => s.includes('Mistakes') && !s.includes('Loading mistakes'),
        { timeoutMs: 10_000, label: 'en WrongBookView rendered' },
      );
      enTty.assertHealthyScreen(enWb, 120, 36, 'en WrongBookView 120x36');
      enTty.assertAsciiPure(enWb, 'en WrongBookView 120x36');

      // Press V when no variants ready -> helpful ASCII-pure toast
      enTty.send('V');
      const enToastWide = await enTty.waitFor(
        (s) => s.includes('No variants') && s.includes('ExamCoach(9)[g]'),
        { timeoutMs: 6_000, label: 'en WrongBook [V] no-variants toast at 120x36' },
      );
      enTty.assertHealthyScreen(enToastWide, 120, 36, 'en WrongBook [V] toast 120x36');
      enTty.assertAsciiPure(enToastWide, 'en WrongBook [V] toast 120x36');

      // Verify 80x24 narrow layout
      enTty.resize(80, 24);
      const enNarrow = await enTty.waitFor(
        (s) => s.includes('Mistakes') && s.split('\n').length <= 24,
        { timeoutMs: 6_000, label: 'en WrongBookView at 80x24' },
      );
      enTty.assertHealthyScreen(enNarrow, 80, 24, 'en WrongBookView 80x24');
      enTty.assertAsciiPure(enNarrow, 'en WrongBookView 80x24');

      enTty.send('V');
      const enToastNarrow = await enTty.waitFor(
        (s) => s.includes('No variants; ExamCoach'),
        { timeoutMs: 6_000, label: 'en WrongBook [V] no-variants toast at 80x24' },
      );
      enTty.assertHealthyScreen(enToastNarrow, 80, 24, 'en WrongBook [V] toast 80x24');
      enTty.assertAsciiPure(enToastNarrow, 'en WrongBook [V] toast 80x24');

      // Prepare a variant for the currently highlighted wrongbook card, then press [V] to launch ReviewView
      const wb = await enHost.call('wrongbook', { course: '*', view: 'weak', offset: 0, limit: 20 });
      assert.equal(wb.ok, true);
      const firstWrong = wb.value?.items?.[0];
      assert.ok(firstWrong?.deckId && firstWrong?.cardId);
      const varRes = await enHost.call('coach.variants', {
        cards: [{ deckId: firstWrong.deckId, cardId: firstWrong.cardId }],
        consent: true,
      });
      assert.equal(varRes.ok, true, varRes.error?.message);
      const prepRes = await enHost.call('coach.prepare', {});
      assert.equal(prepRes.ok, true, prepRes.error?.message);
      assert.ok((prepRes.value?.ready ?? 0) >= 1);

      enTty.resize(120, 36);
      await enTty.waitFor((s) => s.includes('Mistakes'), { timeoutMs: 6_000, label: 'en WrongBook back at 120x36' });
      enTty.send('V');
      const reviewScreen = await enTty.waitFor(
        (s) =>
          useDistTuiStore.getState().page === 'review' &&
          Boolean(useDistTuiStore.getState().activeRunId) &&
          (s.includes('Started mistake variant practice') || s.includes('Variant practice question')),
        { timeoutMs: 10_000, label: 'en WrongBook [V] launched ReviewView' },
      );
      enTty.assertHealthyScreen(reviewScreen, 120, 36, 'en ReviewView after WrongBook [V]');
      enTty.assertAsciiPure(reviewScreen, 'en ReviewView after WrongBook [V]');
    } finally {
      try {
        enInk?.unmount();
      } catch {
        // ignore
      }
      await enHost.dispose();
      enTty.dispose();
    }
  });
});
