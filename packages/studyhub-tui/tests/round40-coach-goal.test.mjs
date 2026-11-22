// Round 40 Coach Goal Selector (coach.goal), Card Quality Feedback (coach.feedback + rewriteVia: 'assist')
// & Coach Rewrite Revert (coach.revert) integration + @xterm/headless PTY E2E tests:
// node --test tests/round40-coach-goal.test.mjs
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
  });
}

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

describe('Round 40: Coach Learning Goal, Card Quality Feedback & Coach Revert', () => {
  test('1) createTuiHost integration: coach.profile -> coach.goal + coach.feedback (rewriteVia: assist, 0 AI calls) + coach.revert', async () => {
    const base = await makeTempDir('host');
    const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');

    let aiCalls = 0;
    const trackingComplete = async () => {
      aiCalls += 1;
      throw new Error('Unexpected AI model invocation during P2-safe operations');
    };

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      providerDiscovery: fakeDiscovery(),
      injectedComplete: trackingComplete,
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      const sampleRes = await host.call('sample.load', { language: 'en' });
      assert.equal(sampleRes.ok, true, sampleRes.error?.message);

      // 1a) coach.profile -> coach.goal (compare-and-set memoryRevision + unknown goal refusal)
      const prof0 = await host.call('coach.profile', {});
      assert.equal(prof0.ok, true, prof0.error?.message);
      assert.equal(prof0.value?.goal, '');
      const rev0 = prof0.value?.memoryRevision ?? 0;

      const setExam = await host.call('coach.goal', { goal: 'exam', expectedRevision: rev0 });
      assert.equal(setExam.ok, true, setExam.error?.message);
      assert.equal(setExam.value?.goal, 'exam');
      assert.equal(setExam.value?.memoryRevision, rev0 + 1);

      const prof1 = await host.call('coach.profile', {});
      assert.equal(prof1.ok, true);
      assert.equal(prof1.value?.goal, 'exam');
      assert.equal(prof1.value?.memoryRevision, rev0 + 1);

      // Stale revision must be refused
      const staleRes = await host.call('coach.goal', { goal: 'work', expectedRevision: rev0 });
      assert.equal(staleRes.ok, false, 'stale expectedRevision must be refused');
      assert.match(staleRes.error?.message ?? '', /更新|刷新|conflict/i);

      // Unknown goal must be refused
      const unknownRes = await host.call('coach.goal', { goal: 'deep-invalid', expectedRevision: rev0 + 1 });
      assert.equal(unknownRes.ok, false, 'unknown goal must be refused');
      assert.match(unknownRes.error?.message ?? '', /Unknown goal/i);

      // 1b) coach.feedback (vote up, vote down with valid tag + rewriteVia: 'assist', vote up + tag refusal, 0 AI calls)
      const snap = await host.call('snapshot', {});
      assert.equal(snap.ok, true);
      const deck = (snap.value?.decks ?? []).find((d) => !d.systemKind);
      assert.ok(deck, 'sample course must include an ordinary deck');
      const deckDetail = await host.call('deck.get', { id: deck.id });
      assert.equal(deckDetail.ok, true);
      const card = deckDetail.value.cards[0];
      assert.ok(card?.id, 'deck must contain at least one card');

      const upRes = await host.call('coach.feedback', {
        deckId: deck.id,
        cardId: card.id,
        vote: 'up',
        rewriteVia: 'assist',
      });
      assert.equal(upRes.ok, true, upRes.error?.message);
      assert.equal(upRes.value?.vote, 'up');
      assert.deepEqual(upRes.value?.scheduled, []);

      const upWithTagRes = await host.call('coach.feedback', {
        deckId: deck.id,
        cardId: card.id,
        vote: 'up',
        tags: ['stem-vague'],
        rewriteVia: 'assist',
      });
      assert.equal(upWithTagRes.ok, false, 'vote up with problem tags must be refused');
      assert.match(upWithTagRes.error?.message ?? '', /Tags describe a problem/i);

      const downRes = await host.call('coach.feedback', {
        deckId: deck.id,
        cardId: card.id,
        vote: 'down',
        tags: ['wrong-answer'],
        rewriteVia: 'assist',
      });
      assert.equal(downRes.ok, true, downRes.error?.message);
      assert.equal(downRes.value?.vote, 'down');
      assert.deepEqual(downRes.value?.tags, ['wrong-answer']);
      assert.equal(downRes.value?.scheduled?.includes('rewrite'), false, 'rewriteVia: assist must never schedule silent rewrite');
      assert.deepEqual(downRes.value?.fix, ['wrong-answer']);
      assert.equal(aiCalls, 0, 'coach.feedback with rewriteVia: assist must make 0 AI calls');

      // 1c) coach.revert: no-earlier-version clean refusal
      const revertEmpty = await host.call('coach.revert', { deckId: deck.id, cardId: card.id });
      assert.equal(revertEmpty.ok, false, 'coach.revert without revisions must refuse cleanly');
      assert.match(revertEmpty.error?.message ?? '', /no earlier version/i);
      assert.equal(aiCalls, 0, 'all Round 40 host operations must make 0 AI calls');
    } finally {
      await host.dispose();
    }
  });

  test('2) PTY E2E: CoachPreferencesModal cycles [g] learning goal cleanly in default (zh) and --ascii (en) modes', async () => {
    // 2a) Default (zh) mode
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

      zhTty.send('9');
      await zhTty.waitFor(
        (s) => s.includes('考试教练') && s.includes('校准与考法') && !s.includes('正在加载'),
        { timeoutMs: 10_000, label: 'zh ExamCoachView rendered' },
      );

      zhTty.send('p');
      const zhPrefs0 = await zhTty.waitFor(
        (s) => s.includes('学习者画像与长期偏好') && s.includes('[g] 目标: 未设定') && !s.includes('正在读取学习者画像'),
        { timeoutMs: 8_000, label: 'zh CoachPreferencesModal opened with unset goal' },
      );
      zhTty.assertHealthyScreen(zhPrefs0, 120, 36, 'zh CoachPreferencesModal initial');

      // Press [g] -> 应付考试 (exam)
      zhTty.send('g');
      const zhPrefsExam = await zhTty.waitFor(
        (s) => s.includes('[g] 目标: 应付考试'),
        { timeoutMs: 8_000, label: 'zh CoachPreferencesModal goal cycled to exam' },
      );
      zhTty.assertHealthyScreen(zhPrefsExam, 120, 36, 'zh CoachPreferencesModal goal=exam');

      // Press [g] -> 面试求职 (interview)
      zhTty.send('g');
      const zhPrefsInterview = await zhTty.waitFor(
        (s) => s.includes('[g] 目标: 面试求职'),
        { timeoutMs: 8_000, label: 'zh CoachPreferencesModal goal cycled to interview' },
      );
      zhTty.assertHealthyScreen(zhPrefsInterview, 120, 36, 'zh CoachPreferencesModal goal=interview');

      const zhProf = await zhHost.call('coach.profile', {});
      assert.equal(zhProf.ok, true);
      assert.equal(zhProf.value?.goal, 'interview');
      assert.equal(zhProf.value?.memoryRevision, 2);

      // Also verify 80x24 narrow layout
      zhTty.resize(80, 24);
      const zhNarrow = await zhTty.waitFor(
        (s) => s.includes('[g] 目标: 面试求职') && s.split('\n').length <= 24,
        { timeoutMs: 8_000, label: 'zh CoachPreferencesModal at 80x24' },
      );
      zhTty.assertHealthyScreen(zhNarrow, 80, 24, 'zh CoachPreferencesModal 80x24');

      zhTty.send('\x1b');
      await zhTty.waitFor(
        (s) => !s.includes('学习者画像与长期偏好') && s.includes('考试教练'),
        { timeoutMs: 8_000, label: 'zh CoachPreferencesModal closed' },
      );
    } finally {
      try {
        zhInk?.unmount();
      } catch {
        // ignore
      }
      await zhHost.dispose();
      zhTty.dispose();
    }

    // 2b) --ascii (en) mode + CardToolsModal feedback & revert verification
    const enBase = await makeTempDir('pty-ascii-en');
    const enDshHome = join(enBase, 'dsh-home');
    process.env.DSH_HOME = enDshHome;
    await saveTuiPreferences(
      { language: 'en', asciiMode: true, theme: 'tokyo-night', mathUnicode: false, showHints: true },
      { env: { ...process.env, DSH_HOME: enDshHome } },
    );

    let enAiCalls = 0;
    const enHost = await createTuiHost({
      libraryRoot: join(enBase, 'library'),
      env: { ...process.env, DSH_HOME: enDshHome },
      home: join(enBase, 'home'),
      documentsDir: enBase,
      providerDiscovery: fakeDiscovery(),
      injectedComplete: async () => {
        enAiCalls += 1;
        throw new Error('Unexpected AI call in --ascii E2E');
      },
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

      // Open ExamCoach ('9') -> CoachPreferencesModal ('p')
      enTty.send('9');
      await enTty.waitFor(
        (s) => s.includes('Exam Coach') && s.includes('Calibration') && !s.includes('Loading'),
        { timeoutMs: 10_000, label: 'en ExamCoachView rendered' },
      );

      enTty.send('p');
      const enPrefs0 = await enTty.waitFor(
        (s) => s.includes('Learner Profile & Preferences') && s.includes('[g] Goal: Not set') && !s.includes('Loading learner profile'),
        { timeoutMs: 8_000, label: 'en CoachPreferencesModal opened' },
      );
      enTty.assertHealthyScreen(enPrefs0, 120, 36, 'en ASCII CoachPreferencesModal initial');
      enTty.assertAsciiPure(enPrefs0, 'en ASCII CoachPreferencesModal initial');

      enTty.send('g');
      const enPrefsExam = await enTty.waitFor(
        (s) => s.includes('[g] Goal: Pass Exam'),
        { timeoutMs: 8_000, label: 'en CoachPreferencesModal goal cycled to Pass Exam' },
      );
      enTty.assertHealthyScreen(enPrefsExam, 120, 36, 'en ASCII CoachPreferencesModal goal=exam');
      enTty.assertAsciiPure(enPrefsExam, 'en ASCII CoachPreferencesModal goal=exam');

      enTty.send('g');
      const enPrefsInterview = await enTty.waitFor(
        (s) => s.includes('[g] Goal: Job Interview'),
        { timeoutMs: 8_000, label: 'en CoachPreferencesModal goal cycled to Job Interview' },
      );
      enTty.assertHealthyScreen(enPrefsInterview, 120, 36, 'en ASCII CoachPreferencesModal goal=interview');
      enTty.assertAsciiPure(enPrefsInterview, 'en ASCII CoachPreferencesModal goal=interview');

      const enProf = await enHost.call('coach.profile', {});
      assert.equal(enProf.ok, true);
      assert.equal(enProf.value?.goal, 'interview');
      assert.equal(enProf.value?.memoryRevision, 2);

      enTty.send('\x1b');
      await enTty.waitFor(
        (s) => !s.includes('Learner Profile & Preferences') && s.includes('Exam Coach'),
        { timeoutMs: 8_000, label: 'en CoachPreferencesModal closed' },
      );

      // Also verify CardToolsModal [9] Card Quality Feedback & [0] Revert Last Rewrite in --ascii mode
      // Backspace returns from ExamCoachView back to LibraryView (1-4 are claimed by ExamCoach tabs)
      enTty.send('\x7f');
      await enTty.waitFor(
        (s) => s.includes('Memento') && s.includes('Bridge') && !s.includes('Exam Coach') && !s.includes('Loading'),
        { timeoutMs: 10_000, label: 'en LibraryView rendered' },
      );
      enTty.send('\r');
      await enTty.waitFor(
        (s) => s.includes('[D]Tools') && /\b1\/\d+/.test(s),
        { timeoutMs: 10_000, label: 'en ReviewView rendered' },
      );

      enTty.send('D');
      const toolsMenu = await enTty.waitFor(
        (s) => s.includes('Card Tools') && s.includes('Card Quality Feedback') && s.includes('Revert Last Rewrite'),
        { timeoutMs: 8_000, label: 'en CardToolsModal opened' },
      );
      enTty.assertHealthyScreen(toolsMenu, 120, 36, 'en ASCII CardToolsModal menu');
      enTty.assertAsciiPure(toolsMenu, 'en ASCII CardToolsModal menu');

      // Press '0' with no revisions -> clean info message
      enTty.send('0');
      const noRevInfo = await enTty.waitFor(
        (s) => s.includes('No earlier rewrite version exists'),
        { timeoutMs: 5_000, label: 'en CardToolsModal no-revision info message' },
      );
      enTty.assertAsciiPure(noRevInfo, 'en ASCII CardToolsModal no-rev info');

      // Press '9' -> Card Quality Feedback, toggle tag 1 (general-quality), submit with Enter
      enTty.send('9');
      const fbScreen = await enTty.waitFor(
        (s) => s.includes('Card Quality Feedback') && s.includes('Stem too vague'),
        { timeoutMs: 5_000, label: 'en CardToolsModal feedback view opened' },
      );
      enTty.assertHealthyScreen(fbScreen, 120, 36, 'en ASCII CardToolsModal feedback');
      enTty.assertAsciiPure(fbScreen, 'en ASCII CardToolsModal feedback');

      enTty.send('1');
      await enTty.waitFor((s) => s.includes('[x] [1]'), { timeoutMs: 5_000, label: 'feedback tag 1 toggled' });
      enTty.send('\r');
      await enTty.waitFor(
        (s) => s.includes('Edit Question') && (s.includes('Flagged') || s.includes('no silent AI rewrite')),
        { timeoutMs: 8_000, label: 'en CardToolsModal feedback submitted safely' },
      );
      assert.equal(enAiCalls, 0, 'CardToolsModal feedback must never trigger silent AI rewrite');

      // Edit card via '1' -> save Ctrl+S -> reopen 'D' -> press '0' -> ConfirmDialog -> press 'y' -> coach.revert
      const beforeCard = await enHost.call('card.current', {});
      assert.equal(beforeCard.ok, true);
      const origPrompt = String(beforeCard.value?.card?.prompt || '').trim();

      enTty.send('1');
      await enTty.waitFor((s) => s.includes('1. Stem (prompt)'), { timeoutMs: 5_000, label: 'edit form opened' });
      enTty.send(' [R40EDIT]');
      await enTty.waitFor((s) => s.includes('[R40EDIT]'), { timeoutMs: 5_000, label: 'edit tag typed' });
      enTty.send('\x13');
      await enTty.waitFor(
        (s) => !s.includes('Card Tools') && s.includes('[R40EDIT]'),
        { timeoutMs: 8_000, label: 'card updated in ReviewView' },
      );

      enTty.send('D');
      await enTty.waitFor(
        (s) => s.includes('Card Tools') && s.includes('1 rev'),
        { timeoutMs: 8_000, label: 'CardToolsModal reopened showing 1 rev' },
      );
      enTty.send('0');
      const confirmScreen = await enTty.waitFor(
        (s) => s.includes('Revert Last Rewrite') && s.includes('Confirm') && s.includes('coach.revert'),
        { timeoutMs: 5_000, label: 'ConfirmDialog opened for coach.revert' },
      );
      enTty.assertHealthyScreen(confirmScreen, 120, 36, 'en ASCII ConfirmDialog for coach.revert');
      enTty.assertAsciiPure(confirmScreen, 'en ASCII ConfirmDialog for coach.revert');

      enTty.send('y');
      await enTty.waitFor(
        (s) => !s.includes('Card Tools') && s.includes('Reverted last rewrite'),
        { timeoutMs: 8_000, label: 'coach.revert confirmed and toast shown' },
      );

      const afterCard = await enHost.call('card.get', { cardId: beforeCard.value.card.id });
      assert.equal(afterCard.ok, true);
      assert.equal(String(afterCard.value?.card?.prompt || '').trim(), origPrompt);
      assert.equal(afterCard.value?.revisions?.length ?? 0, 0);
      assert.equal(enAiCalls, 0, 'entire --ascii E2E flow must make 0 AI calls');
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
