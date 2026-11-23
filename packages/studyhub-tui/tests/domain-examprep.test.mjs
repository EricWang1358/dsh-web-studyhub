// Consolidated ExamPrep Domain Suite
// Merges: round45-focus-suggest, round68-examprep-export
// node --test tests/domain-examprep.test.mjs
import assert from 'node:assert/strict';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { render } from 'ink';
import React from 'react';
import { tsImport } from 'tsx/esm/api';
import {
  cloneSampleLibrary,
  createTempTracker,
  createVirtualTty,
  disposeTerminalPool,
  distDir,
  findExportedBackupFile,
  loadDistRuntime,
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

const { formatExamPrepMarkdown } = await tsImport(
  '../src/views/examprep/ExamPrepView.tsx',
  import.meta.url,
);
assert.equal(typeof formatExamPrepMarkdown, 'function', 'ExamPrepView must export formatExamPrepMarkdown');

const PREV_DSH_HOME = process.env.DSH_HOME;
const ORIGINAL_FETCH = globalThis.fetch;
const temps = createTempTracker('studyhub-tui-examprep-');

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

function todayLocalYmd(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function getSampleDeckTopics(host) {
  const deckRes = await host.call('deck.get', { id: 'sample-deck-patterns' });
  assert.equal(deckRes.ok, true, `deck.get(sample-deck-patterns) failed: ${deckRes.error?.message || ''}`);
  const cards = deckRes.value?.cards ?? [];
  const topics = [...new Set(cards.map((c) => c.topic).filter(Boolean))];
  assert.ok(topics.length >= 2, `Expected at least 2 distinct topics in sample deck, got ${topics.length}`);
  return { cards, topics };
}

describe('Round 45: AddFocusModal AI Focus Topic Matching (focus.suggest + P2 ConfirmDialog)', () => {
  test('1) createTuiHost integration: focus.suggest filters out invented topics to existing deck topics only & handles no-model rules fallback', async () => {
    const base = await temps.make('r45-host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');
    await cloneSampleLibrary('en', libraryRoot);

    const observed = [];
    let modelCalls = 0;

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'en',
      injectedComplete: async (system, prompt) => {
        modelCalls += 1;
        const parsed = JSON.parse(String(prompt));
        observed.push({ system, parsed });
        const available = Array.isArray(parsed.availableTopics) ? parsed.availableTopics : [];
        return JSON.stringify({
          role: 'Staff Systems Architect',
          targetTopics: [
            available[0],
            'Invented Ghost Topic Not In Decks',
            available[1],
            'Another Hallucinated Topic',
          ],
        });
      },
    });

    try {
      const initSnap = await host.call('snapshot', {});
      assert.equal(initSnap.ok, true, `snapshot failed: ${initSnap.error?.message || ''}`);
      const { cards: beforeCards, topics: deckTopics } = await getSampleDeckTopics(host);

      const res = await host.call('focus.suggest', {
        role: 'Backend Architect',
        jd: 'Decouple state snapshots and abstraction hierarchies.',
      });
      assert.equal(res.ok, true, `focus.suggest failed: ${res.error?.message || ''}`);
      assert.equal(modelCalls, 1, 'focus.suggest must invoke model once');
      assert.equal(typeof observed[0]?.system, 'string');
      assert.ok(observed[0].system.length > 0, 'System prompt must be non-empty');
      assert.equal(res.value?.method, 'ai');
      assert.equal(res.value?.role, 'Staff Systems Architect');
      assert.equal(res.value?.jd, 'Decouple state snapshots and abstraction hierarchies.');
      assert.deepEqual(
        res.value?.targetTopics,
        [deckTopics[0], deckTopics[1]],
        'Backend must filter out invented topics and keep only existing deck topics',
      );
      assert.ok(
        !res.value?.targetTopics?.includes('Invented Ghost Topic Not In Decks'),
        'Invented topic must be excluded',
      );
      assert.ok(
        observed[0]?.parsed?.availableTopics?.includes(deckTopics[0]),
        'Prompt must pass existing deck topics as availableTopics',
      );

      // Verify study cards were not modified
      const { cards: afterCards } = await getSampleDeckTopics(host);
      assert.equal(afterCards.length, beforeCards.length, 'focus.suggest must never alter card count');
      assert.deepEqual(
        afterCards.map((c) => c.topic),
        beforeCards.map((c) => c.topic),
        'focus.suggest must never alter card topics',
      );
    } finally {
      await host.dispose();
    }

    // No-model host -> clean rules fallback with 0 AI calls
    const baseNoModel = await temps.make('r45-host-nomodel');
    const hostNoModel = await createTuiHost({
      libraryRoot: join(baseNoModel, 'library'),
      env: { DSH_HOME: join(baseNoModel, 'dsh-home') },
      home: baseNoModel,
      documentsDir: baseNoModel,
      skipAutoProbe: true,
      language: 'en',
      injectedComplete: null,
    });
    try {
      const res = await hostNoModel.call('focus.suggest', { role: 'Frontend Engineer', jd: 'React' });
      assert.equal(res.ok, true, 'focus.suggest without model returns structured rules fallback');
      assert.equal(res.value?.method, 'rules');
      assert.deepEqual(res.value?.targetTopics, []);
    } finally {
      await hostNoModel.dispose();
    }
  });

  test('2) PTY E2E: AddFocusModal AI Match (Ctrl+T/Ctrl+G -> P2 ConfirmDialog -> cancel n/Esc -> confirm y) at 120x36 & 80x24', async () => {
    const baseZh = await temps.make('r45-pty-zh');
    const envZh = { DSH_HOME: join(baseZh, 'dsh-home') };
    process.env.DSH_HOME = envZh.DSH_HOME;

    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env: envZh });
    resetDistStore('zh', false, { loading: true });

    let zhModelCalls = 0;
    let releaseZh = null;
    let gateZh = null;
    let pickedZhTopics = [];

    const libraryRootZh = join(baseZh, 'library');
    await cloneSampleLibrary('zh', libraryRootZh);

    const hostZh = await createTuiHost({
      libraryRoot: libraryRootZh,
      env: envZh,
      home: baseZh,
      documentsDir: baseZh,
      skipAutoProbe: true,
      language: 'zh',
      injectedComplete: async (_system, prompt) => {
        zhModelCalls += 1;
        if (gateZh) await gateZh;
        const parsed = JSON.parse(String(prompt));
        const available = Array.isArray(parsed.availableTopics) ? parsed.availableTopics : [];
        pickedZhTopics = available.slice(0, 2);
        return JSON.stringify({
          role: parsed.role,
          targetTopics: [...pickedZhTopics, '虚构不存在考点'],
        });
      },
    });

    const snapZh = await hostZh.call('snapshot', {});
    assert.equal(snapZh.ok, true, `zh snapshot failed: ${snapZh.error?.message || ''}`);
    const { topics: zhDeckTopics } = await getSampleDeckTopics(hostZh);
    const zhTargetTopics = zhDeckTopics.slice(0, 2);

    const ttyZh = createVirtualTty(120, 36);
    let inkInstance = null;
    try {
      inkInstance = render(React.createElement(StudyHubTuiApp, { host: hostZh, asciiMode: false }), {
        stdin: ttyZh.stdin,
        stdout: ttyZh.stdout,
        stderr: ttyZh.stderr,
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await ttyZh.firstFramePromise;

      await ttyZh.waitFor(() => useDistTuiStore.getState().page === 'library' && Boolean(useDistTuiStore.getState().snapshot), {
        label: 'zh LibraryView ready',
      });

      // Navigate to ExamPrepView ('0')
      ttyZh.send('0');
      const prepInit = await ttyZh.waitFor(
        (s) =>
          useDistTuiStore.getState().page === 'examprep' &&
          s.includes('备考补习') &&
          s.includes('1:考纲重点进度') &&
          !s.includes('正在加载备考重点'),
        { label: 'zh ExamPrepView ready' },
      );
      ttyZh.assertHealthyScreen(prepInit, 120, 36, 'zh ExamPrepView initial');
      assert.equal(zhModelCalls, 0, 'Entering ExamPrepView must make 0 AI calls');

      // Press 'a' to open AddFocusModal
      ttyZh.send('a');
      const modalOpen = await ttyZh.waitFor(
        (s) => s.includes('添加考纲重点') && s.includes('3: AI匹配题库'),
        { label: 'zh AddFocusModal open' },
      );
      ttyZh.assertHealthyScreen(modalOpen, 120, 36, 'zh AddFocusModal initial');
      assert.equal(zhModelCalls, 0, 'Opening AddFocusModal must make 0 AI calls');

      // Switch to AI Match mode using Ctrl+T twice (text -> image -> suggest)
      ttyZh.send('\u0014');
      await ttyZh.waitFor((s) => s.includes('本地截图 / 文件路径'), { label: 'zh AddFocusModal image mode' });
      ttyZh.send('\u0014');
      const suggestModeZh = await ttyZh.waitFor(
        (s) => s.includes('目标岗位方向') && s.includes('岗位描述 / JD 关键词'),
        { label: 'zh AddFocusModal suggest mode' },
      );
      ttyZh.assertHealthyScreen(suggestModeZh, 120, 36, 'zh AddFocusModal suggest mode 120x36');
      assert.equal(zhModelCalls, 0, 'Switching to suggest mode must make 0 AI calls');

      // Type target role & Tab -> JD
      ttyZh.send('架构师');
      await ttyZh.waitFor((s) => s.includes('架构师'), { label: 'zh role typed' });
      await ttyZh.flush(20);
      ttyZh.send('\t');
      await ttyZh.flush(20);
      ttyZh.send('设计模式');
      await ttyZh.waitFor((s) => s.includes('设计模式'), { label: 'zh jd typed' });
      await ttyZh.flush(20);
      assert.equal(zhModelCalls, 0, 'Typing role/JD must make 0 AI calls');

      // Trigger focus.suggest with Ctrl+E -> P2 ConfirmDialog must open with 0 AI calls
      ttyZh.send('\u0005');
      const zhConfirm1 = await ttyZh.waitFor(
        (s) =>
          s.includes('确认 AI 匹配题库重点') &&
          s.includes('1 次轻量 AI 调用') &&
          s.includes('绝不修改任何题目'),
        { label: 'zh ConfirmDialog open after Ctrl+E' },
      );
      ttyZh.assertHealthyScreen(zhConfirm1, 120, 36, 'zh ConfirmDialog 120x36');
      assert.equal(zhModelCalls, 0, 'P2 guard: 0 AI calls before ConfirmDialog confirm');

      // Cancel with 'n' -> 0 AI calls
      ttyZh.send('n');
      await ttyZh.waitFor(
        (s) => s.includes('目标岗位方向') && !s.includes('确认 AI 匹配题库重点'),
        { label: 'zh ConfirmDialog cancelled with n' },
      );
      assert.equal(zhModelCalls, 0, 'Cancelling with n must keep AI calls at 0');

      // Reopen with Ctrl+G and cancel with Esc -> 0 AI calls
      ttyZh.send('\u0007');
      await ttyZh.waitFor((s) => s.includes('确认 AI 匹配题库重点'), { label: 'zh ConfirmDialog reopened via Ctrl+G' });
      ttyZh.send('\u001b');
      await ttyZh.waitFor(
        (s) => s.includes('目标岗位方向') && !s.includes('确认 AI 匹配题库重点'),
        { label: 'zh ConfirmDialog cancelled with Esc' },
      );
      assert.equal(zhModelCalls, 0, 'Cancelling with Esc must keep AI calls at 0');

      // Trigger again and confirm with 'y' (gated to verify busyRef blocks duplicate triggers)
      gateZh = new Promise((resolveFn) => {
        releaseZh = resolveFn;
      });
      ttyZh.send('\u0005');
      await ttyZh.waitFor((s) => s.includes('确认 AI 匹配题库重点'), { label: 'zh ConfirmDialog before gated y' });
      ttyZh.send('y');
      await ttyZh.waitFor((s) => s.includes('正在匹配题库重点'), { label: 'zh busy spinner during focus.suggest' });
      ttyZh.send('\u0005');
      ttyZh.send('\u0007');
      await ttyZh.flush();
      assert.equal(zhModelCalls, 1, 'busyRef must prevent duplicate AI calls while matching');

      releaseZh();
      gateZh = null;

      // Verify AI badge and matched topics populate at 120x36 (and invented topic is filtered out)
      const zhMatchedWide = await ttyZh.waitFor(
        (s) =>
          s.includes('匹配 2 个现有知识点') &&
          s.includes(zhTargetTopics[0]) &&
          s.includes(zhTargetTopics[1]) &&
          s.includes('AI 匹配到 2 个现有知识点'),
        { label: 'zh matched topics rendered at 120x36' },
      );
      ttyZh.assertHealthyScreen(zhMatchedWide, 120, 36, 'zh matched topics 120x36');
      assert.ok(!zhMatchedWide.includes('虚构不存在考点'), 'Invented topic must not appear in matched UI');
      assert.equal(zhModelCalls, 1);

      // Resize to 80x24 and verify healthy layout
      ttyZh.resize(80, 24);
      const zhMatchedNarrow = await ttyZh.waitFor(
        (s) => s.includes('匹配 2 个现有知识点') && s.includes(zhTargetTopics[0]) && s.split('\n').length <= 24,
        { label: 'zh matched topics rendered at 80x24' },
      );
      ttyZh.assertHealthyScreen(zhMatchedNarrow, 80, 24, 'zh matched topics 80x24');

      // Save merged topics to course with Ctrl+S
      useDistTuiStore.setState({ toasts: [] });
      ttyZh.send('\u0013');
      const zhAfterSave = await ttyZh.waitFor(
        (s) =>
          !s.includes('添加考纲重点') &&
          s.includes('1:考纲重点进度') &&
          useDistTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已保存')),
        { label: 'zh Ctrl+S saves matched focus topics to course' },
      );
      ttyZh.assertHealthyScreen(zhAfterSave, 80, 24, 'zh ExamPrepView after save 80x24');

      ttyZh.resize(120, 36);
      const zhPrepUpdated = await ttyZh.waitFor(
        (s) => s.includes(zhTargetTopics[0]),
        { label: 'zh saved topic visible in ExamPrepView at 120x36' },
      );
      ttyZh.assertHealthyScreen(zhPrepUpdated, 120, 36, 'zh ExamPrepView after save 120x36');
      assert.ok(zhPrepUpdated.includes(zhTargetTopics[1]), 'Second saved topic must appear in ExamPrepView');
      const afterSaveSnap = await hostZh.call('snapshot', {});
      assert.equal(afterSaveSnap.ok, true);
      const savedFocus = afterSaveSnap.value?.courses?.[0]?.focusTopics ?? [];
      assert.equal(savedFocus.length >= 2, true, 'Course focusTopics must contain at least 2 saved topics');
      assert.ok(savedFocus.includes(zhTargetTopics[0]), 'Course focusTopics must persist first matched topic');
      assert.ok(savedFocus.includes(zhTargetTopics[1]), 'Course focusTopics must persist second matched topic');
      assert.equal(useDistTuiStore.getState().lastError ?? null, null);
      assert.equal(zhModelCalls, 1, 'Total AI calls across entire AddFocusModal flow must remain 1');
    } finally {
      inkInstance?.unmount();
      inkInstance = null;
      ttyZh.dispose();
      await hostZh.dispose();
    }
  });
});

describe('Round 68 Track 2: ExamPrepView `/` live filter & `[x]` atomic Markdown export', () => {
  test('1. Pure unit test: formatExamPrepMarkdown (zh & en, topics table, crunch checklist, notes, empty state)', () => {
    const sampleTopics = [
      {
        topic: 'Virtual Memory | Paging',
        cards: 10,
        counts: { new: 1, weak: 2, learning: 1, familiar: 2, mastered: 4 },
        mastery: 0.65,
        status: 'weak',
        weakCards: [
          { deckId: 'd1', cardId: 'c1' },
          { deckId: 'd1', cardId: 'c2' },
        ],
      },
      {
        topic: 'CPU Scheduling',
        cards: 6,
        counts: { mastered: 6 },
        mastery: 1,
        status: 'done',
        weakCards: [],
      },
      {
        topic: 'Deadlock Avoidance',
        cards: 4,
        counts: { new: 4 },
        mastery: 0.1,
        status: 'todo',
        weakCards: [],
      },
      {
        topic: 'File Systems',
        cards: 0,
        counts: {},
        mastery: 0,
        status: 'none',
        weakCards: [],
      },
    ];

    const sampleCrunch = [
      { id: 'pt-1', title: 'Page Replacement Algorithms', questions: 5, weak: 1, done: '2026-11-22' },
      { id: 'pt-2', title: 'Banker Algorithm', questions: 3, weak: 0, seen: '2026-11-22', done: null },
    ];

    const zhMd = formatExamPrepMarkdown({
      course: 'OS301',
      examDate: '2026-12-18',
      topics: sampleTopics,
      crunchPoints: sampleCrunch,
      planNotes: 'Prioritize weak paging cards before mock exam.',
      lang: 'zh',
      generatedAt: '2026-11-22 14:00',
    });

    assert.ok(zhMd.includes('# StudyHub 备考计划与重点进度'));
    assert.ok(zhMd.includes('生成日期**: 2026-11-22 14:00'));
    assert.ok(zhMd.includes('课程**: OS301'));
    assert.ok(zhMd.includes('考试日期**: 2026-12-18'));
    assert.ok(zhMd.includes('共 4 项 (已掌握 1 / 薄弱 1 / 待学 1 / 缺题 1)'));
    assert.ok(zhMd.includes('| 重点主题 | 状态 | 掌握率 | 题数 | 薄弱题 |'));
    assert.ok(zhMd.includes('| Virtual Memory \\| Paging | 薄弱 | 65% | 10 | 2 |'));
    assert.ok(zhMd.includes('| CPU Scheduling | 已掌握 | 100% | 6 | 0 |'));
    assert.ok(zhMd.includes('| Deadlock Avoidance |'), 'zh Deadlock Avoidance row');
    assert.ok(zhMd.includes('| File Systems | 暂无题 | - | 0 | 0 |'));
    assert.ok(zhMd.includes('## 期末冲刺清单'));
    assert.ok(zhMd.includes('- [x] Page Replacement Algorithms (5题, 1错)'));
    assert.ok(zhMd.includes('- [ ] Banker Algorithm (3题, 已翻看)'));
    assert.ok(zhMd.includes('## 备考计划备注'));
    assert.ok(zhMd.includes('Prioritize weak paging cards before mock exam.'));

    const enMd = formatExamPrepMarkdown({
      course: 'OS301',
      examDate: '2026-12-18',
      topics: sampleTopics,
      crunchPoints: sampleCrunch,
      planNotes: 'Daily 30m drill.',
      lang: 'en',
      generatedAt: new Date('2026-11-22T14:00:00Z'),
    });

    assert.ok(enMd.includes('# StudyHub Exam Prep Plan & Focus Progress'));
    assert.ok(enMd.includes('Course**: OS301'));
    assert.ok(enMd.includes('Exam Date**: 2026-12-18'));
    assert.ok(enMd.includes('4 total (Done 1 / Weak 1 / Todo 1 / None 1)'));
    assert.ok(enMd.includes('| Topic | Status | Mastery | Cards | Weak |'));
    assert.ok(enMd.includes('| Virtual Memory \\| Paging | Weak | 65% | 10 | 2 |'));
    assert.ok(enMd.includes('| CPU Scheduling | Mastered | 100% | 6 | 0 |'));
    assert.ok(enMd.includes('| Deadlock Avoidance |'), 'en Deadlock Avoidance row');
    assert.ok(enMd.includes('| File Systems | No Qs | - | 0 | 0 |'));
    assert.ok(enMd.includes('## Focus Topics'));
    assert.ok(enMd.includes('## Final-Week Crunch'));
    assert.ok(enMd.includes('- [x] Page Replacement Algorithms (5 Q, 1 weak)'));
    assert.ok(enMd.includes('- [ ] Banker Algorithm (3 Q, seen)'));
    assert.ok(enMd.includes('## Study Plan Notes'));
    assert.ok(enMd.includes('Daily 30m drill.'));

    const emptyEn = formatExamPrepMarkdown({
      course: '',
      topics: [],
      crunchPoints: [],
      lang: 'en',
      generatedAt: '2026-11-22',
    });
    assert.ok(emptyEn.includes('Course**: All Courses'));
    assert.ok(!emptyEn.includes('Exam Date**:'));
    assert.ok(emptyEn.includes('0 total (Done 0 / Weak 0 / Todo 0 / None 0)'));
    assert.ok(emptyEn.includes('_No focus topics yet._'));
    assert.ok(!emptyEn.includes('## Final-Week Crunch'));
    assert.ok(!emptyEn.includes('## Study Plan Notes'));

    const emptyZh = formatExamPrepMarkdown({
      course: '',
      topics: [],
      crunchPoints: [],
      lang: 'zh',
      generatedAt: '2026-11-22',
    });
    assert.ok(emptyZh.includes('# StudyHub 备考计划与重点进度'));
    assert.ok(emptyZh.includes('全部课程'));
    assert.ok(!emptyZh.includes('考试日期**:'));
    assert.ok(emptyZh.includes('共 0 项 (已掌握 0 / 薄弱 0 / 待学 0 / 缺题 0)'));
    assert.ok(emptyZh.includes('_暂无考纲重点条目。_'));
    assert.ok(!emptyZh.includes('## 期末冲刺清单'));
    assert.ok(!emptyZh.includes('## 备考计划备注'));
  });

  test('2. @xterm/headless PTY E2E (120x36 & 80x24 zh): empty [x] -> seed 2 focus topics -> [r] -> / filter -> Enter -> x export -> Esc clear (0 model calls)', async () => {
    const box = await temps.make('r68-e2e-zh');
    const dshHome = join(box, 'dsh-home');
    const libraryRoot = join(box, 'library');
    await cloneSampleLibrary('zh', libraryRoot);
    process.env.DSH_HOME = dshHome;

    let fetchCalls = 0;
    let llmCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error('Unexpected global fetch call');
    };

    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env: { DSH_HOME: dshHome } });
    const host = await createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(box, 'home'),
      libraryRoot,
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 25,
      fetch: async () => {
        fetchCalls += 1;
        throw new Error('Unexpected host fetch call');
      },
    });
    host.streamComplete = async () => {
      llmCalls += 1;
      throw new Error('Unexpected streamComplete call');
    };

    const tty = createVirtualTty(120, 36);
    let inst = null;
    try {
      const snapRes = await host.call('snapshot', {});
      assert.equal(snapRes.ok, true, `snapshot failed: ${snapRes.error?.message}`);
      assert.ok((snapRes.value?.decks?.length ?? 0) > 0, 'cloned sample library must contain decks');
      const activeCourse =
        snapRes.value?.focus?.course ||
        snapRes.value?.courses?.[0]?.name ||
        snapRes.value?.decks?.find((d) => !d.archived && d.course)?.course;
      assert.ok(activeCourse, 'sample course must exist');

      // Start with empty focusTopics to verify empty-state [x] guard first
      const clearRes = await host.call('course.save', {
        name: activeCourse,
        focusTopics: [],
      });
      assert.equal(clearRes.ok, true, `course.save clear failed: ${clearRes.error?.message}`);
      await host.refreshSnapshot();

      resetDistStore('zh', false, {
        preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: false, sidebarCollapsed: false, showKeyHints: true },
      });

      inst = render(
        React.createElement(StudyHubTuiApp, {
          host,
          autoLaunchpad: false,
          onExit: () => inst?.unmount(),
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
      await tty.waitFor((s) => !s.includes('正在打开学习库'), { label: 'LibraryView ready (zh)' });

      // Navigate to ExamPrep ('0') -> empty state [x] shows friendly info toast and writes no file
      const backupsDir = join(libraryRoot, 'backups');
      const todayYmd = todayLocalYmd();
      await rm(backupsDir, { recursive: true, force: true });
      useDistTuiStore.setState({ toasts: [] });
      tty.send('0');
      const emptyPrep = await tty.waitFor(
        (s) => useDistTuiStore.getState().page === 'examprep' && s.includes('尚未添加本课程考纲重点'),
        { label: 'ExamPrepView empty state ready (zh)' },
      );
      tty.assertHealthyScreen(emptyPrep, 120, 36, 'ExamPrepView 120x36 empty zh');
      tty.send('x');
      const emptyToast = await tty.waitFor(
        () =>
          useDistTuiStore
            .getState()
            .toasts.some((toast) => toast.tone === 'info' && toast.text.includes('当前暂无可导出的备考重点或冲刺清单')),
        { label: 'ExamPrep empty export info toast (zh)' },
      );
      tty.assertHealthyScreen(emptyToast, 120, 36, 'ExamPrepView empty export toast');
      assert.equal(useDistTuiStore.getState().page, 'examprep');
      assert.equal(await findExportedBackupFile(backupsDir, 'studyhub-examprep', 'md', todayYmd), null, 'empty exam prep must not write markdown file');

      // Seed 2 focus topics & reload ExamPrep via 'r'
      const saveRes = await host.call('course.save', {
        name: activeCourse,
        exam: { date: '2026-12-20' },
        plan: { version: 1, notes: '先刷薄弱考点，再做模拟卷。' },
        focusTopics: ['进程调度与死锁', '虚拟内存分页'],
      });
      assert.equal(saveRes.ok, true, `course.save failed: ${saveRes.error?.message}`);
      await host.refreshSnapshot();
      tty.send('r');

      const initialScreen = await tty.waitFor(
        (s) => {
          const hints = useDistTuiStore.getState().footerHints;
          return (
            useDistTuiStore.getState().page === 'examprep' &&
            s.includes('进程调度与死锁') &&
            s.includes('虚拟内存分页') &&
            hints.some((h) => h.key === '/' && h.label === '筛选') &&
            hints.some((h) => h.key === 'x' && h.label === '导出MD')
          );
        },
        { label: 'ExamPrepView rendered with seeded focus topics (zh)' },
      );
      const hintKeys = useDistTuiStore.getState().footerHints.map((h) => h.key);
      assert.ok(hintKeys.indexOf('/') > hintKeys.indexOf('d'), '`/` hint must appear after existing hints');
      assert.ok(hintKeys.indexOf('x') > hintKeys.indexOf('/'), '`x` hint must appear after `/` hint');
      tty.assertHealthyScreen(initialScreen, 120, 36, 'ExamPrepView initial 120x36 zh');

      // Press `/` to open live filter bar and filter to '虚拟内存'
      tty.send('/');
      await tty.waitFor((s) => s.includes('[筛选 2/2]'), { label: 'ExamPrep filter bar opened' });
      tty.send('虚拟内存');
      const filteredEditing = await tty.waitFor(
        (s) =>
          s.includes('[筛选 1/2]') &&
          s.includes('虚拟内存分页') &&
          !s.includes('进程调度与死锁'),
        { label: 'Filter narrowed focus topics to 虚拟内存分页' },
      );
      tty.assertHealthyScreen(filteredEditing, 120, 36, 'ExamPrepView filter editing');

      // Enter confirms filter keeping filter active
      tty.send('\r');
      const filteredConfirmed = await tty.waitFor(
        (s) => s.includes('[已筛选 1/2]') && s.includes('虚拟内存分页') && !s.includes('进程调度与死锁'),
        { label: 'Enter confirmed ExamPrep filter bar' },
      );
      tty.assertHealthyScreen(filteredConfirmed, 120, 36, 'ExamPrepView filter confirmed');

      // Press `d` to verify clamped selection targets exact filtered topic (`虚拟内存分页`), then Esc to cancel dialog
      tty.send('d');
      const confirmDeleteScreen = await tty.waitFor(
        (s) => s.includes('移除重点条目') && s.includes('虚拟内存分页'),
        { label: 'Delete confirm dialog targets filtered topic 虚拟内存分页' },
      );
      tty.assertHealthyScreen(confirmDeleteScreen, 120, 36, 'ExamPrepView confirm delete on filtered topic');
      tty.send('\u001b');
      await tty.waitFor((s) => !s.includes('移除重点条目') && s.includes('[已筛选 1/2]'), {
        label: 'Delete confirm dialog cancelled with Esc',
      });

      // Resize to 80x24 and press `x` to export Markdown atomically
      tty.resize(80, 24);
      const narrowFiltered = await tty.waitFor(
        (s) => s.includes('[已筛选 1/2]') && s.includes('虚拟内存分页') && s.split('\n').length <= 24,
        { label: 'ExamPrepView 80x24 filtered (zh)' },
      );
      tty.assertHealthyScreen(narrowFiltered, 80, 24, 'ExamPrepView 80x24 filtered zh');

      useDistTuiStore.setState({ toasts: [] });
      tty.send('x');
      const exportToastScreen = await tty.waitFor(
        (s) =>
          s.includes('已导出 2 项重点') &&
          useDistTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已导出 2 项重点')),
        { label: 'ExamPrep Markdown export toast (zh)' },
      );
      tty.assertHealthyScreen(exportToastScreen, 80, 24, 'ExamPrepView after export 80x24');

      const prepExport = await findExportedBackupFile(backupsDir, 'studyhub-examprep', 'md', todayYmd);
      assert.ok(prepExport, `studyhub-examprep-${todayYmd}-HHmmss.md must exist on disk`);
      const exportedMd = await readFile(prepExport.path, 'utf8');
      assert.ok(exportedMd.includes('# StudyHub 备考计划与重点进度'));
      assert.ok(exportedMd.includes(`课程**: ${activeCourse}`));
      assert.ok(exportedMd.includes('考试日期**: 2026-12-20'));
      assert.ok(exportedMd.includes('进程调度与死锁'));
      assert.ok(exportedMd.includes('虚拟内存分页'));
      assert.ok(exportedMd.includes('先刷薄弱考点，再做模拟卷。'));
      assert.ok(exportedMd.includes('## 备考计划备注'));
      assert.ok(exportedMd.includes('| 重点主题 | 状态 | 掌握率 | 题数 | 薄弱题 |'));
      assert.ok(exportedMd.includes('共 2 项'));
      assert.ok(exportedMd.includes('| 进程调度与死锁 |'));
      assert.ok(exportedMd.includes('| 虚拟内存分页 |'));

      // Press `Esc` in normal mode to clear active filter
      tty.send('\u001b');
      const clearedScreen = await tty.waitFor(
        (s) => !s.includes('[已筛选') && s.includes('进程调度与死锁') && s.includes('虚拟内存分页'),
        { label: 'Esc cleared active filter cleanly' },
      );
      assert.equal(useDistTuiStore.getState().page, 'examprep');
      assert.equal(useDistTuiStore.getState().inputCaptured, false);
      assert.equal(useDistTuiStore.getState().lastError ?? null, null);
      tty.assertHealthyScreen(clearedScreen, 80, 24, 'ExamPrepView filter cleared 80x24');
      assert.equal(llmCalls, 0, 'ExamPrep filter & export must make 0 LLM calls');
      assert.equal(fetchCalls, 0, 'ExamPrep filter & export must make 0 network fetch calls');
    } finally {
      globalThis.fetch = ORIGINAL_FETCH;
      try {
        inst?.unmount();
      } catch {
        // Ignore unmount error
      }
      tty.dispose();
      await host.dispose();
    }
  });
});
