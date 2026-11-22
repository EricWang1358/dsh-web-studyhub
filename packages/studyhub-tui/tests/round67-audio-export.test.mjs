// Round 67 Track 2: AudioView [/] Live Filter & [x] Atomic Audio Transcript Markdown Export (0 LLM tokens)
// `node --test --test-concurrency=1 tests/round67-audio-export.test.mjs`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path, { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import xtermPkg from '@xterm/headless';
import { render } from 'ink';
import React from 'react';
import { StudyService } from '../../../lib/service.js';

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

// Bundle AudioView from TypeScript source to unit-test formatAudioTranscriptMarkdown directly
const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyhub-r67-audio-unit-'));
const bundleFile = path.join(bundleDir, 'audio-view.mjs');
await build({
  stdin: {
    contents: `export { formatAudioTranscriptMarkdown } from './src/views/audio/AudioView.tsx';`,
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
const AudioMod = await import(pathToFileURL(bundleFile).href);
assert.equal(
  typeof AudioMod.formatAudioTranscriptMarkdown,
  'function',
  'AudioView must export formatAudioTranscriptMarkdown',
);

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
  const d = await mkdtemp(join(os.tmpdir(), `studyhub-r67-audio-${label}-`));
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

async function seedAudioTranscripts(libraryRoot, records) {
  const service = new StudyService(libraryRoot);
  try {
    await service.call('snapshot');
    await service.store.update((state) => {
      state.courses = [...(state.courses || [])];
      for (const rec of records) {
        for (const c of rec.courses || []) {
          if (!state.courses.some((x) => x.name === c)) {
            state.courses.push({ name: c, createdAt: '2026-11-22T00:00:00.000Z' });
          }
        }
        state.sources = [...(state.sources || []).filter((s) => s.id !== rec.id), structuredClone(rec)];
        state.audioResults = [...(state.audioResults || []).filter((r) => r.id !== rec.id), structuredClone(rec)];
      }
    });
  } finally {
    await service.dispose();
  }
}

after(async () => {
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await Promise.all(
    tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
});

describe('Round 67 Track 2: AudioView [/] Filter & [x] Atomic Transcript Markdown Export', () => {
  test('1) Unit: formatAudioTranscriptMarkdown handles zh/en, [MM:SS] segments, plain fallback & pending corrections', () => {
    const segmentedResult = {
      id: 'aud-seg-1',
      title: 'Operating Systems Week 3',
      courses: ['CS301'],
      fileName: 'os-week3.m4a',
      durationSec: 125,
      provider: 'siliconflow',
      language: 'zh-CN',
      createdAt: '2026-11-20T10:00:00Z',
    };
    const segmentedDetail = {
      id: 'aud-seg-1',
      segments: [
        { start: 0, speaker: 'Prof', text: 'Welcome to virtual memory.' },
        { startSec: 65, text: 'Page tables map virtual pages to physical frames.' },
      ],
      audio: {
        corrections: {
          applied: [{ wrong: 'TLP', right: 'TLB' }],
          appliedCount: 1,
          skipped: [
            {
              wrong: 'page faulted',
              right: 'page fault',
              reason: '术语拼写',
              context: 'A page faulted occurs on miss.',
              skipped: 'low-confidence',
            },
            {
              wrong: 'resolved-term',
              right: 'kept',
              skipped: 'low-confidence',
              review: { decision: 'keep' },
            },
          ],
        },
      },
    };

    const mdZh = AudioMod.formatAudioTranscriptMarkdown({
      result: segmentedResult,
      detail: segmentedDetail,
      lang: 'zh',
      generatedAt: '2026-11-22 21:30',
    });
    assert.match(mdZh, /^# Operating Systems Week 3/m);
    assert.match(mdZh, /- 导出时间: 2026-11-22 21:30/);
    assert.match(mdZh, /- 课程: CS301/);
    assert.match(mdZh, /- 文件: os-week3\.m4a/);
    assert.match(mdZh, /- 时长: 02:05/);
    assert.match(mdZh, /- 转写服务: siliconflow/);
    assert.match(mdZh, /- 语言: zh-CN/);
    assert.match(mdZh, /\[00:00\] Prof: Welcome to virtual memory\./);
    assert.match(mdZh, /\[01:05\] Page tables map virtual pages to physical frames\./);
    assert.match(mdZh, /## 待复核存疑处 \(1\)/);
    assert.match(mdZh, /\*\*page faulted\*\* -> \*\*page fault\*\* \(术语拼写\) -- "A page faulted occurs on miss\."/);
    assert.ok(!mdZh.includes('resolved-term'), 'already-reviewed correction must not be listed as pending');

    const mdEnPlain = AudioMod.formatAudioTranscriptMarkdown({
      result: {
        id: 'aud-plain-2',
        title: 'Linear Algebra Recap',
        course: 'MATH202',
        transcript: 'Eigenvalues satisfy det(A - lambda I) = 0.',
        durationSec: 42,
        provider: 'groq',
        language: 'en',
      },
      detail: null,
      lang: 'en',
      generatedAt: '2026-11-22 21:35',
    });
    assert.match(mdEnPlain, /^# Linear Algebra Recap/m);
    assert.match(mdEnPlain, /- Exported: 2026-11-22 21:35/);
    assert.match(mdEnPlain, /- Course: MATH202/);
    assert.match(mdEnPlain, /- Duration: 00:42/);
    assert.match(mdEnPlain, /- Provider: groq/);
    assert.match(mdEnPlain, /- Language: en/);
    assert.match(mdEnPlain, /## Transcript/);
    assert.match(mdEnPlain, /Eigenvalues satisfy det\(A - lambda I\) = 0\./);
    assert.ok(!mdEnPlain.includes('Pending Uncertain Corrections'));
  });

  test('2) PTY E2E (120x36 zh): navigate via [a], [/] live filter + Enter, [x] atomic MD export with 0 model calls', async () => {
    const base = await makeTempDir('zh');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');
    await mkdir(libraryRoot, { recursive: true });

    await seedAudioTranscripts(libraryRoot, [
      {
        id: 'aud-r67-1',
        title: 'Compilers Lecture 01',
        fileName: 'compilers-01.mp3',
        courses: ['CS401'],
        durationSec: 185,
        provider: 'siliconflow',
        language: 'zh-CN',
        text: 'Lexical analysis converts character streams into tokens.',
        segments: [
          { start: 0, text: 'Lexical analysis converts character streams into tokens.' },
          { start: 75, text: 'Deterministic finite automata recognize regular languages.' },
        ],
        audio: {
          sourceIds: ['aud-r67-1'],
          corrections: {
            applied: [],
            appliedCount: 0,
            skipped: [
              {
                wrong: 'finite automoton',
                right: 'finite automaton',
                reason: '拼写校正',
                context: 'A finite automoton accepts strings.',
                skipped: 'low-confidence',
              },
            ],
            skippedCount: 1,
          },
        },
      },
      {
        id: 'aud-r67-2',
        title: 'Database Transactions',
        fileName: 'db-tx.wav',
        courses: ['CS302'],
        durationSec: 90,
        provider: 'groq',
        language: 'en',
        text: 'Two-phase locking guarantees conflict serializability.',
      },
    ]);

    let aiCalls = 0;
    const trackingComplete = async () => {
      aiCalls += 1;
      return '';
    };

    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
    resetDistStore('zh', false);

    const host = await createTuiHost({
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
          initialPage: 'dashboard',
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

      // Wait for DashboardView ready, then navigate to AudioView via 'a'
      await tty.waitFor((s) => s.includes('学习统计与掌握度'), {
        label: 'Initial DashboardView ready',
      });
      tty.send('a');

      const audioScreen = await tty.waitFor(
        (s) =>
          s.includes('音频转写工作台') &&
          s.includes('Compilers Lecture 01') &&
          s.includes('Database Transactions'),
        { label: 'AudioView zh 120x36 rendered seeded results' },
      );
      tty.assertHealthyScreen(audioScreen, 120, 36, 'AudioView zh 120x36');
      const hintKeys = useDistTuiStore.getState().footerHints.map((h) => h.key);
      assert.ok(hintKeys.includes('/') && hintKeys.includes('x'), `AudioView footerHints must include / and x: ${hintKeys.join(',')}`);
      assert.equal(aiCalls, 0);

      // Press '/' to open live filter bar and filter by transcript snippet / fileName
      tty.send('/');
      await tty.waitFor(
        (s) => s.includes('[筛选 2/2]') && useDistTuiStore.getState().inputCaptured === true,
        { label: 'Filter bar opened with [筛选 2/2]' },
      );

      tty.send('automata');
      const filteredEditing = await tty.waitFor(
        (s) =>
          s.includes('[筛选 1/2]') &&
          s.includes('Compilers Lecture 01') &&
          !s.includes('Database Transactions'),
        { label: 'Live filter narrowed results to 1/2' },
      );
      tty.assertHealthyScreen(filteredEditing, 120, 36, 'AudioView live filter editing zh');

      // Press Enter to confirm filter while keeping filter active
      tty.send('\r');
      const filteredApplied = await tty.waitFor(
        (s) => s.includes('[已筛选 1/2]') && useDistTuiStore.getState().inputCaptured === false,
        { label: 'Filter confirmed via Enter' },
      );
      tty.assertHealthyScreen(filteredApplied, 120, 36, 'AudioView filter applied zh');

      // Press 'x' to export selected audio transcript atomically (0 model calls)
      useDistTuiStore.setState({ toasts: [] });
      tty.send('x');
      const expectedPath = join(resolve(libraryRoot), 'backups', `studyhub-audio-${todayLocalYmd()}.md`);
      await tty.waitFor(
        () =>
          useDistTuiStore
            .getState()
            .toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已导出逐字稿')),
        { label: '[x] export success toast zh' },
      );

      const exported = await readFile(expectedPath, 'utf8');
      assert.match(exported, /^# Compilers Lecture 01/m);
      assert.match(exported, /- 课程: CS401/);
      assert.match(exported, /- 文件: compilers-01\.mp3/);
      assert.match(exported, /\[00:00\] Lexical analysis converts character streams into tokens\./);
      assert.match(exported, /\[01:15\] Deterministic finite automata recognize regular languages\./);
      assert.match(exported, /finite automoton.*->.*finite automaton/);
      assert.equal(aiCalls, 0, 'Audio transcript export must make 0 LLM calls');

      // Press Esc in normal mode to clear active filter
      tty.send('\x1b');
      const clearedScreen = await tty.waitFor(
        (s) => !s.includes('[已筛选') && s.includes('Database Transactions'),
        { label: 'Esc cleared active filter in normal mode' },
      );
      tty.assertHealthyScreen(clearedScreen, 120, 36, 'AudioView after Esc clear zh');
    } finally {
      inkInstance?.unmount();
      tty.dispose();
      await host.dispose();
    }
  });

  test('3) PTY E2E (80x24 --ascii en): [/] filter + [x] export remain healthy & 100% ASCII-pure', async () => {
    const base = await makeTempDir('ascii');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');
    await mkdir(libraryRoot, { recursive: true });

    await seedAudioTranscripts(libraryRoot, [
      {
        id: 'aud-ascii-1',
        title: 'Networking Basics',
        fileName: 'net-01.mp3',
        courses: ['CS210'],
        durationSec: 64,
        provider: 'groq',
        language: 'en',
        text: 'TCP provides reliable ordered byte-stream delivery.',
        segments: [{ start: 12, text: 'TCP provides reliable ordered byte-stream delivery.' }],
      },
      {
        id: 'aud-ascii-2',
        title: 'Linear Systems',
        fileName: 'lin-02.wav',
        courses: ['MATH201'],
        durationSec: 45,
        provider: 'free',
        language: 'en',
        text: 'Gaussian elimination solves linear systems.',
      },
    ]);

    let aiCalls = 0;
    await saveTuiPreferences({ language: 'en', asciiMode: true }, { env });
    resetDistStore('en', true);

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      injectedComplete: async () => {
        aiCalls += 1;
        return '';
      },
      skipAutoProbe: true,
      language: 'en',
    });

    const tty = createVirtualTty(80, 24);
    let inkInstance = null;
    try {
      inkInstance = render(
        React.createElement(StudyHubTuiApp, {
          host,
          initialPage: 'dashboard',
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

      await tty.waitFor((s) => s.includes('Study Analytics & Mastery'), { label: 'Initial DashboardView en 80x24' });
      tty.send('a');

      const audioAscii = await tty.waitFor(
        (s) => s.includes('Diagnostics & Quota') && s.includes('Networking Basics'),
        { label: 'AudioView --ascii en 80x24' },
      );
      tty.assertHealthyScreen(audioAscii, 80, 24, 'AudioView --ascii en 80x24');
      tty.assertAsciiPure(audioAscii, 'AudioView --ascii en 80x24');

      // Filter with '/' -> type 'net-01' -> Enter
      tty.send('/');
      await tty.waitFor(
        (s) => s.includes('[Filter 2/2]') && useDistTuiStore.getState().inputCaptured === true,
        { label: 'Filter bar opened --ascii en 80x24' },
      );
      tty.send('net-01');
      const filterAscii = await tty.waitFor(
        (s) => s.includes('[Filter 1/2]') && s.includes('Networking Basics') && !s.includes('Linear Systems'),
        { label: 'Filter bar --ascii en 80x24' },
      );
      tty.assertHealthyScreen(filterAscii, 80, 24, 'AudioView filter editing --ascii en 80x24');
      tty.assertAsciiPure(filterAscii, 'AudioView filter editing --ascii en 80x24');

      tty.send('\r');
      const appliedAscii = await tty.waitFor(
        (s) => s.includes('[Filtered 1/2]') && useDistTuiStore.getState().inputCaptured === false,
        { label: 'Filter applied --ascii en 80x24' },
      );
      tty.assertHealthyScreen(appliedAscii, 80, 24, 'AudioView filter applied --ascii en 80x24');
      tty.assertAsciiPure(appliedAscii, 'AudioView filter applied --ascii en 80x24');

      // Export with 'x'
      useDistTuiStore.setState({ toasts: [] });
      tty.send('x');
      const expectedPath = join(resolve(libraryRoot), 'backups', `studyhub-audio-${todayLocalYmd()}.md`);
      await tty.waitFor(
        () =>
          useDistTuiStore
            .getState()
            .toasts.some((toast) => toast.tone === 'success' && toast.text.includes('Exported transcript')),
        { label: '[x] export toast --ascii en 80x24' },
      );
      const screenAfterExport = tty.readScreen();
      tty.assertHealthyScreen(screenAfterExport, 80, 24, 'AudioView after export --ascii en 80x24');
      tty.assertAsciiPure(screenAfterExport, 'AudioView after export --ascii en 80x24');

      const exported = await readFile(expectedPath, 'utf8');
      assert.match(exported, /^# Networking Basics/m);
      assert.match(exported, /\[00:12\] TCP provides reliable ordered byte-stream delivery\./);
      assert.equal(aiCalls, 0);

      // Clear with Esc in normal mode, then re-filter to 0/2 -> verify no-selection guard on [x]
      tty.send('\x1b');
      await tty.waitFor((s) => !s.includes('[Filtered') && s.includes('Linear Systems'), {
        label: 'Esc cleared active filter --ascii en 80x24',
      });
      tty.send('/');
      await tty.waitFor(
        (s) => s.includes('[Filter 2/2]') && useDistTuiStore.getState().inputCaptured === true,
        { label: 'Re-open filter bar --ascii en 80x24' },
      );
      tty.send('zzz-no-match');
      await tty.waitFor((s) => s.includes('[Filter 0/2]'), { label: '0/2 filter state' });
      tty.send('\r');
      await tty.waitFor((s) => s.includes('[Filtered 0/2]'), { label: '0/2 applied state' });
      useDistTuiStore.setState({ toasts: [] });
      tty.send('x');
      await tty.waitFor(
        () =>
          useDistTuiStore
            .getState()
            .toasts.some((toast) => toast.tone === 'info' && toast.text.includes('Select an audio transcript first')),
        { label: '[x] empty-selection info toast' },
      );
    } finally {
      inkInstance?.unmount();
      tty.dispose();
      await host.dispose();
    }
  });
});
