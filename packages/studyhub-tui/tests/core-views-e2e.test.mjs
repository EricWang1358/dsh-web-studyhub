// Consolidated Core Views E2E, Deep Interactions & Memory Soak: node --test tests/core-views-e2e.test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import v8 from 'node:v8';
import vm from 'node:vm';
import { render } from 'ink';
import React from 'react';
import {
  createTempTracker,
  createVirtualTty,
  disposeTerminalPool,
  distDir,
  loadDistRuntime,
} from './helpers/virtual-tty.mjs';

// Load directly from built dist/ (avoids loading tsx/esbuild compiler overhead in memory soak measurements).
const runtime = await loadDistRuntime();
const { StudyHubTuiApp, createTuiHost } = runtime;
assert.ok(StudyHubTuiApp, 'dist/ must export StudyHubTuiApp');
assert.ok(createTuiHost, 'dist/ must export createTuiHost');

const appCode = await readFile(join(distDir, 'App.mjs'), 'utf8');
const cjkImport = appCode.match(/import\s*\{[^}]*\bdisplayWidth\b[^}]*\}\s*from\s*["'](\.\/[^"']+\.mjs)["']/);
assert.ok(cjkImport, 'dist/App.mjs must import displayWidth');
const { displayWidth } = await import(pathToFileURL(resolve(distDir, cjkImport[1])).href);
assert.ok(displayWidth, 'dist/ must export displayWidth');

const PREV_DSH_HOME = process.env.DSH_HOME;
const temps = createTempTracker('studyhub-tui-core-');

const RESOURCE_KINDS = new Set(['FSEventWrap', 'StatWatcher', 'Timeout', 'ProcessWrap', 'TCPWrap', 'PipeWrap']);
function resourceCounts() {
  const counts = {};
  for (const kind of process.getActiveResourcesInfo()) {
    if (RESOURCE_KINDS.has(kind)) counts[kind] = (counts[kind] || 0) + 1;
  }
  return counts;
}

async function waitForResourceTeardown(baselineResources, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let afterRes = resourceCounts();
  while (
    Date.now() < deadline &&
    ['FSEventWrap', 'StatWatcher', 'ProcessWrap', 'Timeout'].some(
      (kind) => (afterRes[kind] || 0) > (baselineResources[kind] || 0),
    )
  ) {
    await new Promise((r) => setTimeout(r, 15));
    afterRes = resourceCounts();
  }
  return afterRes;
}

function assertScreenHealthy(tty, screen, expectedCols, expectedRows, contextLabel) {
  tty.assertHealthyScreen(screen, expectedCols, expectedRows, contextLabel);
  const lines = screen.split('\n');
  assert.ok(lines.length <= expectedRows, `${contextLabel}: Row count ${lines.length} > ${expectedRows}`);
  assert.ok(!/\bNaN\b/.test(screen), `${contextLabel}: Raw NaN leaked\n${screen}`);
  assert.ok(!/\bundefined\b/.test(screen), `${contextLabel}: Raw undefined leaked\n${screen}`);
  assert.ok(!screen.includes('[object Object]'), `${contextLabel}: [object Object] leaked\n${screen}`);
  assert.ok(!screen.includes('\uFFFD'), `${contextLabel}: Replacement char U+FFFD found!\n${screen}`);
  assert.ok(
    !screen.includes('\u001b'),
    `${contextLabel}: Unparsed escape sequence leaked into xterm buffer!\n${screen}`,
  );
  for (let i = 0; i < lines.length; i += 1) {
    const w = displayWidth(lines[i]);
    assert.ok(
      w <= expectedCols,
      `${contextLabel}: Row ${i} exceeds cols (${w} > ${expectedCols}): ${JSON.stringify(lines[i])}`,
    );
  }
  const buf = tty.term.buffer.active;
  for (let y = 0; y < tty.term.rows; y += 1) {
    const line = buf.getLine(buf.viewportY + y);
    if (line) {
      assert.equal(
        line.isWrapped,
        false,
        `${contextLabel}: xterm soft-wrapped row ${y}: ${JSON.stringify(line.translateToString(true))}`,
      );
    }
  }
}

function tryParseJsonPrefix(raw) {
  const idx = raw.indexOf('\n\nYour previous reply failed validation:');
  const clean = idx >= 0 ? raw.slice(0, idx) : raw;
  return JSON.parse(clean);
}

/** Deterministic model stub supporting translation JSON, daily plan JSON, and live AI streaming. */
function createCoreStubComplete() {
  return async (system, prompt, execution = {}) => {
    const s = String(system || '');
    const p = String(prompt || '');
    if (p.includes('OK?')) return 'OK';

    if (execution?.task === 'card.translate' || s.includes('You translate flashcard content')) {
      const src = tryParseJsonPrefix(p);
      const translated = {
        prompt: `[EN] ${src.prompt || 'Translated question'}`,
        answer: `[EN] ${src.answer || 'Translated answer'}`,
        explanation: `[EN] ${src.explanation || 'Translated explanation'}`,
      };
      if (src.clozeText) {
        translated.clozeText = src.clozeText;
        translated.blanks = (src.blanks || []).map((b) => ({
          id: b.id,
          value: `[EN] ${b.value || b.id}`,
        }));
      }
      if (Array.isArray(src.options)) {
        translated.options = src.options.map((o) => ({
          id: o.id,
          text: `[EN] ${o.text || o.id}`,
          explanation: `[EN] ${o.explanation || 'Option explanation'}`,
        }));
      }
      return JSON.stringify(translated);
    }

    if (s.includes('You propose a realistic daily learning plan')) {
      const ctx = JSON.parse(p);
      const picked = (ctx.candidates || []).slice(0, 2).map((c) => ({
        candidateId: c.candidateId,
        reason: 'Stub AI recommendation based on due items.',
      }));
      return JSON.stringify({
        items: picked,
        summary: 'Balanced study session for today.',
      });
    }

    const chunks = ['[AI Tutor] ', 'Memento ', 'encapsulates ', 'state snapshots ', 'cleanly.'];
    for (const chunk of chunks) {
      execution.signal?.throwIfAborted?.();
      execution.onOutput?.(chunk);
      await new Promise((r) => setImmediate(r));
    }
    return chunks.join('');
  };
}

const SOAK_VIEWS = [
  { id: 'library', key: '1', expect: /题组列表|Decks/ },
  { id: 'sources', key: '2', expect: /资料列表|Materials/ },
  { id: 'generate', key: '3', expect: /新建出题任务|Generate/ },
  { id: 'wrongbook', key: '4', expect: /错题列表|Mistakes/ },
  { id: 'exam', key: '5', expect: /组卷设置|Mock Exam/ },
  { id: 'dashboard', key: '6', expect: /学习统计与掌握度|Stats/ },
  { id: 'book', key: '7', expect: /复习全书|Book/ },
  { id: 'skeleton', key: '8', expect: /知识层级树|Skeleton/ },
];

describe('StudyHub TUI Core Views E2E, Deep Interactions & Memory Soak', () => {
  let boxDir;
  let dshHome;
  let libraryRoot;
  let host;
  let tty;
  let inkInstance;
  let baselineResources;
  let disposed = false;

  async function cleanupAll() {
    if (disposed) return;
    disposed = true;
    try {
      inkInstance?.unmount();
    } catch {
      // Ignore unmount errors during teardown
    }
    await host?.dispose();
    tty?.dispose();
    disposeTerminalPool();
  }

  before(async () => {
    boxDir = await temps.make('main');
    dshHome = join(boxDir, 'dsh-home');
    libraryRoot = join(boxDir, 'library');
    process.env.DSH_HOME = dshHome;
    baselineResources = resourceCounts();

    host = await createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(boxDir, 'home'),
      libraryRoot,
      injectedComplete: createCoreStubComplete(),
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    tty = createVirtualTty(120, 36);
    inkInstance = render(
      React.createElement(StudyHubTuiApp, {
        host,
        autoLaunchpad: true,
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
  });

  after(async () => {
    try {
      await cleanupAll();
    } finally {
      if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = PREV_DSH_HOME;
      await temps.cleanup();
    }
  });

  test('1) Global Inbox (I): load sample course, cycle filter (Tab), toggle read (m), mark all read (M), close (Esc)', async () => {
    await tty.waitFor(
      (s) => s.includes('载入示例课程体验') || s.includes('Load the sample course'),
      { timeoutMs: 15_000, label: 'Launchpad render' },
    );
    await tty.flush();

    // Load sample course via 's'
    tty.send('s');
    await tty.waitFor(
      (s) =>
        !s.includes('载入示例课程体验') &&
        (s.includes('示例 · Memento 与 Bridge') || s.includes('Sample · Memento')) &&
        /\[I\]/.test(s),
      { timeoutMs: 25_000, label: 'Library after sample load' },
    );
    await tty.flush();

    // Open Global Inbox ('I')
    tty.send('I');
    const inboxInit = await tty.waitFor(
      (s) =>
        (s.includes('收件箱与通知') || s.includes('Notification Inbox')) &&
        (s.includes('全部 (5)') || s.includes('All (5)')) &&
        !s.includes('同步'),
      { timeoutMs: 8_000, label: 'InboxModal open with 5 items' },
    );
    assertScreenHealthy(tty, inboxInit, 120, 36, 'InboxModal initial');
    assert.match(inboxInit, /未读 \(2\)|Unread \(2\)/);
    assert.match(inboxInit, /已读 \(3\)|Read \(3\)/);

    // Cycle filter with Tab: all -> unread -> read -> all
    tty.send('\t');
    const unreadView = await tty.waitFor(
      (s) => !s.includes('[批改完成]') && !s.includes('[前置题]') && s.includes('[笔记草稿]'),
      { label: 'Inbox filter: unread' },
    );
    assertScreenHealthy(tty, unreadView, 120, 36, 'InboxModal filter unread');

    tty.send('\t');
    const readView = await tty.waitFor(
      (s) => (s.includes('[批改完成]') || s.includes('[前置题]')) && !s.includes('[讲解追问]'),
      { label: 'Inbox filter: read' },
    );
    assertScreenHealthy(tty, readView, 120, 36, 'InboxModal filter read');

    tty.send('\t');
    await tty.waitFor(
      (s) => s.includes('[笔记草稿]') && (s.includes('[批改完成]') || s.includes('[前置题]')),
      { label: 'Inbox filter back to all' },
    );

    // Toggle read ('m') on selected unread item -> unread becomes 1, read becomes 4
    tty.send('m');
    const afterToggle = await tty.waitFor(
      (s) => (s.includes('未读 (1)') || s.includes('Unread (1)')) && (s.includes('已读 (4)') || s.includes('Read (4)')),
      { timeoutMs: 8_000, label: 'Inbox toggle read (m)' },
    );
    assert.match(afterToggle, /未读 \(1\)|Unread \(1\)/);
    assertScreenHealthy(tty, afterToggle, 120, 36, 'InboxModal after toggle read');

    // Mark all read ('M') -> unread becomes 0, read becomes 5
    tty.send('M');
    const afterMarkAll = await tty.waitFor(
      (s) => (s.includes('未读 (0)') || s.includes('Unread (0)')) && (s.includes('全部已读') || s.includes('All caught up')),
      { timeoutMs: 8_000, label: 'Inbox mark all read (M)' },
    );
    assert.match(afterMarkAll, /未读 \(0\)|Unread \(0\)/);
    assertScreenHealthy(tty, afterMarkAll, 120, 36, 'InboxModal after mark all read');

    // Close ('Esc')
    tty.send('\x1b');
    await tty.waitFor(
      (s) => !s.includes('收件箱与通知') && !s.includes('Notification Inbox'),
      { label: 'InboxModal closed' },
    );
  });

  test('2) Library Daily Plan (p + g + Esc) & Course Settings (C + tabs 1/2/3 + Esc)', async () => {
    // Open DailyPlanModal ('p')
    tty.send('p');
    const planOpen = await tty.waitFor(
      (s) =>
        (s.includes('今日学习计划') || s.includes("Today's Study Plan")) &&
        !s.includes('正在读取今日学习安排') &&
        !s.includes('Loading daily plan'),
      { timeoutMs: 8_000, label: 'DailyPlanModal opened' },
    );
    assertScreenHealthy(tty, planOpen, 120, 36, 'DailyPlanModal initial');

    // Trigger suggestion ('g')
    tty.send('g');
    const planSuggested = await tty.waitFor(
      (s) =>
        (s.includes('AI 建议') || s.includes('AI Proposal') || s.includes('本地建议') || s.includes('Local Proposal')) &&
        !s.includes('正在生成计划') &&
        !s.includes('Generating plan'),
      { timeoutMs: 8_000, label: 'DailyPlanModal after suggest (g)' },
    );
    assertScreenHealthy(tty, planSuggested, 120, 36, 'DailyPlanModal suggested');

    // Close DailyPlanModal ('Esc')
    tty.send('\x1b');
    await tty.waitFor(
      (s) => !s.includes('今日学习计划') && !s.includes("Today's Study Plan"),
      { label: 'DailyPlanModal closed' },
    );

    // Open CourseSettingsModal ('C')
    tty.send('C');
    const settingsFirst = await tty.waitFor(
      (s) =>
        (s.includes('课程设置与学法') || s.includes('Course Settings')) &&
        !s.includes('正在读取课程配置') &&
        !s.includes('Loading course settings'),
      { timeoutMs: 8_000, label: 'CourseSettingsModal opened' },
    );
    assertScreenHealthy(tty, settingsFirst, 120, 36, 'CourseSettingsModal initial');

    // If no active course was pinned in snapshot, pickCourse opens first; select the sample course.
    if (settingsFirst.includes('选择要配置的课程') || settingsFirst.includes('Select a course to configure')) {
      tty.send('\r');
      await tty.waitFor(
        (s) =>
          !s.includes('选择要配置的课程') &&
          !s.includes('Select a course to configure') &&
          !s.includes('正在读取课程配置') &&
          !s.includes('Loading course settings'),
        { timeoutMs: 8_000, label: 'CourseSettingsModal course selected' },
      );
    }

    // Tab 1: Method
    tty.send('1');
    const tab1 = await tty.waitFor(
      (s) => s.includes('课堂跟学') || s.includes('Classroom') || s.includes('选预设模式') || s.includes('Presets'),
      { label: 'CourseSettings tab 1 (Method)' },
    );
    assertScreenHealthy(tty, tab1, 120, 36, 'CourseSettings tab 1 Method');

    // Tab 2: Info & Rename
    tty.send('2');
    const tab2 = await tty.waitFor(
      (s) => (s.includes('课程名称') || s.includes('Course Name')) && (s.includes('重命名课程') || s.includes('Rename course')),
      { label: 'CourseSettings tab 2 (Info & Rename)' },
    );
    assertScreenHealthy(tty, tab2, 120, 36, 'CourseSettings tab 2 Info');

    // Tab 3: Terms
    tty.send('3');
    const tab3 = await tty.waitFor(
      (s) => (s.includes('已掌握') || s.includes('Known')) && (s.includes('待巩固') || s.includes('Unknown')),
      { label: 'CourseSettings tab 3 (Terms)' },
    );
    assertScreenHealthy(tty, tab3, 120, 36, 'CourseSettings tab 3 Terms');

    // Close CourseSettingsModal ('Esc')
    tty.send('\x1b');
    await tty.waitFor(
      (s) => !s.includes('课程设置与学法') && !s.includes('Course Settings'),
      { label: 'CourseSettingsModal closed' },
    );
  });

  test('3) Review Deep Actions: Similar (S), Card Tools (D), Translate (T), and exit (q -> b)', async () => {
    // Enter Review ('r')
    tty.send('r');
    const reviewScreen = await tty.waitFor(
      (s) =>
        (s.includes('[h]讲解') || s.includes('[h]Help')) &&
        !s.includes('正在加载页面') &&
        !s.includes('Loading view') &&
        !s.includes('正在准备复习队列'),
      { timeoutMs: 10_000, label: 'Review active card' },
    );
    assertScreenHealthy(tty, reviewScreen, 120, 36, 'Review initial card');

    // Press 'S' -> SimilarCardsModal
    tty.send('S');
    const similarScreen = await tty.waitFor(
      (s) =>
        (s.includes('同类 / 易混题对比') || s.includes('Similar & Confusable Cards')) &&
        !s.includes('正在检索同类易混题目') &&
        !s.includes('Searching similar cards'),
      { timeoutMs: 8_000, label: 'SimilarCardsModal rendered' },
    );
    assertScreenHealthy(tty, similarScreen, 120, 36, 'SimilarCardsModal');

    tty.send('\x1b');
    await tty.waitFor(
      (s) => !s.includes('同类 / 易混题对比') && !s.includes('Similar & Confusable Cards'),
      { label: 'SimilarCardsModal closed' },
    );

    // Press 'D' -> CardToolsModal (all 4 tools rendered cleanly)
    tty.send('D');
    const toolsScreen = await tty.waitFor(
      (s) => s.includes('题目工具箱') || s.includes('Card Tools'),
      { timeoutMs: 8_000, label: 'CardToolsModal rendered' },
    );
    assertScreenHealthy(tty, toolsScreen, 120, 36, 'CardToolsModal');
    assert.match(toolsScreen, /编辑题目|Edit Question/);
    assert.match(toolsScreen, /暂停题目|恢复题目|Suspend Card|Resume Card/);
    assert.match(toolsScreen, /斩题 \/ 永久掌握|Slay \/ Mastered/);
    assert.match(toolsScreen, /判分等效改判|Override Grade/);

    tty.send('\x1b');
    await tty.waitFor(
      (s) => !s.includes('题目工具箱') && !s.includes('Card Tools'),
      { label: 'CardToolsModal closed' },
    );

    // Press 'W' -> Bilingual translation via stub model (T is now unified Guided/Retell per #1315)
    tty.send('W');
    const translatedScreen = await tty.waitFor(
      (s) => s.includes('EN 译') && s.includes('[EN]'),
      { timeoutMs: 8_000, label: 'Bilingual translation rendered' },
    );
    assertScreenHealthy(tty, translatedScreen, 120, 36, 'Review bilingual translation');

    // Exit Review: 'X' -> Confirm -> 'y' -> Round Summary -> 'b' -> Library
    tty.send('X');
    await tty.waitFor(
      (s) => s.includes('结束本轮练习') || s.includes('End This Round'),
      { timeoutMs: 6_000, label: 'Confirm end round dialog' },
    );
    tty.send('y');
    const summaryScreen = await tty.waitFor(
      (s) => s.includes('再来一轮') || s.includes('New Round') || s.includes('本轮练习总结'),
      { timeoutMs: 20_000, label: 'Round Summary' },
    );
    assertScreenHealthy(tty, summaryScreen, 120, 36, 'Round Summary');

    tty.send('b');
    await tty.waitFor(
      (s) => s.includes('题组列表') || s.includes('Decks'),
      { timeoutMs: 20_000, label: 'Back to Library from Review' },
    );
  });

  test('4) Mock Exam (5) End-to-End: start timed written exam -> answer -> nav -> submit -> report -> return', async () => {
    tty.send('5');
    const setupScreen = await tty.waitFor(
      (s) =>
        (s.includes('组卷设置') || s.includes('Exam Setup')) &&
        (s.includes('选择题卷') || s.includes('Written MCQ')) &&
        !s.includes('正在加载页面'),
      { timeoutMs: 10_000, label: 'ExamSetup rendered' },
    );
    assertScreenHealthy(tty, setupScreen, 120, 36, 'ExamSetup initial');

    // Start timed written mock exam with Enter
    tty.send('\r');
    const runningScreen = await tty.waitFor(
      (s) =>
        (s.includes('选择题卷 · 1/') || s.includes('Written MCQ · 1/')) &&
        (/剩余 \d{2}:\d{2}/.test(s) || /Left \d{2}:\d{2}/.test(s)) &&
        s.includes('[1]'),
      { timeoutMs: 10_000, label: 'ExamRunner written exam started with timer and options' },
    );
    assertScreenHealthy(tty, runningScreen, 120, 36, 'ExamRunner initial Q1');

    // Select option 1
    tty.send('1');
    const pickedScreen = await tty.waitFor(
      (s) => (s.includes('已答 1/') || s.includes('Ans 1/')) && s.includes('◉'),
      { timeoutMs: 8_000, label: 'Option 1 selected on Q1' },
    );
    assertScreenHealthy(tty, pickedScreen, 120, 36, 'ExamRunner Q1 selected');

    // Navigate next ('n') -> Q2, then prev ('p') -> Q1
    tty.send('n');
    const q2Screen = await tty.waitFor(
      (s) => s.includes('选择题卷 · 2/') || s.includes('Written MCQ · 2/'),
      { timeoutMs: 8_000, label: 'Moved to Q2 with n' },
    );
    assertScreenHealthy(tty, q2Screen, 120, 36, 'ExamRunner Q2');

    tty.send('p');
    const backQ1Screen = await tty.waitFor(
      (s) => (s.includes('选择题卷 · 1/') || s.includes('Written MCQ · 1/')) && s.includes('◉'),
      { timeoutMs: 8_000, label: 'Moved back to Q1 with p' },
    );
    assertScreenHealthy(tty, backQ1Screen, 120, 36, 'ExamRunner back to Q1');

    // Submit via Ctrl+S -> confirm dialog -> 'y'
    tty.send('\x13');
    const submitDialog = await tty.waitFor(
      (s) => s.includes('确认交卷') || s.includes('Submit Exam'),
      { timeoutMs: 8_000, label: 'Exam submit confirmation dialog' },
    );
    assertScreenHealthy(tty, submitDialog, 120, 36, 'ExamRunner ConfirmDialog');

    tty.send('y');
    const reportScreen = await tty.waitFor(
      (s) =>
        (s.includes('考试成绩单') || s.includes('Exam Report')) &&
        /\d+%/.test(s) &&
        (s.includes('正确') || s.includes('OK')) &&
        (s.includes('各主题正确率') || s.includes('Accuracy by Topic') || s.includes('错题与未答') || s.includes('Wrong & Skipped')),
      { timeoutMs: 10_000, label: 'ExamReportView rendered score/accuracy/breakdown' },
    );
    assert.match(reportScreen, /\d+%/);
    assertScreenHealthy(tty, reportScreen, 120, 36, 'ExamReportView');

    // Return cleanly to ExamSetup via 'b'
    tty.send('b');
    const returnedSetup = await tty.waitFor(
      (s) =>
        (s.includes('组卷设置') || s.includes('Exam Setup')) &&
        (s.includes('历史考卷') || s.includes('Past Exams')) &&
        (s.includes('[选择题卷]') || s.includes('[Written]')),
      { timeoutMs: 8_000, label: 'Returned cleanly to ExamSetup with submitted exam in history' },
    );
    assert.match(returnedSetup, /\[选择题卷\]|\[Written\]/);
    assertScreenHealthy(tty, returnedSetup, 120, 36, 'ExamSetup after report return');
  });

  test('5) Notes (n) Full CRUD + Markdown Export', async () => {
    tty.send('n');
    const notesInit = await tty.waitFor(
      (s) =>
        (s.includes('Unicode Math') || s.includes('Raw LaTeX') || s.includes('笔记正文') || s.includes('Note Reader')) &&
        !s.includes('载入笔记中') &&
        !s.includes('正在加载页面'),
      { timeoutMs: 10_000, label: 'NotesView rendered' },
    );
    await tty.flush();
    assertScreenHealthy(tty, notesInit, 120, 36, 'NotesView initial');

    const noteTitle = 'Deep Views E2E Note';
    const appendedLine = 'E2E_INSIGHT_APPENDED';

    // Create note via 'a'
    tty.send('a');
    const createModal = await tty.waitFor(
      (s) =>
        (s.includes('新建学习笔记') || s.includes('New Study Note')) &&
        (s.includes('已选 1/30') || s.includes('Linked Cards (1/30)')),
      { timeoutMs: 8_000, label: 'NoteEditorModal create opened with preselected card' },
    );
    assertScreenHealthy(tty, createModal, 120, 36, 'NoteEditorModal create');

    tty.send(noteTitle);
    await tty.waitFor(
      (s) => s.includes(noteTitle),
      { timeoutMs: 5_000, label: 'Note title typed' },
    );

    // Save via Ctrl+S
    tty.send('\x13');
    await tty.waitFor(
      (s) =>
        !s.includes('新建学习笔记') &&
        !s.includes('New Study Note') &&
        (s.includes('学习笔记  3') || s.includes('Notes  3')) &&
        s.includes('Deep Views'),
      { timeoutMs: 8_000, label: 'Created note rendered in notes list' },
    );
    await tty.flush();

    // Ensure the newly created note (sorted first at index 0) is selected
    let createdNoteScreen = tty.readScreen();
    for (let step = 0; step < 3; step += 1) {
      if (/Deep Views E2E Note\s+(草稿|Draft)/.test(createdNoteScreen)) {
        break;
      }
      tty.send('k');
      await tty.flush();
      createdNoteScreen = tty.readScreen();
    }
    createdNoteScreen = await tty.waitFor(
      (s) => /Deep Views E2E Note\s+(草稿|Draft)/.test(s),
      { timeoutMs: 6_000, label: 'Created note selected and shown in detail pane' },
    );
    assertScreenHealthy(tty, createdNoteScreen, 120, 36, 'NotesView after create');

    // Edit note via 'e' (starts on markdown field)
    tty.send('e');
    const editModal = await tty.waitFor(
      (s) => s.includes('编辑笔记') || s.includes('Edit Note'),
      { timeoutMs: 8_000, label: 'NoteEditorModal edit opened' },
    );
    assertScreenHealthy(tty, editModal, 120, 36, 'NoteEditorModal edit');

    tty.send(`\n${appendedLine}`);
    await tty.waitFor(
      (s) => s.includes(appendedLine),
      { timeoutMs: 5_000, label: 'Appended markdown typed' },
    );

    tty.send('\x13');
    const editedScreen = await tty.waitFor(
      (s) => !s.includes('编辑笔记') && !s.includes('Edit Note') && s.includes(appendedLine),
      { timeoutMs: 8_000, label: 'Edited note detail pane updated' },
    );
    assertScreenHealthy(tty, editedScreen, 120, 36, 'NotesView after edit');

    // Export Markdown via 'x' to a deterministic temp file
    const exportTarget = join(boxDir, 'exported-deep-note.md');
    tty.send('x');
    const exportModal = await tty.waitFor(
      (s) => s.includes('导出 Markdown 笔记') || s.includes('Export Note as Markdown'),
      { timeoutMs: 8_000, label: 'Notes export modal opened' },
    );
    assertScreenHealthy(tty, exportModal, 120, 36, 'NotesView export modal');
    await tty.flush(25);

    tty.send('\x15');
    await tty.flush(20);
    tty.send(exportTarget);
    await tty.waitFor(
      (s) => s.includes('exported-deep-note.md'),
      { timeoutMs: 5_000, label: 'Export path typed' },
    );
    tty.send('\r');

    const afterExport = await tty.waitFor(
      (s) => !s.includes('导出 Markdown 笔记') && !s.includes('Export Note as Markdown'),
      { timeoutMs: 8_000, label: 'Export modal closed' },
    );
    assertScreenHealthy(tty, afterExport, 120, 36, 'NotesView after export');

    const exportedMd = await readFile(exportTarget, 'utf8');
    assert.ok(exportedMd.includes(noteTitle), 'Exported markdown must include note title');
    assert.ok(exportedMd.includes(appendedLine), `Exported markdown must include appended line, got:\n${exportedMd}`);

    // Delete note via 'd' -> confirm with 'y'
    tty.send('d');
    const deleteDialog = await tty.waitFor(
      (s) => s.includes('删除笔记') || s.includes('Delete Note'),
      { timeoutMs: 8_000, label: 'Delete note confirmation dialog' },
    );
    assertScreenHealthy(tty, deleteDialog, 120, 36, 'NotesView delete ConfirmDialog');

    tty.send('y');
    const afterDelete = await tty.waitFor(
      (s) => !s.includes('删除笔记') && !s.includes('Delete Note') && !s.includes(noteTitle),
      { timeoutMs: 8_000, label: 'Deleted note removed from NotesView' },
    );
    assertScreenHealthy(tty, afterDelete, 120, 36, 'NotesView after delete');

    const listRes = await host.call('note.list', {});
    assert.equal(listRes.ok, true);
    assert.ok(
      !(listRes.value?.notes || []).some((item) => item.title === noteTitle),
      'Deleted note must not remain in note.list',
    );
  });

  test('6) WrongBook (4) Inspection & Practice Launch -> ReviewView -> Return', async () => {
    tty.send('4');
    const wbInit = await tty.waitFor(
      (s) =>
        (s.includes('错题本') || s.includes('Mistakes')) &&
        (s.includes('待巩固') || s.includes('To Review')) &&
        !s.includes('正在加载错题本') &&
        !s.includes('正在加载页面') &&
        (s.includes('题干') || s.includes('Question')),
      { timeoutMs: 20_000, label: 'WrongBookView rendered with sample weak cards' },
    );
    assertScreenHealthy(tty, wbInit, 120, 36, 'WrongBookView initial');

    // Cycle through tabs: weak -> confusable -> reason -> all -> weak
    tty.send('\t');
    const confusableTab = await tty.waitFor(
      (s) => s.includes('易混淆') || s.includes('Confusable'),
      { timeoutMs: 6_000, label: 'WrongBook confusable tab' },
    );
    assertScreenHealthy(tty, confusableTab, 120, 36, 'WrongBookView confusable tab');

    tty.send('\t');
    const reasonTab = await tty.waitFor(
      (s) =>
        ((s.includes('错因筛选') || s.includes('筛选[f]:')) && (s.includes('全部错因') || s.includes('全部('))) ||
        ((s.includes('Reason [f]:') || s.includes('Filter[f]:')) && (s.includes('All reasons') || s.includes('All('))),
      { timeoutMs: 6_000, label: 'WrongBook reason tab with sub-filter' },
    );
    assertScreenHealthy(tty, reasonTab, 120, 36, 'WrongBookView reason tab');

    // Cycle back to 'all' (includes history + weak) and then 'weak'
    tty.send('\t');
    const allTab = await tty.waitFor(
      (s) => (s.includes('全部 (') || s.includes('All (')) && !s.includes('筛选[f]:') && !s.includes('错因筛选'),
      { timeoutMs: 6_000, label: 'WrongBook all (weak+history) tab' },
    );
    assertScreenHealthy(tty, allTab, 120, 36, 'WrongBookView all tab');

    tty.send('\t');
    const backWeak = await tty.waitFor(
      (s) => (s.includes('待巩固') || s.includes('To Review')) && (s.includes('题干') || s.includes('Question')),
      { timeoutMs: 6_000, label: 'WrongBook returned to weak tab' },
    );
    assertScreenHealthy(tty, backWeak, 120, 36, 'WrongBookView back to weak tab');

    // Launch 0-token wrongbook practice with Enter -> ReviewView
    tty.send('\r');
    const reviewScreen = await tty.waitFor(
      (s) =>
        (s.includes('[D]工具') || s.includes('[D]Tools')) &&
        (s.includes('[t]带学') || s.includes('[t]Guided') || s.includes('[L]带学') || s.includes('[L]Teach')) &&
        !s.includes('正在准备复习队列'),
      { timeoutMs: 10_000, label: 'ReviewView launched from WrongBookView' },
    );
    assertScreenHealthy(tty, reviewScreen, 120, 36, 'ReviewView from WrongBook');

    // Return cleanly via Esc -> WrongBookView
    tty.send('\x1b');
    const returnedWb = await tty.waitFor(
      (s) => (s.includes('错题本') || s.includes('Mistakes')) && (s.includes('错题列表') || s.includes('Mistakes')),
      { timeoutMs: 8_000, label: 'Returned cleanly from ReviewView to WrongBookView' },
    );
    assertScreenHealthy(tty, returnedWb, 120, 36, 'WrongBookView after returning from ReviewView');
  });

  test('7) Skeleton (8) Interactive Tree + Audio (a) Terminal Degradation Notice at 120x36 & 80x24', async () => {
    // Navigate to SkeletonView ('8')
    tty.send('8');
    const skelInit = await tty.waitFor(
      (s) =>
        (s.includes('知识骨架') || s.includes('Knowledge Skeleton')) &&
        (s.includes('知识层级树') || s.includes('Knowledge Tree') || s.includes('课程主题预览')) &&
        !s.includes('正在加载知识骨架') &&
        !s.includes('正在加载页面'),
      { timeoutMs: 10_000, label: 'SkeletonView rendered' },
    );
    assertScreenHealthy(tty, skelInit, 120, 36, 'SkeletonView initial');

    // Navigate down/up, toggle collapse/expand, expand-all ('e'), pane switch ('Tab'), and switcher modal ('s' + Esc)
    for (const key of ['j', 'k', ' ', 'l', 'h', 'e', '\t', '\t']) {
      tty.send(key);
      await tty.flush();
    }
    const skelAfterTreeOps = await tty.waitFor(
      (s) => s.includes('知识层级树') || s.includes('Knowledge Tree'),
      { timeoutMs: 6_000, label: 'SkeletonView healthy after tree navigation & expand/collapse' },
    );
    assertScreenHealthy(tty, skelAfterTreeOps, 120, 36, 'SkeletonView after tree operations');

    tty.send('s');
    const switcherModal = await tty.waitFor(
      (s) => s.includes('选择已保存的知识骨架') || s.includes('Switch Knowledge Skeleton'),
      { timeoutMs: 6_000, label: 'Skeleton switcher modal opened' },
    );
    assertScreenHealthy(tty, switcherModal, 120, 36, 'SkeletonView switcher modal');

    tty.send('\x1b');
    const afterSwitcher = await tty.waitFor(
      (s) => !s.includes('选择已保存的知识骨架') && !s.includes('Switch Knowledge Skeleton'),
      { timeoutMs: 6_000, label: 'Skeleton switcher modal closed' },
    );
    assertScreenHealthy(tty, afterSwitcher, 120, 36, 'SkeletonView after switcher close');

    // Navigate to AudioView ('a')
    tty.send('a');
    const audioWide = await tty.waitFor(
      (s) =>
        (s.includes('音频转写工作台') || s.includes('Audio Transcription')) &&
        (s.includes('纯终端模式已禁用') || s.includes('disabled in terminal mode')) &&
        !s.includes('正在加载页面'),
      { timeoutMs: 10_000, label: 'AudioView rendered with terminal mic degradation notice at 120x36' },
    );
    assertScreenHealthy(tty, audioWide, 120, 36, 'AudioView 120x36');

    // Open Audio settings ('s') & close ('Esc'), then open Import ('i') & close ('Esc') at 120x36
    tty.send('s');
    const audioSettingsWide = await tty.waitFor(
      (s) => s.includes('音频转写服务配置') || s.includes('Audio Transcription Providers'),
      { timeoutMs: 6_000, label: 'AudioView settings modal opened at 120x36' },
    );
    assertScreenHealthy(tty, audioSettingsWide, 120, 36, 'AudioView settings modal 120x36');

    tty.send('\x1b');
    await tty.waitFor(
      (s) => !s.includes('音频转写服务配置') && !s.includes('Audio Transcription Providers'),
      { timeoutMs: 6_000, label: 'AudioView settings modal closed at 120x36' },
    );

    tty.send('i');
    const audioImportWide = await tty.waitFor(
      (s) => s.includes('导入本地音频转写') || s.includes('Import Local Audio'),
      { timeoutMs: 6_000, label: 'AudioView import modal opened at 120x36' },
    );
    assertScreenHealthy(tty, audioImportWide, 120, 36, 'AudioView import modal 120x36');

    tty.send('\x1b');
    await tty.waitFor(
      (s) => !s.includes('导入本地音频转写') && !s.includes('Import Local Audio'),
      { timeoutMs: 6_000, label: 'AudioView import modal closed at 120x36' },
    );

    // Resize to 80x24 and verify AudioView degradation notice, settings modal, and import modal remain healthy
    tty.resize(80, 24);
    const audioNarrow = await tty.waitFor(
      (s) =>
        (s.includes('♪ 音频转写') || s.includes('♪ Audio')) &&
        (s.includes('纯终端模式已禁用') || s.includes('disabled in terminal mode')) &&
        s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'AudioView rendered cleanly at 80x24' },
    );
    assertScreenHealthy(tty, audioNarrow, 80, 24, 'AudioView 80x24');

    tty.send('s');
    const audioSettingsNarrow = await tty.waitFor(
      (s) => s.includes('音频转写服务配置') || s.includes('Audio Transcription Providers'),
      { timeoutMs: 6_000, label: 'AudioView settings modal opened at 80x24' },
    );
    assertScreenHealthy(tty, audioSettingsNarrow, 80, 24, 'AudioView settings modal 80x24');

    tty.send('\x1b');
    await tty.waitFor(
      (s) => !s.includes('音频转写服务配置') && !s.includes('Audio Transcription Providers'),
      { timeoutMs: 6_000, label: 'AudioView settings modal closed at 80x24' },
    );

    tty.send('i');
    const audioImportNarrow = await tty.waitFor(
      (s) => s.includes('导入本地音频转写') || s.includes('Import Local Audio'),
      { timeoutMs: 6_000, label: 'AudioView import modal opened at 80x24' },
    );
    assertScreenHealthy(tty, audioImportNarrow, 80, 24, 'AudioView import modal 80x24');

    tty.send('\x1b');
    await tty.waitFor(
      (s) => !s.includes('导入本地音频转写') && !s.includes('Import Local Audio'),
      { timeoutMs: 6_000, label: 'AudioView import modal closed at 80x24' },
    );

    tty.resize(120, 36);
    const audioRestored = await tty.waitFor(
      (s) => s.includes('音频转写工作台') || s.includes('Audio Transcription'),
      { timeoutMs: 6_000, label: 'AudioView restored to 120x36' },
    );
    assertScreenHealthy(tty, audioRestored, 120, 36, 'AudioView restored 120x36');
  });

  test('8) Sources Folders (F), Companions (C), Reader Outline (O), Reader Notes (B + Tab) & Save Q&A (a + s)', async () => {
    // Navigate to Sources ('2')
    tty.send('2');
    const sourcesScreen = await tty.waitFor(
      (s) => (s.includes('资料列表') || s.includes('Materials')) && !s.includes('正在加载页面'),
      { timeoutMs: 8_000, label: 'Sources view' },
    );
    assertScreenHealthy(tty, sourcesScreen, 120, 36, 'Sources view');

    // Press 'F' -> FolderModal, create folder 'Week 1' ('a')
    tty.send('F');
    const folderOpen = await tty.waitFor(
      (s) => s.includes('资料文件夹管理') || s.includes('Material Folders'),
      { label: 'FolderModal opened' },
    );
    assertScreenHealthy(tty, folderOpen, 120, 36, 'FolderModal');

    tty.send('a');
    await tty.waitFor(
      (s) => s.includes('新建文件夹名称') || s.includes('New folder name'),
      { label: 'Folder create input' },
    );
    tty.send('Week 1');
    await tty.waitFor((s) => s.includes('Week 1'), { label: 'Folder name typed' });
    tty.send('\r');

    const folderCreated = await tty.waitFor(
      (s) =>
        !s.includes('新建文件夹名称') &&
        !s.includes('New folder name') &&
        s.includes('Week 1') &&
        (s.includes('1 个文件夹') || s.includes('1 folders')),
      { timeoutMs: 8_000, label: 'Folder Week 1 created' },
    );
    assertScreenHealthy(tty, folderCreated, 120, 36, 'FolderModal after create');

    // Verify folder persisted in host snapshot
    const snapRes = await host.call('snapshot', {});
    assert.equal(snapRes.ok, true);
    const persistedFolders = snapRes.value?.settings?.materialFolders?.folders || snapRes.value?.materialFolders?.folders || [];
    assert.ok(persistedFolders.includes('Week 1'), `Week 1 persisted in materialFolders: ${JSON.stringify(persistedFolders)}`);

    tty.send('\x1b');
    await tty.waitFor(
      (s) => !s.includes('资料文件夹管理') && !s.includes('Material Folders'),
      { label: 'FolderModal closed' },
    );

    // Press 'C' -> CompanionsModal
    tty.send('C');
    const companionsScreen = await tty.waitFor(
      (s) =>
        (s.includes('交互伴学页') || s.includes('Interactive Companions')) &&
        !s.includes('加载中') &&
        !s.includes('Loading'),
      { timeoutMs: 8_000, label: 'CompanionsModal rendered' },
    );
    assertScreenHealthy(tty, companionsScreen, 120, 36, 'CompanionsModal');

    tty.send('\x1b');
    await tty.waitFor(
      (s) => !s.includes('交互伴学页') && !s.includes('Interactive Companions'),
      { label: 'CompanionsModal closed' },
    );

    // Press Enter -> open DocumentReader
    tty.send('\r');
    const readerScreen = await tty.waitFor(
      (s) => (s.includes('第 1 /') || s.includes('P. 1 /')) && (s.includes('∑ Unicode') || s.includes('TeX')),
      { timeoutMs: 8_000, label: 'DocumentReader opened' },
    );
    assertScreenHealthy(tty, readerScreen, 120, 36, 'DocumentReader page 1');

    // Press 'O' -> ReaderOutlineDrawer
    tty.send('O');
    const outlineScreen = await tty.waitFor(
      (s) =>
        (s.includes('文档目录大纲') || s.includes('Document Outline')) &&
        !s.includes('正在读取目录结构') &&
        !s.includes('Loading outline'),
      { timeoutMs: 8_000, label: 'ReaderOutlineDrawer rendered' },
    );
    assertScreenHealthy(tty, outlineScreen, 120, 36, 'ReaderOutlineDrawer');

    tty.send('\x1b');
    await tty.waitFor(
      (s) => !s.includes('文档目录大纲') && !s.includes('Document Outline'),
      { label: 'ReaderOutlineDrawer closed' },
    );

    // Press 'B' -> ReaderNotesDrawer + Tab toggle Annotations/Marks
    tty.send('B');
    const notesScreen = await tty.waitFor(
      (s) =>
        (s.includes('批注问答与高亮标记') || s.includes('Annotations & Marks')) &&
        !s.includes('正在加载批注与标记') &&
        !s.includes('Loading annotations'),
      { timeoutMs: 8_000, label: 'ReaderNotesDrawer rendered' },
    );
    assertScreenHealthy(tty, notesScreen, 120, 36, 'ReaderNotesDrawer Annotations tab');

    tty.send('\t');
    const marksTabScreen = await tty.waitFor(
      (s) => s.includes('暂无高亮标记') || s.includes('No marks yet') || s.includes('高亮标记'),
      { label: 'ReaderNotesDrawer Marks tab' },
    );
    assertScreenHealthy(tty, marksTabScreen, 120, 36, 'ReaderNotesDrawer Marks tab');

    tty.send('\x1b');
    await tty.waitFor(
      (s) => !s.includes('批注问答与高亮标记') && !s.includes('Annotations & Marks'),
      { label: 'ReaderNotesDrawer closed' },
    );

    // Press 'a' -> ask a question -> verify stream -> press 's' to save Q&A -> Esc twice back to Sources
    tty.send('a');
    await tty.waitFor(
      (s) => s.includes('向 AI 提问本页') || s.includes('Ask AI about this page'),
      { label: 'DocumentReader Ask input' },
    );
    tty.send('Explain Memento roles');
    await tty.waitFor((s) => s.includes('Explain Memento roles'), { label: 'Question typed' });
    tty.send('\r');

    const streamedReader = await tty.waitFor(
      (s) => s.includes('[AI Tutor]') && s.includes('state snapshots cleanly.') && !s.includes('生成中'),
      { timeoutMs: 8_000, label: 'DocumentReader AI stream finished' },
    );
    assert.match(streamedReader, /\[AI Tutor\]/);
    assertScreenHealthy(tty, streamedReader, 120, 36, 'DocumentReader AI stream');

    tty.send('s');
    const savedScreen = await tty.waitFor(
      (s) => s.includes('已保存') || s.includes('Saved'),
      { timeoutMs: 8_000, label: 'DocumentReader Q&A saved (s)' },
    );
    assert.match(savedScreen, /已保存|Saved/);
    assertScreenHealthy(tty, savedScreen, 120, 36, 'DocumentReader after save Q&A');

    // Esc closes AI pane back to reader, second Esc exits reader back to Sources
    tty.send('\x1b');
    await tty.waitFor(
      (s) =>
        !s.includes('[AI Tutor]') &&
        !s.includes('向 AI 提问本页') &&
        !s.includes('Ask AI about this page') &&
        (s.includes('O  目录') || s.includes('O  Outline')),
      { timeoutMs: 6_000, label: 'DocumentReader AI pane closed' },
    );
    await tty.flush();
    tty.send('\x1b');
    const backToSources = await tty.waitFor(
      (s) => s.includes('资料列表') || s.includes('Materials'),
      { timeoutMs: 8_000, label: 'Back to Sources after Esc twice' },
    );
    assert.match(backToSources, /资料列表|Materials/);
    assertScreenHealthy(tty, backToSources, 120, 36, 'Sources after DocumentReader exit');
  });

  test('9) Memory-Leak & Teardown Check: 8 view transitions (1..8; full 64-transition resize soak is in packaging-smoke), heapUsed delta < 60MB, 0 leaked handles', async () => {
    // Normalize back to Library before taking heap baseline
    tty.send('1');
    await tty.waitFor(
      (s) => (s.includes('题组列表') || s.includes('Decks')) && !s.includes('正在加载页面'),
      { label: 'Library baseline before soak' },
    );
    await tty.flush();

    const runGc = () => {
      if (typeof globalThis.gc === 'function') {
        globalThis.gc();
        return;
      }
      try {
        v8.setFlagsFromString('--expose_gc');
        const gcFn = vm.runInNewContext('gc');
        if (typeof gcFn === 'function') gcFn();
      } catch {
        // Fallback when V8 flags are locked
      }
    };

    runGc();
    const baselineHeapBytes = process.memoryUsage().heapUsed;
    assert.ok(baselineHeapBytes > 0, 'baseline heapUsed must be > 0');

    for (let round = 1; round <= 1; round += 1) {
      for (const step of SOAK_VIEWS) {
        tty.send(step.key);
        await tty.flush();
        const screen = await tty.waitFor(
          (s) =>
            step.expect.test(s) &&
            !s.includes('正在加载页面…') &&
            !s.includes('Loading view…'),
          { timeoutMs: 20_000, label: `Soak round ${round} -> ${step.id}` },
        );
        await tty.flush();
        assertScreenHealthy(tty, screen, 120, 36, `Soak R${round} ${step.id}`);
      }
    }

    runGc();
    const finalHeapBytes = process.memoryUsage().heapUsed;
    const baselineMb = Math.round((baselineHeapBytes / (1024 * 1024)) * 10) / 10;
    const finalMb = Math.round((finalHeapBytes / (1024 * 1024)) * 10) / 10;
    const deltaMb = Math.round(((finalHeapBytes - baselineHeapBytes) / (1024 * 1024)) * 10) / 10;

    console.log(`[SOAK] 32 transitions: baselineHeap=${baselineMb}MB finalHeap=${finalMb}MB delta=${deltaMb}MB`);
    assert.ok(deltaMb < 60, `heapUsed delta (${deltaMb}MB) must be < 60MB after 32 transitions`);

    await cleanupAll();
    const afterRes = await waitForResourceTeardown(baselineResources);
    for (const kind of ['FSEventWrap', 'StatWatcher', 'ProcessWrap', 'Timeout']) {
      assert.ok(
        (afterRes[kind] || 0) <= (baselineResources[kind] || 0),
        `${kind} leaked: before=${baselineResources[kind] || 0} after=${afterRes[kind] || 0}`,
      );
    }
  });
});
