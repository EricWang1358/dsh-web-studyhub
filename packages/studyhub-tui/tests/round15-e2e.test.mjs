// Round 15 Features & Regression E2E verification: node --test tests/round15-e2e.test.mjs
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
assert.ok(H?.saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(R?.displayWidth, 'dist/ must export displayWidth');

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round15-${label}-`));
  tempDirs.push(d);
  return d;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const UNICODE_BOX_RE = /[\u2500-\u257f]/g;
const UNICODE_BLOCK_RE = /[\u2580-\u259f]/g;
const UNICODE_BRAILLE_RE = /[\u2800-\u28ff]/g;

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

  function assertHealthyScreen(screen, expectedCols, expectedRows, contextLabel) {
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
    assert.ok(
      lines.length <= expectedRows,
      `${contextLabel}: Screen rows exceeded (${lines.length} > ${expectedRows})`,
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

  function assertAsciiPure(screen, contextLabel) {
    const boxMatch = screen.match(UNICODE_BOX_RE);
    assert.equal(
      boxMatch,
      null,
      `${contextLabel}: Unicode box-drawing chars leaked in --ascii mode: ${JSON.stringify(boxMatch ? [...new Set(boxMatch)] : [])}\n${screen}`,
    );
    const blockMatch = screen.match(UNICODE_BLOCK_RE);
    assert.equal(
      blockMatch,
      null,
      `${contextLabel}: Unicode block elements leaked in --ascii mode: ${JSON.stringify(blockMatch ? [...new Set(blockMatch)] : [])}\n${screen}`,
    );
    const brailleMatch = screen.match(UNICODE_BRAILLE_RE);
    assert.equal(
      brailleMatch,
      null,
      `${contextLabel}: Unicode Braille chars leaked in --ascii mode: ${JSON.stringify(brailleMatch ? [...new Set(brailleMatch)] : [])}\n${screen}`,
    );
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
    assertAsciiPure,
    dispose: () => {
      term.dispose();
      stdin.destroy();
      stdout.destroy();
      stderr.destroy();
    },
  };
}

function createRound15StubComplete() {
  return async (_system, prompt, execution = {}) => {
    const p = String(prompt || '');
    if (p.includes('OK?')) return 'OK';
    execution.signal?.throwIfAborted?.();
    const reply = JSON.stringify({ status: 'ok' });
    execution.onOutput?.(reply);
    return reply;
  };
}

describe('StudyHub TUI Round 15 Features & Regression E2E', () => {
  let boxDir;
  let dshHome;
  let libraryRoot;
  let host;
  let tty;
  let inkInstance;
  let disposed = false;
  const extraCleanups = [];

  async function cleanupAll() {
    if (disposed) return;
    disposed = true;
    while (extraCleanups.length > 0) {
      const fn = extraCleanups.pop();
      try {
        await fn();
      } catch {
        // Ignore teardown errors from secondary test handles
      }
    }
    try {
      inkInstance?.unmount();
    } catch {
      // Ignore unmount errors during primary teardown
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
      injectedComplete: createRound15StubComplete(),
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

  test('1) CoachPreferencesModal (9 -> p): profile summary, add/remove preference, 120x36 & 80x24, Esc closes', async () => {
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
    await sleep(100);
    await tty.flush();

    // Navigate to ExamCoachView via '9'
    tty.send('9');
    const coachScreen = await tty.waitFor(
      (s) =>
        (s.includes('考试教练') || s.includes('Exam Coach')) &&
        (s.includes('校准与考法') || s.includes('Calibration')) &&
        !s.includes('正在加载页面') &&
        !s.includes('正在加载考试教练'),
      { timeoutMs: 10_000, label: 'ExamCoachView rendered' },
    );
    tty.assertHealthyScreen(coachScreen, 120, 36, 'ExamCoachView initial');

    // Open CoachPreferencesModal via 'p'
    tty.send('p');
    const prefsWide = await tty.waitFor(
      (s) =>
        (s.includes('学习者画像与长期偏好') || s.includes('Learner Profile & Preferences')) &&
        (s.includes('画像摘要') || s.includes('Summary:')) &&
        !s.includes('正在读取学习者画像'),
      { timeoutMs: 8_000, label: 'CoachPreferencesModal opened at 120x36' },
    );
    assert.ok(
      prefsWide.includes('目标:') || prefsWide.includes('Goal:'),
      `Profile summary header must show Goal badge:\n${prefsWide}`,
    );
    tty.assertHealthyScreen(prefsWide, 120, 36, 'CoachPreferencesModal initial 120x36');

    // Press 'a' to add a custom preference
    const prefText = 'Prefer concise bullet proofs';
    tty.send('a');
    await tty.waitFor(
      (s) => s.includes('新增偏好') || s.includes('New preference'),
      { timeoutMs: 5_000, label: 'CoachPreferencesModal add input opened' },
    );

    tty.send(prefText);
    await tty.waitFor(
      (s) => s.includes(prefText),
      { timeoutMs: 5_000, label: 'Preference text typed' },
    );

    tty.send('\r');
    const prefsPopulatedWide = await tty.waitFor(
      (s) =>
        !s.includes('新增偏好') &&
        !s.includes('New preference') &&
        s.includes(prefText) &&
        s.includes('1/12'),
      { timeoutMs: 8_000, label: 'Added preference rendered in list' },
    );
    tty.assertHealthyScreen(prefsPopulatedWide, 120, 36, 'CoachPreferencesModal populated 120x36');

    // Verify 80x24 layout with populated preference
    tty.resize(80, 24);
    const prefsPopulatedNarrow = await tty.waitFor(
      (s) =>
        (s.includes('学习者画像与长期偏好') || s.includes('Learner Profile & Preferences')) &&
        s.includes(prefText) &&
        s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'CoachPreferencesModal populated at 80x24' },
    );
    tty.assertHealthyScreen(prefsPopulatedNarrow, 80, 24, 'CoachPreferencesModal populated 80x24');

    // Restore 120x36
    tty.resize(120, 36);
    await tty.waitFor(
      (s) => s.includes('学习者画像与长期偏好') && s.includes(prefText),
      { timeoutMs: 8_000, label: 'CoachPreferencesModal restored to 120x36' },
    );

    // Press 'd' to remove the preference
    tty.send('d');
    const prefsRemoved = await tty.waitFor(
      (s) =>
        !s.includes(prefText) &&
        s.includes('0/12') &&
        (s.includes('暂无自定义学习偏好') || s.includes('No study preferences yet')),
      { timeoutMs: 8_000, label: 'Preference removed from list' },
    );
    tty.assertHealthyScreen(prefsRemoved, 120, 36, 'CoachPreferencesModal after remove');

    // Esc closes modal cleanly back to ExamCoachView
    tty.send('\x1b');
    const backToCoach = await tty.waitFor(
      (s) =>
        !s.includes('学习者画像与长期偏好') &&
        !s.includes('Learner Profile & Preferences') &&
        (s.includes('考试教练') || s.includes('Exam Coach')),
      { timeoutMs: 8_000, label: 'CoachPreferencesModal closed via Esc' },
    );
    tty.assertHealthyScreen(backToCoach, 120, 36, 'ExamCoachView after CoachPreferencesModal closed');
  });

  test('2) BookQaModal (7 -> P): empty/populated state at 120x36 & 80x24, Esc closes cleanly', async () => {
    tty.send('7');
    const bookInit = await tty.waitFor(
      (s) =>
        (s.includes('精选问答') || s.includes('Pinned QA')) &&
        !s.includes('正在打开复习全书') &&
        !s.includes('正在加载页面'),
      { timeoutMs: 10_000, label: 'BookView rendered' },
    );
    tty.assertHealthyScreen(bookInit, 120, 36, 'BookView initial');

    // Open BookQaModal via 'P'
    tty.send('P');
    const qaWide = await tty.waitFor(
      (s) =>
        (s.includes('全书精选问答与答题卡') || s.includes('Book Pinned Q&A & Answer Cards')) &&
        !s.includes('正在读取全书精选问答') &&
        (s.includes('当前课程暂无已收录的答题卡或追问') ||
          s.includes('No pinned Answer Cards or Q&As yet') ||
          s.includes('已收录条目') ||
          s.includes('Pinned')),
      { timeoutMs: 8_000, label: 'BookQaModal rendered at 120x36' },
    );
    tty.assertHealthyScreen(qaWide, 120, 36, 'BookQaModal 120x36');

    // Verify 80x24 layout
    tty.resize(80, 24);
    const qaNarrow = await tty.waitFor(
      (s) =>
        (s.includes('全书精选问答与答题卡') || s.includes('Book Pinned Q&A & Answer Cards')) &&
        s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'BookQaModal rendered at 80x24' },
    );
    tty.assertHealthyScreen(qaNarrow, 80, 24, 'BookQaModal 80x24');

    // Restore 120x36 and close cleanly with Esc
    tty.resize(120, 36);
    await tty.waitFor(
      (s) => s.includes('全书精选问答与答题卡') || s.includes('Book Pinned Q&A & Answer Cards'),
      { timeoutMs: 8_000, label: 'BookQaModal restored to 120x36' },
    );

    tty.send('\x1b');
    const afterQaClose = await tty.waitFor(
      (s) =>
        !s.includes('全书精选问答与答题卡') &&
        !s.includes('Book Pinned Q&A & Answer Cards') &&
        (s.includes('复习全书') || s.includes('Review Book')),
      { timeoutMs: 8_000, label: 'BookQaModal closed via Esc' },
    );
    tty.assertHealthyScreen(afterQaClose, 120, 36, 'BookView after BookQaModal closed');

    // Unmount primary Ink instance before running dedicated --ascii render in Test 3
    // so two StudyHubTuiApp instances never share the Zustand store simultaneously.
    inkInstance.unmount();
    inkInstance = null;
    tty.dispose();
    tty = null;
  });

  test('3) Review --ascii Zero-Unicode-Leak Purity Test across CardTools (D), Retell (F), Similar (S), AnswerCard (A)', async () => {
    const asciiDir = await makeTempDir('ascii');
    const asciiDshHome = join(asciiDir, 'dsh-home');
    const asciiLibRoot = join(asciiDir, 'library');

    await H.saveTuiPreferences({ language: 'zh', asciiMode: true }, { env: { DSH_HOME: asciiDshHome } });

    const asciiHost = await H.createTuiHost({
      env: { DSH_HOME: asciiDshHome },
      home: join(asciiDir, 'home'),
      libraryRoot: asciiLibRoot,
      injectedComplete: createRound15StubComplete(),
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    const sampleRes = await asciiHost.call('sample.load', { language: 'zh' });
    assert.equal(sampleRes.ok, true, 'sample.load must succeed for ASCII test');

    const asciiTty = createVirtualTty(120, 36);
    let asciiInk = null;

    const cleanupAscii = async () => {
      try {
        asciiInk?.unmount();
      } catch {
        // Ignore unmount errors during ASCII teardown
      }
      await asciiHost.dispose();
      asciiTty.dispose();
    };
    extraCleanups.push(cleanupAscii);

    try {
      asciiInk = render(
        React.createElement(StudyHubTuiApp, {
          host: asciiHost,
          initialPage: 'library',
          initialLanguage: 'zh',
          initialAsciiMode: true,
          autoLaunchpad: false,
          onExit: () => asciiInk?.unmount(),
        }),
        {
          stdin: asciiTty.stdin,
          stdout: asciiTty.stdout,
          stderr: asciiTty.stderr,
          interactive: true,
          exitOnCtrlC: false,
          patchConsole: false,
        },
      );
      await asciiTty.firstFramePromise;

      const libAscii = await asciiTty.waitFor(
        (s) =>
          s.includes('示例 · Memento 与 Bridge') &&
          !s.includes('正在打开学习库') &&
          !s.includes('正在加载页面'),
        { timeoutMs: 10_000, label: 'ASCII LibraryView rendered' },
      );
      asciiTty.assertHealthyScreen(libAscii, 120, 36, 'ASCII LibraryView');
      asciiTty.assertAsciiPure(libAscii, 'ASCII LibraryView');

      // Start Review on the first sample deck via 'r'
      asciiTty.send('r');
      const reviewAscii = await asciiTty.waitFor(
        (s) =>
          (s.includes('[D]工具') || s.includes('[D]Tools')) &&
          (s.includes('[A]答题卡') || s.includes('[A]AnswerCard')) &&
          !s.includes('正在准备复习队列'),
        { timeoutMs: 10_000, label: 'ASCII ReviewView rendered' },
      );
      await asciiTty.flush();
      asciiTty.assertHealthyScreen(reviewAscii, 120, 36, 'ASCII ReviewView');
      asciiTty.assertAsciiPure(reviewAscii, 'ASCII ReviewView');

      // 3a) CardToolsModal ('D')
      asciiTty.send('D');
      const cardToolsScreen = await asciiTty.waitFor(
        (s) => s.includes('题目工具箱') || s.includes('Card Tools'),
        { timeoutMs: 8_000, label: 'ASCII CardToolsModal opened' },
      );
      await asciiTty.flush();
      asciiTty.assertHealthyScreen(cardToolsScreen, 120, 36, 'ASCII CardToolsModal');
      asciiTty.assertAsciiPure(cardToolsScreen, 'ASCII CardToolsModal');

      asciiTty.send('\x1b');
      await asciiTty.waitFor(
        (s) => !s.includes('题目工具箱') && !s.includes('Card Tools'),
        { timeoutMs: 8_000, label: 'ASCII CardToolsModal closed' },
      );

      // 3b) RetellModal ('F')
      asciiTty.send('F');
      const retellScreen = await asciiTty.waitFor(
        (s) =>
          (s.includes('费曼复述') || s.includes('Feynman Retell')) &&
          (s.includes('用自己的话复述') || s.includes('Explain the core idea')),
        { timeoutMs: 8_000, label: 'ASCII RetellModal opened' },
      );
      await asciiTty.flush();
      asciiTty.assertHealthyScreen(retellScreen, 120, 36, 'ASCII RetellModal');
      asciiTty.assertAsciiPure(retellScreen, 'ASCII RetellModal');

      asciiTty.send('\x1b');
      await asciiTty.waitFor(
        (s) => !s.includes('用自己的话复述') && !s.includes('Explain the core idea'),
        { timeoutMs: 8_000, label: 'ASCII RetellModal closed' },
      );

      // 3c) SimilarCardsModal ('S')
      asciiTty.send('S');
      const similarScreen = await asciiTty.waitFor(
        (s) =>
          (s.includes('同类 / 易混题对比') || s.includes('Similar & Confusable Cards')) &&
          !s.includes('正在检索同类易混题目'),
        { timeoutMs: 8_000, label: 'ASCII SimilarCardsModal opened' },
      );
      await asciiTty.flush();
      asciiTty.assertHealthyScreen(similarScreen, 120, 36, 'ASCII SimilarCardsModal');
      asciiTty.assertAsciiPure(similarScreen, 'ASCII SimilarCardsModal');

      asciiTty.send('\x1b');
      await asciiTty.waitFor(
        (s) => !s.includes('同类 / 易混题对比') && !s.includes('Similar & Confusable Cards'),
        { timeoutMs: 8_000, label: 'ASCII SimilarCardsModal closed' },
      );

      // 3d) AnswerCardModal ('A')
      asciiTty.send('A');
      const answerCardScreen = await asciiTty.waitFor(
        (s) =>
          (s.includes('分析题答题卡') || s.includes('Case Answer Card')) &&
          !s.includes('正在读取答题卡'),
        { timeoutMs: 8_000, label: 'ASCII AnswerCardModal opened' },
      );
      await asciiTty.flush();
      asciiTty.assertHealthyScreen(answerCardScreen, 120, 36, 'ASCII AnswerCardModal');
      asciiTty.assertAsciiPure(answerCardScreen, 'ASCII AnswerCardModal');

      asciiTty.send('\x1b');
      await asciiTty.waitFor(
        (s) => !s.includes('分析题答题卡') && !s.includes('Case Answer Card'),
        { timeoutMs: 8_000, label: 'ASCII AnswerCardModal closed' },
      );
    } finally {
      await cleanupAscii();
      extraCleanups.pop();
    }
  });

  test('4) NotesView Save-Keeps-Selection Regression (create -> wait 300ms for note.list -> stays selected -> delete)', async () => {
    // Re-mount clean non-ASCII app on existing host (with sample course already loaded)
    await H.saveTuiPreferences({ language: 'zh', asciiMode: false }, { env: { DSH_HOME: dshHome } });
    tty = createVirtualTty(120, 36);
    inkInstance = render(
      React.createElement(StudyHubTuiApp, {
        host,
        initialPage: 'library',
        initialLanguage: 'zh',
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
      { timeoutMs: 10_000, label: 'LibraryView ready before NotesView navigation' },
    );

    // Navigate to NotesView ('n') on primary app
    tty.send('n');
    const notesInit = await tty.waitFor(
      (s) =>
        (s.includes('Unicode Math') || s.includes('Raw LaTeX') || s.includes('笔记正文') || s.includes('Note Reader')) &&
        !s.includes('载入笔记中') &&
        !s.includes('正在加载页面'),
      { timeoutMs: 10_000, label: 'NotesView rendered' },
    );
    tty.assertHealthyScreen(notesInit, 120, 36, 'NotesView initial');

    const noteTitle = 'R15 Keep Selection Note';
    const noteBody = 'R15_PENDING_SELECT_REGRESSION_BODY';

    // Open create modal via 'a'
    tty.send('a');
    const createModal = await tty.waitFor(
      (s) =>
        (s.includes('新建学习笔记') || s.includes('New Study Note')) &&
        (s.includes('已选 1/30') || s.includes('Linked Cards (1/30)')),
      { timeoutMs: 8_000, label: 'NoteEditorModal create opened with preselected card' },
    );
    tty.assertHealthyScreen(createModal, 120, 36, 'NoteEditorModal create');

    // Type note title
    tty.send(noteTitle);
    await tty.waitFor(
      (s) => s.includes(noteTitle),
      { timeoutMs: 5_000, label: 'Note title typed' },
    );

    // Tab 3 times: title -> query -> cards -> markdown body
    for (let i = 0; i < 3; i += 1) {
      tty.send('\t');
      await sleep(30);
    }
    await tty.flush();

    tty.send(noteBody);
    await tty.waitFor(
      (s) => s.includes(noteBody),
      { timeoutMs: 5_000, label: 'Note body typed' },
    );

    // Tab back to title (single-line) before Ctrl+S so only NoteEditorModal's Ctrl+S handler fires once
    tty.send('\t');
    await tty.flush();

    // Save via Ctrl+S
    tty.send('\x13');
    await tty.waitFor(
      (s) => !s.includes('新建学习笔记') && !s.includes('New Study Note'),
      { timeoutMs: 8_000, label: 'NoteEditorModal closed after Ctrl+S' },
    );

    // Wait for background note.list / snapshot refresh to settle (~350ms), WITHOUT pressing any nav keys
    await sleep(350);
    await tty.flush();

    const settledScreen = await tty.waitFor(
      (s) =>
        (s.includes('学习笔记  3') || s.includes('Notes  3')) &&
        s.includes(noteTitle) &&
        s.includes(noteBody) &&
        /(?:R15 Keep Selection Note)\s+(?:草稿|Draft)/.test(s),
      { timeoutMs: 6_000, label: 'Newly created note stayed selected in detail pane after background refresh' },
    );
    tty.assertHealthyScreen(settledScreen, 120, 36, 'NotesView settled after create');

    // Delete cleanly via 'd' -> 'y'
    tty.send('d');
    const deleteDialog = await tty.waitFor(
      (s) => s.includes('删除笔记') || s.includes('Delete Note'),
      { timeoutMs: 8_000, label: 'Delete note confirmation dialog' },
    );
    tty.assertHealthyScreen(deleteDialog, 120, 36, 'NotesView delete ConfirmDialog');

    tty.send('y');
    const afterDelete = await tty.waitFor(
      (s) => !s.includes('删除笔记') && !s.includes('Delete Note') && !s.includes(noteTitle),
      { timeoutMs: 8_000, label: 'Deleted note removed from NotesView' },
    );
    tty.assertHealthyScreen(afterDelete, 120, 36, 'NotesView after delete');
  });
});
