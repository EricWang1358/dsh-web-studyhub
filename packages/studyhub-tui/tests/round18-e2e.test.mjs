// Round 18 Features E2E verification: node --test tests/round18-e2e.test.mjs
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
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round18-${label}-`));
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

function createRound18StubComplete() {
  return async (system, prompt, execution = {}) => {
    const sys = String(system || '');
    const p = String(prompt || '');
    if (p.includes('OK?')) return 'OK';
    execution.signal?.throwIfAborted?.();

    let reply;
    if (sys.startsWith('You file a learner')) {
      const req = JSON.parse(p);
      const deckId = req.catalog?.[0]?.deckId ?? null;
      reply = JSON.stringify({
        duplicateOf: null,
        deckId,
        newDeck: deckId ? null : { title: 'Captured Deck', folder: '' },
        topic: 'Observer Pattern',
        reason: 'Matches existing design patterns deck',
      });
    } else if (sys.startsWith('You write one rigorous study card')) {
      const dataIdx = p.indexOf('DATA:\n');
      const data = dataIdx >= 0 ? JSON.parse(p.slice(dataIdx + 6)) : {};
      const q = String(data.question || 'What is the Observer pattern?');
      const a = String(data.proposedAnswer || 'Defines one-to-many dependency between objects.');
      const noteText = `Supplementary study note for "${q}": ${a} When the subject state changes, all registered observers are notified automatically.`;
      reply = JSON.stringify({
        grounded: false,
        note: noteText,
        card: {
          kind: 'flashcard',
          topic: 'Observer Pattern',
          objective: `Explain ${q}`,
          prompt: q,
          answer: a,
          hint: 'Think about a subject maintaining a list of subscribers.',
          explanation: 'The Observer pattern decouples subjects from observers via automatic notifications.',
          misconception: 'Confusing the Observer pattern with the Mediator pattern.',
          citations: [{ sourceId: 'NOTE', quote: noteText.slice(0, Math.min(noteText.length, 48)) }],
        },
      });
    } else if (sys.startsWith('You convert a learner')) {
      const dataIdx = p.indexOf('DATA:\n');
      const data = dataIdx >= 0 ? JSON.parse(p.slice(dataIdx + 6)) : {};
      const pasted = String(data.pasted || '');
      const quote = pasted.slice(0, Math.min(pasted.length, 32));
      reply = JSON.stringify({
        items: [
          {
            kind: 'flashcard',
            topic: 'Design Patterns',
            objective: 'Explain the Flyweight pattern intent',
            prompt: 'What is the Flyweight pattern?',
            answer: 'Shares intrinsic state across many fine-grained objects to save memory.',
            answerFrom: 'material',
            hint: 'Think about sharing immutable state among many instances.',
            explanation: 'Flyweight separates intrinsic shared state from extrinsic context.',
            misconception: 'Confusing Flyweight with Singleton.',
            quotes: [quote],
            learner: { selected: [], wrong: false },
          },
        ],
        ignored: [],
      });
    } else {
      reply = JSON.stringify({ status: 'ok' });
    }

    execution.onOutput?.(reply);
    return reply;
  };
}

async function countSnapshotCards(host) {
  const snapRes = await host.call('snapshot', {});
  assert.equal(snapRes.ok, true, 'snapshot must succeed');
  const decks = snapRes.value?.decks ?? [];
  return decks.reduce(
    (sum, d) => sum + (Number(d.count ?? d.cardCount ?? (Array.isArray(d.cards) ? d.cards.length : 0)) || 0),
    0,
  );
}

describe('StudyHub TUI Round 18 Features E2E', () => {
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
      injectedComplete: createRound18StubComplete(),
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

  test('1) GenerateView IngestModal (3 -> i): Quick Capture & Bulk Ingest at 120x36 & 80x24, Esc closes', async () => {
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

    const initialCardCount = await countSnapshotCards(host);

    // Navigate to GenerateView via '3' (wait for GenerateView-unique content, not sidebar text)
    tty.send('3');
    const genInit = await tty.waitFor(
      (s) =>
        (s.includes('1. 选择资料') || s.includes('1. Select Materials')) &&
        (s.includes('2. 出题设置与预估') || s.includes('2. Generation Settings')) &&
        !s.includes('正在加载页面'),
      { timeoutMs: 10_000, label: 'GenerateView rendered' },
    );
    tty.assertHealthyScreen(genInit, 120, 36, 'GenerateView initial');

    // Open IngestModal via 'i'
    tty.send('i');
    const ingestTab1 = await tty.waitFor(
      (s) =>
        (s.includes('快速录题与批量整理') || s.includes('Quick Capture & Bulk Ingest')) &&
        (s.includes('题干 *') || s.includes('Question *')),
      { timeoutMs: 10_000, label: 'IngestModal Tab 1 rendered' },
    );
    tty.assertHealthyScreen(ingestTab1, 120, 36, 'IngestModal Tab 1 initial');

    // Type question, Tab to answer, type answer, Ctrl+S to submit capture
    tty.send('What is the Observer pattern?');
    await tty.waitFor(
      (s) => s.includes('What is the Observer pattern?'),
      { timeoutMs: 5_000, label: 'Question typed in IngestModal' },
    );

    tty.send('\t');
    await tty.flush();
    tty.send('Defines one-to-many dependency between objects.');
    await tty.waitFor(
      (s) => s.includes('Defines one-to-many dependency'),
      { timeoutMs: 5_000, label: 'Answer typed in IngestModal' },
    );

    tty.send('\x13');
    const captureDone = await tty.waitFor(
      (s) =>
        (s.includes('已录入') || s.includes('Added to')) &&
        !s.includes('正在识别并归档题目'),
      { timeoutMs: 10_000, label: 'Quick Capture completed' },
    );
    tty.assertHealthyScreen(captureDone, 120, 36, 'IngestModal after Quick Capture');

    const afterCaptureCount = await countSnapshotCards(host);
    assert.equal(afterCaptureCount, initialCardCount + 1, 'Quick Capture should add 1 card to snapshot');

    // Switch to Tab 2 (Bulk Ingest) via Ctrl+T
    tty.send('\x14');
    const ingestTab2 = await tty.waitFor(
      (s) =>
        (s.includes('粘贴既有题目或试卷错题') || s.includes('Paste Existing Questions')) &&
        !s.includes('题干 * (Question)'),
      { timeoutMs: 8_000, label: 'IngestModal Tab 2 Bulk Ingest rendered' },
    );
    tty.assertHealthyScreen(ingestTab2, 120, 36, 'IngestModal Tab 2 initial');

    // Paste raw Q&A block using bracketed paste and submit via Ctrl+S
    const rawBlock = 'Q: What is the Flyweight pattern?\nA: Shares intrinsic state across many fine-grained objects to save memory.';
    tty.send(`\x1b[200~${rawBlock}\x1b[201~`);
    await tty.waitFor(
      (s) => s.includes('Flyweight pattern'),
      { timeoutMs: 5_000, label: 'Bulk text pasted in IngestModal' },
    );

    tty.send('\x13');
    const ingestSummary = await tty.waitFor(
      (s) =>
        (s.includes('批量整理结果') || s.includes('Bulk Ingest Summary')) &&
        (s.includes('新增 1') || s.includes('Added 1')) &&
        s.includes('What is the Flyweight pattern?'),
      { timeoutMs: 10_000, label: 'Bulk Ingest summary rendered at 120x36' },
    );
    tty.assertHealthyScreen(ingestSummary, 120, 36, 'IngestModal Bulk Ingest summary at 120x36');

    const afterIngestCount = await countSnapshotCards(host);
    assert.equal(afterIngestCount, initialCardCount + 2, 'Bulk Ingest should add 1 more card to snapshot');

    // Verify healthy at 80x24
    tty.resize(80, 24);
    const ingestSummaryNarrow = await tty.waitFor(
      (s) =>
        (s.includes('批量整理结果') || s.includes('Bulk Ingest Summary')) &&
        (s.includes('新增 1') || s.includes('Added 1')) &&
        s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'IngestModal summary at 80x24' },
    );
    tty.assertHealthyScreen(ingestSummaryNarrow, 80, 24, 'IngestModal summary at 80x24');

    // Restore 120x36 and close cleanly via Esc
    tty.resize(120, 36);
    await tty.waitFor(
      (s) => s.includes('批量整理结果') || s.includes('Bulk Ingest Summary'),
      { timeoutMs: 8_000, label: 'IngestModal restored to 120x36' },
    );

    tty.send('\x1b');
    const backToGen = await tty.waitFor(
      (s) =>
        !s.includes('快速录题与批量整理') &&
        !s.includes('Quick Capture & Bulk Ingest') &&
        (s.includes('1. 选择资料') || s.includes('1. Select Materials')),
      { timeoutMs: 8_000, label: 'IngestModal closed via Esc' },
    );
    tty.assertHealthyScreen(backToGen, 120, 36, 'GenerateView after IngestModal closed');
  });

  test('2) DashboardView (6): KPIs, 7-day forecast [f] at 120x36 & 80x24, and j/k + Enter drill-down into ReviewView', async () => {
    // Navigate to DashboardView via '6'
    tty.send('6');
    const dashInit = await tty.waitFor(
      (s) =>
        (s.includes('学习统计与掌握度') || s.includes('Study Analytics & Mastery')) &&
        (s.includes('薄弱点与课程钻取') || s.includes('Weak Topics & Courses')) &&
        !s.includes('加载中...') &&
        !s.includes('Loading...'),
      { timeoutMs: 10_000, label: 'DashboardView rendered at 120x36' },
    );
    tty.assertHealthyScreen(dashInit, 120, 36, 'DashboardView initial at 120x36');
    assert.ok(
      dashInit.includes('总题数') || dashInit.includes('Cards'),
      'DashboardView should display KPI cards',
    );

    // Toggle 7-day forecast via 'f' at 120x36
    tty.send('f');
    const dashForecastWide = await tty.waitFor(
      (s) => s.includes('7 日到期预测') || s.includes('7-Day Forecast'),
      { timeoutMs: 8_000, label: 'DashboardView 7-day forecast at 120x36' },
    );
    tty.assertHealthyScreen(dashForecastWide, 120, 36, 'DashboardView 7-day forecast at 120x36');

    // Verify 7-day forecast & [f] toggle at 80x24
    tty.resize(80, 24);
    const dashForecastNarrow = await tty.waitFor(
      (s) =>
        (s.includes('7 日到期预测') || s.includes('7-Day Forecast')) &&
        s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'DashboardView 7-day forecast at 80x24' },
    );
    tty.assertHealthyScreen(dashForecastNarrow, 80, 24, 'DashboardView 7-day forecast at 80x24');

    tty.send('f');
    const dashMasteryNarrow = await tty.waitFor(
      (s) =>
        (s.includes('掌握度 & FSRS') || s.includes('Mastery & FSRS')) &&
        !s.includes('7 日到期预测') &&
        !s.includes('7-Day Forecast') &&
        s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'DashboardView toggled back to Mastery at 80x24' },
    );
    tty.assertHealthyScreen(dashMasteryNarrow, 80, 24, 'DashboardView Mastery at 80x24');

    // Restore 120x36
    tty.resize(120, 36);
    await tty.waitFor(
      (s) =>
        (s.includes('学习统计与掌握度') || s.includes('Study Analytics & Mastery')) &&
        (s.includes('薄弱点与课程钻取') || s.includes('Weak Topics & Courses')),
      { timeoutMs: 8_000, label: 'DashboardView restored to 120x36' },
    );

    // Navigate drill-down list with j / k and press Enter to launch ReviewView
    tty.send('j');
    await tty.flush();
    tty.assertHealthyScreen(tty.readScreen(), 120, 36, 'DashboardView after j');

    tty.send('k');
    await tty.flush();
    tty.assertHealthyScreen(tty.readScreen(), 120, 36, 'DashboardView after k');

    tty.send('\r');
    const reviewFromDrill = await tty.waitFor(
      (s) =>
        !s.includes('学习统计与掌握度') &&
        !s.includes('Study Analytics & Mastery') &&
        !s.includes('正在加载页面') &&
        !s.includes('当前没有待复习题目') &&
        (s.includes('TeX Raw') || s.includes('Unicode')) &&
        /\b1\/\d+/.test(s),
      { timeoutMs: 10_000, label: 'ReviewView rendered from DashboardView drill-down' },
    );
    tty.assertHealthyScreen(reviewFromDrill, 120, 36, 'ReviewView from DashboardView drill-down');

    // Unmount primary Ink instance before running dedicated --ascii render in Test 3
    inkInstance.unmount();
    inkInstance = null;
    tty.dispose();
    tty = null;
  });

  test('3) IngestModal & DashboardView --ascii Zero-Unicode-Leak Check', async () => {
    const asciiDir = await makeTempDir('ascii');
    const asciiDshHome = join(asciiDir, 'dsh-home');
    const asciiLibRoot = join(asciiDir, 'library');

    await H.saveTuiPreferences({ language: 'zh', asciiMode: true }, { env: { DSH_HOME: asciiDshHome } });

    const asciiHost = await H.createTuiHost({
      env: { DSH_HOME: asciiDshHome },
      home: join(asciiDir, 'home'),
      libraryRoot: asciiLibRoot,
      injectedComplete: createRound18StubComplete(),
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
          initialPage: 'generate',
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

      const genAscii = await asciiTty.waitFor(
        (s) =>
          (s.includes('1. 选择资料') || s.includes('1. Select Materials')) &&
          !s.includes('正在加载页面'),
        { timeoutMs: 10_000, label: 'ASCII GenerateView rendered' },
      );
      asciiTty.assertHealthyScreen(genAscii, 120, 36, 'ASCII GenerateView');
      asciiTty.assertAsciiPure(genAscii, 'ASCII GenerateView');

      // Open IngestModal ('i') -> Tab 1
      asciiTty.send('i');
      const ingestAscii1 = await asciiTty.waitFor(
        (s) =>
          (s.includes('快速录题与批量整理') || s.includes('Quick Capture & Bulk Ingest')) &&
          (s.includes('题干 *') || s.includes('Question *')),
        { timeoutMs: 10_000, label: 'ASCII IngestModal Tab 1 rendered' },
      );
      await asciiTty.flush();
      asciiTty.assertHealthyScreen(ingestAscii1, 120, 36, 'ASCII IngestModal Tab 1');
      asciiTty.assertAsciiPure(ingestAscii1, 'ASCII IngestModal Tab 1');

      // Switch to Tab 2 (Ctrl+T)
      asciiTty.send('\x14');
      const ingestAscii2 = await asciiTty.waitFor(
        (s) => s.includes('粘贴既有题目或试卷错题') || s.includes('Paste Existing Questions'),
        { timeoutMs: 8_000, label: 'ASCII IngestModal Tab 2 rendered' },
      );
      await asciiTty.flush();
      asciiTty.assertHealthyScreen(ingestAscii2, 120, 36, 'ASCII IngestModal Tab 2');
      asciiTty.assertAsciiPure(ingestAscii2, 'ASCII IngestModal Tab 2');

      // Close IngestModal ('Esc')
      asciiTty.send('\x1b');
      await asciiTty.waitFor(
        (s) => !s.includes('快速录题与批量整理') && !s.includes('Quick Capture & Bulk Ingest'),
        { timeoutMs: 8_000, label: 'ASCII IngestModal closed' },
      );

      // Navigate to DashboardView ('6')
      asciiTty.send('6');
      const dashAscii = await asciiTty.waitFor(
        (s) =>
          (s.includes('学习统计与掌握度') || s.includes('Study Analytics & Mastery')) &&
          !s.includes('加载中...') &&
          !s.includes('Loading...') &&
          !s.includes('正在加载页面'),
        { timeoutMs: 10_000, label: 'ASCII DashboardView rendered' },
      );
      await asciiTty.flush();
      asciiTty.assertHealthyScreen(dashAscii, 120, 36, 'ASCII DashboardView');
      asciiTty.assertAsciiPure(dashAscii, 'ASCII DashboardView');

      // Toggle 7-day forecast ('f')
      asciiTty.send('f');
      const dashForecastAscii = await asciiTty.waitFor(
        (s) => s.includes('7 日到期预测') || s.includes('7-Day Forecast'),
        { timeoutMs: 8_000, label: 'ASCII DashboardView 7-day forecast rendered' },
      );
      await asciiTty.flush();
      asciiTty.assertHealthyScreen(dashForecastAscii, 120, 36, 'ASCII DashboardView 7-day forecast');
      asciiTty.assertAsciiPure(dashForecastAscii, 'ASCII DashboardView 7-day forecast');
    } finally {
      await cleanupAscii();
      extraCleanups.pop();
    }
  });
});
