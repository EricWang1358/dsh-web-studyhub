// Consolidated Legacy E2E Suite: Rounds 23-35
// Merges: round23-e2e, round24-e2e, round25-e2e, round26-e2e, round31-e2e, round34-e2e, round35-e2e
// node --test tests/legacy-rounds-23-35.test.mjs
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { render } from 'ink';
import React from 'react';
import { tsImport } from 'tsx/esm/api';
import { StudyService } from '../../../lib/service.js';
import { courseOutlineMaterial, materialsFingerprint } from '../../../lib/course-outline-book.js';
import { courseNotesMaterial } from '../../../lib/course-book.js';
import { buildOutlineIndex } from '../../../lib/course-outline-index.js';
import { groupSourcesByDocument } from '../../../lib/source-groups.js';
import { openCourseBook } from '../../../lib/course-book-files.js';
import {
  createTempTracker,
  createVirtualTty,
  disposeTerminalPool,
  distDir,
  loadDistRuntime,
} from './helpers/virtual-tty.mjs';

const runtime = await loadDistRuntime();
const { StudyHubTuiApp, createTuiHost, saveTuiPreferences } = runtime;
assert.ok(StudyHubTuiApp, 'dist/ must export StudyHubTuiApp');
assert.ok(createTuiHost, 'dist/ must export createTuiHost');
assert.ok(saveTuiPreferences, 'dist/ must export saveTuiPreferences');

const storeFile = (await readdir(distDir)).find((f) => f.startsWith('store-') && f.endsWith('.mjs'));
assert.ok(storeFile, 'dist/ must include store-*.mjs');
const { useTuiStore, DEFAULT_PREFERENCES } = await import(pathToFileURL(join(distDir, storeFile)).href);
assert.ok(useTuiStore, 'dist/store-*.mjs must export useTuiStore');

const { exportJobTraceToFile } = await tsImport('../src/views/tasks/TasksView.tsx', import.meta.url);
assert.equal(typeof exportJobTraceToFile, 'function', 'TasksView.tsx must export exportJobTraceToFile');

const PREV_DSH_HOME = process.env.DSH_HOME;
const temps = createTempTracker('studyhub-tui-legacy-23-35-');

function resetDistStore(language = 'zh', asciiMode = false, extra = {}) {
  useTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    snapshot: null,
    binding: null,
    config: null,
    desktopConfig: null,
    loading: false,
    refreshing: false,
    lastError: null,
    activeRunId: null,
    toasts: [],
    footerHints: [],
    commandPaletteOpen: false,
    helpOpen: false,
    coursePickerOpen: false,
    voicePackOpen: false,
    inboxOpen: false,
    showLaunchpad: false,
    inputCaptured: false,
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
  resetDistStore('zh', false);
  disposeTerminalPool();
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await temps.cleanup();
});

function createDefaultStubComplete() {
  return async (_system, prompt, execution = {}) => {
    if (String(prompt || '').includes('OK?')) return 'OK';
    execution.signal?.throwIfAborted?.();
    const reply = JSON.stringify({ status: 'ok' });
    execution.onOutput?.(reply);
    return reply;
  };
}

function hasBookEditEmptyState(screen) {
  return (
    screen.includes('这门课还没有复习全书') ||
    screen.includes('No review book for this course yet') ||
    screen.includes('请先选择一门课程') ||
    screen.includes('Select a course first')
  );
}

function hasCustomWizardOptions(screen) {
  return (
    (screen.includes('深度定制向导') || screen.includes('Custom Plan Wizard')) &&
    (screen.includes('学习目的') || screen.includes('Purpose')) &&
    (screen.includes('覆盖范围') || screen.includes('Scope')) &&
    (screen.includes('全书讲解') || screen.includes('Explanations')) &&
    (screen.includes('出题强度') || screen.includes('Q Strength')) &&
    (screen.includes('每日时长') || screen.includes('Min / Day'))
  );
}

function hasCustomEstimate(screen) {
  return (
    !screen.includes('正在重算零成本估算') &&
    !screen.includes('Updating zero-cost estimate') &&
    (screen.includes('粗估(非计费):') ||
      screen.includes('Rough est.(no price):') ||
      screen.includes('粗估:') ||
      screen.includes('Est:'))
  );
}

function hasScopeHintBar(screen) {
  return (
    (screen.includes('/ 命令') &&
      screen.includes('# 题目') &&
      screen.includes('? 片段') &&
      screen.includes('@ 课程') &&
      screen.includes(': 页面')) ||
    (screen.includes('/ cmd') &&
      screen.includes('# card') &&
      screen.includes('? passage') &&
      screen.includes('@ course') &&
      screen.includes(': page'))
  );
}

function extractSkeletonItems(listRes) {
  if (!listRes?.ok) return [];
  const v = listRes.value;
  if (Array.isArray(v)) return v;
  if (Array.isArray(v?.skeletons)) return v.skeletons;
  return [];
}

async function mountSuiteApp(label, { injectedComplete = createDefaultStubComplete(), language = 'zh' } = {}) {
  resetDistStore(language, false);
  const boxDir = await temps.make(label);
  const dshHome = join(boxDir, 'dsh-home');
  const libraryRoot = join(boxDir, 'library');
  process.env.DSH_HOME = dshHome;

  await saveTuiPreferences({ language, asciiMode: false }, { env: { DSH_HOME: dshHome } });

  const host = await createTuiHost({
    env: { DSH_HOME: dshHome },
    home: join(boxDir, 'home'),
    libraryRoot,
    injectedComplete,
    skipAutoProbe: true,
    language,
    eventDebounceMs: 30,
  });

  const sampleRes = await host.call('sample.load', { language });
  assert.equal(sampleRes.ok, true, `${label}: sample.load must succeed: ${sampleRes.error?.message || ''}`);

  const tty = createVirtualTty(120, 36);
  let inkInstance = null;
  inkInstance = render(
    React.createElement(StudyHubTuiApp, {
      host,
      initialPage: 'library',
      initialLanguage: language,
      initialAsciiMode: false,
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
  await tty.firstFramePromise;
  await tty.waitFor(
    (s) =>
      s.includes('示例 · Memento 与 Bridge') &&
      !s.includes('正在打开学习库') &&
      !s.includes('正在加载页面'),
    { timeoutMs: 12_000, label: `${label}: initial LibraryView` },
  );
  await tty.flush();

  return {
    boxDir,
    dshHome,
    libraryRoot,
    host,
    tty,
    async dispose() {
      try {
        inkInstance?.unmount();
      } catch {
        // Ignore unmount errors during teardown
      }
      await host?.dispose();
      tty?.dispose();
      resetDistStore('zh', false);
    },
  };
}

describe('Round 23: BookEditModal & CompanionsModal', () => {
  let ctx;

  before(async () => {
    ctx = await mountSuiteApp('r23');
  });

  after(async () => {
    await ctx?.dispose();
  });

  test('1) BookView BookEditModal (7 -> e): opens cleanly at 120x36 & 80x24 with empty state, Esc closes cleanly', async () => {
    const { tty } = ctx;
    tty.send('7');
    const bookScreen = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'book' &&
        (s.includes('精选问答') || s.includes('Pinned QA')) &&
        !s.includes('正在加载页面') &&
        !s.includes('正在打开复习全书'),
      { timeoutMs: 10_000, label: 'BookView rendered with footer 精选问答 / Pinned QA' },
    );
    tty.assertHealthyScreen(bookScreen, 120, 36, 'BookView at 120x36');
    assert.equal(useTuiStore.getState().page, 'book', 'Key 7 must open BookView');

    tty.send('e');
    const editWide = await tty.waitFor(
      (s) =>
        (s.includes('编辑复习全书') || s.includes('Edit Review Book')) &&
        !s.includes('正在读取本节文件') &&
        !s.includes('Loading section file') &&
        hasBookEditEmptyState(s),
      { timeoutMs: 10_000, label: 'BookEditModal empty state opened at 120x36' },
    );
    tty.assertHealthyScreen(editWide, 120, 36, 'BookEditModal at 120x36');
    assert.ok(hasBookEditEmptyState(editWide), 'BookEditModal must render empty state when no review book exists');

    tty.resize(80, 24);
    const editNarrow = await tty.waitFor(
      (s) =>
        (s.includes('编辑复习全书') || s.includes('Edit Review Book')) &&
        hasBookEditEmptyState(s) &&
        s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'BookEditModal at 80x24' },
    );
    tty.assertHealthyScreen(editNarrow, 80, 24, 'BookEditModal at 80x24');
    assert.ok(editNarrow.split('\n').length <= 24);

    tty.resize(120, 36);
    await tty.waitFor(
      (s) => (s.includes('编辑复习全书') || s.includes('Edit Review Book')) && hasBookEditEmptyState(s),
      { timeoutMs: 8_000, label: 'BookEditModal restored to 120x36' },
    );

    tty.send('\x1b');
    const afterClose = await tty.waitFor(
      (s) =>
        !s.includes('编辑复习全书') &&
        !s.includes('Edit Review Book') &&
        (s.includes('精选问答') || s.includes('Pinned QA')),
      { timeoutMs: 8_000, label: 'BookEditModal closed via Esc' },
    );
    tty.assertHealthyScreen(afterClose, 120, 36, 'BookView after Esc closed BookEditModal');
    assert.ok(!afterClose.includes('编辑复习全书') && !afterClose.includes('Edit Review Book'));
  });

  test('2) SourcesView Upgraded CompanionsModal (2 -> C): [v] scope toggle, [b] Companion Build form at 120x36 & 80x24, Esc back & close', async () => {
    const { tty } = ctx;
    tty.send('2');
    const sourcesScreen = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'sources' &&
        (s.includes('学习资料库') || s.includes('Study Materials')) &&
        (s.includes('示例 · 设计模式讲义') || s.includes('示例案例 · 墨笺笔记')) &&
        !s.includes('正在加载页面'),
      { timeoutMs: 10_000, label: 'SourcesView rendered' },
    );
    tty.assertHealthyScreen(sourcesScreen, 120, 36, 'SourcesView at 120x36');
    assert.equal(useTuiStore.getState().page, 'sources', 'Key 2 must open SourcesView');

    tty.send('C');
    const browseScreen = await tty.waitFor(
      (s) =>
        (s.includes('交互伴学页 (Companions)') || s.includes('Interactive Companions')) &&
        !s.includes('加载中') &&
        !s.includes('Loading') &&
        (s.includes('伴学页') || s.includes('Companions')),
      { timeoutMs: 10_000, label: 'CompanionsModal browse opened at 120x36' },
    );
    tty.assertHealthyScreen(browseScreen, 120, 36, 'CompanionsModal browse at 120x36');
    assert.ok(browseScreen.includes('交互伴学页 (Companions)') || browseScreen.includes('Interactive Companions'));

    assert.ok(
      browseScreen.includes('范围') || browseScreen.includes('Scope'),
      `Expected [v] scope hint when defaultCourse is active:\n${browseScreen}`,
    );
    const initiallyAllCourses = browseScreen.includes('全部课程') || browseScreen.includes('All Courses');
    tty.send('v');
    const toggledScreen = await tty.waitFor(
      (s) =>
        (s.includes('交互伴学页 (Companions)') || s.includes('Interactive Companions')) &&
        !s.includes('加载中') &&
        !s.includes('Loading') &&
        (s.includes('全部课程') || s.includes('All Courses')) !== initiallyAllCourses,
      { timeoutMs: 8_000, label: 'CompanionsModal [v] scope toggled' },
    );
    tty.assertHealthyScreen(toggledScreen, 120, 36, 'CompanionsModal after first [v] toggle');
    assert.notEqual(
      toggledScreen.includes('全部课程') || toggledScreen.includes('All Courses'),
      initiallyAllCourses,
      'Scope toggle [v] must invert All Courses filter',
    );

    tty.send('v');
    const restoredScopeScreen = await tty.waitFor(
      (s) =>
        (s.includes('交互伴学页 (Companions)') || s.includes('Interactive Companions')) &&
        !s.includes('加载中') &&
        !s.includes('Loading') &&
        (s.includes('全部课程') || s.includes('All Courses')) === initiallyAllCourses,
      { timeoutMs: 8_000, label: 'CompanionsModal [v] scope toggled back' },
    );
    tty.assertHealthyScreen(restoredScopeScreen, 120, 36, 'CompanionsModal after second [v] toggle');
    assert.equal(
      restoredScopeScreen.includes('全部课程') || restoredScopeScreen.includes('All Courses'),
      initiallyAllCourses,
      'Second [v] must restore initial scope',
    );

    tty.send('b');
    const buildWide = await tty.waitFor(
      (s) =>
        (s.includes('4 阶段构建') || s.includes('4-Stage Build')) &&
        (s.includes('1. 所属课程') || s.includes('1. Course')) &&
        (s.includes('2. 核心主题') || s.includes('2. Topic')) &&
        (s.includes('4. 交互母版') || s.includes('4. Archetype')) &&
        (s.includes('5. 题库联动') || s.includes('5. Mount')),
      { timeoutMs: 8_000, label: 'CompanionsModal Build form opened at 120x36' },
    );
    tty.assertHealthyScreen(buildWide, 120, 36, 'CompanionsModal Build form at 120x36');
    assert.ok(buildWide.includes('4 阶段构建') || buildWide.includes('4-Stage Build'));

    tty.resize(80, 24);
    const buildNarrow = await tty.waitFor(
      (s) =>
        (s.includes('4 阶段构建') || s.includes('4-Stage Build')) &&
        (s.includes('1. 所属课程') || s.includes('1. Course')) &&
        (s.includes('2. 核心主题') || s.includes('2. Topic')) &&
        (s.includes('4. 交互母版') || s.includes('4. Archetype')) &&
        (s.includes('5. 题库联动') || s.includes('5. Mount')) &&
        s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'CompanionsModal Build form at 80x24' },
    );
    tty.assertHealthyScreen(buildNarrow, 80, 24, 'CompanionsModal Build form at 80x24');
    assert.ok(buildNarrow.split('\n').length <= 24);

    tty.resize(120, 36);
    await tty.waitFor(
      (s) =>
        (s.includes('4 阶段构建') || s.includes('4-Stage Build')) &&
        (s.includes('5. 题库联动') || s.includes('5. Mount')),
      { timeoutMs: 8_000, label: 'CompanionsModal Build form restored to 120x36' },
    );

    tty.send('\x1b');
    const backToBrowse = await tty.waitFor(
      (s) =>
        !s.includes('4 阶段构建') &&
        !s.includes('4-Stage Build') &&
        (s.includes('交互伴学页 (Companions)') || s.includes('Interactive Companions')) &&
        (s.includes('伴学页') || s.includes('Companions')),
      { timeoutMs: 8_000, label: 'CompanionsModal Esc back from build to browse' },
    );
    tty.assertHealthyScreen(backToBrowse, 120, 36, 'CompanionsModal back to browse');
    assert.ok(!backToBrowse.includes('4 阶段构建'));

    tty.send('\x1b');
    const afterClose = await tty.waitFor(
      (s) =>
        !s.includes('交互伴学页 (Companions)') &&
        !s.includes('Interactive Companions') &&
        (s.includes('学习资料库') || s.includes('Study Materials')),
      { timeoutMs: 8_000, label: 'CompanionsModal closed via Esc' },
    );
    tty.assertHealthyScreen(afterClose, 120, 36, 'SourcesView after Esc closed CompanionsModal');
    assert.ok(!afterClose.includes('交互伴学页 (Companions)'));
  });
});

describe('Round 24: Custom Plan Wizard, DeckManage Batch Focus & WrongBook Batch Practice', () => {
  let ctx;

  before(async () => {
    ctx = await mountSuiteApp('r24');
  });

  after(async () => {
    await ctx?.dispose();
  });

  test('1) StudyPlanModal Tab 3 Custom Plan Wizard (0 -> P -> 3): options, live preview, save without clobbering exam date, 120x36 & 80x24, --ascii purity, Esc close', async () => {
    const { host, tty } = ctx;
    const courseName = '示例课程 · 设计模式';
    const beforeCourse = await host.call('course.get', { name: courseName });
    assert.equal(beforeCourse.ok, true, 'course.get before saving custom plan must succeed');
    assert.ok(beforeCourse.value?.exam?.date, 'Sample course must have an initial exam date');

    tty.send('0');
    const examPrepScreen = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'examprep' &&
        (s.includes('备考补习') || s.includes('Exam Prep')) &&
        (s.includes('考纲重点进度') || s.includes('Focus Progress')) &&
        !s.includes('正在加载页面') &&
        !s.includes('正在加载备考重点'),
      { timeoutMs: 10_000, label: 'ExamPrepView rendered' },
    );
    tty.assertHealthyScreen(examPrepScreen, 120, 36, 'ExamPrepView at 120x36');

    tty.send('P');
    await tty.waitFor(
      (s) => s.includes('课程备考计划 & 章节就绪度') || s.includes('Study Plan & Chapter Readiness'),
      { timeoutMs: 10_000, label: 'StudyPlanModal opened' },
    );

    tty.send('3');
    const tab3Initial = await tty.waitFor(
      (s) =>
        (s.includes('3:深度定制') || s.includes('3:Custom')) &&
        !s.includes('正在加载深度定制配置') &&
        !s.includes('Loading custom plan') &&
        !s.includes('正在初始化向导') &&
        hasCustomWizardOptions(s) &&
        hasCustomEstimate(s),
      { timeoutMs: 10_000, label: 'StudyPlanModal Tab 3 Custom Wizard rendered with live estimate' },
    );
    tty.assertHealthyScreen(tab3Initial, 120, 36, 'StudyPlanModal Tab 3 at 120x36');
    assert.ok(hasCustomWizardOptions(tab3Initial), 'Tab 3 must display all custom wizard options');
    assert.ok(hasCustomEstimate(tab3Initial), 'Tab 3 must display live rough estimate');

    const initialMinMatch = tab3Initial.match(/(\d+)(?:分\/天|m\/d)/);
    assert.ok(initialMinMatch, `Expected Minutes/Day value in Tab 3:\n${tab3Initial}`);
    const initialMins = Number(initialMinMatch[1]);

    tty.send('j');
    await tty.waitFor(
      (s) => s.includes('覆盖当前课程全部可学习章节') || s.includes('Covers all teachable chapters'),
      { timeoutMs: 5_000, label: 'Cursor moved to Scope row' },
    );

    tty.send(' ');
    const scopedScreen = await tty.waitFor(
      (s) => (s.includes('考纲范围') || s.includes('Exam Scope')) && hasCustomEstimate(s),
      { timeoutMs: 8_000, label: 'Scope toggled to Exam Scope and live preview updated' },
    );
    assert.ok(scopedScreen.includes('考纲范围') || scopedScreen.includes('Exam Scope'));

    tty.send('k');
    await tty.waitFor((s) => s.includes('学习目的:') || s.includes('Purpose:'), {
      timeoutMs: 5_000,
      label: 'Cursor moved back to Purpose row',
    });

    tty.send(' ');
    await tty.waitFor(
      (s) => s.includes('开卷速查') || s.includes('Open-book') || s.includes('课前预习') || s.includes('Preview'),
      { timeoutMs: 8_000, label: 'Purpose cycled via Space' },
    );

    tty.send('+');
    const expectedMins = Math.min(240, initialMins + 15);
    const tab3Edited = await tty.waitFor(
      (s) => (s.includes(`${expectedMins}分/天`) || s.includes(`${expectedMins}m/d`)) && hasCustomEstimate(s),
      { timeoutMs: 8_000, label: 'Minutes/Day adjusted via + and live estimate settled' },
    );
    tty.assertHealthyScreen(tab3Edited, 120, 36, 'StudyPlanModal Tab 3 after edits');
    assert.ok(tab3Edited.includes(`${expectedMins}分/天`) || tab3Edited.includes(`${expectedMins}m/d`));

    tty.send('s');
    const tab3Saved = await tty.waitFor(
      (s) =>
        !s.includes('正在保存定制方案') &&
        !s.includes('Saving custom plan') &&
        !s.includes('草稿(未存)') &&
        !s.includes('已修改(未存)') &&
        (s.includes('已保存') || s.includes('Saved')) &&
        (s.includes('深度定制方案') || s.includes('Saved custom plan')),
      { timeoutMs: 10_000, label: 'StudyPlanModal Tab 3 saved toast and badge' },
    );
    tty.assertHealthyScreen(tab3Saved, 120, 36, 'StudyPlanModal Tab 3 after save');
    assert.ok(tab3Saved.includes('已保存') || tab3Saved.includes('Saved'));

    const afterCourse = await host.call('course.get', { name: courseName });
    assert.equal(afterCourse.ok, true, 'course.get after saving custom plan must succeed');
    assert.deepEqual(
      afterCourse.value?.exam,
      beforeCourse.value?.exam,
      'Saving custom plan must not clobber existing course exam date or exam profile',
    );
    assert.ok(afterCourse.value?.custom, 'course.custom must be persisted after [s]');

    tty.resize(80, 24);
    const tab3Narrow = await tty.waitFor(
      (s) =>
        (s.includes('深度定制向导') || s.includes('Custom Plan Wizard')) &&
        hasCustomEstimate(s) &&
        s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'StudyPlanModal Tab 3 at 80x24' },
    );
    tty.assertHealthyScreen(tab3Narrow, 80, 24, 'StudyPlanModal Tab 3 at 80x24');
    assert.ok(tab3Narrow.split('\n').length <= 24);

    tty.resize(120, 36);
    await tty.waitFor(
      (s) => (s.includes('深度定制向导') || s.includes('Custom Plan Wizard')) && hasCustomWizardOptions(s),
      { timeoutMs: 8_000, label: 'StudyPlanModal Tab 3 restored to 120x36' },
    );

    tty.send('\x1b');
    const afterEsc = await tty.waitFor(
      (s) =>
        !s.includes('深度定制向导') &&
        !s.includes('课程备考计划') &&
        (s.includes('备考补习') || s.includes('Exam Prep')),
      { timeoutMs: 8_000, label: 'StudyPlanModal closed via Esc' },
    );
    tty.assertHealthyScreen(afterEsc, 120, 36, 'ExamPrepView after Esc closed StudyPlanModal');
    assert.ok(!afterEsc.includes('深度定制向导'));

    useTuiStore.getState().setPreferences({ asciiMode: true });
    try {
      await tty.waitFor((s) => s.includes('[SH] StudyHub') && !s.includes('╭'), {
        timeoutMs: 5_000,
        label: 'ASCII mode enabled on ExamPrepView',
      });

      tty.send('P');
      await tty.waitFor(
        (s) => s.includes('课程备考计划 & 章节就绪度') || s.includes('Study Plan & Chapter Readiness'),
        { timeoutMs: 10_000, label: 'ASCII StudyPlanModal opened' },
      );

      tty.send('3');
      const tab3Ascii = await tty.waitFor(
        (s) =>
          !s.includes('正在加载深度定制配置') &&
          !s.includes('Loading custom plan') &&
          hasCustomWizardOptions(s) &&
          hasCustomEstimate(s) &&
          s.includes('Space/<->'),
        { timeoutMs: 10_000, label: 'ASCII StudyPlanModal Tab 3 rendered' },
      );
      tty.assertHealthyScreen(tab3Ascii, 120, 36, 'ASCII StudyPlanModal Tab 3');
      tty.assertAsciiPure(tab3Ascii, 'ASCII StudyPlanModal Tab 3');
      assert.ok(tab3Ascii.includes('Space/<->'));

      tty.send('\x1b');
      await tty.waitFor((s) => !s.includes('深度定制向导') && !s.includes('课程备考计划'), {
        timeoutMs: 6_000,
        label: 'ASCII StudyPlanModal closed',
      });
    } finally {
      useTuiStore.getState().setPreferences({ asciiMode: false });
      await tty.waitFor((s) => s.includes('╭') && !s.includes('[SH] StudyHub'), {
        timeoutMs: 5_000,
        label: 'Unicode mode restored after ASCII check',
      });
    }
  });

  test('2) DeckManageModal Multi-Select Batch Focus (1 -> m -> Space -> F): select 2 cards, batch Focus updates markers, x clears selection, Esc closes', async () => {
    const { tty } = ctx;
    if (useTuiStore.getState().page !== 'library') {
      tty.send('\x7f');
      await tty.waitFor(() => useTuiStore.getState().page === 'library', {
        timeoutMs: 6_000,
        label: 'Returned from ExamPrepView to LibraryView',
      });
    }
    tty.send('1');
    const libraryScreen = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'library' &&
        (s.includes('题组列表') || s.includes('Decks')) &&
        s.includes('示例 · Memento 与 Bridge') &&
        !s.includes('正在加载页面'),
      { timeoutMs: 10_000, label: 'LibraryView rendered' },
    );
    tty.assertHealthyScreen(libraryScreen, 120, 36, 'LibraryView at 120x36');

    tty.send('m');
    const manageInitial = await tty.waitFor(
      (s) =>
        (s.includes('题组管理') || s.includes('Manage Deck')) &&
        !s.includes('正在读取题组卡片') &&
        !s.includes('Loading deck cards') &&
        s.includes(' 1.') &&
        s.includes(' 2.'),
      { timeoutMs: 10_000, label: 'DeckManageModal opened' },
    );
    tty.assertHealthyScreen(manageInitial, 120, 36, 'DeckManageModal initial at 120x36');
    assert.equal(
      (manageInitial.match(/★/g) ?? []).length,
      0,
      `Expected no initial Focus stars before batch toggle:\n${manageInitial}`,
    );

    tty.send(' ');
    await tty.waitFor((s) => s.includes('[已选 1]') || s.includes('[1 sel]'), {
      timeoutMs: 5_000,
      label: 'DeckManageModal 1st card selected',
    });
    tty.send('j');
    await tty.flush();
    tty.send(' ');
    const selectedScreen = await tty.waitFor(
      (s) => (s.includes('[已选 2]') || s.includes('[2 sel]')) && (s.includes('[F]重点') || s.includes('[F]Focus')),
      { timeoutMs: 8_000, label: 'DeckManageModal 2 cards selected' },
    );
    tty.assertHealthyScreen(selectedScreen, 120, 36, 'DeckManageModal with 2 cards selected');

    tty.send('F');
    const focusedScreen = await tty.waitFor(
      (s) =>
        (s.match(/★/g) ?? []).length >= 2 &&
        (s.includes('已将 2 题标为重点') || s.includes('Marked 2 card(s) as Focus')),
      { timeoutMs: 8_000, label: 'DeckManageModal batch Focus applied' },
    );
    tty.assertHealthyScreen(focusedScreen, 120, 36, 'DeckManageModal after batch Focus');
    assert.ok((focusedScreen.match(/★/g) ?? []).length >= 2, 'Two cards must have Focus star markers');

    tty.send('x');
    const clearedScreen = await tty.waitFor(
      (s) =>
        !s.includes('[已选') &&
        !s.includes('sel]') &&
        !s.includes('已选 2') &&
        !s.includes('2 sel') &&
        (s.match(/★/g) ?? []).length >= 2,
      { timeoutMs: 8_000, label: 'DeckManageModal selection cleared via x' },
    );
    tty.assertHealthyScreen(clearedScreen, 120, 36, 'DeckManageModal after clearing selection');
    assert.ok(!clearedScreen.includes('[已选') && !clearedScreen.includes('sel]'));

    tty.send('\x1b');
    const afterClose = await tty.waitFor(
      (s) => !s.includes('题组管理') && !s.includes('Manage Deck') && (s.includes('题组列表') || s.includes('Decks')),
      { timeoutMs: 8_000, label: 'DeckManageModal closed via Esc' },
    );
    tty.assertHealthyScreen(afterClose, 120, 36, 'LibraryView after Esc closed DeckManageModal');
    assert.ok(!afterClose.includes('题组管理') && !afterClose.includes('Manage Deck'));
  });

  test('3) WrongBookView Multi-Select Batch Practice (4 -> Space -> B -> ReviewView): selects 1 weak card and launches 1/1 ReviewView', async () => {
    const { tty } = ctx;
    tty.send('4');
    const wrongBookScreen = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'wrongbook' &&
        (s.includes('错题列表') || s.includes('Mistakes')) &&
        !s.includes('正在加载错题本') &&
        !s.includes('Loading mistakes') &&
        (s.includes('Memento') || s.includes('Bridge')),
      { timeoutMs: 10_000, label: 'WrongBookView rendered with weak cards' },
    );
    tty.assertHealthyScreen(wrongBookScreen, 120, 36, 'WrongBookView at 120x36');
    assert.equal(useTuiStore.getState().page, 'wrongbook', 'Key 4 must open WrongBookView');

    tty.send(' ');
    const selectedWrongScreen = await tty.waitFor(
      (s) => (s.includes('[已选 1]') || s.includes('[1 sel]')) && (s.includes('练已选(1)') || s.includes('Batch(1)')),
      { timeoutMs: 8_000, label: 'WrongBookView 1 weak card selected' },
    );
    tty.assertHealthyScreen(selectedWrongScreen, 120, 36, 'WrongBookView with 1 card selected');
    assert.ok(selectedWrongScreen.includes('练已选(1)') || selectedWrongScreen.includes('Batch(1)'));

    tty.send('B');
    const reviewScreen = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'review' &&
        !s.includes('正在准备复习队列') &&
        !s.includes('Preparing review queue') &&
        s.includes('1/1'),
      { timeoutMs: 10_000, label: 'ReviewView launched from WrongBook [B] with 1/1 question' },
    );
    tty.assertHealthyScreen(reviewScreen, 120, 36, 'ReviewView after WrongBook [B] batch practice');
    assert.equal(useTuiStore.getState().page, 'review', 'Batch practice B must launch ReviewView');
    assert.ok(reviewScreen.includes('1/1'), 'Batch practice with 1 card must show 1/1');
  });
});

describe('Round 25: CommandPalette Scoped Prefixes, RoundConfigModal & Review Undo', () => {
  let ctx;

  before(async () => {
    ctx = await mountSuiteApp('r25');
  });

  after(async () => {
    await ctx?.dispose();
  });

  test('1) CommandPalette v3 scoped prefixes (/#?@:) & recentCommands persistence, 120x36 & 80x24, --ascii purity', async () => {
    const { tty } = ctx;
    tty.send('\x0b');
    const paletteOpen = await tty.waitFor(
      (s) => (s.includes('命令面板') || s.includes('Command Palette')) && hasScopeHintBar(s),
      { timeoutMs: 6_000, label: 'CommandPalette opened with scope hint bar' },
    );
    tty.assertHealthyScreen(paletteOpen, 120, 36, 'CommandPalette initial at 120x36');
    assert.ok(hasScopeHintBar(paletteOpen), 'CommandPalette must show scope hint bar');

    tty.send('#Memento');
    const cardHitScreen = await tty.waitFor(
      (s) =>
        !s.includes('正在全文检索') &&
        !s.includes('Searching') &&
        (s.includes('题库') || s.includes('Card')) &&
        s.includes('Memento'),
      { timeoutMs: 8_000, label: 'CommandPalette #Memento live card search hit' },
    );
    tty.assertHealthyScreen(cardHitScreen, 120, 36, 'CommandPalette #Memento');
    assert.ok(cardHitScreen.includes('Memento'), '#Memento must return Memento card hits');
    const cardScopeRows = tty
      .readLines()
      .filter((l) => l.includes('│') && !l.includes(': 页面') && !l.includes(': page'));
    assert.ok(
      !cardScopeRows.some((l) => l.includes(' 页面 ') || l.includes(' Page ')),
      `# scope must exclude page items:\n${cardHitScreen}`,
    );

    tty.send('\x15');
    await tty.waitFor((s) => s.includes('搜索页面、课程') || s.includes('Search pages'), {
      timeoutMs: 5_000,
      label: 'CommandPalette cleared before ?Bridge',
    });
    tty.send('?Bridge');
    const passageHitScreen = await tty.waitFor(
      (s) =>
        !s.includes('正在全文检索') &&
        !s.includes('Searching') &&
        (s.includes('原文') || s.includes('Passage')),
      { timeoutMs: 8_000, label: 'CommandPalette ?Bridge live passage hit' },
    );
    tty.assertHealthyScreen(passageHitScreen, 120, 36, 'CommandPalette ?Bridge');
    assert.ok(passageHitScreen.includes('原文') || passageHitScreen.includes('Passage'));
    const passageScopeRows = tty
      .readLines()
      .filter((l) => l.includes('│') && !l.includes(': 页面') && !l.includes(': page'));
    assert.ok(
      !passageScopeRows.some((l) => l.includes(' 题库 ') || l.includes(' Card ')),
      `? scope must exclude card items:\n${passageHitScreen}`,
    );

    tty.send('\x15');
    await tty.waitFor((s) => !s.includes('?Bridge') && (s.includes('搜索页面、课程') || s.includes('Search pages')), {
      timeoutMs: 5_000,
      label: 'CommandPalette cleared before @示例',
    });
    tty.send('@示例');
    const courseFilterScreen = await tty.waitFor(
      (s) => s.includes('@示例') && (s.includes('课程') || s.includes('Course')) && s.includes('示例课程 · 设计模式'),
      { timeoutMs: 6_000, label: 'CommandPalette @示例 course filter' },
    );
    tty.assertHealthyScreen(courseFilterScreen, 120, 36, 'CommandPalette @示例');
    assert.ok(courseFilterScreen.includes('示例课程 · 设计模式'));

    tty.send('\x15');
    await tty.waitFor((s) => !s.includes('@示例') && (s.includes('搜索页面、课程') || s.includes('Search pages')), {
      timeoutMs: 5_000,
      label: 'CommandPalette cleared before :设置',
    });
    tty.send(':设置');
    const pageFilterScreen = await tty.waitFor(
      (s) => s.includes(':设置') && (s.includes('页面') || s.includes('Page')) && (s.includes('设置') || s.includes('Settings')),
      { timeoutMs: 6_000, label: 'CommandPalette :设置 page filter' },
    );
    tty.assertHealthyScreen(pageFilterScreen, 120, 36, 'CommandPalette :设置');
    assert.ok(pageFilterScreen.includes('设置') || pageFilterScreen.includes('Settings'));

    tty.send('\x15');
    await tty.waitFor((s) => !s.includes(':设置') && (s.includes('搜索页面、课程') || s.includes('Search pages')), {
      timeoutMs: 5_000,
      label: 'CommandPalette cleared before /theme',
    });
    tty.send('/theme');
    const themeFilterScreen = await tty.waitFor(
      (s) => s.includes('/theme') && !s.includes(':设置') && !s.includes('@示例') && (s.includes('命令') || s.includes('Action')),
      { timeoutMs: 6_000, label: 'CommandPalette /theme command filter' },
    );
    tty.assertHealthyScreen(themeFilterScreen, 120, 36, 'CommandPalette /theme');
    assert.ok(themeFilterScreen.includes('/theme'));

    const prevTheme = useTuiStore.getState().preferences.theme;
    tty.send('\r');
    await tty.waitFor(
      (s) =>
        !s.includes('命令面板') &&
        !s.includes('Command Palette') &&
        useTuiStore.getState().preferences.theme !== prevTheme,
      { timeoutMs: 6_000, label: 'CommandPalette /theme executed' },
    );

    const recent = useTuiStore.getState().preferences.recentCommands;
    assert.ok(Array.isArray(recent) && recent.includes('cmd:theme'), `Expected recentCommands to include cmd:theme, got ${JSON.stringify(recent)}`);

    tty.send('\x0b');
    const reopened = await tty.waitFor(
      (s) => (s.includes('命令面板') || s.includes('Command Palette')) && (s.includes('最近') || s.includes('Recent')) && s.includes('/theme'),
      { timeoutMs: 6_000, label: 'CommandPalette reopened showing Recent /theme' },
    );
    tty.assertHealthyScreen(reopened, 120, 36, 'CommandPalette reopened with recentCommands');
    assert.ok(reopened.includes('/theme'), 'Reopened CommandPalette must render recent /theme');

    tty.resize(80, 24);
    const narrowPalette = await tty.waitFor(
      (s) => (s.includes('命令面板') || s.includes('Command Palette')) && hasScopeHintBar(s) && s.split('\n').length <= 24,
      { timeoutMs: 6_000, label: 'CommandPalette at 80x24' },
    );
    tty.assertHealthyScreen(narrowPalette, 80, 24, 'CommandPalette at 80x24');
    assert.ok(narrowPalette.split('\n').length <= 24);

    tty.resize(120, 36);
    await tty.waitFor((s) => (s.includes('命令面板') || s.includes('Command Palette')) && hasScopeHintBar(s), {
      timeoutMs: 6_000,
      label: 'CommandPalette restored to 120x36',
    });

    useTuiStore.getState().setPreferences({ asciiMode: true });
    try {
      const asciiPalette = await tty.waitFor(
        (s) => s.includes('Up/Dn') && !s.includes('╭') && !s.includes('❯') && !s.includes('⌘'),
        { timeoutMs: 5_000, label: 'ASCII CommandPalette rendered' },
      );
      tty.assertHealthyScreen(asciiPalette, 120, 36, 'ASCII CommandPalette');
      assert.equal(
        asciiPalette.match(/[\u2500-\u257F\u2580-\u259F\u2800-\u28FF\u2190\u2191\u2193\u25b8\u276f]/g),
        null,
        `ASCII CommandPalette leaked Unicode chrome:\n${asciiPalette}`,
      );
    } finally {
      useTuiStore.getState().setPreferences({ asciiMode: false });
      await tty.waitFor((s) => s.includes('╭') && s.includes('⌘'), {
        timeoutMs: 5_000,
        label: 'Unicode mode restored on CommandPalette',
      });
    }

    tty.send('\x1b');
    const afterEsc = await tty.waitFor((s) => !s.includes('命令面板') && !s.includes('Command Palette'), {
      timeoutMs: 6_000,
      label: 'CommandPalette closed via Esc',
    });
    tty.assertHealthyScreen(afterEsc, 120, 36, 'LibraryView after CommandPalette Esc');
    assert.ok(!afterEsc.includes('命令面板') && !afterEsc.includes('Command Palette'));
  });

  test('2) LibraryView [R] RoundConfigModal (1 -> R): 120x36 & 80x24, --ascii purity, adjust filter/size/focus, Enter starts ReviewView', async () => {
    const { tty } = ctx;
    if (useTuiStore.getState().page !== 'library') {
      tty.send('1');
    }
    const libScreen = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'library' &&
        (s.includes('题组列表') || s.includes('Decks')) &&
        s.includes('示例 · Memento 与 Bridge'),
      { timeoutMs: 8_000, label: 'LibraryView active for RoundConfigModal' },
    );
    tty.assertHealthyScreen(libScreen, 120, 36, 'LibraryView before [R]');
    assert.equal(useTuiStore.getState().page, 'library');

    tty.send('R');
    const modalOpen = await tty.waitFor(
      (s) => s.includes('定制本轮练习') || s.includes('Configure Practice Round'),
      { timeoutMs: 8_000, label: 'RoundConfigModal opened via R' },
    );
    tty.assertHealthyScreen(modalOpen, 120, 36, 'RoundConfigModal at 120x36');
    assert.ok(modalOpen.includes('定制本轮练习') || modalOpen.includes('Configure Practice Round'));

    tty.send('-');
    await tty.waitFor((s) => s.includes('15 题') || s.includes('15 cards'), {
      timeoutMs: 5_000,
      label: 'RoundConfigModal size decremented to 15',
    });

    tty.send('2');
    await tty.waitFor((s) => s.includes('仅到期') && (s.includes('就绪: 仅到期') || s.includes('Ready: Due Only')), {
      timeoutMs: 5_000,
      label: 'RoundConfigModal filter set to due via 2',
    });

    tty.send('1');
    await tty.waitFor((s) => s.includes('就绪: 智能混合') || s.includes('Ready: Smart Mix'), {
      timeoutMs: 5_000,
      label: 'RoundConfigModal filter restored to all via 1',
    });

    tty.send('f');
    await tty.waitFor((s) => s.includes('仅考纲重点') || s.includes('Focus only'), {
      timeoutMs: 5_000,
      label: 'RoundConfigModal focusOnly toggled ON via f',
    });

    tty.send('f');
    await tty.waitFor((s) => s.includes('全部难度') || s.includes('All cards'), {
      timeoutMs: 5_000,
      label: 'RoundConfigModal focusOnly toggled OFF via f',
    });

    tty.resize(80, 24);
    const modalNarrow = await tty.waitFor(
      (s) => (s.includes('定制本轮练习') || s.includes('Configure Practice Round')) && s.split('\n').length <= 24,
      { timeoutMs: 6_000, label: 'RoundConfigModal at 80x24' },
    );
    tty.assertHealthyScreen(modalNarrow, 80, 24, 'RoundConfigModal at 80x24');
    assert.ok(modalNarrow.split('\n').length <= 24);

    tty.resize(120, 36);
    await tty.waitFor((s) => s.includes('定制本轮练习') || s.includes('Configure Practice Round'), {
      timeoutMs: 6_000,
      label: 'RoundConfigModal restored to 120x36',
    });

    useTuiStore.getState().setPreferences({ asciiMode: true });
    try {
      const modalAscii = await tty.waitFor(
        (s) => (s.includes('定制本轮练习') || s.includes('Configure Practice Round')) && s.includes('<-/->') && !s.includes('╭'),
        { timeoutMs: 5_000, label: 'ASCII RoundConfigModal rendered' },
      );
      tty.assertHealthyScreen(modalAscii, 120, 36, 'ASCII RoundConfigModal');
      tty.assertAsciiPure(modalAscii, 'ASCII RoundConfigModal');
      assert.ok(modalAscii.includes('<-/->'));
    } finally {
      useTuiStore.getState().setPreferences({ asciiMode: false });
      await tty.waitFor((s) => s.includes('╭') && s.includes('←/→'), {
        timeoutMs: 5_000,
        label: 'Unicode mode restored on RoundConfigModal',
      });
    }

    tty.send('\r');
    const reviewScreen = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'review' &&
        !s.includes('定制本轮练习') &&
        !s.includes('正在准备复习队列') &&
        !s.includes('Preparing review queue') &&
        (s.includes('[h]AI讲解') || s.includes('[h]AI Help') || s.includes('1/')),
      { timeoutMs: 10_000, label: 'ReviewView started from RoundConfigModal' },
    );
    tty.assertHealthyScreen(reviewScreen, 120, 36, 'ReviewView started from RoundConfigModal');
    assert.equal(useTuiStore.getState().page, 'review', 'Starting configured round must open ReviewView');
    assert.ok(!reviewScreen.includes('定制本轮练习'));
  });

  test('3) ReviewView [u] review.undo: rate/answer card then undo rating cleanly', async () => {
    const { host, tty } = ctx;
    const runId = useTuiStore.getState().activeRunId;
    assert.ok(runId, 'Expected activeRunId in ReviewView from Test 2');
    const beforeRes = await host.call('review.get', { runId });
    assert.equal(beforeRes.ok, true, 'review.get before answering must succeed');
    const cardKind = String(beforeRes.value?.card?.kind || '').toLowerCase();

    if (cardKind === 'flashcard' || cardKind === 'open' || cardKind === 'short_answer' || cardKind === 'case') {
      tty.send(' ');
      await tty.waitFor((s) => s.includes('FSRS-6 记忆评分') || s.includes('FSRS-6 Rating'), {
        timeoutMs: 8_000,
        label: 'Card revealed for FSRS rating',
      });
      tty.send('2');
    } else if (cardKind === 'multiple') {
      tty.send('1');
      await tty.flush();
      tty.send('\r');
    } else if (cardKind === 'cloze' || cardKind === 'fill_blank') {
      tty.send('i');
      await tty.flush();
      tty.send('Originator');
      await tty.flush();
      tty.send('\r');
    } else {
      tty.send('1');
    }

    const gradedScreen = await tty.waitFor(
      (s) =>
        s.includes('回答正确') ||
        s.includes('回答有误') ||
        s.includes('已自报') ||
        s.includes('Correct') ||
        s.includes('Incorrect') ||
        s.includes('Self-reported'),
      { timeoutMs: 8_000, label: 'Feedback rendered after answering/rating card' },
    );
    tty.assertHealthyScreen(gradedScreen, 120, 36, 'ReviewView after rating card');
    assert.ok(
      gradedScreen.includes('回答正确') ||
        gradedScreen.includes('回答有误') ||
        gradedScreen.includes('已自报') ||
        gradedScreen.includes('Correct') ||
        gradedScreen.includes('Incorrect') ||
        gradedScreen.includes('Self-reported'),
    );

    const midRes = await host.call('review.get', { runId });
    assert.equal(midRes.ok, true, 'review.get after rating must succeed');
    assert.ok(midRes.value?.undoable, 'Expected run.undoable to be present after rating card');

    tty.send('u');
    const undoneScreen = await tty.waitFor(
      (s) =>
        (s.includes('已撤销上一题评分') || s.includes('Undid last rating')) &&
        (s.includes('答案与解析') || s.includes('Answer & Explanation')) &&
        !s.includes('回答正确') &&
        !s.includes('回答有误') &&
        !s.includes('已自报'),
      { timeoutMs: 8_000, label: 'ReviewView after [u] review.undo' },
    );
    tty.assertHealthyScreen(undoneScreen, 120, 36, 'ReviewView after [u] review.undo');
    assert.ok(undoneScreen.includes('已撤销上一题评分') || undoneScreen.includes('Undid last rating'));

    const afterRes = await host.call('review.get', { runId });
    assert.equal(afterRes.ok, true, 'review.get after undo must succeed');
    assert.equal(Boolean(afterRes.value?.undoable), false, 'run.undoable must clear after undoing');
    assert.equal(afterRes.value?.revealed, true, 'Undone card must remain in revealed state');
  });
});

describe('Round 26: SkeletonView CourseRoute, TopicGroups & NodeEdit Modals', () => {
  let ctx;

  before(async () => {
    ctx = await mountSuiteApp('r26');
  });

  after(async () => {
    await ctx?.dispose();
  });

  test('1) SkeletonView [R] CourseRouteModal (8 -> R): 120x36 & 80x24, --ascii purity, Enter -> ReviewView -> Exit to LibraryView', async () => {
    const { tty } = ctx;
    tty.send('8');
    const skelScreen = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'skeleton' &&
        (s.includes('知识层级树') || s.includes('Knowledge Tree')) &&
        !s.includes('正在加载知识骨架') &&
        !s.includes('Loading knowledge skeleton') &&
        (s.includes('释义:') || s.includes('Description:') || s.includes('节点检视器') || s.includes('Node Inspector')),
      { timeoutMs: 10_000, label: 'SkeletonView rendered at 120x36' },
    );
    tty.assertHealthyScreen(skelScreen, 120, 36, 'SkeletonView at 120x36');
    assert.equal(useTuiStore.getState().page, 'skeleton', 'Key 8 must open SkeletonView');

    tty.send('R');
    const routeWide = await tty.waitFor(
      (s) =>
        (s.includes('课程学习路线') || s.includes('Course Route')) &&
        !s.includes('正在加载课程路线') &&
        !s.includes('Loading course route') &&
        (s.includes('总进度') || s.includes('Route')) &&
        (s.includes('章') || s.includes(' ch')) &&
        (s.includes('[▶]') || s.includes('[✔]') || s.includes('[◐]') || s.includes('[○]')),
      { timeoutMs: 8_000, label: 'CourseRouteModal rendered at 120x36' },
    );
    tty.assertHealthyScreen(routeWide, 120, 36, 'CourseRouteModal at 120x36');
    assert.ok(routeWide.includes('课程学习路线') || routeWide.includes('Course Route'));

    tty.resize(80, 24);
    const routeNarrow = await tty.waitFor(
      (s) =>
        (s.includes('课程学习路线') || s.includes('Course Route')) &&
        (s.includes('总进度') || s.includes('Route')) &&
        s.split('\n').length <= 24,
      { timeoutMs: 6_000, label: 'CourseRouteModal at 80x24' },
    );
    tty.assertHealthyScreen(routeNarrow, 80, 24, 'CourseRouteModal at 80x24');
    assert.ok(routeNarrow.split('\n').length <= 24);

    tty.resize(120, 36);
    await tty.waitFor(
      (s) =>
        (s.includes('课程学习路线') || s.includes('Course Route')) &&
        (s.includes('知识层级树') || s.includes('Knowledge Tree')),
      { timeoutMs: 6_000, label: 'CourseRouteModal restored to 120x36' },
    );

    useTuiStore.getState().setPreferences({ asciiMode: true });
    try {
      const routeAscii = await tty.waitFor(
        (s) =>
          (s.includes('> 课程学习路线') || s.includes('> Course Route')) &&
          s.includes('esc x') &&
          !s.includes('╭'),
        { timeoutMs: 6_000, label: 'CourseRouteModal rendered in --ascii mode' },
      );
      tty.assertHealthyScreen(routeAscii, 120, 36, 'CourseRouteModal --ascii at 120x36');
      tty.assertAsciiPure(routeAscii, 'CourseRouteModal --ascii at 120x36');
      assert.ok(!routeAscii.includes('╭'), 'ASCII CourseRouteModal must not render Unicode borders');
    } finally {
      useTuiStore.getState().setPreferences({ asciiMode: false });
      await tty.waitFor((s) => s.includes('◈ 课程学习路线') || s.includes('◈ Course Route'), {
        timeoutMs: 6_000,
        label: 'CourseRouteModal restored to Unicode mode',
      });
    }

    tty.send('\r');
    const reviewScreen = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'review' &&
        !s.includes('课程学习路线') &&
        !s.includes('Course Route') &&
        !s.includes('正在准备复习队列') &&
        !s.includes('Preparing review queue') &&
        (s.includes('[h]AI讲解') || s.includes('[h]AI Help') || s.includes('1/')),
      { timeoutMs: 10_000, label: 'ReviewView started from CourseRouteModal' },
    );
    tty.assertHealthyScreen(reviewScreen, 120, 36, 'ReviewView from CourseRouteModal');
    assert.equal(useTuiStore.getState().page, 'review');

    tty.send('q');
    await tty.waitFor((s) => s.includes('结束本轮练习') || s.includes('End This Round'), {
      timeoutMs: 6_000,
      label: 'ReviewView End Round ConfirmDialog',
    });
    tty.send('y');
    await tty.waitFor((s) => s.includes('本轮练习总结') || s.includes('Round Summary'), {
      timeoutMs: 8_000,
      label: 'ReviewView RoundSummary after q -> y',
    });
    tty.send('b');
    const libBack = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'library' &&
        (s.includes('题组列表') || s.includes('Decks')) &&
        s.includes('示例 · Memento 与 Bridge'),
      { timeoutMs: 8_000, label: 'LibraryView after q -> y -> b' },
    );
    tty.assertHealthyScreen(libBack, 120, 36, 'LibraryView after exiting ReviewView');
  });

  test('2) SkeletonView [G] TopicGroupsModal (8 -> G): Tab 1 120x36/80x24/--ascii, Tab 2 create & Ctrl+S persist, Esc close', async () => {
    const { host, tty } = ctx;
    tty.send('8');
    const skelScreen = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'skeleton' &&
        (s.includes('知识层级树') || s.includes('Knowledge Tree')) &&
        !s.includes('正在加载知识骨架') &&
        !s.includes('Loading knowledge skeleton'),
      { timeoutMs: 10_000, label: 'SkeletonView active for TopicGroupsModal' },
    );
    tty.assertHealthyScreen(skelScreen, 120, 36, 'SkeletonView before [G]');

    tty.send('G');
    const groupsWide = await tty.waitFor(
      (s) =>
        (s.includes('主题分组管理') || s.includes('Topic Groups')) &&
        !s.includes('正在加载主题与分组') &&
        !s.includes('Loading topics & groups') &&
        (s.includes('分组列表') || s.includes('Groups')) &&
        (s.includes('已建分组') || s.includes('Groups:')),
      { timeoutMs: 8_000, label: 'TopicGroupsModal Tab 1 at 120x36' },
    );
    tty.assertHealthyScreen(groupsWide, 120, 36, 'TopicGroupsModal Tab 1 at 120x36');
    assert.ok(groupsWide.includes('主题分组管理') || groupsWide.includes('Topic Groups'));

    tty.resize(80, 24);
    const groupsNarrow = await tty.waitFor(
      (s) =>
        (s.includes('主题分组管理') || s.includes('Topic Groups')) &&
        (s.includes('分组列表') || s.includes('Groups')) &&
        s.split('\n').length <= 24,
      { timeoutMs: 6_000, label: 'TopicGroupsModal Tab 1 at 80x24' },
    );
    tty.assertHealthyScreen(groupsNarrow, 80, 24, 'TopicGroupsModal Tab 1 at 80x24');
    assert.ok(groupsNarrow.split('\n').length <= 24);

    tty.resize(120, 36);
    await tty.waitFor(
      (s) =>
        (s.includes('主题分组管理') || s.includes('Topic Groups')) &&
        (s.includes('知识层级树') || s.includes('Knowledge Tree')),
      { timeoutMs: 6_000, label: 'TopicGroupsModal restored to 120x36' },
    );

    useTuiStore.getState().setPreferences({ asciiMode: true });
    try {
      const groupsAscii = await tty.waitFor(
        (s) => (s.includes('# 主题分组管理') || s.includes('# Topic Groups')) && s.includes('esc x') && !s.includes('╭'),
        { timeoutMs: 6_000, label: 'TopicGroupsModal Tab 1 in --ascii mode' },
      );
      tty.assertHealthyScreen(groupsAscii, 120, 36, 'TopicGroupsModal Tab 1 --ascii');
      tty.assertAsciiPure(groupsAscii, 'TopicGroupsModal Tab 1 --ascii');
    } finally {
      useTuiStore.getState().setPreferences({ asciiMode: false });
      await tty.waitFor((s) => s.includes('▦ 主题分组管理') || s.includes('▦ Topic Groups'), {
        timeoutMs: 6_000,
        label: 'TopicGroupsModal restored to Unicode mode',
      });
    }

    tty.send('2');
    const createTab = await tty.waitFor(
      (s) => (s.includes('分组名称:') || s.includes('Group Title:')) && (s.includes('选择包含主题') || s.includes('Select Topics')),
      { timeoutMs: 6_000, label: 'TopicGroupsModal Tab 2 (New Group)' },
    );
    tty.assertHealthyScreen(createTab, 120, 36, 'TopicGroupsModal Tab 2 at 120x36');
    assert.ok(createTab.includes('分组名称:') || createTab.includes('Group Title:'));

    const groupTitle = 'R26Group';
    tty.send(groupTitle);
    await tty.waitFor((s) => s.includes(groupTitle), {
      timeoutMs: 5_000,
      label: 'Group title typed in Tab 2',
    });

    tty.send('\t');
    await tty.flush(40);
    tty.send(' ');
    await tty.waitFor(
      (s) => (s.includes('已选 1') || s.includes('1 selected')) && (s.includes('[✓]') || s.includes('[x]')),
      { timeoutMs: 5_000, label: 'First topic selected via Space' },
    );

    tty.send('\x13');
    const savedGroupsView = await tty.waitFor(
      (s) =>
        !s.includes('正在保存分组') &&
        !s.includes('Saving topic group') &&
        (s.includes('已建分组') || s.includes('Groups:')) &&
        s.includes(groupTitle),
      { timeoutMs: 8_000, label: 'TopicGroupsModal returned to Tab 1 with saved group' },
    );
    tty.assertHealthyScreen(savedGroupsView, 120, 36, 'TopicGroupsModal after saving R26Group');
    assert.ok(savedGroupsView.includes(groupTitle), 'Saved group must appear in Tab 1 list');

    const activeCourse = useTuiStore.getState().activeCourse;
    const topicsRes = await host.call('skeleton.topics', activeCourse ? { course: activeCourse } : {});
    assert.equal(topicsRes.ok, true, 'skeleton.topics must succeed after saving group');
    const persistedGroups = topicsRes.value?.groups?.groups ?? [];
    const savedEntry = persistedGroups.find((g) => g.title === groupTitle);
    assert.ok(savedEntry, `Expected persisted group "${groupTitle}" in skeleton.topics, got ${JSON.stringify(persistedGroups)}`);
    assert.ok(Array.isArray(savedEntry.topics) && savedEntry.topics.length >= 1, 'Persisted group must contain at least 1 topic');

    tty.send('\x1b');
    const afterEsc = await tty.waitFor(
      (s) =>
        !s.includes('主题分组管理') &&
        !s.includes('Topic Groups') &&
        (s.includes('知识层级树') || s.includes('Knowledge Tree')),
      { timeoutMs: 6_000, label: 'TopicGroupsModal closed via Esc' },
    );
    tty.assertHealthyScreen(afterEsc, 120, 36, 'SkeletonView after TopicGroupsModal Esc');
    assert.ok(!afterEsc.includes('主题分组管理') && !afterEsc.includes('Topic Groups'));
  });

  test('3) SkeletonView [E] NodeEditModal (8 -> E): 120x36, 80x24, --ascii purity, edit term & Ctrl+S persist', async () => {
    const { host, tty } = ctx;
    if (useTuiStore.getState().page !== 'skeleton') {
      tty.send('8');
    }
    const skelScreen = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'skeleton' &&
        (s.includes('知识层级树') || s.includes('Knowledge Tree')) &&
        !s.includes('正在加载知识骨架') &&
        !s.includes('Loading knowledge skeleton') &&
        (s.includes('释义:') || s.includes('Description:')),
      { timeoutMs: 8_000, label: 'SkeletonView active for NodeEditModal' },
    );
    tty.assertHealthyScreen(skelScreen, 120, 36, 'SkeletonView before [E]');

    const activeCourse = useTuiStore.getState().activeCourse;
    const listRes = await host.call('skeleton.list', activeCourse ? { course: activeCourse } : {});
    assert.equal(listRes.ok, true, 'skeleton.list must succeed');
    const skeletonId = listRes.value?.skeletons?.[0]?.id;
    assert.ok(skeletonId, 'Expected at least one skeleton in sample course');
    const beforeSkelRes = await host.call('skeleton.get', { id: skeletonId });
    assert.equal(beforeSkelRes.ok, true, 'skeleton.get before edit must succeed');

    // Round 79: NodeEditModal clean Esc closes immediately; dirty Esc opens ConfirmDialog
    tty.send('E');
    await tty.waitFor((s) => (s.includes('编辑知识节点') || s.includes('Edit Knowledge Node')) && !s.includes('未保存'), {
      timeoutMs: 8_000,
      label: 'NodeEditModal opened clean for dirty-Esc check',
    });
    tty.send('\x1b');
    await tty.waitFor((s) => !s.includes('编辑知识节点') && !s.includes('Edit Knowledge Node'), {
      timeoutMs: 5_000,
      label: 'Clean NodeEditModal Esc closed immediately',
    });
    tty.send('E');
    await tty.waitFor((s) => s.includes('编辑知识节点') || s.includes('Edit Knowledge Node'), {
      timeoutMs: 8_000,
      label: 'NodeEditModal reopened for dirty-Esc check',
    });
    tty.send(' R79_TMP');
    await tty.waitFor((s) => s.includes('R79_TMP') && s.includes('未保存'), {
      timeoutMs: 5_000,
      label: 'NodeEditModal shows unsaved badge',
    });
    tty.send('\x1b');
    const nodeDiscardDialog = await tty.waitFor((s) => s.includes('放弃未保存的节点修改'), {
      timeoutMs: 5_000,
      label: 'NodeEditModal dirty Esc opened ConfirmDialog',
    });
    tty.assertHealthyScreen(nodeDiscardDialog, 120, 36, 'NodeEditModal discard ConfirmDialog');
    tty.send('n');
    await tty.waitFor(
      (s) => !s.includes('放弃未保存的节点修改') && (s.includes('编辑知识节点') || s.includes('Edit Knowledge Node')) && s.includes('R79_TMP'),
      { timeoutMs: 5_000, label: 'NodeEditModal discard cancel preserved edit' },
    );
    tty.send('\x1b');
    await tty.waitFor((s) => s.includes('放弃未保存的节点修改'), {
      timeoutMs: 5_000,
      label: 'NodeEditModal discard ConfirmDialog reopened',
    });
    tty.send('y');
    await tty.waitFor((s) => !s.includes('编辑知识节点') && !s.includes('Edit Knowledge Node') && !s.includes('放弃未保存的节点修改'), {
      timeoutMs: 5_000,
      label: 'NodeEditModal confirm discard closed cleanly',
    });

    tty.send('E');
    const editWide = await tty.waitFor(
      (s) => (s.includes('编辑知识节点') || s.includes('Edit Knowledge Node')) && (s.includes('概念名称') || s.includes('Node Term:')),
      { timeoutMs: 6_000, label: 'NodeEditModal opened at 120x36' },
    );
    tty.assertHealthyScreen(editWide, 120, 36, 'NodeEditModal at 120x36');
    assert.ok(editWide.includes('编辑知识节点') || editWide.includes('Edit Knowledge Node'));

    const targetNode =
      beforeSkelRes.value.nodes.find((n) => editWide.includes(n.id)) ?? beforeSkelRes.value.nodes[0];
    assert.ok(targetNode, 'Expected target skeleton node to edit');
    const expectedTerm = `${targetNode.term} R26`;

    tty.resize(80, 24);
    const editNarrow = await tty.waitFor(
      (s) => (s.includes('编辑知识节点') || s.includes('Edit Knowledge Node')) && s.split('\n').length <= 24,
      { timeoutMs: 6_000, label: 'NodeEditModal at 80x24' },
    );
    tty.assertHealthyScreen(editNarrow, 80, 24, 'NodeEditModal at 80x24');
    assert.ok(editNarrow.split('\n').length <= 24);

    tty.resize(120, 36);
    await tty.waitFor(
      (s) =>
        (s.includes('编辑知识节点') || s.includes('Edit Knowledge Node')) &&
        (s.includes('知识层级树') || s.includes('Knowledge Tree')),
      { timeoutMs: 6_000, label: 'NodeEditModal restored to 120x36' },
    );

    useTuiStore.getState().setPreferences({ asciiMode: true });
    try {
      const editAscii = await tty.waitFor(
        (s) => (s.includes('* 编辑知识节点') || s.includes('* Edit Knowledge Node')) && s.includes('esc x') && !s.includes('╭'),
        { timeoutMs: 6_000, label: 'NodeEditModal in --ascii mode' },
      );
      tty.assertHealthyScreen(editAscii, 120, 36, 'NodeEditModal --ascii at 120x36');
      tty.assertAsciiPure(editAscii, 'NodeEditModal --ascii at 120x36');
      assert.ok(editAscii.includes('esc x'));
    } finally {
      useTuiStore.getState().setPreferences({ asciiMode: false });
      await tty.waitFor((s) => s.includes('✎ 编辑知识节点') || s.includes('✎ Edit Knowledge Node'), {
        timeoutMs: 6_000,
        label: 'NodeEditModal restored to Unicode mode',
      });
    }

    tty.send(' R26');
    await tty.waitFor((s) => s.includes('R26'), {
      timeoutMs: 5_000,
      label: 'NodeEditModal term suffix R26 typed',
    });
    tty.send('\x13');

    const afterSave = await tty.waitFor(
      (s) =>
        !s.includes('编辑知识节点') &&
        !s.includes('Edit Knowledge Node') &&
        !s.includes('正在保存节点') &&
        s.includes(expectedTerm) &&
        (s.includes('知识层级树') || s.includes('Knowledge Tree')),
      { timeoutMs: 8_000, label: 'SkeletonView updated with patched node term' },
    );
    tty.assertHealthyScreen(afterSave, 120, 36, 'SkeletonView after NodeEditModal Ctrl+S');
    assert.ok(afterSave.includes(expectedTerm), 'SkeletonView must reflect patched node term');

    const afterSkelRes = await host.call('skeleton.get', { id: skeletonId });
    assert.equal(afterSkelRes.ok, true, 'skeleton.get after patch must succeed');
    const patchedNode = afterSkelRes.value?.nodes?.find((n) => n.id === targetNode.id);
    assert.ok(patchedNode, `Expected node ${targetNode.id} in skeleton.get response`);
    assert.equal(
      patchedNode.term,
      expectedTerm,
      `Expected persisted node.term to equal "${expectedTerm}", got "${patchedNode.term}"`,
    );
  });
});

describe('Round 31: Oral Mock Exam, Skeleton Invalid-JSON Refusal, ExamCoach Flow & Pomodoro Persistence', () => {
  let ctx;
  let modelCallCount = 0;
  let skeletonStreamCalls = 0;
  let skeletonStubResponse = 'not json at all';

  before(async () => {
    ctx = await mountSuiteApp('r31', {
      injectedComplete: async (system, prompt, execution = {}) => {
        if (String(prompt || '').includes('OK?')) return 'OK';
        execution.signal?.throwIfAborted?.();
        modelCallCount += 1;

        const sysText = String(system || '');
        const promptText = String(prompt || '');

        if (sysText.includes('Design a hierarchical knowledge skeleton')) {
          skeletonStreamCalls += 1;
          execution.onOutput?.(skeletonStubResponse);
          return skeletonStubResponse;
        }

        if (sysText.includes('Assess a completed technical oral mock interview')) {
          let questions = [];
          try {
            const parsed = JSON.parse(promptText);
            questions = Array.isArray(parsed?.questions) ? parsed.questions : [];
          } catch {
            questions = [];
          }
          const reply = JSON.stringify({
            results: questions.map((q) => ({
              cardId: q.cardId,
              band: 'strong',
              grade: 4,
              fragmentsOnly: false,
              reason: 'Clear mechanism and accurate boundary reasoning.',
            })),
          });
          execution.onOutput?.(reply);
          return reply;
        }

        const fallback = JSON.stringify({ status: 'ok', title: 'Stub', overview: 'Stub', nodes: [], relations: [] });
        execution.onOutput?.(fallback);
        return fallback;
      },
    });
  });

  after(async () => {
    await ctx?.dispose();
  });

  test('1) Oral Mock Exam E2E (5 -> 3 -> Enter -> answer -> submit -> Oral ExamReportView -> b)', async () => {
    const { tty } = ctx;
    tty.send('5');
    const setupScreen = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'exam' &&
        (s.includes('组卷设置') || s.includes('Exam Setup')) &&
        !s.includes('正在加载页面'),
      { timeoutMs: 8_000, label: 'ExamView setup rendered' },
    );
    tty.assertHealthyScreen(setupScreen, 120, 36, 'ExamSetup initial');
    assert.equal(useTuiStore.getState().page, 'exam');

    tty.send('3');
    const oralSetupScreen = await tty.waitFor(
      (s) =>
        (s.includes('[c] 口试题数') || s.includes('[c] Questions:')) &&
        (s.includes('示例') || s.includes('当前课程') || s.includes('全部激活课程')),
      { timeoutMs: 6_000, label: 'ExamSetup Oral Mock scope choices' },
    );
    assert.ok(
      !oralSetupScreen.includes('暂无可用考题') && !oralSetupScreen.includes('No eligible exam questions'),
      `Oral mode must show real scope choices (P1 #2 count fix), got:\n${oralSetupScreen}`,
    );
    tty.assertHealthyScreen(oralSetupScreen, 120, 36, 'ExamSetup Oral mode');

    tty.send('\r');
    const oralRunner120 = await tty.waitFor(
      (s) =>
        (s.includes('口试模拟') || s.includes('Oral Mock')) &&
        (s.includes('你的回答') || s.includes('Your answer')) &&
        !s.includes('组卷设置'),
      { timeoutMs: 8_000, label: 'Oral ExamRunner at 120x36' },
    );
    tty.assertHealthyScreen(oralRunner120, 120, 36, 'Oral ExamRunner at 120x36');
    assert.ok(oralRunner120.includes('口试模拟') || oralRunner120.includes('Oral Mock'));

    tty.resize(80, 24);
    const oralRunner80 = await tty.waitFor(
      (s) => (s.includes('口试模拟') || s.includes('Oral Mock')) && s.split('\n').length <= 24,
      { timeoutMs: 6_000, label: 'Oral ExamRunner at 80x24' },
    );
    tty.assertHealthyScreen(oralRunner80, 80, 24, 'Oral ExamRunner at 80x24');
    assert.ok(oralRunner80.split('\n').length <= 24);

    tty.resize(120, 36);
    await tty.waitFor(
      (s) => (s.includes('口试模拟') || s.includes('Oral Mock')) && (s.includes('你的回答') || s.includes('Your answer')),
      { timeoutMs: 6_000, label: 'Oral ExamRunner restored to 120x36' },
    );

    tty.send('e');
    await tty.waitFor((s) => s.includes('口述作答') || s.includes('Editing answer'), {
      timeoutMs: 5_000,
      label: 'Oral answer editor opened',
    });

    const oralAnswerText = 'Memento captures internal state without exposing representation.';
    tty.send(oralAnswerText);
    await tty.waitFor((s) => s.includes('Memento captures internal state'), {
      timeoutMs: 5_000,
      label: 'Oral answer typed',
    });

    tty.send('\x13');
    const afterSave = await tty.waitFor(
      (s) =>
        !s.includes('口述作答') &&
        !s.includes('Editing answer') &&
        s.includes('Memento captures internal state') &&
        (s.includes('已答 1/') || s.includes('Ans 1/')),
      { timeoutMs: 6_000, label: 'Oral answer saved' },
    );
    tty.assertHealthyScreen(afterSave, 120, 36, 'Oral ExamRunner after saving Q1');
    assert.ok(afterSave.includes('已答 1/') || afterSave.includes('Ans 1/'));

    tty.send('\x13');
    await tty.waitFor((s) => s.includes('确认交卷') || s.includes('Submit Exam'), {
      timeoutMs: 5_000,
      label: 'Oral submit ConfirmDialog',
    });

    tty.send('y');
    const oralReportScreen = await tty.waitFor(
      (s) =>
        (s.includes('口试评估报告') || s.includes('Oral Report')) &&
        (s.includes('解析与详情') || s.includes('Review Detail')),
      { timeoutMs: 10_000, label: 'Oral ExamReportView rendered' },
    );
    tty.assertHealthyScreen(oralReportScreen, 120, 36, 'Oral ExamReportView');
    assert.ok(
      oralReportScreen.includes('优秀 1') || oralReportScreen.includes('Strong 1') || oralReportScreen.includes('1/'),
      `Expected Oral ExamReportView to show assessed summary, got:\n${oralReportScreen}`,
    );

    tty.send('b');
    const backToSetup = await tty.waitFor(
      (s) =>
        (s.includes('组卷设置') || s.includes('Exam Setup')) &&
        !s.includes('口试评估报告') &&
        !s.includes('Oral Report'),
      { timeoutMs: 6_000, label: 'Return to ExamSetup via b' },
    );
    tty.assertHealthyScreen(backToSetup, 120, 36, 'ExamSetup after oral report');
    assert.ok(backToSetup.includes('组卷设置') || backToSetup.includes('Exam Setup'));
  });

  test('2) Skeleton Generation Confirm + Invalid-JSON Safe Refusal (8 -> g -> y)', async () => {
    const { host, tty } = ctx;
    tty.send('8');
    const skelScreen = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'skeleton' &&
        (s.includes('知识层级树') || s.includes('Knowledge Tree')) &&
        !s.includes('正在加载知识骨架') &&
        !s.includes('Loading knowledge skeleton'),
      { timeoutMs: 8_000, label: 'SkeletonView rendered' },
    );
    tty.assertHealthyScreen(skelScreen, 120, 36, 'SkeletonView initial');

    const beforeListRes = await host.call('skeleton.list', {});
    assert.equal(beforeListRes.ok, true, 'skeleton.list must succeed before generation test');
    const beforeItems = extractSkeletonItems(beforeListRes);
    assert.ok(beforeItems.length >= 1, `Sample course must have at least 1 skeleton, got ${beforeItems.length}`);
    const firstBefore = beforeItems[0];

    skeletonStubResponse = 'not json at all';
    const callsBefore = skeletonStreamCalls;

    tty.send('g');
    const confirmScreen = await tty.waitFor(
      (s) => s.includes('确认生成知识骨架') || s.includes('Confirm Skeleton Generation'),
      { timeoutMs: 6_000, label: 'Skeleton generation ConfirmDialog' },
    );
    assert.equal(skeletonStreamCalls, callsBefore, 'Pressing g must open ConfirmDialog without calling streamComplete');
    tty.assertHealthyScreen(confirmScreen, 120, 36, 'Skeleton ConfirmDialog');

    tty.send('y');
    const afterRefusal = await tty.waitFor(
      (s) =>
        skeletonStreamCalls === callsBefore + 1 &&
        !s.includes('确认生成知识骨架') &&
        (s.includes('格式无效') ||
          s.includes('could not be parsed') ||
          useTuiStore
            .getState()
            .toasts.some((toast) => toast.tone === 'error' && (toast.text.includes('格式无效') || toast.text.includes('could not be parsed')))),
      { timeoutMs: 8_000, label: 'Skeleton invalid-JSON safe refusal feedback' },
    );
    tty.assertHealthyScreen(afterRefusal, 120, 36, 'SkeletonView after invalid-JSON refusal');

    const errorToast = useTuiStore
      .getState()
      .toasts.find((toast) => toast.tone === 'error' && (toast.text.includes('格式无效') || toast.text.includes('could not be parsed')));
    assert.ok(errorToast, 'Expected error toast notifying that invalid skeleton output was not saved');
    assert.ok(
      afterRefusal.includes('知识层级树') || afterRefusal.includes('Knowledge Tree'),
      'Existing skeleton tree view must remain intact after safe refusal',
    );

    const afterListRes = await host.call('skeleton.list', {});
    assert.equal(afterListRes.ok, true);
    const afterItems = extractSkeletonItems(afterListRes);
    assert.equal(
      afterItems.length,
      beforeItems.length,
      `Skeleton count must remain ${beforeItems.length} after invalid JSON refusal, got ${afterItems.length}`,
    );
    assert.equal(afterItems[0]?.id, firstBefore?.id, 'Existing skeleton ID must not be overwritten');
    assert.equal(afterItems[0]?.title, firstBefore?.title, 'Existing skeleton title must not be overwritten');
    assert.equal(
      Array.isArray(afterItems[0]?.nodes) ? afterItems[0].nodes.length : afterItems[0]?.nodes,
      Array.isArray(firstBefore?.nodes) ? firstBefore.nodes.length : firstBefore?.nodes,
      'Existing skeleton nodes must not be replaced by mechanical topic merging',
    );
  });

  test('3) ExamCoach (9) Full Flow: Note save without auto-AI + A ConfirmDialog + Tab 4 Strict Mock', async () => {
    const { tty } = ctx;
    tty.send('9');
    const coachScreen = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'examcoach' &&
        (s.includes('考试教练') || s.includes('Exam Coach')) &&
        (s.includes('校准与考法') || s.includes('Calibration')) &&
        !s.includes('正在加载页面') &&
        !s.includes('Loading view'),
      { timeoutMs: 8_000, label: 'ExamCoachView rendered' },
    );
    tty.assertHealthyScreen(coachScreen, 120, 36, 'ExamCoachView Tab 1');
    assert.equal(useTuiStore.getState().page, 'examcoach');

    const callsBeforeCoach = modelCallCount;

    tty.send('N');
    await tty.waitFor((s) => s.includes('提交往年样卷') || s.includes('Submit Past-Paper'), {
      timeoutMs: 6_000,
      label: 'ExamCoach Note modal opened',
    });

    tty.send('2025 Mock focus: Memento state snapshot vs Command undo history.');
    await tty.waitFor((s) => s.includes('2025 Mock focus'), {
      timeoutMs: 5_000,
      label: 'ExamCoach note text typed',
    });

    tty.send('\x13');
    const afterNoteSave = await tty.waitFor(
      (s) =>
        !s.includes('提交往年样卷') &&
        !s.includes('Submit Past-Paper') &&
        (s.includes('已保存教练笔记') ||
          s.includes('Coach note saved') ||
          useTuiStore
            .getState()
            .toasts.some((toast) => toast.text.includes('已保存教练笔记') || toast.text.includes('Coach note saved'))),
      { timeoutMs: 8_000, label: 'ExamCoach note saved feedback' },
    );
    assert.equal(modelCallCount, callsBeforeCoach, 'Saving coach note must NOT automatically call AI model');
    tty.assertHealthyScreen(afterNoteSave, 120, 36, 'ExamCoachView after note save');
    assert.ok(!afterNoteSave.includes('提交往年样卷'));

    tty.send('A');
    const aiConfirmScreen = await tty.waitFor(
      (s) => s.includes('确认 AI 深化分析考法') || s.includes('Confirm AI Exam Analysis'),
      { timeoutMs: 6_000, label: 'ExamCoach A ConfirmDialog' },
    );
    assert.equal(modelCallCount, callsBeforeCoach, 'Pressing A must open ConfirmDialog without calling AI model');
    tty.assertHealthyScreen(aiConfirmScreen, 120, 36, 'ExamCoach A ConfirmDialog');
    assert.ok(aiConfirmScreen.includes('确认 AI 深化分析考法') || aiConfirmScreen.includes('Confirm AI Exam Analysis'));

    tty.send('n');
    await tty.waitFor((s) => !s.includes('确认 AI 深化分析考法') && !s.includes('Confirm AI Exam Analysis'), {
      timeoutMs: 6_000,
      label: 'ExamCoach A ConfirmDialog cancelled',
    });
    assert.equal(modelCallCount, callsBeforeCoach, 'Cancelling A ConfirmDialog must NOT call AI model');

    tty.send('4');
    const mockTabScreen = await tty.waitFor(
      (s) =>
        s.includes('按校准配置编译出题与严格同型组卷检查') ||
        s.includes('Compiled Calibration & Strict Mock Check'),
      { timeoutMs: 6_000, label: 'ExamCoach Tab 4 rendered' },
    );
    tty.assertHealthyScreen(mockTabScreen, 120, 36, 'ExamCoach Tab 4 initial');
    assert.ok(mockTabScreen.includes('按校准配置编译出题与严格同型组卷检查') || mockTabScreen.includes('Compiled Calibration & Strict Mock Check'));

    tty.send('m');
    const mockResultScreen = await tty.waitFor(
      (s) =>
        s.includes('可完整组成严格同型模拟卷') ||
        s.includes('结构缺口') ||
        s.includes('Ready to compose') ||
        s.includes('structural shortfall'),
      { timeoutMs: 8_000, label: 'ExamCoach Tab 4 strict mock composition result' },
    );
    assert.equal(modelCallCount, callsBeforeCoach, 'Strict mock composition check must remain 0-token');
    tty.assertHealthyScreen(mockResultScreen, 120, 36, 'ExamCoach Tab 4 strict mock result');
    assert.ok(
      mockResultScreen.includes('可完整组成严格同型模拟卷') ||
        mockResultScreen.includes('结构缺口') ||
        mockResultScreen.includes('Ready to compose') ||
        mockResultScreen.includes('structural shortfall'),
    );
  });

  test('4) Board Pomodoro Persistence Across View Switches (b -> P -> 1 -> b)', async () => {
    const { tty } = ctx;
    tty.send('6');
    await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'dashboard' &&
        (s.includes('薄弱点') || s.includes('热力图') || s.includes('Analytics') || s.includes('Weak')) &&
        !s.includes('正在加载页面') &&
        !s.includes('Loading view'),
      { timeoutMs: 6_000, label: 'Navigated to DashboardView before BoardView' },
    );

    tty.send('b');
    const boardInitial = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'board' &&
        (s.includes('专注 Focus') || s.includes('Focus')) &&
        s.includes('25:00'),
      { timeoutMs: 8_000, label: 'BoardView rendered with 25:00 Pomodoro' },
    );
    tty.assertHealthyScreen(boardInitial, 120, 36, 'BoardView initial');
    assert.equal(useTuiStore.getState().page, 'board');

    tty.send('P');
    const boardTicked = await tty.waitFor(
      (s) =>
        useTuiStore.getState().pomodoro.running === true &&
        useTuiStore.getState().pomodoro.remainingSec < 25 * 60 &&
        !s.includes('25:00') &&
        /24:5\d/.test(s),
      { timeoutMs: 4_000, label: 'Pomodoro ticked below 25:00' },
    );
    const remBeforeSwitch = useTuiStore.getState().pomodoro.remainingSec;
    tty.assertHealthyScreen(boardTicked, 120, 36, 'BoardView Pomodoro running');
    assert.ok(remBeforeSwitch < 25 * 60, 'Pomodoro remainingSec must decrement below 25:00');

    tty.send('1');
    await tty.waitFor(
      (s) => useTuiStore.getState().page === 'library' && (s.includes('题组列表') || s.includes('Decks')),
      { timeoutMs: 6_000, label: 'Switched to LibraryView while Pomodoro running' },
    );

    await tty.flush(1150);

    tty.send('b');
    const boardReturned = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'board' &&
        (s.includes('专注 Focus') || s.includes('Focus')) &&
        useTuiStore.getState().pomodoro.remainingSec < remBeforeSwitch &&
        /24:5\d/.test(s),
      { timeoutMs: 6_000, label: 'Returned to BoardView with persisted Pomodoro' },
    );
    const pomAfterReturn = useTuiStore.getState().pomodoro;
    assert.equal(pomAfterReturn.running, true, 'Pomodoro must still be running after switching views');
    assert.notEqual(pomAfterReturn.endsAt, null, 'Pomodoro endsAt must remain set while running');
    assert.ok(
      pomAfterReturn.remainingSec < remBeforeSwitch,
      `Pomodoro must continue counting down across view switches (before=${remBeforeSwitch}, after=${pomAfterReturn.remainingSec})`,
    );
    assert.ok(
      !boardReturned.includes('25:00') && (boardReturned.includes('▶') || boardReturned.includes('> 专注')),
      `BoardView must show running Pomodoro below 25:00, got:\n${boardReturned}`,
    );
    tty.assertHealthyScreen(boardReturned, 120, 36, 'BoardView after view switch');

    tty.send('P');
    await tty.waitFor(
      (s) => useTuiStore.getState().pomodoro.running === false && (s.includes('⏸') || s.includes('||')),
      { timeoutMs: 4_000, label: 'Pomodoro paused cleanly' },
    );

    tty.send('R');
    const boardReset = await tty.waitFor(
      (s) => useTuiStore.getState().pomodoro.remainingSec === 25 * 60 && s.includes('25:00'),
      { timeoutMs: 4_000, label: 'Pomodoro reset to 25:00 cleanly' },
    );
    tty.assertHealthyScreen(boardReset, 120, 36, 'BoardView after Pomodoro reset');
  });
});

const BOOK_COURSE = 'StructArch';

async function seedBookLibrary(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.store.update((state) => {
    state.sources.push(
      {
        id: 'doc1-p1',
        title: 'Lecture 1 · p. 1',
        createdAt: '2026-10-01T00:00:00.000Z',
        courses: [BOOK_COURSE],
        text: 'Alpha Architecture defines components and connectors.',
        document: {
          materialId: 'doc-l1',
          page: 1,
          totalPages: 2,
          format: 'pdf',
          origin: 'converted',
          converter: 'marker',
          filename: 'lecture-1.pdf',
          chapter: { index: 0, title: 'Alpha Basics', level: 1 },
          extractionVersion: 2,
        },
      },
      {
        id: 'doc1-p2',
        title: 'Lecture 1 · p. 2',
        createdAt: '2026-10-01T01:00:00.000Z',
        courses: [BOOK_COURSE],
        text: 'Beta Boundaries separate domain rules from infrastructure.',
        document: {
          materialId: 'doc-l1',
          page: 2,
          totalPages: 2,
          format: 'pdf',
          origin: 'converted',
          converter: 'marker',
          filename: 'lecture-1.pdf',
          chapter: { index: 1, title: 'Beta Boundaries', level: 1 },
          extractionVersion: 2,
        },
      },
    );
    state.focus = { mode: 'class', course: BOOK_COURSE, role: '', jd: '', targetTopics: [] };
    const lecture = groupSourcesByDocument(state.sources).find((item) => item.sourceIds.includes('doc1-p1')).key;
    const leaves = [
      { id: 'alpha', title: 'Alpha Basics', anchors: [`${lecture}#0`] },
      { id: 'beta', title: 'Beta Boundaries', anchors: [`${lecture}#1`] },
    ];
    const outline = {
      ...courseOutlineMaterial({
        title: 'Outline · StructArch',
        course: BOOK_COURSE,
        orderBasis: { codes: ['numbering'] },
        fingerprint: materialsFingerprint(buildOutlineIndex(state, { course: BOOK_COURSE }).allDocuments),
        nodes: [{ id: 'ch1', title: 'Core Architecture', children: leaves }],
        other: { anchors: [] },
        counts: { units: 2, leftover: 0, invalid: 0, repeated: 0 },
      }),
      createdAt: '2026-10-09T00:00:00.000Z',
    };
    state.sources.push(outline);
    state.sources.push({
      ...courseNotesMaterial({
        title: 'Review Book · StructArch',
        course: BOOK_COURSE,
        outlineId: outline.id,
        language: 'zh',
        papers: [],
        counts: {},
        leaves: leaves.map((leaf, idx) => ({
          ...leaf,
          body: {
            fingerprint: 'a'.repeat(16),
            points: [`${leaf.title} key point [^1].`],
            explain: `Detailed notes for ${leaf.title}.`,
            cites: [{ n: 1, sourceId: idx === 0 ? 'doc1-p1' : 'doc1-p2', quote: 'Alpha', start: 0, end: 5 }],
          },
        })),
      }),
      createdAt: '2026-10-09T01:00:00.000Z',
    });
    openCourseBook(state, { course: BOOK_COURSE });
    const record = state.sources.find((s) => s.provenance === 'course-book-doc');
    record.bookDoc.files['beta.mine.md'] = { version: 1, text: 'My custom note on Beta Boundaries.' };
  });
  await service.dispose();
}

describe('Round 34: BookView Structure Management Host Integration & PTY E2E', () => {
  test('1) createTuiHost integration: course.book.open -> rename -> move -> delete -> revert -> rebuild undo', async () => {
    const base = await temps.make('r34-host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');
    await seedBookLibrary(libraryRoot);

    let host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
    });

    try {
      const open0 = await host.call('course.book.open', { course: BOOK_COURSE, language: 'zh' });
      assert.equal(open0.ok, true, open0.error?.message);
      assert.equal(open0.value.status, 'ok');
      assert.ok(Number.isInteger(open0.value.structureVersion) && open0.value.structureVersion >= 1);
      const v0 = open0.value.structureVersion;
      const ch = open0.value.nodes[0];
      assert.equal(ch.children.length, 2);
      const [alpha, beta] = ch.children;

      const renamed = await host.call('course.book.rename', {
        course: BOOK_COURSE,
        hid: alpha.hid,
        title: 'Alpha Foundations',
        version: v0,
      });
      assert.equal(renamed.ok, true, renamed.error?.message);
      assert.equal(renamed.value.write, 'renamed');
      assert.equal(renamed.value.structureVersion, v0 + 1);

      const open1 = await host.call('course.book.open', { course: BOOK_COURSE, language: 'zh' });
      assert.equal(open1.ok, true);
      assert.equal(open1.value.nodes[0].children[0].title, 'Alpha Foundations');

      const moved = await host.call('course.book.move', {
        course: BOOK_COURSE,
        hid: beta.hid,
        beforeHid: alpha.hid,
        version: renamed.value.structureVersion,
      });
      assert.equal(moved.ok, true, moved.error?.message);
      assert.equal(moved.value.write, 'moved');
      assert.equal(moved.value.structureVersion, v0 + 2);

      const open2 = await host.call('course.book.open', { course: BOOK_COURSE, language: 'zh' });
      assert.equal(open2.ok, true);
      assert.equal(open2.value.nodes[0].children[0].hid, beta.hid);
      assert.equal(open2.value.nodes[0].children[1].hid, alpha.hid);

      const deleted = await host.call('course.book.delete', {
        course: BOOK_COURSE,
        hid: beta.hid,
        children: 'promote',
        version: moved.value.structureVersion,
      });
      assert.equal(deleted.ok, true, deleted.error?.message);
      assert.equal(deleted.value.write, 'deleted');
      assert.equal(deleted.value.structureVersion, v0 + 3);

      const open3 = await host.call('course.book.open', { course: BOOK_COURSE, language: 'zh' });
      assert.equal(open3.ok, true);
      assert.equal(open3.value.nodes[0].children.length, 1);
      assert.equal(open3.value.nodes[0].children[0].hid, alpha.hid);
      assert.match(open3.value.unplaced?.text ?? '', /My custom note on Beta Boundaries/);

      const reverted = await host.call('course.book.revert', {
        course: BOOK_COURSE,
        file: 'book.structure',
      });
      assert.equal(reverted.ok, true, reverted.error?.message);
      assert.equal(reverted.value.write, 'reverted');

      const open4 = await host.call('course.book.open', { course: BOOK_COURSE, language: 'zh' });
      assert.equal(open4.ok, true);
      assert.equal(open4.value.nodes[0].children.length, 2);
      assert.equal(open4.value.nodes[0].children[0].hid, beta.hid);

      await host.dispose();
      const service = new StudyService(libraryRoot);
      await service.call('snapshot');
      await service.store.update((state) => {
        const lecture = groupSourcesByDocument(state.sources).find((item) => item.sourceIds.includes('doc1-p1')).key;
        const rebuiltOutline = {
          ...courseOutlineMaterial({
            title: 'Outline · StructArch v2',
            course: BOOK_COURSE,
            orderBasis: { codes: ['numbering'] },
            fingerprint: materialsFingerprint(buildOutlineIndex(state, { course: BOOK_COURSE }).allDocuments),
            nodes: [{ id: 'ch1', title: 'Core Architecture', children: [{ id: 'alpha', title: 'Alpha Renamed By Outline', anchors: [`${lecture}#0`] }] }],
            other: { anchors: [] },
            counts: { units: 1, leftover: 0, invalid: 0, repeated: 0 },
          }),
          createdAt: '2026-10-10T00:00:00.000Z',
        };
        const oldOutline = state.sources.find((s) => s.provenance === 'course-outline' && !s.archived);
        if (oldOutline) oldOutline.archived = true;
        state.sources.push(rebuiltOutline);
      });
      await service.dispose();

      host = await createTuiHost({
        libraryRoot,
        env,
        home: base,
        documentsDir: base,
        skipAutoProbe: true,
        language: 'zh',
      });

      const pendingOpen = await host.call('course.book.open', { course: BOOK_COURSE, language: 'zh' });
      assert.equal(pendingOpen.ok, true);
      assert.equal(pendingOpen.value.status, 'rebuild-pending');
      const outlineId = pendingOpen.value.moves?.outlineId ?? pendingOpen.value.rebuildPending?.outlineId;
      assert.ok(outlineId, 'pending outlineId must be returned');

      const undone = await host.call('course.book.rebuild', { course: BOOK_COURSE, action: 'undo', outlineId });
      assert.equal(undone.ok, true, undone.error?.message);

      const afterUndo = await host.call('course.book.open', { course: BOOK_COURSE, language: 'zh' });
      assert.equal(afterUndo.ok, true);
      assert.equal(afterUndo.value.status, 'ok');
      assert.equal(afterUndo.value.nodes[0].children.length, 2);
    } finally {
      await host.dispose();
    }
  });

  test('2) PTY E2E: BookView (7) -> R (BookStructureModal Esc & Rename) -> D (ConfirmDialog n cancel)', async () => {
    resetDistStore('zh', false);
    const base = await temps.make('r34-pty');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');
    await seedBookLibrary(libraryRoot);

    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
    const host = await createTuiHost({
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
      await tty.waitFor((s) => s.includes('StructArch') || s.includes('学习库'), { label: 'App initial load' });

      tty.send('7');
      const bookScreen = await tty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'book' &&
          s.includes('Core Architecture') &&
          s.includes('Alpha Basics') &&
          !s.includes('正在打开复习全书'),
        { label: 'BookView rendered with TOC' },
      );
      tty.assertHealthyScreen(bookScreen, 120, 36, 'BookView TOC');

      tty.send('[');
      await tty.waitFor((s) => s.includes('已经是同级第一个节点'), { label: 'Boundary move toast' });

      tty.send('R');
      const modalWide = await tty.waitFor(
        (s) => s.includes('重命名目录节点') && s.includes('Core Architecture'),
        { label: 'BookStructureModal opened' },
      );
      tty.assertHealthyScreen(modalWide, 120, 36, 'BookStructureModal 120x36');
      assert.ok(modalWide.includes('重命名目录节点'));

      tty.resize(80, 24);
      const modalNarrow = await tty.waitFor(
        (s) => s.includes('重命名目录节点') && s.split('\n').length <= 24,
        { label: 'BookStructureModal at 80x24' },
      );
      tty.assertHealthyScreen(modalNarrow, 80, 24, 'BookStructureModal 80x24');
      assert.ok(modalNarrow.split('\n').length <= 24);

      tty.resize(120, 36);
      await tty.waitFor((s) => s.includes('重命名目录节点'), { label: 'BookStructureModal restored 120x36' });

      tty.send('\x1b');
      const afterRenameEsc = await tty.waitFor(
        (s) => !s.includes('重命名目录节点') && s.includes('Core Architecture'),
        { label: 'BookStructureModal closed on Esc' },
      );
      tty.assertHealthyScreen(afterRenameEsc, 120, 36, 'BookView after Rename Esc');
      assert.ok(!afterRenameEsc.includes('重命名目录节点'));

      tty.send('D');
      const deleteDialog = await tty.waitFor(
        (s) => s.includes('删除目录节点') && s.includes('未归位'),
        { label: 'Delete ConfirmDialog opened' },
      );
      tty.assertHealthyScreen(deleteDialog, 120, 36, 'Delete ConfirmDialog');
      assert.ok(deleteDialog.includes('未归位'));

      tty.send('n');
      const afterDeleteCancel = await tty.waitFor(
        (s) => !s.includes('删除目录节点') && s.includes('Core Architecture') && s.includes('Alpha Basics'),
        { label: 'Delete ConfirmDialog canceled with n' },
      );
      tty.assertHealthyScreen(afterDeleteCancel, 120, 36, 'BookView after Delete cancel');
      assert.ok(afterDeleteCancel.includes('Alpha Basics'));

      tty.send('R');
      await tty.waitFor((s) => s.includes('重命名目录节点'), { label: 'BookStructureModal reopened for rename' });
      tty.send('\x15');
      tty.send('Architecture Core');
      await tty.waitFor((s) => s.includes('Architecture Core'), { label: 'New title typed' });
      tty.send('\r');
      const afterRenameSave = await tty.waitFor(
        (s) => !s.includes('重命名目录节点') && s.includes('Architecture Core'),
        { label: 'BookView updated after rename' },
      );
      tty.assertHealthyScreen(afterRenameSave, 120, 36, 'BookView after rename save');
      assert.ok(afterRenameSave.includes('Architecture Core'), 'BookView TOC must reflect renamed node');
    } finally {
      try {
        inkInstance?.unmount();
      } catch {
        // Ignore unmount errors during teardown
      }
      tty.dispose();
      await host.dispose();
      resetDistStore('zh', false);
    }
  });
});

function createTraceStubComplete() {
  return async (_system, prompt, execution = {}) => {
    const p = String(prompt || '');
    if (p.includes('OK?')) return 'OK';
    execution.signal?.throwIfAborted?.();
    const reply = JSON.stringify({
      cards: [
        {
          kind: 'flashcard',
          front: 'What is Memento pattern?',
          back: 'Captures and externalizes internal state for later restoration.',
        },
      ],
    });
    execution.onOutput?.(reply);
    return reply;
  };
}

async function pollTraceUntilRecorded(host, jobId, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await host.call('job.trace.export', { jobId });
    if (res.ok && Array.isArray(res.value?.calls) && res.value.calls.some((c) => c.retained)) {
      return res;
    }
    await new Promise((r) => setTimeout(r, 30));
  }
  return host.call('job.trace.export', { jobId });
}

describe('Round 35: TasksView Trace Export (e) & Purge (D)', () => {
  test('1) exportJobTraceToFile unit: creates exports/, sanitizes traversal jobIds, writes valid JSON', async () => {
    const root = await temps.make('r35-unit');
    const exportsDir = resolve(join(root, 'exports'));
    const payload = {
      format: 'studyhub-request-trace-v1',
      jobId: '../../../etc/passwd',
      calls: [{ callId: 'c1', stage: 'generate', model: 'stub', retained: true }],
    };

    const saved = await exportJobTraceToFile(root, '../../../etc/passwd', payload);
    assert.equal(dirname(saved), exportsDir, 'must write strictly inside <libraryRoot>/exports');
    assert.match(basename(saved), /^trace-etc-passwd-\d{8}-\d{6}\.json$/);

    const parsed = JSON.parse(await readFile(saved, 'utf8'));
    assert.deepEqual(parsed, payload);

    const savedWinTraversal = await exportJobTraceToFile(root, '..\\..\\secret/job:id?*', { ok: true });
    assert.equal(dirname(savedWinTraversal), exportsDir, 'must block Windows-style traversal too');
    assert.match(basename(savedWinTraversal), /^trace-secret-job-id-\d{8}-\d{6}\.json$/);
    const dirStat = await stat(exportsDir);
    assert.equal(dirStat.isDirectory(), true);

    const fallbackSaved = await exportJobTraceToFile('', 'job-fallback', { fallback: true });
    try {
      assert.equal(dirname(fallbackSaved), resolve(join(tmpdir(), 'exports')));
      assert.deepEqual(JSON.parse(await readFile(fallbackSaved, 'utf8')), { fallback: true });
    } finally {
      await rm(fallbackSaved, { force: true });
    }
  });

  test('2) createTuiHost integration: job.trace.export & job.trace.delete error + valid schema lifecycle', async () => {
    const base = await temps.make('r35-host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      injectedComplete: createTraceStubComplete(),
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      const missingExport = await host.call('job.trace.export', { jobId: 'missing-job-35' });
      assert.equal(missingExport.ok, false);
      assert.match(missingExport.error?.message ?? '', /Study job not found/i);

      const missingDelete = await host.call('job.trace.delete', { jobId: 'missing-job-35' });
      assert.equal(missingDelete.ok, false);
      assert.match(missingDelete.error?.message ?? '', /Study job not found/i);

      const sampleRes = await host.call('sample.load', { language: 'en' });
      assert.equal(sampleRes.ok, true, sampleRes.error?.message);
      const snap = await host.call('snapshot', {});
      assert.equal(snap.ok, true);
      const activeSource = (snap.value?.sources ?? []).find((s) => !s.archived) ?? snap.value?.sources?.[0];
      assert.ok(activeSource, 'expected an active sample source');
      const course = activeSource.course || activeSource.courses?.[0] || snap.value?.courses?.[0]?.name;

      const genRes = await host.call('generate', {
        course,
        sourceIds: [activeSource.id],
        count: 1,
        kind: 'flashcard',
        title: 'R35 Trace Host Job',
      });
      assert.equal(genRes.ok, true, genRes.error?.message);
      const jobId = genRes.value?.jobId || genRes.value?.id;
      assert.ok(jobId, 'generate must return jobId');

      const exported = await pollTraceUntilRecorded(host, jobId);
      assert.equal(exported.ok, true, exported.error?.message);
      assert.equal(exported.value.format, 'studyhub-request-trace-v1');
      assert.equal(typeof exported.value.exportedAt, 'string');
      assert.equal(exported.value.jobId, jobId);
      assert.equal(exported.value.includesSolutions, false);
      assert.ok(Array.isArray(exported.value.messages));
      assert.ok(Array.isArray(exported.value.calls) && exported.value.calls.length >= 1, 'expected at least 1 trace call');
      assert.equal(exported.value.calls.some((c) => c.retained), true, 'expected retained trace entry');

      const writtenPath = await exportJobTraceToFile(libraryRoot, jobId, exported.value);
      const diskPayload = JSON.parse(await readFile(writtenPath, 'utf8'));
      assert.equal(diskPayload.format, 'studyhub-request-trace-v1');
      assert.equal(diskPayload.jobId, jobId);

      const purged = await host.call('job.trace.delete', { jobId });
      assert.equal(purged.ok, true, purged.error?.message);
      assert.equal(purged.value.jobId, jobId);
      assert.ok(typeof purged.value.removed === 'number' && purged.value.removed >= 1);

      const afterPurgeTrace = await host.call('job.trace', { jobId });
      assert.equal(afterPurgeTrace.ok, true, 'job record must remain intact after trace delete');
      assert.equal(afterPurgeTrace.value.calls.every((c) => c.retained === false && c.deleted === true), true);

      const purgedAgain = await host.call('job.trace.delete', { jobId });
      assert.equal(purgedAgain.ok, true);
      assert.equal(purgedAgain.value.removed, 0);
    } finally {
      await host.dispose();
    }
  });

  test('3) PTY E2E: TasksView [e] Export & [D] Purge at 120x36 & 80x24', async () => {
    resetDistStore('zh', false);
    const base = await temps.make('r35-pty');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');

    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      injectedComplete: createTraceStubComplete(),
      skipAutoProbe: true,
      language: 'zh',
    });

    const sampleRes = await host.call('sample.load', { language: 'zh' });
    assert.equal(sampleRes.ok, true, sampleRes.error?.message);

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
      await tty.waitFor((s) => s.includes('学习库') || s.includes('Memento'), { label: 'Initial app render' });

      tty.send('t');
      const emptyWide = await tty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'tasks' &&
          s.includes('后台任务') &&
          s.includes('[e]') &&
          s.includes('[D]'),
        { label: 'TasksView empty at 120x36 with e/D hints' },
      );
      tty.assertHealthyScreen(emptyWide, 120, 36, 'TasksView empty 120x36');
      assert.equal(useTuiStore.getState().page, 'tasks');
      assert.ok(emptyWide.includes('[e]') && emptyWide.includes('[D]'));

      tty.resize(80, 24);
      const emptyNarrow = await tty.waitFor(
        (s) => s.includes('后台任务') && s.includes('[e]') && s.includes('[D]') && s.split('\n').length <= 24,
        { label: 'TasksView empty at 80x24 with e/D hints' },
      );
      tty.assertHealthyScreen(emptyNarrow, 80, 24, 'TasksView empty 80x24');
      assert.ok(emptyNarrow.split('\n').length <= 24);

      tty.resize(120, 36);
      await tty.waitFor((s) => s.includes('监控后台任务'), { label: 'TasksView restored 120x36' });

      tty.send('e');
      await tty.waitFor(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('请先选择一个任务')),
        { label: 'Empty list e info toast' },
      );
      tty.assertHealthyScreen(tty.readScreen(), 120, 36, 'TasksView after empty e');

      tty.send('D');
      await tty.flush(60);
      tty.assertHealthyScreen(tty.readScreen(), 120, 36, 'TasksView after empty D');

      const snapRes = await host.call('snapshot', {});
      assert.equal(snapRes.ok, true);
      const activeSource = (snapRes.value?.sources ?? []).find((s) => !s.archived) ?? snapRes.value?.sources?.[0];
      assert.ok(activeSource);
      const course = activeSource.course || activeSource.courses?.[0] || snapRes.value?.courses?.[0]?.name;

      const genRes = await host.call('generate', {
        course,
        sourceIds: [activeSource.id],
        count: 1,
        kind: 'flashcard',
        title: 'R35 PTY Trace Job',
      });
      assert.equal(genRes.ok, true, genRes.error?.message);
      const jobId = genRes.value?.jobId || genRes.value?.id;
      assert.ok(jobId);

      await pollTraceUntilRecorded(host, jobId);
      const afterGenSnap = await host.call('snapshot', {});
      assert.equal(afterGenSnap.ok, true);
      useTuiStore.getState().setSnapshot(afterGenSnap.value);

      const jobVisibleScreen = await tty.waitFor(
        (s) => s.includes('R35 PTY Trace Job') && !s.includes('当前筛选下无任务'),
        { label: 'Populated job visible in TasksView' },
      );
      assert.ok(jobVisibleScreen.includes('R35 PTY Trace Job'));

      tty.send('e');
      await tty.waitFor(
        () =>
          useTuiStore
            .getState()
            .toasts.some((toast) => toast.tone === 'success' && toast.text.includes('轨迹已导出到')),
        { label: 'Trace export success toast' },
      );
      const exportFiles = await readdir(join(libraryRoot, 'exports'));
      assert.ok(
        exportFiles.some((f) => f.startsWith('trace-') && f.endsWith('.json')),
        `Expected exported trace-*.json in exports/, found ${JSON.stringify(exportFiles)}`,
      );
      tty.assertHealthyScreen(tty.readScreen(), 120, 36, 'TasksView after export');

      tty.send('D');
      const purgeDialog = await tty.waitFor(
        (s) => s.includes('清空请求轨迹') && s.includes('任务记录与草稿保持不变'),
        { label: 'Purge ConfirmDialog opened' },
      );
      tty.assertHealthyScreen(purgeDialog, 120, 36, 'Purge ConfirmDialog');
      assert.ok(purgeDialog.includes('清空请求轨迹'));

      tty.send('n');
      await tty.waitFor((s) => !s.includes('清空请求轨迹') && s.includes('R35 PTY Trace Job'), {
        label: 'Purge ConfirmDialog canceled with n',
      });

      tty.send('D');
      await tty.waitFor((s) => s.includes('清空请求轨迹'), { label: 'Purge ConfirmDialog reopened' });
      tty.send('y');
      await tty.waitFor(
        () =>
          useTuiStore
            .getState()
            .toasts.some(
              (toast) => toast.text.includes('条调用轨迹（任务记录保留）') || toast.text.includes('暂无可清空'),
            ),
        { label: 'Purge trace toast shown' },
      );
      const afterPurgeScreen = await tty.waitFor(
        (s) => !s.includes('清空请求轨迹') && s.includes('R35 PTY Trace Job'),
        { label: 'Job record still present after purge' },
      );
      tty.assertHealthyScreen(afterPurgeScreen, 120, 36, 'TasksView after purge');
      assert.ok(afterPurgeScreen.includes('R35 PTY Trace Job'));
    } finally {
      try {
        inkInstance?.unmount();
      } catch {
        // Ignore unmount errors during teardown
      }
      tty.dispose();
      await host.dispose();
      resetDistStore('zh', false);
    }
  });
});
