// End-to-end xterm-headless TUI verification: node --test tests/xterm-e2e.test.mjs
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
const screenDumpDir = join(tmpdir(), 'studyhub-tui-screens');

// Load directly from built dist/ (avoids loading tsx/esbuild compiler overhead in RSS measurements).
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
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-e2e-${label}-`));
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
      !/\x1b\[|\u001b/.test(screen),
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

/** Deterministic model stub for E2E tests (streams AI explanations live). */
function createE2eCompleteStub() {
  return async (system, prompt, execution = {}) => {
    const s = String(system || '');
    const p = String(prompt || '');
    if (p.includes('OK?')) return 'OK';
    const chunks = s.includes('AI') || p.includes('?') || p.includes('？') || p.includes('讲解') || p.includes('Explain') || p.includes('hint')
      ? ['[AI Tutor] ', 'Focus on ', 'encapsulating ', 'state transitions ', 'cleanly.']
      : ['StudyHub ', 'TUI ', 'stream ', 'verified.'];
    for (const chunk of chunks) {
      execution.signal?.throwIfAborted?.();
      execution.onOutput?.(chunk);
      await sleep(8);
    }
    return chunks.join('');
  };
}

// Navigation sequence using real keyboard shortcuts across all 16 views.
const ALL_16_SWEEP = [
  { id: 'library', key: null, expect: /学习库|Library/ },
  { id: 'sources', key: '2', expect: /资料列表|Materials/ },
  { id: 'generate', key: '3', expect: /新建出题任务|Generate/ },
  { id: 'wrongbook', key: '4', expect: /错题列表|Mistakes/ },
  { id: 'exam', key: '5', expect: /组卷设置|Mock Exam/ },
  { id: 'dashboard', key: '6', expect: /学习统计与掌握度|Stats/ },
  { id: 'book', key: '7', expect: /复习全书|Book/ },
  { id: 'skeleton', key: '8', expect: /知识层级树|Skeleton/ },
  { id: 'examcoach', key: '9', expect: /考试教练|Coach/ },
  { id: 'examprep', key: '0', expect: /备考补习|Exam Prep/ },
  { id: 'notes', key: 'n', expect: /学习笔记|Notes/ },
  { id: 'board', key: 'b', expect: /待办 Todo|Board/ },
  { id: 'tasks', key: 't', expect: /后台任务|Jobs/ },
  { id: 'settings', key: ',', expect: /设置.*模型配置|Settings/ },
  { id: 'audio', key: 'a', expect: /音频转写|Audio/ },
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
    boxDir = await makeTempDir('main');
    dshHome = join(boxDir, 'dsh-home');
    libraryRoot = join(boxDir, 'library');
    process.env.DSH_HOME = dshHome;
    baselineResources = resourceCounts();

    host = await H.createTuiHost({
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
    if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = PREV_DSH_HOME;
    await Promise.all(
      tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
    );
  });

  test('a) Launchpad -> Load Sample Course renders real decks, due counts, and mastery bars', async () => {
    const launchpadScreen = await tty.waitFor(
      (s) => s.includes('载入示例课程体验') || s.includes('Load the sample course'),
      { label: 'Launchpad render' },
    );
    tty.assertHealthyScreen(launchpadScreen, 120, 'Launchpad 120x36');
    await writeFile(join(screenDumpDir, '120x36-00-launchpad.txt'), launchpadScreen, 'utf8');

    // Press 's' to load sample course
    tty.send('s');
    await tty.waitFor(
      (s) =>
        !s.includes('载入示例课程体验') &&
        (s.includes('示例 · Memento 与 Bridge') || s.includes('Sample · Memento')),
      { timeoutMs: 12_000, label: 'Library with sample course' },
    );
    // Let LibraryView finish initial stats/sample status async sync
    await sleep(200);
    await tty.flush();
    const settled = tty.readScreen();
    tty.assertHealthyScreen(settled, 120, 'Library after sample load 120x36');
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
        await sleep(80);
        await tty.flush();
        tty.send('1');
        await tty.waitFor((s) => s.includes('题组列表') || s.includes('Decks'), {
          label: `Return to Library @ ${cols}x${rows}`,
        });
      }

      for (let i = 0; i < ALL_16_SWEEP.length; i += 1) {
        const step = ALL_16_SWEEP[i];
        if (step.key) {
          for (const ch of step.key) {
            tty.send(ch);
            await sleep(55);
          }
        }
        await tty.waitFor(
          (s) =>
            (step.expect.test(s) || s.includes('页面渲染异常') || s.includes('View Error')) &&
            !s.includes('正在加载页面…') &&
            !s.includes('Loading view…'),
          { timeoutMs: 10_000, label: `${step.id} @ ${cols}x${rows}` },
        );
        // Let view-level async fetches settle
        await sleep(160);
        await tty.flush();
        const settled = tty.readScreen();

        const idxStr = String(i + 1).padStart(2, '0');
        await writeFile(join(screenDumpDir, `${cols}x${rows}-${idxStr}-${step.id}.txt`), settled, 'utf8');

        try {
          tty.assertHealthyScreen(settled, cols, `${step.id} @ ${cols}x${rows}`);
        } catch (err) {
          sweepFailures.push(err instanceof Error ? err.message : String(err));
        }
      }

      // From review (or ViewCrashFallback), exit cleanly back to library
      const afterReview = tty.readScreen();
      if (afterReview.includes('页面渲染异常') || afterReview.includes('View Error')) {
        tty.send('1');
      } else {
        tty.send('q');
        await tty.waitFor(
          (s) => s.includes('再来一轮') || s.includes('New Round') || s.includes('本轮'),
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
    await sleep(80);
    await tty.flush();
    sweepRssMb = Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10;
    assert.deepEqual(sweepFailures, [], `16-view sweep failures:\n${sweepFailures.join('\n\n')}`);
  });

  test('c) Interactive FSRS-6 review + live streaming AI Help + Round Summary', async () => {
    tty.send('1');
    await tty.waitFor((s) => s.includes('题组列表') || s.includes('Decks'), { label: 'Library before review' });
    tty.send('r');
    const reviewScreen = await tty.waitFor(
      (s) => (s.includes('1/') || s.includes('▶')) && !s.includes('正在准备复习队列'),
      { timeoutMs: 10_000, label: 'Review active card' },
    );
    tty.assertHealthyScreen(reviewScreen, 120, 'Review card #1');

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
            scr.includes('2/9') ||
            scr.includes('3/9') ||
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
        await sleep(140);
        continue;
      }
      tty.send('s');
      await sleep(140);
    }
    assert.equal(ratedFsrs, true, 'Rated at least one card with FSRS-6 Good (3)');

    // Open AI Help drawer (`h`)
    tty.send('h');
    const aiDrawerOpened = await tty.waitFor(
      (s) => s.includes('AI 帮我理解') || s.includes('AI Tutor'),
      { label: 'AI Help drawer opened' },
    );
    tty.assertHealthyScreen(aiDrawerOpened, 120, 'AI Help drawer');

    // Wait for auto-explain stream to finish, then send a custom follow-up question
    await tty.waitFor(
      (s) => s.includes('encapsulating state transitions cleanly'),
      { timeoutMs: 8_000, label: 'Auto-explain stream output' },
    );

    tty.send('i');
    await sleep(60);
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
    tty.assertHealthyScreen(followUpScreen, 120, 'AI follow-up streamed');

    // Close AI drawer (`Esc`) and end round (`q`) -> Round Summary
    tty.send('\x1b');
    await tty.waitFor((s) => !s.includes('AI 帮我理解') && !s.includes('AI Tutor'), {
      label: 'AI drawer closed',
    });

    tty.send('q');
    const summaryScreen = await tty.waitFor(
      (s) => s.includes('再来一轮') || s.includes('New Round') || s.includes('本轮') || s.includes('Round'),
      { timeoutMs: 8_000, label: 'Round Summary' },
    );
    tty.assertHealthyScreen(summaryScreen, 120, 'Round Summary');

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
    tty.assertHealthyScreen(boardScreen, 120, 'Board empty');

    // Add a card ('a')
    tty.send('a');
    await tty.waitFor((s) => s.includes('添加看板任务') || s.includes('Add Board Card'), {
      label: 'Board Add Card Modal',
    });
    tty.send('Master Memento Pattern');
    await sleep(40);
    // Ctrl+S saves immediately from any field in BoardCardModal
    tty.send('\x13');

    const addedScreen = await tty.waitFor((s) => s.includes('Master Memento Pattern'), {
      label: 'Card added to Todo column',
    });
    tty.assertHealthyScreen(addedScreen, 120, 'Board after add');

    // Move card right ('L') from Todo -> Doing
    tty.send('L');
    await sleep(160);
    await tty.flush();

    const boardFile = join(libraryRoot, 'tui-board.json');
    const raw = await readFile(boardFile, 'utf8');
    const persisted = JSON.parse(raw);
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
    tty.assertHealthyScreen(paletteFiltered, 120, 'Command Palette');
    tty.send('\x1b');
    await tty.waitFor((s) => !s.includes('命令面板') && !s.includes('Command Palette'), {
      label: 'Command Palette closed',
    });

    // 2. Help Overlay (?)
    tty.send('?');
    const helpScreen = await tty.waitFor((s) => s.includes('快捷键') || s.includes('Keyboard Shortcuts'), {
      label: 'Help overlay open',
    });
    tty.assertHealthyScreen(helpScreen, 120, 'Help Overlay');
    tty.send('?');
    await tty.waitFor((s) => !s.includes('快捷键') && !s.includes('Keyboard Shortcuts'), {
      label: 'Help overlay closed',
    });

    // 3. Course Picker (c)
    tty.send('c');
    const pickerScreen = await tty.waitFor((s) => s.includes('切换课程') || s.includes('Switch Course'), {
      label: 'Course Picker open',
    });
    tty.assertHealthyScreen(pickerScreen, 120, 'Course Picker');
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
      ['3', /FSRS|复习与出题/],
      ['4', /TUI 外观与偏好|TUI Appearance/],
    ]) {
      tty.send(tabKey);
      const tabScreen = await tty.waitFor((s) => expectRe.test(s), {
        label: `Settings tab ${tabKey}`,
      });
      tty.assertHealthyScreen(tabScreen, 120, `Settings tab ${tabKey}`);
    }

    // Row 0 is Theme: dsh-dark -> warm-paper -> nord (press 'l' twice)
    tty.send('l');
    await sleep(50);
    tty.send('l');
    await tty.waitFor((s) => s.includes('Nord'), { label: 'Theme switched to Nord' });

    // Row 1 is Language: zh -> en -> zh
    tty.send('j');
    await sleep(50);
    tty.send('l');
    const enScreen = await tty.waitFor((s) => s.includes('UI Language') && s.includes('English (en)'), {
      label: 'Language switched to English',
    });
    tty.assertHealthyScreen(enScreen, 120, 'Settings Appearance EN');

    tty.send('l');
    const zhScreen = await tty.waitFor((s) => s.includes('界面语言') && s.includes('简体中文 (zh)'), {
      label: 'Language switched back to Chinese',
    });
    tty.assertHealthyScreen(zhScreen, 120, 'Settings Appearance ZH');
  });

  test('g) Sources & Document Reader pagination + Page Ask AI + Esc exit', async () => {
    // Leave Settings (where 1-4 are tab keys) via '6' -> Dashboard, then '2' -> Sources
    tty.send('6');
    await tty.waitFor((s) => s.includes('学习统计') || s.includes('Stats'), {
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
    tty.assertHealthyScreen(readerScreen, 120, 'DocumentReader page 1');

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
    tty.assertHealthyScreen(aiReaderScreen, 120, 'DocumentReader Page Ask AI');

    // Esc closes AI pane back to reader, second Esc exits reader back to Sources
    tty.send('\x1b');
    await sleep(60);
    tty.send('\x1b');
    const backToSources = await tty.waitFor((s) => s.includes('资料列表') || s.includes('Materials'), {
      timeoutMs: 8_000,
      label: 'Exited DocumentReader back to Sources',
    });
    tty.assertHealthyScreen(backToSources, 120, 'Sources after DocumentReader exit');
  });

  test('f) Performance & Memory NFR + clean unmount/dispose', async () => {
    const mem = process.memoryUsage();
    const finalRssMb = Math.round((mem.rss / (1024 * 1024)) * 10) / 10;
    const heapUsedMb = Math.round((mem.heapUsed / (1024 * 1024)) * 10) / 10;
    console.log(
      `[NFR] firstFrameMs=${firstFrameMs}ms sweepRssMb=${sweepRssMb}MB finalRssMb=${finalRssMb}MB heapUsedMb=${heapUsedMb}MB dumps=${screenDumpDir}`,
    );
    assert.ok(firstFrameMs < 3_000, `firstFrameMs (${firstFrameMs}ms) reasonable`);
    assert.ok(sweepRssMb < 350, `RSS after 16-view sweep (${sweepRssMb}MB) must be < 350MB`);
    // After additional DocumentReader + AI streaming + @xterm/headless (~50MB test harness overhead), RSS stays < 400MB
    assert.ok(finalRssMb < 400, `Final RSS including @xterm/headless (${finalRssMb}MB) must be < 400MB`);

    inkInstance.unmount();
    await host.dispose();
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
