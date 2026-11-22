// Round 66 Track 3: WrongBookView [X] Atomic Markdown Study Sheet Export (0 LLM tokens)
// + HelpOverlay & docs/KEYBINDINGS.md sync:
// `node --test --test-concurrency=1 tests/round66-wrongbook-export.test.mjs`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path, { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import xtermPkg from '@xterm/headless';
import { render } from 'ink';
import React from 'react';

const { Terminal } = xtermPkg;
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const distDir = resolve(pkgRoot, 'dist');

const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const { StudyHubTuiApp } = await import(pathToFileURL(join(distDir, 'App.mjs')).href);

let createTuiHost = null;
let saveTuiPreferences = null;
let displayWidth = null;
let useDistTuiStore = null;
let DEFAULT_PREFERENCES = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('store-') || f.startsWith('chunk-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!createTuiHost && typeof mod.createTuiHost === 'function') createTuiHost = mod.createTuiHost;
    if (!saveTuiPreferences && typeof mod.saveTuiPreferences === 'function') saveTuiPreferences = mod.saveTuiPreferences;
    if (!displayWidth && typeof mod.displayWidth === 'function') displayWidth = mod.displayWidth;
    if (!useDistTuiStore && typeof mod.useTuiStore?.getState === 'function') useDistTuiStore = mod.useTuiStore;
    if (!DEFAULT_PREFERENCES && mod.DEFAULT_PREFERENCES) DEFAULT_PREFERENCES = mod.DEFAULT_PREFERENCES;
  }
}
assert.ok(createTuiHost, 'dist/ must export createTuiHost');
assert.ok(saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(displayWidth, 'dist/ must export displayWidth');
assert.ok(useDistTuiStore, 'dist/ must export useTuiStore');
assert.ok(DEFAULT_PREFERENCES, 'dist/ must export DEFAULT_PREFERENCES');

// Bundle WrongBookView from TypeScript source to unit-test formatWrongBookMarkdown directly
const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyhub-r66-wb-unit-'));
const bundleFile = path.join(bundleDir, 'wrongbook.mjs');
await build({
  stdin: {
    contents: `export { formatWrongBookMarkdown } from './src/views/wrongbook/WrongBookView.tsx';`,
    resolveDir: pkgRoot,
    loader: 'ts',
  },
  outfile: bundleFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  logLevel: 'silent',
  absWorkingDir: pkgRoot,
});
fs.symlinkSync(path.join(pkgRoot, 'node_modules'), path.join(bundleDir, 'node_modules'), 'junction');
const WrongBookMod = await import(pathToFileURL(bundleFile).href);
assert.equal(typeof WrongBookMod.formatWrongBookMarkdown, 'function', 'WrongBookView must export formatWrongBookMarkdown');

function resetDistStore(language = 'zh', asciiMode = false) {
  useDistTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    snapshot: null,
    binding: null,
    desktopConfig: null,
    loading: false,
    refreshing: false,
    toasts: [],
    footerHints: [],
    commandPaletteOpen: false,
    helpOpen: false,
    coursePickerOpen: false,
    inboxOpen: false,
    voicePackOpen: false,
    showLaunchpad: false,
    inputCaptured: false,
    activeRunId: null,
    preferences: {
      ...DEFAULT_PREFERENCES,
      language,
      asciiMode,
    },
  });
}

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [bundleDir];

async function makeTempDir(label) {
  const d = await mkdtemp(join(os.tmpdir(), `studyhub-r66-wb-${label}-`));
  tempDirs.push(d);
  return d;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const UNICODE_UI_CHROME_RE = /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u27BF\u2800-\u28FF\u2190-\u21FF\u2022\u2026\u2039\u203A]/g;

function todayLocalYmd() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

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

  async function waitFor(predicate, { timeoutMs = 10_000, label = 'condition' } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await flush();
      const screen = readScreen();
      if (predicate(screen)) return screen;
      await sleep(30);
    }
    const finalScreen = readScreen();
    throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms.\n--- SCREEN ---\n${finalScreen}\n--------------`);
  }

  function assertHealthyScreen(screen, expectedCols, expectedRows, label) {
    const lines = screen.split('\n');
    assert.ok(lines.length <= expectedRows, `${label}: row count ${lines.length} > ${expectedRows}`);
    assert.ok(!screen.includes('页面渲染异常') && !screen.includes('View Error'), `${label}: error boundary triggered`);
    assert.ok(!screen.includes('TypeError:') && !screen.includes('ReferenceError:'), `${label}: runtime JS error`);
    assert.ok(!/\bNaN\b/.test(screen), `${label}: raw NaN leaked`);
    assert.ok(!/\bundefined\b/.test(screen), `${label}: raw undefined leaked`);
    assert.ok(!screen.includes('[object Object]'), `${label}: raw [object Object] leaked`);
    assert.ok(!screen.includes('\uFFFD'), `${label}: replacement char U+FFFD leaked`);
    assert.ok(!screen.includes('\x1b'), `${label}: unparsed escape sequence leaked`);
    for (let i = 0; i < lines.length; i += 1) {
      const w = displayWidth(lines[i]);
      assert.ok(w <= expectedCols, `${label}: row ${i} width ${w} > ${expectedCols}: ${JSON.stringify(lines[i])}`);
    }
  }

  function assertAsciiPure(screen, label) {
    const matches = screen.match(UNICODE_UI_CHROME_RE);
    assert.ok(!matches, `${label}: leaked non-ASCII UI chrome: ${JSON.stringify([...new Set(matches || [])])}\n${screen}`);
  }

  return {
    stdin,
    stdout,
    stderr,
    firstFramePromise,
    flush,
    readScreen,
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

after(async () => {
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await Promise.all(
    tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
});

describe('Round 66 Track 3: WrongBookView [X] Atomic Markdown Study Sheet Export', () => {
  test('1) Unit: formatWrongBookMarkdown renders bilingual study sheets with numbered prompts, options, mistake counts & <details>', () => {
    const sampleItems = [
      {
        deckId: 'd1',
        deckTitle: 'Design Patterns',
        cardId: 'c1',
        topic: 'Memento Pattern',
        kind: 'quiz',
        prompt: 'Which role stores the internal state snapshot without exposing implementation details?',
        wrongCount: 3,
        errorReason: 'concept',
        options: [
          { id: 'a', text: 'Originator', correct: false },
          { id: 'b', text: 'Memento', correct: true },
          { id: 'c', text: 'Caretaker', correct: false },
        ],
        correctAnswer: 'Memento',
        explanation: 'Memento encapsulates the state snapshot created by Originator; Caretaker only holds it.',
        misconception: 'Confusing Caretaker with Memento.',
      },
      {
        deckId: 'd2',
        deckTitle: 'Linear Algebra',
        cardId: 'c2',
        topic: 'Eigenvalues',
        kind: 'open',
        prompt: 'Explain why similar matrices share the same characteristic polynomial.',
        wrongCount: 2,
        detail: {
          deckId: 'd2',
          cardId: 'c2',
          correctAnswer: 'det(P^-1 A P - lambda I) = det(P^-1 (A - lambda I) P) = det(A - lambda I)',
          explanation: 'Determinant is multiplicative and det(P^-1) * det(P) = 1.',
        },
      },
    ];

    const zhMd = WrongBookMod.formatWrongBookMarkdown({
      items: sampleItems,
      course: '软件工程与代数',
      lang: 'zh',
      generatedAt: '2026-11-22 21:00',
    });
    assert.ok(zhMd.includes('# 错题复习卷'), 'zh header title missing');
    assert.ok(zhMd.includes('2026-11-22 21:00'), 'zh date missing');
    assert.ok(zhMd.includes('软件工程与代数'), 'zh course filter missing');
    assert.ok(zhMd.includes('**错题数量**: 2'), 'zh card count missing');
    assert.ok(zhMd.includes('## 1. Memento Pattern'), 'numbered heading 1 missing');
    assert.ok(zhMd.includes('## 2. Eigenvalues'), 'numbered heading 2 missing');
    assert.ok(zhMd.includes('出错次数: 3'), 'mistake count 3 missing');
    assert.ok(zhMd.includes('出错次数: 2'), 'mistake count 2 missing');
    assert.ok(zhMd.includes('Which role stores the internal state snapshot'), 'prompt 1 missing');
    assert.ok(zhMd.includes('- **A.** Originator') && zhMd.includes('- **B.** Memento'), 'options missing');
    assert.ok(zhMd.includes('<details>'), '<details> block missing');
    assert.ok(zhMd.includes('<summary>参考答案与解析 / Answer & Explanation</summary>'), '<summary> missing');
    assert.ok(zhMd.includes('**参考答案**: Memento'), 'reference answer 1 missing');
    assert.ok(zhMd.includes('Memento encapsulates the state snapshot'), 'explanation 1 missing');
    assert.ok(zhMd.includes('Confusing Caretaker with Memento.'), 'misconception 1 missing');
    assert.ok(zhMd.includes('det(P^-1 A P - lambda I)'), 'reference answer 2 missing');
    assert.ok(zhMd.includes('</details>'), '</details> closing tag missing');

    const enMd = WrongBookMod.formatWrongBookMarkdown({
      items: sampleItems,
      course: null,
      lang: 'en',
      generatedAt: new Date(2026, 10, 22, 9, 5),
    });
    assert.ok(enMd.includes('# Wrong-Book Study Sheet'), 'en header title missing');
    assert.ok(enMd.includes('2026-11-22 09:05'), 'en formatted Date missing');
    assert.ok(enMd.includes('All Courses'), 'en all-courses fallback missing');
    assert.ok(enMd.includes('**Cards**: 2'), 'en card count missing');
    assert.ok(enMd.includes('Mistakes: 3'), 'en mistake count 3 missing');
    assert.ok(enMd.includes('<summary>参考答案与解析 / Answer & Explanation</summary>'), 'en <summary> missing');
    assert.ok(enMd.includes('**Reference Answer**: Memento'), 'en reference answer missing');
    assert.ok(enMd.includes('**Explanation**:'), 'en explanation heading missing');

    const emptyMd = WrongBookMod.formatWrongBookMarkdown({
      items: [],
      course: null,
      lang: 'en',
      generatedAt: '2026-11-22 10:00',
    });
    assert.ok(emptyMd.includes('**Cards**: 0'));
    assert.ok(emptyMd.includes('No wrong cards to export'));
  });

  test('2) @xterm/headless PTY E2E (120x36 zh): load sample -> answer 1 card wrong in review -> WrongBook (4) -> [X] exports studyhub-wrongbook-*.md (0 model calls)', async () => {
    const base = await makeTempDir('pty-zh');
    const dshHome = join(base, 'dsh-home');
    const libraryRoot = join(base, 'library');
    process.env.DSH_HOME = dshHome;

    await saveTuiPreferences(
      { language: 'zh', asciiMode: false, theme: 'dsh-dark', mathUnicode: true, showHints: true },
      { env: { ...process.env, DSH_HOME: dshHome } },
    );

    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot,
      env: { ...process.env, DSH_HOME: dshHome },
      home: join(base, 'home'),
      documentsDir: base,
      skipAutoProbe: true,
      injectedComplete: async () => {
        modelCalls += 1;
        return 'Stub';
      },
      language: 'zh',
      eventDebounceMs: 30,
    });

    const tty = createVirtualTty(120, 36);
    let inkInst = null;
    try {
      resetDistStore('zh', false);
      inkInst = render(
        React.createElement(StudyHubTuiApp, {
          host,
          initialPage: 'library',
          initialLanguage: 'zh',
          initialAsciiMode: false,
          autoLaunchpad: true,
          onExit: () => inkInst?.unmount(),
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
      await tty.waitFor((s) => s.includes('载入示例课程体验'), { label: 'zh Launchpad' });

      // Load sample course via 's'
      tty.send('s');
      await tty.waitFor(
        (s) => !s.includes('载入示例课程体验') && s.includes('示例 · Memento 与 Bridge'),
        { timeoutMs: 12_000, label: 'zh sample loaded' },
      );

      // Start a fresh review round on the selected sample deck via Enter, then answer 1 card wrong
      await sleep(200);
      await tty.flush();
      tty.send('\r');
      await tty.waitFor(
        (s) =>
          useDistTuiStore.getState().page === 'review' &&
          Boolean(useDistTuiStore.getState().activeRunId) &&
          !s.includes('正在加载练习') &&
          s.includes('1/9'),
        { timeoutMs: 10_000, label: 'Fresh review round started via Enter' },
      );
      const activeRunId = useDistTuiStore.getState().activeRunId;
      const runInfo = await host.call('review.get', { runId: activeRunId });
      assert.equal(runInfo.ok, true, runInfo.error?.message);
      const card = runInfo.value?.card;
      assert.ok(card?.id, 'active review run must have a card');

      if (card.kind === 'quiz' && Array.isArray(card.options) && card.options.length > 0) {
        const wrongIdx = card.options.findIndex((o) => !o.correct);
        const pick = wrongIdx >= 0 ? wrongIdx + 1 : 1;
        tty.send(String(pick));
        await tty.waitFor(
          (s) => s.includes('下一题') || s.includes('错因') || s.includes('参考答案') || s.includes('解析'),
          { timeoutMs: 6_000, label: 'MCQ wrong answer feedback' },
        );
      } else if (card.kind === 'truefalse') {
        const wrongKey = String(card.answer).toLowerCase() === 'true' ? '2' : '1';
        tty.send(wrongKey);
        await tty.waitFor(
          (s) => s.includes('下一题') || s.includes('参考答案') || s.includes('解析'),
          { timeoutMs: 6_000, label: 'TF wrong answer feedback' },
        );
      } else {
        // flashcard / self-graded card: flip then rate 1 (wrong)
        tty.send(' ');
        await tty.waitFor(
          (s) => !s.includes('翻开答案') && (s.includes('0') || s.includes('评分') || s.includes('参考答案')),
          { timeoutMs: 6_000, label: 'Flashcard flipped for rating' },
        );
        tty.send('1');
        await tty.waitFor(
          (s) => s.includes('回答有误') || s.includes('下一题') || s.includes('2/9'),
          { timeoutMs: 6_000, label: 'Flashcard rated 1 (wrong) and recorded' },
        );
      }

      // End round cleanly ('q' -> 'y')
      tty.send('q');
      await tty.waitFor((s) => s.includes('结束本轮练习'), { timeoutMs: 6_000, label: 'End round dialog' });
      tty.send('y');
      await tty.waitFor((s) => !s.includes('结束本轮练习'), { timeoutMs: 6_000, label: 'Exited review round' });

      // Navigate to WrongBook ('4')
      tty.send('4');
      const wbScreen = await tty.waitFor(
        (s) => s.includes('错题列表') && !s.includes('正在加载错题本') && s.includes('导出错题'),
        { timeoutMs: 10_000, label: 'zh WrongBookView with X hint' },
      );
      tty.assertHealthyScreen(wbScreen, 120, 36, 'zh WrongBookView 120x36');

      const wbRes = await host.call('wrongbook', { course: '*', view: 'weak', offset: 0, limit: 20 });
      assert.equal(wbRes.ok, true);
      assert.ok((wbRes.value?.items?.length ?? 0) >= 1, 'WrongBook must have >= 1 item');
      const firstPromptSnippet = String(wbRes.value.items[0].prompt || '').trim().slice(0, 18);

      // Press 'X' to export Wrong-Book Markdown study sheet atomically
      const expectedPath = join(libraryRoot, 'backups', `studyhub-wrongbook-${todayLocalYmd()}.md`);
      tty.send('X');
      const afterExport = await tty.waitFor(
        (s) =>
          fs.existsSync(expectedPath) &&
          useDistTuiStore
            .getState()
            .toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已导出') && toast.text.includes(expectedPath)) &&
          s.includes('已导出'),
        { timeoutMs: 10_000, label: 'zh WrongBook [X] export toast & file on disk' },
      );
      tty.assertHealthyScreen(afterExport, 120, 36, 'zh WrongBookView after [X] export');

      const exportedMd = await readFile(expectedPath, 'utf8');
      assert.ok(exportedMd.includes('# 错题复习卷'), 'exported MD must have zh title');
      assert.ok(exportedMd.includes('<details>'), 'exported MD must contain <details>');
      assert.ok(exportedMd.includes('<summary>参考答案与解析 / Answer & Explanation</summary>'), 'exported MD must contain <summary>');
      assert.ok(exportedMd.includes('</details>'), 'exported MD must contain </details>');
      if (firstPromptSnippet) {
        assert.ok(exportedMd.includes(firstPromptSnippet), `exported MD must include question prompt "${firstPromptSnippet}"`);
      }
      assert.equal(modelCalls, 0, 'WrongBook export must invoke 0 model calls');
    } finally {
      try {
        inkInst?.unmount();
      } catch {
        // ignore
      }
      await host.dispose();
      tty.dispose();
    }
  });

  test('3) @xterm/headless PTY E2E (80x24 --ascii en): WrongBook (4) -> [X] export -> assertHealthyScreen + assertAsciiPure + valid .md', async () => {
    const base = await makeTempDir('pty-ascii-en');
    const dshHome = join(base, 'dsh-home');
    const libraryRoot = join(base, 'library');
    process.env.DSH_HOME = dshHome;

    await saveTuiPreferences(
      { language: 'en', asciiMode: true, theme: 'dsh-dark', mathUnicode: false, showHints: true },
      { env: { ...process.env, DSH_HOME: dshHome } },
    );

    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot,
      env: { ...process.env, DSH_HOME: dshHome },
      home: join(base, 'home'),
      documentsDir: base,
      skipAutoProbe: true,
      injectedComplete: async () => {
        modelCalls += 1;
        return 'Stub';
      },
      language: 'en',
      eventDebounceMs: 30,
    });

    const tty = createVirtualTty(80, 24);
    let inkInst = null;
    try {
      resetDistStore('en', true);
      inkInst = render(
        React.createElement(StudyHubTuiApp, {
          host,
          initialPage: 'library',
          initialLanguage: 'en',
          initialAsciiMode: true,
          autoLaunchpad: true,
          onExit: () => inkInst?.unmount(),
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
      await tty.waitFor((s) => s.includes('Load the sample course'), { label: 'en Launchpad' });

      tty.send('s');
      await tty.waitFor(
        (s) => !s.includes('Load the sample course') && s.includes('Memento'),
        { timeoutMs: 12_000, label: 'en sample loaded' },
      );

      tty.send('4');
      const wbScreen = await tty.waitFor(
        (s) => s.includes('Mistakes') && !s.includes('Loading mistakes'),
        { timeoutMs: 10_000, label: 'en WrongBookView 80x24' },
      );
      tty.assertHealthyScreen(wbScreen, 80, 24, 'en WrongBookView 80x24');
      tty.assertAsciiPure(wbScreen, 'en WrongBookView 80x24');

      const expectedPath = join(libraryRoot, 'backups', `studyhub-wrongbook-${todayLocalYmd()}.md`);
      tty.send('X');
      const afterExport = await tty.waitFor(
        () =>
          fs.existsSync(expectedPath) &&
          useDistTuiStore
            .getState()
            .toasts.some(
              (toast) =>
                toast.tone === 'success' &&
                toast.text.includes('Exported') &&
                toast.text.includes('wrong card(s) ->') &&
                toast.text.includes(expectedPath),
            ),
        { timeoutMs: 10_000, label: 'en WrongBook [X] export toast & file on disk' },
      );
      tty.assertHealthyScreen(afterExport, 80, 24, 'en WrongBookView after [X] export 80x24');
      tty.assertAsciiPure(afterExport, 'en WrongBookView after [X] export 80x24');

      const exportedMd = await readFile(expectedPath, 'utf8');
      assert.ok(exportedMd.includes('# Wrong-Book Study Sheet'), 'exported MD must have en title');
      assert.ok(exportedMd.includes('## 1.'), 'exported MD must have numbered question');
      assert.ok(exportedMd.includes('<details>'), 'exported MD must contain <details>');
      assert.ok(exportedMd.includes('<summary>参考答案与解析 / Answer & Explanation</summary>'), 'exported MD must contain <summary>');
      assert.ok(exportedMd.includes('</details>'), 'exported MD must contain </details>');
      assert.equal(modelCalls, 0, 'WrongBook export must invoke 0 model calls');
    } finally {
      try {
        inkInst?.unmount();
      } catch {
        // ignore
      }
      await host.dispose();
      tty.dispose();
    }
  });
});
