// Round 14 Deep Interactive Core Views E2E: node --test tests/deep-views-e2e.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
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
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-deep-${label}-`));
  tempDirs.push(d);
  return d;
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
    resize,
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

describe('StudyHub TUI Deep Interactive Core Views E2E', () => {
  let boxDir;
  let dshHome;
  let libraryRoot;
  let host;
  let tty;
  let inkInstance;
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

    host = await H.createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(boxDir, 'home'),
      libraryRoot,
      injectedComplete: async (_system, prompt) => {
        if (String(prompt || '').includes('OK?')) return 'OK';
        return '{}';
      },
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
    await sleep(100);
    await tty.flush();
  });

  after(async () => {
    try {
      await cleanupAll();
    } finally {
      if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = PREV_DSH_HOME;
      await Promise.all(
        tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
      );
    }
  });

  test('1) Mock Exam (5) End-to-End: start timed written exam -> answer -> nav -> submit -> report -> return', async () => {
    tty.send('5');
    const setupScreen = await tty.waitFor(
      (s) =>
        (s.includes('组卷设置') || s.includes('Exam Setup')) &&
        (s.includes('选择题卷') || s.includes('Written MCQ')) &&
        !s.includes('正在加载页面'),
      { timeoutMs: 10_000, label: 'ExamSetup rendered' },
    );
    tty.assertHealthyScreen(setupScreen, 120, 'ExamSetup initial');

    // Start timed written mock exam with Enter
    tty.send('\r');
    const runningScreen = await tty.waitFor(
      (s) =>
        (s.includes('选择题卷 · 1/') || s.includes('Written MCQ · 1/')) &&
        (/剩余 \d{2}:\d{2}/.test(s) || /Left \d{2}:\d{2}/.test(s)) &&
        s.includes('[1]'),
      { timeoutMs: 10_000, label: 'ExamRunner written exam started with timer and options' },
    );
    tty.assertHealthyScreen(runningScreen, 120, 'ExamRunner initial Q1');

    // Select option 1
    tty.send('1');
    const pickedScreen = await tty.waitFor(
      (s) => (s.includes('已答 1/') || s.includes('Ans 1/')) && s.includes('◉'),
      { timeoutMs: 8_000, label: 'Option 1 selected on Q1' },
    );
    tty.assertHealthyScreen(pickedScreen, 120, 'ExamRunner Q1 selected');

    // Navigate next ('n') -> Q2, then prev ('p') -> Q1
    tty.send('n');
    const q2Screen = await tty.waitFor(
      (s) => s.includes('选择题卷 · 2/') || s.includes('Written MCQ · 2/'),
      { timeoutMs: 8_000, label: 'Moved to Q2 with n' },
    );
    tty.assertHealthyScreen(q2Screen, 120, 'ExamRunner Q2');

    tty.send('p');
    const backQ1Screen = await tty.waitFor(
      (s) => (s.includes('选择题卷 · 1/') || s.includes('Written MCQ · 1/')) && s.includes('◉'),
      { timeoutMs: 8_000, label: 'Moved back to Q1 with p' },
    );
    tty.assertHealthyScreen(backQ1Screen, 120, 'ExamRunner back to Q1');

    // Submit via Ctrl+S -> confirm dialog -> 'y'
    tty.send('\x13');
    const submitDialog = await tty.waitFor(
      (s) => s.includes('确认交卷') || s.includes('Submit Exam'),
      { timeoutMs: 8_000, label: 'Exam submit confirmation dialog' },
    );
    tty.assertHealthyScreen(submitDialog, 120, 'ExamRunner ConfirmDialog');

    tty.send('y');
    const reportScreen = await tty.waitFor(
      (s) =>
        (s.includes('考试成绩单') || s.includes('Exam Report')) &&
        /\d+%/.test(s) &&
        (s.includes('正确') || s.includes('OK')) &&
        (s.includes('各主题正确率') || s.includes('Accuracy by Topic') || s.includes('错题与未答') || s.includes('Wrong & Skipped')),
      { timeoutMs: 10_000, label: 'ExamReportView rendered score/accuracy/breakdown' },
    );
    tty.assertHealthyScreen(reportScreen, 120, 'ExamReportView');

    // Return cleanly to ExamSetup via 'b'
    tty.send('b');
    const returnedSetup = await tty.waitFor(
      (s) =>
        (s.includes('组卷设置') || s.includes('Exam Setup')) &&
        (s.includes('历史考卷') || s.includes('Past Exams')) &&
        (s.includes('[选择题卷]') || s.includes('[Written]')),
      { timeoutMs: 8_000, label: 'Returned cleanly to ExamSetup with submitted exam in history' },
    );
    tty.assertHealthyScreen(returnedSetup, 120, 'ExamSetup after report return');
  });

  test('2) Notes (n) Full CRUD + Markdown Export', async () => {
    tty.send('n');
    const notesInit = await tty.waitFor(
      (s) =>
        (s.includes('Unicode Math') || s.includes('Raw LaTeX') || s.includes('笔记正文') || s.includes('Note Reader')) &&
        !s.includes('载入笔记中') &&
        !s.includes('正在加载页面'),
      { timeoutMs: 10_000, label: 'NotesView rendered' },
    );
    await tty.flush();
    tty.assertHealthyScreen(notesInit, 120, 'NotesView initial');

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
    tty.assertHealthyScreen(createModal, 120, 'NoteEditorModal create');

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
    // (workaround for NotesView.tsx L193-197 selection reset while list reloads)
    let createdNoteScreen = tty.readScreen();
    for (let step = 0; step < 3; step += 1) {
      if (/Deep Views E2E Note\s+(草稿|Draft)/.test(createdNoteScreen)) {
        break;
      }
      tty.send('k');
      await sleep(80);
      await tty.flush();
      createdNoteScreen = tty.readScreen();
    }
    createdNoteScreen = await tty.waitFor(
      (s) => /Deep Views E2E Note\s+(草稿|Draft)/.test(s),
      { timeoutMs: 6_000, label: 'Created note selected and shown in detail pane' },
    );
    tty.assertHealthyScreen(createdNoteScreen, 120, 'NotesView after create');

    // Edit note via 'e' (starts on markdown field)
    tty.send('e');
    const editModal = await tty.waitFor(
      (s) => s.includes('编辑笔记') || s.includes('Edit Note'),
      { timeoutMs: 8_000, label: 'NoteEditorModal edit opened' },
    );
    tty.assertHealthyScreen(editModal, 120, 'NoteEditorModal edit');

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
    tty.assertHealthyScreen(editedScreen, 120, 'NotesView after edit');

    // Export Markdown via 'x' to a deterministic temp file
    const exportTarget = join(boxDir, 'exported-deep-note.md');
    tty.send('x');
    const exportModal = await tty.waitFor(
      (s) => s.includes('导出 Markdown 笔记') || s.includes('Export Note as Markdown'),
      { timeoutMs: 8_000, label: 'Notes export modal opened' },
    );
    tty.assertHealthyScreen(exportModal, 120, 'NotesView export modal');

    tty.send('\x15');
    await tty.flush();
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
    tty.assertHealthyScreen(afterExport, 120, 'NotesView after export');

    const exportedMd = await readFile(exportTarget, 'utf8');
    assert.ok(exportedMd.includes(appendedLine), `Exported markdown must include appended line, got:\n${exportedMd}`);

    // Delete note via 'd' -> confirm with 'y'
    tty.send('d');
    const deleteDialog = await tty.waitFor(
      (s) => s.includes('删除笔记') || s.includes('Delete Note'),
      { timeoutMs: 8_000, label: 'Delete note confirmation dialog' },
    );
    tty.assertHealthyScreen(deleteDialog, 120, 'NotesView delete ConfirmDialog');

    tty.send('y');
    const afterDelete = await tty.waitFor(
      (s) => !s.includes('删除笔记') && !s.includes('Delete Note') && !s.includes(noteTitle),
      { timeoutMs: 8_000, label: 'Deleted note removed from NotesView' },
    );
    tty.assertHealthyScreen(afterDelete, 120, 'NotesView after delete');

    const listRes = await host.call('note.list', {});
    assert.equal(listRes.ok, true);
    assert.ok(
      !(listRes.value?.notes || []).some((item) => item.title === noteTitle),
      'Deleted note must not remain in note.list',
    );
  });

  test('3) WrongBook (4) Inspection & Practice Launch -> ReviewView -> Return', async () => {
    tty.send('4');
    const wbInit = await tty.waitFor(
      (s) =>
        (s.includes('错题本') || s.includes('Mistakes')) &&
        (s.includes('待巩固') || s.includes('To Review')) &&
        !s.includes('正在加载错题本') &&
        !s.includes('正在加载页面') &&
        (s.includes('题干') || s.includes('Question')),
      { timeoutMs: 10_000, label: 'WrongBookView rendered with sample weak cards' },
    );
    tty.assertHealthyScreen(wbInit, 120, 'WrongBookView initial');

    // Cycle through tabs: weak -> confusable -> reason -> all -> weak
    tty.send('\t');
    const confusableTab = await tty.waitFor(
      (s) => s.includes('易混淆') || s.includes('Confusable'),
      { timeoutMs: 6_000, label: 'WrongBook confusable tab' },
    );
    tty.assertHealthyScreen(confusableTab, 120, 'WrongBookView confusable tab');

    tty.send('\t');
    const reasonTab = await tty.waitFor(
      (s) =>
        ((s.includes('错因筛选') || s.includes('筛选[f]:')) && (s.includes('全部错因') || s.includes('全部('))) ||
        ((s.includes('Reason [f]:') || s.includes('Filter[f]:')) && (s.includes('All reasons') || s.includes('All('))),
      { timeoutMs: 6_000, label: 'WrongBook reason tab with sub-filter' },
    );
    tty.assertHealthyScreen(reasonTab, 120, 'WrongBookView reason tab');

    // Cycle back to 'all' (includes history + weak) and then 'weak'
    tty.send('\t');
    const allTab = await tty.waitFor(
      (s) => (s.includes('全部 (') || s.includes('All (')) && !s.includes('筛选[f]:') && !s.includes('错因筛选'),
      { timeoutMs: 6_000, label: 'WrongBook all (weak+history) tab' },
    );
    tty.assertHealthyScreen(allTab, 120, 'WrongBookView all tab');

    tty.send('\t');
    const backWeak = await tty.waitFor(
      (s) => (s.includes('待巩固') || s.includes('To Review')) && (s.includes('题干') || s.includes('Question')),
      { timeoutMs: 6_000, label: 'WrongBook returned to weak tab' },
    );
    tty.assertHealthyScreen(backWeak, 120, 'WrongBookView back to weak tab');

    // Launch 0-token wrongbook practice with Enter -> ReviewView
    tty.send('\r');
    const reviewScreen = await tty.waitFor(
      (s) =>
        (s.includes('[D]工具') || s.includes('[D]Tools')) &&
        (s.includes('[L]带学') || s.includes('[L]Teach')) &&
        !s.includes('正在准备复习队列'),
      { timeoutMs: 10_000, label: 'ReviewView launched from WrongBookView' },
    );
    tty.assertHealthyScreen(reviewScreen, 120, 'ReviewView from WrongBook');

    // Return cleanly via Esc -> WrongBookView
    tty.send('\x1b');
    const returnedWb = await tty.waitFor(
      (s) => (s.includes('错题本') || s.includes('Mistakes')) && (s.includes('错题列表') || s.includes('Mistakes')),
      { timeoutMs: 8_000, label: 'Returned cleanly from ReviewView to WrongBookView' },
    );
    tty.assertHealthyScreen(returnedWb, 120, 'WrongBookView after returning from ReviewView');
  });

  test('4) Skeleton (8) Interactive Tree + Audio (a) Terminal Degradation Notice at 120x36 & 80x24', async () => {
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
    tty.assertHealthyScreen(skelInit, 120, 'SkeletonView initial');

    // Navigate down/up, toggle collapse/expand, expand-all ('e'), pane switch ('Tab'), and switcher modal ('s' + Esc)
    tty.send('j');
    await tty.flush();
    tty.send('k');
    await tty.flush();
    tty.send(' ');
    await tty.flush();
    tty.send('l');
    await tty.flush();
    tty.send('h');
    await tty.flush();
    tty.send('e');
    await tty.flush();
    tty.send('\t');
    await tty.flush();
    tty.send('\t');
    const skelAfterTreeOps = await tty.waitFor(
      (s) => s.includes('知识层级树') || s.includes('Knowledge Tree'),
      { timeoutMs: 6_000, label: 'SkeletonView healthy after tree navigation & expand/collapse' },
    );
    tty.assertHealthyScreen(skelAfterTreeOps, 120, 'SkeletonView after tree operations');

    tty.send('s');
    const switcherModal = await tty.waitFor(
      (s) => s.includes('选择已保存的知识骨架') || s.includes('Switch Knowledge Skeleton'),
      { timeoutMs: 6_000, label: 'Skeleton switcher modal opened' },
    );
    tty.assertHealthyScreen(switcherModal, 120, 'SkeletonView switcher modal');

    tty.send('\x1b');
    const afterSwitcher = await tty.waitFor(
      (s) => !s.includes('选择已保存的知识骨架') && !s.includes('Switch Knowledge Skeleton'),
      { timeoutMs: 6_000, label: 'Skeleton switcher modal closed' },
    );
    tty.assertHealthyScreen(afterSwitcher, 120, 'SkeletonView after switcher close');

    // Navigate to AudioView ('a')
    tty.send('a');
    const audioWide = await tty.waitFor(
      (s) =>
        (s.includes('音频转写工作台') || s.includes('Audio Transcription')) &&
        (s.includes('纯终端模式已禁用') || s.includes('disabled in terminal mode')) &&
        !s.includes('正在加载页面'),
      { timeoutMs: 10_000, label: 'AudioView rendered with terminal mic degradation notice at 120x36' },
    );
    tty.assertHealthyScreen(audioWide, 120, 'AudioView 120x36');

    // Open Audio settings ('s') & close ('Esc'), then open Import ('i') & close ('Esc') at 120x36
    tty.send('s');
    const audioSettingsWide = await tty.waitFor(
      (s) => s.includes('音频转写服务配置') || s.includes('Audio Transcription Providers'),
      { timeoutMs: 6_000, label: 'AudioView settings modal opened at 120x36' },
    );
    tty.assertHealthyScreen(audioSettingsWide, 120, 'AudioView settings modal 120x36');

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
    tty.assertHealthyScreen(audioImportWide, 120, 'AudioView import modal 120x36');

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
    tty.assertHealthyScreen(audioNarrow, 80, 'AudioView 80x24');

    tty.send('s');
    const audioSettingsNarrow = await tty.waitFor(
      (s) => s.includes('音频转写服务配置') || s.includes('Audio Transcription Providers'),
      { timeoutMs: 6_000, label: 'AudioView settings modal opened at 80x24' },
    );
    tty.assertHealthyScreen(audioSettingsNarrow, 80, 'AudioView settings modal 80x24');

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
    tty.assertHealthyScreen(audioImportNarrow, 80, 'AudioView import modal 80x24');

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
    tty.assertHealthyScreen(audioRestored, 120, 'AudioView restored 120x36');
  });
});
