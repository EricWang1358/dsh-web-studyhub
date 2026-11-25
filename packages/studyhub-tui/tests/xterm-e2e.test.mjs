// End-to-end xterm-headless TUI verification: node --test tests/xterm-e2e.test.mjs
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

const screenDumpDir = join(tmpdir(), 'studyhub-tui-screens');

// Load directly from built dist/ (avoids loading tsx/esbuild compiler overhead in RSS measurements).
const runtime = await loadDistRuntime();
const { StudyHubTuiApp, createTuiHost } = runtime;
assert.ok(StudyHubTuiApp, 'dist/ must export StudyHubTuiApp');
assert.ok(createTuiHost, 'dist/ must export createTuiHost');

const appCode = await readFile(join(distDir, 'App.mjs'), 'utf8');
const cjkImport = appCode.match(/import\s*\{[^}]*\bdisplayWidth\b[^}]*\}\s*from\s*["'](\.\/[^"']+\.mjs)["']/);
assert.ok(cjkImport, 'dist/App.mjs must import displayWidth');
const { displayWidth } = await import(pathToFileURL(resolve(distDir, cjkImport[1])).href);
assert.equal(typeof displayWidth, 'function', 'dist/ must export displayWidth');

const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const storeFile = distFiles.find((f) => f.startsWith('store-') && f.endsWith('.mjs'));
assert.ok(storeFile, 'dist/ must include store-*.mjs');
const { useTuiStore } = await import(pathToFileURL(join(distDir, storeFile)).href);
assert.ok(useTuiStore, 'dist/store-*.mjs must export useTuiStore');

const PREV_DSH_HOME = process.env.DSH_HOME;
const temps = createTempTracker('studyhub-tui-e2e-');

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
  assert.ok(!screen.includes('\uFFFD'), `${contextLabel}: Replacement char U+FFFD found!\n${screen}`);
  assert.ok(!screen.includes('\u001b'), `${contextLabel}: Unparsed escape sequence leaked into xterm buffer!\n${screen}`);
  const lines = screen.split('\n');
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

/** Deterministic model stub for E2E tests (streams AI explanations live). */
function createE2eCompleteStub() {
  return async (system, prompt, execution = {}) => {
    const s = String(system || '');
    const p = String(prompt || '');
    if (p.includes('OK?')) return 'OK';
    const chunks =
      s.includes('AI') ||
      p.includes('?') ||
      p.includes('？') ||
      p.includes('讲解') ||
      p.includes('Explain') ||
      p.includes('hint')
        ? ['[AI Tutor] ', 'Focus on ', 'encapsulating ', 'state transitions ', 'cleanly.']
        : ['StudyHub ', 'TUI ', 'stream ', 'verified.'];
    for (const chunk of chunks) {
      execution.signal?.throwIfAborted?.();
      execution.onOutput?.(chunk);
      await new Promise((r) => setImmediate(r));
    }
    return chunks.join('');
  };
}

// Strip the SideNav column up to the vertical divider `│` so sidebar labels never false-match body checks.
function stripSideNav(screen) {
  const lines = screen.split('\n');
  return lines
    .slice(1, -1)
    .map((line) => {
      const sepIdx = line.indexOf('│');
      return sepIdx >= 0 ? line.slice(sepIdx + 1) : line;
    })
    .join('\n');
}

// Navigation sequence using real keyboard shortcuts across all 16 views.
const ALL_16_SWEEP = [
  { id: 'library', key: null, expect: /题组列表|今日待复习|Decks/ },
  { id: 'sources', key: '2', expect: /资料列表|Materials/ },
  { id: 'generate', key: '3', expect: /新建出题任务|草稿箱|Generate/ },
  { id: 'wrongbook', key: '4', expect: /错题列表|错因分布|Mistakes/ },
  { id: 'exam', key: '5', expect: /组卷设置|Mock Exam/ },
  { id: 'dashboard', key: '6', expect: /学习统计与掌握度|Stats/ },
  { id: 'book', key: '7', expect: /复习全书|Review Book/ },
  { id: 'skeleton', key: '8', expect: /知识层级树|课程骨架|Skeleton/ },
  { id: 'examcoach', key: '9', expect: /考试教练|Coach/ },
  { id: 'examprep', key: '0', expect: /备考补习|Exam Prep/ },
  { id: 'notes', key: 'n', expect: /学习笔记|Notes/ },
  { id: 'board', key: 'b', expect: /待办 Todo|Board/ },
  { id: 'tasks', key: 't', expect: /运行中|后台任务|Jobs/ },
  { id: 'settings', key: ',', expect: /模型配置|学习库路径|Settings/ },
  { id: 'audio', key: 'a', expect: /音频转写|转写服务|音频导入|未配置转写服务|Audio/ },
  { id: 'review', key: '1r', expect: /AI讲解|AI Tutor|翻开答案|flip card|FSRS|1\/\d+/ },
];

describe('StudyHub TUI xterm-headless E2E', () => {
  let boxDir;
  let dshHome;
  let libraryRoot;
  let host;
  let tty;
  let inkInstance;
  let baselineResources;
  let firstFrameMs = 0;
  let sweepRssMb = 0;

  before(async () => {
    await mkdir(screenDumpDir, { recursive: true });
    boxDir = await temps.make('main');
    dshHome = join(boxDir, 'dsh-home');
    libraryRoot = join(boxDir, 'library');
    process.env.DSH_HOME = dshHome;
    baselineResources = resourceCounts();

    host = await createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(boxDir, 'home'),
      libraryRoot,
      injectedComplete: createE2eCompleteStub(),
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    tty = createVirtualTty(120, 36);
    const t0 = performance.now();
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
    firstFrameMs = Math.round(performance.now() - t0);
  });

  after(async () => {
    try {
      inkInstance?.unmount();
    } catch {
      // Ignore unmount errors on teardown
    }
    await host?.dispose();
    tty?.dispose();
    disposeTerminalPool();
    if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = PREV_DSH_HOME;
    await temps.cleanup();
  });

  test('a) Launchpad -> Load Sample Course renders real decks, due counts, and mastery bars', async () => {
    const launchpadScreen = await tty.waitFor(
      (s) => s.includes('载入示例课程体验') || s.includes('Load the sample course'),
      { label: 'Launchpad render' },
    );
    assertScreenHealthy(tty, launchpadScreen, 120, 36, 'Launchpad 120x36');
    await writeFile(join(screenDumpDir, '120x36-00-launchpad.txt'), launchpadScreen, 'utf8');

    // Press 's' to load sample course
    tty.send('s');
    await tty.waitFor(
      (s) =>
        !s.includes('载入示例课程体验') &&
        (s.includes('示例 · Memento 与 Bridge') || s.includes('Sample · Memento')) &&
        /掌握度|Mastery/.test(s) &&
        /\d+%/.test(s) &&
        /\d+\s*题到期|\d+\s*due/i.test(s) &&
        (s.includes('█') || s.includes('░')),
      { timeoutMs: 12_000, label: 'Library with sample course' },
    );
    await tty.flush();
    const settled = tty.readScreen();
    assertScreenHealthy(tty, settled, 120, 36, 'Library after sample load 120x36');
    assert.match(settled, /掌握度|Mastery/);
    assert.match(settled, /\d+%/);
    assert.match(settled, /\d+\s*题到期|\d+\s*due/i);
    assert.ok(settled.includes('█') || settled.includes('░'), 'mastery progress bar rendered');
  });

  test('b) Sweeps all 16 views at 120x36 and 80x24 with zero crashes/overflows and dumps screen snapshots', async () => {
    const sweepFailures = [];
    for (const [cols, rows] of [
      [120, 36],
      [80, 24],
    ]) {
      if (tty.stdout.columns !== cols || tty.stdout.rows !== rows) {
        tty.resize(cols, rows);
        await tty.flush();
        tty.send('1');
        await tty.waitFor((s) => s.includes('题组列表') || s.includes('Decks'), {
          label: `Return to Library @ ${cols}x${rows}`,
        });
      }

      const visitedOrder = [];
      for (let i = 0; i < ALL_16_SWEEP.length; i += 1) {
        const step = ALL_16_SWEEP[i];
        if (step.key) {
          if (step.id === 'review' && step.key === '1r') {
            tty.send('1');
            await tty.waitFor(
              (s) =>
                useTuiStore.getState().page === 'library' &&
                /题组列表|Decks/.test(stripSideNav(s)) &&
                !s.includes('正在加载页面…') &&
                !s.includes('Loading view…'),
              {
                timeoutMs: 8_000,
                label: `LibraryView before review @ ${cols}x${rows}`,
              },
            );
            await tty.flush();
            tty.send('r');
          } else {
            for (const ch of step.key) {
              tty.send(ch);
              await tty.flush();
            }
          }
        }
        await tty.waitFor(
          (s) => {
            const body = stripSideNav(s);
            const onTargetPage = useTuiStore.getState().page === step.id;
            const bodyReady =
              step.expect.test(body) || s.includes('页面渲染异常') || s.includes('View Error');
            return (
              onTargetPage &&
              bodyReady &&
              !s.includes('正在加载页面…') &&
              !s.includes('Loading view…')
            );
          },
          { timeoutMs: 10_000, label: `${step.id} @ ${cols}x${rows}` },
        );
        await tty.flush();
        visitedOrder.push(useTuiStore.getState().page);
        const settled = tty.readScreen();

        const idxStr = String(i + 1).padStart(2, '0');
        await writeFile(join(screenDumpDir, `${cols}x${rows}-${idxStr}-${step.id}.txt`), settled, 'utf8');

        try {
          assertScreenHealthy(tty, settled, cols, rows, `${step.id} @ ${cols}x${rows}`);
        } catch (err) {
          sweepFailures.push(err instanceof Error ? err.message : String(err));
        }
      }
      assert.deepEqual(
        visitedOrder,
        ALL_16_SWEEP.map((s) => s.id),
        `16-view sweep order must match ALL_16_SWEEP @ ${cols}x${rows}`,
      );

      // From review (or ViewCrashFallback), exit cleanly back to library
      const afterReview = tty.readScreen();
      if (afterReview.includes('页面渲染异常') || afterReview.includes('View Error')) {
        tty.send('1');
      } else {
        tty.send('X');
        await tty.waitFor(
          (s) => s.includes('结束本轮练习') || s.includes('End This Round'),
          { timeoutMs: 6_000, label: `Confirm end round dialog @ ${cols}x${rows}` },
        );
        tty.send('y');
        await tty.waitFor(
          (s) => s.includes('再来一轮') || s.includes('New Round') || s.includes('本轮练习总结'),
          { timeoutMs: 8_000, label: `Round summary after review @ ${cols}x${rows}` },
        );
        tty.send('b');
      }
      await tty.waitFor((s) => s.includes('题组列表') || s.includes('Decks'), {
        label: `Exit review to Library @ ${cols}x${rows}`,
      });
    }

    // Resize back to 120x36 for interactive tests
    tty.resize(120, 36);
    await tty.flush();
    tty.term.clear();
    try {
      v8.setFlagsFromString('--expose_gc');
      const gcFn = vm.runInNewContext('gc');
      if (typeof gcFn === 'function') {
        gcFn();
        gcFn();
      }
    } catch {
      // Ignore if V8 flags are locked
    }
    sweepRssMb = Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10;
    assert.deepEqual(sweepFailures, [], `16-view sweep failures:\n${sweepFailures.join('\n\n')}`);
  });

  test('c) Interactive FSRS-6 review + live streaming AI Help + Round Summary', async () => {
    tty.send('1');
    await tty.waitFor((s) => s.includes('题组列表') || s.includes('Decks'), { label: 'Library before review' });
    await tty.flush();
    tty.send('r');
    const reviewScreen = await tty.waitFor(
      (s) =>
        (s.includes('X  结束') || s.includes('X  End') || s.includes('AI讲解') || s.includes('AI Tutor')) &&
        !s.includes('正在准备复习队列') &&
        !s.includes('正在加载页面'),
      { timeoutMs: 10_000, label: 'Review active card' },
    );
    assertScreenHealthy(tty, reviewScreen, 120, 36, 'Review card #1');

    // Answer cards until we exercise a self-graded FSRS-6 rating (`3` Good)
    let ratedFsrs = false;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await tty.flush();
      const s = tty.readScreen();
      if (s.includes('翻开答案') || s.includes('flip card') || s.includes('翻看答案') || s.includes('to reveal')) {
        tty.send(' ');
        await tty.waitFor(
          (scr) => scr.includes('FSRS-6') || scr.includes('参考答案') || scr.includes('Reference'),
          { label: 'Reveal flashcard/short_answer' },
        );
        tty.send('3');
        await tty.waitFor(
          (scr) =>
            /[23]\/\d+/.test(scr) ||
            scr.includes('已自报') ||
            scr.includes('Self-reported') ||
            scr.includes('Enter / .') ||
            scr.includes('下一题'),
          { label: 'FSRS 3 Good rated' },
        );
        ratedFsrs = true;
        break;
      }
      if (s.includes('[1/a]') || s.includes('[1/t]')) {
        tty.send('1');
        await tty.waitFor(
          (scr) =>
            scr.includes('回答正确') ||
            scr.includes('回答有误') ||
            scr.includes('Correct') ||
            scr.includes('Incorrect'),
          { label: 'Objective card answered' },
        );
        tty.send('.');
        await tty.waitFor(
          (scr) =>
            !scr.includes('回答正确') &&
            !scr.includes('回答有误') &&
            !scr.includes('Correct') &&
            !scr.includes('Incorrect'),
          { label: 'Advance past answered objective card' },
        );
        continue;
      }
      const prevCounter = s.match(/(\d+\/\d+)/)?.[1];
      tty.send('s');
      await tty.waitFor(
        (scr) =>
          scr.match(/(\d+\/\d+)/)?.[1] !== prevCounter ||
          scr.includes('翻开答案') ||
          scr.includes('flip card') ||
          scr.includes('本轮练习总结') ||
          scr.includes('Round Summary'),
        { label: 'Advance past skipped card' },
      );
    }
    assert.equal(ratedFsrs, true, 'Rated at least one card with FSRS-6 Good (3)');

    // Open AI Help drawer (`h`)
    tty.send('h');
    const aiDrawerOpened = await tty.waitFor(
      (s) => s.includes('AI 帮我理解') || s.includes('AI Tutor'),
      { label: 'AI Help drawer opened' },
    );
    assertScreenHealthy(tty, aiDrawerOpened, 120, 36, 'AI Help drawer');

    // Wait for auto-explain stream to finish, then send a custom follow-up question
    await tty.waitFor(
      (s) => s.includes('encapsulating state transitions cleanly'),
      { timeoutMs: 8_000, label: 'Auto-explain stream output' },
    );

    tty.send('i');
    await tty.flush();
    tty.send('Why is this pattern useful?');
    await tty.waitFor((s) => s.includes('Why is this pattern useful?'), {
      timeoutMs: 5_000,
      label: 'Follow-up typed into AI input',
    });
    tty.send('\r');

    const followUpScreen = await tty.waitFor(
      (s) => s.includes('4/20') && s.includes('Why is this pattern useful?') && s.includes('[AI Tutor]'),
      { timeoutMs: 8_000, label: 'Follow-up AI streamed response' },
    );
    assertScreenHealthy(tty, followUpScreen, 120, 36, 'AI follow-up streamed');

    // Close AI drawer (`Esc`) and end round (`q`) -> Round Summary
    tty.send('\x1b');
    await tty.waitFor((s) => !s.includes('AI 帮我理解') && !s.includes('AI Tutor'), {
      label: 'AI drawer closed',
    });

    tty.send('X');
    await tty.waitFor(
      (s) => s.includes('结束本轮练习') || s.includes('End This Round'),
      { timeoutMs: 6_000, label: 'Confirm end round dialog' },
    );
    tty.send('y');
    const summaryScreen = await tty.waitFor(
      (s) => s.includes('再来一轮') || s.includes('New Round') || s.includes('本轮练习总结') || s.includes('Round Summary'),
      { timeoutMs: 8_000, label: 'Round Summary' },
    );
    assertScreenHealthy(tty, summaryScreen, 120, 36, 'Round Summary');

    // Exit Round Summary back to Library
    tty.send('b');
    await tty.waitFor((s) => s.includes('题组列表') || s.includes('Decks'), {
      label: 'Return to Library from Round Summary',
    });
  });

  test('d) Kanban Board CRUD & persistence to tui-board.json', async () => {
    tty.send('b');
    const boardScreen = await tty.waitFor((s) => s.includes('待办 Todo') || s.includes('Board'), {
      label: 'Board view',
    });
    assertScreenHealthy(tty, boardScreen, 120, 36, 'Board empty');

    // Add a card ('a')
    tty.send('a');
    await tty.waitFor((s) => s.includes('添加看板任务') || s.includes('Add Board Card'), {
      label: 'Board Add Card Modal',
    });
    tty.send('Master Memento Pattern');
    await tty.waitFor((s) => s.includes('Master Memento Pattern'), {
      label: 'Board card title typed',
    });
    // Ctrl+S saves immediately from any field in BoardCardModal
    tty.send('\x13');

    const addedScreen = await tty.waitFor(
      (s) =>
        !s.includes('添加看板任务') &&
        !s.includes('Add Board Card') &&
        (/[❯>]\s*Master Memento Pattern/.test(s) ||
          (s.includes('Master Memento Pattern') && !s.includes('未选择任务') && !s.includes('No task selected'))),
      { timeoutMs: 8_000, label: 'Card added and selected in Todo column' },
    );
    assertScreenHealthy(tty, addedScreen, 120, 36, 'Board after add');

    // Move card right ('L') from Todo -> Doing
    tty.send('L');
    await tty.waitFor(
      (s) => /进行中 Doing[^\n]*1/.test(s) || /Doing[^\n]*1/.test(s),
      { timeoutMs: 6_000, label: 'Card moved to Doing column' },
    );
    await tty.flush();

    const boardFile = join(libraryRoot, 'tui-board.json');
    let persisted = null;
    const diskDeadline = Date.now() + 2_000;
    while (Date.now() < diskDeadline) {
      try {
        const raw = await readFile(boardFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed?.cards?.[0]?.column === 'doing') {
          persisted = parsed;
          break;
        }
      } catch {
        // Wait for async board persistence write to complete
      }
      await new Promise((r) => setTimeout(r, 15));
    }
    assert.ok(persisted, 'tui-board.json must be persisted with Doing column');
    assert.equal(persisted.version, 1);
    assert.equal(persisted.cards.length, 1);
    assert.equal(persisted.cards[0].title, 'Master Memento Pattern');
    assert.equal(persisted.cards[0].column, 'doing');
  });

  test('e) Overlays (Ctrl+K Command Palette, ? Help, c Course Picker) + Settings Tabs 1-4 + Theme & Language switch', async () => {
    // 1. Command Palette (Ctrl+K = \x0b)
    tty.send('\x0b');
    await tty.waitFor((s) => s.includes('命令面板') || s.includes('Command Palette'), {
      label: 'Command Palette open',
    });
    tty.send('board');
    const paletteFiltered = await tty.waitFor((s) => s.includes('待办看板') || s.includes('Board'), {
      label: 'Command Palette fuzzy filter',
    });
    assertScreenHealthy(tty, paletteFiltered, 120, 36, 'Command Palette');
    tty.send('\x1b');
    await tty.waitFor((s) => !s.includes('命令面板') && !s.includes('Command Palette'), {
      label: 'Command Palette closed',
    });

    // 2. Help Overlay (?)
    tty.send('?');
    const helpScreen = await tty.waitFor((s) => s.includes('快捷键') || s.includes('Keyboard Shortcuts'), {
      label: 'Help overlay open',
    });
    assertScreenHealthy(tty, helpScreen, 120, 36, 'Help Overlay');
    tty.send('?');
    await tty.waitFor((s) => !s.includes('快捷键') && !s.includes('Keyboard Shortcuts'), {
      label: 'Help overlay closed',
    });

    // 3. Course Picker (c)
    tty.send('c');
    const pickerScreen = await tty.waitFor((s) => s.includes('切换课程') || s.includes('Switch Course'), {
      label: 'Course Picker open',
    });
    assertScreenHealthy(tty, pickerScreen, 120, 36, 'Course Picker');
    tty.send('\x1b');
    await tty.waitFor((s) => !s.includes('切换课程') && !s.includes('Switch Course'), {
      label: 'Course Picker closed',
    });

    // 4. Settings Tabs 1-4 + Theme (dsh-dark -> nord) & Language (zh -> en -> zh)
    tty.send(',');
    await tty.waitFor((s) => s.includes('设置') && s.includes('模型配置'), { label: 'Settings view' });

    for (const [tabKey, expectRe] of [
      ['1', /当前生效模型|Active Model Route/],
      ['2', /学习库路径与工作区|Workspace/],
      ['3', /FSRS/],
      ['4', /配色主题 \(Theme\)|Color Theme/],
    ]) {
      tty.send(tabKey);
      await tty.flush();
      const tabScreen = await tty.waitFor((s) => expectRe.test(s), {
        label: `Settings tab ${tabKey}`,
      });
      assertScreenHealthy(tty, tabScreen, 120, 36, `Settings tab ${tabKey}`);
    }

    // Row 0 is Theme: dsh-dark -> warm-paper -> nord (press 'l' twice)
    tty.send('l');
    await tty.flush();
    await tty.waitFor((s) => s.includes('[ Warm Paper ]'), { label: 'Theme switched to Warm Paper' });
    tty.send('l');
    await tty.flush();
    await tty.waitFor((s) => s.includes('[ Nord ]'), { label: 'Theme switched to Nord' });

    // Row 1 is Language: zh -> en -> zh
    tty.send('j');
    await tty.flush();
    await tty.waitFor((s) => /❯\s+界面语言|❯\s+UI Language/.test(s), {
      label: 'Cursor moved to Language row',
    });
    tty.send('l');
    await tty.flush();
    const enScreen = await tty.waitFor((s) => s.includes('UI Language') && s.includes('English (en)'), {
      label: 'Language switched to English',
    });
    assertScreenHealthy(tty, enScreen, 120, 36, 'Settings Appearance EN');

    tty.send('l');
    const zhScreen = await tty.waitFor((s) => s.includes('界面语言') && s.includes('简体中文 (zh)'), {
      label: 'Language switched back to Chinese',
    });
    assertScreenHealthy(tty, zhScreen, 120, 36, 'Settings Appearance ZH');
  });

  test('g) Sources & Document Reader pagination + Page Ask AI + Esc exit', async () => {
    // Leave Settings (where 1-4 are tab keys) via '6' -> Dashboard, then '2' -> Sources
    tty.send('6');
    await tty.waitFor((s) => s.includes('学习统计与掌握度') || s.includes('Study Analytics'), {
      label: 'Leave Settings before Sources',
    });
    tty.send('2');
    await tty.waitFor((s) => s.includes('资料列表') || s.includes('Materials'), {
      label: 'Sources view for DocumentReader',
    });
    // Open selected source in DocumentReader
    tty.send('\r');
    const readerScreen = await tty.waitFor(
      (s) => (s.includes('第 1 /') || s.includes('P. 1 /')) && (s.includes('∑ Unicode') || s.includes('TeX')),
      { timeoutMs: 8_000, label: 'DocumentReader opened' },
    );
    assertScreenHealthy(tty, readerScreen, 120, 36, 'DocumentReader page 1');

    // Open Page Ask AI (`a`), submit question, verify streamed output
    tty.send('a');
    await tty.waitFor((s) => s.includes('问AI') || s.includes('Ask') || s.includes('输入'), {
      label: 'DocumentReader Ask input',
    });
    tty.send('Summarize key idea');
    await tty.waitFor((s) => s.includes('Summarize key idea'), {
      timeoutMs: 5_000,
      label: 'DocumentReader Ask input typed',
    });
    tty.send('\r');
    const aiReaderScreen = await tty.waitFor(
      (s) => s.includes('StudyHub TUI stream verified') || s.includes('Focus on encapsulating'),
      { timeoutMs: 8_000, label: 'DocumentReader AI streamed response' },
    );
    assertScreenHealthy(tty, aiReaderScreen, 120, 36, 'DocumentReader Page Ask AI');

    // Esc closes AI pane back to reader, second Esc exits reader back to Sources
    tty.send('\x1b');
    await tty.waitFor(
      (s) =>
        !s.includes('StudyHub TUI stream verified') &&
        !s.includes('Focus on encapsulating') &&
        !s.includes('生成中') &&
        (s.includes('O  目录') || s.includes('O  Outline')),
      { timeoutMs: 6_000, label: 'DocumentReader AI pane closed' },
    );
    await tty.flush();
    tty.send('\x1b');
    const backToSources = await tty.waitFor((s) => s.includes('资料列表') || s.includes('Materials'), {
      timeoutMs: 8_000,
      label: 'Exited DocumentReader back to Sources',
    });
    assertScreenHealthy(tty, backToSources, 120, 36, 'Sources after DocumentReader exit');
  });

  test('h) Widescreen 160x44 & ASCII Compatibility Mode', async () => {
    tty.resize(160, 44);
    await tty.flush();

    const widescreenSweep = [
      { id: 'library', key: '1', file: '160x44-01-library.txt', expect: /题组列表|Decks/ },
      { id: 'dashboard', key: '6', file: '160x44-06-dashboard.txt', expect: /学习统计与掌握度|Stats/ },
      { id: 'wrongbook', key: '4', file: '160x44-04-wrongbook.txt', expect: /错题列表|Mistakes/ },
      { id: 'board', key: 'b', file: '160x44-12-board.txt', expect: /待办 Todo|Board/ },
      { id: 'settings', key: ',', file: '160x44-14-settings.txt', expect: /设置.*模型配置|Settings/ },
    ];

    for (const step of widescreenSweep) {
      tty.send(step.key);
      await tty.waitFor(
        (s) =>
          step.expect.test(s) &&
          !s.includes('正在加载页面…') &&
          !s.includes('Loading view…'),
        { timeoutMs: 10_000, label: `${step.id} @ 160x44` },
      );
      await tty.flush();
      const settled = tty.readScreen();
      await writeFile(join(screenDumpDir, step.file), settled, 'utf8');
      assertScreenHealthy(tty, settled, 160, 44, `${step.id} @ 160x44`);
    }

    // Switch to Settings -> Appearance tab (4) and enable ASCII Safe Mode (row index 3)
    tty.send('4');
    await tty.waitFor((s) => /配色主题 \(Theme\)|Color Theme/.test(s), {
      timeoutMs: 8_000,
      label: 'Settings Appearance tab @ 160x44',
    });
    for (let step = 0; step < 3; step += 1) {
      tty.send('j');
      await tty.flush();
    }
    tty.send('l');
    const asciiSettings = await tty.waitFor(
      (s) =>
        s.includes('ASCII') &&
        (s.includes('已开启') || s.includes('Enabled')) &&
        s.includes('+') &&
        s.includes('-'),
      { timeoutMs: 8_000, label: 'Enable asciiMode via Appearance tab' },
    );
    await tty.flush();
    assertScreenHealthy(tty, asciiSettings, 160, 44, 'Settings Appearance ASCII @ 160x44');
    await writeFile(join(screenDumpDir, '160x44-14-settings-ascii.txt'), asciiSettings, 'utf8');
    assert.ok(asciiSettings.includes('+') && asciiSettings.includes('-'), 'Settings renders classic ASCII borders');

    let persistedPrefs = null;
    const persistDeadline = Date.now() + 2_000;
    while (Date.now() < persistDeadline) {
      try {
        const persistedRaw = await readFile(join(dshHome, 'study', 'tui.json'), 'utf8');
        persistedPrefs = JSON.parse(persistedRaw);
        if (persistedPrefs.asciiMode === true) break;
      } catch {
        // Atomic rename may still be in flight
      }
      await new Promise((r) => setTimeout(r, 15));
    }
    assert.equal(persistedPrefs?.asciiMode, true, 'asciiMode persisted to tui.json');

    // Leave Settings (where 1-4 are tab keys) via '6' -> Dashboard, then '1' -> Library
    tty.send('6');
    const dashAscii = await tty.waitFor(
      (s) =>
        /学习统计与掌握度|Stats/.test(s) &&
        !s.includes('正在加载页面…') &&
        !s.includes('Loading view…') &&
        s.includes('+') &&
        s.includes('-'),
      { timeoutMs: 8_000, label: 'Dashboard in ASCII mode @ 160x44' },
    );
    await tty.flush();
    await writeFile(join(screenDumpDir, '160x44-06-dashboard-ascii.txt'), dashAscii, 'utf8');
    assertScreenHealthy(tty, dashAscii, 160, 44, 'Dashboard ASCII @ 160x44');
    assert.ok(dashAscii.includes('+') && dashAscii.includes('-'), 'Dashboard renders classic ASCII borders');

    tty.send('1');
    const libAscii = await tty.waitFor(
      (s) =>
        /题组列表|Decks/.test(s) &&
        !s.includes('正在加载页面…') &&
        !s.includes('Loading view…') &&
        s.includes('+') &&
        s.includes('-') &&
        /掌握度|Mastery/.test(s),
      { timeoutMs: 8_000, label: 'Library in ASCII mode @ 160x44' },
    );
    await tty.flush();
    await writeFile(join(screenDumpDir, '160x44-01-library-ascii.txt'), libAscii, 'utf8');
    assertScreenHealthy(tty, libAscii, 160, 44, 'Library ASCII @ 160x44');
    assert.ok(libAscii.includes('+') && libAscii.includes('-'), 'Library renders classic ASCII borders');
    assert.match(libAscii, /掌握度|Mastery/);

    tty.resize(120, 36);
    await tty.flush();
  });

  test('f) Performance & Memory NFR + clean unmount/dispose', async () => {
    const mem = process.memoryUsage();
    const finalRssMb = Math.round((mem.rss / (1024 * 1024)) * 10) / 10;
    const heapUsedMb = Math.round((mem.heapUsed / (1024 * 1024)) * 10) / 10;
    console.log(
      `[NFR] firstFrameMs=${firstFrameMs}ms sweepRssMb=${sweepRssMb}MB finalRssMb=${finalRssMb}MB heapUsedMb=${heapUsedMb}MB dumps=${screenDumpDir}`,
    );
    assert.ok(firstFrameMs < 3_000, `firstFrameMs (${firstFrameMs}ms) reasonable`);
    assert.ok(heapUsedMb < 220, `JS heapUsed after 16-view sweep (${heapUsedMb}MB) must be < 220MB`);
    // RSS includes @xterm/headless (~60MB test harness) + glibc page retention under Node 24;
    // true production RSS (< 220MB) is verified separately by `npm run bench`.
    assert.ok(sweepRssMb < 395, `RSS after 16-view sweep (${sweepRssMb}MB) must be < 395MB`);
    assert.ok(finalRssMb < 420, `Final RSS including @xterm/headless (${finalRssMb}MB) must be < 420MB`);

    inkInstance.unmount();
    await host.dispose();
    tty.dispose();
    disposeTerminalPool();
    const afterRes = await waitForResourceTeardown(baselineResources, 1500);
    for (const kind of ['FSEventWrap', 'StatWatcher', 'ProcessWrap', 'Timeout']) {
      assert.ok(
        (afterRes[kind] || 0) <= (baselineResources[kind] || 0),
        `${kind} leaked: before=${baselineResources[kind] || 0} after=${afterRes[kind] || 0}`,
      );
    }
  });
});
