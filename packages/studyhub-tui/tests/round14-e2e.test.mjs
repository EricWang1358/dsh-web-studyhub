// Round 14 Features E2E verification: node --test tests/round14-e2e.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
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
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('chunk-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!H && typeof mod.createTuiHost === 'function' && typeof mod.saveTuiPreferences === 'function') H = mod;
    if (!R && typeof mod.displayWidth === 'function') R = mod;
  }
}
assert.ok(H?.createTuiHost, 'dist/ must export createTuiHost');
assert.ok(R?.displayWidth, 'dist/ must export displayWidth');

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round14-${label}-`));
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
 * Deterministic model stub handling JSON contracts for generation.answerCard.build
 * (write / review / repair stages) and fallback generation/probe replies.
 */
function createRound14StubComplete() {
  return async (system, prompt, execution = {}) => {
    const s = String(system || '');
    const p = String(prompt || '');

    if (p.includes('OK?')) return 'OK';

    if (s.includes('structured model answer card')) {
      if (p.includes('REPAIR:')) {
        return JSON.stringify({
          patch: {
            conclusion:
              '采用 Memento 模式封装每篇笔记的状态快照，由笔记编辑器创建与恢复，撤销历史按笔记隔离保管。',
          },
        });
      }
      if (p.includes('STAGE: review')) {
        return JSON.stringify({
          issues: [],
          summary: '引文、显式假设与评分点均已核对完整。',
        });
      }
      if (p.includes('STAGE: write')) {
        return JSON.stringify({
          questionType: 'general',
          signals: [
            { word: '重新设计', quote: '你会怎样重新设计墨笺的撤销功能？' },
          ],
          facts: [
            {
              text: '多模块共享并直接修改全局历史列表',
              quote: '工具栏、同步服务和搜索索引都直接读取并修改这个列表。',
            },
            {
              text: '连按两次撤销可能恢复成另一天的版本',
              quote: '连按两次撤销有时会把笔记恢复成另一天的版本',
            },
          ],
          concepts: [],
          assumptions: [
            '假设每篇笔记保存的快照数量有上限为 50 份，避免内存无限增长。',
          ],
          steps: [
            '使用 Memento 模式拆分角色：笔记编辑器是 Originator，负责创建与恢复状态快照。',
            '每篇笔记的撤销历史是 Caretaker，从不读取快照内容，仅按顺序保管快照。',
            '原方案中工具栏、同步和搜索都能修改共享历史，破坏了封装。',
            '改由按笔记有序保存不透明快照，解决连续撤销恢复成另一天版本的问题。',
          ],
          conclusion:
            '采用 Memento 模式封装每篇笔记的状态快照，由笔记编辑器创建与恢复，撤销历史按笔记隔离保管。',
          justification: {
            goal: '隔离工具栏、同步与搜索对撤销历史的直接修改，确保撤销只恢复当前笔记的上一状态。',
            cost: '每篇笔记需额外占用一定内存保存快照序列，上限假设为 50 份。',
            failure: '若快照列表为空则禁用撤销按钮，若快照损坏则丢弃该条并保留最近有效状态。',
            verify: '编写单元测试验证连按两次撤销仅回退当前笔记历史，且外部模块无法修改快照内容。',
          },
          pitfalls: ['只扩大全局历史列表而未隔离外部模块读写权限'],
          marks: [
            {
              point: 'c1.k1',
              sentence:
                '使用 Memento 模式拆分角色：笔记编辑器是 Originator，负责创建与恢复状态快照。',
            },
            {
              point: 'c1.k2',
              sentence:
                '每篇笔记的撤销历史是 Caretaker，从不读取快照内容，仅按顺序保管快照。',
            },
            {
              point: 'c2.k1',
              sentence: '原方案中工具栏、同步和搜索都能修改共享历史，破坏了封装。',
            },
            {
              point: 'c2.k2',
              sentence:
                '改由按笔记有序保存不透明快照，解决连续撤销恢复成另一天版本的问题。',
            },
            {
              point: 'c3.k1',
              sentence:
                '假设每篇笔记保存的快照数量有上限为 50 份，避免内存无限增长。',
            },
          ],
        });
      }
    }

    const fallback = JSON.stringify({ cards: [], status: 'ok' });
    execution.onOutput?.(fallback);
    return fallback;
  };
}

describe('StudyHub TUI Round 14 Features E2E', () => {
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
      injectedComplete: createRound14StubComplete(),
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

  test('1) AnswerCardModal ([A] in ReviewView: empty state -> [g] build -> [b] pin -> [d] drills -> Esc)', async () => {
    await tty.waitFor(
      (s) => s.includes('载入示例课程体验') || s.includes('Load the sample course'),
      { label: 'Launchpad render' },
    );

    // Load sample course via 's'
    tty.send('s');
    await tty.waitFor(
      (s) =>
        !s.includes('载入示例课程体验') &&
        s.includes('示例 · Memento 与 Bridge') &&
        s.includes('示例案例 · 墨笺笔记'),
      { timeoutMs: 12_000, label: 'Library after sample load' },
    );
    await sleep(120);
    await tty.flush();

    // Move selection to the case deck (示例案例 · 墨笺笔记) and start Review
    tty.send('j');
    await tty.waitFor(
      (s) => s.includes('▤ 示例案例 · 墨笺笔记') && s.includes('总题数: 2'),
      { timeoutMs: 8_000, label: 'Case deck selected in LibraryView' },
    );
    await tty.flush();
    tty.send('\r');

    const reviewInit = await tty.waitFor(
      (s) =>
        (s.includes('[A]答题卡') || s.includes('[A]AnswerCard')) &&
        !s.includes('正在准备复习队列'),
      { timeoutMs: 10_000, label: 'Review active case card rendered' },
    );
    tty.assertHealthyScreen(reviewInit, 120, 'ReviewView case card');

    // Open AnswerCardModal via 'A' and verify empty state at 120x36
    tty.send('A');
    const emptyWide = await tty.waitFor(
      (s) =>
        (s.includes('分析题答题卡') || s.includes('Case Answer Card')) &&
        (s.includes('这道题还没有结构化答题卡') || s.includes('No Answer Card Built Yet')) &&
        !s.includes('正在读取答题卡'),
      { timeoutMs: 8_000, label: 'AnswerCardModal empty state at 120x36' },
    );
    tty.assertHealthyScreen(emptyWide, 120, 'AnswerCardModal empty 120x36');

    // Verify empty state at 80x24
    tty.resize(80, 24);
    const emptyNarrow = await tty.waitFor(
      (s) =>
        (s.includes('分析题答题卡') || s.includes('Case Answer Card')) &&
        s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'AnswerCardModal empty state at 80x24' },
    );
    tty.assertHealthyScreen(emptyNarrow, 80, 'AnswerCardModal empty 80x24');

    // Restore 120x36
    tty.resize(120, 36);
    await tty.waitFor(
      (s) => s.includes('分析题答题卡') || s.includes('Case Answer Card'),
      { timeoutMs: 8_000, label: 'AnswerCardModal restored to 120x36' },
    );

    // Trigger [g] to build the answer card via generation.answerCard.build
    tty.send('g');
    const builtWide = await tty.waitFor(
      (s) =>
        (s.includes('核心结论') || s.includes('Thesis & Conclusion')) &&
        (s.includes('标准作答结构') || s.includes('Model Answer Structure')) &&
        !s.includes('这道题还没有结构化答题卡') &&
        !s.includes('正在写入'),
      { timeoutMs: 12_000, label: 'AnswerCardModal populated after [g] build' },
    );
    tty.assertHealthyScreen(builtWide, 120, 'AnswerCardModal built 120x36');

    // Verify populated AnswerCardModal also renders cleanly at 80x24
    tty.resize(80, 24);
    const builtNarrow = await tty.waitFor(
      (s) =>
        (s.includes('分析题答题卡') || s.includes('Case Answer Card')) &&
        s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'AnswerCardModal built at 80x24' },
    );
    tty.assertHealthyScreen(builtNarrow, 80, 'AnswerCardModal built 80x24');

    tty.resize(120, 36);
    await tty.waitFor(
      (s) => s.includes('核心结论') || s.includes('Thesis & Conclusion'),
      { timeoutMs: 8_000, label: 'AnswerCardModal built restored to 120x36' },
    );

    // Trigger [b] (book.qa.add / remove pin toggle or graceful no-book notice) without crashing
    tty.send('b');
    const afterPin = await tty.waitFor(
      (s) =>
        s.includes('已将答题卡加入复习全书') ||
        s.includes('已从复习全书撤回答题卡') ||
        s.includes('还没有复习全书') ||
        s.includes('Pinned answer card') ||
        s.includes('no review book'),
      { timeoutMs: 8_000, label: 'AnswerCardModal [b] pin action handled cleanly' },
    );
    tty.assertHealthyScreen(afterPin, 120, 'AnswerCardModal after [b]');

    // Trigger [d] (case.drills) on the case deck without crashing
    tty.send('d');
    const afterDrills = await tty.waitFor(
      (s) =>
        s.includes('薄弱项练习') ||
        s.includes('Queued') ||
        s.includes('Drills ready') ||
        s.includes('正在生成薄弱评分项练习'),
      { timeoutMs: 8_000, label: 'AnswerCardModal [d] case.drills handled cleanly' },
    );
    tty.assertHealthyScreen(afterDrills, 120, 'AnswerCardModal after [d]');

    // Esc closes AnswerCardModal cleanly back to ReviewView
    tty.send('\x1b');
    const backToReview = await tty.waitFor(
      (s) =>
        !s.includes('分析题答题卡') &&
        !s.includes('Case Answer Card') &&
        (s.includes('[A]答题卡') || s.includes('[A]AnswerCard')),
      { timeoutMs: 8_000, label: 'AnswerCardModal closed via Esc back to ReviewView' },
    );
    tty.assertHealthyScreen(backToReview, 120, 'ReviewView after AnswerCardModal closed');

    // Esc from ReviewView returns cleanly to LibraryView
    tty.send('\x1b');
    const backToLib = await tty.waitFor(
      (s) => (s.includes('题组列表') || s.includes('Decks')) && !s.includes('[A]答题卡'),
      { timeoutMs: 8_000, label: 'Returned to LibraryView from ReviewView' },
    );
    tty.assertHealthyScreen(backToLib, 120, 'LibraryView after ReviewView');
  });

  test('2) VoicePackModal ([v] in LibraryView: prompt/checklist at 120x36 & 80x24, mode/export, Esc)', async () => {
    tty.send('v');
    const voiceWide = await tty.waitFor(
      (s) =>
        (s.includes('语音带学包导出') || s.includes('Voice Study Pack')) &&
        (s.includes('防发散私教提示词') || s.includes('防跑偏硬协议') || s.includes('Anti-Drift') || s.includes('今日清单')) &&
        !s.includes('正在生成语音带学包'),
      { timeoutMs: 8_000, label: 'VoicePackModal rendered at 120x36' },
    );
    tty.assertHealthyScreen(voiceWide, 120, 'VoicePackModal 120x36');

    // Switch to 'all' mode ('3'), adjust limit ('+') and minutes (']')
    tty.send('3');
    await tty.waitFor(
      (s) => s.includes('3:全部 all') && s.includes('抽题模式： all') && !s.includes('正在生成语音带学包'),
      { timeoutMs: 8_000, label: 'VoicePackModal switched to all mode' },
    );
    tty.send('+');
    await tty.waitFor(
      (s) => s.includes('题数上限: 30') && !s.includes('正在生成语音带学包'),
      { timeoutMs: 8_000, label: 'VoicePackModal limit adjusted to 30' },
    );
    tty.send(']');
    const adjustedWide = await tty.waitFor(
      (s) => s.includes('题数上限: 30') && s.includes('时长预算: 45分钟') && !s.includes('正在生成语音带学包'),
      { timeoutMs: 8_000, label: 'VoicePackModal minutes adjusted to 45' },
    );
    tty.assertHealthyScreen(adjustedWide, 120, 'VoicePackModal adjusted 120x36');

    // Verify 80x24 layout
    tty.resize(80, 24);
    const voiceNarrow = await tty.waitFor(
      (s) =>
        (s.includes('语音带学包导出') || s.includes('Voice Study Pack')) &&
        s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'VoicePackModal rendered at 80x24' },
    );
    tty.assertHealthyScreen(voiceNarrow, 80, 'VoicePackModal 80x24');

    tty.resize(120, 36);
    await tty.waitFor(
      (s) => s.includes('语音带学包导出') || s.includes('Voice Study Pack'),
      { timeoutMs: 8_000, label: 'VoicePackModal restored to 120x36' },
    );

    // Trigger [e] export prompt and save markdown into temp libraryRoot
    tty.send('e');
    const exportPrompt = await tty.waitFor(
      (s) => s.includes('导出 Markdown 文件路径') || s.includes('Export Markdown file path'),
      { timeoutMs: 8_000, label: 'VoicePackModal export prompt opened' },
    );
    tty.assertHealthyScreen(exportPrompt, 120, 'VoicePackModal export prompt');

    tty.send('\r');
    const exportedScreen = await tty.waitFor(
      (s) =>
        (s.includes('已导出到') || s.includes('Exported to')) &&
        !s.includes('导出 Markdown 文件路径'),
      { timeoutMs: 8_000, label: 'VoicePackModal markdown exported' },
    );
    tty.assertHealthyScreen(exportedScreen, 120, 'VoicePackModal after export');

    // Esc closes VoicePackModal cleanly back to LibraryView
    tty.send('\x1b');
    const libAfterVoice = await tty.waitFor(
      (s) =>
        !s.includes('语音带学包导出') &&
        !s.includes('Voice Study Pack') &&
        (s.includes('题组列表') || s.includes('Decks')),
      { timeoutMs: 8_000, label: 'VoicePackModal closed via Esc' },
    );
    tty.assertHealthyScreen(libAfterVoice, 120, 'LibraryView after VoicePackModal closed');
  });

  test('3) Settings Workspace Restore Points (Settings [,] -> Tab [2] -> inspect/refresh/export -> return)', async () => {
    tty.send(',');
    const settingsInit = await tty.waitFor(
      (s) => s.includes('模型配置') || s.includes('Models'),
      { timeoutMs: 8_000, label: 'SettingsView opened' },
    );
    tty.assertHealthyScreen(settingsInit, 120, 'SettingsView initial');

    // Switch to Workspace tab ('2')
    tty.send('2');
    const rootTail = basename(libraryRoot);
    const workspaceWide = await tty.waitFor(
      (s) =>
        (s.includes('学习库路径与工作区') || s.includes('Library Root & Workspace')) &&
        (s.includes('学习库自动备份点') || s.includes('Library Restore Points')) &&
        s.includes(rootTail),
      { timeoutMs: 8_000, label: 'Settings WorkspaceTab rendered at 120x36' },
    );
    tty.assertHealthyScreen(workspaceWide, 120, 'Settings WorkspaceTab 120x36');

    // Verify 80x24 layout
    tty.resize(80, 24);
    const workspaceNarrow = await tty.waitFor(
      (s) =>
        (s.includes('学习库路径与工作区') || s.includes('Library Root & Workspace')) &&
        s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'Settings WorkspaceTab rendered at 80x24' },
    );
    tty.assertHealthyScreen(workspaceNarrow, 80, 'Settings WorkspaceTab 80x24');

    tty.resize(120, 36);
    await tty.waitFor(
      (s) => s.includes('学习库自动备份点') || s.includes('Library Restore Points'),
      { timeoutMs: 8_000, label: 'Settings WorkspaceTab restored to 120x36' },
    );

    // Refresh restore points safely via 'r'
    tty.send('r');
    await tty.flush();
    const afterRefresh = await tty.waitFor(
      (s) =>
        (s.includes('暂无备份点') || s.includes('No restore points yet') || s.includes('cards')) &&
        !s.includes('正在读取备份列表'),
      { timeoutMs: 8_000, label: 'WorkspaceTab restore points refreshed cleanly' },
    );
    tty.assertHealthyScreen(afterRefresh, 120, 'Settings WorkspaceTab after [r]');

    // Open backup export modal via 'x' and export backup safely without crashing
    tty.send('x');
    const exportModal = await tty.waitFor(
      (s) => s.includes('导出学习库备份') || s.includes('Export Library Backup'),
      { timeoutMs: 8_000, label: 'WorkspaceTab export backup modal opened' },
    );
    tty.assertHealthyScreen(exportModal, 120, 'WorkspaceTab export backup modal');

    tty.send('\r');
    const afterBackup = await tty.waitFor(
      (s) =>
        (s.includes('已导出备份') || s.includes('Exported backup')) &&
        !s.includes('输入备份文件路径'),
      { timeoutMs: 8_000, label: 'WorkspaceTab backup exported cleanly' },
    );
    tty.assertHealthyScreen(afterBackup, 120, 'WorkspaceTab after backup export');

    // Return cleanly from SettingsView to LibraryView via Backspace
    tty.send('\x7f');
    const returnedLib = await tty.waitFor(
      (s) =>
        !s.includes('学习库路径与工作区') &&
        !s.includes('Library Root & Workspace') &&
        (s.includes('题组列表') || s.includes('Decks')),
      { timeoutMs: 8_000, label: 'Returned cleanly to LibraryView from SettingsView' },
    );
    tty.assertHealthyScreen(returnedLib, 120, 'LibraryView after SettingsView');
  });
});
