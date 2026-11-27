// P4 (#1354 D12): WorkspaceTab.tsx split behavioral regression suite (line limit: scripts/line-limit-guard.mjs).
// Run: node --test tests/p4-workspace-tab-split-regression.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { Box, render } from 'ink';
import React from 'react';
import stripAnsi from 'strip-ansi';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
const tempDirs = [];

after(async () => {
  unregisterTsx?.();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
});

const [
  workspaceTabMod,
  workspaceModelMod,
  { useTuiStore, DEFAULT_PREFERENCES },
  { useKeyDispatcherBridge },
  { ShellActionsContext },
] = await Promise.all([
  import('../src/views/settings/WorkspaceTab.js'),
  import('../src/views/settings/workspace-model.js'),
  import('../src/state/store.js'),
  import('../src/input/hooks.js'),
  import('../src/shell/actions.js'),
]);

const {
  WorkspaceTab,
  atomicWriteJsonFile,
  atomicWriteTextFile,
  defaultBackupPath,
  describeRetrievalCoverage,
  resolveBackupPath,
  summarizeExportPayload,
  truncatePathMiddle,
} = workspaceTabMod;

const {
  buildRetrievalProviderChoices,
  describeAutoUpdateBadge,
  describeRetrievalBadge,
  describeUpdateStatusBadge,
  describeUsageBadge,
  describeUsageReportState,
  formatBytes,
} = workspaceModelMod;

const UNICODE_UI_CHROME_RE =
  /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u27BF\u2800-\u28FF\u2190-\u21FF\u2022\u2026\u2039\u203A]/g;

async function makeTempDir(label) {
  const dir = await mkdtemp(path.join(os.tmpdir(), `studyhub-p4-ws-${label}-`));
  tempDirs.push(dir);
  return dir;
}

function resetTuiStore({ language = 'zh', asciiMode = false, snapshot = null, desktopConfig = null } = {}) {
  useTuiStore.setState({
    page: 'settings',
    navContext: {},
    history: [],
    snapshot,
    binding: null,
    config: null,
    desktopConfig,
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
  });
}

function KeyBridgeShellWrapper({ cols, rows, actions, children }) {
  useKeyDispatcherBridge();
  return React.createElement(
    ShellActionsContext.Provider,
    { value: actions },
    React.createElement(Box, { width: cols, height: rows }, children),
  );
}

function mountWorkspaceTab({ host, binding, cols = 104, rows = 30, onRefreshBinding, onRefreshSnapshot }) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;

  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = cols;
  stdout.rows = rows;
  stdout.getColorDepth = () => 1;

  let latest = '';
  const listeners = new Set();
  const activeTimers = new Set();

  stdout.on('data', (chunk) => {
    const plain = stripAnsi(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    if (plain.trim()) {
      latest = plain;
      for (const fn of [...listeners]) fn();
    }
  });

  const noop = async () => {};
  const actions = {
    refresh: onRefreshSnapshot ?? noop,
    loadSample: noop,
    importSource: () => {},
    openModelSettings: () => {},
    setCourse: noop,
    createCourse: noop,
    quit: () => {},
  };

  const instance = render(
    React.createElement(
      KeyBridgeShellWrapper,
      { cols, rows, actions },
      React.createElement(WorkspaceTab, {
        host,
        binding,
        width: cols,
        height: rows,
        isActive: true,
        onRefreshBinding: onRefreshBinding ?? noop,
      }),
    ),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false, debug: true },
  );

  function waitFor(pred, { timeoutMs = 4_000, label = 'condition' } = {}) {
    if (pred(latest)) return Promise.resolve(latest);
    return new Promise((resolveWait, rejectWait) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        listeners.delete(check);
        clearInterval(poll);
        clearTimeout(timer);
        activeTimers.delete(poll);
        activeTimers.delete(timer);
      };
      const check = () => {
        if (settled) return;
        if (pred(latest)) {
          done();
          resolveWait(latest);
        }
      };
      const poll = setInterval(check, 25);
      const timer = setTimeout(() => {
        if (settled) return;
        const snap = latest;
        done();
        rejectWait(new Error(`Timed out waiting for ${label} after ${timeoutMs}ms.\n--- FRAME ---\n${snap}\n-------------`));
      }, timeoutMs);
      activeTimers.add(poll);
      activeTimers.add(timer);
      listeners.add(check);
      setImmediate(check);
    });
  }

  return {
    send: (data) => stdin.write(data),
    frame: () => latest,
    waitFor,
    cleanup() {
      for (const handle of activeTimers) {
        clearTimeout(handle);
        clearInterval(handle);
      }
      activeTimers.clear();
      listeners.clear();
      stdout.removeAllListeners();
      instance.unmount();
      stdin.destroy();
      stdout.destroy();
    },
  };
}

function createWorkspaceHost({ libraryRoot, handlers = {} }) {
  const calls = [];
  let experimental = false;
  let autoCheck = true;
  let snoozed = false;
  let retrievalSelected = 'builtin';
  let hfEndpoint = '';
  let usageEnabled = true;
  let usagePaused = false;

  const defaultHandlers = {
    'experimental.get': () => ({ ok: true, value: { enabled: experimental } }),
    'experimental.set': (params) => {
      experimental = Boolean(params?.enabled);
      return { ok: true, value: { enabled: experimental } };
    },
    'retrieval.status': () => ({
      ok: true,
      value: {
        selected: retrievalSelected,
        effective: retrievalSelected,
        hfEndpoint,
        hostCanSearch: true,
        providers: [
          { id: 'builtin', label: 'Builtin Lexical' },
          { id: 'local-hybrid', label: 'Local Hybrid' },
        ],
        otherTools: [{ name: 'local-rag' }],
      },
    }),
    'retrieval.set': (params) => {
      retrievalSelected = String(params?.provider || 'builtin');
      return defaultHandlers['retrieval.status']();
    },
    'retrieval.index.coverage': () => ({
      ok: true,
      value: {
        indexed: ['p1', 'p2', 'p3', 'p4'],
        stale: ['p5'],
        missing: [],
        migrate: ['p6'],
        hasIndex: true,
        canIndex: true,
        building: false,
      },
    }),
    'retrieval.index.plan': () => ({
      ok: true,
      value: {
        course: 'CS162',
        pages: 12,
        toIndex: 3,
        unchanged: 8,
        skipped: 1,
        toRemove: 0,
        chars: 14820,
        firstRun: false,
        modelMb: 92,
        canIndex: true,
      },
    }),
    'retrieval.test': () => ({
      ok: true,
      value: {
        ok: true,
        provider: retrievalSelected,
        reason: retrievalSelected === 'builtin' ? 'builtin' : undefined,
        hits: 4,
        matched: 3,
        unresolved: 0,
      },
    }),
    'retrieval.preview': (params) => ({
      ok: true,
      value: {
        provider: 'local-hybrid',
        query: String(params?.query || ''),
        hits: 2,
        pages: [
          { sourceId: 'src-1', title: 'OS Notes', page: 7, snippet: 'Virtual memory page table overview' },
          { sourceId: 'src-2', title: 'Lab Guide', page: 2, snippet: 'TLB miss handling sequence' },
        ],
      },
    }),
    'retrieval.endpoint.set': (params) => {
      hfEndpoint = String(params?.endpoint || '');
      return defaultHandlers['retrieval.status']();
    },
    'usage.frequency.status': () => ({
      ok: true,
      value: {
        enabled: usageEnabled,
        paused: usagePaused,
        hasData: true,
        daysWithData: 5,
        since: '2026-11-20',
      },
    }),
    'usage.frequency.set': (params) => {
      if (typeof params?.enabled === 'boolean') {
        usageEnabled = params.enabled;
        if (usageEnabled) usagePaused = false;
      }
      if (typeof params?.paused === 'boolean') {
        usagePaused = params.paused;
      }
      return defaultHandlers['usage.frequency.status']();
    },
    'usage.frequency.clear': () => ({
      ok: true,
      value: {
        enabled: usageEnabled,
        paused: usagePaused,
        hasData: false,
        daysWithData: 0,
        since: '2026-11-26',
      },
    }),
    'usage.frequency.report': (params) => ({
      ok: true,
      value: {
        period: params?.period ?? 30,
        language: params?.language ?? 'zh',
        summary: {
          daysWithData: 5,
          interactions: 42,
          distinctControls: 9,
        },
        ranking: [
          { key: 'review.grade', name: 'FSRS Grade', count: 24, share: 0.57 },
          { key: 'settings.workspace', name: 'Workspace Settings', count: 10, share: 0.24 },
        ],
        observations: [
          { id: 'obs-1', key: 'review.grade', text: 'Most interactions happen during spaced repetition review.' },
        ],
      },
    }),
    'usage.frequency.export': (params) => ({
      ok: true,
      value: {
        filename: 'usage.json',
        mime: 'application/json',
        content: JSON.stringify({ period: params?.period ?? 30, interactions: 42 }, null, 2),
      },
    }),
    'update.preferences': (params) => {
      if (typeof params?.autoCheck === 'boolean') autoCheck = params.autoCheck;
      if (params && 'snooze' in params) snoozed = Boolean(params.snooze);
      return {
        ok: true,
        value: {
          current: '1.2.0',
          latest: '1.3.0',
          newer: true,
          publishedAt: '2026-11-25T10:00:00Z',
          notes: 'Faster terminal rendering and backup safety improvements.',
          url: 'https://github.com/EricWang1358/dsh-web-studyhub/releases/tag/v1.3.0',
          autoCheck,
          snoozed,
        },
      };
    },
    'update.check': () => ({
      ok: true,
      value: {
        current: '1.2.0',
        latest: '1.3.0',
        newer: true,
        publishedAt: '2026-11-25T10:00:00Z',
        notes: 'Faster terminal rendering and backup safety improvements.',
        url: 'https://github.com/EricWang1358/dsh-web-studyhub/releases/tag/v1.3.0',
        autoCheck,
        snoozed,
      },
    }),
    'library.restorePoints.list': () => ({
      ok: true,
      value: {
        points: [
          {
            id: 'rp-1',
            createdAt: '2026-11-26T09:15:00Z',
            reason: 'auto-save',
            sizeBytes: 4096,
            summary: { cards: 18, decks: 2 },
          },
          {
            id: 'rp-2',
            createdAt: '2026-11-25T18:00:00Z',
            tier: 'daily',
            extraBytes: 8192,
            cards: 14,
          },
        ],
      },
    }),
    'library.restorePoints.restore': () => ({ ok: true, value: { restored: true } }),
    'library.context': () => ({
      ok: true,
      value: {
        library: libraryRoot,
        timeZone: 'Asia/Shanghai',
        today: '2026-11-26',
        focus: { course: 'CS162', role: 'student' },
        counts: { sources: 4, decks: 3, archivedDecks: 1, drafts: 2, cards: 64 },
        courses: ['CS162', 'MATH201', 'PHYS101', 'HIST105', 'ECON102'],
        coursesPage: { total: 5, offset: 0, nextOffset: null },
        areas: ['sources', 'decks', 'review'],
      },
    }),
    'binding.set': (params) => ({
      ok: true,
      value: { root: params?.root, defaultRoot: libraryRoot, rootSource: 'custom' },
    }),
    'desktop.library.confirm': () => ({ ok: true, value: { confirmed: true } }),
    'sample.load': () => ({ ok: true, value: { loaded: true } }),
    'sample.remove': () => ({ ok: true, value: { removed: true } }),
    export: () => ({
      ok: true,
      value: {
        decks: [
          { id: 'd1', cards: [{ id: 'c1' }, { id: 'c2' }] },
          { id: 'd2', cards: [{ id: 'c3' }] },
        ],
        portableMaterials: { referencedOriginals: ['/tmp/lecture1.pdf'] },
      },
    }),
  };

  const host = {
    mode: 'embedded',
    getLibraryRoot: () => libraryRoot,
    snapshot: async () => null,
    call: async (action, params = {}) => {
      calls.push({ action, params });
      if (Object.hasOwn(handlers, action)) {
        return handlers[action](params, defaultHandlers[action]);
      }
      if (Object.hasOwn(defaultHandlers, action)) {
        return defaultHandlers[action](params);
      }
      return { ok: true, value: {} };
    },
    stream: async () => {},
    dispose: async () => {},
  };

  return { host, calls };
}

describe('P4 (#1354): WorkspaceTab split behavioral regression', () => {
  test('2) Public WorkspaceTab exports preserve backup path sandbox, export summary, path truncation, and retrieval coverage semantics', async () => {
    const libRoot = await makeTempDir('exports');

    const defaultPath = defaultBackupPath(libRoot);
    assert.ok(defaultPath.startsWith(path.join(libRoot, 'backups', 'studyhub-backup-')));
    assert.match(defaultPath, /\.json$/);

    assert.equal(resolveBackupPath('   ', libRoot), '');
    assert.equal(resolveBackupPath('snap-a', libRoot), path.join(libRoot, 'backups', 'snap-a.json'));
    assert.equal(resolveBackupPath(defaultPath, libRoot), defaultPath);
    assert.throws(() => resolveBackupPath('../outside.json', libRoot), /Unsafe export path/);
    assert.throws(() => resolveBackupPath('/etc/passwd', libRoot), /Unsafe export path/);

    assert.deepEqual(summarizeExportPayload(null), { decksCount: 0, cardsCount: 0, referencedOriginals: 0 });
    assert.deepEqual(
      summarizeExportPayload({
        decks: [{ cards: [1, 2] }, { cards: [3] }, {}],
        portableMaterials: { referencedOriginals: ['a.pdf', 'b.pdf'] },
      }),
      { decksCount: 3, cardsCount: 3, referencedOriginals: 2 },
    );

    assert.equal(truncatePathMiddle('/short/dir', 20), '/short/dir');
    const midAscii = truncatePathMiddle('/Users/learner/Documents/Courses/StudyHub-Library-2026', 28, '...');
    assert.ok(midAscii.includes('...'));
    assert.ok(midAscii.endsWith('StudyHub-Library-2026') || midAscii.includes('Library-2026'));

    assert.equal(describeRetrievalCoverage(null, 'zh', false), '');
    assert.equal(
      describeRetrievalCoverage({ indexed: [], stale: [], missing: [], hasIndex: false, canIndex: true, building: true }, 'en', true),
      '0 pages, building',
    );
    assert.equal(
      describeRetrievalCoverage(
        { indexed: ['a', 'b'], stale: ['c'], missing: ['d'], migrate: ['e'], hasIndex: true, canIndex: true, building: false },
        'zh',
        false,
      ),
      '索引 2/5 · 过期 1 · 待升级 1',
    );

    const jsonTarget = path.join(libRoot, 'check.json');
    const txtTarget = path.join(libRoot, 'check.txt');
    await atomicWriteJsonFile(jsonTarget, { ok: true });
    await atomicWriteTextFile(txtTarget, 'hello');
    assert.deepEqual(JSON.parse(await readFile(jsonTarget, 'utf8')), { ok: true });
    assert.equal(await readFile(txtTarget, 'utf8'), 'hello');
  });

  test('3) WorkspaceTab main panel toggles ([c], [f], [u], [a], [v], Ctrl+R) and --ascii purity in en mode', async () => {
    const libRoot = await makeTempDir('toggles');
    let bindingRefreshed = 0;
    let experimentalFailOnce = true;

    resetTuiStore({
      language: 'en',
      asciiMode: true,
      snapshot: { revision: 1, experimental: false, sample: { loaded: false } },
      desktopConfig: { libraryPlaceConfirmed: false },
    });

    const { host, calls } = createWorkspaceHost({
      libraryRoot: libRoot,
      handlers: {
        'experimental.set': (params, fallback) => {
          if (experimentalFailOnce) {
            experimentalFailOnce = false;
            return { ok: false, error: { code: 'ERR', message: 'Toggle denied' } };
          }
          return fallback(params);
        },
      },
    });

    const app = mountWorkspaceTab({
      host,
      binding: { root: libRoot, defaultRoot: libRoot, rootSource: 'default' },
      cols: 108,
      rows: 30,
      onRefreshBinding: async () => {
        bindingRefreshed += 1;
      },
    });

    try {
      const initial = await app.waitFor(
        (f) => f.includes('Idx 4/6, 1 stale, 1 to upgrade') && f.includes('auto-save'),
        { label: 'WorkspaceTab initial render (en ascii)' },
      );
      assert.equal(initial.match(UNICODE_UI_CHROME_RE), null, `ASCII mode leaked Unicode chrome:\n${initial}`);
      assert.ok(initial.includes('Unconfirmed [c]'));

      // [c] confirms library place
      app.send('c');
      await app.waitFor(
        (f) =>
          bindingRefreshed === 1 &&
          f.includes('default') &&
          !f.includes('Confirming location') &&
          useTuiStore.getState().toasts.some((toast) => toast.text.includes('Library location confirmed')),
        { label: 'binding refreshed and confirmed toast after [c]' },
      );
      await new Promise((r) => setImmediate(r));
      assert.ok(calls.some((c) => c.action === 'desktop.library.confirm'));

      // [f] fails first -> rolls back to Disabled, then succeeds -> Enabled +
      app.send('f');
      await app.waitFor(
        (f) =>
          f.includes('Experimental Features:') &&
          f.includes('Disabled') &&
          useTuiStore.getState().toasts.some((toast) => toast.text.includes('Toggle denied')),
        { label: 'experimental failure toast and rollback' },
      );

      app.send('f');
      await app.waitFor((f) => /Experimental Features:\s+Enabled \+/.test(f), {
        label: 'experimental enabled after second [f]',
      });

      // [u] toggles usage recording off
      app.send('u');
      await app.waitFor(
        (f) =>
          /Usage Frequency:\s+Disabled/.test(f) &&
          calls.some((c) => c.action === 'usage.frequency.set' && c.params?.enabled === false),
        { label: 'usage toggled off' },
      );

      // [a] toggles auto update off
      app.send('a');
      await app.waitFor(
        (f) => /Auto Update:\s+Off/.test(f),
        { label: 'auto update toggled off' },
      );

      // [v] cycles retrieval provider builtin -> local-hybrid -> mcp:local-rag
      app.send('v');
      await app.waitFor(
        (f) =>
          /Retrieval:\s+Ready \+/.test(f) &&
          calls.some((c) => c.action === 'retrieval.set' && c.params?.provider === 'local-hybrid'),
        { label: 'retrieval provider switched to local-hybrid' },
      );
      app.send('v');
      await app.waitFor(
        () => calls.some((c) => c.action === 'retrieval.set' && c.params?.provider === 'mcp:local-rag'),
        { label: 'retrieval provider switched to mcp:local-rag' },
      );

      // Ctrl+R reloads restore points and status endpoints
      const listCallsBefore = calls.filter((c) => c.action === 'library.restorePoints.list').length;
      app.send('\x12');
      await app.waitFor(
        () => calls.filter((c) => c.action === 'library.restorePoints.list').length > listCallsBefore,
        { label: 'Ctrl+R reloads restore points' },
      );
    } finally {
      app.cleanup();
    }
  });

  test('4) WorkspaceTab root edit ([e]), backup export sandbox ([x]), sample confirm ([s]), clear usage ([U]), and restore ([Enter])', async () => {
    const libRoot = await makeTempDir('actions');
    let snapshotRefreshed = 0;

    resetTuiStore({
      language: 'zh',
      asciiMode: false,
      snapshot: { revision: 2, experimental: false, sample: { loaded: true } },
      desktopConfig: { libraryPlaceConfirmed: true },
    });

    const { host, calls } = createWorkspaceHost({ libraryRoot: libRoot });
    const app = mountWorkspaceTab({
      host,
      binding: { root: libRoot, defaultRoot: libRoot, rootSource: 'default' },
      cols: 108,
      rows: 30,
      onRefreshSnapshot: async () => {
        snapshotRefreshed += 1;
      },
    });

    try {
      await app.waitFor((f) => f.includes('auto-save'), { label: 'restore points loaded' });

      // [e] opens root path modal, Enter saves and refreshes binding & snapshot
      app.send('e');
      await app.waitFor((f) => f.includes('更改学习库文件夹路径'), { label: 'root edit modal open' });
      app.send('\r');
      await app.waitFor(
        (f) =>
          calls.some((c) => c.action === 'binding.set' && c.params?.root === libRoot) &&
          f.includes('default') &&
          !f.includes('更改学习库文件夹路径') &&
          !f.includes('切换学习库路径') &&
          useTuiStore.getState().toasts.some((toast) => toast.text.includes('学习库已切换到')),
        { label: 'binding.set completed after Enter' },
      );
      await new Promise((r) => setImmediate(r));

      // [x] opens export backup modal -> Enter writes real JSON inside <libRoot>/backups/
      app.send('x');
      await app.waitFor((f) => f.includes('输入备份文件路径'), { label: 'export backup modal open' });
      app.send('\r');
      await app.waitFor(
        (f) =>
          f.includes('default') &&
          !f.includes('输入备份文件路径') &&
          useTuiStore.getState().toasts.some((toast) => toast.text.includes('已导出备份')),
        { label: 'backup exported toast' },
      );
      await new Promise((r) => setImmediate(r));
      const backupFiles = await readdir(path.join(libRoot, 'backups'));
      const jsonBackup = backupFiles.find((name) => /^studyhub-backup-.*\.json$/.test(name));
      assert.ok(jsonBackup, `expected studyhub-backup-*.json in backups/, found ${backupFiles.join(', ')}`);
      const exportedData = JSON.parse(await readFile(path.join(libRoot, 'backups', jsonBackup), 'utf8'));
      assert.equal(exportedData.decks.length, 2);

      // [s] with sampleLoaded=true opens ConfirmDialog -> y calls sample.remove
      app.send('s');
      await app.waitFor((f) => f.includes('确定要从当前学习库移除'), { label: 'confirm sample remove dialog' });
      app.send('y');
      await app.waitFor(
        (f) =>
          calls.some((c) => c.action === 'sample.remove') &&
          f.includes('default') &&
          !f.includes('确定要从当前学习库移除') &&
          useTuiStore.getState().toasts.some((toast) => toast.text.includes('示例课程已移除')),
        { label: 'sample.remove completed after y' },
      );
      await new Promise((r) => setImmediate(r));

      // [U] opens clear usage ConfirmDialog -> n cancels, then [U] + y calls usage.frequency.clear
      app.send('U');
      await app.waitFor((f) => f.includes('删除全部使用记录'), { label: 'confirm clear usage dialog' });
      app.send('n');
      await app.waitFor((f) => !f.includes('删除全部使用记录'), { label: 'confirm clear usage cancelled' });
      assert.equal(calls.some((c) => c.action === 'usage.frequency.clear'), false);

      app.send('U');
      await app.waitFor((f) => f.includes('删除全部使用记录'), { label: 'confirm clear usage reopened' });
      app.send('y');
      await app.waitFor(
        (f) =>
          calls.some((c) => c.action === 'usage.frequency.clear') &&
          f.includes('default') &&
          !f.includes('删除全部使用记录') &&
          useTuiStore.getState().toasts.some((toast) => toast.text.includes('已删除全部本地使用记录')),
        { label: 'usage.frequency.clear completed' },
      );
      await new Promise((r) => setImmediate(r));

      // Enter on first restore point opens ConfirmDialog -> y restores rp-1
      const refreshesBefore = snapshotRefreshed;
      app.send('\r');
      await app.waitFor((f) => f.includes('恢复备份点'), { label: 'confirm restore point dialog' });
      app.send('y');
      await app.waitFor(
        () =>
          calls.some((c) => c.action === 'library.restorePoints.restore' && c.params?.id === 'rp-1') &&
          snapshotRefreshed > refreshesBefore,
        { label: 'restore point restored and snapshot refreshed' },
      );
    } finally {
      app.cleanup();
    }
  });

  test('5) RetrievalDiagModal ([t]): diagnostics summary, [s] hybrid preview search, [m] HF mirror, [r] refresh, Esc close', async () => {
    const libRoot = await makeTempDir('retrieval-modal');
    resetTuiStore({
      language: 'en',
      asciiMode: true,
      snapshot: { revision: 1, experimental: false, sample: { loaded: false } },
      desktopConfig: { libraryPlaceConfirmed: true },
    });

    const { host, calls } = createWorkspaceHost({ libraryRoot: libRoot });
    const app = mountWorkspaceTab({
      host,
      binding: { root: libRoot, defaultRoot: libRoot, rootSource: 'default' },
      cols: 108,
      rows: 30,
    });

    try {
      await app.waitFor((f) => f.includes('Idx 4/6'), { label: 'WorkspaceTab ready' });

      app.send('t');
      const diagFrame = await app.waitFor(
        (f) => f.includes('Retrieval Diagnostics & Index Plan') && f.includes('Pages 12') && f.includes('Chars 14,820'),
        { label: 'RetrievalDiagModal summary loaded' },
      );
      assert.equal(diagFrame.match(UNICODE_UI_CHROME_RE), null, 'RetrievalDiagModal ASCII purity');

      // [s] preview search submode -> submit query -> displays hits in summary
      app.send('s');
      await app.waitFor((f) => f.includes('local hybrid search preview'), { label: 'preview input submode' });
      app.send('page table');
      await app.waitFor((f) => f.includes('page table'), { label: 'preview query typed' });
      app.send('\r');
      const previewFrame = await app.waitFor(
        (f) => f.includes('Search Preview (2 hits): page table') && f.includes('OS Notes (p.7)'),
        { label: 'preview hits rendered' },
      );
      assert.ok(previewFrame.includes('TLB miss handling'));
      assert.ok(calls.some((c) => c.action === 'retrieval.preview' && c.params?.query === 'page table'));

      // [m] HF mirror submode -> submit mirror endpoint -> updates summary
      app.send('m');
      await app.waitFor((f) => f.includes('HuggingFace mirror endpoint'), { label: 'endpoint input submode' });
      app.send('https://mirror.studyhub.local');
      await app.waitFor((f) => f.includes('https://mirror.studyhub.local'), { label: 'HF mirror typed' });
      app.send('\r');
      await app.waitFor(
        (f) => f.includes('HF Endpoint: https://mirror.studyhub.local'),
        { label: 'HF endpoint updated in summary' },
      );
      assert.ok(
        calls.some((c) => c.action === 'retrieval.endpoint.set' && c.params?.endpoint === 'https://mirror.studyhub.local'),
      );

      // [r] refreshes diagnostics, [q] closes modal
      const planCountBefore = calls.filter((c) => c.action === 'retrieval.index.plan').length;
      app.send('r');
      await app.waitFor(
        () => calls.filter((c) => c.action === 'retrieval.index.plan').length > planCountBefore,
        { label: 'RetrievalDiagModal refreshed' },
      );
      app.send('q');
      await app.waitFor((f) => !f.includes('Retrieval Diagnostics & Index Plan'), { label: 'RetrievalDiagModal closed' });
    } finally {
      app.cleanup();
    }
  });

  test('6) ReleaseUpdateModal ([A]), UsageReportModal ([i]), and LibraryContextModal ([L]) full interactive flows', async () => {
    const libRoot = await makeTempDir('other-modals');
    resetTuiStore({
      language: 'en',
      asciiMode: false,
      snapshot: { revision: 1, experimental: false, sample: { loaded: false } },
      desktopConfig: { libraryPlaceConfirmed: true },
    });

    const { host, calls } = createWorkspaceHost({ libraryRoot: libRoot });
    const app = mountWorkspaceTab({
      host,
      binding: { root: libRoot, defaultRoot: libRoot, rootSource: 'default' },
      cols: 108,
      rows: 30,
    });

    try {
      await app.waitFor((f) => f.includes('Library Root & Workspace'), { label: 'WorkspaceTab ready' });

      // 1) ReleaseUpdateModal ([A]) -> [z] snooze -> [z] unsnooze -> [r] recheck -> Esc
      app.send('A');
      await app.waitFor(
        (f) => f.includes('Release Update Check') && f.includes('v1.3.0') && f.includes('Update available'),
        { label: 'ReleaseUpdateModal loaded' },
      );
      app.send('z');
      await app.waitFor((f) => f.includes('Snoozed'), { label: 'ReleaseUpdateModal snoozed' });
      assert.ok(calls.some((c) => c.action === 'update.preferences' && c.params?.snooze === '1.3.0'));
      app.send('z');
      await app.waitFor((f) => f.includes('Update available'), { label: 'ReleaseUpdateModal unsnoozed' });
      assert.ok(calls.some((c) => c.action === 'update.preferences' && c.params?.snooze === null));
      app.send('\x1b');
      await app.waitFor((f) => !f.includes('Release Update Check'), { label: 'ReleaseUpdateModal closed' });

      // 2) UsageReportModal ([i]) -> [1] 7d -> [3] all -> [p] pause -> [e] export -> Esc
      app.send('i');
      await app.waitFor(
        (f) => f.includes('Usage Frequency Report') && f.includes('Interactions: 42') && f.includes('FSRS Grade'),
        { label: 'UsageReportModal loaded' },
      );
      app.send('1');
      await app.waitFor(
        () => calls.some((c) => c.action === 'usage.frequency.report' && c.params?.period === 7),
        { label: 'UsageReportModal switched to 7d' },
      );
      app.send('3');
      await app.waitFor(
        () => calls.some((c) => c.action === 'usage.frequency.report' && c.params?.period === 'all'),
        { label: 'UsageReportModal switched to all' },
      );
      app.send('p');
      await app.waitFor((f) => f.includes('Paused'), { label: 'UsageReportModal paused' });
      app.send('e');
      await app.waitFor((f) => f.includes('Exported:'), { label: 'UsageReportModal exported' });
      const usageExports = (await readdir(path.join(libRoot, 'backups'))).filter((n) => /^studyhub-usage-.*\.json$/.test(n));
      assert.ok(usageExports.length >= 1, 'UsageReportModal [e] must write studyhub-usage-*.json into backups/');
      app.send('q');
      await app.waitFor((f) => !f.includes('Usage Frequency Report'), { label: 'UsageReportModal closed' });

      // 3) LibraryContextModal ([L]) -> verify overflow (+1 more) -> [r] refresh -> [e] export -> Esc
      app.send('L');
      const ctxFrame = await app.waitFor(
        (f) =>
          f.includes('Library Context Overview') &&
          f.includes('Focus: CS162') &&
          f.includes('Cards 64') &&
          f.includes('+1 more'),
        { label: 'LibraryContextModal loaded' },
      );
      assert.ok(ctxFrame.includes('Areas: sources, decks, review'));
      const ctxCallsBefore = calls.filter((c) => c.action === 'library.context').length;
      app.send('r');
      await app.waitFor(
        () => calls.filter((c) => c.action === 'library.context').length > ctxCallsBefore,
        { label: 'LibraryContextModal refreshed' },
      );
      app.send('e');
      await app.waitFor((f) => f.includes('Exported:'), { label: 'LibraryContextModal exported' });
      const ctxExports = (await readdir(path.join(libRoot, 'backups'))).filter((n) => /^studyhub-context-.*\.json$/.test(n));
      assert.ok(ctxExports.length >= 1, 'LibraryContextModal [e] must write studyhub-context-*.json into backups/');
      app.send('q');
      await app.waitFor((f) => !f.includes('Library Context Overview'), { label: 'LibraryContextModal closed' });
    } finally {
      app.cleanup();
    }
  });

  test('7) workspace-model pure descriptors & fail-soft edge cases (offline update check + backup traversal rejection)', async () => {
    assert.deepEqual(describeRetrievalBadge(null, false, 'en', false), { label: 'Checking', tone: 'muted' });
    assert.deepEqual(describeRetrievalBadge(null, true, 'zh', false), { label: '未检测', tone: 'muted' });
    assert.deepEqual(describeRetrievalBadge({ missing: 'ext' }, true, 'en', false), { label: 'Missing', tone: 'warning' });
    assert.deepEqual(
      describeRetrievalBadge({ companion: { notStarted: true } }, true, 'en', false),
      { label: 'Not Started', tone: 'warning' },
    );
    assert.deepEqual(
      describeRetrievalBadge({ effective: 'local-hybrid' }, true, 'en', true),
      { label: 'Ready +', tone: 'success' },
    );
    assert.deepEqual(
      buildRetrievalProviderChoices({
        providers: [{ id: 'builtin' }, { id: 'local-hybrid' }],
        otherTools: [{ name: 'rag' }, { name: 'mcp:rag' }],
      }),
      ['builtin', 'local-hybrid', 'mcp:rag'],
    );

    assert.deepEqual(describeUsageBadge(null, false, 'en', false), { label: 'Loading', tone: 'muted' });
    assert.deepEqual(
      describeUsageBadge({ enabled: true, paused: true, hasData: true, daysWithData: 3, since: '2026-11-20' }, true, 'en', false),
      { label: 'Paused (3d)', tone: 'warning' },
    );
    assert.deepEqual(describeUsageReportState({ enabled: true, paused: false, hasData: false, daysWithData: 0, since: '' }, 'zh'), {
      label: '运行中',
      tone: 'success',
    });

    assert.deepEqual(describeAutoUpdateBadge(null, true, 'en', false), { label: 'Unavailable', tone: 'muted' });
    assert.deepEqual(describeAutoUpdateBadge(true, true, 'en', true), { label: 'On +', tone: 'success' });
    assert.deepEqual(describeUpdateStatusBadge({ error: 'network' }, false, null, 'en', false), {
      label: 'Offline / Network error',
      tone: 'warning',
    });
    assert.deepEqual(describeUpdateStatusBadge({ error: 'rate-limited' }, false, null, 'en', false), {
      label: 'Rate limited',
      tone: 'warning',
    });
    assert.deepEqual(describeUpdateStatusBadge({ pendingRestart: '1.4.0' }, false, null, 'en', false), {
      label: 'Restart pending',
      tone: 'accent',
    });

    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(2048), '2.0 KB');
    assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');

    const libRoot = await makeTempDir('edge-cases');
    resetTuiStore({
      language: 'en',
      asciiMode: true,
      snapshot: { revision: 1, experimental: false, sample: { loaded: false } },
      desktopConfig: { libraryPlaceConfirmed: true },
    });

    const { host, calls } = createWorkspaceHost({
      libraryRoot: libRoot,
      handlers: {
        'update.check': () => ({
          ok: true,
          value: { current: '1.2.0', latest: null, newer: false, error: 'network', autoCheck: true },
        }),
      },
    });
    const app = mountWorkspaceTab({
      host,
      binding: { root: libRoot, defaultRoot: libRoot, rootSource: 'default' },
      cols: 108,
      rows: 30,
    });

    try {
      await app.waitFor((f) => f.includes('Library Root & Workspace'), { label: 'WorkspaceTab ready for edge cases' });

      // Offline update check fails softly without crashing
      app.send('A');
      const offlineFrame = await app.waitFor(
        (f) => f.includes('Offline / Network error') && f.includes('Offline or network unreachable'),
        { label: 'offline update modal rendered' },
      );
      assert.equal(offlineFrame.match(UNICODE_UI_CHROME_RE), null, 'offline update modal ASCII purity');
      app.send('\x1b');
      await app.waitFor((f) => !f.includes('Release Update Check'), { label: 'offline update modal closed' });

      // Backup export rejects path traversal input with error toast and 0 export host calls
      app.send('x');
      await app.waitFor((f) => f.includes('Enter backup file path'), { label: 'backup modal open for traversal check' });
      app.send('\x15'); // Ctrl+U clears pre-filled path
      await new Promise((r) => setImmediate(r));
      app.send('../escape.json');
      await app.waitFor((f) => f.includes('../escape.json') && !f.includes('studyhub-backup-'), {
        label: 'traversal path replaced pre-filled backup path',
      });
      app.send('\r');
      await app.waitFor(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('Export failed:') && toast.text.includes('Unsafe export path')),
        { label: 'traversal path rejected with error toast' },
      );
      assert.equal(calls.some((c) => c.action === 'export'), false, 'must reject unsafe path before calling export');
    } finally {
      app.cleanup();
    }
  });

  test('8) A new snapshot revision reloads restore points while the tab stays mounted', async () => {
    const libRoot = await makeTempDir('revision');
    resetTuiStore({
      language: 'zh',
      snapshot: { revision: 1, experimental: false, sample: { loaded: false } },
      desktopConfig: { libraryPlaceConfirmed: true },
    });
    const { host, calls } = createWorkspaceHost({ libraryRoot: libRoot });
    const app = mountWorkspaceTab({ host, binding: { root: libRoot, defaultRoot: libRoot, rootSource: 'default' } });
    const listCalls = () => calls.filter((c) => c.action === 'library.restorePoints.list').length;
    try {
      await app.waitFor((f) => f.includes('auto-save'), { label: 'restore points loaded' });
      const before = listCalls();
      useTuiStore.setState({ snapshot: { revision: 2, experimental: false, sample: { loaded: false } } });
      await app.waitFor(() => listCalls() > before, { label: 'restore points reloaded on revision bump' });
    } finally {
      app.cleanup();
    }
  });

  test('9) [x] does not open the backup export modal while another action is busy', async () => {
    const libRoot = await makeTempDir('busy-x');
    resetTuiStore({
      language: 'zh',
      snapshot: { revision: 1, experimental: false, sample: { loaded: false } },
      desktopConfig: { libraryPlaceConfirmed: true },
    });
    let releaseSample;
    const sampleGate = new Promise((r) => {
      releaseSample = r;
    });
    const { host } = createWorkspaceHost({
      libraryRoot: libRoot,
      handlers: {
        'sample.load': async () => {
          await sampleGate;
          return { ok: true, value: { loaded: true } };
        },
      },
    });
    const app = mountWorkspaceTab({ host, binding: { root: libRoot, defaultRoot: libRoot, rootSource: 'default' } });
    try {
      await app.waitFor((f) => f.includes('auto-save'), { label: 'restore points loaded' });
      app.send('s');
      await app.waitFor((f) => /载入示例课程(…|\.\.\.)/.test(f), { label: 'sample load busy' });
      app.send('x');
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(app.frame().includes('输入备份文件路径'), false, 'export modal must stay closed while busy');
    } finally {
      releaseSample();
      app.cleanup();
    }
  });

  test('10) Enter restores the selected restore point, not the first one', async () => {
    const libRoot = await makeTempDir('restore-selected');
    resetTuiStore({
      language: 'zh',
      snapshot: { revision: 1, experimental: false, sample: { loaded: false } },
      desktopConfig: { libraryPlaceConfirmed: true },
    });
    const { host, calls } = createWorkspaceHost({ libraryRoot: libRoot });
    const app = mountWorkspaceTab({ host, binding: { root: libRoot, defaultRoot: libRoot, rootSource: 'default' } });
    try {
      await app.waitFor((f) => f.includes('auto-save'), { label: 'restore points loaded' });
      app.send('\u001b[B');
      // Wait until the pointer is on the second point, so Enter cannot race the selection change.
      await app.waitFor((f) => /[\u276f>] 2026-11-25/.test(f), { label: 'second restore point selected' });
      app.send('\r');
      await app.waitFor((f) => f.includes('恢复备份点'), { label: 'confirm restore point dialog' });
      app.send('y');
      await app.waitFor(() => calls.some((c) => c.action === 'library.restorePoints.restore'), {
        label: 'restore called',
      });
      const restore = calls.find((c) => c.action === 'library.restorePoints.restore');
      assert.equal(restore.params?.id, 'rp-2');
    } finally {
      app.cleanup();
    }
  });
});
