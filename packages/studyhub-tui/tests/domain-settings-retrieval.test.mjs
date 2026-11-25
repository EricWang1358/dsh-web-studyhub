// Consolidated Settings Semantic Retrieval Domain Suite:
// Merged from: round50-retrieval-cov, round57-retrieval-diag, round58-retrieval-tools
// `node --test tests/domain-settings-retrieval.test.mjs`
import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { render } from 'ink';
import React from 'react';
import {
  createTempTracker,
  createVirtualTty,
  disposeTerminalPool,
  distDir,
  loadDistRuntime,
} from './helpers/virtual-tty.mjs';

const runtime = await loadDistRuntime();
const { StudyHubTuiApp, createTuiHost, saveTuiPreferences, loadTuiPreferences } = runtime;
assert.ok(StudyHubTuiApp, 'dist/ must export StudyHubTuiApp');
assert.ok(createTuiHost, 'dist/ must export createTuiHost');
assert.ok(saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(loadTuiPreferences, 'dist/ must export loadTuiPreferences');

const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const storeFile = distFiles.find((f) => f.startsWith('store-') && f.endsWith('.mjs'));
assert.ok(storeFile, 'dist/ must include store-*.mjs');
const { useTuiStore, DEFAULT_PREFERENCES } = await import(pathToFileURL(join(distDir, storeFile)).href);
assert.ok(useTuiStore, 'dist/store-*.mjs must export useTuiStore');
assert.ok(DEFAULT_PREFERENCES, 'dist/store-*.mjs must export DEFAULT_PREFERENCES');

const PREV_DSH_HOME = process.env.DSH_HOME;
const temps = createTempTracker('studyhub-tui-dom-ret-');

function resetTuiStore(language = 'zh', asciiMode = false, extra = {}) {
  useTuiStore.setState({
    page: 'settings',
    navContext: {},
    history: [],
    snapshot: null,
    binding: null,
    config: null,
    desktopConfig: null,
    loading: false,
    refreshing: false,
    lastError: null,
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
      recentCommands: [...DEFAULT_PREFERENCES.recentCommands],
      language,
      asciiMode,
    },
    ...extra,
  });
}

async function createRetrievalSuiteContext(label, errorMsg) {
  const boxDir = await temps.make(label);
  const dshHome = join(boxDir, 'dsh-home');
  const libraryRoot = join(boxDir, 'library');
  await mkdir(libraryRoot, { recursive: true });
  process.env.DSH_HOME = dshHome;

  const state = {
    boxDir,
    dshHome,
    libraryRoot,
    host: null,
    fetchCalls: 0,
    activeTty: null,
    activeInk: null,
  };

  state.host = await createTuiHost({
    env: { DSH_HOME: dshHome },
    home: join(boxDir, 'home'),
    libraryRoot,
    skipAutoProbe: true,
    language: 'zh',
    eventDebounceMs: 30,
    fetch: async () => {
      state.fetchCalls += 1;
      throw new Error(errorMsg);
    },
  });

  return state;
}

async function unmountSuiteApp(state) {
  const ink = state.activeInk;
  const tty = state.activeTty;
  state.activeInk = null;
  state.activeTty = null;
  try {
    ink?.unmount();
  } catch {
    // Ignore unmount errors during teardown
  }
  tty?.dispose();
}

async function mountSettingsApp(
  state,
  { initialPage = 'settings', asciiMode = false, language = 'zh', cols = 120, rows = 36 } = {},
) {
  await unmountSuiteApp(state);
  process.env.DSH_HOME = state.dshHome;
  await saveTuiPreferences({ language, asciiMode }, { env: { DSH_HOME: state.dshHome } });
  state.host.setLanguage(language);
  resetTuiStore(language, asciiMode, { page: initialPage });

  const tty = createVirtualTty(cols, rows);
  let inkInstance = null;
  inkInstance = render(
    React.createElement(StudyHubTuiApp, {
      host: state.host,
      initialPage,
      initialLanguage: language,
      initialAsciiMode: asciiMode,
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
  state.activeTty = tty;
  state.activeInk = inkInstance;
  await tty.firstFramePromise;
  return tty;
}

after(async () => {
  resetTuiStore('zh', false);
  disposeTerminalPool();
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await temps.cleanup();
});

describe('Domain Settings Retrieval: Coverage, Diagnostics Planner & Hybrid Preview/Mirror', () => {
  describe('WorkspaceTab Retrieval Index Coverage, Provider Switch & HelpOverlay Sync (Round 50)', () => {
    let ctx;

    before(async () => {
      ctx = await createRetrievalSuiteContext(
        'r50',
        'Network/model call must not happen during retrieval coverage tests',
      );
    });

    after(async () => {
      await unmountSuiteApp(ctx);
      await ctx.host?.dispose();
    });

    test('1) createTuiHost integration: retrieval.index.coverage & retrieval.set builtin (0 model calls)', async () => {
      const emptyCov = await ctx.host.call('retrieval.index.coverage', {});
      assert.equal(emptyCov.ok, true, emptyCov.error?.message);
      assert.deepEqual(emptyCov.value.indexed, []);
      assert.deepEqual(emptyCov.value.stale, []);
      assert.deepEqual(emptyCov.value.missing, []);
      assert.equal(emptyCov.value.hasIndex, false);
      assert.equal(typeof emptyCov.value.canIndex, 'boolean');
      assert.equal(Boolean(emptyCov.value.building), false);

      for (let i = 1; i <= 2; i += 1) {
        const mdPath = join(ctx.boxDir, `r50-retrieval-${i}.md`);
        await writeFile(
          mdPath,
          `# Topic ${i}\n\nRetrieval coverage test material page ${i} with enough body text.\n`,
          'utf8',
        );
        const imp = await ctx.host.call('materials.document.import', {
          path: mdPath,
          title: `R50 Material ${i}`,
          format: 'md',
        });
        assert.equal(imp.ok, true, imp.error?.message);
      }

      const snap = await ctx.host.call('snapshot');
      assert.equal(snap.ok, true);
      const seededCount = snap.value.sources.length;
      assert.ok(seededCount >= 2, `expected >= 2 seeded sources, got ${seededCount}`);

      const seededCov = await ctx.host.call('retrieval.index.coverage', {});
      assert.equal(seededCov.ok, true, seededCov.error?.message);
      assert.equal(seededCov.value.indexed.length, 0);
      assert.equal(seededCov.value.stale.length, 0);
      assert.equal(seededCov.value.missing.length, seededCount);
      assert.equal(seededCov.value.hasIndex, false);
      assert.equal(typeof seededCov.value.canIndex, 'boolean');
      assert.equal(Boolean(seededCov.value.building), false);

      const setRes = await ctx.host.call('retrieval.set', { provider: 'builtin' });
      assert.equal(setRes.ok, true, setRes.error?.message);
      assert.equal(setRes.value.selected, 'builtin');
      assert.equal(setRes.value.effective, 'builtin');

      const statusRes = await ctx.host.call('retrieval.status', {});
      assert.equal(statusRes.ok, true, statusRes.error?.message);
      assert.equal(statusRes.value.effective, 'builtin');

      assert.equal(ctx.fetchCalls, 0, 'retrieval.index.coverage and retrieval.set must trigger 0 model/network calls');
    });

    test('2) PTY E2E: WorkspaceTab coverage + [v] provider cycle & HelpOverlay Round 50 sync at 120x36 & 80x24 (zh & --ascii en)', async () => {
      const snap = await ctx.host.call('snapshot');
      const totalSources = snap.value.sources.length;
      assert.ok(totalSources >= 2);

      // 2a) Default zh mode across 120x36 & 80x24
      const ttyZh = await mountSettingsApp(ctx, { initialPage: 'settings', asciiMode: false, language: 'zh', cols: 120, rows: 36 });
      await ttyZh.waitFor((s) => s.includes('模型配置') && s.includes('工作区'), {
        label: 'SettingsView rendered (zh)',
      });
      assert.equal(useTuiStore.getState().page, 'settings');

      ttyZh.send('2');
      const wsZhWide = await ttyZh.waitFor(
        (s) =>
          s.includes('语义检索:') &&
          s.includes(`索引 0/${totalSources}`) &&
          s.includes('[v] 切换'),
        { timeoutMs: 8_000, label: 'WorkspaceTab retrieval coverage & [v] 120x36 (zh)' },
      );
      ttyZh.assertHealthyScreen(wsZhWide, 120, 36, 'WorkspaceTab retrieval 120x36 zh');
      assert.ok(wsZhWide.includes('[v] 切换'), 'WorkspaceTab (zh) must show [v] 切换');

      ttyZh.send('v');
      const wsZhAfterV = await ttyZh.waitFor(
        (s) => s.includes('当前仅检测到内置检索 (builtin)'),
        { timeoutMs: 5_000, label: 'WorkspaceTab [v] toast (zh)' },
      );
      ttyZh.assertHealthyScreen(wsZhAfterV, 120, 36, 'WorkspaceTab after [v] 120x36 zh');
      assert.ok(wsZhAfterV.includes('builtin'), 'After [v] toast must mention builtin');

      // Resize to 80x24 and verify compact row fits cleanly
      ttyZh.resize(80, 24);
      const wsZhNarrow = await ttyZh.waitFor(
        (s) =>
          s.includes('语义检索:') &&
          s.includes(`索引 0/${totalSources}`) &&
          s.includes('[v] 切换') &&
          s.split('\n').length <= 24,
        { timeoutMs: 5_000, label: 'WorkspaceTab retrieval coverage 80x24 (zh)' },
      );
      ttyZh.assertHealthyScreen(wsZhNarrow, 80, 24, 'WorkspaceTab retrieval 80x24 zh');
      assert.ok(wsZhNarrow.split('\n').length <= 24, '80x24 screen must fit within 24 rows');

      // Open HelpOverlay ('?') and verify Round 50 entries across scroll positions
      ttyZh.resize(120, 36);
      await ttyZh.waitFor((s) => s.includes('语义检索:'), { label: 'WorkspaceTab restored 120x36 (zh)' });
      ttyZh.send('?');
      await ttyZh.waitFor((s) => s.includes('快捷键'), { label: 'HelpOverlay opened (zh)' });
      assert.equal(useTuiStore.getState().helpOpen, true);
      let sawSkelZh = false;
      let sawOrigZh = false;
      for (let step = 0; step < 12 && (!sawSkelZh || !sawOrigZh); step += 1) {
        ttyZh.send('\x04'); // Ctrl+D half-page scroll down
        await ttyZh.flush(15);
        const scr = ttyZh.readScreen();
        ttyZh.assertHealthyScreen(scr, 120, 36, `HelpOverlay scroll ${step} zh`);
        if (scr.includes('骨架互动图')) sawSkelZh = true;
        if (scr.includes('原始文件 / 目录大纲')) sawOrigZh = true;
      }
      assert.ok(sawSkelZh, 'HelpOverlay (zh) must include 骨架互动图');
      assert.ok(sawOrigZh, 'HelpOverlay (zh) must include 原始文件 / 目录大纲');
      ttyZh.send('G');
      const helpZhBottom = await ttyZh.waitFor(
        (s) => s.includes('切换语义检索提供方'),
        { timeoutMs: 5_000, label: 'HelpOverlay Round 50 Settings entry visible (zh)' },
      );
      ttyZh.assertHealthyScreen(helpZhBottom, 120, 36, 'HelpOverlay Round 50 entries zh');
      assert.ok(helpZhBottom.includes('切换语义检索提供方'));
      ttyZh.send('\x1b');
      await ttyZh.waitFor((s) => !s.includes('切换语义检索提供方') && !useTuiStore.getState().helpOpen, {
        label: 'HelpOverlay closed (zh)',
      });
      assert.equal(useTuiStore.getState().helpOpen, false);

      // 2b) --ascii en mode across 120x36 & 80x24
      const ttyEn = await mountSettingsApp(ctx, { initialPage: 'settings', asciiMode: true, language: 'en', cols: 120, rows: 36 });
      await ttyEn.waitFor((s) => s.includes('Models') && s.includes('Workspace'), {
        label: 'SettingsView rendered (en --ascii)',
      });

      ttyEn.send('2');
      const wsEnWide = await ttyEn.waitFor(
        (s) =>
          s.includes('Retrieval:') &&
          s.includes(`Idx 0/${totalSources}`) &&
          s.includes('[v] Switch'),
        { timeoutMs: 8_000, label: 'WorkspaceTab retrieval coverage & [v] 120x36 (en --ascii)' },
      );
      ttyEn.assertHealthyScreen(wsEnWide, 120, 36, 'WorkspaceTab retrieval 120x36 en --ascii');
      ttyEn.assertAsciiPure(wsEnWide, 'WorkspaceTab retrieval 120x36 en --ascii');
      assert.ok(wsEnWide.includes('[v] Switch'));

      ttyEn.send('v');
      const wsEnAfterV = await ttyEn.waitFor(
        (s) => s.includes('Only built-in retrieval is'),
        { timeoutMs: 5_000, label: 'WorkspaceTab [v] toast (en --ascii)' },
      );
      ttyEn.assertHealthyScreen(wsEnAfterV, 120, 36, 'WorkspaceTab after [v] 120x36 en --ascii');
      ttyEn.assertAsciiPure(wsEnAfterV, 'WorkspaceTab after [v] 120x36 en --ascii');

      ttyEn.resize(80, 24);
      const wsEnNarrow = await ttyEn.waitFor(
        (s) =>
          s.includes('Retrieval:') &&
          s.includes(`Idx 0/${totalSources}`) &&
          s.includes('[v] Switch') &&
          s.split('\n').length <= 24,
        { timeoutMs: 5_000, label: 'WorkspaceTab retrieval coverage 80x24 (en --ascii)' },
      );
      ttyEn.assertHealthyScreen(wsEnNarrow, 80, 24, 'WorkspaceTab retrieval 80x24 en --ascii');
      ttyEn.assertAsciiPure(wsEnNarrow, 'WorkspaceTab retrieval 80x24 en --ascii');
      assert.ok(wsEnNarrow.split('\n').length <= 24);

      ttyEn.resize(120, 36);
      await ttyEn.waitFor(
        (s) => s.includes('Retrieval:') && s.split('\n').length >= 30,
        { label: 'WorkspaceTab restored 120x36 (en --ascii)' },
      );
      ttyEn.send('?');
      const helpEnInit = await ttyEn.waitFor(
        (s) => s.includes('Keyboard Shortcuts') && s.split('\n').length >= 30,
        { label: 'HelpOverlay opened (en --ascii)' },
      );
      assert.equal(useTuiStore.getState().helpOpen, true);
      let sawSkelEn = helpEnInit.includes('Skeleton diagrams');
      let sawOrigEn = helpEnInit.includes('Original file / Outline TOC');
      for (let step = 0; step < 24 && (!sawSkelEn || !sawOrigEn); step += 1) {
        ttyEn.send('\x04'); // Ctrl+D half-page scroll down
        await ttyEn.flush(40);
        const scr = ttyEn.readScreen();
        ttyEn.assertHealthyScreen(scr, 120, 36, `HelpOverlay scroll ${step} en --ascii`);
        ttyEn.assertAsciiPure(scr, `HelpOverlay scroll ${step} en --ascii`);
        if (scr.includes('Skeleton diagrams')) sawSkelEn = true;
        if (scr.includes('Original file / Outline TOC')) sawOrigEn = true;
      }
      assert.ok(sawSkelEn, 'HelpOverlay (en --ascii) must include Skeleton diagrams');
      assert.ok(sawOrigEn, 'HelpOverlay (en --ascii) must include Original file / Outline TOC');
      ttyEn.send('G');
      const helpEnBottom = await ttyEn.waitFor(
        (s) => s.includes('Cycle retrieval provider'),
        { timeoutMs: 5_000, label: 'HelpOverlay Round 50 Settings entry visible (en --ascii)' },
      );
      ttyEn.assertHealthyScreen(helpEnBottom, 120, 36, 'HelpOverlay Round 50 entries en --ascii');
      ttyEn.assertAsciiPure(helpEnBottom, 'HelpOverlay Round 50 entries en --ascii');
      assert.ok(helpEnBottom.includes('Cycle retrieval provider'));

      assert.equal(ctx.fetchCalls, 0, 'PTY E2E must trigger 0 network/model calls');
    });
  });

  describe('WorkspaceTab Retrieval Index Planner & Connectivity Diagnostics (Round 57)', () => {
    let ctx;

    before(async () => {
      ctx = await createRetrievalSuiteContext(
        'r57',
        'Network/model call must not happen during retrieval diagnostics tests',
      );
    });

    after(async () => {
      await unmountSuiteApp(ctx);
      await ctx.host?.dispose();
    });

    test('1) createTuiHost integration: retrieval.index.plan & retrieval.test builtin (0 model calls)', async () => {
      for (let i = 1; i <= 2; i += 1) {
        const mdPath = join(ctx.boxDir, `r57-diag-${i}.md`);
        await writeFile(
          mdPath,
          `# Concept ${i}\n\nRound 57 semantic retrieval planner diagnostic page ${i} content.\n`,
          'utf8',
        );
        const imp = await ctx.host.call('materials.document.import', {
          path: mdPath,
          title: `R57 Material ${i}`,
          format: 'md',
        });
        assert.equal(imp.ok, true, imp.error?.message);
      }

      const planRes = await ctx.host.call('retrieval.index.plan', {});
      assert.equal(planRes.ok, true, planRes.error?.message);
      assert.equal(planRes.value.pages, 2);
      assert.equal(planRes.value.toIndex, 2);
      assert.equal(planRes.value.unchanged, 0);
      assert.equal(planRes.value.skipped, 0);
      assert.equal(planRes.value.toRemove, 0);
      assert.ok(planRes.value.chars > 0, 'expected positive chars in index plan');
      assert.equal(typeof planRes.value.firstRun, 'boolean');
      assert.equal(typeof planRes.value.modelMb, 'number');
      assert.equal(typeof planRes.value.canIndex, 'boolean');

      const testRes = await ctx.host.call('retrieval.test', {});
      assert.equal(testRes.ok, true, testRes.error?.message);
      assert.deepEqual(testRes.value, { ok: false, reason: 'builtin' });

      assert.equal(ctx.fetchCalls, 0, 'retrieval.index.plan and retrieval.test must trigger 0 model/network calls');
    });

    test('2) PTY E2E: WorkspaceTab [t] retrieval diagnostics modal at 120x36 (zh) & 80x24 (--ascii en)', async () => {
      // 2a) 120x36 zh
      const ttyZh = await mountSettingsApp(ctx, { initialPage: 'settings', asciiMode: false, language: 'zh', cols: 120, rows: 36 });
      await ttyZh.waitFor((s) => s.includes('模型配置') && s.includes('工作区'), {
        label: 'SettingsView rendered (zh)',
      });

      ttyZh.send('2');
      const wsZh = await ttyZh.waitFor(
        (s) => s.includes('语义检索:') && s.includes('[v] 切换') && s.includes('[t] 诊断'),
        { timeoutMs: 8_000, label: 'WorkspaceTab [t] 诊断 hint visible (zh)' },
      );
      ttyZh.assertHealthyScreen(wsZh, 120, 36, 'WorkspaceTab 120x36 zh');
      assert.ok(wsZh.includes('[t] 诊断'));

      ttyZh.send('t');
      const modalZh = await ttyZh.waitFor(
        (s) =>
          s.includes('语义检索诊断与索引计划') &&
          s.includes('内置词法检索 (builtin)') &&
          s.includes('总页数 2') &&
          s.includes('待索引 2') &&
          s.includes('未变更 0'),
        { timeoutMs: 8_000, label: 'Retrieval diagnostics modal rendered (zh)' },
      );
      ttyZh.assertHealthyScreen(modalZh, 120, 36, 'RetrievalDiagModal 120x36 zh');
      assert.ok(modalZh.includes('语义检索诊断与索引计划'));
      assert.ok(modalZh.includes('总页数 2'));

      ttyZh.send('r');
      const refreshedZh = await ttyZh.waitFor(
        (s) =>
          !s.includes('正在刷新诊断') &&
          s.includes('语义检索诊断与索引计划') &&
          s.includes('总页数 2') &&
          s.includes('内置词法检索 (builtin)'),
        { timeoutMs: 8_000, label: 'Retrieval diagnostics modal refreshed via [r] (zh)' },
      );
      ttyZh.assertHealthyScreen(refreshedZh, 120, 36, 'RetrievalDiagModal refreshed 120x36 zh');
      assert.ok(refreshedZh.includes('待索引 2'));

      ttyZh.send('\x1b');
      const closedZh = await ttyZh.waitFor(
        (s) => !s.includes('语义检索诊断与索引计划') && s.includes('[t] 诊断'),
        { timeoutMs: 5_000, label: 'Retrieval diagnostics modal closed via Esc (zh)' },
      );
      ttyZh.assertHealthyScreen(closedZh, 120, 36, 'WorkspaceTab after modal close 120x36 zh');
      assert.equal(useTuiStore.getState().page, 'settings');

      // 2b) 80x24 --ascii en
      const ttyEn = await mountSettingsApp(ctx, { initialPage: 'settings', asciiMode: true, language: 'en', cols: 80, rows: 24 });
      await ttyEn.waitFor((s) => s.includes('Models') && s.includes('Workspace'), {
        label: 'SettingsView rendered (en --ascii)',
      });

      ttyEn.send('2');
      const wsEn = await ttyEn.waitFor(
        (s) => s.includes('Retrieval:') && s.includes('[v] Switch') && s.includes('[t] Diag'),
        { timeoutMs: 8_000, label: 'WorkspaceTab [t] Diag hint visible 80x24 (en --ascii)' },
      );
      ttyEn.assertHealthyScreen(wsEn, 80, 24, 'WorkspaceTab 80x24 en --ascii');
      ttyEn.assertAsciiPure(wsEn, 'WorkspaceTab 80x24 en --ascii');
      assert.ok(wsEn.includes('[t] Diag'));

      ttyEn.send('t');
      const modalEn = await ttyEn.waitFor(
        (s) =>
          s.includes('Retrieval Diagnostics & Index Plan') &&
          s.includes('Built-in lexical search (builtin)') &&
          s.includes('Pages 2') &&
          s.includes('To Index 2') &&
          s.includes('Unchanged 0'),
        { timeoutMs: 8_000, label: 'Retrieval diagnostics modal rendered 80x24 (en --ascii)' },
      );
      ttyEn.assertHealthyScreen(modalEn, 80, 24, 'RetrievalDiagModal 80x24 en --ascii');
      ttyEn.assertAsciiPure(modalEn, 'RetrievalDiagModal 80x24 en --ascii');
      assert.ok(modalEn.includes('To Index 2'));

      ttyEn.send('r');
      const refreshedEn = await ttyEn.waitFor(
        (s) =>
          !s.includes('Refreshing diagnostics') &&
          s.includes('Retrieval Diagnostics & Index Plan') &&
          s.includes('Pages 2') &&
          s.includes('Built-in lexical search (builtin)'),
        { timeoutMs: 8_000, label: 'Retrieval diagnostics modal refreshed via [r] 80x24 (en --ascii)' },
      );
      ttyEn.assertHealthyScreen(refreshedEn, 80, 24, 'RetrievalDiagModal refreshed 80x24 en --ascii');
      ttyEn.assertAsciiPure(refreshedEn, 'RetrievalDiagModal refreshed 80x24 en --ascii');
      assert.ok(refreshedEn.includes('Unchanged 0'));

      // Close modal with 'q' (must close modal cleanly without quitting app)
      ttyEn.send('q');
      const closedEn = await ttyEn.waitFor(
        (s) => !s.includes('Retrieval Diagnostics & Index Plan') && s.includes('[t] Diag'),
        { timeoutMs: 5_000, label: 'Retrieval diagnostics modal closed via [q] 80x24 (en --ascii)' },
      );
      ttyEn.assertHealthyScreen(closedEn, 80, 24, 'WorkspaceTab after modal close 80x24 en --ascii');
      ttyEn.assertAsciiPure(closedEn, 'WorkspaceTab after modal close 80x24 en --ascii');
      assert.equal(useTuiStore.getState().page, 'settings');

      assert.equal(ctx.fetchCalls, 0, 'PTY E2E must trigger 0 network/model calls');
    });
  });

  describe('WorkspaceTab Local Hybrid Retrieval Preview & HF Mirror Endpoint (Round 58)', () => {
    let ctx;

    before(async () => {
      ctx = await createRetrievalSuiteContext(
        'r58',
        'Network/model call must not happen during retrieval tools tests',
      );
    });

    after(async () => {
      await unmountSuiteApp(ctx);
      await ctx.host?.dispose();
    });

    test('1) createTuiHost integration: retrieval.preview (localHybrid) & retrieval.endpoint.set (0 model calls)', async () => {
      const mdPath = join(ctx.boxDir, 'r58-qft.md');
      await writeFile(
        mdPath,
        '# Quantum Computing\n\nThe Quantum Fourier Transform algorithm maps amplitudes into phase frequencies.\n',
        'utf8',
      );
      const imp = await ctx.host.call('materials.document.import', {
        path: mdPath,
        title: 'Quantum Notes',
        format: 'md',
      });
      assert.equal(imp.ok, true, imp.error?.message);

      const emptyRes = await ctx.host.call('retrieval.preview', { query: '', localHybrid: true, limit: 5 });
      assert.equal(emptyRes.ok, false);
      assert.ok(emptyRes.error?.message?.includes('请先写下要检索的主题'));

      const prevRes = await ctx.host.call('retrieval.preview', {
        query: 'Quantum Fourier',
        localHybrid: true,
        limit: 5,
      });
      assert.equal(prevRes.ok, true, prevRes.error?.message);
      assert.equal(prevRes.value.provider, 'builtin');
      assert.ok(prevRes.value.hits >= 1, `expected hits >= 1, got ${prevRes.value.hits}`);
      assert.ok(Array.isArray(prevRes.value.pages) && prevRes.value.pages.length >= 1, 'expected matched pages');
      assert.ok(
        prevRes.value.pages[0].snippet?.includes('Quantum Fourier'),
        `expected snippet to include Quantum Fourier, got ${JSON.stringify(prevRes.value.pages[0])}`,
      );
      assert.equal(prevRes.value.pages[0].title, 'Quantum Notes');

      const setRes = await ctx.host.call('retrieval.endpoint.set', { endpoint: 'https://hf-mirror.com' });
      assert.equal(setRes.ok, true, setRes.error?.message);
      assert.equal(setRes.value.hfEndpoint, 'https://hf-mirror.com');

      const statusAfterSet = await ctx.host.call('retrieval.status', {});
      assert.equal(statusAfterSet.ok, true, statusAfterSet.error?.message);
      assert.equal(statusAfterSet.value.hfEndpoint, 'https://hf-mirror.com');

      const resetRes = await ctx.host.call('retrieval.endpoint.set', { endpoint: '' });
      assert.equal(resetRes.ok, true, resetRes.error?.message);
      assert.equal(resetRes.value.hfEndpoint, undefined);

      assert.equal(ctx.fetchCalls, 0, 'retrieval.preview and retrieval.endpoint.set must trigger 0 model/network calls');
    });

    test('2) PTY E2E: WorkspaceTab [t] -> [s] local preview search & [m] HF mirror editor at 120x36 (zh) & 80x24 (--ascii en)', async () => {
      // 2a) 120x36 zh
      const ttyZh = await mountSettingsApp(ctx, { initialPage: 'settings', asciiMode: false, language: 'zh', cols: 120, rows: 36 });
      await ttyZh.waitFor((s) => s.includes('模型配置') && s.includes('工作区'), {
        label: 'SettingsView rendered (zh)',
      });

      ttyZh.send('2');
      await ttyZh.waitFor(
        (s) => s.includes('语义检索:') && s.includes('[t] 诊断'),
        { timeoutMs: 8_000, label: 'WorkspaceTab [t] 诊断 visible (zh)' },
      );

      ttyZh.send('t');
      const modalZh = await ttyZh.waitFor(
        (s) =>
          s.includes('语义检索诊断与索引计划') &&
          s.includes('模型镜像: 默认 (HuggingFace)') &&
          s.includes('试搜') &&
          s.includes('镜像源'),
        { timeoutMs: 8_000, label: 'RetrievalDiagModal summary rendered (zh)' },
      );
      ttyZh.assertHealthyScreen(modalZh, 120, 36, 'RetrievalDiagModal summary 120x36 zh');
      assert.ok(modalZh.includes('模型镜像: 默认 (HuggingFace)'));

      // [s] -> Esc returns to summary without closing modal
      ttyZh.send('s');
      await ttyZh.waitFor(
        (s) => s.includes('输入本地混合检索试搜主题'),
        { timeoutMs: 5_000, label: 'preview-input opened (zh)' },
      );
      ttyZh.send('\x1b');
      const backToSummaryZh = await ttyZh.waitFor(
        (s) => s.includes('语义检索诊断与索引计划') && !s.includes('输入本地混合检索试搜主题'),
        { timeoutMs: 5_000, label: 'Esc returned from preview-input to summary (zh)' },
      );
      assert.ok(backToSummaryZh.includes('语义检索诊断与索引计划'));

      // [s] -> type 'Quantum Fourier' + Enter -> preview hits render
      ttyZh.send('s');
      await ttyZh.waitFor(
        (s) => s.includes('输入本地混合检索试搜主题'),
        { timeoutMs: 5_000, label: 'preview-input reopened (zh)' },
      );
      ttyZh.send('Quantum Fourier');
      await ttyZh.waitFor((s) => s.includes('Quantum Fourier'), {
        timeoutMs: 3_000,
        label: 'preview-input typed Quantum Fourier (zh)',
      });
      ttyZh.send('\r');
      const previewZh = await ttyZh.waitFor(
        (s) =>
          s.includes('试搜命中') &&
          s.includes('Quantum Fourier') &&
          s.includes('Quantum Notes'),
        { timeoutMs: 8_000, label: 'preview hits rendered in summary (zh)' },
      );
      ttyZh.assertHealthyScreen(previewZh, 120, 36, 'RetrievalDiagModal preview hits 120x36 zh');
      assert.ok(previewZh.includes('试搜命中'));
      assert.ok(previewZh.includes('Quantum Notes'));

      // [m] -> type 'https://hf-mirror.com' + Enter -> saved & displayed
      ttyZh.send('m');
      await ttyZh.waitFor(
        (s) => s.includes('设置模型下载镜像地址'),
        { timeoutMs: 5_000, label: 'endpoint-input opened (zh)' },
      );
      ttyZh.send('https://hf-mirror.com');
      await ttyZh.waitFor((s) => s.includes('https://hf-mirror.com'), {
        timeoutMs: 3_000,
        label: 'endpoint-input typed hf-mirror (zh)',
      });
      ttyZh.send('\r');
      const mirrorSavedZh = await ttyZh.waitFor(
        (s) =>
          s.includes('模型镜像: https://hf-mirror.com') &&
          s.includes('已保存模型下载镜像'),
        { timeoutMs: 8_000, label: 'HF mirror saved & displayed (zh)' },
      );
      ttyZh.assertHealthyScreen(mirrorSavedZh, 120, 36, 'RetrievalDiagModal mirror saved 120x36 zh');
      assert.ok(mirrorSavedZh.includes('模型镜像: https://hf-mirror.com'));

      const persisted = await ctx.host.call('retrieval.status', {});
      assert.equal(persisted.ok, true);
      assert.equal(persisted.value.hfEndpoint, 'https://hf-mirror.com');

      // 2b) 80x24 --ascii en (verifies persisted hfEndpoint, preview search, reset to default, and pure ASCII)
      const ttyEn = await mountSettingsApp(ctx, { initialPage: 'settings', asciiMode: true, language: 'en', cols: 80, rows: 24 });
      await ttyEn.waitFor((s) => s.includes('Models') && s.includes('Workspace'), {
        label: 'SettingsView rendered (en --ascii)',
      });

      ttyEn.send('2');
      await ttyEn.waitFor(
        (s) => s.includes('Retrieval:') && s.includes('[t] Diag'),
        { timeoutMs: 8_000, label: 'WorkspaceTab [t] Diag visible (en --ascii)' },
      );

      ttyEn.send('t');
      const modalEn = await ttyEn.waitFor(
        (s) =>
          s.includes('Retrieval Diagnostics & Index Plan') &&
          s.includes('HF Endpoint: https://hf-mirror.com') &&
          s.includes('Search') &&
          s.includes('Mirror'),
        { timeoutMs: 8_000, label: 'RetrievalDiagModal summary rendered 80x24 (en --ascii)' },
      );
      ttyEn.assertHealthyScreen(modalEn, 80, 24, 'RetrievalDiagModal summary 80x24 en --ascii');
      ttyEn.assertAsciiPure(modalEn, 'RetrievalDiagModal summary 80x24 en --ascii');
      assert.ok(modalEn.includes('HF Endpoint: https://hf-mirror.com'));

      // [s] -> type 'Quantum Fourier' + Enter -> preview hits render at 80x24
      ttyEn.send('s');
      await ttyEn.waitFor(
        (s) => s.includes('Enter topic for local hybrid search preview'),
        { timeoutMs: 5_000, label: 'preview-input opened 80x24 (en --ascii)' },
      );
      ttyEn.send('Quantum Fourier');
      await ttyEn.waitFor((s) => s.includes('Quantum Fourier'), {
        timeoutMs: 3_000,
        label: 'preview-input typed Quantum Fourier 80x24 (en --ascii)',
      });
      ttyEn.send('\r');
      const previewEn = await ttyEn.waitFor(
        (s) =>
          s.includes('Search Preview') &&
          s.includes('Quantum Notes') &&
          s.includes('Quantum Fourier'),
        { timeoutMs: 8_000, label: 'preview hits rendered 80x24 (en --ascii)' },
      );
      ttyEn.assertHealthyScreen(previewEn, 80, 24, 'RetrievalDiagModal preview hits 80x24 en --ascii');
      ttyEn.assertAsciiPure(previewEn, 'RetrievalDiagModal preview hits 80x24 en --ascii');
      assert.ok(previewEn.includes('Search Preview'));

      // [m] -> Ctrl+U clears pre-filled endpoint -> Enter resets to Default
      ttyEn.send('m');
      await ttyEn.waitFor(
        (s) => s.includes('Set HuggingFace mirror endpoint') && s.includes('https://hf-mirror.com'),
        { timeoutMs: 5_000, label: 'endpoint-input pre-filled 80x24 (en --ascii)' },
      );
      ttyEn.send('\x15');
      await ttyEn.waitFor(
        (s) => s.includes('Set HuggingFace mirror endpoint') && s.includes('(empty resets to default)'),
        { timeoutMs: 3_000, label: 'endpoint-input cleared via Ctrl+U 80x24 (en --ascii)' },
      );
      ttyEn.send('\r');
      const resetEn = await ttyEn.waitFor(
        (s) =>
          s.includes('HF Endpoint: Default') &&
          s.includes('Reset HF endpoint'),
        { timeoutMs: 8_000, label: 'HF mirror reset to Default 80x24 (en --ascii)' },
      );
      ttyEn.assertHealthyScreen(resetEn, 80, 24, 'RetrievalDiagModal mirror reset 80x24 en --ascii');
      ttyEn.assertAsciiPure(resetEn, 'RetrievalDiagModal mirror reset 80x24 en --ascii');
      assert.ok(resetEn.includes('HF Endpoint: Default'));

      const afterReset = await ctx.host.call('retrieval.status', {});
      assert.equal(afterReset.ok, true);
      assert.equal(afterReset.value.hfEndpoint, undefined);

      ttyEn.send('\x1b');
      const closedEn = await ttyEn.waitFor(
        (s) => !s.includes('Retrieval Diagnostics & Index Plan') && s.includes('[t] Diag'),
        { timeoutMs: 5_000, label: 'RetrievalDiagModal closed via Esc 80x24 (en --ascii)' },
      );
      ttyEn.assertHealthyScreen(closedEn, 80, 24, 'WorkspaceTab after modal close 80x24 en --ascii');
      ttyEn.assertAsciiPure(closedEn, 'WorkspaceTab after modal close 80x24 en --ascii');
      assert.equal(useTuiStore.getState().page, 'settings');

      assert.equal(ctx.fetchCalls, 0, 'PTY E2E must trigger 0 network/model calls');
    });
  });
});
