// Round 7 Parity E2E & Memory Soak verification: node --test tests/parity-e2e.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import xtermPkg from '@xterm/headless';
import { render } from 'ink';
import React from 'react';

const { Terminal } = xtermPkg;
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const distDir = resolve(pkgRoot, 'dist');

// Load directly from built dist/ (avoids loading tsx/esbuild compiler overhead in memory soak measurements).
const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const { StudyHubTuiApp } = await import(pathToFileURL(join(distDir, 'App.mjs')).href);

let H = null;
let R = null;
for (const f of distFiles) {
  if (f.startsWith('host-') || f.startsWith('chunk-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!H && typeof mod.createTuiHost === 'function') H = mod;
    if (!R && typeof mod.displayWidth === 'function') R = mod;
  }
}
assert.ok(H?.createTuiHost, 'dist/ must export createTuiHost');
assert.ok(R?.displayWidth, 'dist/ must export displayWidth');

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-parity-${label}-`));
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

/**
 * Creates a real Ink-compatible virtual TTY backed by `@xterm/headless`.
 */
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

  async function waitFor(predicate, { timeoutMs = 8_000, label = 'condition' } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await flush();
      const screen = readScreen();
      if (predicate(screen)) return screen;
      await sleep(35);
    }
    const finalScreen = readScreen();
    throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms.\n--- SCREEN ---\n${finalScreen}\n--------------`);
  }

  function assertHealthyScreen(screen, expectedCols, contextLabel) {
    const lines = screen.split('\n');
    assert.ok(
      !screen.includes('页面渲染异常') && !screen.includes('View Error'),
      `${contextLabel}: ViewErrorBoundary triggered!\n${screen}`,
    );
    assert.ok(
      !screen.includes('TypeError:') && !screen.includes('ReferenceError:'),
      `${contextLabel}: Runtime JS error rendered!\n${screen}`,
    );
    assert.ok(!screen.includes('\uFFFD'), `${contextLabel}: Replacement char U+FFFD found!\n${screen}`);
    assert.ok(
      !screen.includes('\x1b'),
      `${contextLabel}: Unparsed escape sequence leaked into xterm buffer!\n${screen}`,
    );
    for (let i = 0; i < lines.length; i += 1) {
      const w = R.displayWidth(lines[i]);
      assert.ok(
        w <= expectedCols,
        `${contextLabel}: Row ${i} exceeds cols (${w} > ${expectedCols}): ${JSON.stringify(lines[i])}`,
      );
    }
    const buf = term.buffer.active;
    for (let y = 0; y < term.rows; y += 1) {
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

  return {
    stdin,
    stdout,
    stderr,
    term,
    firstFramePromise,
    flush,
    readLines,
    readScreen,
    send,
    waitFor,
    assertHealthyScreen,
    dispose: () => {
      term.dispose();
      stdin.destroy();
      stdout.destroy();
      stderr.destroy();
    },
  };
}

function tryParseJsonPrefix(raw) {
  const idx = raw.indexOf('\n\nYour previous reply failed validation:');
  const clean = idx >= 0 ? raw.slice(0, idx) : raw;
  return JSON.parse(clean);
}

/** Deterministic model stub supporting translation JSON, daily plan JSON, and live AI streaming. */
function createParityStubComplete() {
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
      await sleep(8);
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

describe('StudyHub TUI Round 7 Parity E2E & Memory Soak', () => {
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
  }

  before(async () => {
    boxDir = await makeTempDir('main');
    dshHome = join(boxDir, 'dsh-home');
    libraryRoot = join(boxDir, 'library');
    process.env.DSH_HOME = dshHome;
    baselineResources = resourceCounts();

    host = await H.createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(boxDir, 'home'),
      libraryRoot,
      injectedComplete: createParityStubComplete(),
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
    await cleanupAll();
    if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = PREV_DSH_HOME;
    await Promise.all(
      tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
    );
  });

  test('1) Global Inbox (I): load sample course, cycle filter (Tab), toggle read (m), mark all read (M), close (Esc)', async () => {
    await tty.waitFor(
      (s) => s.includes('载入示例课程体验') || s.includes('Load the sample course'),
      { label: 'Launchpad render' },
    );

    // Load sample course via 's'
    tty.send('s');
    await tty.waitFor(
      (s) =>
        !s.includes('载入示例课程体验') &&
        (s.includes('示例 · Memento 与 Bridge') || s.includes('Sample · Memento')),
      { timeoutMs: 12_000, label: 'Library after sample load' },
    );
    await sleep(200);
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
    tty.assertHealthyScreen(inboxInit, 120, 'InboxModal initial');
    assert.match(inboxInit, /未读 \(2\)|Unread \(2\)/);
    assert.match(inboxInit, /已读 \(3\)|Read \(3\)/);

    // Cycle filter with Tab: all -> unread -> read -> all
    tty.send('\t');
    const unreadView = await tty.waitFor(
      (s) => !s.includes('[批改完成]') && !s.includes('[前置题]') && s.includes('[笔记草稿]'),
      { label: 'Inbox filter: unread' },
    );
    tty.assertHealthyScreen(unreadView, 120, 'InboxModal filter unread');

    tty.send('\t');
    const readView = await tty.waitFor(
      (s) => (s.includes('[批改完成]') || s.includes('[前置题]')) && !s.includes('[讲解追问]'),
      { label: 'Inbox filter: read' },
    );
    tty.assertHealthyScreen(readView, 120, 'InboxModal filter read');

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
    tty.assertHealthyScreen(afterToggle, 120, 'InboxModal after toggle read');

    // Mark all read ('M') -> unread becomes 0, read becomes 5
    tty.send('M');
    const afterMarkAll = await tty.waitFor(
      (s) => (s.includes('未读 (0)') || s.includes('Unread (0)')) && (s.includes('全部已读') || s.includes('All caught up')),
      { timeoutMs: 8_000, label: 'Inbox mark all read (M)' },
    );
    tty.assertHealthyScreen(afterMarkAll, 120, 'InboxModal after mark all read');

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
    tty.assertHealthyScreen(planOpen, 120, 'DailyPlanModal initial');

    // Trigger suggestion ('g')
    tty.send('g');
    const planSuggested = await tty.waitFor(
      (s) =>
        (s.includes('AI 建议') || s.includes('AI Proposal') || s.includes('本地建议') || s.includes('Local Proposal')) &&
        !s.includes('正在生成计划') &&
        !s.includes('Generating plan'),
      { timeoutMs: 8_000, label: 'DailyPlanModal after suggest (g)' },
    );
    tty.assertHealthyScreen(planSuggested, 120, 'DailyPlanModal suggested');

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
    tty.assertHealthyScreen(settingsFirst, 120, 'CourseSettingsModal initial');

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
    tty.assertHealthyScreen(tab1, 120, 'CourseSettings tab 1 Method');

    // Tab 2: Info & Rename
    tty.send('2');
    const tab2 = await tty.waitFor(
      (s) => (s.includes('课程名称') || s.includes('Course Name')) && (s.includes('重命名课程') || s.includes('Rename course')),
      { label: 'CourseSettings tab 2 (Info & Rename)' },
    );
    tty.assertHealthyScreen(tab2, 120, 'CourseSettings tab 2 Info');

    // Tab 3: Terms
    tty.send('3');
    const tab3 = await tty.waitFor(
      (s) => (s.includes('已掌握') || s.includes('Known')) && (s.includes('待巩固') || s.includes('Unknown')),
      { label: 'CourseSettings tab 3 (Terms)' },
    );
    tty.assertHealthyScreen(tab3, 120, 'CourseSettings tab 3 Terms');

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
    tty.assertHealthyScreen(reviewScreen, 120, 'Review initial card');

    // Press 'S' -> SimilarCardsModal
    tty.send('S');
    const similarScreen = await tty.waitFor(
      (s) =>
        (s.includes('同类 / 易混题对比') || s.includes('Similar & Confusable Cards')) &&
        !s.includes('正在检索同类易混题目') &&
        !s.includes('Searching similar cards'),
      { timeoutMs: 8_000, label: 'SimilarCardsModal rendered' },
    );
    tty.assertHealthyScreen(similarScreen, 120, 'SimilarCardsModal');

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
    tty.assertHealthyScreen(toolsScreen, 120, 'CardToolsModal');
    assert.match(toolsScreen, /编辑题目|Edit Question/);
    assert.match(toolsScreen, /暂停题目|恢复题目|Suspend Card|Resume Card/);
    assert.match(toolsScreen, /斩题 \/ 永久掌握|Slay \/ Mastered/);
    assert.match(toolsScreen, /判分等效改判|Override Grade/);

    tty.send('\x1b');
    await tty.waitFor(
      (s) => !s.includes('题目工具箱') && !s.includes('Card Tools'),
      { label: 'CardToolsModal closed' },
    );

    // Press 'T' -> Bilingual translation via stub model
    tty.send('T');
    const translatedScreen = await tty.waitFor(
      (s) => s.includes('EN 译') && s.includes('[EN]'),
      { timeoutMs: 8_000, label: 'Bilingual translation rendered' },
    );
    tty.assertHealthyScreen(translatedScreen, 120, 'Review bilingual translation');

    // Exit Review: 'q' -> Round Summary -> 'b' -> Library
    tty.send('q');
    const summaryScreen = await tty.waitFor(
      (s) => s.includes('再来一轮') || s.includes('New Round') || s.includes('本轮'),
      { timeoutMs: 8_000, label: 'Round Summary' },
    );
    tty.assertHealthyScreen(summaryScreen, 120, 'Round Summary');

    tty.send('b');
    await tty.waitFor(
      (s) => s.includes('题组列表') || s.includes('Decks'),
      { timeoutMs: 8_000, label: 'Back to Library from Review' },
    );
  });

  test('4) Sources Folders (F), Companions (C), Reader Outline (O), Reader Notes (B + Tab) & Save Q&A (a + s)', async () => {
    // Navigate to Sources ('2')
    tty.send('2');
    const sourcesScreen = await tty.waitFor(
      (s) => (s.includes('资料列表') || s.includes('Materials')) && !s.includes('正在加载页面'),
      { timeoutMs: 8_000, label: 'Sources view' },
    );
    tty.assertHealthyScreen(sourcesScreen, 120, 'Sources view');

    // Press 'F' -> FolderModal, create folder 'Week 1' ('a')
    tty.send('F');
    const folderOpen = await tty.waitFor(
      (s) => s.includes('资料文件夹管理') || s.includes('Material Folders'),
      { label: 'FolderModal opened' },
    );
    tty.assertHealthyScreen(folderOpen, 120, 'FolderModal');

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
    tty.assertHealthyScreen(folderCreated, 120, 'FolderModal after create');

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
    tty.assertHealthyScreen(companionsScreen, 120, 'CompanionsModal');

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
    tty.assertHealthyScreen(readerScreen, 120, 'DocumentReader page 1');

    // Press 'O' -> ReaderOutlineDrawer
    tty.send('O');
    const outlineScreen = await tty.waitFor(
      (s) =>
        (s.includes('文档目录大纲') || s.includes('Document Outline')) &&
        !s.includes('正在读取目录结构') &&
        !s.includes('Loading outline'),
      { timeoutMs: 8_000, label: 'ReaderOutlineDrawer rendered' },
    );
    tty.assertHealthyScreen(outlineScreen, 120, 'ReaderOutlineDrawer');

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
    tty.assertHealthyScreen(notesScreen, 120, 'ReaderNotesDrawer Annotations tab');

    tty.send('\t');
    const marksTabScreen = await tty.waitFor(
      (s) => s.includes('暂无高亮标记') || s.includes('No marks yet') || s.includes('高亮标记'),
      { label: 'ReaderNotesDrawer Marks tab' },
    );
    tty.assertHealthyScreen(marksTabScreen, 120, 'ReaderNotesDrawer Marks tab');

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
    tty.assertHealthyScreen(streamedReader, 120, 'DocumentReader AI stream');

    tty.send('s');
    const savedScreen = await tty.waitFor(
      (s) => s.includes('已保存') || s.includes('Saved'),
      { timeoutMs: 8_000, label: 'DocumentReader Q&A saved (s)' },
    );
    tty.assertHealthyScreen(savedScreen, 120, 'DocumentReader after save Q&A');

    // Esc closes AI pane back to reader, second Esc exits reader back to Sources
    tty.send('\x1b');
    await tty.waitFor(
      (s) => !s.includes('s 存笔记') && !s.includes('s Save Note'),
      { label: 'DocumentReader AI pane closed' },
    );
    tty.send('\x1b');
    const backToSources = await tty.waitFor(
      (s) => s.includes('资料列表') || s.includes('Materials'),
      { timeoutMs: 8_000, label: 'Back to Sources after Esc twice' },
    );
    tty.assertHealthyScreen(backToSources, 120, 'Sources after DocumentReader exit');
  });

  test('5) Memory-Leak Soak Test: 32 rapid view transitions (1..8 x 4), heapUsed delta < 60MB, 0 leaked handles', async () => {
    // Normalize back to Library before taking heap baseline
    tty.send('1');
    await tty.waitFor(
      (s) => (s.includes('题组列表') || s.includes('Decks')) && !s.includes('正在加载页面'),
      { label: 'Library baseline before soak' },
    );
    await sleep(100);
    await tty.flush();

    if (typeof globalThis.gc === 'function') globalThis.gc();
    const baselineHeapBytes = process.memoryUsage().heapUsed;

    for (let round = 1; round <= 4; round += 1) {
      for (const step of SOAK_VIEWS) {
        tty.send(step.key);
        const screen = await tty.waitFor(
          (s) =>
            step.expect.test(s) &&
            !s.includes('正在加载页面…') &&
            !s.includes('Loading view…'),
          { timeoutMs: 10_000, label: `Soak round ${round} -> ${step.id}` },
        );
        tty.assertHealthyScreen(screen, 120, `Soak R${round} ${step.id}`);
      }
    }

    if (typeof globalThis.gc === 'function') globalThis.gc();
    const finalHeapBytes = process.memoryUsage().heapUsed;
    const baselineMb = Math.round((baselineHeapBytes / (1024 * 1024)) * 10) / 10;
    const finalMb = Math.round((finalHeapBytes / (1024 * 1024)) * 10) / 10;
    const deltaMb = Math.round(((finalHeapBytes - baselineHeapBytes) / (1024 * 1024)) * 10) / 10;

    console.log(`[SOAK] 32 transitions: baselineHeap=${baselineMb}MB finalHeap=${finalMb}MB delta=${deltaMb}MB`);
    assert.ok(deltaMb < 60, `heapUsed delta (${deltaMb}MB) must be < 60MB after 32 transitions`);

    await cleanupAll();
    await sleep(100);
    const afterRes = resourceCounts();
    for (const kind of ['FSEventWrap', 'StatWatcher', 'ProcessWrap', 'Timeout']) {
      assert.ok(
        (afterRes[kind] || 0) <= (baselineResources[kind] || 0),
        `${kind} leaked: before=${baselineResources[kind] || 0} after=${afterRes[kind] || 0}`,
      );
    }
  });
});
