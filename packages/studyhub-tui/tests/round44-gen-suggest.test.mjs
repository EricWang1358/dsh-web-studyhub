// Round 44 GenerateView AI Focus Suggestion (generate.suggest + P2 ConfirmDialog) E2E verification:
// node --test tests/round44-gen-suggest.test.mjs
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
const distDir = resolve(pkgRoot, 'dist');

const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const { StudyHubTuiApp } = await import(pathToFileURL(join(distDir, 'App.mjs')).href);

let createTuiHost = null;
let saveTuiPreferences = null;
let displayWidth = null;
let useTuiStore = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('store-') || f.startsWith('chunk-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!createTuiHost && typeof mod.createTuiHost === 'function') createTuiHost = mod.createTuiHost;
    if (!saveTuiPreferences && typeof mod.saveTuiPreferences === 'function') saveTuiPreferences = mod.saveTuiPreferences;
    if (!displayWidth && typeof mod.displayWidth === 'function') displayWidth = mod.displayWidth;
    if (!useTuiStore && typeof mod.useTuiStore?.getState === 'function') useTuiStore = mod.useTuiStore;
  }
}
assert.ok(createTuiHost, 'dist/ must export createTuiHost');
assert.ok(saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(displayWidth, 'dist/ must export displayWidth');
assert.ok(useTuiStore, 'dist/ must export useTuiStore');

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round44-gen-suggest-${label}-`));
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

function resetTuiStore() {
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
  });
}

async function addTextSource(host, title, text, courses = []) {
  const res = await host.call('source.add', { title, text, ...(courses.length ? { courses } : {}) });
  assert.equal(res.ok, true, `source.add(${title}) failed: ${res.error?.message || ''}`);
  const id = res.value?.source?.id || res.value?.id;
  assert.ok(id, `source.add(${title}) must return source id`);
  return id;
}

describe('Round 44: GenerateView AI Focus Suggestion (generate.suggest + P2 ConfirmDialog)', () => {
  after(async () => {
    if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = PREV_DSH_HOME;
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
  });

  test('1) createTuiHost integration: generate.suggest with injectedComplete + empty sourceIds no-signal', async () => {
    const base = await makeTempDir('host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');

    const observedPrompts = [];
    let modelCalls = 0;

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'en',
      injectedComplete: async (system, prompt) => {
        modelCalls += 1;
        observedPrompts.push({ system, prompt: String(prompt) });
        return JSON.stringify({
          focus: ['Raft Leader Election', 'Paxos Quorum', 'Log Replication'],
          coverage: 'standard',
          difficulty: 'application',
          kind: 'quiz',
          why: 'Prioritizes core consensus headings and exam focus.',
        });
      },
    });

    try {
      const secretBody = 'SECRET_BODY_LINE_NEVER_SENT_TO_LIGHT_MODEL';
      const srcId = await addTextSource(
        host,
        'Consensus Protocols',
        `# Distributed Consensus\n${secretBody}\n## Raft Leader Election\n${secretBody}\n## Paxos Quorum\n${secretBody}`,
        ['Distributed Systems'],
      );

      // Valid suggestion call
      const res = await host.call('generate.suggest', {
        sourceIds: [srcId],
        course: 'Distributed Systems',
        goal: 'exam',
      });
      assert.equal(res.ok, true, `generate.suggest failed: ${res.error?.message || ''}`);
      assert.equal(modelCalls, 1, 'generate.suggest must invoke model once on valid reply');
      assert.equal(res.value?.source, 'model');
      assert.deepEqual(res.value?.focus, ['Raft Leader Election', 'Paxos Quorum', 'Log Replication']);
      assert.equal(res.value?.coverage, 'standard');
      assert.equal(res.value?.difficulty, 'application');
      assert.equal(res.value?.kind, 'quiz');
      assert.match(res.value?.why || '', /consensus/i);
      assert.equal(res.value?.basis?.sources, 1);

      const sentPrompt = observedPrompts[0]?.prompt || '';
      assert.ok(sentPrompt.includes('Consensus Protocols'), 'Prompt must include source title');
      assert.ok(sentPrompt.includes('Raft Leader Election'), 'Prompt must include headings');
      assert.ok(sentPrompt.includes('"goal":"exam"'), 'Prompt must forward goal');
      assert.ok(!sentPrompt.includes(secretBody), 'Prompt must never send full source body text');

      // Empty sourceIds -> unavailable.reason === 'no-signal' with 0 additional model calls
      const emptyRes = await host.call('generate.suggest', {
        sourceIds: [],
        course: 'Distributed Systems',
      });
      assert.equal(emptyRes.ok, true, 'Empty sourceIds returns structured local fallback rather than throwing');
      assert.equal(modelCalls, 1, 'no-signal must not invoke model');
      assert.equal(emptyRes.value?.source, 'local');
      assert.deepEqual(emptyRes.value?.focus, []);
      assert.equal(emptyRes.value?.unavailable?.reason, 'no-signal');
    } finally {
      await host.dispose();
    }
  });

  test('2) PTY E2E: GenerateView [S] P2 ConfirmDialog guard, n/Esc cancel (0 calls), y suggest & [a] apply in zh and --ascii en at 120x36 & 80x24', async () => {
    // --- Part A: Default mode (zh) ---
    const baseZh = await makeTempDir('pty-zh');
    const envZh = { DSH_HOME: join(baseZh, 'dsh-home') };
    process.env.DSH_HOME = envZh.DSH_HOME;

    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env: envZh });
    resetTuiStore();

    let zhModelCalls = 0;
    let releaseSuggest = null;
    let suggestGate = null;

    const hostZh = await createTuiHost({
      libraryRoot: join(baseZh, 'library'),
      env: envZh,
      home: baseZh,
      documentsDir: baseZh,
      skipAutoProbe: true,
      language: 'zh',
      injectedComplete: async () => {
        zhModelCalls += 1;
        if (suggestGate) await suggestGate;
        return JSON.stringify({
          focus: ['Raft 领导者选举', 'Paxos 法定人数', '日志复制安全性'],
          coverage: 'standard',
          difficulty: 'application',
          kind: 'multi',
          why: '优先覆盖核心共识章节与高频考点。',
        });
      },
    });

    await addTextSource(
      hostZh,
      '分布式系统讲义',
      '# 共识算法\n## Raft 领导者选举\n## Paxos 法定人数\n正文内容不会发送到轻量模型。',
    );

    const ttyZh = createVirtualTty(120, 36);
    let inkInstance = null;
    try {
      inkInstance = render(React.createElement(StudyHubTuiApp, { host: hostZh, asciiMode: false }), {
        stdin: ttyZh.stdin,
        stdout: ttyZh.stdout,
        stderr: ttyZh.stderr,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await ttyZh.firstFramePromise;

      await ttyZh.waitFor(() => useTuiStore.getState().page === 'library' && Boolean(useTuiStore.getState().snapshot), {
        label: 'zh LibraryView ready',
      });

      // Navigate to GenerateView ('3')
      ttyZh.send('3');
      const genInit = await ttyZh.waitFor(
        (s) => useTuiStore.getState().page === 'generate' && s.includes('新建出题任务') && s.includes('分布式系统讲义'),
        { label: 'zh GenerateView ready' },
      );
      ttyZh.assertHealthyScreen(genInit, 120, 36, 'zh GenerateView initial');
      assert.equal(zhModelCalls, 0, 'Entering GenerateView must make 0 AI calls');

      // Pressing 'S' with 0 selected sources shows friendly toast and makes 0 AI calls
      useTuiStore.setState({ toasts: [] });
      ttyZh.send('S');
      await ttyZh.waitFor(
        () => useTuiStore.getState().toasts.some((toast) => toast.tone === 'warning' && toast.text.includes('请至少选择一份资料')),
        { label: 'zh toast when pressing S with no sources selected' },
      );
      assert.equal(zhModelCalls, 0, 'Empty selection toast must make 0 AI calls');

      // Select source with Space
      ttyZh.send(' ');
      await ttyZh.waitFor((s) => s.includes('1p'), { label: 'zh source selected via Space' });

      // Press 'S' -> ConfirmDialog opens with 0 AI calls
      ttyZh.send('S');
      const zhConfirm1 = await ttyZh.waitFor(
        (s) => s.includes('AI 帮我想想') && s.includes('1 次轻量 AI 调用') && s.includes('不会立即出题'),
        { label: 'zh P2 ConfirmDialog open after S' },
      );
      ttyZh.assertHealthyScreen(zhConfirm1, 120, 36, 'zh ConfirmDialog 120x36');
      assert.equal(zhModelCalls, 0, 'P2 guard: 0 AI calls before ConfirmDialog confirmation');

      // Cancel with 'n' -> still 0 AI calls
      ttyZh.send('n');
      await ttyZh.waitFor(
        (s) => s.includes('新建出题任务') && !s.includes('1 次轻量 AI 调用'),
        { label: 'zh ConfirmDialog cancelled with n' },
      );
      assert.equal(zhModelCalls, 0, 'Cancelling ConfirmDialog with n must keep AI calls at 0');

      // Reopen 'S' and cancel with Esc -> still 0 AI calls
      ttyZh.send('S');
      await ttyZh.waitFor((s) => s.includes('1 次轻量 AI 调用'), { label: 'zh ConfirmDialog reopened for Esc' });
      assert.equal(zhModelCalls, 0, 'Reopening ConfirmDialog must keep AI calls at 0');
      ttyZh.send('\u001b');
      await ttyZh.waitFor(
        (s) => s.includes('新建出题任务') && !s.includes('1 次轻量 AI 调用'),
        { label: 'zh ConfirmDialog cancelled with Esc' },
      );
      assert.equal(zhModelCalls, 0, 'Cancelling ConfirmDialog with Esc must keep AI calls at 0');

      // Press 'S' -> 'y' with gate to verify busyRef blocks duplicate calls while loading
      suggestGate = new Promise((resolveFn) => {
        releaseSuggest = resolveFn;
      });
      ttyZh.send('S');
      await ttyZh.waitFor((s) => s.includes('1 次轻量 AI 调用'), { label: 'zh ConfirmDialog before gated y' });
      ttyZh.send('y');
      await ttyZh.waitFor(
        (s) => s.includes('正在分析资料目录与薄弱知识点'),
        { label: 'zh loading modal while generating suggestion' },
      );
      ttyZh.send('S');
      ttyZh.send('\u001b');
      await ttyZh.flush();
      assert.equal(zhModelCalls, 1, 'busyRef must prevent duplicate AI calls while suggest is running');

      releaseSuggest();
      suggestGate = null;

      // Verify suggestion summary modal renders cleanly at 120x36
      const zhSuggestWide = await ttyZh.waitFor(
        (s) =>
          s.includes('AI 出题重点建议') &&
          s.includes('Raft 领导者选举') &&
          s.includes('Paxos 法定人数') &&
          s.includes('优先覆盖核心共识章节'),
        { label: 'zh AI suggestion rendered at 120x36' },
      );
      ttyZh.assertHealthyScreen(zhSuggestWide, 120, 36, 'zh AI suggestion 120x36');

      // Resize to 80x24 while suggestion modal is visible
      ttyZh.resize(80, 24);
      const zhSuggestNarrow = await ttyZh.waitFor(
        (s) => s.includes('AI 出题重点建议') && s.includes('Raft 领导者选举') && s.split('\n').length <= 24,
        { label: 'zh AI suggestion rendered at 80x24' },
      );
      ttyZh.assertHealthyScreen(zhSuggestNarrow, 80, 24, 'zh AI suggestion 80x24');

      // Apply suggestion with [a] at 80x24, then verify applied form at 120x36
      useTuiStore.setState({ toasts: [] });
      ttyZh.send('a');
      const zhAppliedNarrow = await ttyZh.waitFor(
        (s) =>
          !s.includes('AI 出题重点建议') &&
          s.includes('新建出题任务') &&
          useTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已将建议重点应用')),
        { label: 'zh [a] applies suggestion toast at 80x24' },
      );
      ttyZh.assertHealthyScreen(zhAppliedNarrow, 80, 24, 'zh GenerateView after apply 80x24');

      ttyZh.resize(120, 36);
      const zhApplied = await ttyZh.waitFor(
        (s) => s.includes('Raft 领导者选举') && s.includes('多选'),
        { label: 'zh [a] applied focus & kind visible in right panel at 120x36' },
      );
      ttyZh.assertHealthyScreen(zhApplied, 120, 36, 'zh GenerateView after apply 120x36');
    } finally {
      inkInstance?.unmount();
      inkInstance = null;
      ttyZh.dispose();
      await hostZh.dispose();
    }

    // --- Part B: --ascii mode (en) ---
    const baseEn = await makeTempDir('pty-en');
    const envEn = { DSH_HOME: join(baseEn, 'dsh-home') };
    process.env.DSH_HOME = envEn.DSH_HOME;

    await saveTuiPreferences({ language: 'en', asciiMode: true }, { env: envEn });
    resetTuiStore();

    let enModelCalls = 0;

    const hostEn = await createTuiHost({
      libraryRoot: join(baseEn, 'library'),
      env: envEn,
      home: baseEn,
      documentsDir: baseEn,
      skipAutoProbe: true,
      language: 'en',
      injectedComplete: async () => {
        enModelCalls += 1;
        return JSON.stringify({
          focus: ['Raft Leader Election', 'Log Replication Safety'],
          coverage: 'full',
          difficulty: 'application',
          kind: 'multi',
          why: 'Targets core distributed consensus headings.',
        });
      },
    });

    await addTextSource(
      hostEn,
      'Distributed Systems Notes',
      '# Consensus\n## Raft Leader Election\n## Log Replication Safety\nPlain body text.',
    );

    const ttyEn = createVirtualTty(120, 36);
    try {
      inkInstance = render(React.createElement(StudyHubTuiApp, { host: hostEn, asciiMode: true }), {
        stdin: ttyEn.stdin,
        stdout: ttyEn.stdout,
        stderr: ttyEn.stderr,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await ttyEn.firstFramePromise;

      await ttyEn.waitFor(() => useTuiStore.getState().page === 'library' && Boolean(useTuiStore.getState().snapshot), {
        label: 'en --ascii LibraryView ready',
      });

      ttyEn.send('3');
      const enGenInit = await ttyEn.waitFor(
        (s) => useTuiStore.getState().page === 'generate' && s.includes('New Generation') && s.includes('Distributed Systems Notes'),
        { label: 'en --ascii GenerateView ready' },
      );
      ttyEn.assertHealthyScreen(enGenInit, 120, 36, 'en --ascii GenerateView initial');
      ttyEn.assertAsciiPure(enGenInit, 'en --ascii GenerateView initial');
      assert.equal(enModelCalls, 0);

      // Select source with Space
      ttyEn.send(' ');
      await ttyEn.waitFor((s) => s.includes('1p'), { label: 'en --ascii source selected' });

      // Press 'S' -> ConfirmDialog opens with 0 AI calls
      ttyEn.send('S');
      const enConfirm = await ttyEn.waitFor(
        (s) => s.includes('AI Study Focus Suggestion') && s.includes('1 lightweight AI call') && s.includes('no cards generated yet'),
        { label: 'en --ascii ConfirmDialog open' },
      );
      ttyEn.assertHealthyScreen(enConfirm, 120, 36, 'en --ascii ConfirmDialog 120x36');
      ttyEn.assertAsciiPure(enConfirm, 'en --ascii ConfirmDialog 120x36');
      assert.equal(enModelCalls, 0);

      // Cancel with 'n' and Esc -> 0 AI calls
      ttyEn.send('n');
      await ttyEn.waitFor((s) => !s.includes('1 lightweight AI call'), { label: 'en --ascii ConfirmDialog cancel n' });
      assert.equal(enModelCalls, 0);

      ttyEn.send('S');
      await ttyEn.waitFor((s) => s.includes('1 lightweight AI call'), { label: 'en --ascii ConfirmDialog reopen' });
      ttyEn.send('\u001b');
      await ttyEn.waitFor((s) => !s.includes('1 lightweight AI call'), { label: 'en --ascii ConfirmDialog cancel Esc' });
      assert.equal(enModelCalls, 0);

      // Press 'S' -> 'y' -> verify suggestion renders cleanly at 120x36
      ttyEn.send('S');
      await ttyEn.waitFor((s) => s.includes('1 lightweight AI call'), { label: 'en --ascii ConfirmDialog before y' });
      ttyEn.send('y');

      const enSuggestWide = await ttyEn.waitFor(
        (s) =>
          s.includes('AI Focus Suggestion') &&
          s.includes('Raft Leader Election') &&
          s.includes('Log Replication Safety') &&
          s.includes('Targets core distributed consensus headings'),
        { label: 'en --ascii AI suggestion 120x36' },
      );
      ttyEn.assertHealthyScreen(enSuggestWide, 120, 36, 'en --ascii AI suggestion 120x36');
      ttyEn.assertAsciiPure(enSuggestWide, 'en --ascii AI suggestion 120x36');
      assert.equal(enModelCalls, 1);

      // Resize to 80x24 and verify ASCII purity & bounds
      ttyEn.resize(80, 24);
      const enSuggestNarrow = await ttyEn.waitFor(
        (s) => s.includes('AI Focus Suggestion') && s.includes('Raft Leader Election') && s.split('\n').length <= 24,
        { label: 'en --ascii AI suggestion 80x24' },
      );
      ttyEn.assertHealthyScreen(enSuggestNarrow, 80, 24, 'en --ascii AI suggestion 80x24');
      ttyEn.assertAsciiPure(enSuggestNarrow, 'en --ascii AI suggestion 80x24');

      // Press 'a' to apply into generation form
      useTuiStore.setState({ toasts: [] });
      ttyEn.send('a');
      const enAppliedNarrow = await ttyEn.waitFor(
        (s) =>
          !s.includes('AI Focus Suggestion') &&
          s.includes('New Generation') &&
          useTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('Applied suggested focus')),
        { label: 'en --ascii [a] applies suggestion toast at 80x24' },
      );
      ttyEn.assertHealthyScreen(enAppliedNarrow, 80, 24, 'en --ascii after apply 80x24');
      ttyEn.assertAsciiPure(enAppliedNarrow, 'en --ascii after apply 80x24');

      ttyEn.resize(120, 36);
      const enApplied = await ttyEn.waitFor(
        (s) => s.includes('Raft Leader Election') && s.includes('Multi'),
        { label: 'en --ascii [a] applied focus & kind visible in right panel at 120x36' },
      );
      ttyEn.assertHealthyScreen(enApplied, 120, 36, 'en --ascii after apply 120x36');
      ttyEn.assertAsciiPure(enApplied, 'en --ascii after apply 120x36');
    } finally {
      inkInstance?.unmount();
      inkInstance = null;
      ttyEn.dispose();
      await hostEn.dispose();
    }
  });
});
