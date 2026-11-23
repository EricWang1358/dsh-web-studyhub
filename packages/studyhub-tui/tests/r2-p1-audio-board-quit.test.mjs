// Round 2 Review Track 2 regressions: P1 #3 (AudioView results), P1 #6 (BoardView read-only lock), P1 #7 (/quit guard).
// Run: node --test tests/r2-p1-audio-board-quit.test.mjs
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { render } from 'ink';
import React from 'react';
import {
  cloneSampleLibrary,
  createTempTracker,
  createVirtualTty,
  disposeTerminalPool,
  distDir,
  loadDistRuntime,
} from './helpers/virtual-tty.mjs';

const runtime = await loadDistRuntime();
const { StudyHubTuiApp, createTuiHost } = runtime;

const storeFile = (await readdir(distDir)).find((f) => f.startsWith('store-') && f.endsWith('.mjs'));
assert.ok(storeFile, 'dist/ must include store-*.mjs');
const { useTuiStore } = await import(pathToFileURL(join(distDir, storeFile)).href);

const PREV_DSH_HOME = process.env.DSH_HOME;
const temps = createTempTracker('studyhub-tui-r2-p1-');

function resetStoreForTest() {
  useTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    inputCaptured: false,
    commandPaletteOpen: false,
    helpOpen: false,
    coursePickerOpen: false,
    voicePackOpen: false,
    inboxOpen: false,
    showLaunchpad: false,
    snapshot: null,
    binding: null,
    desktopConfig: null,
    loading: true,
    refreshing: false,
    lastError: null,
    activeRunId: null,
    quitConfirmOpen: false,
    quitGuard: null,
    toasts: [],
    footerHints: [],
  });
}

function createStubComplete() {
  return async (_system, prompt) => {
    if (String(prompt || '').includes('OK?')) return 'OK';
    return JSON.stringify({ cards: [] });
  };
}

function createMockHost(libraryRoot, overrides = {}) {
  const listeners = new Set();
  const baseSnapshot = {
    root: libraryRoot,
    revision: 1,
    modelReady: false,
    courses: [{ name: 'CS101', deckCount: 0, cardCount: 0, dueCount: 0 }],
    decks: [],
    sources: [],
    drafts: [],
    jobs: [],
    runs: [],
    notes: [],
  };
  const baseConfig = {
    mode: 'openai',
    openai: { providerId: 'deepseek', baseUrl: '', model: '', hasKey: false, keyLast4: '' },
    agy: { executablePath: '', model: '', effort: '' },
    codex: { executablePath: '', model: '', effort: '' },
    libraryRoot,
    libraryPlaceConfirmed: true,
    reasoningEffort: '',
    effective: { ready: false, label: 'Unconfigured', reason: 'no-credential' },
  };

  return {
    dshHome: libraryRoot,
    autoProbe: Promise.resolve({ outcome: 'skipped', providers: [] }),
    getLibraryRoot: () => libraryRoot,
    getConfig: () => baseConfig,
    setLanguage: () => {},
    getLanguage: () => 'zh',
    rescanProviders: async () => [],
    subscribeEvents: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    refreshSnapshot: async () => ({
      snapshot: overrides.snapshot ?? baseSnapshot,
      binding: { root: libraryRoot, libraryPlaceConfirmed: true },
      config: baseConfig,
      error: null,
    }),
    dispose: async () => {
      listeners.clear();
    },
    call: async (action, args = {}) => {
      if (overrides.call) {
        const custom = await overrides.call(action, args);
        if (custom !== undefined) return custom;
      }
      if (action === 'snapshot') return { ok: true, value: overrides.snapshot ?? baseSnapshot };
      if (action === 'binding.get') return { ok: true, value: { root: libraryRoot } };
      if (action === 'desktop.config.get') return { ok: true, value: baseConfig };
      if (action === 'audio.settings.get') {
        return { ok: true, value: { freeKey: { set: false }, paidKey: { set: false }, groqKey: { set: false }, siliconflowKey: { set: false } } };
      }
      if (action === 'audio.preflight') {
        return { ok: true, value: { providers: {}, transcription: false, text: false, live: false } };
      }
      if (action === 'audio.usage') return { ok: true, value: { providers: [] } };
      if (action === 'audio.results') return { ok: true, value: { results: [] } };
      if (action === 'board.get') return { ok: true, value: { readOnly: false, cards: {}, columns: [] } };
      return { ok: false, error: { message: `Unhandled action: ${action}`, code: 'UNKNOWN' } };
    },
  };
}

async function mountApp(host, { cols = 120, rows = 36, initialPage = 'library', autoLaunchpad = false, onExit } = {}) {
  resetStoreForTest();
  const tty = createVirtualTty(cols, rows);
  const inkInstance = render(
    React.createElement(StudyHubTuiApp, {
      host,
      initialPage,
      initialLanguage: 'zh',
      autoLaunchpad,
      onExit: onExit ?? (() => inkInstance?.unmount()),
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
  return {
    tty,
    unmount: () => {
      try {
        inkInstance?.unmount();
      } catch {
        // Ignore unmount error on cleanup
      }
      tty.dispose();
    },
  };
}

after(async () => {
  try {
    disposeTerminalPool();
  } finally {
    if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = PREV_DSH_HOME;
    await temps.cleanup();
  }
});

describe('Round 2 P1: AudioView results, BoardView read-only lock, Unified /quit guard', () => {
  test('P1 #3a: tui-host audio.results & audio.result.get resolve real library audio sources and AudioView displays & exports them', async () => {
    const box = await temps.make('audio-real');
    const dshHome = join(box, 'dsh');
    const libRoot = join(box, 'lib');
    await Promise.all([mkdir(dshHome, { recursive: true }), mkdir(libRoot, { recursive: true })]);
    process.env.DSH_HOME = dshHome;

    const host = await createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(box, 'home'),
      libraryRoot: libRoot,
      injectedComplete: createStubComplete(),
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    const addRes = await host.call('source.add', {
      id: 'subtitle-lecture-01',
      title: 'Distributed Systems Lecture 01',
      courses: ['CS401'],
      text: '[00:00] Welcome to Distributed Systems.\n[00:12] Today we study Raft consensus.',
    });
    assert.equal(addRes.ok, true, `source.add failed: ${addRes.error?.message}`);

    const listRes = await host.call('audio.results', {});
    assert.equal(listRes.ok, true, `audio.results must succeed: ${listRes.error?.message}`);
    assert.ok(Array.isArray(listRes.value?.results), 'audio.results must return results array');
    assert.equal(listRes.value.results.length, 1, 'audio.results should include the audio/subtitle source');
    assert.equal(listRes.value.results[0].id, 'subtitle-lecture-01');
    assert.equal(listRes.value.results[0].title, 'Distributed Systems Lecture 01');

    const detailRes = await host.call('audio.result.get', { id: 'subtitle-lecture-01' });
    assert.equal(detailRes.ok, true, `audio.result.get must succeed: ${detailRes.error?.message}`);
    assert.ok(
      String(detailRes.value?.transcript || detailRes.value?.text || '').includes('Raft consensus'),
      'audio.result.get must return full transcript text',
    );

    const app = await mountApp(host, { initialPage: 'audio', autoLaunchpad: false });
    try {
      const screen = await app.tty.waitFor(
        (s) =>
          s.includes('Distributed Systems Lecture 01') &&
          s.includes('Raft consensus'),
        { timeoutMs: 8_000, label: 'AudioView showing real library transcript' },
      );
      assert.ok(!screen.includes('Unknown action'), 'AudioView must not show Unknown action');

      // Export twice via [x] — must write unique timestamped slugged files in backups/ without overwriting
      app.tty.send('x');
      await app.tty.waitFor(
        (s) => s.includes('已导出逐字稿') || s.includes('Exported transcript'),
        { timeoutMs: 6_000, label: 'AudioView first export toast' },
      );
      app.tty.send('x');
      await app.tty.waitFor(
        () => useTuiStore.getState().toasts.filter((t) => t.text.includes('已导出逐字稿') || t.text.includes('Exported transcript')).length >= 2,
        { timeoutMs: 6_000, label: 'AudioView second unique export toast' },
      );

      const backupsDir = join(libRoot, 'backups');
      const files = (await readdir(backupsDir)).filter((f) => f.startsWith('studyhub-audio-') && f.endsWith('.md'));
      assert.equal(files.length, 2, `Expected 2 unique audio exports in backups/, got ${files.join(', ')}`);
      assert.ok(files.some((f) => f.includes('Distributed-Systems')), `Expected slug in filename: ${files.join(', ')}`);
      const mdBody = await readFile(join(backupsDir, files[0]), 'utf8');
      assert.ok(mdBody.includes('Raft consensus'), 'Exported Markdown must include transcript content');
    } finally {
      app.unmount();
      await host.dispose();
    }
  });

  test('P1 #3b: AudioView displays actionable error & empty states (never silent blank)', async () => {
    const box = await temps.make('audio-empty-err');
    const libRoot = join(box, 'lib');
    await mkdir(libRoot, { recursive: true });

    // 1. Error state when audio.results fails
    const errHost = createMockHost(libRoot, {
      call: async (action) => {
        if (action === 'audio.results') {
          return { ok: false, error: { message: 'Audio backend unavailable', code: 'AUDIO_DOWN' } };
        }
        return undefined;
      },
    });
    const appErr = await mountApp(errHost, { initialPage: 'audio' });
    try {
      const screen = await appErr.tty.waitFor(
        (s) => s.includes('加载音频转写记录失败') && s.includes('Audio backend unavailable'),
        { timeoutMs: 6_000, label: 'AudioView results error state' },
      );
      assert.ok(screen.includes('重试') || screen.includes('[r]'), 'Error state must show retry hint');
    } finally {
      appErr.unmount();
      await errHost.dispose();
    }

    // 2. Empty state when no provider is configured
    const noProvHost = createMockHost(libRoot);
    const appNoProv = await mountApp(noProvHost, { initialPage: 'audio' });
    try {
      const screen = await appNoProv.tty.waitFor(
        (s) => s.includes('未配置转写服务') || s.includes('provider unset'),
        { timeoutMs: 6_000, label: 'AudioView empty state without provider' },
      );
      assert.ok(screen.includes('[s]') || screen.includes('配置转写'), 'Should direct user to [s] settings');
      assert.ok(screen.includes('[u]') || screen.includes('导入字幕'), 'Should mention [u] subtitle import');
    } finally {
      appNoProv.unmount();
      await noProvHost.dispose();
    }

    // 3. Detail fetch error is surfaced on right pane (not swallowed)
    const detailErrHost = createMockHost(libRoot, {
      call: async (action) => {
        if (action === 'audio.results') {
          return { ok: true, value: { results: [{ id: 'aud-1', title: 'Missing Body Audio' }] } };
        }
        if (action === 'audio.result.get') {
          return { ok: false, error: { message: 'Transcript shard corrupt' } };
        }
        return undefined;
      },
    });
    const appDetailErr = await mountApp(detailErrHost, { initialPage: 'audio' });
    try {
      await appDetailErr.tty.waitFor(
        (s) => s.includes('加载转写正文失败') && s.includes('Transcript shard corrupt'),
        { timeoutMs: 6_000, label: 'AudioView detail error state' },
      );
    } finally {
      appDetailErr.unmount();
      await detailErrHost.dispose();
    }
  });

  test('P1 #6a: BoardView corrupt tui-board.json blocks ALL write keys and hides write hints', async () => {
    const box = await temps.make('board-corrupt');
    const libRoot = join(box, 'lib');
    await mkdir(libRoot, { recursive: true });
    const boardPath = join(libRoot, 'tui-board.json');
    await writeFile(boardPath, '{corrupt json', 'utf8');

    const host = createMockHost(libRoot);
    const app = await mountApp(host, { initialPage: 'board' });
    try {
      const screen = await app.tty.waitFor(
        (s) =>
          s.includes('看板只读锁定') &&
          s.includes('tui-board.json') &&
          !s.includes('a  添加') &&
          !s.includes('S  同步'),
        { timeoutMs: 6_000, label: 'BoardView corrupt read-only banner & footer hints' },
      );
      assert.ok(!screen.includes('a  添加') && !screen.includes('S  同步'), 'Write hints must be hidden in read-only mode');
      assert.ok(screen.includes('r  重载') || screen.includes('[r]'), 'Reload hint must be shown');

      for (const key of ['a', 'e', '\r', 'd', 'H', 'L', 'm', 'S']) {
        app.tty.send(key);
      }
      const afterScreen = await app.tty.waitFor(
        (s) => s.includes('只读') && !s.includes('添加任务') && !s.includes('编辑任务') && !s.includes('删除任务'),
        { timeoutMs: 4_000, label: 'BoardView corrupt blocked write keys' },
      );
      assert.ok(!afterScreen.includes('Add Card') && !afterScreen.includes('Delete Card'));
      assert.equal(await readFile(boardPath, 'utf8'), '{corrupt json', 'Corrupt tui-board.json must remain untouched');
    } finally {
      app.unmount();
      await host.dispose();
    }
  });

  test('P1 #6b: BoardView upstream board.get { readOnly: true } blocks ALL write keys, mutations & disk writes', async () => {
    const box = await temps.make('board-upstream-ro');
    const libRoot = join(box, 'lib');
    await mkdir(libRoot, { recursive: true });
    const boardPath = join(libRoot, 'tui-board.json');
    const initialDoc = {
      version: 1,
      cards: [
        {
          id: 'c1',
          title: 'ReadOnly Card Alpha',
          column: 'todo',
          course: 'CS101',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      focusStats: { completedPomodoros: 0, focusedMinutes: 0, lastDay: '2026-01-01', todayPomodoros: 0, todayMinutes: 0 },
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const initialRaw = `${JSON.stringify(initialDoc, null, 2)}\n`;
    await writeFile(boardPath, initialRaw, 'utf8');

    const upstreamWriteCalls = [];
    const host = createMockHost(libRoot, {
      call: async (action) => {
        if (action === 'board.get') {
          return { ok: true, value: { readOnly: true, cards: {}, columns: [] } };
        }
        if (action.startsWith('board.card.')) {
          upstreamWriteCalls.push(action);
          return { ok: true, value: {} };
        }
        return undefined;
      },
    });

    const app = await mountApp(host, { initialPage: 'board' });
    try {
      const screen = await app.tty.waitFor(
        (s) =>
          s.includes('ReadOnly Card Alpha') &&
          s.includes('看板只读锁定') &&
          !s.includes('a  添加') &&
          !s.includes('e  编辑') &&
          !s.includes('d  删除'),
        { timeoutMs: 6_000, label: 'BoardView upstream read-only banner' },
      );
      assert.ok(!screen.includes('S  同步'), 'Sync hint must be hidden in read-only mode');

      for (const key of ['a', 'e', '\r', 'd', 'H', 'L', 'm', 'S']) {
        app.tty.send(key);
      }
      await app.tty.waitFor(
        (s) => s.includes('只读') && s.includes('ReadOnly Card Alpha'),
        { timeoutMs: 4_000, label: 'BoardView upstream read-only toast' },
      );
      assert.equal(upstreamWriteCalls.length, 0, 'Zero upstream write calls allowed in read-only mode');
      assert.equal(await readFile(boardPath, 'utf8'), initialRaw, 'tui-board.json must not be modified on disk');

      // Export [x] still works in read-only mode via atomicWriteExportText
      app.tty.send('x');
      await app.tty.waitFor(
        (s) => s.includes('已导出 1 张卡片') || s.includes('Exported 1 cards'),
        { timeoutMs: 6_000, label: 'BoardView read-only export' },
      );
      const backups = await readdir(join(libRoot, 'backups'));
      assert.ok(backups.some((f) => f.startsWith('studyhub-board-') && f.endsWith('.md')));
    } finally {
      app.unmount();
      await host.dispose();
    }
  });

  test('P1 #7a: CommandPalette /quit and q in active ExamRunner show confirm dialog; n/Esc cancel, y exits', async () => {
    const box = await temps.make('quit-exam');
    const dshHome = join(box, 'dsh');
    const libRoot = join(box, 'lib');
    await Promise.all([mkdir(dshHome, { recursive: true }), cloneSampleLibrary('zh', libRoot)]);
    process.env.DSH_HOME = dshHome;

    const host = await createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(box, 'home'),
      libraryRoot: libRoot,
      injectedComplete: createStubComplete(),
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    let exitCount = 0;
    const app = await mountApp(host, {
      initialPage: 'exam',
      autoLaunchpad: false,
      onExit: () => {
        exitCount += 1;
      },
    });
    try {
      await app.tty.waitFor(
        (s) =>
          (s.includes('组卷设置') || s.includes('Exam Setup')) &&
          (s.includes('1:选择题卷') || s.includes('1:Written MCQ')) &&
          !s.includes('正在加载页面'),
        { timeoutMs: 10_000, label: 'ExamSetup loaded' },
      );

      // Start written exam
      app.tty.send('\r');
      await app.tty.waitFor(
        (s) => s.includes('选择题卷') && s.includes('Ctrl+S'),
        { timeoutMs: 10_000, label: 'ExamRunner active' },
      );

      // Open CommandPalette with Ctrl+K -> type /quit -> Enter
      app.tty.send('\x0b');
      await app.tty.waitFor((s) => s.includes('命令面板'), { timeoutMs: 6_000, label: 'CommandPalette open in ExamRunner' });
      app.tty.send('/quit');
      await app.tty.waitFor((s) => s.includes('/quit'), { timeoutMs: 4_000, label: '/quit item visible' });
      app.tty.send('\r');

      await app.tty.waitFor(
        (s) => s.includes('确认退出') && s.includes('当前有进行中的考试/练习'),
        { timeoutMs: 6_000, label: 'Quit ConfirmDialog shown on /quit in ExamRunner' },
      );
      assert.equal(exitCount, 0, 'onExit must NOT be called before confirming quit dialog');

      // Press n to cancel -> exam remains active
      app.tty.send('n');
      await app.tty.waitFor(
        (s) => !s.includes('确认退出') && s.includes('选择题卷') && s.includes('Ctrl+S'),
        { timeoutMs: 6_000, label: 'ExamRunner preserved after cancelling /quit with n' },
      );
      assert.equal(exitCount, 0);

      // Press q directly -> also guarded by unified quit dialog, Esc cancels
      app.tty.send('q');
      await app.tty.waitFor(
        (s) => s.includes('确认退出') && s.includes('当前有进行中的考试/练习'),
        { timeoutMs: 6_000, label: 'Quit ConfirmDialog shown on q in ExamRunner' },
      );
      assert.equal(exitCount, 0);
      app.tty.send('\x1b');
      await app.tty.waitFor(
        (s) => !s.includes('确认退出') && s.includes('选择题卷'),
        { timeoutMs: 6_000, label: 'ExamRunner preserved after Esc' },
      );
      assert.equal(exitCount, 0);

      // /quit -> confirm with y -> invokes onExit
      app.tty.send('\x0b');
      await app.tty.waitFor((s) => s.includes('命令面板'), { timeoutMs: 6_000 });
      app.tty.send('/quit');
      await app.tty.waitFor((s) => s.includes('/quit'), { timeoutMs: 4_000 });
      app.tty.send('\r');
      await app.tty.waitFor((s) => s.includes('确认退出'), { timeoutMs: 6_000 });
      app.tty.send('y');
      await app.tty.waitFor(() => exitCount === 1, { timeoutMs: 4_000, label: 'onExit called after confirming y' });
      assert.equal(exitCount, 1);
    } finally {
      app.unmount();
      await host.dispose();
    }
  });

  test('P1 #7b: CommandPalette /quit in active ReviewView shows confirm dialog; Esc cancels and keeps round, y exits', async () => {
    const box = await temps.make('quit-review');
    const dshHome = join(box, 'dsh');
    const libRoot = join(box, 'lib');
    await Promise.all([mkdir(dshHome, { recursive: true }), cloneSampleLibrary('zh', libRoot)]);
    process.env.DSH_HOME = dshHome;

    const host = await createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(box, 'home'),
      libraryRoot: libRoot,
      injectedComplete: createStubComplete(),
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    let exitCount = 0;
    const app = await mountApp(host, {
      initialPage: 'library',
      autoLaunchpad: false,
      onExit: () => {
        exitCount += 1;
      },
    });
    try {
      await app.tty.waitFor(
        (s) => s.includes('示例 · Memento 与 Bridge'),
        { timeoutMs: 10_000, label: 'LibraryView loaded' },
      );

      // Enter ReviewView
      app.tty.send('\r');
      await app.tty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'review' &&
          !s.includes('正在准备复习队列') &&
          (s.includes('AI讲解') || s.includes('q  结束')),
        { timeoutMs: 10_000, label: 'ReviewView active' },
      );

      // Ctrl+K -> /quit -> Enter
      app.tty.send('\x0b');
      await app.tty.waitFor((s) => s.includes('命令面板'), { timeoutMs: 6_000, label: 'CommandPalette open in ReviewView' });
      app.tty.send('/quit');
      await app.tty.waitFor((s) => s.includes('/quit'), { timeoutMs: 4_000 });
      app.tty.send('\r');

      await app.tty.waitFor(
        (s) => s.includes('确认退出') && s.includes('当前有进行中的考试/练习'),
        { timeoutMs: 6_000, label: 'Quit ConfirmDialog shown on /quit in ReviewView' },
      );
      assert.equal(exitCount, 0, 'onExit must NOT be called before confirming quit');

      // Esc cancels and preserves active review round
      app.tty.send('\x1b');
      const preserved = await app.tty.waitFor(
        (s) => !s.includes('确认退出') && useTuiStore.getState().page === 'review' && (s.includes('AI讲解') || s.includes('q  结束')),
        { timeoutMs: 6_000, label: 'ReviewView active round preserved after Esc' },
      );
      assert.ok(!preserved.includes('本轮练习总结'), 'Round must remain active, not ended');
      assert.equal(exitCount, 0);

      // /quit -> confirm with y -> exits
      app.tty.send('\x0b');
      await app.tty.waitFor((s) => s.includes('命令面板'), { timeoutMs: 6_000 });
      app.tty.send('/quit');
      await app.tty.waitFor((s) => s.includes('/quit'), { timeoutMs: 4_000 });
      app.tty.send('\r');
      await app.tty.waitFor((s) => s.includes('确认退出'), { timeoutMs: 6_000 });
      app.tty.send('y');
      await app.tty.waitFor(() => exitCount === 1, { timeoutMs: 4_000, label: 'onExit called on y in ReviewView' });
      assert.equal(exitCount, 1);
    } finally {
      app.unmount();
      await host.dispose();
    }
  });
});
