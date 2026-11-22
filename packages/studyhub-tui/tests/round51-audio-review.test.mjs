// Round 51 AudioView Transcript Corrections Review (audio.corrections.review behind P2 ConfirmDialog)
// + Pending-Corrections Inspection integration & @xterm/headless E2E tests:
// node --test tests/round51-audio-review.test.mjs
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import xtermPkg from '@xterm/headless';
import { render } from 'ink';
import React from 'react';
import { register } from 'tsx/esm/api';
import { StudyService } from '../../../lib/service.js';

const unregisterTsx = register();

const { Terminal } = xtermPkg;
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const distDir = resolve(pkgRoot, 'dist');

const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const { StudyHubTuiApp } = await import(pathToFileURL(join(distDir, 'App.mjs')).href);

let H = null;
let displayWidth = null;
let useTuiStore = null;
let DEFAULT_PREFERENCES = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('store-') || f.startsWith('chunk-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (
      !H &&
      (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('chunk-')) &&
      typeof mod.createTuiHost === 'function' &&
      typeof mod.saveTuiPreferences === 'function'
    ) {
      H = mod;
    }
    if (!displayWidth && typeof mod.displayWidth === 'function') displayWidth = mod.displayWidth;
    if (!useTuiStore && typeof mod.useTuiStore?.getState === 'function') useTuiStore = mod.useTuiStore;
    if (!DEFAULT_PREFERENCES && mod.DEFAULT_PREFERENCES) DEFAULT_PREFERENCES = mod.DEFAULT_PREFERENCES;
  }
}
assert.ok(H, 'dist/ must export createTuiHost and saveTuiPreferences');
assert.ok(displayWidth, 'dist/ must export displayWidth');
assert.ok(useTuiStore, 'dist/ must export useTuiStore');
assert.ok(DEFAULT_PREFERENCES, 'dist/ must export DEFAULT_PREFERENCES');

const { createTuiHost, saveTuiPreferences } = H;
const { countPendingCorrections } = await import('../src/views/audio/AudioView.tsx');

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round51-${label}-`));
  tempDirs.push(d);
  return d;
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

function resetTuiStore(language = 'zh', asciiMode = false) {
  useTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    snapshot: null,
    binding: null,
    config: null,
    loading: true,
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

async function seedAudioTranscript(libraryRoot, { id, title, text, applied = [], skipped = [] }) {
  const service = new StudyService(libraryRoot);
  try {
    await service.call('snapshot');
    const record = {
      id,
      title,
      text,
      courses: ['CS101'],
      audio: {
        sourceIds: [id],
        corrections: {
          applied,
          appliedCount: applied.length,
          skipped,
          skippedCount: skipped.length,
        },
      },
    };
    await service.store.update((state) => {
      state.sources = [...(state.sources || []).filter((s) => s.id !== id), structuredClone(record)];
      state.audioResults = [...(state.audioResults || []).filter((r) => r.id !== id), structuredClone(record)];
    });
    return record;
  } finally {
    service.dispose();
  }
}

after(async () => {
  unregisterTsx?.();
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

describe('Round 51: AudioView transcript corrections inspection & AI review confirmation', () => {
  test('1) createTuiHost integration & countPendingCorrections unit logic: 0 pending refuses cleanly with 0 model calls', async () => {
    // 1a. Pure helper unit checks
    assert.deepEqual(countPendingCorrections(null), { pending: 0, applied: 0, items: [] });
    assert.deepEqual(countPendingCorrections({ id: 'plain-1' }), { pending: 0, applied: 0, items: [] });

    const directSummary = countPendingCorrections({
      id: 'talk-u1',
      audio: {
        corrections: {
          applied: [
            { wrong: 'over fit', right: 'overfit', context: 'Avoid over fit.' },
            { wrong: 'bias term', right: 'bias term', context: 'Add bias term.' },
          ],
          skipped: [
            {
              wrong: 'gradient decent',
              right: 'gradient descent',
              reason: '同音术语',
              context: 'Use gradient decent to optimize.',
              skipped: 'low-confidence',
            },
            {
              wrong: 'already reviewed',
              right: 'reviewed term',
              context: 'Context',
              skipped: 'low-confidence',
              review: { at: '2026-11-22T00:00:00.000Z', verdict: 'unsure', reason: 'Unclear' },
            },
            {
              wrong: 'ambiguous phrase',
              right: 'other phrase',
              context: 'Context',
              skipped: 'not-found',
            },
          ],
        },
      },
    });
    assert.equal(directSummary.applied, 2);
    assert.equal(directSummary.pending, 1);
    assert.deepEqual(directSummary.items, [
      {
        wrong: 'gradient decent',
        right: 'gradient descent',
        reason: '同音术语',
        context: 'Use gradient decent to optimize.',
      },
    ]);

    // 1b. Snapshot source lookup by sourceId || id
    const lookupSummary = countPendingCorrections(
      { id: 'res-1', sourceId: 'src-audio-1' },
      [
        {
          id: 'src-audio-1',
          audio: {
            corrections: {
              applied: [{ wrong: 'a', right: 'b' }],
              skipped: [
                { wrong: 'kernet', right: 'kernel', reason: '拼写', skipped: 'low-confidence' },
                { wrong: 'epoc', right: 'epoch', skipped: 'low-confidence' },
              ],
            },
          },
        },
      ],
    );
    assert.equal(lookupSummary.applied, 1);
    assert.equal(lookupSummary.pending, 2);
    assert.equal(lookupSummary.items[0].wrong, 'kernet');
    assert.equal(lookupSummary.items[1].right, 'epoch');

    // 1c. Host integration: 0 pending corrections returns normalized error with 0 model calls
    const base = await makeTempDir('host');
    const dshHome = join(base, 'dsh-home');
    const libraryRoot = join(base, 'library');
    await mkdir(libraryRoot, { recursive: true });
    process.env.DSH_HOME = dshHome;

    await seedAudioTranscript(libraryRoot, {
      id: 'talk-zero',
      title: 'Lecture Zero Pending',
      text: 'This lecture transcript already has all corrections reviewed.',
      applied: [{ wrong: 'neural net', right: 'neural network', context: 'A neural net.' }],
      skipped: [
        {
          wrong: 'layer norm',
          right: 'LayerNorm',
          context: 'Use layer norm here.',
          skipped: 'low-confidence',
          review: { at: '2026-11-22T00:00:00.000Z', verdict: 'reject', reason: 'Original is fine' },
        },
      ],
    });

    let aiCalls = 0;
    const host = await createTuiHost({
      libraryRoot,
      env: { DSH_HOME: dshHome },
      home: base,
      documentsDir: base,
      injectedComplete: async () => {
        aiCalls += 1;
        return '{"decisions":[]}';
      },
      skipAutoProbe: true,
      language: 'zh',
    });

    try {
      const reviewRes = await host.call('audio.corrections.review', { sourceId: 'talk-zero' });
      assert.equal(reviewRes.ok, false, 'audio.corrections.review must fail when pending === 0');
      assert.ok(
        String(reviewRes.error?.message || '').includes('没有待复核的存疑处'),
        `Expected normalized error mentioning 没有待复核的存疑处, got: ${reviewRes.error?.message}`,
      );
      assert.equal(aiCalls, 0, 'audio.corrections.review with 0 pending must make 0 model calls');
    } finally {
      await host.dispose();
    }
  });

  test('2) PTY E2E (120x36 & 80x24, default zh & --ascii en): pending badge/samples, [c] opens ConfirmDialog, [n] cancels with 0 model calls', async () => {
    const base = await makeTempDir('pty');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');
    await mkdir(libraryRoot, { recursive: true });

    await seedAudioTranscript(libraryRoot, {
      id: 'talk-review',
      title: 'ML Lecture 04',
      text: 'Gradient decent updates weights. Back prop computes gradients efficiently.',
      applied: [{ wrong: 'hyper param', right: 'hyperparameter', context: 'Tune hyper param.' }],
      skipped: [
        {
          wrong: 'gradient decent',
          right: 'gradient descent',
          reason: '术语拼写',
          context: 'Gradient decent updates weights.',
          confidence: 'low',
          skipped: 'low-confidence',
        },
        {
          wrong: 'back prop',
          right: 'backpropagation',
          reason: '全称还原',
          context: 'Back prop computes gradients efficiently.',
          confidence: 'low',
          skipped: 'low-confidence',
        },
      ],
    });

    let aiCalls = 0;
    const trackingComplete = async () => {
      aiCalls += 1;
      return '{"decisions":[]}';
    };

    // Pass A: default zh at 120x36, plus resize check at 80x24
    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
    resetTuiStore('zh', false);

    let host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      injectedComplete: trackingComplete,
      skipAutoProbe: true,
      language: 'zh',
    });

    const tty = createVirtualTty(120, 36);
    let inkInstance = null;
    try {
      inkInstance = render(
        React.createElement(StudyHubTuiApp, {
          host,
          initialPage: 'audio',
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

      const zhWide = await tty.waitFor(
        (s) =>
          s.includes('ML Lecture 04') &&
          s.includes('2 处存疑待复核') &&
          s.includes('gradient decent -> gradient descent'),
        { label: 'AudioView zh 120x36 renders pending badge and sample corrections' },
      );
      tty.assertHealthyScreen(zhWide, 120, 36, 'AudioView zh 120x36');
      assert.equal(aiCalls, 0, 'Rendering pending corrections must make 0 model calls');

      // Press [c] -> P2 ConfirmDialog opens
      tty.send('c');
      const zhConfirm = await tty.waitFor(
        (s) =>
          s.includes('AI 复核转写存疑处') &&
          s.includes('取消 (n)') &&
          s.includes('开始复核 (y)') &&
          s.includes('复核 2') &&
          s.includes('处存疑项'),
        { label: 'ConfirmDialog opened via [c] in zh 120x36' },
      );
      tty.assertHealthyScreen(zhConfirm, 120, 36, 'AudioView ConfirmDialog zh 120x36');
      assert.equal(useTuiStore.getState().inputCaptured, true, 'ConfirmDialog must capture input');
      assert.equal(aiCalls, 0, 'Opening ConfirmDialog must make 0 model calls');

      // Press [n] -> cancels cleanly back to AudioView with 0 model calls
      tty.send('n');
      const zhCancelled = await tty.waitFor(
        (s) =>
          !s.includes('AI 复核转写存疑处') &&
          s.includes('2 处存疑待复核') &&
          useTuiStore.getState().inputCaptured === false,
        { label: 'ConfirmDialog cancelled via [n] in zh 120x36' },
      );
      tty.assertHealthyScreen(zhCancelled, 120, 36, 'AudioView after [n] cancel zh 120x36');
      assert.equal(aiCalls, 0, 'Cancelling ConfirmDialog with [n] must make 0 model calls');

      // Resize to 80x24 default zh (narrow SplitPane shows left list + [c] ConfirmDialog still works cleanly)
      tty.resize(80, 24);
      const zhNarrow = await tty.waitFor(
        (s) =>
          s.includes('已完成转写稿') &&
          s.includes('ML Lecture 04') &&
          s.split('\n').length <= 24,
        { label: 'AudioView zh 80x24' },
      );
      tty.assertHealthyScreen(zhNarrow, 80, 24, 'AudioView zh 80x24');

      inkInstance.unmount();
      inkInstance = null;
      tty.dispose();
      await host.dispose();
      host = null;

      // Pass B: --ascii en across 120x36 and 80x24
      for (const pass of [
        { cols: 120, rows: 36 },
        { cols: 80, rows: 24 },
      ]) {
        await saveTuiPreferences({ language: 'en', asciiMode: true }, { env });
        resetTuiStore('en', true);
        host = await createTuiHost({
          libraryRoot,
          env,
          home: base,
          documentsDir: base,
          injectedComplete: trackingComplete,
          skipAutoProbe: true,
          language: 'en',
        });
        const asciiTty = createVirtualTty(pass.cols, pass.rows);
        try {
          inkInstance = render(
            React.createElement(StudyHubTuiApp, {
              host,
              initialPage: 'audio',
              initialLanguage: 'en',
              initialAsciiMode: true,
              autoLaunchpad: false,
              onExit: () => inkInstance?.unmount(),
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

          const asciiMain = await asciiTty.waitFor(
            (s) =>
              pass.cols >= 120
                ? s.includes('2 uncertain') && s.includes('gradient decent -> gradient descent')
                : s.includes('Completed Transcripts') && s.includes('ML Lecture 04'),
            { label: `AudioView --ascii en ${pass.cols}x${pass.rows}` },
          );
          asciiTty.assertHealthyScreen(asciiMain, pass.cols, pass.rows, `AudioView --ascii en ${pass.cols}x${pass.rows}`);
          asciiTty.assertAsciiPure(asciiMain, `AudioView --ascii en ${pass.cols}x${pass.rows}`);
          assert.equal(aiCalls, 0);

          asciiTty.send('c');
          const asciiConfirm = await asciiTty.waitFor(
            (s) =>
              s.includes('AI Review Uncertain Corrections') &&
              s.includes('Cancel (n)') &&
              s.includes('Start Review (y)') &&
              s.includes('2 uncertain'),
            { label: `ConfirmDialog --ascii en ${pass.cols}x${pass.rows}` },
          );
          asciiTty.assertHealthyScreen(asciiConfirm, pass.cols, pass.rows, `ConfirmDialog --ascii en ${pass.cols}x${pass.rows}`);
          asciiTty.assertAsciiPure(asciiConfirm, `ConfirmDialog --ascii en ${pass.cols}x${pass.rows}`);
          assert.equal(aiCalls, 0, 'Opening ConfirmDialog in --ascii en must make 0 model calls');

          asciiTty.send('n');
          const asciiCancelled = await asciiTty.waitFor(
            (s) =>
              !s.includes('AI Review Uncertain Corrections') &&
              (pass.cols >= 120 ? s.includes('2 uncertain') : s.includes('ML Lecture 04')) &&
              useTuiStore.getState().inputCaptured === false,
            { label: `ConfirmDialog cancelled --ascii en ${pass.cols}x${pass.rows}` },
          );
          asciiTty.assertHealthyScreen(asciiCancelled, pass.cols, pass.rows, `AudioView cancel --ascii en ${pass.cols}x${pass.rows}`);
          asciiTty.assertAsciiPure(asciiCancelled, `AudioView cancel --ascii en ${pass.cols}x${pass.rows}`);
          assert.equal(aiCalls, 0, 'Cancelling ConfirmDialog in --ascii en must make 0 model calls');
        } finally {
          inkInstance?.unmount();
          inkInstance = null;
          asciiTty.dispose();
          await host.dispose();
          host = null;
        }
      }
    } finally {
      inkInstance?.unmount();
      tty.dispose();
      await host?.dispose();
    }
  });
});
