// Round 59 Task 3: WorkflowHistoryModal Full Workflow Context Inspector (`workflow.context` & `workflow.session.get`, 0 LLM tokens)
// + HelpOverlay & KEYBINDINGS sync tests:
// node --test --test-concurrency=1 tests/round59-workflow-ctx.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import xtermPkg from '@xterm/headless';
import { render } from 'ink';
import React from 'react';

const { Terminal } = xtermPkg;
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const repoRoot = resolve(pkgRoot, '../..');
const distDir = resolve(pkgRoot, 'dist');

const { Store } = await import(pathToFileURL(join(repoRoot, 'lib/store.js')).href);

// Canonical dist chunk discovery
const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const { StudyHubTuiApp } = await import(pathToFileURL(join(distDir, 'App.mjs')).href);

let H = null;
let R = null;
let S = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('chunk-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!H && typeof mod.createTuiHost === 'function' && typeof mod.saveTuiPreferences === 'function') H = mod;
    if (!R && typeof mod.displayWidth === 'function') R = mod;
    if (!S && mod.useTuiStore?.getState && mod.DEFAULT_PREFERENCES) S = mod;
  }
}
assert.ok(H?.createTuiHost, 'dist/ must export createTuiHost');
assert.ok(H?.saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(R?.displayWidth, 'dist/ must export displayWidth');
assert.ok(S?.useTuiStore, 'dist/ must export useTuiStore');
assert.ok(S?.DEFAULT_PREFERENCES, 'dist/ must export DEFAULT_PREFERENCES');

const { createTuiHost, saveTuiPreferences } = H;
const { displayWidth } = R;
const { useTuiStore: useDistTuiStore, DEFAULT_PREFERENCES } = S;

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round59-wf-${label}-`));
  tempDirs.push(d);
  return d;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const UNICODE_UI_CHROME_RE = /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u27BF\u2800-\u28FF\u2190-\u21FF\u2022\u2026\u2039\u203A]/g;

function resetDistStore(language = 'zh', asciiMode = false, extra = {}) {
  useDistTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    snapshot: null,
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
      language,
      asciiMode,
    },
    ...extra,
  });
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

function fakeDiscovery() {
  const result = () => [
    { id: 'agy', supported: true, status: 'not-installed', executablePath: null, version: null, reasonCode: 'not-installed', reason: '' },
    { id: 'claude', supported: false, status: 'coming-soon', executablePath: null, version: null, reasonCode: 'coming-soon-not-installed', reason: '' },
    { id: 'codex', supported: true, status: 'not-installed', executablePath: null, version: null, reasonCode: 'not-installed', reason: '' },
  ];
  return {
    async scan() {
      return result();
    },
    getCached: () => result(),
    findReadyPath: () => '',
    findReadyAgyPath: () => '',
    findReadyCodexPath: () => '',
  };
}

async function seedWorkflowLibrary(libraryRoot, host, { lang = 'zh' } = {}) {
  const isEn = lang === 'en';
  const deckTitle = isEn ? 'Mean Value Theorem Deck' : '中值定理题组';
  const courseName = isEn ? 'Calculus' : '高等数学';
  const imp = await host.call('deck.import', {
    text: JSON.stringify({
      title: deckTitle,
      course: courseName,
      cards: [
        {
          kind: 'flashcard',
          prompt: isEn ? 'State Lagrange Mean Value Theorem.' : '写出拉格朗日中值定理条件与结论。',
          answer: isEn ? 'Continuous on [a,b], differentiable on (a,b).' : '闭区间连续，开区间可导。',
          topic: isEn ? 'MeanValue' : '中值定理',
        },
      ],
    }),
  });
  assert.equal(imp.ok, true, `deck.import failed: ${imp.error?.message}`);
  const snapRes = await host.refreshSnapshot();
  const deck = (snapRes.snapshot?.decks ?? []).find((d) => !d.archived && !d.systemKind && d.title === deckTitle);
  assert.ok(deck, 'Seeded deck must exist in snapshot');

  const store = new Store(libraryRoot);
  const templateId = 'wf-tpl-1';
  const sessionId = 'wf-ses-1';
  await store.update((state) => {
    state.workflowTemplates.push({
      id: templateId,
      title: isEn ? 'Calculus Deep Study Flow' : '微积分深度学习流',
      description: isEn ? 'From theorem intuition to proof drills.' : '从定理直觉到证明训练的复习流程。',
      version: 1,
      updatedAt: '2026-11-20T10:00:00.000Z',
      steps: [
        {
          id: 'step-1',
          kind: 'overview',
          title: isEn ? 'Set Goal' : '明确目标',
          instructions: isEn ? 'Identify core theorem conditions.' : '梳理定理前提与边界条件。',
          content: '',
        },
        {
          id: 'step-2',
          kind: 'lesson',
          title: isEn ? 'Concept & Example' : '概念与例子',
          instructions: isEn ? 'Derive auxiliary function.' : '构造辅助函数完成推导。',
          content: isEn ? 'Construct F(x) = f(x) - kx to apply Rolle theorem.' : '构造辅助函数 F(x) 转化为罗尔定理。',
        },
      ],
    });
    state.workflowSessions.push({
      id: sessionId,
      requestId: 'req-seed-wf-1',
      topic: isEn ? 'Lagrange Theorem Workshop' : '拉格朗日中值定理专练',
      goal: isEn ? 'Master auxiliary function construction' : '掌握中值定理辅助函数构造方法',
      course: { name: courseName, label: courseName },
      scope: [{ deckId: deck.id }],
      skeletonId: null,
      currentStepId: 'step-2',
      status: 'active',
      version: 1,
      createdAt: '2026-11-20T09:00:00.000Z',
      updatedAt: '2026-11-20T10:30:00.000Z',
      template: {
        id: templateId,
        title: isEn ? 'Calculus Deep Study Flow' : '微积分深度学习流',
        description: isEn ? 'From theorem intuition to proof drills.' : '从定理直觉到证明训练的复习流程。',
        steps: [
          {
            id: 'step-1',
            kind: 'overview',
            title: isEn ? 'Set Goal' : '明确目标',
            instructions: isEn ? 'Identify core theorem conditions.' : '梳理定理前提与边界条件。',
            content: '',
          },
          {
            id: 'step-2',
            kind: 'lesson',
            title: isEn ? 'Concept & Example' : '概念与例子',
            instructions: isEn ? 'Derive auxiliary function.' : '构造辅助函数完成推导。',
            content: isEn ? 'Construct F(x) = f(x) - kx to apply Rolle theorem.' : '构造辅助函数 F(x) 转化为罗尔定理。',
          },
        ],
      },
      records: {
        'step-1': {
          outcome: 'done',
          output: isEn ? 'Confirmed continuity and differentiability.' : '确认闭区间连续与开区间可导。',
          updatedAt: '2026-11-20T09:20:00.000Z',
        },
      },
      history: [
        {
          requestId: 'hist-1',
          stepId: 'step-1',
          outcome: 'done',
          output: isEn ? 'Goal step finished' : '完成目标步骤',
          at: '2026-11-20T09:20:00.000Z',
        },
      ],
    });
  });

  await host.refreshSnapshot();
  return { deckId: deck.id, templateId, sessionId };
}

after(async () => {
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

describe('Round 59: WorkflowHistoryModal Context Inspector + HelpOverlay Sync', () => {
  test('1) createTuiHost integration (0 model calls): workflow.list -> workflow.context & workflow.session.get', async () => {
    const base = await makeTempDir('host');
    const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');

    let aiCalls = 0;
    let fetchCalls = 0;
    const host = await createTuiHost({
      libraryRoot,
      env,
      home: join(base, 'home'),
      documentsDir: base,
      discovery: fakeDiscovery(),
      injectedComplete: async () => {
        aiCalls += 1;
        return '{}';
      },
      fetch: async () => {
        fetchCalls += 1;
        throw new Error('Network call must not happen during workflow.list / workflow.context');
      },
      skipAutoProbe: true,
      language: 'zh',
    });

    try {
      const { sessionId, templateId } = await seedWorkflowLibrary(libraryRoot, host, { lang: 'zh' });

      const listRes = await host.call('workflow.list', {});
      assert.equal(listRes.ok, true, `workflow.list failed: ${listRes.error?.message}`);
      assert.equal(listRes.value?.retired, true);
      assert.ok(Array.isArray(listRes.value?.sessions) && listRes.value.sessions.length >= 1, 'workflow.list must return seeded session');
      assert.ok(Array.isArray(listRes.value?.templates) && listRes.value.templates.length >= 1, 'workflow.list must return seeded template');
      assert.ok(Array.isArray(listRes.value?.components) && listRes.value.components.length >= 1, 'workflow.list must return components');
      assert.ok(Array.isArray(listRes.value?.suggested?.steps) && listRes.value.suggested.steps.length >= 1, 'workflow.list must return suggested flow');

      const firstWorkflow = listRes.value.sessions[0];
      assert.equal(firstWorkflow.id, sessionId);

      const ctxRes = await host.call('workflow.context', { id: firstWorkflow.id, sessionId: firstWorkflow.id });
      assert.equal(ctxRes.ok, true, `workflow.context failed: ${ctxRes.error?.message}`);
      assert.ok(typeof ctxRes.value?.contract === 'string' && ctxRes.value.contract.length > 0, 'workflow.context must return contract');
      assert.ok(typeof ctxRes.value?.api?.read === 'string', 'workflow.context must return api.read');
      assert.equal(ctxRes.value?.session?.id, firstWorkflow.id, 'workflow.context must return matching session');
      assert.ok(Array.isArray(ctxRes.value?.session?.template?.steps) && ctxRes.value.session.template.steps.length === 2);
      assert.equal(ctxRes.value?.resources?.cardCount, 1, 'workflow.context resources must count scoped cards');
      assert.ok(Array.isArray(ctxRes.value?.resources?.scopeDecks) && ctxRes.value.resources.scopeDecks.includes('中值定理题组'));

      const sesRes = await host.call('workflow.session.get', { id: firstWorkflow.id });
      assert.equal(sesRes.ok, true, `workflow.session.get failed: ${sesRes.error?.message}`);
      assert.equal(sesRes.value?.session?.id, sessionId);
      assert.equal(sesRes.value?.resources?.cardCount, 1);

      const globalCtxRes = await host.call('workflow.context', { id: templateId });
      assert.equal(globalCtxRes.ok, true, `workflow.context global failed: ${globalCtxRes.error?.message}`);
      assert.equal(globalCtxRes.value?.session, null);
      assert.ok(Array.isArray(globalCtxRes.value?.templates) && globalCtxRes.value.templates.some((tpl) => tpl.id === templateId));

      assert.equal(aiCalls, 0, 'workflow.list/context/session.get must make 0 model calls');
      assert.equal(fetchCalls, 0, 'workflow.list/context/session.get must make 0 network calls');
    } finally {
      await host.dispose();
    }
  });

  test('2a) @xterm/headless PTY E2E (120x36 zh): TasksView -> w -> c/Enter inspect context -> r refresh -> b/Esc -> ? HelpOverlay', async () => {
    const base = await makeTempDir('e2e-zh');
    const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');

    let aiCalls = 0;
    let fetchCalls = 0;
    resetDistStore('zh', false);
    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });

    const host = await createTuiHost({
      env,
      home: join(base, 'home'),
      libraryRoot,
      discovery: fakeDiscovery(),
      injectedComplete: async () => {
        aiCalls += 1;
        return '{}';
      },
      fetch: async () => {
        fetchCalls += 1;
        throw new Error('Network call must not happen during WorkflowHistoryModal PTY E2E');
      },
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    await seedWorkflowLibrary(libraryRoot, host, { lang: 'zh' });

    const tty = createVirtualTty(120, 36);
    const inkInstance = render(
      React.createElement(StudyHubTuiApp, {
        host,
        autoLaunchpad: false,
        onExit: () => inkInstance.unmount(),
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

    try {
      await tty.firstFramePromise;
      const tasksInit = await (async () => {
        await tty.waitFor((s) => s.includes('中值定理题组') || s.includes('学习库'), {
          timeoutMs: 8_000,
          label: 'LibraryView initial zh',
        });
        tty.send('t');
        return tty.waitFor(
          (s) => s.includes('监控后台任务') && s.includes('1. 运行中') && !s.includes('正在加载页面'),
          { timeoutMs: 8_000, label: 'TasksView rendered zh' },
        );
      })();
      tty.assertHealthyScreen(tasksInit, 120, 36, 'TasksView zh 120x36');

      // Open WorkflowHistoryModal ('w')
      tty.send('w');
      const modalListScreen = await tty.waitFor(
        (s) =>
          s.includes('历史学习流记录 (只读)') &&
          s.includes('拉格朗日中值定理专练') &&
          !s.includes('正在读取历史学习流'),
        { timeoutMs: 8_000, label: 'WorkflowHistoryModal list loaded zh' },
      );
      tty.assertHealthyScreen(modalListScreen, 120, 36, 'WorkflowHistoryModal list zh 120x36');

      // Press 'c' -> inspect full workflow.context
      tty.send('c');
      const ctxScreen = await tty.waitFor(
        (s) =>
          s.includes('上下文视图') &&
          s.includes('拉格朗日中值定理专练') &&
          s.includes('步骤时间线') &&
          !s.includes('正在读取工作流上下文'),
        { timeoutMs: 8_000, label: 'WorkflowHistoryModal context view via c zh' },
      );
      tty.assertHealthyScreen(ctxScreen, 120, 36, 'WorkflowHistoryModal context zh 120x36');

      // Refresh context ('r') then return to list ('b')
      tty.send('r');
      const ctxRefreshed = await tty.waitFor(
        (s) => s.includes('上下文视图') && s.includes('拉格朗日中值定理专练') && !s.includes('正在读取工作流上下文'),
        { timeoutMs: 8_000, label: 'WorkflowHistoryModal context refreshed zh' },
      );
      tty.assertHealthyScreen(ctxRefreshed, 120, 36, 'WorkflowHistoryModal context refreshed zh');

      tty.send('b');
      const backToList = await tty.waitFor(
        (s) => s.includes('只读存档') && !s.includes('上下文视图') && s.includes('拉格朗日中值定理专练'),
        { timeoutMs: 8_000, label: 'WorkflowHistoryModal returned to list via b zh' },
      );
      tty.assertHealthyScreen(backToList, 120, 36, 'WorkflowHistoryModal back to list zh');

      // Press Enter on first item -> opens context view -> Esc back to list -> Esc closes modal
      tty.send('\r');
      const ctxViaEnter = await tty.waitFor(
        (s) => s.includes('上下文视图') && s.includes('掌握中值定理辅助函数构造方法') && !s.includes('正在读取工作流上下文'),
        { timeoutMs: 8_000, label: 'WorkflowHistoryModal context view via Enter zh' },
      );
      tty.assertHealthyScreen(ctxViaEnter, 120, 36, 'WorkflowHistoryModal context Enter zh');

      tty.send('\x1b');
      await tty.waitFor(
        (s) => s.includes('只读存档') && !s.includes('上下文视图'),
        { timeoutMs: 8_000, label: 'WorkflowHistoryModal Esc from context to list zh' },
      );

      tty.send('\x1b');
      const backToTasks = await tty.waitFor(
        (s) => !s.includes('历史学习流记录 (只读)') && s.includes('监控后台任务'),
        { timeoutMs: 8_000, label: 'WorkflowHistoryModal closed via Esc zh' },
      );
      tty.assertHealthyScreen(backToTasks, 120, 36, 'TasksView after modal close zh');

      // Open HelpOverlay ('?') and verify Round 59 labels
      tty.send('?');
      const helpScreenTop = await tty.waitFor(
        (s) => s.includes('快捷键') && s.includes('B支线/u回/Q问答'),
        { timeoutMs: 8_000, label: 'HelpOverlay Round 59 Library label zh' },
      );
      tty.assertHealthyScreen(helpScreenTop, 120, 36, 'HelpOverlay top zh 120x36');
      tty.send('G');
      const helpScreen = await tty.waitFor(
        (s) => s.includes('工作流上下文'),
        { timeoutMs: 8_000, label: 'HelpOverlay Round 59 Tasks label zh' },
      );
      tty.assertHealthyScreen(helpScreen, 120, 36, 'HelpOverlay zh 120x36');
      assert.equal(aiCalls, 0, 'PTY zh flow must trigger 0 model calls');
      assert.equal(fetchCalls, 0, 'PTY zh flow must trigger 0 network calls');
    } finally {
      try {
        inkInstance.unmount();
      } catch {
        // ignore unmount errors
      }
      tty.dispose();
      await host.dispose();
    }
  });

  test('2b) @xterm/headless PTY E2E (80x24 --ascii en): TasksView -> w -> Enter/c context -> Esc -> ? HelpOverlay (pure ASCII)', async () => {
    const base = await makeTempDir('e2e-en-ascii');
    const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');

    let aiCalls = 0;
    let fetchCalls = 0;
    resetDistStore('en', true);
    await saveTuiPreferences({ language: 'en', asciiMode: true }, { env });

    const host = await createTuiHost({
      env,
      home: join(base, 'home'),
      libraryRoot,
      discovery: fakeDiscovery(),
      injectedComplete: async () => {
        aiCalls += 1;
        return '{}';
      },
      fetch: async () => {
        fetchCalls += 1;
        throw new Error('Network call must not happen during --ascii WorkflowHistoryModal PTY E2E');
      },
      skipAutoProbe: true,
      language: 'en',
      eventDebounceMs: 30,
    });

    await seedWorkflowLibrary(libraryRoot, host, { lang: 'en' });

    const tty = createVirtualTty(80, 24);
    const inkInstance = render(
      React.createElement(StudyHubTuiApp, {
        host,
        autoLaunchpad: false,
        onExit: () => inkInstance.unmount(),
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

    try {
      await tty.firstFramePromise;
      await tty.waitFor((s) => s.includes('Mean Value Theorem Deck') || s.includes('Library'), {
        timeoutMs: 8_000,
        label: 'LibraryView initial en --ascii',
      });

      tty.send('t');
      const tasksAscii = await tty.waitFor(
        (s) => (s.includes('Monitor jobs') || s.includes('Jobs: [R]Rec')) && s.includes('1. Running') && !s.includes('Loading'),
        { timeoutMs: 8_000, label: 'TasksView en --ascii 80x24' },
      );
      tty.assertHealthyScreen(tasksAscii, 80, 24, 'TasksView en --ascii 80x24');
      tty.assertAsciiPure(tasksAscii, 'TasksView en --ascii 80x24');

      // Open WorkflowHistoryModal ('w')
      tty.send('w');
      const wfListAscii = await tty.waitFor(
        (s) =>
          s.includes('Workflow History (Read-Only)') &&
          s.includes('Lagrange Theorem Workshop') &&
          !s.includes('Loading workflow history'),
        { timeoutMs: 8_000, label: 'WorkflowHistoryModal list en --ascii 80x24' },
      );
      tty.assertHealthyScreen(wfListAscii, 80, 24, 'WorkflowHistoryModal list en --ascii 80x24');
      tty.assertAsciiPure(wfListAscii, 'WorkflowHistoryModal list en --ascii 80x24');

      // Press Enter -> inspect context -> pure ASCII check
      tty.send('\r');
      const ctxAscii = await tty.waitFor(
        (s) =>
          s.includes('workflow.context inspector') &&
          s.includes('Lagrange Theorem Workshop') &&
          s.includes('Evidence Excerpts') &&
          !s.includes('Loading workflow context'),
        { timeoutMs: 8_000, label: 'WorkflowHistoryModal context en --ascii 80x24' },
      );
      tty.assertHealthyScreen(ctxAscii, 80, 24, 'WorkflowHistoryModal context en --ascii 80x24');
      tty.assertAsciiPure(ctxAscii, 'WorkflowHistoryModal context en --ascii 80x24');

      // Esc back to list -> Esc close modal
      tty.send('\x1b');
      await tty.waitFor(
        (s) => s.includes('Read-Only') && !s.includes('workflow.context inspector'),
        { timeoutMs: 8_000, label: 'WorkflowHistoryModal Esc to list en --ascii' },
      );

      tty.send('\x1b');
      await tty.waitFor(
        (s) => !s.includes('Workflow History (Read-Only)') && (s.includes('Monitor jobs') || s.includes('Jobs: [R]Rec')),
        { timeoutMs: 8_000, label: 'WorkflowHistoryModal closed en --ascii' },
      );

      // Open HelpOverlay ('?') and scroll single-column 80x24 to verify Round 59 labels & pure ASCII
      tty.send('?');
      const helpOpenScreen = await tty.waitFor(
        (s) => s.includes('Keyboard Shortcuts'),
        { timeoutMs: 8_000, label: 'HelpOverlay opened en --ascii 80x24' },
      );
      tty.assertHealthyScreen(helpOpenScreen, 80, 24, 'HelpOverlay open en --ascii 80x24');
      tty.assertAsciiPure(helpOpenScreen, 'HelpOverlay open en --ascii 80x24');

      let prevHelpScreen = helpOpenScreen;
      let seenLibraryLabel = helpOpenScreen.includes('AI Guided Study (B/u/Q)');
      let seenTasksLabel = helpOpenScreen.includes('Workflows ctx / Output / Msg');
      for (let step = 0; step < 24 && (!seenLibraryLabel || !seenTasksLabel); step += 1) {
        tty.send(' ');
        const cur = await tty.waitFor(
          (s) => s !== prevHelpScreen,
          { timeoutMs: 2_000, label: `HelpOverlay scroll #${step + 1}` },
        ).catch(() => tty.readScreen());
        tty.assertHealthyScreen(cur, 80, 24, `HelpOverlay scroll #${step + 1} en --ascii 80x24`);
        tty.assertAsciiPure(cur, `HelpOverlay scroll #${step + 1} en --ascii 80x24`);
        if (cur.includes('AI Guided Study (B/u/Q)')) seenLibraryLabel = true;
        if (cur.includes('Workflows ctx / Output / Msg')) seenTasksLabel = true;
        if (cur === prevHelpScreen) break;
        prevHelpScreen = cur;
      }
      assert.equal(seenLibraryLabel, true, 'HelpOverlay must display Round 59 Library [g] label in en --ascii');
      assert.equal(seenTasksLabel, true, 'HelpOverlay must display Round 59 Tasks [w / o / m] label in en --ascii');
      assert.equal(aiCalls, 0, 'PTY en --ascii flow must trigger 0 model calls');
      assert.equal(fetchCalls, 0, 'PTY en --ascii flow must trigger 0 network calls');
    } finally {
      try {
        inkInstance.unmount();
      } catch {
        // ignore unmount errors
      }
      tty.dispose();
      await host.dispose();
    }
  });

  test('2c) @xterm/headless PTY E2E (80x24 --ascii en): empty workflow list -> c opens Global Context -> Esc closes cleanly', async () => {
    const base = await makeTempDir('e2e-empty-ascii');
    const env = { ...process.env, DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');

    let aiCalls = 0;
    resetDistStore('en', true);
    await saveTuiPreferences({ language: 'en', asciiMode: true }, { env });

    const host = await createTuiHost({
      env,
      home: join(base, 'home'),
      libraryRoot,
      discovery: fakeDiscovery(),
      injectedComplete: async () => {
        aiCalls += 1;
        return '{}';
      },
      fetch: async () => {
        throw new Error('Network call must not happen');
      },
      skipAutoProbe: true,
      language: 'en',
      eventDebounceMs: 30,
    });

    const tty = createVirtualTty(80, 24);
    const inkInstance = render(
      React.createElement(StudyHubTuiApp, {
        host,
        autoLaunchpad: false,
        onExit: () => inkInstance.unmount(),
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

    try {
      await tty.firstFramePromise;
      await tty.waitFor((s) => s.includes('Library') && !s.includes('Loading'), {
        timeoutMs: 8_000,
        label: 'LibraryView empty ready',
      });
      tty.send('t');
      await tty.waitFor(
        (s) => (s.includes('Monitor jobs') || s.includes('Jobs: [R]Rec')) && s.includes('1. Running'),
        { timeoutMs: 8_000, label: 'TasksView empty ready' },
      );
      tty.send('w');
      const emptyModal = await tty.waitFor(
        (s) => s.includes('No historical workflow runs yet') && !s.includes('Loading workflow history'),
        { timeoutMs: 8_000, label: 'WorkflowHistoryModal empty state' },
      );
      tty.assertHealthyScreen(emptyModal, 80, 24, 'WorkflowHistoryModal empty en --ascii');
      tty.assertAsciiPure(emptyModal, 'WorkflowHistoryModal empty en --ascii');

      tty.send('c');
      const globalCtx = await tty.waitFor(
        (s) => s.includes('workflow.context inspector') && s.includes('Workflow Context Overview') && !s.includes('Loading workflow context'),
        { timeoutMs: 8_000, label: 'WorkflowHistoryModal global context from empty state' },
      );
      tty.assertHealthyScreen(globalCtx, 80, 24, 'WorkflowHistoryModal global context en --ascii');
      tty.assertAsciiPure(globalCtx, 'WorkflowHistoryModal global context en --ascii');

      tty.send('\x1b');
      await tty.waitFor(
        (s) => s.includes('No historical workflow runs yet') && !s.includes('workflow.context inspector'),
        { timeoutMs: 8_000, label: 'WorkflowHistoryModal back to empty state' },
      );
      tty.send('\x1b');
      await tty.waitFor(
        (s) => !s.includes('Workflow History (Read-Only)') && (s.includes('Monitor jobs') || s.includes('Jobs: [R]Rec')),
        { timeoutMs: 8_000, label: 'WorkflowHistoryModal closed from empty state' },
      );
      assert.equal(aiCalls, 0);
    } finally {
      try {
        inkInstance.unmount();
      } catch {
        // ignore unmount errors
      }
      tty.dispose();
      await host.dispose();
    }
  });
});
