// Consolidated ExamCoach Calibration & Filter Domain Suite
// Merges: round40-coach-goal, round55-coach-prep, round68-examcoach-export, round74-examcoach-filter
// node --test tests/domain-examcoach-cal.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { render } from 'ink';
import React from 'react';
import {
  cloneSampleLibrary,
  createTempTracker,
  createVirtualTty,
  disposeTerminalPool,
  distDir,
  findExportedBackupFile,
  installNoNetworkGuard,
  loadDistRuntime,
  pkgRoot,
  sanitizedTestEnv,
} from './helpers/virtual-tty.mjs';

const { StudyHubTuiApp, createTuiHost, saveTuiPreferences } = await loadDistRuntime();
assert.ok(StudyHubTuiApp, 'dist/ must export StudyHubTuiApp');
assert.ok(createTuiHost, 'dist/ must export createTuiHost');
assert.ok(saveTuiPreferences, 'dist/ must export saveTuiPreferences');

const storeFile = (await readdir(distDir)).find((f) => f.startsWith('store-') && f.endsWith('.mjs'));
assert.ok(storeFile, 'dist/ must include store-*.mjs');
const { useTuiStore: useDistTuiStore, DEFAULT_PREFERENCES } = await import(
  pathToFileURL(join(distDir, storeFile)).href
);
assert.ok(useDistTuiStore, 'dist/store-*.mjs must export useTuiStore');
assert.ok(DEFAULT_PREFERENCES, 'dist/store-*.mjs must export DEFAULT_PREFERENCES');

const PREV_DSH_HOME = process.env.DSH_HOME;
const restoreNetworkGuard = installNoNetworkGuard();
const temps = createTempTracker('studyhub-tui-coach-cal-');

// Bundle ExamCoachView & HelpOverlay helpers from TypeScript source for unit tests
const coachBundleDir = await temps.make('coach-unit');
const coachBundleFile = join(coachBundleDir, 'coach.mjs');
await build({
  stdin: {
    contents: [
      `export { formatExamCoachMarkdown, filterCoachFamilies, filterCoachWrongItems, filterCoachEvidencePoints } from './src/views/examcoach/ExamCoachView.tsx';`,
      `export { featureShortcuts } from './src/shell/HelpOverlay.tsx';`,
    ].join('\n'),
    resolveDir: pkgRoot,
    loader: 'ts',
  },
  outfile: coachBundleFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  logLevel: 'silent',
  absWorkingDir: pkgRoot,
});
fs.symlinkSync(join(pkgRoot, 'node_modules'), join(coachBundleDir, 'node_modules'), 'junction');
const CoachMod = await import(pathToFileURL(coachBundleFile).href);
assert.equal(typeof CoachMod.formatExamCoachMarkdown, 'function', 'ExamCoachView must export formatExamCoachMarkdown');
assert.equal(typeof CoachMod.filterCoachFamilies, 'function', 'ExamCoachView must export filterCoachFamilies');
assert.equal(typeof CoachMod.filterCoachWrongItems, 'function', 'ExamCoachView must export filterCoachWrongItems');
assert.equal(typeof CoachMod.filterCoachEvidencePoints, 'function', 'ExamCoachView must export filterCoachEvidencePoints');
assert.equal(typeof CoachMod.featureShortcuts, 'function', 'HelpOverlay must export featureShortcuts');

function resetDistStore(language = 'zh', asciiMode = false, extra = {}) {
  useDistTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    snapshot: null,
    binding: null,
    config: null,
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
      recentCommands: [...(DEFAULT_PREFERENCES.recentCommands ?? [])],
      language,
      asciiMode,
    },
    ...extra,
  });
}

after(async () => {
  restoreNetworkGuard();
  resetDistStore('zh', false);
  disposeTerminalPool();
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await temps.cleanup();
});

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

function todayLocalYmd() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Patch realHost.call for deterministic coach calibration/variants/evidence lists while preserving all TuiHost methods & properties. */
function patchCoachFilterHost(realHost, seed) {
  let currentFamilies = seed.families.map((f) => ({ ...f, confirmations: { ...(f.confirmations || {}) } }));
  const confirmCalls = [];
  const variantCalls = [];
  const practiceCalls = [];
  const origCall = realHost.call.bind(realHost);

  realHost.call = async (action, payload) => {
    if (action === 'coach.calibration.get') {
      return {
        ok: true,
        value: {
          course: payload?.course || seed.course,
          spec: {
            specVersion: 4,
            course: payload?.course || seed.course,
            stage: 'calibrating',
            taskFamilies: currentFamilies,
          },
          evidence: seed.capabilityEvidence,
        },
      };
    }
    if (action === 'coach.calibration.confirm') {
      confirmCalls.push(payload);
      currentFamilies = currentFamilies.map((f) => {
        if (f.id !== payload?.familyId) return f;
        const nextConf = { ...(f.confirmations || {}) };
        if (typeof payload.appearanceApproved === 'boolean') nextConf.appearanceApproved = payload.appearanceApproved;
        if (typeof payload.intentApproved === 'boolean') nextConf.intentApproved = payload.intentApproved;
        if (typeof payload.answerVerified === 'boolean') nextConf.answerVerified = payload.answerVerified;
        const calibrated = Boolean(nextConf.appearanceApproved && nextConf.intentApproved && nextConf.answerVerified);
        const nextSample = payload.revealSampleSolution && f.sample ? { ...f.sample, redacted: false } : f.sample;
        return { ...f, confirmations: nextConf, calibrated, sample: nextSample };
      });
      return {
        ok: true,
        value: {
          spec: {
            specVersion: 4,
            course: payload?.course || seed.course,
            stage: 'calibrating',
            taskFamilies: currentFamilies,
          },
          evidence: seed.capabilityEvidence,
        },
      };
    }
    if (action === 'wrongbook') {
      return { ok: true, value: { items: seed.wrongItems } };
    }
    if (action === 'course.evidence.summary') {
      return { ok: true, value: seed.courseEvidence };
    }
    if (action === 'coach.variants') {
      variantCalls.push(payload);
      return { ok: true, value: { queued: payload?.cards?.length ?? 0 } };
    }
    if (action === 'review.start') {
      practiceCalls.push(payload);
      return { ok: false, error: { message: 'Stubbed point practice target captured' } };
    }
    return origCall(action, payload);
  };

  return { host: realHost, confirmCalls, variantCalls, practiceCalls };
}

describe('Round 40: Coach Learning Goal, Card Quality Feedback & Coach Revert', () => {
  test('1) createTuiHost integration: coach.profile -> coach.goal + coach.feedback (rewriteVia: assist, 0 AI calls) + coach.revert', async () => {
    const base = await temps.make('r40-host');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
    const libraryRoot = join(base, 'library');
    await cloneSampleLibrary('en', libraryRoot);

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
      const initSnap = await host.call('snapshot', {});
      assert.equal(initSnap.ok, true, initSnap.error?.message);

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

  test('2) PTY E2E: CoachPreferencesModal cycles [g] learning goal & CardToolsModal feedback/revert cleanly (0 AI calls)', async () => {
    const zhBase = await temps.make('r40-pty-zh');
    const zhDshHome = join(zhBase, 'dsh-home');
    process.env.DSH_HOME = zhDshHome;
    await saveTuiPreferences(
      { language: 'zh', asciiMode: false, theme: 'tokyo-night', mathUnicode: true, showHints: true },
      { env: sanitizedTestEnv({ DSH_HOME: zhDshHome }) },
    );

    const zhLibraryRoot = join(zhBase, 'library');
    await cloneSampleLibrary('zh', zhLibraryRoot);

    let zhAiCalls = 0;
    const zhHost = await createTuiHost({
      libraryRoot: zhLibraryRoot,
      env: sanitizedTestEnv({ DSH_HOME: zhDshHome }),
      home: join(zhBase, 'home'),
      documentsDir: zhBase,
      providerDiscovery: fakeDiscovery(),
      injectedComplete: async () => {
        zhAiCalls += 1;
        throw new Error('Unexpected AI call in Round 40 PTY E2E');
      },
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
          autoLaunchpad: false,
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

      await zhTty.waitFor(
        (s) => !s.includes('载入示例课程体验') && s.includes('示例 · Memento 与 Bridge') && !useDistTuiStore.getState().loading,
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
      assert.deepEqual(zhProf.value?.preferences, []);
      assert.deepEqual(zhProf.value?.bullets, []);

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

      // Resize back to 120x36 and verify CardToolsModal [9] Card Quality Feedback & [0] Revert Last Rewrite
      zhTty.resize(120, 36);
      zhTty.send('\x7f');
      await zhTty.waitFor(
        (s) => useDistTuiStore.getState().page === 'library' && s.includes('题组列表') && s.includes('Memento') && !useDistTuiStore.getState().loading,
        { timeoutMs: 10_000, label: 'zh LibraryView rendered' },
      );
      assert.equal(useDistTuiStore.getState().page, 'library');
      zhTty.send('\r');
      await zhTty.waitFor(
        (s) => useDistTuiStore.getState().page === 'review' && s.includes('[D]工具') && /\b1\/\d+/.test(s),
        { timeoutMs: 10_000, label: 'zh ReviewView rendered' },
      );
      assert.equal(useDistTuiStore.getState().page, 'review');

      zhTty.send('D');
      const toolsMenu = await zhTty.waitFor(
        (s) => s.includes('题目工具箱') && s.includes('题目质量反馈') && s.includes('撤销上次改写'),
        { timeoutMs: 8_000, label: 'zh CardToolsModal opened' },
      );
      zhTty.assertHealthyScreen(toolsMenu, 120, 36, 'zh CardToolsModal menu');

      // Press '0' with no revisions -> clean info message
      zhTty.send('0');
      await zhTty.waitFor(
        (s) => s.includes('当前题目暂无可撤销的改写历史'),
        { timeoutMs: 5_000, label: 'zh CardToolsModal no-revision info message' },
      );

      // Press '9' -> Card Quality Feedback, toggle tag 1 (general-quality), submit with Enter
      zhTty.send('9');
      const fbScreen = await zhTty.waitFor(
        (s) => s.includes('题目质量反馈') && s.includes('题干太空'),
        { timeoutMs: 5_000, label: 'zh CardToolsModal feedback view opened' },
      );
      zhTty.assertHealthyScreen(fbScreen, 120, 36, 'zh CardToolsModal feedback');

      zhTty.send('1');
      await zhTty.waitFor((s) => s.includes('☑ [1]'), { timeoutMs: 5_000, label: 'feedback tag 1 toggled' });
      zhTty.send('\r');
      await zhTty.waitFor(
        (s) => s.includes('编辑题目') && (s.includes('已反馈') || s.includes('不触发静默后台改题')),
        { timeoutMs: 8_000, label: 'zh CardToolsModal feedback submitted safely' },
      );
      assert.equal(zhAiCalls, 0, 'CardToolsModal feedback must never trigger silent AI rewrite');

      // Edit card via '1' -> save Ctrl+S -> reopen 'D' -> press '0' -> ConfirmDialog -> press 'y' -> coach.revert
      const beforeCard = await zhHost.call('card.current', {});
      assert.equal(beforeCard.ok, true);
      const origPrompt = String(beforeCard.value?.card?.prompt || '').trim();

      zhTty.send('1');
      await zhTty.waitFor((s) => s.includes('1. 题干 (prompt)'), { timeoutMs: 5_000, label: 'edit form opened' });
      zhTty.send(' [R40EDIT]');
      await zhTty.waitFor((s) => s.includes('[R40EDIT]'), { timeoutMs: 5_000, label: 'edit tag typed' });
      zhTty.send('\x13');
      await zhTty.waitFor(
        (s) => !s.includes('题目工具箱') && s.includes('[R40EDIT]'),
        { timeoutMs: 8_000, label: 'card updated in ReviewView' },
      );

      zhTty.send('D');
      await zhTty.waitFor(
        (s) => s.includes('题目工具箱') && s.includes('1 版'),
        { timeoutMs: 8_000, label: 'CardToolsModal reopened showing 1 版' },
      );
      zhTty.send('0');
      const confirmScreen = await zhTty.waitFor(
        (s) => s.includes('撤销上次改写') && s.includes('确认撤销') && s.includes('coach.revert'),
        { timeoutMs: 5_000, label: 'ConfirmDialog opened for coach.revert' },
      );
      zhTty.assertHealthyScreen(confirmScreen, 120, 36, 'zh ConfirmDialog for coach.revert');

      zhTty.send('y');
      await zhTty.waitFor(
        (s) => !s.includes('题目工具箱') && s.includes('已撤销上次改写'),
        { timeoutMs: 8_000, label: 'coach.revert confirmed and toast shown' },
      );

      const afterCard = await zhHost.call('card.get', { cardId: beforeCard.value.card.id });
      assert.equal(afterCard.ok, true);
      assert.equal(String(afterCard.value?.card?.prompt || '').trim(), origPrompt);
      assert.equal(afterCard.value?.revisions?.length ?? 0, 0);
      assert.equal(useDistTuiStore.getState().page, 'review');
      assert.equal(zhAiCalls, 0, 'entire Round 40 PTY E2E flow must make 0 AI calls');
    } finally {
      try {
        zhInk?.unmount();
      } catch {
        // ignore
      }
      await zhHost.dispose();
      zhTty.dispose();
    }
  });
});

describe('Round 55: ExamCoachView Manual Coach Prep Queue Flush (coach.prepare) & Live Queue Status Pill', () => {
  test('1) createTuiHost integration (0 AI calls): coach.prepare {} returns valid CoachStatusResult', async () => {
    const base = await temps.make('r55-host');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
    const libraryRoot = join(base, 'library');
    await cloneSampleLibrary('en', libraryRoot);

    let aiCalls = 0;
    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      providerDiscovery: fakeDiscovery(),
      injectedComplete: async () => {
        aiCalls += 1;
        return '';
      },
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      const initSnap = await host.call('snapshot', {});
      assert.equal(initSnap.ok, true, initSnap.error?.message);

      const prepRes = await host.call('coach.prepare', {});
      assert.equal(prepRes.ok, true, prepRes.error?.message);
      assert.equal(typeof prepRes.value, 'object');
      assert.ok(prepRes.value !== null, 'coach.prepare must return an object');
      assert.equal(typeof prepRes.value.enabled, 'boolean');
      assert.equal(typeof prepRes.value.ready, 'number');
      assert.equal(typeof prepRes.value.preparing, 'boolean');
      assert.ok(Array.isArray(prepRes.value.tasks), 'coachStatus.tasks must be an array');
      assert.equal(aiCalls, 0, 'coach.prepare {} on empty queue must make 0 model calls');
    } finally {
      await host.dispose();
    }
  });

  test('2) PTY E2E at 120x36 & 80x24 (zh): [f] P2 ConfirmDialog, n/Esc cancel (0 calls), y flush + toast + live pill + Variants panes', async () => {
    const zhBase = await temps.make('r55-pty-zh');
    const zhDshHome = join(zhBase, 'dsh-home');
    process.env.DSH_HOME = zhDshHome;
    await saveTuiPreferences(
      { language: 'zh', asciiMode: false, theme: 'tokyo-night', mathUnicode: true, showHints: true },
      { env: sanitizedTestEnv({ DSH_HOME: zhDshHome }) },
    );

    const zhLibraryRoot = join(zhBase, 'library');
    await cloneSampleLibrary('zh', zhLibraryRoot);

    let zhAiCalls = 0;
    const zhHost = await createTuiHost({
      libraryRoot: zhLibraryRoot,
      env: sanitizedTestEnv({ DSH_HOME: zhDshHome }),
      home: join(zhBase, 'home'),
      documentsDir: zhBase,
      providerDiscovery: fakeDiscovery(),
      injectedComplete: async () => {
        zhAiCalls += 1;
        return '';
      },
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
          autoLaunchpad: false,
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

      await zhTty.waitFor(
        (s) => !s.includes('载入示例课程体验') && s.includes('示例 · Memento 与 Bridge') && !useDistTuiStore.getState().loading,
        { timeoutMs: 12_000, label: 'zh sample loaded' },
      );

      zhTty.send('9');
      const zhCoach = await zhTty.waitFor(
        (s) => s.includes('考试教练') && s.includes('校准与考法') && s.includes('备题 0') && !s.includes('正在加载'),
        { timeoutMs: 10_000, label: 'zh ExamCoachView rendered with live queue status pill' },
      );
      zhTty.assertHealthyScreen(zhCoach, 120, 36, 'zh ExamCoachView initial');

      // Press [f] -> opens P2 ConfirmDialog with 0 model calls
      zhTty.send('f');
      const zhConfirm1 = await zhTty.waitFor(
        (s) => s.includes('触发教练后台备题队列') && s.includes('coach.prepare'),
        { timeoutMs: 5_000, label: 'zh ConfirmDialog opened via f' },
      );
      zhTty.assertHealthyScreen(zhConfirm1, 120, 36, 'zh flush prep ConfirmDialog');
      assert.equal(zhAiCalls, 0, 'opening flush prep ConfirmDialog must make 0 model calls');

      // Press [n] -> cancels cleanly with 0 model calls
      zhTty.send('n');
      const zhCancelledN = await zhTty.waitFor(
        (s) => !s.includes('触发教练后台备题队列') && s.includes('考试教练'),
        { timeoutMs: 5_000, label: 'zh ConfirmDialog cancelled via n' },
      );
      zhTty.assertHealthyScreen(zhCancelledN, 120, 36, 'zh after n cancel');
      assert.equal(zhAiCalls, 0, 'cancelling flush prep via n must make 0 model calls');

      // Press [f] -> [Esc] -> cancels cleanly with 0 model calls
      zhTty.send('f');
      await zhTty.waitFor((s) => s.includes('触发教练后台备题队列'), { timeoutMs: 5_000, label: 'zh ConfirmDialog reopened for Esc' });
      zhTty.send('\x1b');
      await zhTty.waitFor(
        (s) => !s.includes('触发教练后台备题队列') && s.includes('考试教练'),
        { timeoutMs: 5_000, label: 'zh ConfirmDialog cancelled via Esc' },
      );
      assert.equal(zhAiCalls, 0, 'cancelling flush prep via Esc must make 0 model calls');

      // Press [f] -> [y] -> triggers coach.prepare & shows success toast
      zhTty.send('f');
      await zhTty.waitFor((s) => s.includes('触发教练后台备题队列'), { timeoutMs: 5_000, label: 'zh ConfirmDialog reopened for y' });
      zhTty.send('y');
      const zhFlushed = await zhTty.waitFor(
        (s) => !s.includes('触发教练后台备题队列') && s.includes('已触发教练备题队列（就绪 0 题）'),
        { timeoutMs: 8_000, label: 'zh coach.prepare success toast' },
      );
      assert.ok(
        useDistTuiStore.getState().toasts.some((t) => t.text === '已触发教练备题队列（就绪 0 题）' && t.tone === 'success'),
        'expected exact full success toast in store',
      );
      zhTty.assertHealthyScreen(zhFlushed, 120, 36, 'zh after coach.prepare flush');
      assert.equal(zhAiCalls, 0, 'flushing empty prep queue must make 0 model calls');

      // Switch to Variants tab (2) -> verify footer hint + live pill at 120x36
      zhTty.send('2');
      const zhVariants = await zhTty.waitFor(
        (s) => s.includes('教练备题池') && s.includes('立即备题') && s.includes('待备队列: 0'),
        { timeoutMs: 5_000, label: 'zh Variants tab with live queue status & f hint' },
      );
      zhTty.assertHealthyScreen(zhVariants, 120, 36, 'zh Variants tab 120x36');

      // Resize to 80x24 -> verify single-pane list, Tab to Detail pane, and [f]->[n] narrow ConfirmDialog
      zhTty.resize(80, 24);
      const zhVariantsNarrowList = await zhTty.waitFor(
        (s) => s.includes('错题/薄弱题变式状态') && s.includes('立即备题') && s.includes('教练队列') && s.split('\n').length <= 24,
        { timeoutMs: 5_000, label: 'zh Variants tab list with live pill & f hint at 80x24' },
      );
      zhTty.assertHealthyScreen(zhVariantsNarrowList, 80, 24, 'zh Variants tab list 80x24');

      zhTty.send('\t');
      const zhVariantsNarrowDetail = await zhTty.waitFor(
        (s) => s.includes('教练备题池') && s.includes('立即备题') && s.includes('待备队列: 0') && s.split('\n').length <= 24,
        { timeoutMs: 5_000, label: 'zh Variants detail pane with live pill & Queued count at 80x24' },
      );
      zhTty.assertHealthyScreen(zhVariantsNarrowDetail, 80, 24, 'zh Variants tab detail 80x24');

      zhTty.send('f');
      const zhNarrowConfirm = await zhTty.waitFor(
        (s) => s.includes('触发教练后台备题队列') && s.includes('coach.prepare') && s.split('\n').length <= 24,
        { timeoutMs: 5_000, label: 'zh ConfirmDialog opened via f at 80x24' },
      );
      zhTty.assertHealthyScreen(zhNarrowConfirm, 80, 24, 'zh flush prep ConfirmDialog 80x24');
      zhTty.send('n');
      await zhTty.waitFor(
        (s) => !s.includes('触发教练后台备题队列') && s.includes('教练备题池'),
        { timeoutMs: 5_000, label: 'zh ConfirmDialog cancelled via n at 80x24' },
      );
      assert.equal(zhAiCalls, 0, 'entire Round 55 PTY E2E flow must make 0 model calls');
      assert.equal(useDistTuiStore.getState().page, 'examcoach');
    } finally {
      try {
        zhInk?.unmount();
      } catch {
        // ignore
      }
      await zhHost.dispose();
      zhTty.dispose();
    }
  });
});

describe('Round 68 Track 3: ExamCoachView [X] Atomic Markdown Export & HelpOverlay Sync', () => {
  test('1) Unit: formatExamCoachMarkdown renders zh & en briefings (families table, evidence summary, prefs & bullets) + HelpOverlay/KEYBINDINGS sync', async () => {
    const sampleSpec = {
      specVersion: 3,
      course: '操作系统',
      stage: 'calibrated',
      crunchMode: { enabled: true, remainingMinutes: 90 },
      taskFamilies: [
        {
          id: 'fam-paging',
          title: '页表与 TLB 计算 | Multi-level Paging',
          primaryFormat: 'open',
          quota: 4,
          priority: 'high',
          marksPerItem: 10,
          timeBudgetSec: 180,
          calibrated: true,
          knowledgePoints: ['TLB 命中率', '多级页表'],
          confirmations: { appearanceApproved: true, intentApproved: true, answerVerified: true },
        },
        {
          id: 'fam-sched',
          title: '调度算法对比',
          primaryFormat: 'quiz',
          quota: 3,
          priority: 'medium',
          marksPerItem: 5,
          timeBudgetSec: 90,
          calibrated: false,
          formatTradeoff: 'Prioritize turnaround calculation',
          confirmations: { appearanceApproved: true, intentApproved: false, answerVerified: false },
        },
        {
          id: 'fam-legacy',
          title: '历史概念默写',
          primaryFormat: 'quiz',
          quota: 0,
          priority: 'deferred',
          calibrated: false,
          defects: [{ message: 'Excluded for final sprint' }],
        },
      ],
    };

    const sampleEvidence = {
      materialCoverage: {
        totalSources: 4,
        totalSections: 12,
        coveredSections: 9,
        ratio: 0.75,
        totalPublishedCards: 42,
        recallOnlyCardCount: 8,
        surfaceApplicationCardCount: 14,
      },
      trainingCoverage: {
        specVersion: 3,
        planned: 16,
        generated: 12,
        verifiedUsable: 10,
        practiced: 7,
      },
      capabilityEvidence: {
        reviewFamiliarity: { reviewedCards: 30, highStabilityCards: 18 },
        sameItemRepeatCount: 2,
        assistedOrExposedCount: 1,
        selfReportedCount: 0,
        unseenIndependentPassCount: 6,
        delayedIndependent: { passedFamilyCount: 2, totalActiveFamilyCount: 3, status: 'progressing' },
        timedIndependent: { passedCount: 5, overBudgetCount: 1, status: 'good' },
        misconceptionHypotheses: [
          { misconceptionId: 'm1', reason: 'Confusing physical frame with virtual page', occurrences: 3, confirmedMisconception: true },
        ],
        readyForExam: false,
        verdict: 'Need 1 more delayed family pass',
      },
    };

    const sampleStatus = {
      enabled: true,
      consent: true,
      ready: 2,
      preparing: true,
      preparingCards: ['c-1', 'c-2', 'c-3'],
    };

    const sampleProfile = {
      goal: 'exam',
      summary: 'Strong on concepts, watch off-by-one frame indices',
      preferences: ['Use concrete byte-offset examples', 'Flag edge cases first'],
      bullets: [
        { id: 'b1', text: 'Always separate VPN bits from offset bits before lookup', source: 'user', course: '操作系统' },
        { id: 'b2', text: 'Check TLB miss penalty twice in effective access time', source: 'debrief' },
      ],
    };

    const zhMd = CoachMod.formatExamCoachMarkdown({
      course: '操作系统',
      spec: sampleSpec,
      evidence: sampleEvidence,
      status: sampleStatus,
      profile: sampleProfile,
      lang: 'zh',
      generatedAt: '2026-11-22 21:30',
    });

    assert.ok(zhMd.includes('# 考试教练校准与学习画像'), 'zh title missing');
    assert.ok(zhMd.includes('2026-11-22 21:30'), 'zh date missing');
    assert.ok(zhMd.includes('操作系统'), 'zh course missing');
    assert.ok(zhMd.includes('就绪 2') && zhMd.includes('待备 3') && zhMd.includes('active'), 'zh prep queue status missing');
    assert.ok(zhMd.includes('应付考试'), 'zh learner goal missing');
    assert.ok(zhMd.includes('页表与 TLB 计算 \\| Multi-level Paging'), 'escaped pipe in family title missing');
    assert.ok(zhMd.includes('已确认') && zhMd.includes('待确认') && zhMd.includes('已排除'), 'zh family statuses missing');
    assert.ok(zhMd.includes('9/12 (75%)'), 'zh material coverage missing');
    assert.ok(zhMd.includes('Need 1 more delayed family pass'), 'zh evidence verdict missing');
    assert.ok(zhMd.includes('Confusing physical frame with virtual page'), 'zh misconception hypothesis missing');
    assert.ok(zhMd.includes('Use concrete byte-offset examples'), 'zh preference missing');
    assert.ok(zhMd.includes('Always separate VPN bits from offset bits before lookup'), 'zh memory bullet missing');
    assert.ok(zhMd.includes('Prioritize turnaround calculation'), 'zh formatTradeoff missing');
    assert.ok(zhMd.includes('Excluded for final sprint'), 'zh defect message missing');
    assert.ok(zhMd.includes('Strong on concepts, watch off-by-one frame indices'), 'zh profile summary missing');
    assert.ok(zhMd.includes('10/12') || zhMd.includes('10'), 'zh training coverage verifiedUsable missing');
    assert.ok(zhMd.includes('TLB 命中率'), 'zh knowledgePoint missing');
    assert.ok(zhMd.includes('Check TLB miss penalty twice in effective access time'), 'zh second bullet missing');

    const enMd = CoachMod.formatExamCoachMarkdown({
      course: null,
      spec: sampleSpec,
      evidence: sampleEvidence,
      status: { enabled: true, ready: 1, preparing: false, preparingCards: [] },
      profile: sampleProfile,
      lang: 'en',
      generatedAt: new Date(2026, 10, 22, 8, 5),
    });

    assert.ok(enMd.includes('# Exam Coach Calibration & Learner Profile'), 'en title missing');
    assert.ok(enMd.includes('2026-11-22 08:05'), 'en formatted Date missing');
    assert.ok(enMd.includes('ready: 1, queued: 0, active: no (idle)'), 'en prep queue status missing');
    assert.ok(enMd.includes('Pass Exam'), 'en learner goal missing');
    assert.ok(enMd.includes('| Family (Key) |'), 'en table header missing');
    assert.ok(enMd.includes('Confirmed') && enMd.includes('Pending') && enMd.includes('Excluded'), 'en family statuses missing');
    assert.ok(enMd.includes('## Capability Evidence & Mastery Summary'), 'en evidence section missing');
    assert.ok(enMd.includes('Flag edge cases first'), 'en preference missing');
    assert.ok(enMd.includes('Check TLB miss penalty twice in effective access time'), 'en bullet missing');
    assert.ok(enMd.includes('9/12 (75%)'), 'en material coverage missing');
    assert.ok(enMd.includes('Need 1 more delayed family pass'), 'en evidence verdict missing');
    assert.ok(enMd.includes('Strong on concepts, watch off-by-one frame indices'), 'en profile summary missing');
    assert.ok(enMd.includes('Use concrete byte-offset examples'), 'en first preference missing');
    assert.ok(enMd.includes('Always separate VPN bits from offset bits before lookup'), 'en first bullet missing');

    // HelpOverlay & docs/KEYBINDINGS.md sync check
    for (const lang of ['zh', 'en']) {
      const sections = CoachMod.featureShortcuts(lang);
      assert.equal(sections.length, 15);
      const coachSec = sections.find((s) => s.title.includes('Exam Coach'));
      const prepSec = sections.find((s) => s.title.includes('Exam Prep'));
      assert.ok(coachSec?.items.some((i) => i.key === 'X'), `missing [X] in Exam Coach HelpOverlay (${lang})`);
      assert.ok(prepSec?.items.some((i) => i.key === '/ / x'), `missing [/ / x] in Exam Prep HelpOverlay (${lang})`);
    }
    const keybindingsMd = await readFile(join(pkgRoot, 'docs', 'KEYBINDINGS.md'), 'utf8');
    assert.ok(keybindingsMd.includes('studyhub-coach[-<slug>]-YYYY-MM-DD-HHmmss.md'), 'KEYBINDINGS.md must document studyhub-coach export');
    assert.ok(keybindingsMd.includes('export exam prep plan Markdown'), 'KEYBINDINGS.md must document exam prep export');
  });

  test('2) @xterm/headless PTY E2E (120x36 zh): load sample -> seed pref & bullet -> ExamCoach (9) -> [X] exports studyhub-coach-*.md (0 model calls)', async () => {
    const base = await temps.make('r68-pty-zh');
    const dshHome = join(base, 'dsh-home');
    const libraryRoot = join(base, 'library');
    await cloneSampleLibrary('zh', libraryRoot);
    process.env.DSH_HOME = dshHome;

    await saveTuiPreferences(
      { language: 'zh', asciiMode: false, theme: 'dsh-dark', mathUnicode: true, showHints: true },
      { env: sanitizedTestEnv({ DSH_HOME: dshHome }) },
    );

    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot,
      env: sanitizedTestEnv({ DSH_HOME: dshHome }),
      home: join(base, 'home'),
      documentsDir: base,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      injectedComplete: async () => {
        modelCalls += 1;
        return 'Stub';
      },
      language: 'zh',
      eventDebounceMs: 30,
    });

    const tty = createVirtualTty(120, 36);
    let inkInst = null;
    try {
      resetDistStore('zh', false);
      inkInst = render(
        React.createElement(StudyHubTuiApp, {
          host,
          initialPage: 'library',
          initialLanguage: 'zh',
          initialAsciiMode: false,
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
      await tty.waitFor(
        (s) => !s.includes('载入示例课程体验') && s.includes('示例 · Memento 与 Bridge') && !useDistTuiStore.getState().loading,
        { timeoutMs: 12_000, label: 'zh sample loaded' },
      );

      // Seed a learner preference and memory bullet via host actions (0 model calls)
      const seededPref = 'Prefer step-by-step invariant checks before final summary';
      const seededBullet = 'Distinguish Originator state creation from Caretaker storage';
      const prefRes = await host.call('coach.preferences', { add: seededPref });
      assert.equal(prefRes.ok, true, prefRes.error?.message);

      const prof0 = await host.call('coach.profile', {});
      assert.equal(prof0.ok, true, prof0.error?.message);
      const rev0 = prof0.value?.memoryRevision ?? 0;
      const bulletRes = await host.call('coach.profile', {
        addBullet: { text: seededBullet },
        expectedRevision: rev0,
      });
      assert.equal(bulletRes.ok, true, bulletRes.error?.message);
      assert.equal(modelCalls, 0, 'Seeding preference & bullet must invoke 0 model calls');

      // Navigate to ExamCoach ('9')
      tty.send('9');
      const coachScreen = await tty.waitFor(
        (s) =>
          s.includes('考试教练') &&
          s.includes('校准与考法') &&
          !s.includes('正在加载考试教练') &&
          useDistTuiStore.getState().footerHints.some((h) => h.key === 'X' && h.label === '导出画像'),
        { timeoutMs: 10_000, label: 'zh ExamCoachView rendered with X hint' },
      );
      tty.assertHealthyScreen(coachScreen, 120, 36, 'zh ExamCoachView 120x36');

      // Press 'X' -> atomic export to studyhub-coach-YYYY-MM-DD-HHmmss.md
      const backupsDir = join(libraryRoot, 'backups');
      const todayYmd = todayLocalYmd();
      tty.send('X');
      const afterExport = await tty.waitFor(
        (s) =>
          useDistTuiStore
            .getState()
            .toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已导出教练画像') && toast.text.includes('studyhub-coach-')) &&
          s.includes('已导出教练画像'),
        { timeoutMs: 10_000, label: 'zh ExamCoach [X] export toast & file on disk' },
      );
      tty.assertHealthyScreen(afterExport, 120, 36, 'zh ExamCoachView after [X] export');

      const coachExport = await findExportedBackupFile(backupsDir, 'studyhub-coach', 'md', todayYmd);
      assert.ok(coachExport, `expected studyhub-coach-${todayYmd}-HHmmss.md in ${backupsDir}`);
      const exportedMd = await readFile(coachExport.path, 'utf8');
      assert.ok(exportedMd.includes('# 考试教练校准与学习画像'), 'exported MD must have zh title');
      assert.ok(exportedMd.includes('备题队列状态'), 'exported MD must include prep queue status');
      assert.ok(exportedMd.includes(seededPref), 'exported MD must include seeded preference');
      assert.ok(exportedMd.includes(seededBullet), 'exported MD must include seeded memory bullet');
      assert.ok(exportedMd.includes('## 学习偏好与记忆要点'), 'exported MD must include preferences & bullets section');
      assert.ok(exportedMd.includes('就绪 0'), 'exported MD must include ready 0');
      assert.equal(useDistTuiStore.getState().page, 'examcoach');
      assert.equal(modelCalls, 0, 'ExamCoach [X] export must invoke 0 model calls');

      // Round 78: ExamCoachView [N] note modal Esc dirty guard (clean Esc immediate; dirty Esc confirms)
      tty.send('N');
      await tty.waitFor((s) => s.includes('提交往年样卷 / 考法笔记') && !s.includes('未保存'), {
        timeoutMs: 5_000,
        label: 'ExamCoachView note modal opened clean',
      });
      tty.send('\x1b');
      await tty.waitFor((s) => !s.includes('提交往年样卷 / 考法笔记') && !s.includes('放弃未保存'), {
        timeoutMs: 5_000,
        label: 'Clean ExamCoachView note modal Esc closed immediately',
      });
      tty.send('N');
      await tty.waitFor((s) => s.includes('提交往年样卷 / 考法笔记'), {
        timeoutMs: 5_000,
        label: 'ExamCoachView note modal reopened',
      });
      tty.send('R78_COACH_NOTE');
      await tty.waitFor((s) => s.includes('R78_COACH_NOTE') && s.includes('未保存'), {
        timeoutMs: 5_000,
        label: 'ExamCoachView note modal shows unsaved badge',
      });
      tty.send('\x1b');
      const coachDiscardDialog = await tty.waitFor((s) => s.includes('放弃未保存的考法笔记'), {
        timeoutMs: 5_000,
        label: 'ExamCoachView dirty Esc opened ConfirmDialog',
      });
      tty.assertHealthyScreen(coachDiscardDialog, 120, 36, 'ExamCoachView discard ConfirmDialog');
      tty.send('n');
      await tty.waitFor(
        (s) => !s.includes('放弃未保存的考法笔记') && s.includes('提交往年样卷 / 考法笔记') && s.includes('R78_COACH_NOTE'),
        { timeoutMs: 5_000, label: 'ExamCoachView discard cancel preserved typed note' },
      );
      tty.send('\x1b');
      await tty.waitFor((s) => s.includes('放弃未保存的考法笔记'), {
        timeoutMs: 5_000,
        label: 'ExamCoachView discard ConfirmDialog reopened',
      });
      tty.send('y');
      await tty.waitFor((s) => !s.includes('提交往年样卷 / 考法笔记') && !s.includes('放弃未保存的考法笔记'), {
        timeoutMs: 5_000,
        label: 'ExamCoachView confirm discard closed note modal cleanly',
      });

      // Also verify 80x24 narrow layout of ExamCoachView
      tty.resize(80, 24);
      const narrowCoach = await tty.waitFor(
        (s) => s.includes('考试教练') && s.split('\n').length <= 24,
        { timeoutMs: 5_000, label: 'zh ExamCoachView at 80x24' },
      );
      tty.assertHealthyScreen(narrowCoach, 80, 24, 'zh ExamCoachView 80x24');
    } finally {
      try {
        inkInst?.unmount();
      } catch {
        // ignore
      }
      await host.dispose();
      tty.dispose();
    }
  });
});

describe('Round 74 Track 3: ExamCoachView `/` Live Filter + HelpOverlay & KEYBINDINGS.md Sync', () => {
  test('1) Unit: filterCoachFamilies, filterCoachWrongItems, filterCoachEvidencePoints (EN, CJK, empty, no-match) + HelpOverlay/KEYBINDINGS sync', async () => {
    // 1a. filterCoachFamilies
    const families = [
      {
        id: 'fam-paging-01',
        title: '页表与 TLB 地址转换',
        primaryFormat: 'open',
        quota: 4,
        priority: 'high',
        knowledgePoints: ['TLB 命中率', 'Multi-level Paging'],
      },
      {
        id: 'fam-deadlock-02',
        title: 'Banker Algorithm & Deadlock Avoidance',
        primaryFormat: 'case',
        quota: 2,
        priority: 'medium',
        knowledgePoints: ['安全序列', 'Resource Allocation Graph'],
      },
      {
        id: 'fam-mutex-03',
        title: '信号量与 PV 同步',
        primaryFormat: 'quiz',
        quota: 5,
        priority: 'medium',
        knowledgePoints: ['Producer-Consumer'],
      },
    ];

    assert.strictEqual(CoachMod.filterCoachFamilies(families, ''), families, 'empty query must return original families ref');
    assert.strictEqual(CoachMod.filterCoachFamilies(families, '   \t '), families, 'whitespace query must return original families ref');
    assert.deepEqual(
      CoachMod.filterCoachFamilies(families, '页表').map((f) => f.id),
      ['fam-paging-01'],
      'CJK title match failed',
    );
    assert.deepEqual(
      CoachMod.filterCoachFamilies(families, 'DEADLOCK-02').map((f) => f.id),
      ['fam-deadlock-02'],
      'case-insensitive id match failed',
    );
    assert.deepEqual(
      CoachMod.filterCoachFamilies(families, 'CASE').map((f) => f.id),
      ['fam-deadlock-02'],
      'case-insensitive primaryFormat match failed',
    );
    assert.deepEqual(
      CoachMod.filterCoachFamilies(families, 'producer-consumer').map((f) => f.id),
      ['fam-mutex-03'],
      'knowledgePoints EN substring match failed',
    );
    assert.deepEqual(
      CoachMod.filterCoachFamilies(families, '命中率').map((f) => f.id),
      ['fam-paging-01'],
      'knowledgePoints CJK substring match failed',
    );
    assert.deepEqual(
      CoachMod.filterCoachFamilies(families, '  banker  ').map((f) => f.id),
      ['fam-deadlock-02'],
      'trimmed EN title match failed',
    );
    assert.deepEqual(
      CoachMod.filterCoachFamilies(families, 'quiz').map((f) => f.id),
      ['fam-mutex-03'],
      'quiz primaryFormat match failed',
    );
    assert.deepEqual(
      CoachMod.filterCoachFamilies(families, 'allocation').map((f) => f.id),
      ['fam-deadlock-02'],
      'knowledgePoints substring match failed',
    );
    assert.deepEqual(CoachMod.filterCoachFamilies(families, 'nonexistent-xyz'), [], 'no-match must return empty array');
    assert.deepEqual(CoachMod.filterCoachFamilies([], 'quiz'), [], 'empty families array must return []');

    // 1b. filterCoachWrongItems
    const wrongItems = [
      {
        deckId: 'd1',
        cardId: 'card-tlb-99',
        prompt: 'Compute effective access time when TLB hit ratio is 90%',
        topic: '虚拟内存',
        course: '操作系统',
      },
      {
        deckId: 'd2',
        cardId: 'card-memento-12',
        prompt: '如何在不破坏封装的前提下保存快照？',
        topic: 'Memento Pattern',
        course: 'Design Patterns',
      },
    ];

    assert.strictEqual(CoachMod.filterCoachWrongItems(wrongItems, ''), wrongItems, 'empty query must return original wrongItems ref');
    assert.strictEqual(CoachMod.filterCoachWrongItems(wrongItems, '   '), wrongItems, 'whitespace query must return original wrongItems ref');
    assert.deepEqual(
      CoachMod.filterCoachWrongItems(wrongItems, '封装').map((w) => w.cardId),
      ['card-memento-12'],
      'CJK prompt match failed',
    );
    assert.deepEqual(
      CoachMod.filterCoachWrongItems(wrongItems, 'effective access').map((w) => w.cardId),
      ['card-tlb-99'],
      'EN prompt match failed',
    );
    assert.deepEqual(
      CoachMod.filterCoachWrongItems(wrongItems, 'memento pattern').map((w) => w.cardId),
      ['card-memento-12'],
      'topic match failed',
    );
    assert.deepEqual(
      CoachMod.filterCoachWrongItems(wrongItems, 'CARD-TLB-99').map((w) => w.cardId),
      ['card-tlb-99'],
      'cardId match failed',
    );
    assert.deepEqual(
      CoachMod.filterCoachWrongItems(wrongItems, 'design patterns').map((w) => w.cardId),
      ['card-memento-12'],
      'course EN match failed',
    );
    assert.deepEqual(
      CoachMod.filterCoachWrongItems(wrongItems, '操作系统').map((w) => w.cardId),
      ['card-tlb-99'],
      'course CJK match failed',
    );
    assert.deepEqual(CoachMod.filterCoachWrongItems(wrongItems, 'zzzz-missing'), [], 'wrongItems no-match must return []');

    // 1c. filterCoachEvidencePoints
    const evidencePoints = [
      {
        hid: 'P1',
        title: 'Bridge 桥接模式与抽象解耦',
        overall: 'shaky',
        gapHint: 'Need timed implementation comparison',
      },
      {
        hid: 'P2',
        title: 'Memento 备忘录状态回滚',
        overall: 'solid',
        gapHint: '注意 Caretaker 与 Originator 职责边界',
      },
      {
        hid: 'P3',
        title: 'Page Replacement Algorithms',
        overall: 'in_progress',
        gapHint: "Belady's anomaly in FIFO",
      },
    ];

    assert.strictEqual(CoachMod.filterCoachEvidencePoints(evidencePoints, ''), evidencePoints, 'empty query must return original evidencePoints ref');
    assert.strictEqual(CoachMod.filterCoachEvidencePoints(evidencePoints, '  '), evidencePoints, 'whitespace query must return original evidencePoints ref');
    assert.deepEqual(
      CoachMod.filterCoachEvidencePoints(evidencePoints, '桥接').map((p) => p.hid),
      ['P1'],
      'evidence CJK title match failed',
    );
    assert.deepEqual(
      CoachMod.filterCoachEvidencePoints(evidencePoints, 'replacement').map((p) => p.hid),
      ['P3'],
      'evidence EN title match failed',
    );
    assert.deepEqual(
      CoachMod.filterCoachEvidencePoints(evidencePoints, 'SHAKY').map((p) => p.hid),
      ['P1'],
      'evidence overall match failed',
    );
    assert.deepEqual(
      CoachMod.filterCoachEvidencePoints(evidencePoints, 'caretaker').map((p) => p.hid),
      ['P2'],
      'evidence CJK/EN gapHint match failed',
    );
    assert.deepEqual(
      CoachMod.filterCoachEvidencePoints(evidencePoints, 'belady').map((p) => p.hid),
      ['P3'],
      'evidence EN gapHint match failed',
    );
    assert.deepEqual(CoachMod.filterCoachEvidencePoints(evidencePoints, 'no-such-point'), [], 'evidence no-match must return []');

    // 1d. HelpOverlay & docs/KEYBINDINGS.md sync
    for (const lang of ['zh', 'en']) {
      const sections = CoachMod.featureShortcuts(lang);
      assert.equal(sections.length, 15, `featureShortcuts(${lang}) must preserve exactly 15 sections`);
      for (const sec of sections) {
        const keys = sec.items.map((i) => i.key);
        const labels = sec.items.map((i) => i.label);
        assert.equal(new Set(keys).size, keys.length, `duplicate key in ${sec.title} (${lang})`);
        assert.equal(new Set(labels).size, labels.length, `duplicate label in ${sec.title} (${lang})`);
      }
      const dashSec = sections.find((s) => s.title.includes('Dashboard'));
      const coachSec = sections.find((s) => s.title.includes('Exam Coach'));
      assert.ok(
        dashSec?.items.some((i) => i.key === '/' && (i.label === '筛选薄弱点与课程' || i.label === 'Filter weak topics & courses')),
        `Dashboard HelpOverlay missing / filter entry (${lang})`,
      );
      assert.ok(
        coachSec?.items.some((i) => i.key === '/' && (i.label === '筛选任务族/错题/考点' || i.label === 'Filter families/variants/points')),
        `Exam Coach HelpOverlay missing / filter entry (${lang})`,
      );
    }

    const keybindingsMd = await readFile(join(pkgRoot, 'docs', 'KEYBINDINGS.md'), 'utf8');
    assert.ok(keybindingsMd.includes('--search <query>'), 'KEYBINDINGS.md must document --search <query>');
    assert.ok(keybindingsMd.includes('--search <query> --json'), 'KEYBINDINGS.md must document --search <query> --json');
    assert.ok(keybindingsMd.includes('--limit <n>'), 'KEYBINDINGS.md must document --limit <n>');
    assert.ok(keybindingsMd.includes('live filter weak topics & courses'), 'KEYBINDINGS.md must document Dashboard / filter');
    assert.ok(keybindingsMd.includes('live filter Calibration families, Variants weak items, or Evidence points'), 'KEYBINDINGS.md must document ExamCoach / filter');
    assert.ok(keybindingsMd.includes('studyhub-coach[-<slug>]-YYYY-MM-DD-HHmmss.md'), 'KEYBINDINGS.md must document ExamCoach X export');
    assert.ok(keybindingsMd.includes('flush coach prep queue (`coach.prepare`)'), 'KEYBINDINGS.md must document coach.prepare');
    assert.ok(keybindingsMd.includes('CoachPreferencesModal'), 'KEYBINDINGS.md must document CoachPreferencesModal');

    // Empty briefing edge case in formatExamCoachMarkdown
    const emptyCoachZh = CoachMod.formatExamCoachMarkdown({
      course: null,
      spec: null,
      evidence: null,
      status: { enabled: false, ready: 0, preparing: false, preparingCards: [] },
      profile: { goal: '', summary: '', preferences: [], bullets: [] },
      lang: 'zh',
      generatedAt: '2026-11-22 22:00',
    });
    assert.ok(emptyCoachZh.includes('# 考试教练校准与学习画像'));
    assert.ok(emptyCoachZh.includes('2026-11-22 22:00'));
    assert.ok(emptyCoachZh.includes('就绪 0'));
    assert.ok(emptyCoachZh.includes('待备 0'));

    const emptyCoachEn = CoachMod.formatExamCoachMarkdown({
      course: '',
      spec: null,
      evidence: null,
      status: { enabled: false, ready: 0, preparing: false, preparingCards: [] },
      profile: { goal: '', summary: '', preferences: [], bullets: [] },
      lang: 'en',
      generatedAt: '2026-11-22 22:00',
    });
    assert.ok(emptyCoachEn.includes('# Exam Coach Calibration & Learner Profile'));
    assert.ok(emptyCoachEn.includes('2026-11-22 22:00'));
    assert.ok(emptyCoachEn.includes('Prep Queue Status'));
    assert.ok(emptyCoachEn.includes('ready: 0, queued: 0'));
    assert.ok(emptyCoachEn.includes('## Learner Preferences & Memory Bullets'));
    assert.ok(emptyCoachEn.includes('All Courses') || emptyCoachEn.includes('All'));

    assert.deepEqual(CoachMod.filterCoachWrongItems([], 'tlb'), []);
    assert.deepEqual(CoachMod.filterCoachEvidencePoints([], 'p1'), []);
    assert.deepEqual(CoachMod.filterCoachWrongItems(wrongItems, '虚拟内存').map((w) => w.cardId), ['card-tlb-99']);
    assert.deepEqual(CoachMod.filterCoachEvidencePoints(evidencePoints, 'solid').map((p) => p.hid), ['P2']);
    assert.deepEqual(CoachMod.filterCoachEvidencePoints(evidencePoints, 'in_progress').map((p) => p.hid), ['P3']);
    assert.deepEqual(CoachMod.filterCoachWrongItems(wrongItems, '快照').map((w) => w.cardId), ['card-memento-12']);
    assert.deepEqual(CoachMod.filterCoachWrongItems(wrongItems, 'hit ratio').map((w) => w.cardId), ['card-tlb-99']);
    assert.deepEqual(CoachMod.filterCoachEvidencePoints(evidencePoints, '备忘录').map((p) => p.hid), ['P2']);
    assert.deepEqual(CoachMod.filterCoachEvidencePoints(evidencePoints, 'timed').map((p) => p.hid), ['P1']);
    assert.equal(CoachMod.filterCoachFamilies(families, 'TLB').length, 1);
    assert.equal(CoachMod.filterCoachFamilies(families, 'high').length, 0);
    assert.equal(CoachMod.filterCoachFamilies(families, 'open').length, 1);
    assert.equal(CoachMod.filterCoachFamilies(families, 'medium').length, 0);
    assert.equal(CoachMod.filterCoachWrongItems(wrongItems, 'design').length, 1);
    assert.equal(CoachMod.filterCoachEvidencePoints(evidencePoints, 'fifo').length, 1);
    assert.equal(CoachMod.filterCoachEvidencePoints(evidencePoints, 'shaky').length, 1);
    assert.equal(CoachMod.filterCoachFamilies(families, 'paging').length, 1);
    assert.equal(CoachMod.filterCoachFamilies(families, '安全序列').length, 1);
    assert.equal(CoachMod.filterCoachFamilies(families, 'pv').length, 1);
    assert.equal(CoachMod.filterCoachWrongItems(wrongItems, '90%').length, 1);
  });

  test('2) @xterm/headless PTY E2E (120x36 & 80x24 zh): ExamCoach `/` live filter across Calibration / Variants / Evidence, Enter commit, Esc clear, shortcut guard & filtered actions', async () => {
    const base = await temps.make('r74-pty-zh');
    const dshHome = join(base, 'dsh-home');
    const libraryRoot = join(base, 'library');
    await cloneSampleLibrary('zh', libraryRoot);
    process.env.DSH_HOME = dshHome;

    await saveTuiPreferences(
      { language: 'zh', asciiMode: false, theme: 'dsh-dark', mathUnicode: true, showHints: true },
      { env: sanitizedTestEnv({ DSH_HOME: dshHome }) },
    );

    let modelCalls = 0;
    const realHost = await createTuiHost({
      libraryRoot,
      env: sanitizedTestEnv({ DSH_HOME: dshHome }),
      home: join(base, 'home'),
      documentsDir: base,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      injectedComplete: async () => {
        modelCalls += 1;
        return 'Stub';
      },
      language: 'zh',
      eventDebounceMs: 30,
    });

    const { host, confirmCalls, variantCalls, practiceCalls } = patchCoachFilterHost(realHost, {
      course: '示例 · Memento 与 Bridge',
      families: [
        {
          id: 'fam-alpha-paging',
          title: '页表地址转换Alpha',
          primaryFormat: 'open',
          quota: 4,
          priority: 'high',
          timeBudgetSec: 180,
          calibrated: false,
          knowledgePoints: ['TLB'],
          confirmations: { appearanceApproved: false, intentApproved: false, answerVerified: false },
        },
        {
          id: 'fam-beta-bridge',
          title: '桥接模式解耦Beta',
          primaryFormat: 'case',
          quota: 2,
          priority: 'medium',
          timeBudgetSec: 240,
          calibrated: false,
          knowledgePoints: ['Abstraction', '1234q'],
          confirmations: { appearanceApproved: false, intentApproved: false, answerVerified: false },
          sample: { stem: 'Design a Bridge abstraction', redacted: true, answer: 'Separate Implementor' },
        },
      ],
      wrongItems: [
        {
          deckId: 'deck-1',
          cardId: 'card-wrong-alpha',
          topic: 'Memory',
          prompt: 'Alpha wrong card about TLB miss penalty',
          wrongCount: 2,
          lastGrade: 1,
        },
        {
          deckId: 'deck-2',
          cardId: 'card-wrong-zeta',
          topic: 'Design',
          prompt: 'Zeta wrong card about Caretaker snapshot',
          wrongCount: 3,
          lastGrade: 0,
        },
      ],
      courseEvidence: {
        status: 'ok',
        course: '示例 · Memento 与 Bridge',
        points: [
          {
            hid: 'PT-1',
            title: 'AlphaPoint 概念梳理',
            overall: 'solid',
            gapHint: 'Keep practicing',
            cardRefs: [{ deckId: 'deck-1', cardId: 'card-pt-alpha' }],
          },
          {
            hid: 'PT-2',
            title: 'OmegaPoint 迁移推导',
            overall: 'shaky',
            gapHint: 'Need timed transfer',
            cardRefs: [{ deckId: 'deck-2', cardId: 'card-pt-omega' }],
          },
        ],
        summary: { total: 2, unstarted: 0, shaky: 1, in_progress: 0, solid: 1 },
      },
      capabilityEvidence: {
        materialCoverage: { totalSources: 2, totalSections: 4, coveredSections: 3, ratio: 0.75, totalPublishedCards: 10, recallOnlyCardCount: 2, surfaceApplicationCardCount: 3 },
        trainingCoverage: { specVersion: 4, planned: 6, generated: 4, verifiedUsable: 4, practiced: 2 },
        capabilityEvidence: {
          reviewFamiliarity: { reviewedCards: 5, highStabilityCards: 2 },
          sameItemRepeatCount: 0,
          assistedOrExposedCount: 0,
          selfReportedCount: 0,
          unseenIndependentPassCount: 2,
          delayedIndependent: { passedFamilyCount: 1, totalActiveFamilyCount: 2, status: 'progressing' },
          timedIndependent: { passedCount: 2, overBudgetCount: 0, status: 'good' },
          readyForExam: false,
          verdict: 'Need 1 more family pass',
        },
      },
    });

    const tty = createVirtualTty(120, 36);
    let inkInst = null;
    try {
      resetDistStore('zh', false);
      inkInst = render(
        React.createElement(StudyHubTuiApp, {
          host,
          initialPage: 'library',
          initialLanguage: 'zh',
          initialAsciiMode: false,
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
      await tty.waitFor(
        (s) => !s.includes('载入示例课程体验') && s.includes('示例 · Memento 与 Bridge') && !useDistTuiStore.getState().loading,
        { timeoutMs: 12_000, label: 'zh sample loaded' },
      );

      // Navigate to ExamCoach ('9')
      tty.send('9');
      const tab1Screen = await tty.waitFor(
        (s) =>
          s.includes('页表地址转换Alpha') &&
          s.includes('桥接模式解耦Beta') &&
          useDistTuiStore.getState().footerHints.some((h) => h.key === '/' && h.label === '筛选'),
        { timeoutMs: 10_000, label: 'zh ExamCoach Tab 1 with / hint' },
      );
      tty.assertHealthyScreen(tab1Screen, 120, 36, 'zh Tab 1 initial');

      // Tab 1: Press '/' -> opens inline filter bar, does NOT open CommandPalette
      tty.send('/');
      await tty.waitFor(
        (s) =>
          !useDistTuiStore.getState().commandPaletteOpen &&
          useDistTuiStore.getState().inputCaptured &&
          s.includes('[2/2]'),
        { timeoutMs: 5_000, label: 'Tab 1 filter bar opened' },
      );

      // Type 'beta' -> must filter live without triggering shortcuts
      tty.send('beta');
      const tab1Filtered = await tty.waitFor(
        (s) =>
          s.includes('[1/2]') &&
          s.includes('桥接模式解耦Beta') &&
          !s.includes('页表地址转换Alpha'),
        { timeoutMs: 5_000, label: 'Tab 1 filtered to Beta' },
      );
      tty.assertHealthyScreen(tab1Filtered, 120, 36, 'zh Tab 1 filtered');
      assert.equal(useDistTuiStore.getState().page, 'examcoach', 'typing filter must stay on examcoach');

      // Enter exits filter input while keeping filterQuery applied
      tty.send('\r');
      await tty.waitFor(
        (s) => !useDistTuiStore.getState().inputCaptured && s.includes('[1/2]') && s.includes('桥接模式解耦Beta'),
        { timeoutMs: 5_000, label: 'Tab 1 filter committed on Enter' },
      );

      // Press 'x' -> must confirm appearanceApproved on the FILTERED family (fam-beta-bridge)
      tty.send('x');
      await tty.waitFor(
        () => confirmCalls.some((c) => c.familyId === 'fam-beta-bridge' && c.appearanceApproved === true),
        { timeoutMs: 5_000, label: 'x acted on filtered family fam-beta-bridge' },
      );
      assert.equal(confirmCalls.length, 1);

      // Press Esc when !filterOpen && filterQuery -> clears active filter and restores both families
      tty.send('\x1b');
      const tab1Restored = await tty.waitFor(
        (s) => !s.includes('[1/2]') && s.includes('页表地址转换Alpha') && s.includes('桥接模式解耦Beta'),
        { timeoutMs: 5_000, label: 'Tab 1 filter cleared via Esc' },
      );
      tty.assertHealthyScreen(tab1Restored, 120, 36, 'zh Tab 1 restored');

      // Resize to 80x24 and verify typing '1234q' in '/' filter must NOT switch tabs (1-4) or quit (q)
      tty.resize(80, 24);
      const tab1Narrow = await tty.waitFor(
        (s) => s.includes('页表地址转换Alpha') && s.split('\n').length <= 24,
        { timeoutMs: 5_000, label: 'Tab 1 resized to 80x24' },
      );
      tty.assertHealthyScreen(tab1Narrow, 80, 24, 'zh Tab 1 80x24');

      tty.send('/');
      await tty.waitFor(() => useDistTuiStore.getState().inputCaptured, { timeoutMs: 5_000, label: '80x24 filter opened' });
      tty.send('1234q');
      const narrowGuardScreen = await tty.waitFor(
        (s) => s.includes('[1/2]') && s.includes('桥接模式解耦Beta') && !s.includes('页表地址转换Alpha'),
        { timeoutMs: 5_000, label: '80x24 filtered typing 1234q without switching tabs or quitting' },
      );
      tty.assertHealthyScreen(narrowGuardScreen, 80, 24, 'zh Tab 1 filtered 1234q at 80x24');
      assert.equal(useDistTuiStore.getState().page, 'examcoach');
      assert.equal(useDistTuiStore.getState().inputCaptured, true);

      tty.send('\x1b');
      await tty.waitFor(
        (s) => !useDistTuiStore.getState().inputCaptured && !s.includes('[1/2]') && s.includes('页表地址转换Alpha'),
        { timeoutMs: 5_000, label: '80x24 filter cleared via Esc' },
      );
      tty.resize(120, 36);
      await tty.waitFor(
        (s) => s.includes('页表地址转换Alpha') && s.includes('桥接模式解耦Beta'),
        { timeoutMs: 5_000, label: 'Restored 120x36 layout' },
      );

      // Switch to Tab 2 (Variants)
      tty.send('2');
      await tty.waitFor(
        (s) =>
          s.includes('Alpha wrong card') &&
          s.includes('Zeta wrong card') &&
          useDistTuiStore.getState().footerHints.some((h) => h.key === '/'),
        { timeoutMs: 5_000, label: 'Tab 2 Variants loaded' },
      );

      // Open filter on Tab 2 and type 'zeta'
      tty.send('/');
      await tty.waitFor((s) => useDistTuiStore.getState().inputCaptured && s.includes('[2/2]'), { timeoutMs: 5_000, label: 'Tab 2 filter opened' });
      tty.send('zeta');
      const tab2Filtered = await tty.waitFor(
        (s) => s.includes('[1/2]') && s.includes('Zeta wrong card') && !s.includes('Alpha wrong card'),
        { timeoutMs: 5_000, label: 'Tab 2 filtered to Zeta' },
      );
      tty.assertHealthyScreen(tab2Filtered, 120, 36, 'zh Tab 2 filtered');

      // Enter commits, then 'g' queues variant on the filtered Zeta card
      tty.send('\r');
      await tty.waitFor(() => !useDistTuiStore.getState().inputCaptured, { timeoutMs: 5_000, label: 'Tab 2 filter committed' });
      tty.send('g');
      await tty.waitFor(
        () => variantCalls.some((v) => v.cards?.[0]?.cardId === 'card-wrong-zeta'),
        { timeoutMs: 5_000, label: 'g queued filtered variant card-wrong-zeta' },
      );
      assert.equal(variantCalls.length, 1);

      // Open filter again and press Esc inside filter input -> clears filter & exits filterOpen
      tty.send('/');
      await tty.waitFor(() => useDistTuiStore.getState().inputCaptured, { timeoutMs: 5_000, label: 'Tab 2 filter reopened' });
      tty.send('\x1b');
      await tty.waitFor(
        (s) => !useDistTuiStore.getState().inputCaptured && !s.includes('[1/2]') && s.includes('Alpha wrong card'),
        { timeoutMs: 5_000, label: 'Tab 2 Esc inside filter clears & restores' },
      );

      // Switch to Tab 3 (Evidence)
      tty.send('3');
      await tty.waitFor(
        (s) =>
          s.includes('AlphaPoint 概念梳理') &&
          s.includes('OmegaPoint 迁移推导') &&
          useDistTuiStore.getState().footerHints.some((h) => h.key === '/'),
        { timeoutMs: 5_000, label: 'Tab 3 Evidence loaded' },
      );

      // Filter by 'shaky' (matches PT-2 overall)
      tty.send('/');
      await tty.waitFor(() => useDistTuiStore.getState().inputCaptured, { timeoutMs: 5_000, label: 'Tab 3 filter opened' });
      tty.send('shaky');
      const tab3Filtered = await tty.waitFor(
        (s) => s.includes('[1/2]') && s.includes('OmegaPoint 迁移推导') && !s.includes('AlphaPoint 概念梳理'),
        { timeoutMs: 5_000, label: 'Tab 3 filtered to shaky OmegaPoint' },
      );
      tty.assertHealthyScreen(tab3Filtered, 120, 36, 'zh Tab 3 filtered');

      // Enter commits, 'p' starts point practice on filtered OmegaPoint
      tty.send('\r');
      await tty.waitFor(() => !useDistTuiStore.getState().inputCaptured, { timeoutMs: 5_000, label: 'Tab 3 filter committed' });
      tty.send('p');
      await tty.waitFor(
        () => practiceCalls.some((p) => p.scope?.[0]?.cardId === 'card-pt-omega'),
        { timeoutMs: 5_000, label: 'p started practice on filtered OmegaPoint' },
      );
      assert.equal(practiceCalls.length, 1);

      assert.equal(modelCalls, 0, 'ExamCoach `/` filter E2E must invoke 0 model calls');
    } finally {
      try {
        inkInst?.unmount();
      } catch {
        // ignore
      }
      await host.dispose();
      tty.dispose();
    }
  });
});
