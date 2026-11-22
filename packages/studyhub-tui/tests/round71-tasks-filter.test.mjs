// Round 71 Track 3: TasksView [/] Live Job Filter & [X] Atomic Jobs Summary Markdown Export (0 LLM tokens)
// + HelpOverlay & KEYBINDINGS.md sync:
// `node --test --test-concurrency=1 tests/round71-tasks-filter.test.mjs`
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

// Bundle TasksView & HelpOverlay from TypeScript source to unit-test formatTasksMarkdown & featureShortcuts directly
const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyhub-r71-tasks-unit-'));
const bundleFile = path.join(bundleDir, 'tasks-unit.mjs');
await build({
  stdin: {
    contents: [
      `export { formatTasksMarkdown } from './src/views/tasks/TasksView.tsx';`,
      `export { featureShortcuts } from './src/shell/HelpOverlay.tsx';`,
    ].join('\n'),
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
const TasksUnitMod = await import(pathToFileURL(bundleFile).href);
assert.equal(typeof TasksUnitMod.formatTasksMarkdown, 'function', 'TasksView must export formatTasksMarkdown');
assert.equal(typeof TasksUnitMod.featureShortcuts, 'function', 'HelpOverlay must export featureShortcuts');

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

function clearStoreToasts() {
  const st = useDistTuiStore.getState();
  for (const toast of [...st.toasts]) {
    st.dismissToast(toast.id);
  }
}

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [bundleDir];

async function makeTempDir(label) {
  const d = await mkdtemp(join(os.tmpdir(), `studyhub-r71-tasks-${label}-`));
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
    for (let i = 0; i < lines.length; i += 1) {
      const w = displayWidth(lines[i]);
      assert.ok(w <= expectedCols, `${label}: row ${i} width ${w} > ${expectedCols}: ${JSON.stringify(lines[i])}`);
    }
    const buf = term.buffer.active;
    for (let y = 0; y < term.rows; y += 1) {
      const line = buf.getLine(buf.viewportY + y);
      if (line) {
        assert.equal(
          line.isWrapped,
          false,
          `${label}: xterm soft-wrapped row ${y}: ${JSON.stringify(line.translateToString(true))}`,
        );
      }
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

function createMockJobsHost(innerHost, initialJobs) {
  const jobs = initialJobs.map((j) => structuredClone(j));

  const wrapResult = (res) => {
    if (!res?.ok || !res.value || typeof res.value !== 'object') return res;
    return {
      ...res,
      value: {
        ...res.value,
        jobs: jobs.map((j) => structuredClone(j)),
      },
    };
  };

  return {
    ...innerHost,
    refreshSnapshot: async (args = {}) => {
      const snap = await innerHost.refreshSnapshot(args);
      return {
        ...snap,
        snapshot: snap.snapshot
          ? {
              ...snap.snapshot,
              jobs: jobs.map((j) => structuredClone(j)),
            }
          : snap.snapshot,
      };
    },
    call: async (action, args = {}) => {
      if (action === 'snapshot') {
        const res = await innerHost.call(action, args);
        return wrapResult(res);
      }
      if (action === 'job.live.list') {
        return {
          ok: true,
          value: { jobs: jobs.map((j) => structuredClone(j)) },
        };
      }
      if (action === 'job.output') {
        return { ok: true, value: { supported: false, text: '' } };
      }
      if (action === 'job.trace') {
        return { ok: true, value: { calls: [] } };
      }
      return innerHost.call(action, args);
    },
  };
}

describe('Round 71 Track 3: TasksView [/] Live Filter & [X] Atomic Markdown Export', () => {
  after(async () => {
    if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = PREV_DSH_HOME;
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
  });

  test('1) Pure unit test: formatTasksMarkdown (zh/en, table columns, pipe escaping, empty state) & HelpOverlay/KEYBINDINGS sync', () => {
    const sampleJobs = [
      {
        id: 'job-trans-1',
        title: 'Lecture 01 | Translation\nPart A',
        type: 'translation',
        status: 'queued',
        progress: 0.25,
        course: 'Algorithms | CS101',
        startedAt: '2026-11-22T10:00:00.000Z',
      },
      {
        id: 'job-gen-2',
        title: 'Chapter 3 Deck Generation',
        type: 'generation',
        status: 'complete',
        progress: 1,
        course: 'Operating Systems',
        startedAt: '2026-11-22T09:00:00.000Z',
        finishedAt: '2026-11-22T09:15:00.000Z',
      },
    ];

    const mdZh = TasksUnitMod.formatTasksMarkdown({
      jobs: sampleJobs,
      filterTab: 'all',
      filterQuery: 'trans',
      lang: 'zh',
      generatedAt: '2026-11-22 12:00',
    });
    assert.ok(mdZh.includes('# StudyHub 后台任务汇总报告'));
    assert.ok(mdZh.includes('2026-11-22 12:00'));
    assert.ok(mdZh.includes('all'));
    assert.ok(mdZh.includes('trans'));
    assert.ok(mdZh.includes('**任务总数**: 2'));
    assert.ok(mdZh.includes('queued: 1') && mdZh.includes('complete: 1'));
    assert.ok(mdZh.includes('| # | 标题 | 类型 | 状态 | 进度 | 课程 | 更新/创建时间 |'));
    assert.ok(mdZh.includes('| 1 | Lecture 01 \\| Translation Part A | translation | queued | 25% | Algorithms \\| CS101 |'));
    assert.ok(mdZh.includes('| 2 | Chapter 3 Deck Generation | generation | complete | 100% | Operating Systems |'));

    const mdEn = TasksUnitMod.formatTasksMarkdown({
      jobs: sampleJobs,
      filterTab: 'running',
      filterQuery: 'Pipe|Query',
      lang: 'en',
      generatedAt: '2026-11-22 12:30',
    });
    assert.ok(mdEn.includes('# StudyHub Background Jobs Summary'));
    assert.ok(mdEn.includes('Running (running)'));
    assert.ok(mdEn.includes('Pipe\\|Query'));
    assert.ok(mdEn.includes('| # | Title | Type | Status | Progress | Course | Updated/Created |'));
    assert.ok(mdEn.includes('**Total Jobs**: 2'));

    const emptyZh = TasksUnitMod.formatTasksMarkdown({
      jobs: [],
      filterTab: 'archived',
      filterQuery: '',
      lang: 'zh',
      generatedAt: '2026-11-22 12:00',
    });
    assert.ok(emptyZh.includes('archived'));
    assert.ok(emptyZh.includes('**任务总数**: 0'));
    assert.ok(emptyZh.includes('当前筛选下暂无任务记录'));

    const emptyEn = TasksUnitMod.formatTasksMarkdown({
      jobs: [],
      filterTab: 'all',
      lang: 'en',
      generatedAt: '2026-11-22 12:00',
    });
    assert.ok(emptyEn.includes('No jobs match the current filter'));

    // Verify HelpOverlay has exactly 15 sections and Round 71 entries + KEYBINDINGS.md sync
    const secEn = TasksUnitMod.featureShortcuts('en');
    const secZh = TasksUnitMod.featureShortcuts('zh');
    assert.equal(secEn.length, 15);
    assert.equal(secZh.length, 15);
    const libSecEn = secEn.find((s) => s.title.includes('Library'));
    const tasksSecEn = secEn.find((s) => s.title.includes('Tasks'));
    const libSecZh = secZh.find((s) => s.title.includes('Library'));
    const tasksSecZh = secZh.find((s) => s.title.includes('Tasks'));
    assert.ok(libSecEn?.items.some((i) => i.key === '/' && i.label === 'Filter decks by keyword'));
    assert.ok(libSecZh?.items.some((i) => i.key === '/' && i.label === '关键词筛选题组'));
    assert.ok(tasksSecEn?.items.some((i) => i.key === 't: /  X' && i.label === 'Filter jobs / Export jobs MD'));
    assert.ok(tasksSecZh?.items.some((i) => i.key === 't: /  X' && i.label === '筛选任务 / 导出任务汇总 MD'));

    const keybindingsMd = fs.readFileSync(join(pkgRoot, 'docs/KEYBINDINGS.md'), 'utf8');
    assert.ok(keybindingsMd.includes('filter decks by keyword'));
    assert.ok(keybindingsMd.includes('studyhub-tasks-YYYY-MM-DD.md'));
  });

  test('2) @xterm/headless PTY E2E (120x36 zh): TasksView [/] live filter + [X] atomic export + [Esc] clear (0 model calls)', async () => {
    const base = await makeTempDir('pty-zh');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');

    await saveTuiPreferences({ language: 'zh', asciiMode: false });
    resetDistStore('zh', false);

    let modelCalls = 0;
    const rawHost = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      injectedComplete: async () => {
        modelCalls += 1;
        throw new Error('Must not call model in PTY E2E');
      },
      skipAutoProbe: true,
      language: 'zh',
    });

    const sampleRes = await rawHost.call('sample.load', { language: 'zh' });
    assert.equal(sampleRes.ok, true, sampleRes.error?.message);

    const host = createMockJobsHost(rawHost, [
      {
        id: 'job-gen-done-r71',
        title: 'R71 操作系统出题任务',
        type: 'generation',
        status: 'complete',
        progress: 1,
        phase: '已完成',
        course: 'Operating Systems',
        startedAt: '2026-11-22T09:00:00.000Z',
        finishedAt: '2026-11-22T09:05:00.000Z',
        calls: [],
      },
      {
        id: 'job-trans-queued-r71',
        title: 'R71 分布式共识译文任务',
        type: 'translation',
        status: 'queued',
        progress: 0.1,
        phase: '翻译排队',
        course: 'Distributed Systems',
        startedAt: '2026-11-22T10:00:00.000Z',
        calls: [],
      },
    ]);

    const tty = createVirtualTty(120, 36);
    let inkInstance = null;
    try {
      inkInstance = render(React.createElement(StudyHubTuiApp, { host, autoLaunchpad: false, asciiMode: false }), {
        stdin: tty.stdin,
        stdout: tty.stdout,
        stderr: tty.stderr,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await tty.firstFramePromise;
      await tty.waitFor((s) => s.includes('学习库') || s.includes('Memento'), { label: 'Initial zh render' });

      // Navigate to TasksView ('t') -> Tab '2' (All)
      tty.send('t');
      await tty.waitFor(
        (s) =>
          useDistTuiStore.getState().page === 'tasks' &&
          s.includes('R71 分布式共识') &&
          s.includes('R71 操作系统出题'),
        { label: 'TasksView zh with 2 jobs' },
      );

      tty.send('2');
      const allScreen = await tty.waitFor(
        (s) =>
          s.includes('2. 全部 (2)') &&
          useDistTuiStore.getState().footerHints.some((h) => h.key === '/' && h.label === '筛选') &&
          useDistTuiStore.getState().footerHints.some((h) => h.key === 'X' && h.label === '导出MD'),
        { label: 'TasksView zh Tab 2 (All)' },
      );
      tty.assertHealthyScreen(allScreen, 120, 36, 'TasksView zh Tab 2 120x36');

      // Press '/' -> type 'translation' -> Enter -> verifies match count badge [已筛选 1/2]
      tty.send('/');
      await tty.waitFor((s) => s.includes('[筛选 2/2]'), { label: 'Filter input opened zh' });

      tty.send('translation');
      const typingScreen = await tty.waitFor(
        (s) => s.includes('[筛选 1/2]') && s.includes('R71 分布式共识') && !s.includes('R71 操作系统出题'),
        { label: 'Live filter narrowed to 1/2 zh' },
      );
      tty.assertHealthyScreen(typingScreen, 120, 36, 'TasksView zh filtering 120x36');

      tty.send('\r');
      const confirmedScreen = await tty.waitFor(
        (s) => s.includes('[已筛选 1/2]'),
        { label: 'Filter confirmed with Enter zh' },
      );
      tty.assertHealthyScreen(confirmedScreen, 120, 36, 'TasksView zh filter confirmed');

      // Press 'X' -> atomic export to <libraryRoot>/backups/studyhub-tasks-YYYY-MM-DD.md
      clearStoreToasts();
      tty.send('X');
      const expectedPath = join(libraryRoot, 'backups', `studyhub-tasks-${todayLocalYmd()}.md`);
      const exportScreen = await tty.waitFor(
        (s) =>
          fs.existsSync(expectedPath) &&
          useDistTuiStore
            .getState()
            .toasts.some(
              (toast) =>
                toast.tone === 'success' &&
                toast.text.includes('已导出 1 条任务汇总') &&
                toast.text.includes(expectedPath),
            ) &&
          s.includes('已导出 1 条任务汇总'),
        { label: 'TasksView zh [X] export success toast' },
      );
      tty.assertHealthyScreen(exportScreen, 120, 36, 'TasksView zh after [X] export');

      const exportedMd = await readFile(expectedPath, 'utf8');
      assert.ok(exportedMd.includes('# StudyHub 后台任务汇总报告'));
      assert.ok(exportedMd.includes('**筛选关键词**: translation'));
      assert.ok(exportedMd.includes('**任务总数**: 1'));
      assert.ok(exportedMd.includes('| # | 标题 | 类型 | 状态 | 进度 | 课程 | 更新/创建时间 |'));
      assert.ok(exportedMd.includes('R71 分布式共识译文任务'));
      assert.ok(!exportedMd.includes('R71 操作系统出题任务'));

      // Press Esc in normal mode -> clears active filter back to 2 jobs
      tty.send('\x1b');
      const clearedScreen = await tty.waitFor(
        (s) => !s.includes('[已筛选') && s.includes('R71 操作系统出题') && s.includes('R71 分布式共识'),
        { label: 'Esc clears active filter in normal mode zh' },
      );
      tty.assertHealthyScreen(clearedScreen, 120, 36, 'TasksView zh after Esc clear');

      // Also test empty filter + 'X' shows friendly info toast
      tty.send('/');
      await tty.waitFor((s) => s.includes('[筛选 2/2]'), { label: 'Re-open filter zh' });
      tty.send('nonexistent-xyz');
      await tty.waitFor((s) => s.includes('[筛选 0/2]') && s.includes('未找到匹配的任务'), { label: 'Empty filter match zh' });
      tty.send('\r');
      await tty.waitFor((s) => s.includes('[已筛选 0/2]'), { label: 'Empty filter confirmed zh' });
      clearStoreToasts();
      tty.send('X');
      await tty.waitFor(
        () =>
          useDistTuiStore
            .getState()
            .toasts.some((toast) => toast.tone === 'info' && toast.text.includes('当前筛选下暂无可导出的任务记录')),
        { label: 'Empty filter [X] friendly info toast zh' },
      );
      tty.send('\x1b');
      await tty.waitFor((s) => !s.includes('[已筛选') && s.includes('R71 操作系统出题'), { label: 'Esc clears empty filter zh' });

      assert.equal(modelCalls, 0);
    } finally {
      inkInstance?.unmount();
      tty.dispose();
      await rawHost.dispose();
    }
  });

  test('3) @xterm/headless PTY E2E (80x24 --ascii en): TasksView [/] filter + [X] export + [Esc] clear (pure ASCII)', async () => {
    const base = await makeTempDir('pty-ascii-en');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');

    await saveTuiPreferences({ language: 'en', asciiMode: true });
    resetDistStore('en', true);

    let modelCalls = 0;
    const rawHost = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      injectedComplete: async () => {
        modelCalls += 1;
        throw new Error('Must not call model in ASCII PTY E2E');
      },
      skipAutoProbe: true,
      language: 'en',
    });

    const sampleRes = await rawHost.call('sample.load', { language: 'en' });
    assert.equal(sampleRes.ok, true, sampleRes.error?.message);

    const host = createMockJobsHost(rawHost, [
      {
        id: 'job-en-gen-1',
        title: 'R71 Generate Algorithms Deck',
        type: 'generation',
        status: 'complete',
        progress: 1,
        phase: 'Done',
        course: 'Algorithms',
        startedAt: '2026-11-22T09:00:00.000Z',
        finishedAt: '2026-11-22T09:10:00.000Z',
        calls: [],
      },
      {
        id: 'job-en-trans-2',
        title: 'R71 Translate Raft Paper',
        type: 'translation',
        status: 'queued',
        progress: 0,
        phase: 'Queued',
        course: 'Distributed Systems',
        startedAt: '2026-11-22T10:00:00.000Z',
        calls: [],
      },
    ]);

    const tty = createVirtualTty(80, 24);
    let inkInstance = null;
    try {
      inkInstance = render(React.createElement(StudyHubTuiApp, { host, autoLaunchpad: false, asciiMode: true }), {
        stdin: tty.stdin,
        stdout: tty.stdout,
        stderr: tty.stderr,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await tty.firstFramePromise;
      await tty.waitFor((s) => s.includes('Library') || s.includes('StudyHub'), { label: 'Initial ASCII en render' });

      tty.send('t');
      const tasksAscii = await tty.waitFor(
        (s) =>
          useDistTuiStore.getState().page === 'tasks' &&
          s.includes('R71 Translate Raft Paper') &&
          s.includes('R71 Generate Algorithms'),
        { label: 'TasksView ASCII en 80x24' },
      );
      tty.assertHealthyScreen(tasksAscii, 80, 24, 'TasksView ASCII en 80x24');
      tty.assertAsciiPure(tasksAscii, 'TasksView ASCII en 80x24');

      // Tab 2 (All) -> '/' filter -> Enter -> 'X' export
      tty.send('2');
      await tty.waitFor((s) => s.includes('2. All (2)'), { label: 'Tab 2 All ASCII en' });

      tty.send('/');
      const filterOpenAscii = await tty.waitFor((s) => s.includes('[Filter 2/2]'), { label: 'Filter open ASCII en' });
      tty.assertHealthyScreen(filterOpenAscii, 80, 24, 'Filter open ASCII en 80x24');
      tty.assertAsciiPure(filterOpenAscii, 'Filter open ASCII en 80x24');

      tty.send('Raft');
      const filteredAscii = await tty.waitFor(
        (s) => s.includes('[Filter 1/2]') && s.includes('R71 Translate Raft Paper') && !s.includes('R71 Generate Algorithms'),
        { label: 'Filter narrowed 1/2 ASCII en' },
      );
      tty.assertHealthyScreen(filteredAscii, 80, 24, 'Filter narrowed ASCII en 80x24');
      tty.assertAsciiPure(filteredAscii, 'Filter narrowed ASCII en 80x24');

      tty.send('\r');
      const appliedAscii = await tty.waitFor((s) => s.includes('[Filtered 1/2]'), { label: 'Filter applied ASCII en' });
      tty.assertHealthyScreen(appliedAscii, 80, 24, 'Filter applied ASCII en 80x24');
      tty.assertAsciiPure(appliedAscii, 'Filter applied ASCII en 80x24');

      clearStoreToasts();
      tty.send('X');
      const expectedPath = join(libraryRoot, 'backups', `studyhub-tasks-${todayLocalYmd()}.md`);
      const exportAscii = await tty.waitFor(
        (s) =>
          fs.existsSync(expectedPath) &&
          useDistTuiStore
            .getState()
            .toasts.some(
              (toast) =>
                toast.tone === 'success' &&
                toast.text.includes('Exported 1 job(s) summary ->') &&
                toast.text.includes(expectedPath),
            ) &&
          s.includes('Exported 1 job(s)'),
        { label: 'Export success toast ASCII en' },
      );
      tty.assertHealthyScreen(exportAscii, 80, 24, 'Export success ASCII en 80x24');
      tty.assertAsciiPure(exportAscii, 'Export success ASCII en 80x24');

      const exportedMd = await readFile(expectedPath, 'utf8');
      assert.ok(exportedMd.includes('# StudyHub Background Jobs Summary'));
      assert.ok(exportedMd.includes('**Filter Query**: Raft'));
      assert.ok(exportedMd.includes('R71 Translate Raft Paper'));
      assert.ok(!exportedMd.includes('R71 Generate Algorithms Deck'));

      // Esc clears filter
      tty.send('\x1b');
      const clearedAscii = await tty.waitFor(
        (s) => !s.includes('[Filtered') && s.includes('R71 Generate Algorithms'),
        { label: 'Esc cleared filter ASCII en' },
      );
      tty.assertHealthyScreen(clearedAscii, 80, 24, 'Esc cleared filter ASCII en 80x24');
      tty.assertAsciiPure(clearedAscii, 'Esc cleared filter ASCII en 80x24');
      assert.equal(modelCalls, 0);
    } finally {
      inkInstance?.unmount();
      tty.dispose();
      await rawHost.dispose();
    }
  });
});
