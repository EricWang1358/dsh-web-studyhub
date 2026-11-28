// Consolidated Legacy E2E Suite: Rounds 16-22
// Merges: round16-e2e, round17-e2e, round18-e2e, round19-e2e, round20-e2e, round21-e2e, round22-e2e
// node --test tests/legacy-rounds-16-22.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { render } from 'ink';
import React from 'react';
import {
  createTempTracker,
  createVirtualTty,
  disposeTerminalPool,
  distDir,
  installNoNetworkGuard,
  loadDistRuntime,
  pkgRoot,
  sanitizedTestEnv,
} from './helpers/virtual-tty.mjs';

const cliBinPath = resolve(pkgRoot, 'bin', 'studyhub-tui.mjs');

const runtime = await loadDistRuntime();
const { StudyHubTuiApp, createTuiHost, saveTuiPreferences } = runtime;
assert.ok(StudyHubTuiApp, 'dist/ must export StudyHubTuiApp');
assert.ok(createTuiHost, 'dist/ must export createTuiHost');
assert.ok(saveTuiPreferences, 'dist/ must export saveTuiPreferences');

const storeFile = (await readdir(distDir)).find((f) => f.startsWith('store-') && f.endsWith('.mjs'));
assert.ok(storeFile, 'dist/ must include store-*.mjs');
const { useTuiStore, DEFAULT_PREFERENCES } = await import(pathToFileURL(join(distDir, storeFile)).href);
assert.ok(useTuiStore, 'dist/store-*.mjs must export useTuiStore');

const PREV_DSH_HOME = process.env.DSH_HOME;
const restoreNetworkGuard = installNoNetworkGuard();
const temps = createTempTracker('studyhub-tui-legacy-16-22-');

function resetDistStore(language = 'zh', asciiMode = false, extra = {}) {
  useTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    snapshot: null,
    binding: null,
    config: null,
    desktopConfig: null,
    loading: false,
    refreshing: false,
    lastError: null,
    activeRunId: null,
    toasts: [],
    footerHints: [],
    commandPaletteOpen: false,
    helpOpen: false,
    coursePickerOpen: false,
    voicePackOpen: false,
    inboxOpen: false,
    showLaunchpad: false,
    inputCaptured: false,
    preferences: {
      ...DEFAULT_PREFERENCES,
      recentCommands: [...(DEFAULT_PREFERENCES.recentCommands ?? [])],
      language,
      asciiMode,
    },
    ...extra,
  });
}

after(async () => {
  restoreNetworkGuard();
  resetDistStore('zh', false);
  disposeTerminalPool();
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await temps.cleanup();
});

/**
 * Unified deterministic model stub covering Rounds 16-22:
 * - Round 18 IngestModal (`You file a learner`, `You write one rigorous study card`, `You convert a learner`)
 * - Fallback JSON reply for all other rounds
 */
function createGroup2StubComplete() {
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

function runCliSubprocess(args, extraEnv = {}, timeoutMs = 10_000) {
  return new Promise((resolveFn, rejectFn) => {
    const startedAt = performance.now();
    const child = spawn(process.execPath, [cliBinPath, ...args], {
      cwd: pkgRoot,
      env: sanitizedTestEnv(extraEnv),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      rejectFn(new Error(`CLI subprocess timed out after ${timeoutMs}ms: ${args.join(' ')}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectFn(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveFn({
        code,
        stdout,
        stderr,
        durationMs: performance.now() - startedAt,
      });
    });
  });
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

function parseQueueCount(screen) {
  const m = screen.match(/(\d+)\s*(?:题|cards)\s*[·|]\s*v(\d+)/);
  return m ? { count: Number(m[1]), version: Number(m[2]) } : null;
}

async function waitForHostCondition(checkFn, { timeoutMs = 8_000, intervalMs = 40, label = 'host condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await checkFn();
    if (val) return val;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
}

async function mountSuiteApp(label, { initialPage = 'library', asciiMode = false, language = 'zh' } = {}) {
  resetDistStore(language, asciiMode);
  const boxDir = await temps.make(label);
  const dshHome = join(boxDir, 'dsh-home');
  const libraryRoot = join(boxDir, 'library');
  process.env.DSH_HOME = dshHome;

  const env = sanitizedTestEnv({ DSH_HOME: dshHome });
  await saveTuiPreferences({ language, asciiMode }, { env });

  const host = await createTuiHost({
    env,
    home: join(boxDir, 'home'),
    libraryRoot,
    injectedComplete: createGroup2StubComplete(),
    skipAutoProbe: true,
    language,
    eventDebounceMs: 30,
  });

  const sampleRes = await host.call('sample.load', { language });
  assert.equal(sampleRes.ok, true, `${label}: sample.load must succeed: ${sampleRes.error?.message || ''}`);

  const tty = createVirtualTty(120, 36);
  let inkInstance = null;
  inkInstance = render(
    React.createElement(StudyHubTuiApp, {
      host,
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
  await tty.firstFramePromise;
  await tty.waitFor(
    (s) =>
      s.includes('示例 · Memento 与 Bridge') &&
      !s.includes('正在打开学习库') &&
      !s.includes('正在加载页面'),
    { timeoutMs: 12_000, label: `${label}: initial LibraryView` },
  );
  await tty.flush();

  return {
    boxDir,
    dshHome,
    libraryRoot,
    host,
    tty,
    async dispose() {
      try {
        inkInstance?.unmount();
      } catch {
        // Ignore unmount errors during teardown
      }
      await host?.dispose();
      tty?.dispose();
      resetDistStore('zh', false);
    },
  };
}

describe('Round 16: StudyPlanModal & TasksView WorkflowHistoryModal / JobOutputModal', () => {
  let ctx;

  before(async () => {
    ctx = await mountSuiteApp('r16');
  });

  after(async () => {
    await ctx?.dispose();
  });

  test('1) ExamPrepView StudyPlanModal (0 -> P): Tab 1 Plan & Tab 2 Readiness at 120x36 & 80x24, Esc closes', async () => {
    const { tty } = ctx;
    tty.send('0');
    const examPrepInit = await tty.waitFor(
      (s) =>
        (s.includes('1:考纲重点进度') || s.includes('1:Focus Progress')) &&
        (s.includes('[P] 备考计划') || s.includes('[P] Plan')) &&
        !s.includes('正在加载备考重点') &&
        !s.includes('正在加载页面'),
      { timeoutMs: 10_000, label: 'ExamPrepView rendered' },
    );
    tty.assertHealthyScreen(examPrepInit, 120, 36, 'ExamPrepView initial');
    assert.equal(useTuiStore.getState().page, 'examprep', 'Key 0 must open ExamPrepView');

    tty.send('P');
    const planTabWide = await tty.waitFor(
      (s) =>
        (s.includes('课程备考计划 & 章节就绪度') || s.includes('Study Plan & Chapter Readiness')) &&
        (s.includes('1:备考计划') || s.includes('1:Study Plan')) &&
        !s.includes('正在加载备考计划') &&
        !s.includes('Loading study plan') &&
        (s.includes('近期日程') ||
          s.includes('Upcoming Schedule') ||
          s.includes('尚未') ||
          s.includes('No study plan') ||
          s.includes('No review book') ||
          s.includes('No exam date')),
      { timeoutMs: 10_000, label: 'StudyPlanModal Tab 1 rendered at 120x36' },
    );
    tty.assertHealthyScreen(planTabWide, 120, 36, 'StudyPlanModal Tab 1 at 120x36');
    assert.ok(planTabWide.includes('1:备考计划') || planTabWide.includes('1:Study Plan'));

    tty.send('2');
    const readinessTabWide = await tty.waitFor(
      (s) =>
        (s.includes('2:章节就绪度') || s.includes('2:Readiness')) &&
        !s.includes('正在分析章节就绪度与估算') &&
        !s.includes('Loading chapter readiness') &&
        (s.includes('粗估消耗') || s.includes('Rough est.')) &&
        (s.includes('章节就绪度 (') || s.includes('Chapter Readiness (')),
      { timeoutMs: 10_000, label: 'StudyPlanModal Tab 2 Readiness rendered at 120x36' },
    );
    tty.assertHealthyScreen(readinessTabWide, 120, 36, 'StudyPlanModal Tab 2 at 120x36');
    assert.ok(readinessTabWide.includes('粗估消耗') || readinessTabWide.includes('Rough est.'));

    tty.resize(80, 24);
    const readinessTabNarrow = await tty.waitFor(
      (s) =>
        (s.includes('课程备考计划 & 章节就绪度') || s.includes('Study Plan & Chapter Readiness')) &&
        (s.includes('粗估消耗') || s.includes('Rough est.')) &&
        s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'StudyPlanModal Tab 2 at 80x24' },
    );
    tty.assertHealthyScreen(readinessTabNarrow, 80, 24, 'StudyPlanModal Tab 2 at 80x24');
    assert.ok(readinessTabNarrow.split('\n').length <= 24);

    tty.resize(120, 36);
    await tty.waitFor(
      (s) => s.includes('课程备考计划 & 章节就绪度') || s.includes('Study Plan & Chapter Readiness'),
      { timeoutMs: 8_000, label: 'StudyPlanModal restored to 120x36' },
    );

    tty.send('\x1b');
    const backToExamPrep = await tty.waitFor(
      (s) =>
        !s.includes('课程备考计划 & 章节就绪度') &&
        !s.includes('Study Plan & Chapter Readiness') &&
        (s.includes('1:考纲重点进度') || s.includes('1:Focus Progress')),
      { timeoutMs: 8_000, label: 'StudyPlanModal closed via Esc' },
    );
    tty.assertHealthyScreen(backToExamPrep, 120, 36, 'ExamPrepView after StudyPlanModal closed');
    assert.ok(!backToExamPrep.includes('课程备考计划 & 章节就绪度'));
    assert.equal(useTuiStore.getState().page, 'examprep');
  });

  test('2) TasksView WorkflowHistoryModal (t -> w) at 120x36 & 80x24, plus safe o / a / r handling', async () => {
    const { host, tty } = ctx;
    tty.send('t');
    const tasksInit = await tty.waitFor(
      (s) =>
        (s.includes('监控后台任务') || s.includes('Monitor jobs')) &&
        (s.includes('1. 运行中') || s.includes('1. Running')) &&
        !s.includes('正在加载页面'),
      { timeoutMs: 10_000, label: 'TasksView rendered' },
    );
    tty.assertHealthyScreen(tasksInit, 120, 36, 'TasksView initial');
    assert.equal(useTuiStore.getState().page, 'tasks', 'Key t must open TasksView');

    tty.send('w');
    const wfWide = await tty.waitFor(
      (s) =>
        (s.includes('历史学习流记录 (只读)') || s.includes('Workflow History (Read-Only)')) &&
        !s.includes('正在读取历史学习流') &&
        !s.includes('Loading workflow history'),
      { timeoutMs: 10_000, label: 'WorkflowHistoryModal rendered at 120x36' },
    );
    tty.assertHealthyScreen(wfWide, 120, 36, 'WorkflowHistoryModal at 120x36');
    assert.ok(wfWide.includes('历史学习流记录 (只读)') || wfWide.includes('Workflow History (Read-Only)'));

    tty.send('r');
    const wfRefreshed = await tty.waitFor(
      (s) =>
        (s.includes('历史学习流记录 (只读)') || s.includes('Workflow History (Read-Only)')) &&
        !s.includes('正在读取历史学习流'),
      { timeoutMs: 8_000, label: 'WorkflowHistoryModal after r refresh' },
    );
    tty.assertHealthyScreen(wfRefreshed, 120, 36, 'WorkflowHistoryModal after r refresh');
    assert.ok(wfRefreshed.includes('历史学习流记录 (只读)') || wfRefreshed.includes('Workflow History (Read-Only)'));

    tty.resize(80, 24);
    const wfNarrow = await tty.waitFor(
      (s) =>
        (s.includes('历史学习流记录 (只读)') || s.includes('Workflow History (Read-Only)')) &&
        s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'WorkflowHistoryModal at 80x24' },
    );
    tty.assertHealthyScreen(wfNarrow, 80, 24, 'WorkflowHistoryModal at 80x24');
    assert.ok(wfNarrow.split('\n').length <= 24);

    tty.resize(120, 36);
    await tty.waitFor(
      (s) => s.includes('历史学习流记录 (只读)') || s.includes('Workflow History (Read-Only)'),
      { timeoutMs: 8_000, label: 'WorkflowHistoryModal restored to 120x36' },
    );

    tty.send('\x1b');
    const backToTasks = await tty.waitFor(
      (s) =>
        !s.includes('历史学习流记录 (只读)') &&
        !s.includes('Workflow History (Read-Only)') &&
        (s.includes('监控后台任务') || s.includes('Monitor jobs')),
      { timeoutMs: 8_000, label: 'WorkflowHistoryModal closed via Esc' },
    );
    tty.assertHealthyScreen(backToTasks, 120, 36, 'TasksView after WorkflowHistoryModal closed');
    assert.ok(!backToTasks.includes('历史学习流记录 (只读)'));

    tty.send('o');
    const afterEmptyO = await tty.waitFor(
      (s) =>
        (s.includes('请先选择一个任务') || s.includes('Select a job first') || s.includes('任务输出:')) &&
        (s.includes('监控后台任务') || s.includes('Monitor jobs')),
      { timeoutMs: 5_000, label: 'TasksView o on empty job list' },
    );
    tty.assertHealthyScreen(afterEmptyO, 120, 36, 'TasksView after o (empty)');
    assert.ok(afterEmptyO.includes('监控后台任务') || afterEmptyO.includes('Monitor jobs'));

    tty.send('a');
    await tty.flush(60);
    tty.assertHealthyScreen(tty.readScreen(), 120, 36, 'TasksView after a (empty)');

    const snapRes = await host.call('snapshot', {});
    assert.equal(snapRes.ok, true, 'snapshot must succeed');
    const sources = snapRes.value?.sources ?? [];
    const activeSource = sources.find((s) => !s.archived) ?? sources[0];
    assert.ok(activeSource, 'Sample must include an active source');
    const activeCourse =
      activeSource?.course || activeSource?.courses?.[0] || snapRes.value?.courses?.[0]?.name || '示例 · Memento 与 Bridge';
    const genRes = await host.call('generate', {
      course: activeCourse,
      sourceIds: [activeSource.id],
      count: 5,
      kind: 'quiz',
      title: 'R16 E2E Job',
    });
    assert.equal(
      genRes.ok,
      true,
      `generate job for TasksView should succeed: ${genRes.error?.message || JSON.stringify(genRes)}`,
    );
    const snapAfterGen = await host.call('snapshot', {});
    assert.equal(snapAfterGen.ok, true, 'snapshot after generate must succeed');
    useTuiStore.getState().setSnapshot(snapAfterGen.value);

    const populatedTasks = await tty.waitFor(
      (s) =>
        (s.includes('R16 E2E Job') || s.includes('2. 全部 (1)') || s.includes('2. All (1)')) &&
        !s.includes('当前筛选下无任务'),
      { timeoutMs: 10_000, label: 'Populated job visible in TasksView' },
    );
    tty.assertHealthyScreen(populatedTasks, 120, 36, 'TasksView populated job');
    assert.ok(populatedTasks.includes('R16 E2E Job'), 'Generated job title must appear in TasksView');

    tty.send('o');
    const outputModal = await tty.waitFor(
      (s) =>
        (s.includes('任务输出:') || s.includes('Job Output:')) &&
        !s.includes('正在获取任务输出') &&
        !s.includes('Loading job output'),
      { timeoutMs: 8_000, label: 'JobOutputModal opened on populated job' },
    );
    tty.assertHealthyScreen(outputModal, 120, 36, 'JobOutputModal opened');
    assert.ok(outputModal.includes('任务输出:') || outputModal.includes('Job Output:'));

    tty.send('r');
    const outputRefreshed = await tty.waitFor(
      (s) =>
        (s.includes('任务输出:') || s.includes('Job Output:')) &&
        !s.includes('正在获取任务输出') &&
        !s.includes('Loading job output'),
      { timeoutMs: 8_000, label: 'JobOutputModal refreshed via r' },
    );
    tty.assertHealthyScreen(outputRefreshed, 120, 36, 'JobOutputModal after r');
    assert.ok(outputRefreshed.includes('任务输出:') || outputRefreshed.includes('Job Output:'));

    tty.send('\x1b');
    const backAfterOutput = await tty.waitFor(
      (s) => !s.includes('任务输出:') && !s.includes('Job Output:'),
      { timeoutMs: 8_000, label: 'JobOutputModal closed via Esc' },
    );
    tty.assertHealthyScreen(backAfterOutput, 120, 36, 'TasksView after JobOutputModal closed');
    assert.ok(!backAfterOutput.includes('任务输出:'));

    tty.send('a');
    await tty.flush(100);
    tty.assertHealthyScreen(tty.readScreen(), 120, 36, 'TasksView after a on populated job');
  });
});

describe('Round 17: BoardView Sync Bridge, NoteEditor Direct Ctrl+S & CLI Matrix', () => {
  let ctx;

  before(async () => {
    ctx = await mountSuiteApp('r17');
  });

  after(async () => {
    await ctx?.dispose();
  });

  test('1) BoardView StudyHub Backend Sync Bridge ([S] + board.card.add -> BoardView -> move L -> board.get)', async () => {
    const { host, tty } = ctx;
    const taskTitle = 'Synced Daily Plan Task R17';
    const initialBoard = await host.call('board.get', {});
    assert.equal(initialBoard.ok, true, `board.get must succeed: ${initialBoard.error?.message || ''}`);

    const addRes = await host.call('board.card.add', {
      revision: initialBoard.value?.revision ?? 0,
      title: taskTitle,
    });
    assert.equal(addRes.ok, true, `board.card.add must succeed: ${addRes.error?.message || ''}`);

    const upstreamEntries = Object.entries(addRes.value?.cards || {});
    const createdEntry = upstreamEntries.find(([, card]) => card?.title === taskTitle);
    assert.ok(createdEntry, 'Created upstream card must exist in board.card.add result');
    const [upstreamCardId] = createdEntry;

    tty.send('b');
    await tty.waitFor(
      (s) =>
        (s.includes('待办 Todo') || s.includes('Todo')) &&
        (s.includes('进行中 Doing') || s.includes('Doing')) &&
        !s.includes('正在加载页面') &&
        !s.includes('载入看板'),
      { timeoutMs: 10_000, label: 'BoardView rendered' },
    );
    assert.equal(useTuiStore.getState().page, 'board', 'Key b must navigate to BoardView');

    tty.send('S');
    const syncedWide = await tty.waitFor(
      (s) => s.includes(taskTitle) && s.includes('◈ SH'),
      { timeoutMs: 8_000, label: 'Synced card with StudyHub badge rendered at 120x36' },
    );
    tty.assertHealthyScreen(syncedWide, 120, 36, 'BoardView synced 120x36');
    assert.ok(syncedWide.includes('◈ SH'), 'Synced card must display StudyHub badge');

    tty.resize(80, 24);
    const syncedNarrow = await tty.waitFor(
      (s) => s.includes(taskTitle) && s.includes('SH') && s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'BoardView synced rendered at 80x24' },
    );
    tty.assertHealthyScreen(syncedNarrow, 80, 24, 'BoardView synced 80x24');
    assert.ok(syncedNarrow.includes(taskTitle) && syncedNarrow.split('\n').length <= 24);

    tty.resize(120, 36);
    await tty.waitFor(
      (s) => s.includes(taskTitle) && s.includes('◈ SH') && s.includes('进行中 Doing'),
      { timeoutMs: 8_000, label: 'BoardView restored to 120x36' },
    );

    tty.send('L');
    const movedUpstream = await waitForHostCondition(
      async () => {
        const boardAfter = await host.call('board.get', {});
        assert.equal(boardAfter.ok, true, 'board.get after move must succeed');
        const doingCol = boardAfter.value?.columns?.find((c) => c.id === 'doing');
        return Array.isArray(doingCol?.cardIds) && doingCol.cardIds.includes(upstreamCardId);
      },
      { timeoutMs: 8_000, label: 'Upstream card moved to doing column' },
    );
    assert.equal(movedUpstream, true, 'Upstream card must move into "doing" column after pressing L');
    await tty.flush();
    tty.assertHealthyScreen(tty.readScreen(), 120, 36, 'BoardView after moving synced card to doing');
  });

  test('2) NoteEditorModal Direct Ctrl+S on Body Field Single-Create Regression', async () => {
    const { host, tty } = ctx;
    tty.send('n');
    const notesInit = await tty.waitFor(
      (s) =>
        (s.includes('Unicode Math') || s.includes('Raw LaTeX') || s.includes('笔记正文') || s.includes('Note Reader')) &&
        !s.includes('载入笔记中') &&
        !s.includes('正在加载页面'),
      { timeoutMs: 10_000, label: 'NotesView rendered' },
    );
    tty.assertHealthyScreen(notesInit, 120, 36, 'NotesView initial');
    assert.equal(useTuiStore.getState().page, 'notes', 'Key n must open NotesView');

    const beforeRes = await host.call('note.list', {});
    assert.equal(beforeRes.ok, true, `note.list before create must succeed: ${beforeRes.error?.message || ''}`);
    const beforeCount = Array.isArray(beforeRes.value?.notes) ? beforeRes.value.notes.length : 0;

    tty.send('a');
    const createModal = await tty.waitFor(
      (s) =>
        (s.includes('新建学习笔记') || s.includes('New Study Note')) &&
        (s.includes('已选 1/30') || s.includes('Linked Cards (1/30)')),
      { timeoutMs: 8_000, label: 'NoteEditorModal create opened with preselected card' },
    );
    tty.assertHealthyScreen(createModal, 120, 36, 'NoteEditorModal opened');

    const noteTitle = 'Direct CtrlS Regression';
    const noteBody = 'Saved directly from body';

    tty.send(noteTitle);
    await tty.waitFor((s) => s.includes(noteTitle), { timeoutMs: 5_000, label: 'Note title typed' });

    for (let i = 0; i < 3; i += 1) {
      tty.send('\t');
      await tty.flush(20);
    }

    tty.send(noteBody);
    const bodyTypedScreen = await tty.waitFor((s) => s.includes(noteBody), {
      timeoutMs: 5_000,
      label: 'Note body typed directly in markdown field',
    });
    assert.ok(
      bodyTypedScreen.includes('输入关键词按 Enter 搜索题目') || bodyTypedScreen.includes('Type keywords + Enter to search'),
      'Query field must remain untouched (proving focus moved to markdown body)',
    );

    tty.send('\x13');
    await tty.waitFor((s) => !s.includes('新建学习笔记') && !s.includes('New Study Note'), {
      timeoutMs: 8_000,
      label: 'NoteEditorModal closed after direct Ctrl+S on body',
    });

    await tty.flush(350);

    const afterRes = await host.call('note.list', {});
    assert.equal(afterRes.ok, true, `note.list after create must succeed: ${afterRes.error?.message || ''}`);
    const afterNotes = Array.isArray(afterRes.value?.notes) ? afterRes.value.notes : [];
    assert.equal(
      afterNotes.length,
      beforeCount + 1,
      `Expected exactly 1 created note (before=${beforeCount}, after=${afterNotes.length})`,
    );
    const matchingNotes = afterNotes.filter((n) => n.title === noteTitle);
    assert.equal(matchingNotes.length, 1, 'Direct Ctrl+S on body must not double-create notes');

    const settledScreen = await tty.waitFor((s) => s.includes(noteTitle) && s.includes(noteBody), {
      timeoutMs: 6_000,
      label: 'Created note rendered in NotesView',
    });
    tty.assertHealthyScreen(settledScreen, 120, 36, 'NotesView settled after direct Ctrl+S');
    assert.ok(settledScreen.includes(noteTitle) && settledScreen.includes(noteBody));

    tty.send('d');
    const deleteDialog = await tty.waitFor((s) => s.includes('删除笔记') || s.includes('Delete Note'), {
      timeoutMs: 8_000,
      label: 'Delete note confirmation dialog opened',
    });
    tty.assertHealthyScreen(deleteDialog, 120, 36, 'NotesView delete dialog');
    assert.ok(deleteDialog.includes('删除笔记') || deleteDialog.includes('Delete Note'));

    tty.send('y');
    const afterDeleteScreen = await tty.waitFor(
      (s) => !s.includes('删除笔记') && !s.includes('Delete Note') && !s.includes(noteTitle),
      { timeoutMs: 8_000, label: 'Test note deleted from NotesView' },
    );
    tty.assertHealthyScreen(afterDeleteScreen, 120, 36, 'NotesView after delete');
    assert.ok(!afterDeleteScreen.includes(noteTitle));

    const finalRes = await host.call('note.list', {});
    assert.equal(finalRes.ok, true, 'note.list after delete must succeed');
    assert.equal(finalRes.value?.notes?.length, beforeCount, 'note.list count must return to beforeCount');
  });

  test('3) Real Subprocess CLI Cross-Platform Matrix (bin/studyhub-tui.mjs)', async () => {
    const verRes = await runCliSubprocess(['--version'], { NO_COLOR: '1', TERM: 'dumb' });
    assert.equal(verRes.code, 0, `--version should exit 0, stderr: ${verRes.stderr}`);
    assert.match(verRes.stdout, /studyhub-tui\s+\d+\.\d+\.\d+/);
    assert.equal(verRes.stdout.includes('\x1b'), false, 'stdout must contain no ESC ANSI sequences');
    assert.equal(verRes.stdout.includes('\u009b'), false, 'stdout must contain no CSI ANSI sequences');
    assert.equal(verRes.stderr, '', '--version must produce empty stderr');
    const coldBudgetMs = process.platform === 'win32' ? 3000 : 1500;
    assert.ok(verRes.durationMs < coldBudgetMs, `--version fast-path took ${verRes.durationMs.toFixed(1)}ms (>= ${coldBudgetMs}ms)`);

    const helpAsciiRes = await runCliSubprocess(['--help'], { STUDYHUB_TUI_ASCII: '1' });
    assert.equal(helpAsciiRes.code, 0, `--help should exit 0, stderr: ${helpAsciiRes.stderr}`);
    assert.equal(helpAsciiRes.stderr, '', '--help must produce empty stderr');
    for (const token of ['--ascii', '--theme', '--lang', 'agy']) {
      assert.ok(helpAsciiRes.stdout.includes(token), `--help output must document "${token}"`);
    }

    const spacedRes = await runCliSubprocess([
      '--theme',
      'nord',
      '--lang',
      'en',
      '--root',
      join(tmpdir(), 'path with spaces'),
      '--help',
    ]);
    assert.equal(spacedRes.code, 0, `spaced --root --help should exit 0, stderr: ${spacedRes.stderr}`);
    assert.ok(spacedRes.stdout.includes('StudyHub TUI'), 'spaced --root --help must print help text');
    assert.equal(spacedRes.stderr, '', 'spaced --root --help must produce empty stderr');

    const badThemeRes = await runCliSubprocess(['--theme', 'unknown-theme']);
    assert.equal(badThemeRes.code, 2, `invalid --theme should exit 2, got ${badThemeRes.code}`);
    assert.match(badThemeRes.stderr, /Invalid --theme "unknown-theme"/);
    assert.equal(badThemeRes.stdout, '', 'invalid --theme must produce empty stdout');
  });
});

describe('Round 18: GenerateView IngestModal & DashboardView Forecast/Drill-Down', () => {
  let ctx;

  before(async () => {
    ctx = await mountSuiteApp('r18');
  });

  after(async () => {
    await ctx?.dispose();
  });

  test('1) GenerateView IngestModal (3 -> i): Quick Capture & Bulk Ingest at 120x36 & 80x24, Esc closes', async () => {
    const { host, tty } = ctx;
    const initialCardCount = await countSnapshotCards(host);

    tty.send('3');
    const genInit = await tty.waitFor(
      (s) =>
        (s.includes('1. 选择资料') || s.includes('1. Select Materials')) &&
        (s.includes('2. 出题设置与预估') || s.includes('2. Generation Settings')) &&
        !s.includes('正在加载页面'),
      { timeoutMs: 10_000, label: 'GenerateView rendered' },
    );
    tty.assertHealthyScreen(genInit, 120, 36, 'GenerateView initial');
    assert.equal(useTuiStore.getState().page, 'generate', 'Key 3 must open GenerateView');

    tty.send('i');
    const ingestTab1 = await tty.waitFor(
      (s) =>
        (s.includes('快速录题与批量整理') || s.includes('Quick Capture & Bulk Ingest')) &&
        (s.includes('题干 *') || s.includes('Question *')),
      { timeoutMs: 10_000, label: 'IngestModal Tab 1 rendered' },
    );
    tty.assertHealthyScreen(ingestTab1, 120, 36, 'IngestModal Tab 1 initial');
    assert.ok(ingestTab1.includes('快速录题与批量整理') || ingestTab1.includes('Quick Capture & Bulk Ingest'));

    tty.send('What is the Observer pattern?');
    await tty.waitFor((s) => s.includes('What is the Observer pattern?'), {
      timeoutMs: 5_000,
      label: 'Question typed in IngestModal',
    });

    tty.send('\t');
    await tty.flush();
    tty.send('Defines one-to-many dependency between objects.');
    await tty.waitFor((s) => s.includes('Defines one-to-many dependency'), {
      timeoutMs: 5_000,
      label: 'Answer typed in IngestModal',
    });

    tty.send('\x13');
    const captureDone = await tty.waitFor(
      (s) => (s.includes('已录入') || s.includes('Added to')) && !s.includes('正在识别并归档题目'),
      { timeoutMs: 10_000, label: 'Quick Capture completed' },
    );
    tty.assertHealthyScreen(captureDone, 120, 36, 'IngestModal after Quick Capture');
    assert.ok(captureDone.includes('已录入') || captureDone.includes('Added to'));

    const afterCaptureCount = await countSnapshotCards(host);
    assert.equal(afterCaptureCount, initialCardCount + 1, 'Quick Capture should add 1 card to snapshot');

    tty.send('\x14');
    const ingestTab2 = await tty.waitFor(
      (s) =>
        (s.includes('粘贴既有题目或试卷错题') || s.includes('Paste Existing Questions')) &&
        !s.includes('题干 * (Question)'),
      { timeoutMs: 8_000, label: 'IngestModal Tab 2 Bulk Ingest rendered' },
    );
    tty.assertHealthyScreen(ingestTab2, 120, 36, 'IngestModal Tab 2 initial');
    assert.ok(ingestTab2.includes('粘贴既有题目或试卷错题') || ingestTab2.includes('Paste Existing Questions'));

    const rawBlock = 'Q: What is the Flyweight pattern?\nA: Shares intrinsic state across many fine-grained objects to save memory.';
    tty.send(`\x1b[200~${rawBlock}\x1b[201~`);
    await tty.waitFor((s) => s.includes('Flyweight pattern'), {
      timeoutMs: 5_000,
      label: 'Bulk text pasted in IngestModal',
    });

    tty.send('\x13');
    const ingestSummary = await tty.waitFor(
      (s) =>
        (s.includes('批量整理结果') || s.includes('Bulk Ingest Summary')) &&
        (s.includes('新增 1') || s.includes('Added 1')) &&
        s.includes('What is the Flyweight pattern?'),
      { timeoutMs: 10_000, label: 'Bulk Ingest summary rendered at 120x36' },
    );
    tty.assertHealthyScreen(ingestSummary, 120, 36, 'IngestModal Bulk Ingest summary at 120x36');
    assert.ok(ingestSummary.includes('What is the Flyweight pattern?'), 'Summary must list ingested card prompt');

    const afterIngestCount = await countSnapshotCards(host);
    assert.equal(afterIngestCount, initialCardCount + 2, 'Bulk Ingest should add 1 more card to snapshot');

    tty.resize(80, 24);
    const ingestSummaryNarrow = await tty.waitFor(
      (s) =>
        (s.includes('批量整理结果') || s.includes('Bulk Ingest Summary')) &&
        (s.includes('新增 1') || s.includes('Added 1')) &&
        s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'IngestModal summary at 80x24' },
    );
    tty.assertHealthyScreen(ingestSummaryNarrow, 80, 24, 'IngestModal summary at 80x24');
    assert.ok(ingestSummaryNarrow.split('\n').length <= 24);

    tty.resize(120, 36);
    await tty.waitFor((s) => s.includes('批量整理结果') || s.includes('Bulk Ingest Summary'), {
      timeoutMs: 8_000,
      label: 'IngestModal restored to 120x36',
    });

    tty.send('\x1b');
    const backToGen = await tty.waitFor(
      (s) =>
        !s.includes('快速录题与批量整理') &&
        !s.includes('Quick Capture & Bulk Ingest') &&
        (s.includes('1. 选择资料') || s.includes('1. Select Materials')),
      { timeoutMs: 8_000, label: 'IngestModal closed via Esc' },
    );
    tty.assertHealthyScreen(backToGen, 120, 36, 'GenerateView after IngestModal closed');
    assert.ok(!backToGen.includes('快速录题与批量整理'));
  });

  test('2) DashboardView (6): KPIs, 7-day forecast [f] at 120x36 & 80x24, and j/k + Enter drill-down into ReviewView', async () => {
    const { tty } = ctx;
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
    assert.ok(dashInit.includes('总题数') || dashInit.includes('Cards'), 'DashboardView should display KPI cards');
    assert.equal(useTuiStore.getState().page, 'dashboard', 'Key 6 must open DashboardView');

    tty.send('f');
    const dashForecastWide = await tty.waitFor(
      (s) => s.includes('7 日到期预测') || s.includes('7-Day Forecast'),
      { timeoutMs: 8_000, label: 'DashboardView 7-day forecast at 120x36' },
    );
    tty.assertHealthyScreen(dashForecastWide, 120, 36, 'DashboardView 7-day forecast at 120x36');
    assert.ok(dashForecastWide.includes('7 日到期预测') || dashForecastWide.includes('7-Day Forecast'));

    tty.resize(80, 24);
    const dashForecastNarrow = await tty.waitFor(
      (s) => (s.includes('7 日到期预测') || s.includes('7-Day Forecast')) && s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'DashboardView 7-day forecast at 80x24' },
    );
    tty.assertHealthyScreen(dashForecastNarrow, 80, 24, 'DashboardView 7-day forecast at 80x24');
    assert.ok(dashForecastNarrow.split('\n').length <= 24);

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
    assert.ok(dashMasteryNarrow.includes('掌握度 & FSRS') || dashMasteryNarrow.includes('Mastery & FSRS'));

    tty.resize(120, 36);
    await tty.waitFor(
      (s) =>
        (s.includes('学习统计与掌握度') || s.includes('Study Analytics & Mastery')) &&
        (s.includes('薄弱点与课程钻取') || s.includes('Weak Topics & Courses')),
      { timeoutMs: 8_000, label: 'DashboardView restored to 120x36' },
    );

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
    assert.equal(useTuiStore.getState().page, 'review', 'Drill-down Enter must navigate to ReviewView');
  });
});

describe('Round 19: BookExportModal & CardToolsModal Revert/Prerequisites', () => {
  let ctx;

  before(async () => {
    ctx = await mountSuiteApp('r19');
  });

  after(async () => {
    await ctx?.dispose();
  });

  test('1) BookView BookExportModal (7 -> x): estimate or empty state, [q]/[k] toggles if enabled, 120x36 & 80x24, Esc closes', async () => {
    const { tty } = ctx;
    tty.send('7');
    const bookInit = await tty.waitFor(
      (s) =>
        (s.includes('精选问答') || s.includes('Pinned QA')) &&
        !s.includes('正在打开复习全书') &&
        !s.includes('正在加载页面'),
      { timeoutMs: 10_000, label: 'BookView rendered' },
    );
    tty.assertHealthyScreen(bookInit, 120, 36, 'BookView initial at 120x36');
    assert.equal(useTuiStore.getState().page, 'book', 'Key 7 must open BookView');

    tty.send('x');
    const exportScreen = await tty.waitFor(
      (s) =>
        (s.includes('导出可打印复习全书') || s.includes('Export Printable Review Book')) &&
        !s.includes('正在读取复习全书并估算页数') &&
        !s.includes('Loading book and estimating pages') &&
        (s.includes('A4 预估') ||
          s.includes('Est. A4:') ||
          s.includes('该课程还没有复习全书') ||
          s.includes('No review book for this course yet') ||
          s.includes('请先选择一门课程') ||
          s.includes('Select a course first')),
      { timeoutMs: 10_000, label: 'BookExportModal loaded at 120x36' },
    );
    tty.assertHealthyScreen(exportScreen, 120, 36, 'BookExportModal initial at 120x36');

    const exportEnabled = exportScreen.includes('A4 预估') || exportScreen.includes('Est. A4:');
    if (exportEnabled) {
      tty.send('q');
      const qAllScreen = await tty.waitFor(
        (s) =>
          (s.includes('导出可打印复习全书') || s.includes('Export Printable Review Book')) &&
          !s.includes('正在更新 A4 页数估算') &&
          !s.includes('Updating A4 estimate') &&
          (s.includes('全部 all') || s.includes('All')),
        { timeoutMs: 8_000, label: 'BookExportModal [q] cycled to all' },
      );
      tty.assertHealthyScreen(qAllScreen, 120, 36, 'BookExportModal [q] -> all');
      assert.ok(qAllScreen.includes('全部 all') || qAllScreen.includes('All'));

      tty.send('q');
      const qNoneScreen = await tty.waitFor(
        (s) =>
          (s.includes('导出可打印复习全书') || s.includes('Export Printable Review Book')) &&
          !s.includes('正在更新 A4 页数估算') &&
          !s.includes('Updating A4 estimate') &&
          (s.includes('不含 none') || s.includes('None')),
        { timeoutMs: 8_000, label: 'BookExportModal [q] cycled to none' },
      );
      tty.assertHealthyScreen(qNoneScreen, 120, 36, 'BookExportModal [q] -> none');
      assert.ok(qNoneScreen.includes('不含 none') || qNoneScreen.includes('None'));

      tty.send('k');
      const kOnScreen = await tty.waitFor(
        (s) =>
          (s.includes('导出可打印复习全书') || s.includes('Export Printable Review Book')) &&
          !s.includes('正在更新 A4 页数估算') &&
          !s.includes('Updating A4 estimate') &&
          s.includes('ON') &&
          (s.includes('文末附带答案与解析') || s.includes('append answers & explanations')),
        { timeoutMs: 8_000, label: 'BookExportModal [k] toggled ON' },
      );
      tty.assertHealthyScreen(kOnScreen, 120, 36, 'BookExportModal [k] -> ON');
      assert.ok(kOnScreen.includes('ON'), 'Answer key toggle must show ON');
    }

    tty.resize(80, 24);
    const exportNarrow = await tty.waitFor(
      (s) =>
        (s.includes('导出可打印复习全书') || s.includes('Export Printable Review Book')) &&
        s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'BookExportModal rendered at 80x24' },
    );
    tty.assertHealthyScreen(exportNarrow, 80, 24, 'BookExportModal at 80x24');
    assert.ok(exportNarrow.split('\n').length <= 24);

    tty.resize(120, 36);
    await tty.waitFor(
      (s) => s.includes('导出可打印复习全书') || s.includes('Export Printable Review Book'),
      { timeoutMs: 8_000, label: 'BookExportModal restored to 120x36' },
    );

    tty.send('\x1b');
    const backToBook = await tty.waitFor(
      (s) =>
        !s.includes('导出可打印复习全书') &&
        !s.includes('Export Printable Review Book') &&
        (s.includes('精选问答') || s.includes('Pinned QA')),
      { timeoutMs: 8_000, label: 'BookExportModal closed via Esc' },
    );
    tty.assertHealthyScreen(backToBook, 120, 36, 'BookView after BookExportModal closed');
    assert.ok(!backToBook.includes('导出可打印复习全书'));
  });

  test('2) CardToolsModal Undo Revert ([7] card.revert) & Prerequisite Links ([8] card.link)', async () => {
    const { host, tty } = ctx;
    tty.send('1');
    await tty.waitFor(
      (s) =>
        s.includes('示例 · Memento 与 Bridge') &&
        (s.includes('题组列表') || s.includes('Decks')) &&
        !s.includes('正在打开学习库') &&
        !s.includes('正在加载页面'),
      { timeoutMs: 10_000, label: 'LibraryView rendered' },
    );
    await tty.flush();

    tty.send('\r');
    const reviewInit = await tty.waitFor(
      (s) =>
        (s.includes('[D]工具') || s.includes('[D]Tools')) &&
        !s.includes('正在准备复习队列') &&
        !s.includes('正在加载页面') &&
        /\b1\/\d+/.test(s),
      { timeoutMs: 10_000, label: 'ReviewView rendered on first sample deck' },
    );
    tty.assertHealthyScreen(reviewInit, 120, 36, 'ReviewView initial');

    const beforeCardRes = await host.call('card.current', {});
    assert.equal(beforeCardRes.ok, true, 'card.current must succeed');
    const currentCardId = beforeCardRes.value?.card?.id;
    const originalPrompt = String(beforeCardRes.value?.card?.prompt || '').trim();
    assert.ok(currentCardId && originalPrompt.length > 0, 'Active card must have id and prompt');
    const originalPromptSnippet = originalPrompt.slice(0, Math.min(18, originalPrompt.length));
    assert.ok(
      reviewInit.includes(originalPromptSnippet),
      `ReviewView should render original prompt snippet "${originalPromptSnippet}"`,
    );

    tty.send('D');
    const toolsMenu1 = await tty.waitFor(
      (s) =>
        (s.includes('题目工具箱') || s.includes('Card Tools')) &&
        (s.includes('撤销上次修改') || s.includes('Undo Last Edit')) &&
        (s.includes('无历史') || s.includes('None')),
      { timeoutMs: 8_000, label: 'CardToolsModal opened before edit' },
    );
    tty.assertHealthyScreen(toolsMenu1, 120, 36, 'CardToolsModal menu before edit');
    await tty.flush();

    tty.send('1');
    await tty.waitFor(
      (s) => s.includes('1. 题干 (prompt)') || s.includes('1. Stem (prompt)'),
      { timeoutMs: 8_000, label: 'CardToolsModal edit form opened' },
    );
    await tty.flush();

    const editTag = ' [R19EDIT]';
    tty.send(editTag);
    await tty.waitFor((s) => s.includes('[R19EDIT]'), {
      timeoutMs: 5_000,
      label: 'Edit tag typed in prompt input',
    });

    tty.send('\x13');
    const reviewAfterEdit = await tty.waitFor(
      (s) => !s.includes('题目工具箱') && !s.includes('Card Tools') && s.includes('[R19EDIT]'),
      { timeoutMs: 10_000, label: 'ReviewView updated after card edit' },
    );
    tty.assertHealthyScreen(reviewAfterEdit, 120, 36, 'ReviewView after card edit');
    assert.ok(reviewAfterEdit.includes('[R19EDIT]'), 'ReviewView must show edited prompt tag');

    tty.send('D');
    const toolsAfterEdit = await tty.waitFor(
      (s) =>
        (s.includes('题目工具箱') || s.includes('Card Tools')) &&
        (s.includes('1 版') || s.includes('1 rev')),
      { timeoutMs: 8_000, label: 'CardToolsModal shows 1 rev badge on [7]' },
    );
    tty.assertHealthyScreen(toolsAfterEdit, 120, 36, 'CardToolsModal after edit with 1 rev');
    assert.ok(toolsAfterEdit.includes('1 版') || toolsAfterEdit.includes('1 rev'));

    tty.send('7');
    const reviewAfterRevert = await tty.waitFor(
      (s) =>
        !s.includes('题目工具箱') &&
        !s.includes('Card Tools') &&
        (s.includes('已撤销上次修改') || s.includes('Reverted last edit')),
      { timeoutMs: 10_000, label: 'CardToolsModal closed with revert confirmation toast' },
    );
    tty.assertHealthyScreen(reviewAfterRevert, 120, 36, 'ReviewView after card.revert');
    assert.ok(reviewAfterRevert.includes('已撤销上次修改') || reviewAfterRevert.includes('Reverted last edit'));

    const revertedCardRes = await host.call('card.get', { cardId: currentCardId });
    assert.equal(revertedCardRes.ok, true, 'card.get after revert must succeed');
    assert.equal(
      String(revertedCardRes.value?.card?.prompt || '').trim(),
      originalPrompt,
      'card.revert must restore exact original prompt',
    );
    assert.equal(
      revertedCardRes.value?.revisions?.length ?? 0,
      0,
      'card.revert must consume the revision entry',
    );

    tty.send('D');
    const toolsAfterRevert = await tty.waitFor(
      (s) =>
        (s.includes('题目工具箱') || s.includes('Card Tools')) &&
        (s.includes('无历史') || s.includes('None')) &&
        (s.includes('前置题目关联') || s.includes('Prerequisite Links')),
      { timeoutMs: 8_000, label: 'CardToolsModal reopened after revert showing 0 revisions' },
    );
    tty.assertHealthyScreen(toolsAfterRevert, 120, 36, 'CardToolsModal after revert');
    await tty.flush();

    tty.send('1');
    const editAfterRevert = await tty.waitFor(
      (s) => {
        const lines = s.split('\n');
        const startIdx = lines.findIndex((l) => l.includes('1. 题干 (prompt)') || l.includes('1. Stem (prompt)'));
        const endIdx = lines.findIndex(
          (l) =>
            l.includes('2. 参考答案 (answer)') ||
            l.includes('2. Reference Answer') ||
            l.includes('2. 解析 (explanation)') ||
            l.includes('2. Explanation'),
        );
        const stemSlice = startIdx >= 0 && endIdx > startIdx ? lines.slice(startIdx, endIdx).join('\n') : '';
        return stemSlice.includes(originalPromptSnippet) && !stemSlice.includes('[R19EDIT]');
      },
      { timeoutMs: 8_000, label: 'CardToolsModal edit form shows reverted original prompt' },
    );
    tty.assertHealthyScreen(editAfterRevert, 120, 36, 'CardToolsModal edit form after revert');

    tty.send('\x1b');
    await tty.waitFor((s) => s.includes('前置题目关联') || s.includes('Prerequisite Links'), {
      timeoutMs: 8_000,
      label: 'Returned to CardToolsModal menu from edit form',
    });

    tty.send('8');
    const prereqsEmpty = await tty.waitFor(
      (s) =>
        (s.includes('前置题目关联') || s.includes('Prerequisite Links')) &&
        !s.includes('正在加载前置题目') &&
        !s.includes('Loading prerequisites') &&
        (s.includes('当前题目暂无前置依赖') || s.includes('No prerequisites linked yet') || /已关联 \d+ 题|\d+ linked/.test(s)),
      { timeoutMs: 8_000, label: 'CardToolsModal Prerequisite Links view opened' },
    );
    tty.assertHealthyScreen(prereqsEmpty, 120, 36, 'CardToolsModal Prerequisite Links initial');

    tty.send('a');
    await tty.waitFor((s) => s.includes('输入关键词搜索前置题') || s.includes('Search cards to link'), {
      timeoutMs: 5_000,
      label: 'Prerequisite search input activated',
    });

    tty.send('Bridge');
    const searchHitsScreen = await tty.waitFor(
      (s) =>
        (/搜索结果 [1-9]\d* 题/.test(s) || /[1-9]\d* hits/.test(s)) &&
        !s.includes('正在搜索题库') &&
        !s.includes('Searching cards'),
      { timeoutMs: 8_000, label: 'Prerequisite search hits rendered for "Bridge"' },
    );
    tty.assertHealthyScreen(searchHitsScreen, 120, 36, 'CardToolsModal Prerequisite search hits');

    tty.send('\r');
    await tty.waitFor((s) => s.includes('▸ ') || s.includes('> '), {
      timeoutMs: 5_000,
      label: 'Prerequisite search hit focused',
    });

    tty.send('\r');
    const linkedScreen = await tty.waitFor(
      (s) =>
        !s.includes('输入关键词搜索前置题') &&
        !s.includes('Search cards to link') &&
        (s.includes('已关联 1 题') || s.includes('1 linked')) &&
        s.includes('1. '),
      { timeoutMs: 8_000, label: 'Linked prerequisite rendered in list' },
    );
    tty.assertHealthyScreen(linkedScreen, 120, 36, 'CardToolsModal Prerequisite linked');
    assert.ok(linkedScreen.includes('已关联 1 题') || linkedScreen.includes('1 linked'));

    tty.send('d');
    const unlinkedScreen = await tty.waitFor(
      (s) =>
        (s.includes('已关联 0 题') || s.includes('0 linked')) &&
        (s.includes('当前题目暂无前置依赖') || s.includes('No prerequisites linked yet')),
      { timeoutMs: 8_000, label: 'Prerequisite unlinked cleanly' },
    );
    tty.assertHealthyScreen(unlinkedScreen, 120, 36, 'CardToolsModal Prerequisite after unlink');
    assert.ok(unlinkedScreen.includes('已关联 0 题') || unlinkedScreen.includes('0 linked'));

    tty.send('\x1b');
    await tty.waitFor((s) => s.includes('编辑题目') || s.includes('Edit Question'), {
      timeoutMs: 8_000,
      label: 'Esc returned from Prerequisite Links to menu',
    });

    tty.send('\x1b');
    const backToReview = await tty.waitFor(
      (s) =>
        !s.includes('题目工具箱') &&
        !s.includes('Card Tools') &&
        (s.includes('[D]工具') || s.includes('[D]Tools')),
      { timeoutMs: 8_000, label: 'CardToolsModal closed cleanly via Esc' },
    );
    tty.assertHealthyScreen(backToReview, 120, 36, 'ReviewView after CardToolsModal closed');
    assert.ok(!backToReview.includes('题目工具箱') && !backToReview.includes('Card Tools'));
  });
});

describe('Round 20: RoundSummary Look-Back & CommandPalette Slash Sweep', () => {
  let ctx;

  before(async () => {
    ctx = await mountSuiteApp('r20');
  });

  after(async () => {
    await ctx?.dispose();
  });

  test('1) RoundSummary interactive review.lookBack browser, j/k & Enter preview, 120x36 & 80x24, --ascii purity, and [w] weak-retry', async () => {
    const { host, tty } = ctx;
    const snapRes = await host.call('snapshot', {});
    assert.equal(snapRes.ok, true, 'snapshot must succeed');
    const sampleDeck = (snapRes.value?.decks || []).find((d) => d.id === 'sample-deck-patterns') || snapRes.value?.decks?.[0];
    assert.ok(sampleDeck?.id, 'Sample deck must exist');

    const deckDetailRes = await host.call('deck.get', { id: sampleDeck.id });
    assert.equal(deckDetailRes.ok, true, 'deck.get must succeed');
    const flashcards = (deckDetailRes.value?.cards || []).filter((c) => c.kind === 'flashcard');
    assert.ok(flashcards.length >= 2, 'Sample deck must have at least 2 flashcards');
    const card1 = flashcards[0];
    const card2 = flashcards[1];

    const startRes = await host.call('review.start', {
      mode: 'path',
      scope: [
        { deckId: sampleDeck.id, cardId: card1.id },
        { deckId: sampleDeck.id, cardId: card2.id },
      ],
      fresh: true,
    });
    assert.equal(startRes.ok, true, 'review.start 2-card run must succeed');
    const runId = startRes.value?.id;
    assert.ok(runId, 'review.start must return a runId');

    useTuiStore.getState().navigate('review', { runId });

    const c1PromptSnippet = String(card1.prompt || '').slice(0, 14);
    await tty.waitFor(
      (s) =>
        s.includes(c1PromptSnippet) &&
        (s.includes('按 [Space] 或 [Enter] 翻开答案') || s.includes('Press [Space] or [Enter] to flip card')),
      { timeoutMs: 10_000, label: 'Card 1 rendered in ReviewView' },
    );

    tty.send(' ');
    await tty.waitFor((s) => s.includes('答案与解析') && s.includes('重来'), {
      timeoutMs: 8_000,
      label: 'Card 1 revealed with FSRS rating bar',
    });

    tty.send('1');
    await tty.waitFor((s) => s.includes('下一题') && !s.includes('按 [Space] 或 [Enter] 翻开答案'), {
      timeoutMs: 8_000,
      label: 'Card 1 rated Again (1)',
    });

    tty.send('\r');
    const c2PromptSnippet = String(card2.prompt || '').slice(0, 14);
    await tty.waitFor(
      (s) =>
        s.includes(c2PromptSnippet) &&
        (s.includes('按 [Space] 或 [Enter] 翻开答案') || s.includes('Press [Space] or [Enter] to flip card')),
      { timeoutMs: 20_000, label: 'Card 2 rendered in ReviewView' },
    );

    tty.send(' ');
    await tty.waitFor((s) => s.includes('答案与解析') && s.includes('简单'), {
      timeoutMs: 20_000,
      label: 'Card 2 revealed with FSRS rating bar',
    });

    tty.send('5');
    await tty.waitFor(
      (s) =>
        s.includes(c1PromptSnippet) &&
        (s.includes('再练') || s.includes('Retry')) &&
        (s.includes('按 [Space] 或 [Enter] 翻开答案') || s.includes('Press [Space] or [Enter] to flip card')),
      { timeoutMs: 20_000, label: 'Card 1 tail retry rendered' },
    );

    tty.send(' ');
    await tty.waitFor((s) => s.includes('答案与解析') && s.includes('良好'), {
      timeoutMs: 20_000,
      label: 'Tail retry revealed',
    });
    tty.send('3');

    const summaryInit = await tty.waitFor(
      (s) =>
        (s.includes('本轮练习总结') || s.includes('Round Summary')) &&
        (s.includes('本轮题目回顾') || s.includes('Round Look-Back')) &&
        !s.includes('加载本轮回顾') &&
        !s.includes('Loading look-back') &&
        s.includes('#1') &&
        s.includes('#2') &&
        (s.includes('[重来]') || s.includes('[Again]')),
      { timeoutMs: 20_000, label: 'RoundSummary lookBack rendered at 120x36' },
    );
    tty.assertHealthyScreen(summaryInit, 120, 36, 'RoundSummary initial at 120x36');
    assert.ok(
      summaryInit.includes('需巩固') || summaryInit.includes('Missed'),
      'Initial selection on first weak card #1 must display Missed/需巩固 badge',
    );

    await tty.flush(30);
    tty.send('j');
    const summaryRow2 = await tty.waitFor(
      (s) =>
        /[▸>].*#2/.test(s) &&
        (s.includes('答对') || s.includes('Correct')) &&
        (s.includes('简单') || s.includes('Easy')) &&
        s.includes(c2PromptSnippet.slice(0, 10)),
      { timeoutMs: 6_000, label: 'RoundSummary navigated to #2 via j' },
    );
    tty.assertHealthyScreen(summaryRow2, 120, 36, 'RoundSummary row #2 at 120x36');
    assert.ok(summaryRow2.includes('答对') || summaryRow2.includes('Correct'));

    await tty.flush(30);
    tty.send('k');
    const summaryRow1 = await tty.waitFor(
      (s) =>
        /[▸>].*#1/.test(s) &&
        (s.includes('需巩固') || s.includes('Missed')) &&
        (s.includes('重来') || s.includes('Again')) &&
        s.includes(c1PromptSnippet.slice(0, 10)),
      { timeoutMs: 6_000, label: 'RoundSummary navigated back to #1 via k' },
    );
    tty.assertHealthyScreen(summaryRow1, 120, 36, 'RoundSummary back to row #1 at 120x36');
    assert.ok(summaryRow1.includes('需巩固') || summaryRow1.includes('Missed'));

    await tty.flush(30);
    tty.send('\r');
    const summaryExpanded = await tty.waitFor(
      (s) =>
        (s.includes('参考答案') || s.includes('Reference Answer')) &&
        (s.includes('解析') || s.includes('Explanation')) &&
        (s.includes('收起参考答案与解析') || s.includes('Hide Answer & Explanation')),
      { timeoutMs: 6_000, label: 'RoundSummary Enter toggled preview ON at 120x36' },
    );
    tty.assertHealthyScreen(summaryExpanded, 120, 36, 'RoundSummary preview expanded at 120x36');
    assert.ok(summaryExpanded.includes('参考答案') || summaryExpanded.includes('Reference Answer'));

    tty.send('\r');
    const summaryCollapsed = await tty.waitFor(
      (s) =>
        !s.includes('参考答案:') &&
        (s.includes('展开参考答案与解析') || s.includes('Show Reference Answer & Explanation')),
      { timeoutMs: 6_000, label: 'RoundSummary Enter toggled preview OFF at 120x36' },
    );
    tty.assertHealthyScreen(summaryCollapsed, 120, 36, 'RoundSummary preview collapsed at 120x36');
    assert.ok(!summaryCollapsed.includes('参考答案:'));

    tty.resize(80, 24);
    const summaryNarrowList = await tty.waitFor(
      (s) =>
        (s.includes('本轮练习总结') || s.includes('Round Summary')) &&
        (s.includes('本轮题目回顾') || s.includes('Round Look-Back')) &&
        s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'RoundSummary at 80x24 list pane' },
    );
    tty.assertHealthyScreen(summaryNarrowList, 80, 24, 'RoundSummary list at 80x24');
    assert.ok(summaryNarrowList.split('\n').length <= 24);

    tty.send('\r');
    const summaryNarrowDetail = await tty.waitFor(
      (s) =>
        (s.includes('参考答案') || s.includes('Reference Answer')) &&
        (s.includes('收起返回列表') || s.includes('Collapse')) &&
        s.split('\n').length <= 24,
      { timeoutMs: 6_000, label: 'RoundSummary at 80x24 expanded detail pane' },
    );
    tty.assertHealthyScreen(summaryNarrowDetail, 80, 24, 'RoundSummary detail at 80x24');
    assert.ok(summaryNarrowDetail.includes('参考答案') || summaryNarrowDetail.includes('Reference Answer'));

    tty.send('\x1b');
    await tty.waitFor(
      (s) => (s.includes('本轮题目回顾') || s.includes('Round Look-Back')) && !s.includes('收起返回列表'),
      { timeoutMs: 6_000, label: 'RoundSummary collapsed from narrow detail via Esc' },
    );

    tty.resize(120, 36);
    await tty.waitFor(
      (s) => (s.includes('本轮练习总结') || s.includes('Round Summary')) && s.includes('[w]'),
      { timeoutMs: 8_000, label: 'RoundSummary restored to 120x36' },
    );

    useTuiStore.getState().setPreferences({ asciiMode: true });
    try {
      const summaryAscii = await tty.waitFor(
        (s) => s.includes('* 本轮练习总结') && s.includes('>x #1') && s.includes(' + #2'),
        { timeoutMs: 6_000, label: 'RoundSummary rendered in --ascii mode' },
      );
      tty.assertHealthyScreen(summaryAscii, 120, 36, 'RoundSummary --ascii at 120x36');
      tty.assertAsciiPure(summaryAscii, 'RoundSummary --ascii at 120x36');
    } finally {
      useTuiStore.getState().setPreferences({ asciiMode: false });
    }
    await tty.waitFor((s) => s.includes('★ 本轮练习总结') && s.includes('#1'), {
      timeoutMs: 6_000,
      label: 'RoundSummary restored to Unicode mode',
    });

    tty.send('w');
    const weakRetryScreen = await tty.waitFor(
      (s) =>
        !s.includes('本轮练习总结') &&
        !s.includes('Round Summary') &&
        s.includes('1/1') &&
        s.includes(c1PromptSnippet) &&
        (s.includes('[D]工具') || s.includes('[D]Tools')),
      { timeoutMs: 10_000, label: 'Weak retry round opened in ReviewView with missed card' },
    );
    tty.assertHealthyScreen(weakRetryScreen, 120, 36, 'ReviewView after [w] weak retry');
    assert.ok(weakRetryScreen.includes('1/1'), 'Weak retry round must contain exactly 1 missed card');
  });

  test('2) CommandPalette full slash-command sweep (/theme nord, /lang, /inbox, /help, /course, /sidebar)', async () => {
    const { tty } = ctx;
    useTuiStore.getState().navigate('library');
    const libScreen = await tty.waitFor(
      (s) => s.includes('示例 · Memento 与 Bridge') && (s.includes('题组列表') || s.includes('Decks')),
      { timeoutMs: 8_000, label: 'LibraryView ready for CommandPalette sweep' },
    );
    tty.assertHealthyScreen(libScreen, 120, 36, 'LibraryView before CommandPalette sweep');

    const openPaletteAndSelect = async (cmdText, matchPredicate, label) => {
      tty.send('\x0b');
      await tty.waitFor((s) => s.includes('命令面板') || s.includes('Command Palette'), {
        timeoutMs: 20_000,
        label: `CommandPalette opened for ${label}`,
      });
      await tty.flush(20);
      tty.send(cmdText);
      const filtered = await tty.waitFor(matchPredicate, {
        timeoutMs: 15_000,
        label: `CommandPalette filtered for ${label}`,
      });
      tty.assertHealthyScreen(filtered, 120, 36, `CommandPalette (${cmdText})`);
      await tty.flush(25);
      tty.send('\r');
    };

    await openPaletteAndSelect('/theme nord', (s) => s.includes('/theme nord') && s.includes('Nord'), '/theme nord');
    await tty.waitFor(
      (s) =>
        !s.includes('命令面板') &&
        !s.includes('Command Palette') &&
        useTuiStore.getState().preferences.theme === 'nord',
      { timeoutMs: 6_000, label: 'Theme switched to nord' },
    );
    assert.equal(useTuiStore.getState().preferences.theme, 'nord', 'Theme must switch to nord');
    await tty.flush();
    tty.assertHealthyScreen(tty.readScreen(), 120, 36, 'After /theme nord');

    assert.equal(useTuiStore.getState().preferences.language, 'zh', 'Initial language must be zh');
    await openPaletteAndSelect('/lang', (s) => s.includes('/lang') && s.includes('Switch to English'), '/lang zh -> en');
    const enScreen = await tty.waitFor(
      (s) =>
        !s.includes('命令面板') &&
        useTuiStore.getState().preferences.language === 'en' &&
        s.includes('Library') &&
        s.includes('Decks'),
      { timeoutMs: 6_000, label: 'Language toggled to en' },
    );
    assert.equal(useTuiStore.getState().preferences.language, 'en', 'Language must be en');
    tty.assertHealthyScreen(enScreen, 120, 36, 'After /lang -> en');

    await openPaletteAndSelect('/lang', (s) => s.includes('/lang') && s.includes('切换到中文'), '/lang en -> zh');
    const zhScreen = await tty.waitFor(
      (s) =>
        !s.includes('Command Palette') &&
        useTuiStore.getState().preferences.language === 'zh' &&
        s.includes('学习库') &&
        s.includes('题组列表'),
      { timeoutMs: 6_000, label: 'Language toggled back to zh' },
    );
    assert.equal(useTuiStore.getState().preferences.language, 'zh', 'Language must be back to zh');
    tty.assertHealthyScreen(zhScreen, 120, 36, 'After /lang -> zh');

    await openPaletteAndSelect(
      '/inbox',
      (s) => s.includes('/inbox') && (s.includes('收件箱与通知') || s.includes('Notification Inbox')),
      '/inbox',
    );
    const inboxScreen = await tty.waitFor(
      (s) =>
        !s.includes('命令面板') &&
        (s.includes('收件箱与通知') || s.includes('Notification Inbox')) &&
        (s.includes('全部') || s.includes('All')),
      { timeoutMs: 20_000, label: 'InboxModal opened via /inbox' },
    );
    tty.assertHealthyScreen(inboxScreen, 120, 36, 'InboxModal via /inbox');
    assert.ok(inboxScreen.includes('收件箱与通知') || inboxScreen.includes('Notification Inbox'));
    tty.send('\x1b');
    const afterInbox = await tty.waitFor(
      (s) => !s.includes('收件箱与通知') && !s.includes('Notification Inbox'),
      { timeoutMs: 15_000, label: 'InboxModal closed via Esc' },
    );
    tty.assertHealthyScreen(afterInbox, 120, 36, 'After InboxModal closed');
    assert.ok(!afterInbox.includes('收件箱与通知'));

    await openPaletteAndSelect(
      '/help',
      (s) => s.includes('/help') && (s.includes('快捷键帮助') || s.includes('Keyboard help')),
      '/help',
    );
    const helpScreen = await tty.waitFor(
      (s) =>
        !s.includes('搜索页面') &&
        (s.includes('? 快捷键') || s.includes('? Keyboard Shortcuts')) &&
        (s.includes('全局') || s.includes('Global')),
      { timeoutMs: 20_000, label: 'HelpOverlay opened via /help' },
    );
    tty.assertHealthyScreen(helpScreen, 120, 36, 'HelpOverlay via /help');
    assert.ok(helpScreen.includes('? 快捷键') || helpScreen.includes('? Keyboard Shortcuts'));
    tty.send('\x1b');
    const afterHelp = await tty.waitFor(
      (s) => !s.includes('? 快捷键') && !s.includes('? Keyboard Shortcuts'),
      { timeoutMs: 15_000, label: 'HelpOverlay closed via Esc' },
    );
    tty.assertHealthyScreen(afterHelp, 120, 36, 'After HelpOverlay closed');
    assert.ok(!afterHelp.includes('? 快捷键'));

    await openPaletteAndSelect(
      '/course',
      (s) => s.includes('/course') && (s.includes('切换课程焦点') || s.includes('Switch course')),
      '/course',
    );
    const courseScreen = await tty.waitFor(
      (s) =>
        !s.includes('切换课程焦点') &&
        (s.includes('◎ 切换课程') || s.includes('◎ Switch Course')) &&
        (s.includes('全部课程') || s.includes('All courses')),
      { timeoutMs: 20_000, label: 'CoursePickerModal opened via /course' },
    );
    tty.assertHealthyScreen(courseScreen, 120, 36, 'CoursePickerModal via /course');
    assert.ok(courseScreen.includes('◎ 切换课程') || courseScreen.includes('◎ Switch Course'));
    tty.send('\x1b');
    const afterCourse = await tty.waitFor(
      (s) => !s.includes('◎ 切换课程') && !s.includes('◎ Switch Course'),
      { timeoutMs: 6_000, label: 'CoursePickerModal closed via Esc' },
    );
    tty.assertHealthyScreen(afterCourse, 120, 36, 'After CoursePickerModal closed');
    assert.ok(!afterCourse.includes('◎ 切换课程'));

    assert.equal(useTuiStore.getState().preferences.sidebarCollapsed, false, 'Sidebar starts expanded');
    await openPaletteAndSelect(
      '/sidebar',
      (s) => s.includes('/sidebar') && (s.includes('折叠/展开侧栏') || s.includes('Toggle sidebar')),
      '/sidebar collapse',
    );
    const collapsedScreen = await tty.waitFor(
      (s) =>
        !s.includes('命令面板') &&
        useTuiStore.getState().preferences.sidebarCollapsed === true &&
        !s.includes('每日 Daily'),
      { timeoutMs: 6_000, label: 'Sidebar collapsed via /sidebar' },
    );
    assert.equal(useTuiStore.getState().preferences.sidebarCollapsed, true, 'Sidebar must be collapsed');
    tty.assertHealthyScreen(collapsedScreen, 120, 36, 'Sidebar collapsed via /sidebar');

    await openPaletteAndSelect(
      '/sidebar',
      (s) => s.includes('/sidebar') && (s.includes('折叠/展开侧栏') || s.includes('Toggle sidebar')),
      '/sidebar expand',
    );
    const expandedScreen = await tty.waitFor(
      (s) =>
        !s.includes('命令面板') &&
        useTuiStore.getState().preferences.sidebarCollapsed === false &&
        s.includes('每日 Daily'),
      { timeoutMs: 6_000, label: 'Sidebar expanded back via /sidebar' },
    );
    assert.equal(useTuiStore.getState().preferences.sidebarCollapsed, false, 'Sidebar must be expanded again');
    tty.assertHealthyScreen(expandedScreen, 120, 36, 'Sidebar expanded via /sidebar');
  });
});

describe('Round 21: Case Exam Runner/Report, Skeleton Lint & Notes Linked-Card Jump', () => {
  let ctx;

  before(async () => {
    ctx = await mountSuiteApp('r21');
  });

  after(async () => {
    await ctx?.dispose();
  });

  test('1) Case Exam (5) side-by-side scenario at 120x36, [H] highlight, narrow [s] toggle at 80x24, Ctrl+S submit & Case ExamReportView', async () => {
    const { tty } = ctx;
    tty.send('5');
    const setupScreen = await tty.waitFor((s) => s.includes('组卷设置') && s.includes('2:案例卷'), {
      timeoutMs: 20_000,
      label: 'ExamSetup rendered',
    });
    tty.assertHealthyScreen(setupScreen, 120, 36, 'ExamSetup at 120x36');
    assert.equal(useTuiStore.getState().page, 'exam', 'Key 5 must open ExamView');

    tty.send('2');
    await tty.waitFor((s) => s.includes('示例案例 · 墨笺笔记') && s.includes('案例卷按题组全卷作答'), {
      timeoutMs: 6_000,
      label: 'Case Exam mode selected in ExamSetup',
    });
    tty.send('\r');

    await tty.waitFor((s) => s.includes('案例卷 · 1/2') && (s.includes('第 1 题') || s.includes('Memento')), {
      timeoutMs: 10_000,
      label: 'Case ExamRunner opened',
    });

    tty.send('\\');
    const sideBySide = await tty.waitFor(
      (s) =>
        s.includes('[P1]') &&
        s.includes('墨笺是一家为学生做笔记应用的小公司') &&
        s.includes('案例卷 · 1/2') &&
        s.includes('第 1 题'),
      { timeoutMs: 8_000, label: 'Case side-by-side scenario rendered at 120x36' },
    );
    tty.assertHealthyScreen(sideBySide, 120, 36, 'Case side-by-side scenario at 120x36');
    assert.ok(sideBySide.includes('[P1]'), 'Side-by-side scenario must show [P1]');

    tty.send('H');
    const highlighted = await tty.waitFor((s) => s.includes('[P1 ★]') && s.includes('1★'), {
      timeoutMs: 8_000,
      label: 'Paragraph 1 highlighted via [H]',
    });
    tty.assertHealthyScreen(highlighted, 120, 36, 'Case Exam after [H] highlight at 120x36');
    assert.ok(highlighted.includes('[P1 ★]'), 'Paragraph 1 must show highlight star');

    tty.resize(80, 24);
    const narrowQuestion = await tty.waitFor(
      (s) =>
        s.includes('案例卷 · 1/2') &&
        !s.includes('墨笺是一家为学生做笔记应用的小公司') &&
        s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'Case question pane at 80x24' },
    );
    tty.assertHealthyScreen(narrowQuestion, 80, 24, 'Case Exam narrow question at 80x24');
    assert.ok(narrowQuestion.split('\n').length <= 24);

    tty.send('s');
    const narrowOverlay = await tty.waitFor(
      (s) => s.includes('[P1 ★]') && s.includes('墨笺是一家为学生做笔记应用的小公司') && s.includes('s 返回'),
      { timeoutMs: 6_000, label: 'Narrow scenario overlay opened via [s]' },
    );
    tty.assertHealthyScreen(narrowOverlay, 80, 24, 'Case Exam narrow [s] overlay at 80x24');
    assert.ok(narrowOverlay.includes('墨笺是一家为学生做笔记应用的小公司'));

    tty.send('s');
    const narrowBack = await tty.waitFor(
      (s) => s.includes('案例卷 · 1/2') && !s.includes('墨笺是一家为学生做笔记应用的小公司'),
      { timeoutMs: 6_000, label: 'Narrow scenario overlay closed via [s]' },
    );
    tty.assertHealthyScreen(narrowBack, 80, 24, 'Case Exam back from [s] overlay at 80x24');
    assert.ok(!narrowBack.includes('墨笺是一家为学生做笔记应用的小公司'));

    tty.send('\x13');
    await tty.waitFor((s) => s.includes('确认交卷') || s.includes('Submit Exam'), {
      timeoutMs: 6_000,
      label: 'Submit confirmation dialog',
    });
    tty.send('y');

    const narrowReport = await tty.waitFor(
      (s) =>
        (s.includes('案例评估报告') || s.includes('Case Exam Report')) &&
        s.includes('0/10') &&
        s.includes('Q1') &&
        s.includes('Q2'),
      { timeoutMs: 10_000, label: 'Case ExamReportView rendered at 80x24' },
    );
    tty.assertHealthyScreen(narrowReport, 80, 24, 'Case ExamReportView at 80x24');
    assert.ok(narrowReport.includes('0/10'), 'Empty submitted case exam scores 0/10');

    tty.resize(120, 36);
    tty.send('\\');
    const wideReport = await tty.waitFor(
      (s) =>
        (s.includes('案例评估报告') || s.includes('Case Exam Report')) &&
        s.includes('Q1 (0/6') &&
        s.includes('各题评分 (2)'),
      { timeoutMs: 8_000, label: 'Case ExamReportView restored to 120x36' },
    );
    tty.assertHealthyScreen(wideReport, 120, 36, 'Case ExamReportView at 120x36');
    assert.ok(wideReport.includes('Q1 (0/6'), 'Case report must show Q1 breakdown');

    tty.send('b');
    await tty.waitFor((s) => s.includes('组卷设置') && s.includes('历史考卷'), {
      timeoutMs: 6_000,
      label: 'Returned to ExamSetup via [b]',
    });
    tty.send('l');
    await tty.flush(20);
    tty.send('j');
    await tty.flush(20);
    tty.send('\r');
    const gradedReport = await tty.waitFor(
      (s) =>
        (s.includes('案例评估报告') || s.includes('Case Exam Report')) &&
        s.includes('薄弱评分维度') &&
        s.includes('评分维度明细') &&
        s.includes('运用 Memento 给出建议'),
      { timeoutMs: 8_000, label: 'Graded sample Case ExamReportView with criteria breakdown' },
    );
    tty.assertHealthyScreen(gradedReport, 120, 36, 'Graded sample Case ExamReportView at 120x36');
    assert.ok(gradedReport.includes('薄弱评分维度') && gradedReport.includes('评分维度明细'));

    tty.send('b');
    const backSetup = await tty.waitFor((s) => s.includes('组卷设置') && !s.includes('案例评估报告'), {
      timeoutMs: 6_000,
      label: 'Exited Case ExamReportView cleanly',
    });
    tty.assertHealthyScreen(backSetup, 120, 36, 'ExamSetup after Case report exit');
    assert.ok(backSetup.includes('组卷设置'));
  });

  test('2) SkeletonView [L] Skeleton Structural Lint (8 -> L) at 120x36, 80x24, --ascii purity & Esc close', async () => {
    const { tty } = ctx;
    tty.send('8');
    const skelScreen = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'skeleton' &&
        (s.includes('知识层级树') || s.includes('Knowledge Tree')) &&
        (s.includes('释义:') || s.includes('Description:') || s.includes('节点检视器') || s.includes('Node Inspector')) &&
        !s.includes('正在加载知识骨架'),
      { timeoutMs: 10_000, label: 'SkeletonView rendered at 120x36' },
    );
    tty.assertHealthyScreen(skelScreen, 120, 36, 'SkeletonView at 120x36');
    assert.equal(useTuiStore.getState().page, 'skeleton', 'Key 8 must open SkeletonView');

    tty.send('L');
    const lintWide = await tty.waitFor(
      (s) =>
        (s.includes('骨架结构自检') || s.includes('Skeleton Lint')) &&
        !s.includes('正在检查骨架与题目结构') &&
        (s.includes('骨架结构健康') || s.includes('结构提示') || s.includes('structural finding')),
      { timeoutMs: 8_000, label: 'Skeleton Lint modal rendered at 120x36' },
    );
    tty.assertHealthyScreen(lintWide, 120, 36, 'Skeleton Lint modal at 120x36');
    assert.ok(lintWide.includes('骨架结构自检') || lintWide.includes('Skeleton Lint'));

    tty.resize(80, 24);
    const lintNarrow = await tty.waitFor(
      (s) => (s.includes('骨架结构自检') || s.includes('Skeleton Lint')) && s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'Skeleton Lint modal at 80x24' },
    );
    tty.assertHealthyScreen(lintNarrow, 80, 24, 'Skeleton Lint modal at 80x24');
    assert.ok(lintNarrow.split('\n').length <= 24);

    tty.resize(120, 36);
    await tty.waitFor(
      (s) => (s.includes('骨架结构自检') || s.includes('Skeleton Lint')) && s.includes('知识层级树'),
      { timeoutMs: 8_000, label: 'Skeleton Lint modal restored to 120x36' },
    );

    useTuiStore.getState().setPreferences({ asciiMode: true });
    try {
      const lintAscii = await tty.waitFor(
        (s) => s.includes('! 骨架结构自检') && s.includes('esc x'),
        { timeoutMs: 6_000, label: 'Skeleton Lint modal rendered in --ascii mode' },
      );
      tty.assertHealthyScreen(lintAscii, 120, 36, 'Skeleton Lint modal --ascii at 120x36');
      tty.assertAsciiPure(lintAscii, 'Skeleton Lint modal --ascii at 120x36');
      assert.ok(lintAscii.includes('! 骨架结构自检'));
    } finally {
      useTuiStore.getState().setPreferences({ asciiMode: false });
    }
    await tty.waitFor((s) => s.includes('⚑ 骨架结构自检'), {
      timeoutMs: 6_000,
      label: 'Skeleton Lint modal restored to Unicode mode',
    });

    tty.send('\x1b');
    const afterLint = await tty.waitFor(
      (s) =>
        !s.includes('骨架结构自检') &&
        !s.includes('Skeleton Lint') &&
        (s.includes('知识层级树') || s.includes('Knowledge Tree')),
      { timeoutMs: 6_000, label: 'Skeleton Lint modal closed via Esc' },
    );
    tty.assertHealthyScreen(afterLint, 120, 36, 'SkeletonView after Esc closed lint modal');
    assert.ok(!afterLint.includes('骨架结构自检') && !afterLint.includes('Skeleton Lint'));
  });

  test('3) NotesView [o] linked-card direct jump (n -> create card-linked note -> o -> ReviewView)', async () => {
    const { tty } = ctx;
    tty.send('n');
    const notesInit = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'notes' &&
        (s.includes('Unicode Math') || s.includes('Raw LaTeX') || s.includes('选择一篇笔记阅读') || s.includes('Select a note to read')) &&
        (s.includes('a  新建') || s.includes('a  New')) &&
        !s.includes('载入笔记中'),
      { timeoutMs: 8_000, label: 'NotesView rendered' },
    );
    tty.assertHealthyScreen(notesInit, 120, 36, 'NotesView at 120x36');
    await tty.flush();

    tty.send('a');
    const editorOpen = await tty.waitFor(
      (s) =>
        (s.includes('新建学习笔记') || s.includes('New Study Note')) &&
        (s.includes('已选 1/30') || s.includes('1/30')) &&
        !s.includes('搜索中'),
      { timeoutMs: 8_000, label: 'NoteEditorModal opened with preselected linked card' },
    );
    tty.assertHealthyScreen(editorOpen, 120, 36, 'NoteEditorModal open at 120x36');
    assert.ok(editorOpen.includes('已选 1/30') || editorOpen.includes('1/30'));

    const noteTitle = 'R21 Linked Card Note';
    tty.send(noteTitle);
    await tty.waitFor((s) => s.includes(noteTitle), {
      timeoutMs: 6_000,
      label: 'Note title typed into NoteEditorModal',
    });
    tty.send('\x13');

    const notesSaved = await tty.waitFor(
      (s) =>
        !s.includes('新建学习笔记') &&
        s.includes(noteTitle) &&
        (s.includes('[o] 关联题卡:') || s.includes('[o] Card:')),
      { timeoutMs: 8_000, label: 'Saved linked note displayed with [o] Card reference' },
    );
    tty.assertHealthyScreen(notesSaved, 120, 36, 'NotesView after saving card-linked note');
    assert.ok(notesSaved.includes('[o] 关联题卡:') || notesSaved.includes('[o] Card:'));

    tty.send('o');
    const reviewScreen = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'review' &&
        s.includes('1/1') &&
        (s.includes('按 [Space] 或 [Enter] 翻开答案') ||
          s.includes('Press [Space] or [Enter] to flip card') ||
          s.includes('[1/a]') ||
          s.includes('选择提交')) &&
        (s.includes('[D]工具') || s.includes('[D]Tools')),
      { timeoutMs: 10_000, label: 'ReviewView opened directly via [o] from linked note' },
    );
    assert.equal(useTuiStore.getState().page, 'review', 'Store page must switch to review');
    tty.assertHealthyScreen(reviewScreen, 120, 36, 'ReviewView after [o] jump from NotesView');
    assert.ok(reviewScreen.includes('1/1'), 'Linked card jump must start 1/1 review');
    assert.ok(reviewScreen.includes('[D]工具') || reviewScreen.includes('[D]Tools'));
  });
});

describe('Round 22: SourcesView MinerUModal & ReviewView QueueModal', () => {
  let ctx;

  before(async () => {
    ctx = await mountSuiteApp('r22');
  });

  after(async () => {
    await ctx?.dispose();
  });

  test('1) SourcesView MinerUModal (2 -> M): Tab 1 Plan & Convert at 120x36 & 80x24, missing PDF inline error, Ctrl+T Tab 2 History, Esc close', async () => {
    const { boxDir, tty } = ctx;
    tty.send('2');
    const sourcesScreen = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'sources' &&
        (s.includes('学习资料库') || s.includes('Study Materials')) &&
        (s.includes('示例 · 设计模式讲义') || s.includes('示例案例 · 墨笺笔记')) &&
        !s.includes('正在加载页面'),
      { timeoutMs: 10_000, label: 'SourcesView rendered' },
    );
    tty.assertHealthyScreen(sourcesScreen, 120, 36, 'SourcesView at 120x36');
    assert.equal(useTuiStore.getState().page, 'sources', 'Key 2 must open SourcesView');

    tty.send('M');
    const mineruWide = await tty.waitFor(
      (s) =>
        (s.includes('MinerU 扫描/长 PDF 转换') || s.includes('MinerU Scanned / Long PDF')) &&
        (s.includes('[1] 转换长/扫描 PDF') || s.includes('[1] Plan & Convert')) &&
        (s.includes('[2] 转换历史') || s.includes('[2] History')) &&
        (s.includes('PDF 路径') || s.includes('PDF Path')) &&
        !s.includes('正在加载页面'),
      { timeoutMs: 10_000, label: 'MinerUModal Tab 1 opened at 120x36' },
    );
    tty.assertHealthyScreen(mineruWide, 120, 36, 'MinerUModal Tab 1 at 120x36');
    assert.ok(mineruWide.includes('MinerU'));

    tty.resize(80, 24);
    const mineruNarrow = await tty.waitFor(
      (s) =>
        (s.includes('MinerU 扫描/长 PDF 转换') || s.includes('MinerU Scanned / Long PDF')) &&
        (s.includes('PDF 路径') || s.includes('PDF Path')) &&
        s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'MinerUModal Tab 1 at 80x24' },
    );
    tty.assertHealthyScreen(mineruNarrow, 80, 24, 'MinerUModal Tab 1 at 80x24');
    assert.ok(mineruNarrow.split('\n').length <= 24);

    tty.resize(120, 36);
    await tty.waitFor(
      (s) =>
        (s.includes('MinerU 扫描/长 PDF 转换') || s.includes('MinerU Scanned / Long PDF')) &&
        (s.includes('学习资料库') || s.includes('Study Materials')),
      { timeoutMs: 8_000, label: 'MinerUModal restored to 120x36' },
    );

    const missingPdf = join(boxDir, 'does-not-exist-round22.pdf');
    tty.send(missingPdf);
    await tty.waitFor((s) => s.includes('does-not-exist-round22.pdf'), {
      timeoutMs: 8_000,
      label: 'Missing PDF path typed into MinerUModal',
    });
    tty.send('\r');

    try {
      const errorScreen = await tty.waitFor(
        (s) =>
          (s.includes('MinerU 扫描/长 PDF 转换') || s.includes('MinerU Scanned / Long PDF')) &&
          !s.includes('正在本地读取页数与分段计划') &&
          !s.includes('Reading PDF pages') &&
          (s.includes('提示：请检查路径是否存在') ||
            s.includes('Verify the file exists') ||
            s.includes('安装或修复本机 MinerU') ||
            s.includes('PDF 解析计划生成失败') ||
            s.includes('Failed to plan PDF') ||
            s.includes('ENOENT') ||
            s.includes('不存在') ||
            s.includes('not found')),
        { timeoutMs: 15_000, label: 'MinerUModal inline error rendered for missing PDF' },
      );
      tty.assertHealthyScreen(errorScreen, 120, 36, 'MinerUModal missing PDF inline error at 120x36');
      assert.ok(
        errorScreen.includes('✕ ') || errorScreen.includes('[X]') || errorScreen.includes('x '),
        'Missing PDF must show inline error marker',
      );
      await tty.flush(80);

      tty.send('\x14');
      const historyWide = await tty.waitFor(
        (s) =>
          (s.includes('[r] 重试') || s.includes('[r] Retry')) &&
          !s.includes('正在加载 MinerU 转换历史') &&
          (s.includes('暂无 MinerU 转换记录') || s.includes('No MinerU conversions yet') || /记录 \d+|Records \d+/.test(s)),
        { timeoutMs: 12_000, label: 'MinerUModal Tab 2 History rendered at 120x36' },
      );
      tty.assertHealthyScreen(historyWide, 120, 36, 'MinerUModal Tab 2 History at 120x36');
      assert.ok(historyWide.includes('[r] 重试') || historyWide.includes('[r] Retry'));
    } finally {
      tty.send('\x1b');
    }
    const afterClose = await tty.waitFor(
      (s) =>
        !s.includes('MinerU 扫描/长 PDF 转换') &&
        !s.includes('MinerU Scanned / Long PDF') &&
        (s.includes('学习资料库') || s.includes('Study Materials')),
      { timeoutMs: 10_000, label: 'MinerUModal closed via Esc' },
    );
    tty.assertHealthyScreen(afterClose, 120, 36, 'SourcesView after Esc closed MinerUModal');
    assert.ok(!afterClose.includes('MinerU 扫描/长 PDF 转换'));
  });

  test('2) ReviewView QueueModal ([Q] Live review.queue.edit): remove upcoming card [d], search & insert [a], 120x36 & 80x24, Esc close', async () => {
    const { tty } = ctx;
    tty.send('1');
    await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'library' &&
        s.includes('示例 · Memento 与 Bridge') &&
        !s.includes('正在加载页面'),
      { timeoutMs: 8_000, label: 'LibraryView active before starting review' },
    );
    await tty.flush();

    tty.send('\r');
    const reviewScreen = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'review' &&
        !s.includes('正在加载页面') &&
        !s.includes('正在启动') &&
        (s.includes('[Q]队列') || s.includes('[Q]Queue') || s.includes('[D]工具') || s.includes('[D]Tools')),
      { timeoutMs: 10_000, label: 'ReviewView started for first sample deck' },
    );
    tty.assertHealthyScreen(reviewScreen, 120, 36, 'ReviewView initial at 120x36');
    assert.equal(useTuiStore.getState().page, 'review');

    tty.send('Q');
    const queueOpen = await tty.waitFor(
      (s) =>
        (s.includes('本轮复习队列') || s.includes('Review Queue')) &&
        !s.includes('正在读取队列') &&
        !s.includes('Loading queue') &&
        s.includes('[▶]') &&
        s.includes('[ ]'),
      { timeoutMs: 8_000, label: 'QueueModal opened with [▶] and [ ] markers' },
    );
    tty.assertHealthyScreen(queueOpen, 120, 36, 'QueueModal opened at 120x36');
    assert.ok(queueOpen.includes('[▶]') && queueOpen.includes('[ ]'));

    const initialMeta = parseQueueCount(queueOpen);
    assert.ok(initialMeta && initialMeta.count >= 2, `Expected >=2 cards in queue, got: ${JSON.stringify(initialMeta)}`);
    const initialCount = initialMeta.count;

    const row2Line = queueOpen.split('\n').find((l) => l.includes(' 2 [ ]')) || '';
    const searchTerm = row2Line.includes('Bridge') ? 'Bridge' : 'Memento';

    tty.send('j');
    await tty.waitFor((s) => s.includes('[d] 可移除') || s.includes('[d] Removable'), {
      timeoutMs: 6_000,
      label: 'QueueModal cursor moved to removable upcoming card',
    });

    tty.send('d');
    const afterRemoveScreen = await tty.waitFor(
      (s) => {
        if (s.includes('正在更新本轮队列') || s.includes('Updating round queue')) return false;
        const meta = parseQueueCount(s);
        return Boolean(meta && meta.count === initialCount - 1);
      },
      { timeoutMs: 8_000, label: 'QueueModal count decreased by 1 after [d]' },
    );
    tty.assertHealthyScreen(afterRemoveScreen, 120, 36, 'QueueModal after [d] remove at 120x36');
    const afterRemoveMeta = parseQueueCount(afterRemoveScreen);
    assert.equal(afterRemoveMeta?.count, initialCount - 1, 'Queue count must decrease by 1 after removing upcoming card');

    tty.send('a');
    await tty.waitFor(
      (s) =>
        (s.includes('向本轮队列加题') || s.includes('Add Card to Queue')) &&
        (s.includes('输入关键词搜索') || s.includes('Type keywords')),
      { timeoutMs: 6_000, label: 'QueueModal add-card inline search opened' },
    );

    tty.send(searchTerm);
    await tty.waitFor(
      (s) =>
        !s.includes('正在搜索题库') &&
        !s.includes('Searching cards') &&
        !s.includes('输入关键词搜索要加入本轮的题目') &&
        !s.includes('未找到匹配题目') &&
        s.includes(searchTerm),
      { timeoutMs: 8_000, label: `QueueModal search hits rendered for "${searchTerm}"` },
    );

    tty.send('\x1b[B');
    let hitListScreen = await tty.waitFor(
      (s) => s.includes('[p/Tab] 切换位置') || s.includes('[p/Tab] Pos'),
      { timeoutMs: 6_000, label: 'QueueModal hit list focused via Down arrow' },
    );

    for (let step = 0; step < 8; step += 1) {
      const selectedLine = hitListScreen.split('\n').find((l) => l.includes('▸ ')) || '';
      if (!selectedLine.includes('[已在队列]') && !selectedLine.includes('[in queue]')) break;
      tty.send('j');
      await tty.flush(20);
      hitListScreen = tty.readScreen();
    }

    tty.send('\r');
    const afterAddScreen = await tty.waitFor(
      (s) => {
        if (s.includes('向本轮队列加题') || s.includes('Add Card to Queue')) return false;
        if (s.includes('正在更新本轮队列') || s.includes('Updating round queue')) return false;
        const meta = parseQueueCount(s);
        return Boolean(meta && meta.count === initialCount);
      },
      { timeoutMs: 8_000, label: 'QueueModal count increased by 1 after adding card' },
    );
    tty.assertHealthyScreen(afterAddScreen, 120, 36, 'QueueModal after add at 120x36');
    const afterAddMeta = parseQueueCount(afterAddScreen);
    assert.equal(afterAddMeta?.count, initialCount, 'Queue count must increase by 1 after inserting search hit');

    tty.resize(80, 24);
    const queueNarrow = await tty.waitFor(
      (s) => (s.includes('本轮复习队列') || s.includes('Review Queue')) && s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'QueueModal at 80x24' },
    );
    tty.assertHealthyScreen(queueNarrow, 80, 24, 'QueueModal at 80x24');
    assert.ok(queueNarrow.split('\n').length <= 24);

    tty.resize(120, 36);
    await tty.waitFor((s) => (s.includes('本轮复习队列') || s.includes('Review Queue')) && s.includes('[▶]'), {
      timeoutMs: 8_000,
      label: 'QueueModal restored to 120x36',
    });

    tty.send('\x1b');
    const backToReview = await tty.waitFor(
      (s) =>
        !s.includes('本轮复习队列') &&
        !s.includes('Review Queue') &&
        (s.includes('[D]工具') || s.includes('[D]Tools')),
      { timeoutMs: 8_000, label: 'QueueModal closed via Esc' },
    );
    tty.assertHealthyScreen(backToReview, 120, 36, 'ReviewView after Esc closed QueueModal');
    assert.ok(!backToReview.includes('本轮复习队列'));
  });
});
