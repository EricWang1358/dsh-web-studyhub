// Round 11 Features E2E verification: node --test tests/round11-e2e.test.mjs
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
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round11-${label}-`));
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

/**
 * Deterministic model stub handling JSON contracts for card.terms,
 * card.followup.suggest, teach.start, teach.answer, and streaming tutor calls.
 */
function createRound11StubComplete() {
  return async (system, prompt, execution = {}) => {
    const s = String(system || '');
    const p = String(prompt || '');
    const task = execution?.task;

    if (p.includes('OK?')) return 'OK';

    if (task === 'card.terms' || s.includes('unfamiliar technical terms')) {
      const payload = JSON.parse(p);
      const haystack = [
        payload.prompt,
        payload.answer,
        payload.explanation,
        payload.clozeText,
        ...(Array.isArray(payload.options) ? payload.options.map((o) => `${o?.text || ''} ${o?.explanation || ''}`) : []),
      ]
        .filter(Boolean)
        .join(' ');
      const candidates = ['Memento', 'Caretaker', 'Originator', 'Bridge', 'Snapshot', '报表', '快照'];
      const picked = candidates.filter((term) => haystack.includes(term));
      return JSON.stringify({ terms: picked.length > 0 ? picked : ['Memento'] });
    }

    if (task === 'card.followup.suggest' || s.includes('suggest exactly 3') || s.includes('推荐恰好 3 个')) {
      return JSON.stringify({
        questions: [
          'Caretaker 为何不能读取快照内容？',
          'Memento 与 Originator 的职责边界是什么？',
          '什么场景不适合使用 Memento 模式？',
        ],
      });
    }

    if (s.includes('You are a source-grounded tutor')) {
      return JSON.stringify({
        diagnosis: '区分历史管理者 Caretaker 与快照容器 Memento 的职责边界',
        rungs: [
          {
            lesson: 'Originator 拥有内部状态，负责创建和恢复快照；Caretaker 只负责保管历史列表。',
            check: '在 Memento 模式中，哪个角色负责保存历史列表而不检查快照内容？',
            answer: 'Caretaker',
          },
          {
            lesson: 'Memento 本身是一份不透明的状态快照，通过窄接口对外隐藏内部结构。',
            check: 'Caretaker 可以直接读取或修改 Memento 内部的字段吗？',
            answer: '不能',
          },
        ],
        transfer: '将「状态创建/恢复（Originator）」与「历史保管（Caretaker）」分离即可守住封装边界。',
      });
    }

    if (s.includes('Judge only the current prerequisite check')) {
      const req = JSON.parse(p);
      assert.ok(String(req.learnerAnswer || '').trim().length > 0, 'teach.answer payload must include learnerAnswer');
      return JSON.stringify({
        passed: true,
        feedback: '回答正确！Caretaker 负责管理历史快照列表，但不检查快照内部数据。',
      });
    }

    const chunks = ['[AI 助教] ', 'Caretaker 维护快照历史，', 'Originator 创建并恢复快照。'];
    for (const chunk of chunks) {
      execution.signal?.throwIfAborted?.();
      execution.onOutput?.(chunk);
      await sleep(8);
    }
    return chunks.join('');
  };
}

describe('StudyHub TUI Round 11 Features E2E', () => {
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
      injectedComplete: createRound11StubComplete(),
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
      await Promise.all(
        tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
      );
    }
  });

  test('1) Review Mastery (* Focus toggle, D CardTools terms, h->s Follow-up chips, L Socratic TeachModal)', async () => {
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
    await sleep(120);
    await tty.flush();

    // Open Review on first deck via Enter
    tty.send('\r');
    const reviewInit = await tty.waitFor(
      (s) =>
        (s.includes('[D]工具') || s.includes('[D]Tools')) &&
        (s.includes('[L]带学') || s.includes('[L]Teach')) &&
        !s.includes('正在准备复习队列'),
      { timeoutMs: 10_000, label: 'Review active card rendered' },
    );
    tty.assertHealthyScreen(reviewInit, 120, 'Review initial card');

    // 1a. Focus toggle ('*') -> appears -> toggles off -> toggles back on
    tty.send('*');
    const focusOnScreen = await tty.waitFor(
      (s) => s.includes('★ 重点') || s.includes('* Focus') || s.includes('* 重点'),
      { timeoutMs: 8_000, label: 'Focus badge toggled on' },
    );
    tty.assertHealthyScreen(focusOnScreen, 120, 'Review Focus badge ON');

    tty.send('*');
    const focusOffScreen = await tty.waitFor(
      (s) => !s.includes('★ 重点') && !s.includes('* Focus') && !s.includes('* 重点'),
      { timeoutMs: 8_000, label: 'Focus badge toggled off' },
    );
    tty.assertHealthyScreen(focusOffScreen, 120, 'Review Focus badge OFF');

    // Leave Focus ON and verify persisted in snapshot/deck
    tty.send('*');
    await tty.waitFor(
      (s) => s.includes('★ 重点') || s.includes('* Focus') || s.includes('* 重点'),
      { timeoutMs: 8_000, label: 'Focus badge toggled back on' },
    );

    // 1b. CardTools ('D') -> extract technical terms ('6') -> Esc back
    tty.send('D');
    const toolsMenu = await tty.waitFor(
      (s) =>
        (s.includes('题目工具箱') || s.includes('Card Tools')) &&
        (s.includes('提取核心术语') || s.includes('Extract Technical Terms')),
      { timeoutMs: 8_000, label: 'CardToolsModal menu opened' },
    );
    tty.assertHealthyScreen(toolsMenu, 120, 'CardToolsModal menu');

    tty.send('6');
    const termsScreen = await tty.waitFor(
      (s) =>
        (s.includes('核心术语 / 生词提取') || s.includes('Technical Terms')) &&
        !s.includes('共 0 项') &&
        !s.includes('0 terms') &&
        !s.includes('正在提取本题核心专业术语'),
      { timeoutMs: 8_000, label: 'CardToolsModal extracted terms rendered' },
    );
    tty.assertHealthyScreen(termsScreen, 120, 'CardToolsModal terms');

    tty.send('\x1b');
    await tty.waitFor(
      (s) => s.includes('编辑题目') || s.includes('Edit Question'),
      { timeoutMs: 8_000, label: 'CardToolsModal returned to menu' },
    );
    tty.send('\x1b');
    await tty.waitFor(
      (s) => !s.includes('题目工具箱') && !s.includes('Card Tools'),
      { timeoutMs: 8_000, label: 'CardToolsModal closed' },
    );

    // 1c. AiHelpDrawer ('h') -> Suggest follow-ups ('s') -> Ask chip ('1') -> Esc close
    tty.send('h');
    const drawerReady = await tty.waitFor(
      (s) =>
        (s.includes('AI 帮我理解') || s.includes('AI Tutor')) &&
        (s.includes('已就绪') || s.includes('Ready')) &&
        s.includes('Caretaker 维护快照历史'),
      { timeoutMs: 8_000, label: 'AiHelpDrawer opened and initial stream finished' },
    );
    tty.assertHealthyScreen(drawerReady, 120, 'AiHelpDrawer initial');

    tty.send('s');
    const chipsScreen = await tty.waitFor(
      (s) =>
        s.includes('[1]') &&
        s.includes('Caretaker 为何不能读取快照内容？') &&
        !s.includes('正在生成推荐追问'),
      { timeoutMs: 8_000, label: 'AiHelpDrawer suggested follow-up chips rendered' },
    );
    tty.assertHealthyScreen(chipsScreen, 120, 'AiHelpDrawer chips');

    tty.send('1');
    const afterChipAsk = await tty.waitFor(
      (s) =>
        (s.includes('你: Caretaker 为何不能读取快照内容') || s.includes('You: Caretaker')) &&
        (s.includes('已就绪') || s.includes('Ready')) &&
        !s.includes('正在流式生成'),
      { timeoutMs: 8_000, label: 'AiHelpDrawer chip 1 answered' },
    );
    tty.assertHealthyScreen(afterChipAsk, 120, 'AiHelpDrawer after chip 1');

    tty.send('\x1b');
    const reviewAfterDrawer = await tty.waitFor(
      (s) => !s.includes('AI 帮我理解') && !s.includes('AI Tutor'),
      { timeoutMs: 8_000, label: 'AiHelpDrawer closed' },
    );
    await tty.flush();
    assert.ok(
      reviewAfterDrawer.includes('[L]带学') || reviewAfterDrawer.includes('[L]Teach'),
      `Expected to remain in ReviewView after closing AiHelpDrawer, got:\n${reviewAfterDrawer}`,
    );

    // 1d. Answer card first (required before teach.start), then open TeachModal ('L')
    if (
      reviewAfterDrawer.includes('翻开答案') ||
      reviewAfterDrawer.includes('翻卡') ||
      reviewAfterDrawer.includes('flip card') ||
      reviewAfterDrawer.includes('Flip')
    ) {
      tty.send(' ');
      await tty.waitFor(
        (s) => s.includes('FSRS-6') || s.includes('1-4'),
        { timeoutMs: 8_000, label: 'Flashcard flipped for rating' },
      );
      await tty.flush();
      tty.send('2');
    } else if (reviewAfterDrawer.includes('填空') || reviewAfterDrawer.includes('Type')) {
      tty.send('i');
      await tty.flush();
      tty.send('Originator');
      await tty.flush();
      tty.send('\r');
    } else {
      tty.send('1');
    }
    await tty.waitFor(
      (s) =>
        s.includes('回答正确') ||
        s.includes('Correct') ||
        s.includes('回答有误') ||
        s.includes('Incorrect') ||
        s.includes('已自报') ||
        s.includes('Self-reported'),
      { timeoutMs: 8_000, label: 'Card answered before TeachModal' },
    );

    tty.send('L');
    const teachOpen = await tty.waitFor(
      (s) =>
        (s.includes('苏格拉底带学模式') || s.includes('Socratic Teach Mode')) &&
        (s.includes('第 1/2 步') || s.includes('Step 1/2')) &&
        s.includes('Originator 拥有内部状态') &&
        !s.includes('正在生成苏格拉底带学阶梯'),
      { timeoutMs: 8_000, label: 'TeachModal opened with Step 1/2' },
    );
    tty.assertHealthyScreen(teachOpen, 120, 'TeachModal Step 1');

    tty.send('Caretaker');
    await tty.waitFor(
      (s) => s.includes('Caretaker'),
      { timeoutMs: 4_000, label: 'Answer typed in TeachModal' },
    );
    tty.send('\r');
    const teachUpdated = await tty.waitFor(
      (s) =>
        (s.includes('导师点评') || s.includes('Tutor Feedback')) &&
        s.includes('回答正确') &&
        (s.includes('第 2/2 步') || s.includes('Step 2/2')),
      { timeoutMs: 8_000, label: 'TeachModal updated after teach.answer' },
    );
    tty.assertHealthyScreen(teachUpdated, 120, 'TeachModal Step 2');

    tty.send('\x1b');
    const reviewAfterTeach = await tty.waitFor(
      (s) => !s.includes('苏格拉底带学模式') && !s.includes('Socratic Teach Mode'),
      { timeoutMs: 8_000, label: 'TeachModal closed via Esc' },
    );
    tty.assertHealthyScreen(reviewAfterTeach, 120, 'Review after TeachModal closed');
  });

  test('2) AI Guided Study Workbench (g in LibraryView: create -> pause -> resume -> end -> Esc)', async () => {
    tty.send('1');
    const libScreen = await tty.waitFor(
      (s) => (s.includes('题组列表') || s.includes('Decks')) && !s.includes('正在加载页面'),
      { timeoutMs: 8_000, label: 'LibraryView rendered' },
    );
    tty.assertHealthyScreen(libScreen, 120, 'LibraryView before GuidedStudyModal');

    tty.send('g');
    const guidedOpen = await tty.waitFor(
      (s) =>
        (s.includes('AI 带学工作台') || s.includes('Guided Study Workbench')) &&
        !s.includes('正在读取带学工作台'),
      { timeoutMs: 8_000, label: 'GuidedStudyModal opened' },
    );
    tty.assertHealthyScreen(guidedOpen, 120, 'GuidedStudyModal initial');

    // Create new session ('n' -> Ctrl+U clear prefill -> type goal -> Enter)
    tty.send('n');
    await tty.waitFor(
      (s) => s.includes('新目标:') || s.includes('Goal:'),
      { timeoutMs: 8_000, label: 'GuidedStudyModal create input visible' },
    );

    const goalTitle = 'Master Memento Round 11';
    tty.send('\x15');
    await tty.flush();
    tty.send(goalTitle);
    await tty.waitFor(
      (s) => s.includes(goalTitle),
      { timeoutMs: 5_000, label: 'GuidedStudyModal goal title typed' },
    );
    tty.send('\r');

    const createdScreen = await tty.waitFor(
      (s) =>
        s.includes(goalTitle) &&
        (s.includes('进行中') || s.includes('Active')) &&
        !s.includes('新目标:'),
      { timeoutMs: 8_000, label: 'GuidedStudyModal new active session rendered' },
    );
    tty.assertHealthyScreen(createdScreen, 120, 'GuidedStudyModal active session');

    // Pause ('p')
    tty.send('p');
    const pausedScreen = await tty.waitFor(
      (s) => s.includes(goalTitle) && (s.includes('已暂停') || s.includes('Paused')),
      { timeoutMs: 8_000, label: 'GuidedStudyModal session paused' },
    );
    tty.assertHealthyScreen(pausedScreen, 120, 'GuidedStudyModal paused session');

    // Resume ('r')
    tty.send('r');
    const resumedScreen = await tty.waitFor(
      (s) => s.includes(goalTitle) && (s.includes('进行中') || s.includes('Active')),
      { timeoutMs: 8_000, label: 'GuidedStudyModal session resumed' },
    );
    tty.assertHealthyScreen(resumedScreen, 120, 'GuidedStudyModal resumed session');

    // End ('e' + 'y' confirm)
    tty.send('e');
    const endConfirm = await tty.waitFor(
      (s) => s.includes('结束带学会话') || s.includes('End Guided Study Session'),
      { timeoutMs: 8_000, label: 'GuidedStudyModal end confirmation dialog' },
    );
    tty.assertHealthyScreen(endConfirm, 120, 'GuidedStudyModal end ConfirmDialog');

    tty.send('y');
    const endedScreen = await tty.waitFor(
      (s) =>
        s.includes(goalTitle) &&
        (s.includes('已结束') || s.includes('Ended')) &&
        !s.includes('结束带学会话'),
      { timeoutMs: 8_000, label: 'GuidedStudyModal session ended' },
    );
    tty.assertHealthyScreen(endedScreen, 120, 'GuidedStudyModal ended session');

    // Esc closes cleanly
    tty.send('\x1b');
    const libAfterGuided = await tty.waitFor(
      (s) => !s.includes('AI 带学工作台') && !s.includes('Guided Study Workbench'),
      { timeoutMs: 8_000, label: 'GuidedStudyModal closed via Esc' },
    );
    tty.assertHealthyScreen(libAfterGuided, 120, 'LibraryView after GuidedStudyModal closed');
  });

  test('3) CourseSettings Exam Alignment Tab 4 (C -> 4 -> a) & BookView Final-Week Crunch (7 -> w)', async () => {
    // Open CourseSettingsModal ('C') in LibraryView
    tty.send('C');
    const settingsOpen = await tty.waitFor(
      (s) =>
        (s.includes('课程设置与学法') || s.includes('Course Settings')) &&
        !s.includes('正在读取课程配置'),
      { timeoutMs: 8_000, label: 'CourseSettingsModal opened' },
    );
    tty.assertHealthyScreen(settingsOpen, 120, 'CourseSettingsModal Tab 1');

    // Switch to Tab 4 ('4')
    tty.send('4');
    const alignScreen = await tty.waitFor(
      (s) =>
        (s.includes('考前对齐') || s.includes('Exam Align')) &&
        (s.includes('重点掌握度') || s.includes('Focus Mastery')) &&
        !s.includes('正在读取考前对齐与重点进度'),
      { timeoutMs: 8_000, label: 'CourseSettingsModal Tab 4 Exam Alignment rendered' },
    );
    tty.assertHealthyScreen(alignScreen, 120, 'CourseSettingsModal Tab 4');

    const wasEnabled = alignScreen.includes('考前对齐: 已开启') || alignScreen.includes('Exam Align: ON');

    // Toggle alignment via 'a'
    tty.send('a');
    const toggledAlignScreen = await tty.waitFor(
      (s) =>
        wasEnabled
          ? s.includes('考前对齐: 已关闭') || s.includes('Exam Align: OFF')
          : s.includes('考前对齐: 已开启') || s.includes('Exam Align: ON'),
      { timeoutMs: 8_000, label: 'CourseSettingsModal Tab 4 alignment toggled' },
    );
    tty.assertHealthyScreen(toggledAlignScreen, 120, 'CourseSettingsModal Tab 4 toggled');

    // Esc closes CourseSettingsModal
    tty.send('\x1b');
    await tty.waitFor(
      (s) => !s.includes('课程设置与学法') && !s.includes('Course Settings'),
      { timeoutMs: 8_000, label: 'CourseSettingsModal closed via Esc' },
    );

    // Navigate to BookView ('7') and wait for BookView content (not SideNav label)
    tty.send('7');
    const bookScreen = await tty.waitFor(
      (s) =>
        (s.includes('Math: Unicode') ||
          s.includes('Math: LaTeX') ||
          s.includes('这门课还没有复习全书') ||
          s.includes('章节目录')) &&
        !s.includes('正在打开复习全书') &&
        !s.includes('正在加载页面'),
      { timeoutMs: 8_000, label: 'BookView rendered' },
    );
    await tty.flush();
    tty.assertHealthyScreen(bookScreen, 120, 'BookView initial');

    // Press 'w' -> BookCrunchModal opens cleanly at 120x36
    tty.send('w');
    const crunchWide = await tty.waitFor(
      (s) =>
        (s.includes('期末一周冲刺') || s.includes('Final Week Crunch')) &&
        !s.includes('正在载入期末一周日程与模拟卷'),
      { timeoutMs: 8_000, label: 'BookCrunchModal opened at 120x36' },
    );
    tty.assertHealthyScreen(crunchWide, 120, 'BookCrunchModal 120x36');

    // Verify BookCrunchModal also renders cleanly at 80x24
    tty.resize(80, 24);
    const crunchNarrow = await tty.waitFor(
      (s) =>
        (s.includes('期末一周冲刺') || s.includes('Final Week Crunch')) &&
        s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'BookCrunchModal resized to 80x24' },
    );
    tty.assertHealthyScreen(crunchNarrow, 80, 'BookCrunchModal 80x24');

    // Restore 120x36 and close cleanly with Esc
    tty.resize(120, 36);
    await tty.waitFor(
      (s) => s.includes('期末一周冲刺') || s.includes('Final Week Crunch'),
      { timeoutMs: 8_000, label: 'BookCrunchModal restored to 120x36' },
    );

    tty.send('\x1b');
    const bookAfterClose = await tty.waitFor(
      (s) => !s.includes('期末一周冲刺') && !s.includes('Final Week Crunch'),
      { timeoutMs: 8_000, label: 'BookCrunchModal closed via Esc' },
    );
    tty.assertHealthyScreen(bookAfterClose, 120, 'BookView after BookCrunchModal closed');
  });
});
