// P4 (#1354 D12): Behavioral & interaction regression suite protecting the TasksView.tsx split.
// Exercises line-limit/baseline ratchet guardrails, pure model/export helpers, and real Ink + KeyBridge
// keyboard interactions across tab switching, inline filter + Esc consumption, Enter draft navigation,
// pause/resume + concurrency +/- + optimistic overrides, parallel promotion, interrupted recovery,
// cancel/archive/unarchive/delete (dismiss fallback + running skipped + missing), output/trace toggle,
// trace export/purge, Markdown summary export, JobOutputModal, JobMessageModal (validation + double-submit
// guard + receipts), --ascii purity at 120x36 & 80x24, and unmount async race safety.
// Run: node --test tests/p4-tasks-view-split-regression.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { Box, render } from 'ink';
import React from 'react';
import stripAnsi from 'strip-ansi';
import { register } from 'tsx/esm/api';
import {
  MAX_SOURCE_FILE_LINES,
  evaluateLineLimitRatchet,
  formatLineLimitReport,
  loadLineLimitBaseline,
  scanSourceLineCounts,
} from '../scripts/line-limit-guard.mjs';
import { UNICODE_UI_CHROME_RE } from './helpers/virtual-tty.mjs';

const unregisterTsx = register();
const tempDirs = [];

after(async () => {
  unregisterTsx?.();
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function makeTempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const [
  tasksMod,
  { useTuiStore, DEFAULT_PREFERENCES },
  { useKeyDispatcherBridge },
  { getHub, dispatchToHub },
  { useMouseClickInputFallback },
  { ShellActionsContext },
  { displayWidth },
] = await Promise.all([
  import('../src/views/tasks/TasksView.tsx'),
  import('../src/state/store.ts'),
  import('../src/input/hooks.ts'),
  import('../src/input/dispatcher.ts'),
  import('../src/components/mouse.tsx'),
  import('../src/shell/actions.ts'),
  import('../src/render/cjk.ts'),
]);

const { TasksView, formatTasksMarkdown, exportJobTraceToFile } = tasksMod;

// Extended ASCII purity regex catching Unicode UI chrome, middle dots, dashes, and icons.
const ASCII_FORBIDDEN_CHROME_RE = new RegExp(`${UNICODE_UI_CHROME_RE.source}|[·—–▤✉⟳]`);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function KeyBridgeRoot({ width, height, shellActions, children }) {
  useKeyDispatcherBridge();
  useMouseClickInputFallback(true);
  const content = React.createElement(Box, { width, height }, children);
  if (!shellActions) return content;
  return React.createElement(ShellActionsContext.Provider, { value: shellActions }, content);
}

function createHarness(element, { cols = 120, rows = 36, shellActions = null } = {}) {
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
  stdout.on('data', (chunk) => {
    const plain = stripAnsi(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    if (plain.trim()) latest = plain;
  });

  const instance = render(
    React.createElement(KeyBridgeRoot, { width: cols, height: rows, shellActions }, element),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false, debug: true },
  );

  return {
    write: (data) => stdin.write(data),
    dispatchKey: (input, key = {}) => dispatchToHub(getHub(stdin), input, key),
    rerender: (nextElement) => {
      instance.rerender(
        React.createElement(KeyBridgeRoot, { width: cols, height: rows, shellActions }, nextElement),
      );
    },
    frame: () => latest,
    async waitFor(pred, timeoutMs = 4000, label = 'condition') {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (pred(latest)) return latest;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`waitFor(${label}) timed out. Last frame:\n${latest}`);
    },
    cleanup() {
      instance.unmount();
      stdin.destroy();
      stdout.destroy();
    },
  };
}

function makeShellActions(refreshImpl = async () => {}) {
  return {
    refresh: refreshImpl,
    loadSample: async () => {},
    importSource: () => {},
    openModelSettings: () => {},
    setCourse: async () => {},
    createCourse: async () => {},
    quit: () => {},
  };
}

function resetStore({ language = 'zh', asciiMode = false, snapshot = null, navContext = {} } = {}) {
  useTuiStore.setState({
    page: 'tasks',
    navContext,
    history: [],
    snapshot,
    binding: null,
    config: null,
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
      recentCommands: [...(DEFAULT_PREFERENCES.recentCommands ?? [])],
      language,
      asciiMode,
    },
  });
}

function makeHost(callImpl, { libraryRoot = '' } = {}) {
  const calls = [];
  return {
    calls,
    host: {
      mode: 'embedded',
      getLibraryRoot: () => libraryRoot,
      getConfig: () => ({ libraryRoot }),
      snapshot: async () => null,
      call: async (name, args) => {
        calls.push({ name, args });
        return callImpl(name, args);
      },
      stream: async () => {},
      close: async () => {},
    },
  };
}

function makeSampleSnapshot(libraryRoot = '') {
  return {
    root: libraryRoot,
    courses: [],
    decks: [],
    sources: [],
    drafts: [],
    jobs: [
      {
        id: 'job-done',
        title: 'Linear Algebra Draft',
        type: 'generate',
        status: 'complete',
        progress: 1,
        phase: 'done',
        course: 'Math 201',
        draftId: 'draft-linear-1',
        startedAt: '2026-11-20T10:00:00Z',
        finishedAt: '2026-11-20T10:01:30Z',
        calls: [{ id: 'call-done-1', status: 'complete', stage: 'finalize' }],
      },
      {
        id: 'job-queued',
        title: 'Queued Physics Batch',
        type: 'generate',
        status: 'queued',
        progress: 0,
        phase: 'waiting',
        course: 'Phys 101',
        contract: {
          jobId: 'contract-queued-1',
          status: 'queued',
          actions: {
            parallel: { available: true },
            pause: { available: true },
          },
        },
        calls: [],
      },
      {
        id: 'job-run',
        title: 'OS Scheduling Generation',
        type: 'generate',
        status: 'running',
        progress: 0.45,
        phase: 'drafting',
        course: 'CS 301',
        startedAt: '2026-11-20T11:00:00Z',
        contract: {
          jobId: 'contract-run-1',
          status: 'running',
          stage: 'drafting',
          actions: {
            pause: { available: true },
            resume: { available: false },
            set: {
              available: true,
              settings: [{ key: 'concurrency', type: 'int', value: 2, min: 1, max: 4 }],
            },
          },
          calls: [
            { id: 'call-run-1', status: 'complete', stage: 'outline' },
            { id: 'call-run-2', status: 'running', stage: 'drafting' },
          ],
        },
      },
    ],
    archivedJobs: [
      {
        id: 'job-arch',
        title: 'Archived History Summary',
        type: 'book',
        status: 'complete',
        progress: 1,
        course: 'Hist 105',
        calls: [],
      },
    ],
  };
}

async function waitCondition(pred, timeoutMs = 4000, label = 'condition') {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`waitCondition(${label}) timed out`);
}

describe('P4 (#1354 D12): TasksView Split Guardrail & Behavioral Regression Suite', () => {
  test('1. Line-limit guardrail: TasksView.tsx and all newly split views/tasks modules are <= 1000 lines and removed from baseline', () => {
    const baseline = loadLineLimitBaseline();
    const lineCounts = scanSourceLineCounts();

    assert.equal(
      Object.hasOwn(baseline.files, 'views/tasks/TasksView.tsx'),
      false,
      'views/tasks/TasksView.tsx must be removed from file-line-limit-baseline.json after splitting',
    );

    const expectedSplitFiles = [
      'views/tasks/TasksView.tsx',
      'views/tasks/tasks-model.ts',
      'views/tasks/useTasksActions.ts',
      'views/tasks/JobOutputModal.tsx',
      'views/tasks/JobMessageModal.tsx',
      'views/tasks/TasksPanels.tsx',
    ];

    for (const rel of expectedSplitFiles) {
      assert.equal(typeof lineCounts[rel], 'number', `Expected split module to exist: ${rel}`);
      assert.ok(
        lineCounts[rel] <= MAX_SOURCE_FILE_LINES,
        `${rel} has ${lineCounts[rel]} lines, exceeding ceiling ${MAX_SOURCE_FILE_LINES}`,
      );
    }

    const ratchet = evaluateLineLimitRatchet({
      lineCounts,
      baseline,
      maxLines: MAX_SOURCE_FILE_LINES,
    });
    assert.equal(ratchet.ok, true, formatLineLimitReport(ratchet));
  });

  test('2. Pure helpers: formatTasksMarkdown escapes cells/formats zh+en and exportJobTraceToFile sanitizes path traversal', async () => {
    const mdZh = formatTasksMarkdown({
      jobs: [
        {
          id: 'j1',
          title: 'Cell | Pipe\nNewline',
          type: 'generate',
          status: 'running',
          progress: 75,
          course: 'CS|101',
          updatedAt: new Date(2026, 10, 27, 9, 5),
        },
        {
          id: 'j2',
          title: 'Done Job',
          type: 'book',
          status: 'complete',
          progress: 120,
          course: '',
          createdAt: 'not-a-date',
        },
      ],
      filterTab: 'running',
      filterQuery: 'CS|101',
      lang: 'zh',
      generatedAt: '2026-11-27 10:00',
    });

    assert.ok(mdZh.includes('# StudyHub 后台任务汇总报告'));
    assert.ok(mdZh.includes('运行中 (running)'));
    assert.ok(mdZh.includes('CS\\|101'));
    assert.ok(mdZh.includes('| 1 | Cell \\| Pipe Newline | generate | running | 75% | CS\\|101 | 2026-11-27 09:05 |'));
    assert.ok(mdZh.includes('| 2 | Done Job | book | complete | 100% | - | not-a-date |'));
    assert.ok(mdZh.includes('running: 1, complete: 1'));

    const mdEmptyEn = formatTasksMarkdown({
      jobs: [],
      filterTab: 'archived',
      lang: 'en',
      generatedAt: '2026-11-27 10:00',
    });
    assert.ok(mdEmptyEn.includes('# StudyHub Background Jobs Summary'));
    assert.ok(mdEmptyEn.includes('Archived (archived)'));
    assert.ok(mdEmptyEn.includes('_No jobs match the current filter._'));

    const rootDir = await makeTempDir('studyhub-tasks-trace-');
    const payload = { jobId: '../../etc/passwd', calls: [{ callId: 'c1', status: 'ok' }] };
    const saved = await exportJobTraceToFile(rootDir, '../../etc/passwd?bad*id', payload);
    assert.equal(dirname(saved), join(rootDir, 'exports'));
    assert.ok(!saved.includes('..'));
    const disk = JSON.parse(await readFile(saved, 'utf8'));
    assert.deepEqual(disk, payload);
  });

  test('3. Interactive tabs (1/2/3/Tab), inline filter (/ + Esc consumed), and Enter draft navigation', async () => {
    const snap = makeSampleSnapshot();
    resetStore({ language: 'en', asciiMode: false, snapshot: snap });

    const { host } = makeHost(async (name) => {
      if (name === 'job.live.list') return { ok: true, value: { jobs: [] } };
      if (name === 'job.output') return { ok: true, value: { text: 'Stream line 1\nStream line 2' } };
      if (name === 'job.trace') return { ok: true, value: { calls: [] } };
      return { ok: true, value: {} };
    });

    const h = createHarness(
      React.createElement(TasksView, { host, width: 120, height: 34, isActive: true }),
      { cols: 120, rows: 34, shellActions: makeShellActions() },
    );

    try {
      const f0 = await h.waitFor((f) => f.includes('OS Scheduling Generation') && f.includes('Archived History Summary'), 4000, 'initial all tab');
      assert.ok(f0.includes('1. Running (2)'));
      assert.ok(f0.includes('2. All (4)'));
      assert.ok(f0.includes('3. Archived (1)'));

      // Press '1' -> running tab hides completed & archived jobs
      h.dispatchKey('1', {});
      const fRun = await h.waitFor(
        (f) => f.includes('OS Scheduling Generation') && !f.includes('Archived History Summary') && !f.includes('Linear Algebra Draft'),
        4000,
        'running tab',
      );
      assert.ok(fRun.includes('Queued Physics Batch'));

      // Press '3' -> archived tab shows only archived
      h.dispatchKey('3', {});
      await h.waitFor(
        (f) => f.includes('Archived History Summary') && !f.includes('OS Scheduling Generation'),
        4000,
        'archived tab',
      );

      // Tab cycles archived -> running -> all
      h.dispatchKey('', { tab: true });
      await h.waitFor((f) => f.includes('OS Scheduling Generation') && !f.includes('Archived History Summary'), 4000, 'tab to running');
      h.dispatchKey('', { tab: true });
      await h.waitFor((f) => f.includes('Linear Algebra Draft') && f.includes('Archived History Summary'), 4000, 'tab to all');

      // Open inline filter '/', filter by 'Math 201', press Enter to commit
      h.dispatchKey('/', {});
      await h.waitFor((f) => f.includes('[Filter 4/4]'), 4000, 'filter bar open');
      h.dispatchKey('Math 201', {});
      await h.waitFor((f) => f.includes('[Filter 1/4]') && f.includes('Linear Algebra Draft'), 4000, 'filtered to Math 201');
      h.dispatchKey('', { return: true });
      await h.waitFor((f) => f.includes('[Filtered 1/4]'), 4000, 'filter locked');

      // Press Enter on selected Linear Algebra Draft -> navigates to generate with draftId
      h.dispatchKey('', { return: true });
      await waitCondition(() => useTuiStore.getState().page === 'generate', 2000, 'navigated to generate');
      assert.equal(useTuiStore.getState().navContext.draftId, 'draft-linear-1');
      useTuiStore.setState({ page: 'tasks', navContext: {} });

      // Esc clears active filter query AND returns true (consumed)
      const consumed = h.dispatchKey('', { escape: true });
      assert.equal(consumed, true, 'Esc clearing filterQuery must be consumed');
      await h.waitFor((f) => !f.includes('[Filtered') && f.includes('OS Scheduling Generation'), 4000, 'filter cleared');

      // Enter on OS Scheduling Generation (no draftId) notifies info toast instead of navigating
      h.dispatchKey('', { return: true });
      await waitCondition(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('No draft linked')),
        2000,
        'no draft linked toast',
      );
      assert.equal(useTuiStore.getState().page, 'tasks');
    } finally {
      h.cleanup();
    }
  });

  test('4. Interactive queue controls: pause/resume (p), concurrency (+/- bounds), parallel (P), recover (R), and busyRef mutex', async () => {
    const snap = makeSampleSnapshot();
    resetStore({ language: 'en', asciiMode: false, snapshot: snap });

    const pauseGate = deferred();
    let refreshCount = 0;
    const { calls, host } = makeHost(async (name, args) => {
      if (name === 'job.live.list') return { ok: true, value: { jobs: [] } };
      if (name === 'job.output') return { ok: true, value: { text: 'running log' } };
      if (name === 'job.trace') return { ok: true, value: { calls: [] } };
      if (name === 'job.control' && args?.action === 'pause') {
        await pauseGate.promise;
        return { ok: true, value: { status: 'pausing', paused: true } };
      }
      if (name === 'job.control' && args?.action === 'set') {
        return { ok: true, value: { values: { concurrency: args.patch.concurrency } } };
      }
      if (name === 'job.parallel') {
        return { ok: true, value: { parallel: true, note: 'Started queued job in parallel' } };
      }
      if (name === 'coverage.recover') {
        return { ok: true, value: { recovered: 2 } };
      }
      return { ok: true, value: {} };
    });

    const h = createHarness(
      React.createElement(TasksView, { host, width: 120, height: 34, isActive: true }),
      {
        cols: 120,
        rows: 34,
        shellActions: makeShellActions(async () => {
          refreshCount += 1;
        }),
      },
    );

    try {
      await h.waitFor((f) => f.includes('OS Scheduling Generation') && f.includes('2x'), 4000, 'selected running job with 2x');

      // Press 'p' twice rapidly while first job.control is pending -> busyRef blocks second call
      h.dispatchKey('p', {});
      h.dispatchKey('p', {});
      await waitCondition(() => calls.filter((c) => c.name === 'job.control').length === 1, 2000, 'pause RPC started');
      assert.equal(calls.filter((c) => c.name === 'job.control').length, 1, 'busyRef must block duplicate pause RPC');
      assert.deepEqual(calls.find((c) => c.name === 'job.control').args, {
        jobId: 'contract-run-1',
        action: 'pause',
      });

      pauseGate.resolve();
      await waitCondition(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('Job queue paused')),
        2000,
        'paused toast',
      );
      assert.ok(refreshCount >= 1);

      // Press '+' to bump concurrency from 2 -> 3
      h.dispatchKey('+', {});
      await waitCondition(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('Concurrency updated to 3x')),
        2000,
        'concurrency updated toast',
      );
      const setCall = calls.find((c) => c.name === 'job.control' && c.args?.action === 'set');
      assert.deepEqual(setCall?.args, {
        jobId: 'contract-run-1',
        action: 'set',
        patch: { concurrency: 3 },
      });

      // Move down to Queued Physics Batch (index 1) and press 'P' for parallel promotion
      h.dispatchKey('', { downArrow: true });
      await h.waitFor((f) => f.includes('Queued Physics Batch') && f.includes('waiting'), 4000, 'queued job selected');
      h.dispatchKey('P', {});
      await waitCondition(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('Started queued job in parallel')),
        2000,
        'parallel promoted toast',
      );
      assert.deepEqual(calls.find((c) => c.name === 'job.parallel')?.args, { jobId: 'contract-queued-1' });

      // Press 'R' to recover interrupted jobs
      h.dispatchKey('R', {});
      await waitCondition(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('Recovered 2 interrupted job(s)')),
        2000,
        'recover toast',
      );
    } finally {
      h.cleanup();
    }
  });

  test('5. Interactive lifecycle: cancel (x), archive/unarchive (a), and delete (d dismiss fallback to job.delete skipped/running)', async () => {
    const snap = makeSampleSnapshot();
    resetStore({ language: 'en', asciiMode: false, snapshot: snap });

    const { calls, host } = makeHost(async (name, args) => {
      if (name === 'job.live.list') return { ok: true, value: { jobs: [] } };
      if (name === 'job.output') return { ok: true, value: { text: '' } };
      if (name === 'job.trace') return { ok: true, value: { calls: [] } };
      if (name === 'job.cancel') return { ok: true, value: { cancelled: true } };
      if (name === 'job.archive') return { ok: true, value: { archived: [args.jobId] } };
      if (name === 'job.unarchive') return { ok: true, value: { unarchived: [args.jobId] } };
      if (name === 'job.dismiss') return { ok: false, error: { message: 'unsupported' } };
      if (name === 'job.delete') {
        return { ok: true, value: { deleted: [], skipped: [{ id: args.jobIds[0], reason: 'running' }] } };
      }
      return { ok: true, value: {} };
    });

    const h = createHarness(
      React.createElement(TasksView, { host, width: 120, height: 34, isActive: true }),
      { cols: 120, rows: 34, shellActions: makeShellActions() },
    );

    try {
      await h.waitFor((f) => f.includes('OS Scheduling Generation'), 4000, 'running job selected');

      // Archiving a running job is refused cleanly without RPC
      h.dispatchKey('a', {});
      await waitCondition(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('Running jobs cannot be archived')),
        2000,
        'running cannot archive',
      );
      assert.equal(calls.filter((c) => c.name === 'job.archive').length, 0);

      // Cancel running job ('x')
      h.dispatchKey('x', {});
      await waitCondition(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('Job cancel requested')),
        2000,
        'cancel requested',
      );
      assert.deepEqual(calls.find((c) => c.name === 'job.cancel')?.args, { jobId: 'job-run' });

      // Delete running job ('d' -> confirm 'y'): dismiss fails -> falls back to job.delete -> running skipped warning
      h.dispatchKey('d', {});
      await h.waitFor((f) => f.includes('Dismiss Job'), 4000, 'delete confirm dialog');
      h.dispatchKey('y', {});
      await waitCondition(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('Running job cannot be removed')),
        2000,
        'running delete skipped warning',
      );
      assert.deepEqual(calls.find((c) => c.name === 'job.delete')?.args, { jobIds: ['job-run'] });

      // Move down to Linear Algebra Draft (index 2: complete) -> archive ('a')
      h.dispatchKey('', { downArrow: true });
      await h.waitFor((f) => f.includes('Phase: waiting'), 4000, 'queued job selected before second down');
      h.dispatchKey('', { downArrow: true });
      await h.waitFor((f) => f.includes('Linear Algebra Draft') && f.includes('Enter: Draft'), 4000, 'done job selected');
      h.dispatchKey('a', {});
      await waitCondition(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('Job archived')),
        2000,
        'archived toast',
      );
      assert.deepEqual(calls.find((c) => c.name === 'job.archive')?.args, { jobId: 'job-done' });

      // Move down to Archived History Summary (index 3) -> unarchive ('a')
      h.dispatchKey('', { downArrow: true });
      await h.waitFor((f) => f.includes('Archived History Summary') && f.includes('book'), 4000, 'archived job selected');
      h.dispatchKey('a', {});
      await waitCondition(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('Job restored from archive')),
        2000,
        'unarchived toast',
      );
      assert.deepEqual(calls.find((c) => c.name === 'job.unarchive')?.args, { jobId: 'job-arch' });
    } finally {
      h.cleanup();
    }
  });

  test('6. Interactive detail mode (v), trace export (e), trace purge (D), and Markdown export (X)', async () => {
    const libRoot = await makeTempDir('studyhub-tasks-exports-');
    const snap = makeSampleSnapshot(libRoot);
    resetStore({ language: 'en', asciiMode: false, snapshot: snap });

    let tracePurged = false;
    const { calls, host } = makeHost(
      async (name, args) => {
        if (name === 'job.live.list') return { ok: true, value: { jobs: [] } };
        if (name === 'job.output') return { ok: true, value: { text: 'Live stream chunk A' } };
        if (name === 'job.trace') {
          if (tracePurged) return { ok: true, value: { calls: [], unavailableReason: 'deleted-by-user' } };
          return {
            ok: true,
            value: {
              calls: [
                {
                  callId: 'call-run-1',
                  stage: 'outline',
                  status: 'ok',
                  model: 'deepseek-chat',
                  tokenUsage: { uncachedInputTokens: 120, outputTokens: 45 },
                },
              ],
            },
          };
        }
        if (name === 'job.trace.export') {
          return {
            ok: true,
            value: {
              calls: [{ callId: 'call-run-1', retained: true, deleted: false }],
            },
          };
        }
        if (name === 'job.trace.delete') {
          tracePurged = true;
          return { ok: true, value: { jobId: args.jobId, removed: 1 } };
        }
        return { ok: true, value: {} };
      },
      { libraryRoot: libRoot },
    );

    const h = createHarness(
      React.createElement(TasksView, { host, width: 120, height: 34, isActive: true }),
      { cols: 120, rows: 34, shellActions: makeShellActions() },
    );

    try {
      await h.waitFor((f) => f.includes('Live stream chunk A'), 4000, 'initial output lines');

      // Press 'v' to switch to Trace tab
      h.dispatchKey('v', {});
      await h.waitFor((f) => f.includes('[ok] outline (deepseek-chat') && f.includes('120→45 tok'), 4000, 'trace tab lines');

      // Press 'e' to export trace JSON to <libRoot>/exports/
      h.dispatchKey('e', {});
      await waitCondition(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('Trace exported to')),
        2000,
        'trace exported toast',
      );
      const exportToast = useTuiStore.getState().toasts.find((toast) => toast.text.includes('Trace exported to'));
      const tracePath = exportToast.text.replace(/^Trace exported to\s+/, '').trim();
      const exportedTrace = JSON.parse(await readFile(tracePath, 'utf8'));
      assert.equal(exportedTrace.calls[0].callId, 'call-run-1');

      // Press 'X' to export visible jobs Markdown report to <libRoot>/backups/
      h.dispatchKey('X', {});
      await waitCondition(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('Exported 4 job(s) summary')),
        2000,
        'markdown exported toast',
      );
      const mdToast = useTuiStore.getState().toasts.find((toast) => toast.text.includes('Exported 4 job(s) summary'));
      const mdPath = mdToast.text.split('→')[1].trim();
      const mdDisk = await readFile(mdPath, 'utf8');
      assert.ok(mdDisk.includes('OS Scheduling Generation'));
      assert.ok(mdDisk.includes('Archived History Summary'));

      // Press 'D' -> confirm purge traces ('y') -> reloads trace showing (deleted-by-user)
      h.dispatchKey('D', {});
      await h.waitFor((f) => f.includes('Purge Request Traces'), 4000, 'purge confirm modal');
      h.dispatchKey('y', {});
      await waitCondition(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('Purged 1 trace(s)')),
        2000,
        'purged toast',
      );
      await h.waitFor((f) => f.includes('(deleted-by-user)'), 4000, 'reloaded empty purged trace');
      assert.deepEqual(calls.find((c) => c.name === 'job.trace.delete')?.args, { jobId: 'job-run' });
    } finally {
      h.cleanup();
    }
  });

  test('7. Interactive modals: JobOutputModal (o: call switch, JSON toggle, refresh) & JobMessageModal (m: validate, double-submit guard, receipts)', async () => {
    const snap = makeSampleSnapshot();
    resetStore({ language: 'en', asciiMode: false, snapshot: snap });

    const msgGate = deferred();
    const { calls, host } = makeHost(async (name, args) => {
      if (name === 'job.live.list') return { ok: true, value: { jobs: [] } };
      if (name === 'job.trace') return { ok: true, value: { calls: [] } };
      if (name === 'job.output') {
        if (args?.callId === 'call-run-1') {
          return { ok: true, value: { source: 'cache', text: '{"stage":"outline","items":3}' } };
        }
        return { ok: true, value: { source: 'live', text: '# Draft Output\n\nQuestion 1 body', reasoningChars: 42 } };
      }
      if (name === 'job.message') {
        await msgGate.promise;
        return { ok: true, value: { jobId: args.jobId, delivery: 'partial' } };
      }
      return { ok: true, value: {} };
    });

    const h = createHarness(
      React.createElement(TasksView, { host, width: 120, height: 34, isActive: true }),
      { cols: 120, rows: 34, shellActions: makeShellActions() },
    );

    try {
      await h.waitFor((f) => f.includes('OS Scheduling Generation'), 4000, 'initial view');

      // Open JobOutputModal ('o') -> defaults to running call (call-run-2, 2/2)
      h.dispatchKey('o', {});
      const outFrame = await h.waitFor(
        (f) => f.includes('Job Output:') && f.includes('drafting (2/2)') && f.includes('think:42'),
        4000,
        'output modal open and loaded',
      );
      assert.ok(outFrame.includes('think:42'));

      // Switch to previous call ('[') -> loads call-run-1 JSON payload automatically
      h.dispatchKey('[', {});
      await h.waitFor((f) => f.includes('outline (1/2)') && f.includes('"stage": "outline"'), 4000, 'switched to call 1 json');

      // Press 'r' to refresh and Esc to close JobOutputModal
      const outCallsBefore = calls.filter((c) => c.name === 'job.output').length;
      h.dispatchKey('r', {});
      await waitCondition(() => calls.filter((c) => c.name === 'job.output').length > outCallsBefore, 2000, 'output refreshed');
      h.dispatchKey('', { escape: true });
      await h.waitFor((f) => !f.includes('Job Output:'), 4000, 'output modal closed');

      // Open JobMessageModal ('m') on running job
      h.dispatchKey('m', {});
      await h.waitFor((f) => f.includes('Send Refinement Message'), 4000, 'message modal open');

      // Submitting empty message shows validation error without RPC
      h.dispatchKey('', { return: true });
      await h.waitFor((f) => f.includes('Please enter 1'), 4000, 'empty validation error');
      assert.equal(calls.filter((c) => c.name === 'job.message').length, 0);

      // Type message and submit twice synchronously before RPC settles -> sync submittingRef blocks duplicate
      h.dispatchKey('Add edge cases', {});
      await h.waitFor((f) => f.includes('Add edge cases'), 4000, 'message typed');
      h.dispatchKey('', { return: true });
      h.dispatchKey('', { return: true });
      await waitCondition(() => calls.filter((c) => c.name === 'job.message').length >= 1, 2000, 'message RPC sent');
      assert.equal(calls.filter((c) => c.name === 'job.message').length, 1, 'submittingRef must block duplicate submit');
      assert.deepEqual(calls.find((c) => c.name === 'job.message')?.args, {
        jobId: 'job-run',
        message: 'Add edge cases',
      });

      msgGate.resolve();
      await waitCondition(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('Partially delivered')),
        2000,
        'partial delivery toast',
      );
      await h.waitFor((f) => !f.includes('Send Refinement Message'), 4000, 'message modal closed');
    } finally {
      h.cleanup();
    }
  });

  test('8. --ascii purity & narrow width (80x24): zero Unicode UI chrome across TasksView, trace lines, JobOutputModal, and JobMessageModal', async () => {
    const snap = makeSampleSnapshot();
    // Include a job without startedAt to exercise formatElapsed fallback in ASCII mode
    snap.jobs.push({
      id: 'job-notime',
      title: 'No Timestamp Job',
      type: 'generate',
      status: 'complete',
      progress: 1,
      calls: [],
    });

    for (const lang of ['zh', 'en']) {
      for (const [cols, rows] of [
        [120, 34],
        [80, 24],
      ]) {
        resetStore({ language: lang, asciiMode: true, snapshot: snap });

        const { host } = makeHost(async (name) => {
          if (name === 'job.live.list') return { ok: true, value: { jobs: [] } };
          if (name === 'job.output') return { ok: true, value: { text: 'ASCII safe output line', source: 'live' } };
          if (name === 'job.trace') {
            return {
              ok: true,
              value: {
                calls: [
                  {
                    callId: 'c-ascii',
                    stage: 'draft',
                    status: 'ok',
                    model: 'gpt',
                    deleted: true,
                    tokenUsage: { uncachedInputTokens: 50, outputTokens: 20 },
                  },
                ],
              },
            };
          }
          return { ok: true, value: {} };
        });

        const h = createHarness(
          React.createElement(TasksView, { host, width: cols, height: rows, isActive: true }),
          { cols, rows, shellActions: makeShellActions() },
        );

        try {
          const checkFrame = (frame, label) => {
            const leak = frame.match(ASCII_FORBIDDEN_CHROME_RE);
            assert.equal(leak, null, `${label} (${lang} ${cols}x${rows}) leaked Unicode chrome ${JSON.stringify(leak)}:\n${frame}`);
            for (const line of frame.split('\n')) {
              assert.ok(
                displayWidth(line) <= cols,
                `${label} (${lang} ${cols}x${rows}) line exceeded ${cols} cols (${displayWidth(line)}): ${JSON.stringify(line)}`,
              );
            }
          };

          const fMain = await h.waitFor((f) => f.includes('No Timestamp Job'), 4000, `main ${lang} ${cols}x${rows}`);
          checkFrame(fMain, 'TasksView main');

          // In wide side-by-side mode, switch to trace mode ('v') and verify trace separator + arrow are pure ASCII
          if (cols >= 100) {
            h.dispatchKey('v', {});
            const fTrace = await h.waitFor((f) => f.includes('50->20 tok'), 4000, `trace ${lang} ${cols}x${rows}`);
            checkFrame(fTrace, 'TasksView trace');
          }

          // Open JobOutputModal ('o') and check ASCII purity
          h.dispatchKey('o', {});
          const fOut = await h.waitFor((f) => f.includes('ASCII safe output line'), 4000, `output modal ${lang} ${cols}x${rows}`);
          checkFrame(fOut, 'JobOutputModal');
          h.dispatchKey('', { escape: true });
          await h.waitFor(
            (f) => !f.includes('ASCII safe output line') && !f.includes('任务输出:') && !f.includes('Job Output:'),
            4000,
            'output modal closed',
          );

          // Open JobMessageModal ('m') on running job (index 0 after reverse: job-notime is last in snap so index 0 is job-notime; move to job-run)
          // Filter to 'OS Scheduling' so job-run is guaranteed selected
          h.dispatchKey('/', {});
          await h.waitFor((f) => f.includes('[Filter') || f.includes('[筛选'), 4000, 'filter bar open ascii');
          h.dispatchKey('OS Scheduling', {});
          await h.waitFor((f) => f.includes('1/5]'), 4000, 'filtered to running job ascii');
          h.dispatchKey('', { return: true });
          await h.waitFor(
            (f) => f.includes('[已筛选 1/5]') || f.includes('[Filtered 1/5]'),
            4000,
            'filter locked on running job ascii',
          );
          h.dispatchKey('m', {});
          const fMsg = await h.waitFor((f) => f.includes('1-4000'), 4000, `message modal ${lang} ${cols}x${rows}`);
          checkFrame(fMsg, 'JobMessageModal');
          // Trigger empty validation error to check error prefix in ASCII mode
          h.dispatchKey('', { return: true });
          const fMsgErr = await h.waitFor((f) => f.includes('! '), 4000, `message modal error ${lang} ${cols}x${rows}`);
          checkFrame(fMsgErr, 'JobMessageModal validation error');
        } finally {
          h.cleanup();
        }
      }
    }
  });

  test('9. Unmount async race safety: pending cancel/output/trace/live polls settle after unmount without stale toasts or errors', async () => {
    const snap = makeSampleSnapshot();
    resetStore({ language: 'en', asciiMode: false, snapshot: snap });

    const cancelGate = deferred();
    const outputGate = deferred();
    const traceGate = deferred();
    const liveGate = deferred();

    const { calls, host } = makeHost(async (name) => {
      if (name === 'job.live.list') {
        await liveGate.promise;
        return { ok: true, value: { jobs: [] } };
      }
      if (name === 'job.output') {
        await outputGate.promise;
        return { ok: true, value: { text: 'late output' } };
      }
      if (name === 'job.trace') {
        await traceGate.promise;
        return { ok: true, value: { calls: [] } };
      }
      if (name === 'job.cancel') {
        await cancelGate.promise;
        return { ok: true, value: { cancelled: true } };
      }
      return { ok: true, value: {} };
    });

    const h = createHarness(
      React.createElement(TasksView, { host, width: 120, height: 34, isActive: true }),
      { cols: 120, rows: 34, shellActions: makeShellActions() },
    );

    await h.waitFor((f) => f.includes('OS Scheduling Generation'), 4000, 'mounted');
    await waitCondition(() => calls.some((c) => c.name === 'job.output'), 2000, 'output in flight');
    h.dispatchKey('x', {});
    await waitCondition(() => calls.some((c) => c.name === 'job.cancel'), 2000, 'cancel in flight');

    const traceCallsBeforeUnmount = calls.filter((c) => c.name === 'job.trace').length;

    // Unmount while cancel/output/live polls are still unresolved
    h.cleanup();

    // Settle all gates after unmount
    cancelGate.resolve();
    outputGate.resolve();
    traceGate.resolve();
    liveGate.resolve();
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(useTuiStore.getState().toasts.length, 0, 'unmounted TasksView must not emit late toasts');
    assert.equal(
      calls.filter((c) => c.name === 'job.trace').length,
      traceCallsBeforeUnmount,
      'unmounted TasksView must not fire a stray job.trace RPC after late job.output settles',
    );
  });

  test('10. ConfirmDialog target pinning: live poll shifts & tab emptying never hijack delete target or leave ghost dialogs', async () => {
    // Subcase A: live poll prepends a new job while Dismiss Job ConfirmDialog is open -> 'y' still deletes original job
    {
      const liveGate = deferred();
      const { calls, host } = makeHost(async (name) => {
        if (name === 'job.live.list') {
          await liveGate.promise;
          return {
            ok: true,
            value: {
              jobs: [
                { id: 'job-old', title: 'Old Target Job', type: 'generate', status: 'running', progress: 0.5, calls: [] },
                { id: 'job-new', title: 'New Arriving Job', type: 'generate', status: 'running', progress: 0.1, calls: [] },
              ],
            },
          };
        }
        return { ok: true, value: { calls: [], text: '' } };
      });
      resetStore({
        language: 'en',
        asciiMode: false,
        snapshot: {
          root: '',
          courses: [],
          decks: [],
          sources: [],
          drafts: [],
          archivedJobs: [],
          jobs: [{ id: 'job-old', title: 'Old Target Job', type: 'generate', status: 'running', progress: 0.5, calls: [] }],
        },
      });
      const h = createHarness(
        React.createElement(TasksView, { host, width: 120, height: 34, isActive: true }),
        { cols: 120, rows: 34, shellActions: makeShellActions() },
      );
      try {
        await h.waitFor((f) => f.includes('Old Target Job'), 4000, 'initial single job');
        h.dispatchKey('d', {});
        await h.waitFor((f) => f.includes('Remove job record "Old Target Job"'), 4000, 'confirm dialog pinned to Old Target Job');
        liveGate.resolve();
        await h.waitFor((f) => f.includes('New Arriving Job'), 4000, 'new job landed in list');
        assert.equal(
          h.frame().includes('Remove job record "Old Target Job"'),
          true,
          'confirm dialog title must remain pinned to Old Target Job',
        );
        h.dispatchKey('y', {});
        await waitCondition(() => calls.some((c) => c.name === 'job.dismiss'), 2000, 'dismiss called');
        assert.deepEqual(calls.find((c) => c.name === 'job.dismiss')?.args, { jobId: 'job-old' });
      } finally {
        h.cleanup();
      }
    }

    // Subcase B: job completes while on Running tab with ConfirmDialog open -> stays pinned until Esc, no ghost dialog on All tab
    {
      const liveGate = deferred();
      const { host } = makeHost(async (name) => {
        if (name === 'job.live.list') {
          await liveGate.promise;
          return {
            ok: true,
            value: {
              jobs: [{ id: 'job-only', title: 'Finishing Job', type: 'generate', status: 'complete', progress: 1, calls: [] }],
            },
          };
        }
        return { ok: true, value: { calls: [], text: '' } };
      });
      resetStore({
        language: 'en',
        asciiMode: false,
        snapshot: {
          root: '',
          courses: [],
          decks: [],
          sources: [],
          drafts: [],
          archivedJobs: [],
          jobs: [
            { id: 'job-other', title: 'Unrelated Completed Job', type: 'generate', status: 'complete', progress: 1, calls: [] },
            { id: 'job-only', title: 'Finishing Job', type: 'generate', status: 'running', progress: 0.9, calls: [] },
          ],
        },
      });
      const h = createHarness(
        React.createElement(TasksView, { host, width: 120, height: 34, isActive: true }),
        { cols: 120, rows: 34, shellActions: makeShellActions() },
      );
      try {
        await h.waitFor((f) => f.includes('Finishing Job'), 4000, 'initial jobs');
        h.dispatchKey('1', {});
        await h.waitFor((f) => !f.includes('Unrelated Completed Job'), 4000, 'running tab active');
        h.dispatchKey('d', {});
        await h.waitFor((f) => f.includes('Remove job record "Finishing Job"'), 4000, 'confirm dialog open');
        liveGate.resolve();
        await h.waitFor((f) => f.includes('1. Running (0)'), 4000, 'running tab became empty');
        assert.equal(
          h.frame().includes('Remove job record "Finishing Job"'),
          true,
          'confirm dialog must stay mounted until explicitly dismissed',
        );
        h.dispatchKey('', { escape: true });
        await h.waitFor((f) => !f.includes('Dismiss Job'), 4000, 'dialog closed on Esc');
        h.dispatchKey('2', {});
        await h.waitFor((f) => f.includes('Unrelated Completed Job'), 4000, 'switched to All tab');
        assert.equal(h.frame().includes('Dismiss Job'), false, 'no ghost ConfirmDialog after switching tabs');
      } finally {
        h.cleanup();
      }
    }
  });

  test('11. JobOutputModal empty job.calls fallback via job.trace, unsupported/archived hints, and cancel mid-trace safety', async () => {
    // Subcase A: job.calls is empty -> queries job.trace -> picks running call -> fetches job.output; unsupported hint shown on supported:false
    {
      const { calls, host } = makeHost(async (name, args) => {
        if (name === 'job.trace') {
          return {
            ok: true,
            value: {
              calls: [
                { callId: 'c-1', status: 'complete' },
                { callId: 'c-2-run', status: 'running' },
              ],
            },
          };
        }
        if (name === 'job.output' && args?.callId === 'c-2-run') {
          return { ok: true, value: { supported: false } };
        }
        return { ok: true, value: {} };
      });
      resetStore({
        language: 'en',
        asciiMode: false,
        snapshot: {
          root: '',
          courses: [],
          decks: [],
          sources: [],
          drafts: [],
          archivedJobs: [],
          jobs: [{ id: 'job-empty-calls', title: 'Fallback Trace Job', type: 'generate', status: 'complete', progress: 1, calls: [] }],
        },
      });
      const h = createHarness(
        React.createElement(TasksView, { host, width: 120, height: 34, isActive: true }),
        { cols: 120, rows: 34, shellActions: makeShellActions() },
      );
      try {
        await h.waitFor((f) => f.includes('Fallback Trace Job'), 4000, 'fallback job rendered');
        h.dispatchKey('o', {});
        await h.waitFor(
          (f) => f.includes('Live streaming output is not supported by this runner'),
          4000,
          'unsupported runner empty-state hint',
        );
        const outCall = calls.find((c) => c.name === 'job.output');
        assert.deepEqual(outCall?.args, { jobId: 'job-empty-calls', callId: 'c-2-run', cursor: 0 });
      } finally {
        h.cleanup();
      }
    }

    // Subcase B: closing JobOutputModal while job.trace fallback is in-flight fires 0 stray job.output RPCs
    {
      const traceGate = deferred();
      const { calls, host } = makeHost(async (name) => {
        if (name === 'job.trace') {
          await traceGate.promise;
          return { ok: true, value: { calls: [{ callId: 'c-late', status: 'running' }] } };
        }
        return { ok: true, value: { text: 'should not be fetched' } };
      });
      resetStore({
        language: 'en',
        asciiMode: false,
        snapshot: {
          root: '',
          courses: [],
          decks: [],
          sources: [],
          drafts: [],
          archivedJobs: [],
          jobs: [{ id: 'job-cancel-trace', title: 'Cancel Trace Job', type: 'generate', status: 'complete', progress: 1, calls: [] }],
        },
      });
      const h = createHarness(
        React.createElement(TasksView, { host, width: 120, height: 34, isActive: true }),
        { cols: 120, rows: 34, shellActions: makeShellActions() },
      );
      try {
        await h.waitFor((f) => f.includes('Cancel Trace Job'), 4000, 'cancel trace job rendered');
        h.dispatchKey('o', {});
        await h.waitFor((f) => f.includes('Job Output:'), 4000, 'output modal open');
        h.dispatchKey('', { escape: true });
        await h.waitFor((f) => !f.includes('Job Output:'), 4000, 'output modal closed');
        const outBefore = calls.filter((c) => c.name === 'job.output').length;
        traceGate.resolve();
        await new Promise((r) => setTimeout(r, 60));
        assert.equal(
          calls.filter((c) => c.name === 'job.output').length,
          outBefore,
          'closed JobOutputModal must not fire stray job.output RPC after late job.trace settles',
        );
      } finally {
        h.cleanup();
      }
    }
  });
});

// #1623 follow-ups to the TasksView split review: late results, error paths, and behaviour the split moved.
describe('#1623 TasksView: late delete/purge results, pause/concurrency override cleanup, and moved behaviour', () => {
  function twoFinishedJobsSnapshot() {
    return {
      root: '',
      courses: [],
      decks: [],
      sources: [],
      drafts: [],
      archivedJobs: [],
      jobs: [
        { id: 'job-beta', title: 'Beta Done Job', type: 'generate', status: 'complete', progress: 1, calls: [] },
        { id: 'job-alpha', title: 'Alpha Done Job', type: 'generate', status: 'complete', progress: 1, calls: [] },
      ],
    };
  }

  const STILL_RUNNING_EN = 'The previous action is still running';
  const hasToast = (needle) => useTuiStore.getState().toasts.some((toast) => toast.text.includes(needle));

  test('12. A late delete or purge result for job A never closes the dialog opened for job B, and confirming while busy says why', async () => {
    for (const variant of [
      { key: 'd', rpc: 'job.dismiss', dialogFor: (title) => `Remove job record "${title}"`, done: 'Job removed', reply: {} },
      { key: 'D', rpc: 'job.trace.delete', dialogFor: (title) => `Purge saved request traces for "${title}"`, done: 'Purged 1 trace(s)', reply: { removed: 1 } },
    ]) {
      resetStore({ language: 'en', asciiMode: false, snapshot: twoFinishedJobsSnapshot() });
      const alphaGate = deferred();
      const { calls, host } = makeHost(async (name, args) => {
        if (name === variant.rpc) {
          if ((args.jobId ?? args.jobIds?.[0]) === 'job-alpha') await alphaGate.promise;
          return { ok: true, value: { jobId: args.jobId, ...variant.reply } };
        }
        return { ok: true, value: { calls: [], text: '' } };
      });
      const rpcCalls = (jobId) => calls.filter((c) => c.name === variant.rpc && c.args.jobId === jobId);
      const h = createHarness(
        React.createElement(TasksView, { host, width: 120, height: 34, isActive: true }),
        { cols: 120, rows: 34, shellActions: makeShellActions() },
      );
      try {
        await h.waitFor((f) => f.includes('Alpha Done Job') && f.includes('Beta Done Job'), 4000, `${variant.key}: both jobs listed`);
        h.dispatchKey(variant.key, {});
        await h.waitFor((f) => f.includes(variant.dialogFor('Alpha Done Job')), 4000, `${variant.key}: dialog for A`);
        h.dispatchKey('y', {});
        await waitCondition(() => rpcCalls('job-alpha').length === 1, 2000, `${variant.key}: A request held`);

        h.dispatchKey('', { escape: true });
        await h.waitFor((f) => !f.includes(variant.dialogFor('Alpha Done Job')), 4000, `${variant.key}: dialog A closed by Esc`);
        h.dispatchKey('', { downArrow: true });
        await new Promise((r) => setTimeout(r, 40));
        h.dispatchKey(variant.key, {});
        await h.waitFor((f) => f.includes(variant.dialogFor('Beta Done Job')), 4000, `${variant.key}: dialog for B`);

        // B is confirmed while A still runs: refused, but with a reason instead of silently.
        h.dispatchKey('y', {});
        await waitCondition(() => hasToast(STILL_RUNNING_EN), 2000, `${variant.key}: busy confirm explains the wait`);
        assert.equal(rpcCalls('job-beta').length, 0, `${variant.key}: B must not start while A is in flight`);

        alphaGate.resolve();
        await waitCondition(() => hasToast(variant.done), 2000, `${variant.key}: A finished`);
        await new Promise((r) => setTimeout(r, 40));
        assert.equal(
          h.frame().includes(variant.dialogFor('Beta Done Job')),
          true,
          `${variant.key}: A's late result must not close the dialog opened for B`,
        );
        h.dispatchKey('y', {});
        await waitCondition(() => rpcCalls('job-beta').length === 1, 2000, `${variant.key}: B confirmed once A is done`);
      } finally {
        alphaGate.resolve();
        h.cleanup();
      }
    }
  });

  test('13. Pause and concurrency overrides are cleared when the refresh finishes or throws; a throwing refresh shows an error, not an unhandled rejection', async () => {
    const snap = makeSampleSnapshot();
    resetStore({ language: 'en', asciiMode: false, snapshot: snap });
    const rejections = [];
    const onRejection = (reason) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);

    let refreshGate = null;
    let refreshThrows = false;
    const { calls, host } = makeHost(async (name, args) => {
      if (name === 'job.live.list') return { ok: true, value: { jobs: [] } };
      if (name === 'job.control' && args?.action === 'pause') return { ok: true, value: { status: 'paused', paused: true } };
      if (name === 'job.control' && args?.action === 'set') {
        return { ok: true, value: { values: { concurrency: args.patch.concurrency } } };
      }
      return { ok: true, value: { calls: [], text: '' } };
    });
    const refresh = async () => {
      if (refreshThrows) throw new Error('refresh exploded');
      if (refreshGate) await refreshGate.promise;
    };
    const h = createHarness(
      React.createElement(TasksView, { host, width: 120, height: 34, isActive: true }),
      { cols: 120, rows: 34, shellActions: makeShellActions(refresh) },
    );
    const pauseCalls = () => calls.filter((c) => c.name === 'job.control' && c.args?.action === 'pause').length;
    try {
      await h.waitFor((f) => f.includes('OS Scheduling Generation') && f.includes('2x') && f.includes('Active'), 4000, 'running job, 2x, Active');

      // p: the optimistic Paused override shows while the refresh is held, then is dropped once it lands
      // (the host data still says running, so the pill returns to Active).
      refreshGate = deferred();
      h.dispatchKey('p', {});
      await h.waitFor((f) => f.includes('Paused'), 4000, 'optimistic Paused while refresh is held');
      refreshGate.resolve();
      await h.waitFor((f) => f.includes('Active') && !f.includes('Paused'), 4000, 'pause override cleared after refresh');

      // +: same for the concurrency override.
      refreshGate = deferred();
      h.dispatchKey('+', {});
      await h.waitFor((f) => f.includes('3x'), 4000, 'optimistic 3x while refresh is held');
      refreshGate.resolve();
      await h.waitFor((f) => f.includes('2x') && !f.includes('3x'), 4000, 'concurrency override cleared after refresh');

      // p with a throwing refresh: error toast, override cleared, no unhandled rejection, busy released.
      refreshGate = null;
      refreshThrows = true;
      const pausesBefore = pauseCalls();
      h.dispatchKey('p', {});
      await waitCondition(() => hasToast('refresh exploded'), 2000, 'error toast for the throwing refresh');
      const errToast = useTuiStore.getState().toasts.find((toast) => toast.text.includes('refresh exploded'));
      assert.equal(errToast?.tone, 'error');
      await h.waitFor((f) => f.includes('Active') && !f.includes('Paused'), 4000, 'override cleared after the throwing refresh');
      await new Promise((r) => setTimeout(r, 40));
      assert.deepEqual(rejections, [], 'a throwing refresh must not leak an unhandled rejection');
      refreshThrows = false;
      h.dispatchKey('p', {});
      await waitCondition(() => pauseCalls() === pausesBefore + 2, 2000, 'busy lock released after the error');
    } finally {
      process.off('unhandledRejection', onRejection);
      refreshGate?.resolve();
      h.cleanup();
    }
  });

  test('14. Moved behaviour: a failed output fetch drops the previous job\'s lines instead of keeping them', async () => {
    resetStore({
      language: 'en',
      asciiMode: false,
      snapshot: {
        root: '',
        courses: [],
        decks: [],
        sources: [],
        drafts: [],
        archivedJobs: [],
        jobs: [
          { id: 'job-b', title: 'Output Beta', type: 'generate', status: 'complete', progress: 1, calls: [{ id: 'call-b', status: 'complete' }] },
          { id: 'job-a', title: 'Output Alpha', type: 'generate', status: 'complete', progress: 1, calls: [{ id: 'call-a', status: 'complete' }] },
        ],
      },
    });
    const { host } = makeHost(async (name, args) => {
      if (name === 'job.output') {
        if (args.jobId === 'job-a') return { ok: true, value: { text: 'alpha stale log line' } };
        return { ok: false, error: { code: 'E', message: 'output unavailable' } };
      }
      return { ok: true, value: { calls: [] } };
    });
    const h = createHarness(
      React.createElement(TasksView, { host, width: 120, height: 34, isActive: true }),
      { cols: 120, rows: 34, shellActions: makeShellActions() },
    );
    try {
      await h.waitFor((f) => f.includes('alpha stale log line'), 4000, 'job A output shown');
      h.dispatchKey('', { downArrow: true });
      const after = await h.waitFor((f) => f.includes('No live output text yet'), 4000, 'job B with failed output');
      assert.equal(after.includes('alpha stale log line'), false, "job A's lines must not stay under job B");
    } finally {
      h.cleanup();
    }
  });

  test('15. Moved behaviour: purge stays pinned to the job it was opened for when a live poll reorders the list', async () => {
    const liveGate = deferred();
    const { calls, host } = makeHost(async (name, args) => {
      if (name === 'job.live.list') {
        await liveGate.promise;
        return {
          ok: true,
          value: {
            jobs: [
              { id: 'job-old', title: 'Old Target Job', type: 'generate', status: 'running', progress: 0.5, calls: [] },
              { id: 'job-new', title: 'New Arriving Job', type: 'generate', status: 'running', progress: 0.1, calls: [] },
            ],
          },
        };
      }
      if (name === 'job.trace.delete') return { ok: true, value: { jobId: args.jobId, removed: 0 } };
      return { ok: true, value: { calls: [], text: '' } };
    });
    resetStore({
      language: 'en',
      asciiMode: false,
      snapshot: {
        root: '',
        courses: [],
        decks: [],
        sources: [],
        drafts: [],
        archivedJobs: [],
        jobs: [{ id: 'job-old', title: 'Old Target Job', type: 'generate', status: 'running', progress: 0.5, calls: [] }],
      },
    });
    const h = createHarness(
      React.createElement(TasksView, { host, width: 120, height: 34, isActive: true }),
      { cols: 120, rows: 34, shellActions: makeShellActions() },
    );
    try {
      await h.waitFor((f) => f.includes('Old Target Job'), 4000, 'initial single job');
      h.dispatchKey('D', {});
      await h.waitFor((f) => f.includes('Purge saved request traces for "Old Target Job"'), 4000, 'purge dialog for the old job');
      liveGate.resolve();
      await h.waitFor((f) => f.includes('New Arriving Job'), 4000, 'new job landed in the list');
      h.dispatchKey('y', {});
      await waitCondition(() => calls.some((c) => c.name === 'job.trace.delete'), 2000, 'purge called');
      assert.deepEqual(calls.find((c) => c.name === 'job.trace.delete')?.args, { jobId: 'job-old' });
    } finally {
      liveGate.resolve();
      h.cleanup();
    }
  });

  test('16. Moved behaviour: a same-tick double X writes the jobs summary once', async () => {
    const libRoot = await makeTempDir('studyhub-tasks-double-x-');
    resetStore({ language: 'en', asciiMode: false, snapshot: makeSampleSnapshot(libRoot) });
    const { host } = makeHost(async () => ({ ok: true, value: { calls: [], jobs: [], text: '' } }), { libraryRoot: libRoot });
    const h = createHarness(
      React.createElement(TasksView, { host, width: 120, height: 34, isActive: true }),
      { cols: 120, rows: 34, shellActions: makeShellActions() },
    );
    const exportToasts = () => useTuiStore.getState().toastHistory.filter((item) => item.text.includes('job(s) summary'));
    try {
      await h.waitFor((f) => f.includes('OS Scheduling Generation'), 4000, 'jobs listed');
      const before = exportToasts().length;
      h.dispatchKey('X', {});
      h.dispatchKey('X', {});
      await waitCondition(() => exportToasts().length > before, 3000, 'summary exported');
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(exportToasts().length - before, 1, 'a same-tick double X must export once');
    } finally {
      h.cleanup();
    }
  });

  test('17. Moved behaviour: a status change of the selected job re-fetches its output', async () => {
    const liveGate = deferred();
    let outputText = 'first pass log';
    const { calls, host } = makeHost(async (name) => {
      if (name === 'job.live.list') {
        await liveGate.promise;
        return {
          ok: true,
          value: {
            jobs: [
              { id: 'job-flip', title: 'Status Flip Job', type: 'generate', status: 'complete', progress: 1, calls: [{ id: 'call-flip', status: 'complete' }] },
            ],
          },
        };
      }
      if (name === 'job.output') return { ok: true, value: { text: outputText } };
      return { ok: true, value: { calls: [] } };
    });
    resetStore({
      language: 'en',
      asciiMode: false,
      snapshot: {
        root: '',
        courses: [],
        decks: [],
        sources: [],
        drafts: [],
        archivedJobs: [],
        jobs: [
          { id: 'job-flip', title: 'Status Flip Job', type: 'generate', status: 'running', progress: 0.5, calls: [{ id: 'call-flip', status: 'complete' }] },
        ],
      },
    });
    const h = createHarness(
      React.createElement(TasksView, { host, width: 120, height: 34, isActive: true }),
      { cols: 120, rows: 34, shellActions: makeShellActions() },
    );
    try {
      const beforeFrame = await h.waitFor((f) => f.includes('first pass log'), 4000, 'first output');
      const initialOutputCalls = calls.filter((c) => c.name === 'job.output' && c.args?.jobId === 'job-flip').length;
      assert.match(beforeFrame, /first pass log/, 'initial output rendered before status flip');
      assert.doesNotMatch(beforeFrame, /second pass log/, 'updated output has not rendered before status flip');
      assert.ok(initialOutputCalls >= 1, 'initial job.output fetch occurred for job-flip');

      outputText = 'second pass log';
      liveGate.resolve();
      const afterFrame = await h.waitFor((f) => f.includes('second pass log'), 4000, 'output re-fetched after the status change');
      const totalOutputCalls = calls.filter((c) => c.name === 'job.output' && c.args?.jobId === 'job-flip').length;
      assert.match(afterFrame, /second pass log/, 'settled frame displays refreshed job output');
      assert.doesNotMatch(afterFrame, /first pass log/, 'stale output text is replaced after status flip');
      assert.ok(totalOutputCalls > initialOutputCalls, 'job.output was re-fetched after status changed');
    } finally {
      liveGate.resolve();
      h.cleanup();
    }
  });

  test('18. Moved behaviour: navContext.jobId preselects that job, so controls act on it', async () => {
    resetStore({ language: 'en', asciiMode: false, snapshot: makeSampleSnapshot(), navContext: { jobId: 'job-queued' } });
    const { calls, host } = makeHost(async (name) => {
      if (name === 'job.live.list') return { ok: true, value: { jobs: [] } };
      if (name === 'job.parallel') return { ok: true, value: { parallel: true, note: 'Started in parallel' } };
      return { ok: true, value: { calls: [], text: '' } };
    });
    const h = createHarness(
      React.createElement(TasksView, { host, width: 120, height: 34, isActive: true }),
      { cols: 120, rows: 34, shellActions: makeShellActions() },
    );
    try {
      await h.waitFor((f) => f.includes('Queued Physics Batch'), 4000, 'jobs listed');
      await new Promise((r) => setTimeout(r, 40));
      h.dispatchKey('P', {});
      await waitCondition(() => calls.some((c) => c.name === 'job.parallel'), 2000, 'parallel requested');
      assert.deepEqual(calls.find((c) => c.name === 'job.parallel')?.args, { jobId: 'contract-queued-1' });
    } finally {
      h.cleanup();
    }
  });
  test('19. Moved behaviour: the open output modal follows the live record of its job', async () => {
    const liveGate = deferred();
    const { host } = makeHost(async (name) => {
      if (name === 'job.live.list') {
        await liveGate.promise;
        return {
          ok: true,
          value: {
            jobs: [
              {
                id: 'job-live-modal',
                title: 'Live Modal Job',
                type: 'generate',
                status: 'running',
                progress: 0.6,
                calls: [
                  { id: 'call-1', status: 'complete', stage: 'outline' },
                  { id: 'call-2', status: 'running', stage: 'drafting' },
                ],
              },
            ],
          },
        };
      }
      if (name === 'job.output') return { ok: true, value: { text: 'modal text', supported: true } };
      return { ok: true, value: { calls: [] } };
    });
    resetStore({
      language: 'en',
      asciiMode: false,
      snapshot: {
        root: '',
        courses: [],
        decks: [],
        sources: [],
        drafts: [],
        archivedJobs: [],
        jobs: [
          {
            id: 'job-live-modal',
            title: 'Live Modal Job',
            type: 'generate',
            status: 'running',
            progress: 0.3,
            calls: [{ id: 'call-1', status: 'running', stage: 'outline' }],
          },
        ],
      },
    });
    const h = createHarness(
      React.createElement(TasksView, { host, width: 120, height: 34, isActive: true }),
      { cols: 120, rows: 34, shellActions: makeShellActions() },
    );
    try {
      await h.waitFor((f) => f.includes('Live Modal Job'), 4000, 'job listed');
      h.dispatchKey('o', {});
      const beforeModal = await h.waitFor((f) => f.includes('Job Output: Live Modal Job') && f.includes('(1/1)'), 4000, 'output modal on the snapshot record');
      assert.match(beforeModal, /Job Output: Live Modal Job/, 'modal opens with job title');
      assert.match(beforeModal, /\(1\/1\)/, 'modal shows initial snapshot call count (1/1)');
      assert.doesNotMatch(beforeModal, /\(2\/2\)/, 'modal has not yet switched to live record');

      liveGate.resolve();
      const afterModal = await h.waitFor((f) => f.includes('Job Output: Live Modal Job') && f.includes('(2/2)'), 4000, 'output modal switched to the live record');
      assert.match(afterModal, /Job Output: Live Modal Job/, 'modal remains open on the same job');
      assert.match(afterModal, /\(2\/2\)/, 'modal updates to live record call count (2/2)');
      assert.doesNotMatch(afterModal, /\(1\/1\)/, 'stale snapshot call count (1/1) is replaced');
    } finally {
      liveGate.resolve();
      h.cleanup();
    }
  });
});
