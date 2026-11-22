// Round 72 Track 2: DraftEditor `/` Live Card Filter & `[X]` Atomic Draft Study Sheet Markdown Export
// `node --test --test-concurrency=1 tests/round72-draft-ux.test.mjs`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
assert.ok(H?.saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(R?.displayWidth, 'dist/ must export displayWidth');

// Bundle pure helper formatDraftMarkdown from DraftEditor.tsx for unit tests
const bundleDir = fs.mkdtempSync(join(os.tmpdir(), 'studyhub-r72-draft-'));
const bundleFile = join(bundleDir, 'draft-helper.mjs');
await build({
  stdin: {
    contents: `export { formatDraftMarkdown } from './src/views/generate/DraftEditor.tsx';`,
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
fs.symlinkSync(join(pkgRoot, 'node_modules'), join(bundleDir, 'node_modules'), 'junction');
const { formatDraftMarkdown } = await import(pathToFileURL(bundleFile).href);

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [bundleDir];

async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-r72-${label}-`));
  tempDirs.push(d);
  return d;
}

function todayLocalYmd(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const UNICODE_UI_CHROME_RE = /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u27BF\u2800-\u28FF\u2190-\u21FF\u2022\u2026\u2039\u203A]/g;

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
      await sleep(35);
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
      const w = R.displayWidth(lines[i]);
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

describe('Round 72 Track 2: DraftEditor `/` Live Filter & `[X]` Atomic Markdown Export', () => {
  after(async () => {
    if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = PREV_DSH_HOME;
    await Promise.all(
      tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
    );
  });

  test('1) formatDraftMarkdown unit test (zh & en, MCQ options, cloze, <details>, empty cards)', () => {
    const sampleDraft = {
      id: 'draft-r72-unit',
      title: 'Design Patterns Draft',
      course: 'CS301',
      draftVersion: 3,
      cards: [
        {
          id: 'c1',
          kind: 'quiz',
          topic: 'Memento',
          prompt: 'Which pattern saves state without exposing internals?',
          answer: 'A. Memento',
          hint: 'Think about snapshots.',
          explanation: 'Memento encapsulates state inside an opaque token.',
          options: [
            { id: 'a', text: 'Memento', correct: true },
            { id: 'b', text: 'Bridge', correct: false },
          ],
        },
        {
          id: 'c2',
          kind: 'cloze',
          topic: 'Bridge',
          cloze: {
            text: '{{c1::Bridge}} decouples abstraction from {{c2::implementation}}.',
            answers: [{ id: 'c1', value: 'Bridge' }, { id: 'c2', value: 'implementation' }],
          },
          hint: 'Two independent hierarchies.',
          explanation: 'Avoids Cartesian class explosion.',
        },
      ],
    };

    const zhMd = formatDraftMarkdown({
      draft: sampleDraft,
      cards: sampleDraft.cards,
      lang: 'zh',
      generatedAt: '2026-11-22 10:30',
    });
    assert.ok(zhMd.includes('# Design Patterns Draft'));
    assert.ok(zhMd.includes('**课程**: CS301'));
    assert.ok(zhMd.includes('**生成日期**: 2026-11-22 10:30'));
    assert.ok(zhMd.includes('**题目数量**: 2'));
    assert.ok(zhMd.includes('**草稿版本**: v3'));
    assert.ok(zhMd.includes('## 1. Memento'));
    assert.ok(zhMd.includes('`quiz` `Memento`'));
    assert.ok(zhMd.includes('- **A.** Memento'));
    assert.ok(zhMd.includes('- **B.** Bridge'));
    assert.ok(zhMd.includes('## 2. Bridge'));
    assert.ok(zhMd.includes('{{c1::Bridge}} decouples abstraction from {{c2::implementation}}.'));
    assert.ok(zhMd.includes('<details>\n<summary>参考答案与解析 / Answer & Explanation</summary>'));
    assert.ok(zhMd.includes('**参考答案**: Bridge; implementation'));
    assert.ok(zhMd.includes('**提示**: Think about snapshots.'));
    assert.ok(zhMd.includes('**解析**:\n\nMemento encapsulates state inside an opaque token.'));
    assert.ok(zhMd.includes('</details>'));

    const enMd = formatDraftMarkdown({
      draft: sampleDraft,
      cards: [sampleDraft.cards[0]],
      lang: 'en',
      generatedAt: '2026-11-22 10:30',
    });
    assert.ok(enMd.includes('**Course**: CS301'));
    assert.ok(enMd.includes('**Generated**: 2026-11-22 10:30'));
    assert.ok(enMd.includes('**Cards**: 1'));
    assert.ok(enMd.includes('**Draft Version**: v3'));
    assert.ok(enMd.includes('**Answer**: A. Memento'));
    assert.ok(enMd.includes('**Hint**: Think about snapshots.'));
    assert.ok(enMd.includes('**Explanation**:\n\nMemento encapsulates state inside an opaque token.'));
    assert.ok(!enMd.includes('## 2. Bridge'), 'filtered cards slice should exclude second card');

    const emptyZh = formatDraftMarkdown({
      draft: { id: 'empty-draft', title: 'Empty', cards: [] },
      cards: [],
      lang: 'zh',
      generatedAt: '2026-11-22 10:30',
    });
    assert.ok(emptyZh.includes('**题目数量**: 0'));
    assert.ok(emptyZh.includes('暂无匹配题目'));

    const emptyEn = formatDraftMarkdown({
      draft: { id: 'empty-draft', title: 'Empty', cards: [] },
      cards: [],
      lang: 'en',
      generatedAt: '2026-11-22 10:30',
    });
    assert.ok(emptyEn.includes('**Cards**: 0'));
    assert.ok(emptyEn.includes('No matching draft cards'));
  });

  test('2) PTY E2E (120x36 zh): sample -> GenerateView (3) -> Drafts (Tab) -> / filter -> Enter -> [X] export -> Esc clear (0 model calls)', async () => {
    const boxDir = await makeTempDir('zh');
    const dshHome = join(boxDir, 'dsh-home');
    const libraryRoot = join(boxDir, 'library');
    await mkdir(libraryRoot, { recursive: true });
    process.env.DSH_HOME = dshHome;

    let modelCalls = 0;
    const host = await H.createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(boxDir, 'home'),
      libraryRoot,
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
      injectedComplete: async () => {
        modelCalls += 1;
        return '{}';
      },
    });

    await H.saveTuiPreferences({ language: 'zh', asciiMode: false }, { env: { DSH_HOME: dshHome } });
    const tty = createVirtualTty(120, 36);
    let inkInstance = null;
    try {
      inkInstance = render(
        React.createElement(StudyHubTuiApp, {
          host,
          initialLanguage: 'zh',
          initialAsciiMode: false,
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

      await tty.waitFor((s) => s.includes('载入示例课程体验') || s.includes('Load the sample course'), {
        timeoutMs: 10_000,
        label: 'Launchpad render (zh)',
      });

      // Load sample course
      tty.send('s');
      await tty.waitFor(
        (s) => !s.includes('载入示例课程体验') && s.includes('示例 · Memento 与 Bridge'),
        { timeoutMs: 12_000, label: 'Sample course loaded into Library (zh)' },
      );

      // Navigate to GenerateView ('3') -> Drafts tab ('Tab')
      tty.send('3');
      await tty.waitFor((s) => s.includes('新建出题任务') && s.includes('草稿箱'), {
        timeoutMs: 8_000,
        label: 'GenerateView rendered via 3 (zh)',
      });

      tty.send('\t');
      const draftsScreen = await tty.waitFor(
        (s) => s.includes('示例草稿 · 选对设计模式') && s.includes('3 题') && s.includes('筛选') && s.includes('导出MD'),
        { timeoutMs: 8_000, label: 'DraftEditor loaded in Drafts tab (120x36 zh)' },
      );
      tty.assertHealthyScreen(draftsScreen, 120, 36, 'DraftEditor initial 120x36 zh');
      assert.equal(modelCalls, 0);

      // Press '/' to open live filter bar and filter to card #2 ('svg')
      tty.send('/');
      await tty.waitFor((s) => s.includes('[筛选 3/3]'), {
        timeoutMs: 5_000,
        label: 'Filter bar opened via / (zh)',
      });

      tty.send('svg');
      const liveFilteredScreen = await tty.waitFor(
        (s) => s.includes('[筛选 1/3]') && s.includes('#2 单选') && s.includes('SVG'),
        { timeoutMs: 5_000, label: 'Live filter matched card #2 (zh)' },
      );
      tty.assertHealthyScreen(liveFilteredScreen, 120, 36, 'DraftEditor live filtering 120x36 zh');

      // Press Enter to confirm/blur keeping filter active
      tty.send('\r');
      const confirmedFilterScreen = await tty.waitFor(
        (s) => s.includes('[已筛选 1/3]') && s.includes('#2 单选'),
        { timeoutMs: 5_000, label: 'Filter confirmed via Enter (zh)' },
      );
      tty.assertHealthyScreen(confirmedFilterScreen, 120, 36, 'DraftEditor filter confirmed 120x36 zh');

      // Verify original index mapping on 'e' (should open Edit Card #2, not #1)
      tty.send('e');
      const editModalScreen = await tty.waitFor(
        (s) => s.includes('编辑第 2 题'),
        { timeoutMs: 5_000, label: 'Edit modal targets original card #2 while filtered (zh)' },
      );
      tty.assertHealthyScreen(editModalScreen, 120, 36, 'Edit Card #2 modal 120x36 zh');
      tty.send('\x1b');
      await tty.waitFor(
        (s) => !s.includes('编辑第 2 题') && s.includes('[已筛选 1/3]'),
        { timeoutMs: 5_000, label: 'Closed edit modal back to filtered DraftEditor (zh)' },
      );

      // Press 'X' to export filtered cards atomically to Markdown
      tty.send('X');
      const expectedPath = join(libraryRoot, 'backups', `studyhub-draft-${todayLocalYmd()}.md`);
      const exportedScreen = await tty.waitFor(
        (s) => s.includes('已导出 1 道草稿题'),
        { timeoutMs: 8_000, label: 'Toast shown for [X] draft export (zh)' },
      );
      tty.assertHealthyScreen(exportedScreen, 120, 36, 'DraftEditor after [X] export 120x36 zh');

      const md = await readFile(expectedPath, 'utf8');
      assert.ok(md.includes('示例草稿 · 选对设计模式'), 'markdown should include draft title');
      assert.ok(md.includes('**题目数量**: 1'), 'markdown should export only the 1 filtered card');
      assert.ok(md.includes('SVG'), 'markdown should include filtered card prompt');
      assert.ok(!md.includes('绘图应用'), 'markdown must not include filtered-out cards');
      assert.ok(md.includes('<details>\n<summary>参考答案与解析 / Answer & Explanation</summary>'));
      assert.ok(md.includes('</details>'));

      // Press Esc in normal mode to clear active filter
      tty.send('\x1b');
      const clearedScreen = await tty.waitFor(
        (s) => !s.includes('[已筛选 1/3]') && s.includes('1. [单选]') && s.includes('3 题'),
        { timeoutMs: 5_000, label: 'Esc cleared active filter in normal mode (zh)' },
      );
      tty.assertHealthyScreen(clearedScreen, 120, 36, 'DraftEditor after Esc clear 120x36 zh');
      assert.equal(modelCalls, 0, 'entire filter + export flow must trigger 0 model calls');
    } finally {
      try {
        inkInstance?.unmount();
      } catch {
        // Ignore unmount error
      }
      tty.dispose();
      await host.dispose();
    }
  });

  test('3) PTY E2E (80x24 --ascii en): Drafts -> / filter -> X export -> Esc -> assertHealthyScreen + assertAsciiPure', async () => {
    const boxDir = await makeTempDir('en');
    const dshHome = join(boxDir, 'dsh-home');
    const libraryRoot = join(boxDir, 'library');
    await mkdir(libraryRoot, { recursive: true });
    process.env.DSH_HOME = dshHome;

    let modelCalls = 0;
    const host = await H.createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(boxDir, 'home'),
      libraryRoot,
      skipAutoProbe: true,
      language: 'en',
      eventDebounceMs: 30,
      injectedComplete: async () => {
        modelCalls += 1;
        return '{}';
      },
    });

    const sampleRes = await host.call('sample.load', { language: 'en' });
    assert.equal(sampleRes.ok, true, sampleRes.error?.message);

    await H.saveTuiPreferences({ language: 'en', asciiMode: true }, { env: { DSH_HOME: dshHome } });
    const tty = createVirtualTty(80, 24);
    let inkInstance = null;
    try {
      inkInstance = render(
        React.createElement(StudyHubTuiApp, {
          host,
          initialPage: 'library',
          initialLanguage: 'en',
          initialAsciiMode: true,
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
        (s) => s.includes('Memento') && (s.includes('Library') || s.includes('Sample')),
        { timeoutMs: 10_000, label: 'Initial Library view rendered with EN sample course (80x24 --ascii en)' },
      );

      // Navigate to GenerateView ('3') -> Drafts ('Tab')
      tty.send('3');
      await tty.waitFor((s) => s.includes('New Generation') && s.includes('Drafts'), {
        timeoutMs: 8_000,
        label: 'GenerateView rendered via 3 (80x24 --ascii en)',
      });

      tty.send('\t');
      const draftsScreen = await tty.waitFor(
        (s) => s.includes('Sample draft') && s.includes('3 cards') && s.includes('1. [MCQ]'),
        { timeoutMs: 8_000, label: 'DraftEditor rendered in Drafts tab (80x24 --ascii en)' },
      );
      tty.assertHealthyScreen(draftsScreen, 80, 24, 'DraftEditor 80x24 --ascii en');
      tty.assertAsciiPure(draftsScreen, 'DraftEditor 80x24 --ascii en');

      // Open filter via '/', filter to 'svg', confirm with Enter
      tty.send('/');
      const filterOpenScreen = await tty.waitFor((s) => s.includes('[Filter 3/3]'), {
        timeoutMs: 5_000,
        label: 'Filter bar opened (80x24 --ascii en)',
      });
      tty.assertHealthyScreen(filterOpenScreen, 80, 24, 'DraftEditor filter open 80x24 --ascii en');
      tty.assertAsciiPure(filterOpenScreen, 'DraftEditor filter open 80x24 --ascii en');

      tty.send('svg');
      const filteringScreen = await tty.waitFor(
        (s) => s.includes('[Filter 1/3]') && s.includes('2. [MCQ]'),
        { timeoutMs: 5_000, label: 'Live filter matched card #2 (80x24 --ascii en)' },
      );
      tty.assertHealthyScreen(filteringScreen, 80, 24, 'DraftEditor filtering 80x24 --ascii en');
      tty.assertAsciiPure(filteringScreen, 'DraftEditor filtering 80x24 --ascii en');

      tty.send('\r');
      const filteredScreen = await tty.waitFor(
        (s) => s.includes('[Filtered 1/3]') && s.includes('2. [MCQ]'),
        { timeoutMs: 5_000, label: 'Filter confirmed via Enter (80x24 --ascii en)' },
      );
      tty.assertHealthyScreen(filteredScreen, 80, 24, 'DraftEditor filtered 80x24 --ascii en');
      tty.assertAsciiPure(filteredScreen, 'DraftEditor filtered 80x24 --ascii en');

      // Export filtered card with 'X'
      tty.send('X');
      const expectedPath = join(libraryRoot, 'backups', `studyhub-draft-${todayLocalYmd()}.md`);
      const exportToastScreen = await tty.waitFor(
        (s) => s.includes('Exported 1 draft'),
        { timeoutMs: 8_000, label: 'ASCII-safe export toast shown (80x24 --ascii en)' },
      );
      tty.assertHealthyScreen(exportToastScreen, 80, 24, 'DraftEditor after [X] 80x24 --ascii en');
      tty.assertAsciiPure(exportToastScreen, 'DraftEditor after [X] 80x24 --ascii en');

      const md = await readFile(expectedPath, 'utf8');
      assert.ok(md.includes('**Cards**: 1'));
      assert.ok(md.includes('SVG'));
      assert.ok(md.includes('<details>'));

      // Esc clears filter cleanly
      tty.send('\x1b');
      const clearedScreen = await tty.waitFor(
        (s) => !s.includes('[Filtered 1/3]') && s.includes('1. [MCQ]') && s.includes('3 cards'),
        { timeoutMs: 5_000, label: 'Esc cleared filter (80x24 --ascii en)' },
      );
      tty.assertHealthyScreen(clearedScreen, 80, 24, 'DraftEditor after Esc 80x24 --ascii en');
      tty.assertAsciiPure(clearedScreen, 'DraftEditor after Esc 80x24 --ascii en');
      assert.equal(modelCalls, 0);
    } finally {
      try {
        inkInstance?.unmount();
      } catch {
        // Ignore unmount error
      }
      tty.dispose();
      await host.dispose();
    }
  });
});
