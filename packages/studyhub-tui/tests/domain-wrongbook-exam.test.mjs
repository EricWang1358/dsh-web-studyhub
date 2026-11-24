// Consolidated WrongBook & Exam Domain Suite
// Merges: round44-wrongbook-coach, round66-wrongbook-export, round72-wrongbook-filter, round67-exam-export
// node --test tests/domain-wrongbook-exam.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
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
const ORIGINAL_FETCH = globalThis.fetch;
const temps = createTempTracker('studyhub-tui-wb-exam-');

// Bundle pure Markdown formatters from TypeScript sources for unit tests
const wbBundleDir = await temps.make('r66-wb-unit');
const wbBundleFile = join(wbBundleDir, 'wrongbook.mjs');
await build({
  stdin: {
    contents: `export { formatWrongBookMarkdown } from './src/views/wrongbook/WrongBookView.tsx';`,
    resolveDir: pkgRoot,
    loader: 'ts',
  },
  outfile: wbBundleFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  logLevel: 'silent',
  absWorkingDir: pkgRoot,
});
fs.symlinkSync(join(pkgRoot, 'node_modules'), join(wbBundleDir, 'node_modules'), 'junction');
const WrongBookMod = await import(pathToFileURL(wbBundleFile).href);
assert.equal(typeof WrongBookMod.formatWrongBookMarkdown, 'function', 'WrongBookView must export formatWrongBookMarkdown');

const examBundleDir = await temps.make('r67-exam-unit');
const examBundleFile = join(examBundleDir, 'exam-helper.mjs');
await build({
  stdin: {
    contents: `export { formatExamHistoryMarkdown } from './src/views/exam/ExamSetup.tsx';`,
    resolveDir: pkgRoot,
    loader: 'ts',
  },
  outfile: examBundleFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  logLevel: 'silent',
  absWorkingDir: pkgRoot,
});
fs.symlinkSync(join(pkgRoot, 'node_modules'), join(examBundleDir, 'node_modules'), 'junction');
const { formatExamHistoryMarkdown } = await import(pathToFileURL(examBundleFile).href);
assert.equal(typeof formatExamHistoryMarkdown, 'function', 'ExamSetup must export formatExamHistoryMarkdown');

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
  globalThis.fetch = ORIGINAL_FETCH;
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

function itemHaystack(item) {
  return [
    item.prompt,
    item.topic,
    item.deckTitle,
    item.errorReason,
    item.triage?.course,
    item.cardId,
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
}

function pickUniqueKeyword(targetItem, allItems) {
  const candidates = [];
  const promptText = String(targetItem.prompt || '');
  const asciiWords = promptText.match(/[A-Za-z][A-Za-z0-9_-]{3,}/g) || [];
  candidates.push(...asciiWords);
  for (let len = 4; len <= 10; len += 1) {
    for (let i = 0; i + len <= promptText.length; i += 1) {
      const slice = promptText.slice(i, i + len).trim();
      if (slice.length >= 3 && !/[\s$]/.test(slice)) candidates.push(slice);
    }
  }
  if (targetItem.topic) candidates.push(String(targetItem.topic));
  candidates.push(String(targetItem.cardId));

  for (const raw of candidates) {
    const kw = raw.trim();
    if (!kw) continue;
    const needle = kw.toLowerCase();
    const hits = allItems.filter((it) => itemHaystack(it).includes(needle));
    if (hits.length === 1 && hits[0].cardId === targetItem.cardId) {
      return kw;
    }
  }
  return String(targetItem.cardId);
}

async function answerCurrentCardWrong(tty, host, runId, cardNumberLabel) {
  const runInfo = await host.call('review.get', { runId });
  assert.equal(runInfo.ok, true, runInfo.error?.message);
  const card = runInfo.value?.card;
  assert.ok(card?.id, `Card ${cardNumberLabel} must exist in review.get`);

  if (card.kind === 'quiz' && Array.isArray(card.options) && card.options.length > 0) {
    await tty.waitFor(
      () =>
        useDistTuiStore.getState().page === 'review' &&
        useDistTuiStore.getState().footerHints.some((h) => h.key.includes('1-6')),
      { timeoutMs: 10_000, label: `Card ${cardNumberLabel} MCQ ready for choice input` },
    );
    await tty.flush();
    const wrongIdx = card.options.findIndex((o) => !o.correct);
    const pick = wrongIdx >= 0 ? wrongIdx + 1 : 1;
    tty.send(String(pick));
    await tty.waitFor(
      (s) =>
        s.includes('下一题') ||
        s.includes('错因') ||
        s.includes('答案与解析') ||
        useDistTuiStore.getState().footerHints.some((h) => h.label === '下一题' || h.label === 'Next'),
      { timeoutMs: 10_000, label: `Card ${cardNumberLabel} MCQ wrong answer feedback` },
    );
  } else if (card.kind === 'truefalse') {
    await tty.waitFor(
      () =>
        useDistTuiStore.getState().page === 'review' &&
        useDistTuiStore.getState().footerHints.some((h) => h.key.includes('1/2')),
      { timeoutMs: 10_000, label: `Card ${cardNumberLabel} TF ready for judge input` },
    );
    await tty.flush();
    const wrongKey = String(card.answer).toLowerCase() === 'true' ? '2' : '1';
    tty.send(wrongKey);
    await tty.waitFor(
      (s) =>
        s.includes('下一题') ||
        s.includes('答案与解析') ||
        useDistTuiStore.getState().footerHints.some((h) => h.label === '下一题' || h.label === 'Next'),
      { timeoutMs: 10_000, label: `Card ${cardNumberLabel} TF wrong answer feedback` },
    );
  } else if (card.kind === 'cloze') {
    tty.send('__wrong_cloze__');
    await tty.flush();
    tty.send('\r');
    await tty.waitFor(
      (s) =>
        s.includes('下一题') ||
        s.includes('答案与解析') ||
        useDistTuiStore.getState().footerHints.some((h) => h.label === '下一题' || h.label === 'Next'),
      { timeoutMs: 10_000, label: `Card ${cardNumberLabel} cloze wrong answer feedback` },
    );
  } else {
    await tty.waitFor(
      () =>
        useDistTuiStore.getState().page === 'review' &&
        useDistTuiStore.getState().footerHints.some((h) => h.key.includes('Space') || h.key === '0-5'),
      { timeoutMs: 10_000, label: `Card ${cardNumberLabel} self-graded card ready` },
    );
    await tty.flush();
    if (!useDistTuiStore.getState().footerHints.some((h) => h.key === '0-5')) {
      tty.send(' ');
      await tty.waitFor(
        (s) =>
          useDistTuiStore.getState().page === 'review' &&
          s.includes('答案与解析') &&
          useDistTuiStore.getState().footerHints.some((h) => h.key === '0-5'),
        { timeoutMs: 10_000, label: `Card ${cardNumberLabel} flashcard flipped and 0-5 rating ready` },
      );
      // Flush one frame/effect turn so useClaimKeys registers digit key '1' before sending it.
      await tty.flush();
    }
    tty.send('1');
    await tty.waitFor(
      (s) =>
        s.includes('回答有误') ||
        s.includes('下一题') ||
        useDistTuiStore.getState().footerHints.some((h) => h.label === '下一题' || h.label === 'Next'),
      { timeoutMs: 10_000, label: `Card ${cardNumberLabel} flashcard rated 1 (wrong)` },
    );
  }
}

describe('Round 44: WrongBook Coach Variant Practice ([V] / coach.practice)', () => {
  test('1) createTuiHost integration: coach.practice errors cleanly when none ready, then starts review run when prepared variant is ready', async () => {
    const base = await temps.make('r44-host');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
    const libraryRoot = join(base, 'library');
    await cloneSampleLibrary('en', libraryRoot);
    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      providerDiscovery: fakeDiscovery(),
      injectedComplete: createVariantStubComplete(),
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      const initSnap = await host.call('snapshot', {});
      assert.equal(initSnap.ok, true, initSnap.error?.message);

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
      assert.equal(runRes.value?.index, 0, 'started run should start at index 0');
      assert.ok(runRes.value?.card?.prompt, 'started run card must have prompt');

      const getRun = await host.call('review.get', { runId: runRes.value.id });
      assert.equal(getRun.ok, true, getRun.error?.message);
      assert.equal(getRun.value?.id, runRes.value.id);
      assert.equal(getRun.value?.card?.id, runRes.value.card.id);
      assert.equal(getRun.value?.total, runRes.value.total);
      assert.equal(getRun.value?.index, 0);
      assert.equal(typeof getRun.value?.answered, 'number');
      assert.equal(getRun.value?.answered, 0);
    } finally {
      await host.dispose();
    }
  });

  test('2) PTY E2E: WrongBookView [V] shows helpful toast when no variants ready (zh & --ascii en at 120x36 & 80x24) and launches ReviewView when ready', async () => {
    // 2a) Default zh mode at 120x36 & 80x24
    const zhBase = await temps.make('r44-pty-zh');
    const zhDshHome = join(zhBase, 'dsh-home');
    process.env.DSH_HOME = zhDshHome;
    await saveTuiPreferences(
      { language: 'zh', asciiMode: false, theme: 'tokyo-night', mathUnicode: true, showHints: true },
      { env: sanitizedTestEnv({ DSH_HOME: zhDshHome }) },
    );

    const zhLibraryRoot = join(zhBase, 'library');
    await cloneSampleLibrary('zh', zhLibraryRoot);

    const zhHost = await createTuiHost({
      libraryRoot: zhLibraryRoot,
      env: sanitizedTestEnv({ DSH_HOME: zhDshHome }),
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
      assert.equal(useDistTuiStore.getState().helpOpen, true, 'helpOpen must be true when HelpOverlay is open');
      await zhTty.flush(20);
      let zhHelp = zhTty.readScreen();
      for (let step = 0; step < 12 && !zhHelp.includes('练错题变式'); step += 1) {
        const prev = zhHelp;
        zhTty.send('\x04');
        zhHelp = await zhTty.waitFor(
          (s) => s.includes('练错题变式') || s !== prev,
          { timeoutMs: 2_000, label: `zh HelpOverlay scroll step ${step + 1}` },
        );
      }
      assert.ok(zhHelp.includes('快捷键') && zhHelp.includes('练错题变式'), 'HelpOverlay must display [V] shortcut');
      zhTty.assertHealthyScreen(zhHelp, 120, 36, 'zh HelpOverlay 120x36');
      zhTty.send('\x1b');
      await zhTty.waitFor((s) => !s.includes('快捷键'), { timeoutMs: 5_000, label: 'zh HelpOverlay closed' });
      assert.equal(useDistTuiStore.getState().helpOpen, false, 'helpOpen must be false after Esc');

      // Verify 80x24 narrow layout
      zhTty.resize(80, 24);
      const zhNarrow = await zhTty.waitFor(
        (s) => s.includes('错题列表') && s.split('\n').length <= 24,
        { timeoutMs: 6_000, label: 'zh WrongBookView at 80x24' },
      );
      assert.ok(zhNarrow.includes('错题列表'), '80x24 WrongBookView must render title');
      zhTty.assertHealthyScreen(zhNarrow, 80, 24, 'zh WrongBookView 80x24');

      useDistTuiStore.setState({ toasts: [] });
      zhTty.send('V');
      const zhToastNarrow = await zhTty.waitFor(
        (s) => s.includes('无变式') && s.includes('考试教练(9)[g]'),
        { timeoutMs: 6_000, label: 'zh WrongBook [V] no-variants toast at 80x24' },
      );
      assert.ok(zhToastNarrow.includes('无变式'), '80x24 toast must appear');
      zhTty.assertHealthyScreen(zhToastNarrow, 80, 24, 'zh WrongBook [V] toast 80x24');

      // Switch in-place to --ascii en mode at 80x24 & 120x36 (no second PTY mount)
      zhHost.setLanguage('en');
      useDistTuiStore.getState().setPreferences({ language: 'en', asciiMode: true });
      useDistTuiStore.setState({ toasts: [] });

      const enNarrow = await zhTty.waitFor(
        (s) => s.includes('Mistakes') && !s.includes('Loading mistakes') && s.split('\n').length <= 24,
        { timeoutMs: 6_000, label: 'en WrongBookView at 80x24' },
      );
      zhTty.assertHealthyScreen(enNarrow, 80, 24, 'en WrongBookView 80x24');
      zhTty.assertAsciiPure(enNarrow, 'en WrongBookView 80x24');
      await zhTty.flush(40);

      zhTty.send('V');
      const enToastNarrow = await zhTty.waitFor(
        (s) => s.includes('No variants; ExamCoach'),
        { timeoutMs: 6_000, label: 'en WrongBook [V] no-variants toast at 80x24' },
      );
      zhTty.assertHealthyScreen(enToastNarrow, 80, 24, 'en WrongBook [V] toast 80x24');
      zhTty.assertAsciiPure(enToastNarrow, 'en WrongBook [V] toast 80x24');

      zhTty.resize(120, 36);
      const enWb = await zhTty.waitFor(
        (s) =>
          !s.includes('备考补习') &&
          !s.includes('作答对比') &&
          s.includes('Mistakes') &&
          s.includes('Answer Comparison') &&
          !s.includes('Loading mistakes'),
        { timeoutMs: 6_000, label: 'en WrongBookView at 120x36' },
      );
      zhTty.assertHealthyScreen(enWb, 120, 36, 'en WrongBookView 120x36');
      zhTty.assertAsciiPure(enWb, 'en WrongBookView 120x36');

      useDistTuiStore.setState({ toasts: [] });
      zhTty.send('V');
      const enToastWide = await zhTty.waitFor(
        (s) => s.includes('No variants') && s.includes('ExamCoach(9)[g]'),
        { timeoutMs: 6_000, label: 'en WrongBook [V] no-variants toast at 120x36' },
      );
      zhTty.assertHealthyScreen(enToastWide, 120, 36, 'en WrongBook [V] toast 120x36');
      zhTty.assertAsciiPure(enToastWide, 'en WrongBook [V] toast 120x36');

      // Prepare a variant for the currently highlighted wrongbook card, then press [V] to launch ReviewView
      const wb = await zhHost.call('wrongbook', { course: '*', view: 'weak', offset: 0, limit: 20 });
      assert.equal(wb.ok, true);
      const firstWrong = wb.value?.items?.[0];
      assert.ok(firstWrong?.deckId && firstWrong?.cardId);
      const varRes = await zhHost.call('coach.variants', {
        cards: [{ deckId: firstWrong.deckId, cardId: firstWrong.cardId }],
        consent: true,
      });
      assert.equal(varRes.ok, true, varRes.error?.message);
      assert.equal(varRes.value?.queued, 1, 'coach.variants must queue 1 item');
      const prepRes = await zhHost.call('coach.prepare', {});
      assert.equal(prepRes.ok, true, prepRes.error?.message);
      assert.ok((prepRes.value?.ready ?? 0) >= 1);

      zhTty.send('V');
      const reviewScreen = await zhTty.waitFor(
        (s) =>
          useDistTuiStore.getState().page === 'review' &&
          Boolean(useDistTuiStore.getState().activeRunId) &&
          (s.includes('Started mistake variant practice') || s.includes('Variant practice question')),
        { timeoutMs: 10_000, label: 'en WrongBook [V] launched ReviewView' },
      );
      assert.equal(useDistTuiStore.getState().page, 'review', 'page must switch to review');
      assert.ok(useDistTuiStore.getState().activeRunId, 'activeRunId must be set');
      assert.ok(!reviewScreen.includes('undefined'), 'review screen must not leak undefined');
      zhTty.assertHealthyScreen(reviewScreen, 120, 36, 'en ReviewView after WrongBook [V]');
      zhTty.assertAsciiPure(reviewScreen, 'en ReviewView after WrongBook [V]');
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

describe('Round 66 Track 3: WrongBookView [X] Atomic Markdown Study Sheet Export', () => {
  test('1) Unit: formatWrongBookMarkdown renders bilingual study sheets with numbered prompts, options, mistake counts & <details>', () => {
    const sampleItems = [
      {
        deckId: 'd1',
        deckTitle: 'Design Patterns',
        cardId: 'c1',
        topic: 'Memento Pattern',
        kind: 'quiz',
        prompt: 'Which role stores the internal state snapshot without exposing implementation details?',
        wrongCount: 3,
        errorReason: 'concept',
        options: [
          { id: 'a', text: 'Originator', correct: false },
          { id: 'b', text: 'Memento', correct: true },
          { id: 'c', text: 'Caretaker', correct: false },
        ],
        correctAnswer: 'Memento',
        explanation: 'Memento encapsulates the state snapshot created by Originator; Caretaker only holds it.',
        misconception: 'Confusing Caretaker with Memento.',
      },
      {
        deckId: 'd2',
        deckTitle: 'Linear Algebra',
        cardId: 'c2',
        topic: 'Eigenvalues',
        kind: 'open',
        prompt: 'Explain why similar matrices share the same characteristic polynomial.',
        wrongCount: 2,
        detail: {
          deckId: 'd2',
          cardId: 'c2',
          correctAnswer: 'det(P^-1 A P - lambda I) = det(P^-1 (A - lambda I) P) = det(A - lambda I)',
          explanation: 'Determinant is multiplicative and det(P^-1) * det(P) = 1.',
        },
      },
    ];

    const zhMd = WrongBookMod.formatWrongBookMarkdown({
      items: sampleItems,
      course: '软件工程与代数',
      lang: 'zh',
      generatedAt: '2026-11-22 21:00',
    });
    assert.ok(zhMd.includes('# 错题复习卷'), 'zh header title missing');
    assert.ok(zhMd.includes('2026-11-22 21:00'), 'zh date missing');
    assert.ok(zhMd.includes('软件工程与代数'), 'zh course filter missing');
    assert.ok(zhMd.includes('**错题数量**: 2'), 'zh card count missing');
    assert.ok(zhMd.includes('## 1. Memento Pattern'), 'numbered heading 1 missing');
    assert.ok(zhMd.includes('## 2. Eigenvalues'), 'numbered heading 2 missing');
    assert.ok(zhMd.includes('出错次数: 3'), 'mistake count 3 missing');
    assert.ok(zhMd.includes('出错次数: 2'), 'mistake count 2 missing');
    assert.ok(zhMd.includes('Which role stores the internal state snapshot'), 'prompt 1 missing');
    assert.ok(zhMd.includes('- **A.** Originator') && zhMd.includes('- **B.** Memento'), 'options missing');
    assert.ok(zhMd.includes('<details>'), '<details> block missing');
    assert.ok(zhMd.includes('<summary>参考答案与解析 / Answer & Explanation</summary>'), '<summary> missing');
    assert.ok(zhMd.includes('**参考答案**: Memento'), 'reference answer 1 missing');
    assert.ok(zhMd.includes('Memento encapsulates the state snapshot'), 'explanation 1 missing');
    assert.ok(zhMd.includes('Confusing Caretaker with Memento.'), 'misconception 1 missing');
    assert.ok(zhMd.includes('det(P^-1 A P - lambda I)'), 'reference answer 2 missing');
    assert.ok(zhMd.includes('</details>'), '</details> closing tag missing');

    const enMd = WrongBookMod.formatWrongBookMarkdown({
      items: sampleItems,
      course: null,
      lang: 'en',
      generatedAt: new Date(2026, 10, 22, 9, 5),
    });
    assert.ok(enMd.includes('# Wrong-Book Study Sheet'), 'en header title missing');
    assert.ok(enMd.includes('2026-11-22 09:05'), 'en formatted Date missing');
    assert.ok(enMd.includes('All Courses'), 'en all-courses fallback missing');
    assert.ok(enMd.includes('**Cards**: 2'), 'en card count missing');
    assert.ok(enMd.includes('Mistakes: 3'), 'en mistake count 3 missing');
    assert.ok(enMd.includes('<summary>参考答案与解析 / Answer & Explanation</summary>'), 'en <summary> missing');
    assert.ok(enMd.includes('**Reference Answer**: Memento'), 'en reference answer missing');
    assert.ok(enMd.includes('**Explanation**:'), 'en explanation heading missing');

    const emptyMd = WrongBookMod.formatWrongBookMarkdown({
      items: [],
      course: null,
      lang: 'en',
      generatedAt: '2026-11-22 10:00',
    });
    assert.ok(emptyMd.includes('# Wrong-Book Study Sheet'));
    assert.ok(emptyMd.includes('2026-11-22 10:00'));
    assert.ok(emptyMd.includes('All Courses'));
    assert.ok(emptyMd.includes('**Cards**: 0'));
    assert.ok(emptyMd.includes('No wrong cards to export'));

    const emptyZhMd = WrongBookMod.formatWrongBookMarkdown({
      items: [],
      course: '',
      lang: 'zh',
      generatedAt: '2026-11-22 10:00',
    });
    assert.ok(emptyZhMd.includes('# 错题复习卷'));
    assert.ok(emptyZhMd.includes('全部课程'));
    assert.ok(emptyZhMd.includes('**错题数量**: 0'));
    assert.ok(emptyZhMd.includes('当前没有可导出的错题'));
    assert.ok(zhMd.includes('- **C.** Caretaker'));
    assert.ok(zhMd.includes('Explain why similar matrices'));
    assert.ok(zhMd.includes('Determinant is multiplicative'));
    assert.ok(enMd.includes('- **A.** Originator'));
    assert.ok(enMd.includes('- **B.** Memento'));
    assert.ok(enMd.includes('- **C.** Caretaker'));
    assert.ok(enMd.includes('Mistakes: 2'));
    assert.ok(enMd.includes('Confusing Caretaker with Memento.'));
    assert.ok(enMd.includes('Determinant is multiplicative'));
  });

  test('2) @xterm/headless PTY E2E (120x36 zh): load sample -> answer 1 card wrong in review -> WrongBook (4) -> [X] exports studyhub-wrongbook-*.md (0 model calls)', async () => {
    const base = await temps.make('r66-pty-zh');
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

      // Start a fresh review round on the selected sample deck via Enter, then answer 1 card wrong
      await tty.waitFor(
        (s) => !s.includes('载入示例课程体验') && s.includes('示例 · Memento 与 Bridge') && !useDistTuiStore.getState().loading,
        { timeoutMs: 12_000, label: 'zh sample deck settled' },
      );
      await tty.flush();
      tty.send('\r');
      await tty.waitFor(
        (s) =>
          useDistTuiStore.getState().page === 'review' &&
          Boolean(useDistTuiStore.getState().activeRunId) &&
          !s.includes('正在加载练习') &&
          s.includes('1/9'),
        { timeoutMs: 10_000, label: 'Fresh review round started via Enter' },
      );
      const activeRunId = useDistTuiStore.getState().activeRunId;
      const runInfo = await host.call('review.get', { runId: activeRunId });
      assert.equal(runInfo.ok, true, runInfo.error?.message);
      const card = runInfo.value?.card;
      assert.ok(card?.id, 'active review run must have a card');

      if (card.kind === 'quiz' && Array.isArray(card.options) && card.options.length > 0) {
        const wrongIdx = card.options.findIndex((o) => !o.correct);
        const pick = wrongIdx >= 0 ? wrongIdx + 1 : 1;
        tty.send(String(pick));
        await tty.waitFor(
          (s) => s.includes('下一题') || s.includes('错因') || s.includes('参考答案') || s.includes('解析'),
          { timeoutMs: 6_000, label: 'MCQ wrong answer feedback' },
        );
      } else if (card.kind === 'truefalse') {
        const wrongKey = String(card.answer).toLowerCase() === 'true' ? '2' : '1';
        tty.send(wrongKey);
        await tty.waitFor(
          (s) => s.includes('下一题') || s.includes('参考答案') || s.includes('解析'),
          { timeoutMs: 6_000, label: 'TF wrong answer feedback' },
        );
      } else {
        tty.send(' ');
        await tty.waitFor(
          (s) => !s.includes('翻开答案') && (s.includes('0') || s.includes('评分') || s.includes('参考答案')),
          { timeoutMs: 6_000, label: 'Flashcard flipped for rating' },
        );
        tty.send('1');
        await tty.waitFor(
          (s) => s.includes('回答有误') || s.includes('下一题') || s.includes('2/9'),
          { timeoutMs: 6_000, label: 'Flashcard rated 1 (wrong) and recorded' },
        );
      }

      // End round cleanly ('X' -> 'y') and wait for RoundSummary to mount before sending '4'
      tty.send('X');
      await tty.waitFor((s) => s.includes('结束本轮练习'), { timeoutMs: 6_000, label: 'End round dialog' });
      tty.send('y');
      await tty.waitFor((s) => !s.includes('结束本轮练习') && (s.includes('本轮练习总结') || s.includes('Round Summary')), {
        timeoutMs: 6_000,
        label: 'Exited review round to summary',
      });

      // Navigate to WrongBook ('4')
      tty.send('4');
      const wbScreen = await tty.waitFor(
        (s) => s.includes('错题列表') && !s.includes('正在加载错题本') && s.includes('导出错题'),
        { timeoutMs: 10_000, label: 'zh WrongBookView with X hint' },
      );
      tty.assertHealthyScreen(wbScreen, 120, 36, 'zh WrongBookView 120x36');

      const wbRes = await host.call('wrongbook', { course: '*', view: 'weak', offset: 0, limit: 20 });
      assert.equal(wbRes.ok, true);
      assert.ok((wbRes.value?.items?.length ?? 0) >= 1, 'WrongBook must have >= 1 item');
      const firstPromptSnippet = String(wbRes.value.items[0].prompt || '').trim().slice(0, 18);

      // Press 'X' to export Wrong-Book Markdown study sheet atomically
      const backupsDir = join(libraryRoot, 'backups');
      const todayYmd = todayLocalYmd();
      tty.send('X');
      const afterExport = await tty.waitFor(
        (s) =>
          useDistTuiStore
            .getState()
            .toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已导出') && toast.text.includes('studyhub-wrongbook-')) &&
          s.includes('已导出'),
        { timeoutMs: 10_000, label: 'zh WrongBook [X] export toast & file on disk' },
      );
      tty.assertHealthyScreen(afterExport, 120, 36, 'zh WrongBookView after [X] export');

      const zhWbExport = await findExportedBackupFile(backupsDir, 'studyhub-wrongbook', 'md', todayYmd);
      assert.ok(zhWbExport, `expected studyhub-wrongbook-${todayYmd}-HHmmss.md in ${backupsDir}`);
      const exportedMd = await readFile(zhWbExport.path, 'utf8');
      assert.ok(exportedMd.includes('# 错题复习卷'), 'exported MD must have zh title');
      assert.ok(exportedMd.includes('<details>'), 'exported MD must contain <details>');
      assert.ok(exportedMd.includes('<summary>参考答案与解析 / Answer & Explanation</summary>'), 'exported MD must contain <summary>');
      assert.ok(exportedMd.includes('</details>'), 'exported MD must contain </details>');
      if (firstPromptSnippet) {
        assert.ok(exportedMd.includes(firstPromptSnippet), `exported MD must include question prompt "${firstPromptSnippet}"`);
      }

      // Switch in-place to 80x24 --ascii en (reuses single mounted app)
      await rm(backupsDir, { recursive: true, force: true });
      tty.resize(80, 24);
      host.setLanguage('en');
      useDistTuiStore.getState().setPreferences({ language: 'en', asciiMode: true });
      useDistTuiStore.setState({ toasts: [] });

      const enWbScreen = await tty.waitFor(
        (s) => s.includes('Mistakes') && !s.includes('Loading mistakes') && s.split('\n').length <= 24,
        { timeoutMs: 10_000, label: 'en WrongBookView 80x24' },
      );
      tty.assertHealthyScreen(enWbScreen, 80, 24, 'en WrongBookView 80x24');
      tty.assertAsciiPure(enWbScreen, 'en WrongBookView 80x24');

      tty.send('X');
      const enAfterExport = await tty.waitFor(
        () =>
          useDistTuiStore
            .getState()
            .toasts.some(
              (toast) =>
                toast.tone === 'success' &&
                toast.text.includes('Exported') &&
                toast.text.includes('wrong card(s) ->') &&
                toast.text.includes('studyhub-wrongbook-'),
            ),
        { timeoutMs: 10_000, label: 'en WrongBook [X] export toast & file on disk' },
      );
      tty.assertHealthyScreen(enAfterExport, 80, 24, 'en WrongBookView after [X] export 80x24');
      tty.assertAsciiPure(enAfterExport, 'en WrongBookView after [X] export 80x24');

      const enWbExport = await findExportedBackupFile(backupsDir, 'studyhub-wrongbook', 'md', todayYmd);
      assert.ok(enWbExport, `expected studyhub-wrongbook-${todayYmd}-HHmmss.md in ${backupsDir}`);
      const exportedEnMd = await readFile(enWbExport.path, 'utf8');
      assert.ok(exportedEnMd.includes('# Wrong-Book Study Sheet'), 'exported MD must have en title');
      assert.ok(exportedEnMd.includes('## 1.'), 'exported MD must have numbered question');
      assert.ok(exportedEnMd.includes('<details>'), 'exported MD must contain <details>');
      assert.ok(exportedEnMd.includes('<summary>参考答案与解析 / Answer & Explanation</summary>'), 'exported MD must contain <summary>');
      assert.ok(exportedEnMd.includes('</details>'), 'exported MD must contain </details>');
      assert.equal(modelCalls, 0, 'WrongBook export must invoke 0 model calls');
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

describe('Round 72 Track 1: WrongBookView `/` Live Wrong-Card Search & Filter', () => {
  test('1) @xterm/headless PTY E2E (120x36 zh): load sample -> answer 2 cards wrong -> WrongBook (4) -> `/` filter -> Enter -> Esc clears (0 model calls)', async () => {
    const base = await temps.make('r72-pty-zh');
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

      // Start review round on the selected sample deck and answer 2 cards wrong
      await tty.waitFor(
        (s) => !s.includes('载入示例课程体验') && s.includes('示例 · Memento 与 Bridge') && !useDistTuiStore.getState().loading,
        { timeoutMs: 12_000, label: 'zh sample deck settled' },
      );
      await tty.flush();
      tty.send('\r');
      await tty.waitFor(
        (s) =>
          useDistTuiStore.getState().page === 'review' &&
          Boolean(useDistTuiStore.getState().activeRunId) &&
          !s.includes('正在加载练习') &&
          s.includes('1/'),
        { timeoutMs: 10_000, label: 'Fresh review round started' },
      );
      const activeRunId = useDistTuiStore.getState().activeRunId;
      await answerCurrentCardWrong(tty, host, activeRunId, 1);

      // Advance to card 2 if still on card 1
      const afterCard1 = await host.call('review.get', { runId: activeRunId });
      if ((afterCard1.value?.index ?? 0) === 0) {
        tty.send('\r');
        await tty.waitFor(
          (s) =>
            s.includes('2/') &&
            !useDistTuiStore.getState().footerHints.some((h) => h.label === '下一题' || h.label === 'Next'),
          { timeoutMs: 10_000, label: 'Advanced to card 2' },
        );
      }
      await answerCurrentCardWrong(tty, host, activeRunId, 2);

      // End round cleanly ('X' -> 'y') and wait for RoundSummary to mount before sending '4'
      tty.send('X');
      await tty.waitFor((s) => s.includes('结束本轮练习'), { timeoutMs: 6_000, label: 'End round dialog' });
      tty.send('y');
      await tty.waitFor((s) => !s.includes('结束本轮练习') && (s.includes('本轮练习总结') || s.includes('Round Summary')), {
        timeoutMs: 6_000,
        label: 'Exited review round to summary',
      });

      // Navigate to WrongBook ('4')
      tty.send('4');
      const wbScreen = await tty.waitFor(
        (s) =>
          s.includes('错题列表') &&
          !s.includes('正在加载错题本') &&
          useDistTuiStore.getState().footerHints.some((h) => h.key === '/' && h.label === '筛选'),
        { timeoutMs: 10_000, label: 'zh WrongBookView with `/` hint' },
      );
      tty.assertHealthyScreen(wbScreen, 120, 36, 'zh WrongBookView 120x36');

      const wbRes = await host.call('wrongbook', { course: '*', view: 'weak', offset: 0, limit: 50 });
      assert.equal(wbRes.ok, true);
      const items = wbRes.value?.items ?? [];
      assert.ok(items.length >= 2, `Expected >= 2 wrongbook items, got ${items.length}`);
      const total = items.length;
      const card1 = items[0];
      const card2 = items[1];
      const keyword = pickUniqueKeyword(card2, items);
      const card2PromptHead = String(card2.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 8);
      const card1Unique = pickUniqueKeyword(card1, items);

      // Press '/' to open inline filter bar (must NOT open CommandPalette)
      tty.send('/');
      await tty.waitFor(
        (s) =>
          !useDistTuiStore.getState().commandPaletteOpen &&
          useDistTuiStore.getState().inputCaptured &&
          s.includes(`[筛选 ${total}/${total}]`),
        { timeoutMs: 5_000, label: 'zh WrongBookView filter bar opened' },
      );

      // Type unique keyword from card 2 (lower-cased to also exercise case-insensitive matching)
      tty.send(keyword.toLowerCase());
      const filteredEditing = await tty.waitFor(
        (s) =>
          s.includes(`[筛选 1/${total}]`) &&
          (!card2PromptHead || s.includes(card2PromptHead)),
        { timeoutMs: 5_000, label: 'zh WrongBookView filtered to card 2 while editing' },
      );
      tty.assertHealthyScreen(filteredEditing, 120, 36, 'zh WrongBookView filtered editing');
      assert.equal(useDistTuiStore.getState().page, 'wrongbook', 'typing filter keyword must stay on wrongbook');

      // Press Enter to confirm/blur keeping filter active with match count badge
      tty.send('\r');
      const filteredConfirmed = await tty.waitFor(
        (s) =>
          !useDistTuiStore.getState().inputCaptured &&
          s.includes(`[筛选 1/${total}]`) &&
          (!card2PromptHead || s.includes(card2PromptHead)) &&
          useDistTuiStore.getState().page === 'wrongbook',
        { timeoutMs: 5_000, label: 'zh WrongBookView filter confirmed on Enter' },
      );
      tty.assertHealthyScreen(filteredConfirmed, 120, 36, 'zh WrongBookView filter confirmed');

      // Verify clamped selectedIndex targets the highlighted filtered item (Space selects card 2)
      tty.send(' ');
      await tty.waitFor((s) => s.includes('已选 1'), { timeoutMs: 5_000, label: 'Space selected filtered card' });
      tty.send('x');
      await tty.waitFor((s) => !s.includes('已选 1'), { timeoutMs: 5_000, label: 'x cleared selection' });

      // Press Esc in normal mode to clear filter and restore full list
      tty.send('\x1b');
      const restoredScreen = await tty.waitFor(
        (s) =>
          !s.includes('[筛选 ') &&
          (!card1Unique || s.includes(card1Unique) || s.includes(String(card1.prompt || '').slice(0, 6))),
        { timeoutMs: 5_000, label: 'zh WrongBookView filter cleared on Esc' },
      );
      tty.assertHealthyScreen(restoredScreen, 120, 36, 'zh WrongBookView restored');

      // Switch in-place to 80x24 --ascii en (reuses single mounted app)
      tty.resize(80, 24);
      host.setLanguage('en');
      useDistTuiStore.getState().setPreferences({ language: 'en', asciiMode: true });
      useDistTuiStore.setState({ toasts: [] });

      const enWbScreen = await tty.waitFor(
        (s) =>
          s.includes('Mistakes') &&
          !s.includes('Loading mistakes') &&
          useDistTuiStore.getState().footerHints.some((h) => h.key === '/' && h.label === 'Filter') &&
          s.split('\n').length <= 24,
        { timeoutMs: 10_000, label: 'en WrongBookView 80x24 with `/` hint' },
      );
      tty.assertHealthyScreen(enWbScreen, 80, 24, 'en WrongBookView 80x24');
      tty.assertAsciiPure(enWbScreen, 'en WrongBookView 80x24');

      // Press '/' to open inline filter bar
      tty.send('/');
      const openBar = await tty.waitFor(
        (s) =>
          !useDistTuiStore.getState().commandPaletteOpen &&
          useDistTuiStore.getState().inputCaptured &&
          s.includes(`[Filter ${total}/${total}]`),
        { timeoutMs: 5_000, label: 'en WrongBookView filter bar opened 80x24' },
      );
      tty.assertHealthyScreen(openBar, 80, 24, 'en WrongBookView filter bar opened 80x24');
      tty.assertAsciiPure(openBar, 'en WrongBookView filter bar opened 80x24');

      // Type unique keyword from target item
      tty.send(keyword.toLowerCase());
      const filteredEditingEn = await tty.waitFor(
        (s) => s.includes(`[Filter 1/${total}]`),
        { timeoutMs: 5_000, label: 'en WrongBookView filtered 1/N while editing 80x24' },
      );
      tty.assertHealthyScreen(filteredEditingEn, 80, 24, 'en WrongBookView filtered editing 80x24');
      tty.assertAsciiPure(filteredEditingEn, 'en WrongBookView filtered editing 80x24');

      // Press Enter to confirm/blur
      tty.send('\r');
      const filteredConfirmedEn = await tty.waitFor(
        (s) =>
          !useDistTuiStore.getState().inputCaptured &&
          s.includes(`[Filtered 1/${total}]`) &&
          useDistTuiStore.getState().page === 'wrongbook',
        { timeoutMs: 5_000, label: 'en WrongBookView filter confirmed on Enter 80x24' },
      );
      tty.assertHealthyScreen(filteredConfirmedEn, 80, 24, 'en WrongBookView filter confirmed 80x24');
      tty.assertAsciiPure(filteredConfirmedEn, 'en WrongBookView filter confirmed 80x24');

      // Press Esc in normal mode to clear filter
      tty.send('\x1b');
      const enRestoredScreen = await tty.waitFor(
        (s) => !s.includes('[Filtered ') && !s.includes('[Filter '),
        { timeoutMs: 5_000, label: 'en WrongBookView filter cleared on Esc 80x24' },
      );
      tty.assertHealthyScreen(enRestoredScreen, 80, 24, 'en WrongBookView restored 80x24');
      tty.assertAsciiPure(enRestoredScreen, 'en WrongBookView restored 80x24');
      assert.equal(modelCalls, 0, 'WrongBookView `/` filter must invoke 0 model calls');
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

describe('Round 67 Track 3: ExamSetup [x] Atomic Exam History Markdown Report Export', () => {
  let boxDir;
  let dshHome;
  let libraryRoot;
  let host;
  let fetchCalls = 0;
  let activeTty = null;
  let activeInk = null;
  let disposed = false;

  async function unmountActiveApp() {
    const ink = activeInk;
    const tty = activeTty;
    activeInk = null;
    activeTty = null;
    try {
      ink?.unmount();
    } catch {
      // Ignore unmount errors during test teardown
    }
    tty?.dispose();
  }

  async function mountApp({ initialPage = 'library', asciiMode = false, language = 'zh', cols = 120, rows = 36 } = {}) {
    await unmountActiveApp();
    resetDistStore(language, asciiMode, { loading: true });
    await saveTuiPreferences({ language, asciiMode }, { env: { DSH_HOME: dshHome } });
    host.setLanguage(language);
    const tty = createVirtualTty(cols, rows);
    let inkInstance = null;
    inkInstance = render(
      React.createElement(StudyHubTuiApp, {
        host,
        initialPage,
        initialLanguage: language,
        initialAsciiMode: asciiMode,
        autoLaunchpad: false,
        onExit: () => inkInstance?.unmount(),
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
    activeTty = tty;
    activeInk = inkInstance;
    await tty.firstFramePromise;
    await tty.waitFor(
      () => Boolean(useDistTuiStore.getState().snapshot) && !useDistTuiStore.getState().loading,
      { timeoutMs: 10_000, label: `App boot settled (${language} ${cols}x${rows})` },
    );
    await tty.flush();
    return tty;
  }

  before(async () => {
    boxDir = await temps.make('r67-main');
    dshHome = join(boxDir, 'dsh-home');
    libraryRoot = join(boxDir, 'library');
    await mkdir(libraryRoot, { recursive: true });
    process.env.DSH_HOME = dshHome;

    host = await createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(boxDir, 'home'),
      libraryRoot,
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
      fetch: async () => {
        fetchCalls += 1;
        throw new Error('Unexpected fetch call');
      },
    });

    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error('Unexpected global fetch call');
    };

    await host.refreshSnapshot();
  });

  after(async () => {
    if (disposed) return;
    disposed = true;
    try {
      await unmountActiveApp();
      await host?.dispose();
    } finally {
      globalThis.fetch = ORIGINAL_FETCH;
    }
  });

  test('1) Pure unit test: formatExamHistoryMarkdown (zh & en, selected attempt detail + summary table + empty case)', () => {
    const sampleHistory = [
      {
        runId: 'run-written-1',
        kind: 'written',
        mode: 'written',
        title: '[选择题卷] 操作系统 | 核心考点',
        scope: 'Operating Systems | Core',
        scorePct: 85,
        score: '85%',
        answered: 17,
        total: 20,
        durationMs: 750_000,
        submittedAt: '2026-11-22T10:30:00.000Z',
      },
      {
        runId: 'run-case-1',
        kind: 'written',
        mode: 'case',
        examKinds: 'case',
        title: '[案例卷] 临床诊断分析',
        scope: 'Clinical Case Deck',
        scorePct: 75,
        score: '75%',
        answered: 4,
        total: 4,
        durationMs: 1_200_000,
        submittedAt: '2026-11-21T16:15:00.000Z',
      },
      {
        runId: 'run-oral-1',
        kind: 'oral',
        mode: 'oral',
        title: '[口试] Examiner',
        scope: 'Examiner',
        score: '4/5★',
        assessed: 5,
        strong: 4,
        total: 5,
        duration: '08:20',
        submittedAt: '2026-11-20T09:00:00.000Z',
      },
    ];

    const mdZh = formatExamHistoryMarkdown({
      history: sampleHistory,
      selectedAttempt: sampleHistory[0],
      lang: 'zh',
      generatedAt: '2026-11-22',
    });
    assert.ok(mdZh.includes('# StudyHub 模拟考试历史报告'));
    assert.ok(mdZh.includes('生成日期**: 2026-11-22'));
    assert.ok(mdZh.includes('考试记录总数**: 3'));
    assert.ok(mdZh.includes('平均正确率 / 得分**: 80%'));
    assert.ok(mdZh.includes('## 当前选中记录'));
    assert.ok(mdZh.includes('选择题卷 (written)'));
    assert.ok(mdZh.includes('85%'));
    assert.ok(mdZh.includes('17/20'));
    assert.ok(mdZh.includes('12:30'));
    assert.ok(mdZh.includes('2026-11-22T10:30:00.000Z'));
    assert.ok(mdZh.includes('## 考试历史汇总'));
    assert.ok(mdZh.includes('| # | 日期 | 模式 | 范围 / 标题 | 成绩 / 正确率 | 用时 |'));
    assert.ok(mdZh.includes('Operating Systems \\| Core'), 'pipe characters must be escaped in Markdown table');
    assert.ok(mdZh.includes('案例卷 (case)'));
    assert.ok(mdZh.includes('口试 (oral)'));
    assert.ok(mdZh.includes('08:20'));

    const mdEn = formatExamHistoryMarkdown({
      history: sampleHistory,
      selectedAttempt: sampleHistory[1],
      lang: 'en',
      generatedAt: '2026-11-22',
    });
    assert.ok(mdEn.includes('# StudyHub Exam History Report'));
    assert.ok(mdEn.includes('Generated**: 2026-11-22'));
    assert.ok(mdEn.includes('Total Exam Records**: 3'));
    assert.ok(mdEn.includes('Average Accuracy / Score**: 80%'));
    assert.ok(mdEn.includes('## Selected Attempt'));
    assert.ok(mdEn.includes('Case Paper (case)'));
    assert.ok(mdEn.includes('4/4'));
    assert.ok(mdEn.includes('20:00'));
    assert.ok(mdEn.includes('## Exam Attempts Summary'));
    assert.ok(mdEn.includes('| # | Date | Mode | Scope / Title | Score / Accuracy | Duration |'));

    const mdEmptyZh = formatExamHistoryMarkdown({ history: [], selectedAttempt: null, lang: 'zh', generatedAt: '2026-11-22' });
    assert.ok(mdEmptyZh.includes('# StudyHub 模拟考试历史报告'));
    assert.ok(mdEmptyZh.includes('生成日期**: 2026-11-22'));
    assert.ok(mdEmptyZh.includes('考试记录总数**: 0'));
    assert.ok(mdEmptyZh.includes('平均正确率 / 得分**: -'));
    assert.ok(!mdEmptyZh.includes('## 当前选中记录'));
    assert.ok(mdEmptyZh.includes('暂无模拟考试记录'));

    const mdEmptyEn = formatExamHistoryMarkdown({ history: [], selectedAttempt: null, lang: 'en', generatedAt: '2026-11-22' });
    assert.ok(mdEmptyEn.includes('# StudyHub Exam History Report'));
    assert.ok(mdEmptyEn.includes('Generated**: 2026-11-22'));
    assert.ok(mdEmptyEn.includes('Total Exam Records**: 0'));
    assert.ok(mdEmptyEn.includes('Average Accuracy / Score**: -'));
    assert.ok(!mdEmptyEn.includes('## Selected Attempt'));
    assert.ok(mdEmptyEn.includes('No exam history records'));

    assert.ok(mdZh.includes('run-written-1') || mdZh.includes('17/20'));
    assert.ok(mdZh.includes('4/5★') || mdZh.includes('4/5'));
    assert.ok(mdZh.includes('Clinical Case Deck'));
    assert.ok(mdZh.includes('Examiner'));
    assert.ok(mdEn.includes('Operating Systems \\| Core'));
    assert.ok(mdEn.includes('Written MCQ (written)'));
    assert.ok(mdEn.includes('Oral Mock (oral)'));
    assert.ok(mdEn.includes('12:30'));
    assert.ok(mdEn.includes('08:20'));
    assert.ok(mdEn.includes('85%'));
    assert.ok(mdEn.includes('75%'));
    assert.ok(mdEn.includes('Clinical Case Deck'));
    assert.ok(mdEn.includes('2026-11-21T16:15:00.000Z'));
    assert.ok(mdEn.includes('2026-11-22'));
    assert.ok(mdEn.includes('Examiner'));
  });

  test('2) PTY E2E (120x36 zh): Exam [5] empty toast -> seed completed exam -> [x] writes studyhub-exam-*.md (0 model calls)', async () => {
    fetchCalls = 0;
    const backupsDir = join(libraryRoot, 'backups');
    const todayYmd = todayLocalYmd();
    await rm(backupsDir, { recursive: true, force: true });

    const tty = await mountApp({ initialPage: 'library', asciiMode: false, language: 'zh', cols: 120, rows: 36 });
    await tty.waitFor((s) => s.includes('Memento') || s.includes('学习库'), {
      timeoutMs: 10_000,
      label: 'Initial Library view loaded (zh)',
    });

    // Navigate to Exam ('5') while library has 0 exam records
    tty.send('5');
    const examEmptyScreen = await tty.waitFor(
      (s) => s.includes('组卷设置') && s.includes('历史考卷') && s.includes('导出记录') && s.includes('暂无考试记录'),
      { timeoutMs: 8_000, label: 'ExamSetup rendered at 120x36 (zh) empty' },
    );
    tty.assertHealthyScreen(examEmptyScreen, 120, 36, 'ExamSetup initial empty zh 120x36');

    // Empty history export -> friendly info toast, no file written
    tty.send('x');
    const emptyToastScreen = await tty.waitFor(
      (s) => s.includes('暂无可导出的模拟考试记录'),
      { timeoutMs: 5_000, label: 'ExamSetup [x] empty warning toast (zh)' },
    );
    tty.assertHealthyScreen(emptyToastScreen, 120, 36, 'ExamSetup empty export toast zh 120x36');
    assert.equal(await findExportedBackupFile(backupsDir, 'studyhub-exam', 'md', todayYmd), null, 'empty history must not create report file');

    // Seed a fast quiz deck + 2 completed written exam attempts through StudyRuntime host (0 model calls)
    const deckRes = await host.call('deck.import', {
      folder: 'Exam',
      text: JSON.stringify({
        title: 'Mock Exam Deck',
        course: 'Systems',
        cards: [
          {
            kind: 'quiz',
            topic: 'Paging',
            prompt: 'Which structure caches virtual-to-physical page translations?',
            answer: 'TLB',
            options: [
              { id: 'a', text: 'TLB', correct: true },
              { id: 'b', text: 'ALU', correct: false },
            ],
          },
          {
            kind: 'quiz',
            topic: 'Scheduling',
            prompt: 'Which scheduling algorithm avoids starvation via aging?',
            answer: 'Priority with aging',
            options: [
              { id: 'a', text: 'Priority with aging', correct: true },
              { id: 'b', text: 'LIFO', correct: false },
            ],
          },
        ],
      }),
    });
    assert.equal(deckRes.ok, true, `deck.import failed: ${deckRes.error?.message}`);
    const eligibleDeckId = deckRes.value?.results?.[0]?.deckId;
    assert.ok(eligibleDeckId, 'imported exam deck must return deckId');

    for (let i = 0; i < 2; i += 1) {
      const startRes = await host.call('review.start', {
        mode: 'exam',
        examKinds: 'all',
        count: 2,
        limitMinutes: 15,
        scope: [{ deckId: eligibleDeckId }],
        fresh: true,
      });
      assert.equal(startRes.ok, true, `review.start exam failed: ${startRes.error?.message}`);
      const run = startRes.value;
      if (run.card?.id && Array.isArray(run.card.options) && run.card.options.length > 0) {
        const ansRes = await host.call('review.answer', {
          runId: run.id,
          cardId: run.card.id,
          selected: [run.card.options[0].id],
        });
        assert.equal(ansRes.ok, true, `review.answer failed: ${ansRes.error?.message}`);
      }
      const submitRes = await host.call('exam.submit', { runId: run.id });
      assert.equal(submitRes.ok, true, `exam.submit failed: ${submitRes.error?.message}`);
    }
    await host.refreshSnapshot();

    // Wait for Past Exams panel in ExamSetup to reflect the submitted attempts
    const seededScreen = await tty.waitFor(
      (s) => s.includes('选择题卷') && s.includes('%') && !s.includes('暂无考试记录'),
      { timeoutMs: 8_000, label: 'ExamSetup history updated after exam.submit (zh)' },
    );
    tty.assertHealthyScreen(seededScreen, 120, 36, 'ExamSetup with seeded history zh 120x36');

    // Press 'x' to export atomic Markdown report
    tty.send('x');
    const exportedScreen = await tty.waitFor(
      (s) => s.includes('已导出') && s.includes('条模考记录'),
      { timeoutMs: 8_000, label: 'ExamSetup [x] export success toast (zh)' },
    );
    tty.assertHealthyScreen(exportedScreen, 120, 36, 'ExamSetup after [x] export zh 120x36');

    const zhExamExport = await findExportedBackupFile(backupsDir, 'studyhub-exam', 'md', todayYmd);
    assert.ok(zhExamExport, `expected studyhub-exam-${todayYmd}-HHmmss.md in ${backupsDir}`);
    const mdContent = await readFile(zhExamExport.path, 'utf8');
    assert.ok(mdContent.includes('# StudyHub 模拟考试历史报告'), 'exported report has zh title');
    assert.ok(mdContent.includes('考试记录总数**: 2'), 'exported report has record count');
    assert.ok(mdContent.includes('## 当前选中记录'), 'exported report has selected attempt section');
    assert.ok(mdContent.includes('## 考试历史汇总'), 'exported report has summary table');
    assert.ok(mdContent.includes('| # | 日期 | 模式 | 范围 / 标题 | 成绩 / 正确率 | 用时 |'));
    assert.match(mdContent, /\d+%/, 'exported report contains score percentage');

    // Switch in-place to 80x24 --ascii en on same mounted app
    await rm(backupsDir, { recursive: true, force: true });
    tty.resize(80, 24);
    host.setLanguage('en');
    useDistTuiStore.getState().setPreferences({ language: 'en', asciiMode: true });
    useDistTuiStore.setState({ toasts: [] });

    const examScreenEn = await tty.waitFor(
      (s) => s.includes('Exam Setup') && s.includes('History') && s.includes('1:Written MCQ') && s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'ExamSetup rendered at 80x24 (en --ascii)' },
    );
    tty.assertHealthyScreen(examScreenEn, 80, 24, 'ExamSetup initial en ascii 80x24');
    tty.assertAsciiPure(examScreenEn, 'ExamSetup initial en ascii 80x24 pure');

    tty.send('x');
    const exportedScreenEn = await tty.waitFor(
      (s) => s.includes('Exported 2 exam'),
      { timeoutMs: 8_000, label: 'ExamSetup [x] showed ASCII-safe export toast (en --ascii 80x24)' },
    );
    tty.assertHealthyScreen(exportedScreenEn, 80, 24, 'ExamSetup after [x] export en ascii 80x24');
    tty.assertAsciiPure(exportedScreenEn, 'ExamSetup after [x] export en ascii 80x24 pure');

    const enExamExport = await findExportedBackupFile(backupsDir, 'studyhub-exam', 'md', todayYmd);
    assert.ok(enExamExport, `expected studyhub-exam-${todayYmd}-HHmmss.md in ${backupsDir}`);
    const mdContentEn = await readFile(enExamExport.path, 'utf8');
    assert.ok(mdContentEn.includes('# StudyHub Exam History Report'), 'exported report has en title');
    assert.ok(mdContentEn.includes('Total Exam Records**: 2'), 'exported report has en count');
    assert.ok(mdContentEn.includes('## Selected Attempt'), 'exported report has selected attempt section');
    assert.ok(mdContentEn.includes('## Exam Attempts Summary'), 'exported report has summary table');
    assert.ok(mdContentEn.includes('| # | Date | Mode | Scope / Title | Score / Accuracy | Duration |'));
    assert.match(mdContentEn, /\d+%/, 'exported report contains score percentage');
    assert.equal(fetchCalls, 0, 'ExamSetup [x] export must make 0 model/network calls');
  });
});
