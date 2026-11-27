// Consolidated Tasks & Audio Domain Suite (AudioView, TasksView, WorkflowHistoryModal):
// Merged from: round38-audio-e2e, round43-jobs-control, round49-tasks-recover, round51-audio-review,
//              round59-workflow-ctx, round63-job-parallel, round67-audio-export, round71-tasks-filter
// node --test tests/domain-tasks-audio.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { render } from 'ink';
import React from 'react';
import { StudyService } from '../../../lib/service.js';
import { Store } from '../../../lib/store.js';
import {
  createTempTracker,
  createVirtualTty,
  disposeTerminalPool,
  distDir,
  findExportedBackupFile,
  installNoNetworkGuard,
  loadDistRuntime,
  pkgRoot,
  sanitizedTestEnv,
} from './helpers/virtual-tty.mjs';

const runtime = await loadDistRuntime();
const { StudyHubTuiApp, createTuiHost, saveTuiPreferences } = runtime;
assert.ok(StudyHubTuiApp, 'dist/ must export StudyHubTuiApp');
assert.ok(createTuiHost, 'dist/ must export createTuiHost');
assert.ok(saveTuiPreferences, 'dist/ must export saveTuiPreferences');

const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const storeFile = distFiles.find((f) => f.startsWith('store-') && f.endsWith('.mjs'));
assert.ok(storeFile, 'dist/ must include store-*.mjs');
const { useTuiStore, DEFAULT_PREFERENCES } = await import(pathToFileURL(join(distDir, storeFile)).href);
assert.ok(useTuiStore, 'dist/store-*.mjs must export useTuiStore');
assert.ok(DEFAULT_PREFERENCES, 'dist/store-*.mjs must export DEFAULT_PREFERENCES');

const audioChunk = distFiles.find((f) => f.startsWith('AudioView-') && f.endsWith('.mjs'));
assert.ok(audioChunk, `dist/ must emit AudioView-*.mjs chunk, found: ${distFiles.join(', ')}`);
const { countPendingCorrections, formatAudioTranscriptMarkdown } = await import(
  pathToFileURL(join(distDir, audioChunk)).href
);
assert.equal(typeof countPendingCorrections, 'function', `${audioChunk} must export countPendingCorrections`);
assert.equal(typeof formatAudioTranscriptMarkdown, 'function', `${audioChunk} must export formatAudioTranscriptMarkdown`);

const tasksChunk = distFiles.find((f) => f.startsWith('TasksView-') && f.endsWith('.mjs'));
assert.ok(tasksChunk, `dist/ must emit TasksView-*.mjs chunk, found: ${distFiles.join(', ')}`);
const { formatTasksMarkdown } = await import(pathToFileURL(join(distDir, tasksChunk)).href);
assert.equal(typeof formatTasksMarkdown, 'function', `${tasksChunk} must export formatTasksMarkdown`);

const helpChunk = distFiles.find((f) => f.startsWith('HelpOverlay-') && f.endsWith('.mjs'));
assert.ok(helpChunk, `dist/ must emit HelpOverlay-*.mjs chunk, found: ${distFiles.join(', ')}`);
const { featureShortcuts } = await import(pathToFileURL(join(distDir, helpChunk)).href);
assert.equal(typeof featureShortcuts, 'function', `${helpChunk} must export featureShortcuts`);

const wfModalChunk = distFiles.find((f) => f.startsWith('WorkflowHistoryModal-') && f.endsWith('.mjs'));
assert.ok(wfModalChunk, `dist/ must emit WorkflowHistoryModal-*.mjs chunk, found: ${distFiles.join(', ')}`);
for (const chunkName of [audioChunk, tasksChunk, wfModalChunk]) {
  const code = fs.readFileSync(join(distDir, chunkName), 'utf8');
  assert.equal(/\bmarked\b/.test(code), false, `${chunkName} must be marked-free`);
  assert.equal(/\bcli-highlight\b/.test(code), false, `${chunkName} must not bundle cli-highlight`);
  assert.equal(/\bzod\b/.test(code), false, `${chunkName} must not bundle zod`);
  assert.equal(/src\/components\/MarkdownView\.tsx/.test(code), false, `${chunkName} must not bundle MarkdownView`);
}

const PREV_DSH_HOME = process.env.DSH_HOME;
const restoreNetworkGuard = installNoNetworkGuard();
const temps = createTempTracker('studyhub-tui-dom-tasks-audio-');

after(async () => {
  restoreNetworkGuard();
  disposeTerminalPool();
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await temps.cleanup();
});

function resetTuiStore(language = 'zh', asciiMode = false, extra = {}) {
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
    ...extra,
  });
}

function clearStoreToasts() {
  const st = useTuiStore.getState();
  for (const toast of [...st.toasts]) {
    st.dismissToast(toast.id);
  }
}

function safeUnmount(inkInstance) {
  if (!inkInstance) return;
  try {
    inkInstance.unmount();
  } catch {
    // Ignore Ink teardown errors on already-closed streams
  }
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

function todayLocalYmd() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function pollUntil(predicate, { timeoutMs = 8_000, intervalMs = 15, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await predicate();
    if (val) return val;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
}

function buildLongMarkdown() {
  const lines = Array.from(
    { length: 48 },
    (_, i) => `Paragraph ${i + 1} explains an architectural principle and trade-off in distributed systems design.`,
  );
  return `# Distributed Notes\n\n${lines.join('\n\n')}\n`;
}

function buildSampleDoc(tag) {
  const paras = Array.from(
    { length: 8 },
    (_, i) => `Section ${i + 1} (${tag}): Distributed consensus relies on quorum overlap and monotonic term numbers.`,
  );
  return `# Notes ${tag}\n\n${paras.join('\n\n')}\n`;
}

function createControllableTranslationStub() {
  let heldFirst = true;
  let holdAfterResume = false;
  let releaseFirstFn = null;
  let resolveFirstEntered = null;
  const firstEntered = new Promise((resolve) => {
    resolveFirstEntered = resolve;
  });
  let callCount = 0;
  const waiters = [];

  const complete = async (_system, prompt, execution = {}) => {
    const p = String(prompt || '');
    if (p.includes('OK?')) return 'OK';
    execution.signal?.throwIfAborted?.();
    let parsed = null;
    try {
      parsed = JSON.parse(p);
    } catch {
      return JSON.stringify({ cards: [] });
    }
    if (!Array.isArray(parsed?.passages)) {
      return JSON.stringify({ ok: true });
    }
    callCount += 1;
    if (callCount === 1) {
      resolveFirstEntered?.();
      if (heldFirst) {
        await new Promise((resolve) => {
          releaseFirstFn = resolve;
          execution.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      }
    } else if (holdAfterResume) {
      await new Promise((resolve) => {
        waiters.push(resolve);
        execution.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    }
    execution.signal?.throwIfAborted?.();
    return JSON.stringify({
      translations: parsed.passages.map((passage) => ({
        id: passage.id,
        text: `译文(${passage.id})`,
      })),
    });
  };

  return {
    complete,
    getCallCount: () => callCount,
    waitForFirstCall: () => firstEntered,
    releaseFirst: () => {
      heldFirst = false;
      releaseFirstFn?.();
      releaseFirstFn = null;
    },
    setHoldAfterResume: (v) => {
      holdAfterResume = v;
    },
    releaseAll: () => {
      heldFirst = false;
      holdAfterResume = false;
      releaseFirstFn?.();
      releaseFirstFn = null;
      while (waiters.length > 0) waiters.shift()?.();
    },
  };
}

function createDeferredStub() {
  const entered = [];
  const gates = [];
  const countWaiters = [];

  const notifyWaiters = () => {
    for (let i = countWaiters.length - 1; i >= 0; i -= 1) {
      const w = countWaiters[i];
      if (entered.length >= w.target) {
        countWaiters.splice(i, 1);
        w.resolve();
      }
    }
  };

  const complete = async (_system, prompt, execution = {}) => {
    const p = String(prompt || '');
    if (p.includes('OK?')) return 'OK';
    execution.signal?.throwIfAborted?.();
    let parsed = null;
    try {
      parsed = JSON.parse(p);
    } catch {
      return JSON.stringify({ cards: [] });
    }
    if (!Array.isArray(parsed?.passages)) {
      return JSON.stringify({ ok: true });
    }
    const idx = entered.length + 1;
    let resolveGate = null;
    const gate = new Promise((resolve) => {
      resolveGate = resolve;
      execution.signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    gates.push(resolveGate);
    entered.push({ idx, jobId: execution.jobId });
    notifyWaiters();
    await gate;
    execution.signal?.throwIfAborted?.();
    return JSON.stringify({
      translations: parsed.passages.map((passage) => ({
        id: passage.id,
        text: `译文(${passage.id})`,
      })),
    });
  };

  return {
    complete,
    getEnteredCount: () => entered.length,
    getEntered: () => [...entered],
    waitForEntered: (target, timeoutMs = 8_000) => {
      if (entered.length >= target) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const entry = {
          target,
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
        };
        const timer = setTimeout(() => {
          const idx = countWaiters.indexOf(entry);
          if (idx >= 0) countWaiters.splice(idx, 1);
          reject(new Error(`Timed out waiting for deferred stub entered >= ${target}`));
        }, timeoutMs);
        countWaiters.push(entry);
      });
    },
    releaseAll: () => {
      while (gates.length > 0) gates.shift()?.();
    },
  };
}

function createMockJobsHost(innerHost, initialJobs, { zhNote = true, parallelEnabled = false } = {}) {
  const jobs = initialJobs.map((j) => structuredClone(j));
  const parallelCalls = [];

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

  const wrappedHost = {
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
      if (parallelEnabled && action === 'job.parallel') {
        parallelCalls.push({ jobId: args?.jobId });
        const target = jobs.find((j) => j.id === args?.jobId || j.contract?.jobId === args?.jobId);
        if (!target) {
          return { ok: false, error: { code: 'NOT_FOUND', message: `Study job not found: ${args?.jobId}` } };
        }
        if (target.status !== 'queued') {
          return {
            ok: false,
            error: {
              code: 'job-ended',
              message: zhNote
                ? '这个任务已经结束，不能再要求并行。'
                : 'This job has already ended and cannot be started in parallel.',
            },
          };
        }
        target.status = 'running';
        target.phase = zhNote ? '并行执行中' : 'Running in parallel';
        if (target.contract) {
          target.contract.status = 'running';
          target.contract.actions = {
            ...target.contract.actions,
            parallel: { available: false, reason: { code: 'already-parallel' } },
          };
        }
        return {
          ok: true,
          value: {
            jobId: target.id,
            attemptId: target.id,
            action: 'parallel',
            parallel: true,
            status: 'running',
            ...(zhNote ? { note: '已要求并行：这个任务现在就开始，不再等前面的任务。' } : {}),
          },
        };
      }
      return innerHost.call(action, args);
    },
  };

  return {
    host: wrappedHost,
    parallelCalls,
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

describe('Domain Tasks & Audio: AudioView, TasksView Jobs Control/Recovery/Parallel/Filter/Export & WorkflowContext', () => {
  // ── Section 1: Round 38 AudioView Diagnostics, Preflight, Usage, Retry & Subtitle Import ──
  test('1.1) Audio host RPC (0 model calls): audio.preflight, audio.usage, audio.retry refusal & audio.subtitles.import refusals', async () => {
    const base = await temps.make('r38-host');
    const dshHome = join(base, 'dsh-home');
    const libraryRoot = join(base, 'library');
    await mkdir(libraryRoot, { recursive: true });
    process.env.DSH_HOME = dshHome;

    let aiCalls = 0;
    const host = await createTuiHost({
      libraryRoot,
      env: { DSH_HOME: dshHome },
      home: base,
      documentsDir: base,
      injectedComplete: async () => {
        aiCalls += 1;
        throw new Error('Unexpected LLM call during audio diagnostics/refusal checks');
      },
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      // 1a. audio.preflight (default & paidOnly)
      const pre = await host.call('audio.preflight', {});
      assert.equal(pre.ok, true, pre.error?.message);
      assert.equal(typeof pre.value?.providers, 'object');
      assert.ok(pre.value?.providers !== null, 'audio.preflight providers must be non-null');
      assert.equal(typeof pre.value?.transcription, 'boolean');
      assert.equal(typeof pre.value?.text, 'boolean');
      assert.equal(typeof pre.value?.liveLocal?.ready, 'boolean');
      assert.equal(typeof pre.value?.liveLoopback?.ready, 'boolean');

      const prePaid = await host.call('audio.preflight', { paidOnly: true });
      assert.equal(prePaid.ok, true, prePaid.error?.message);
      assert.equal(typeof prePaid.value?.transcription, 'boolean');
      assert.equal(typeof prePaid.value?.text, 'boolean');

      // 1b. audio.usage
      const usage = await host.call('audio.usage', {});
      assert.equal(usage.ok, true, usage.error?.message);
      assert.equal(typeof usage.value?.updatedAt, 'number');
      assert.ok(Array.isArray(usage.value?.providers), 'audio.usage must return providers array');
      assert.ok(usage.value.providers.length >= 4, 'audio.usage must include all 4 tiers');
      assert.ok(Array.isArray(usage.value?.trend), 'audio.usage must return trend array');
      for (const tier of ['free', 'groq', 'paid', 'siliconflow']) {
        assert.ok(
          usage.value.providers.some((p) => p.tier === tier),
          `audio.usage providers missing tier ${tier}`,
        );
      }

      // 1c. audio.retry invalid job refusal
      const retryBad = await host.call('audio.retry', { jobId: 'nonexistent-audio-job-id' });
      assert.equal(retryBad.ok, false, 'audio.retry must refuse unknown/non-retryable jobId');
      assert.ok(retryBad.error?.message, 'audio.retry refusal must include error message');

      const retryEmpty = await host.call('audio.retry', {});
      assert.equal(retryEmpty.ok, false, 'audio.retry must refuse missing jobId');
      assert.ok(retryEmpty.error?.message, 'audio.retry missing jobId refusal must include error message');

      // 1d. audio.subtitles.import unsupported extension, missing text & blank text refusals
      const subBad = await host.call('audio.subtitles.import', {
        filename: 'lecture.mp3',
        text: '1\n00:00:01,000 --> 00:00:02,000\nHello world\n',
      });
      assert.equal(subBad.ok, false, 'audio.subtitles.import must refuse unsupported extension');
      assert.ok(subBad.error?.message, 'audio.subtitles.import refusal must include error message');
      assert.match(String(subBad.error?.message || ''), /不支持的字幕格式|subtitle/i);

      const subBadText = await host.call('audio.subtitles.import', {
        filename: 'lecture.srt',
      });
      assert.equal(subBadText.ok, false, 'audio.subtitles.import must refuse missing text');
      assert.ok(subBadText.error?.message, 'audio.subtitles.import missing text must include error message');

      const subBlankText = await host.call('audio.subtitles.import', {
        filename: 'lecture.vtt',
        text: '   \n  ',
      });
      assert.equal(subBlankText.ok, false, 'audio.subtitles.import must refuse blank subtitle text');
      assert.ok(subBlankText.error?.message, 'audio.subtitles.import blank text must include error message');
      assert.equal(aiCalls, 0, 'Audio diagnostics and validation refusals must trigger 0 LLM calls');
    } finally {
      await host.dispose();
    }
  });

  test('1.2) AudioView PTY E2E: diagnostics, [p] preflight, [R] retry guard, [u] subtitle modal + Esc, and 80x24 resize', async () => {
    const base = await temps.make('r38-pty');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');
    await mkdir(libraryRoot, { recursive: true });

    await saveTuiPreferences({ language: 'en', asciiMode: false }, { env });
    resetTuiStore('en', false, { loading: true });

    let aiCalls = 0;
    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      injectedComplete: async () => {
        aiCalls += 1;
        throw new Error('AudioView diagnostics/modal flow must trigger 0 LLM calls');
      },
      skipAutoProbe: true,
      language: 'en',
    });
    const sampleRes = await host.call('sample.load', { language: 'en' });
    assert.equal(sampleRes.ok, true, sampleRes.error?.message);

    const tty = createVirtualTty(120, 36);
    let inkInstance = null;
    try {
      inkInstance = render(
        React.createElement(StudyHubTuiApp, {
          host,
          initialPage: 'audio',
          initialLanguage: 'en',
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

      const wideScreen = await tty.waitFor(
        (s) =>
          s.includes('Audio Transcription') &&
          s.includes('Diagnostics & Quota') &&
          s.includes('Preflight:') &&
          s.includes('Today:'),
        { label: 'AudioView Diagnostics & Quota rendered at 120x36' },
      );
      tty.assertHealthyScreen(wideScreen, 120, 36, 'AudioView 120x36 default');
      assert.equal(useTuiStore.getState().page, 'audio');
      assert.equal(aiCalls, 0);

      // Press [p] to run on-demand audio.preflight and verify toast
      useTuiStore.setState({ toasts: [] });
      tty.send('p');
      await tty.waitFor(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('Preflight:')),
        { label: '[p] preflight summary toast' },
      );
      assert.ok(useTuiStore.getState().toasts.some((toast) => toast.text.includes('Preflight:')));

      // Press [R] when no failed audio job is selected -> friendly warning toast
      useTuiStore.setState({ toasts: [] });
      tty.send('R');
      await tty.waitFor(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('No failed or canceled audio job selected')),
        { label: '[R] friendly toast when no failed audio job selected' },
      );
      assert.ok(
        useTuiStore.getState().toasts.some((toast) => toast.text.includes('No failed or canceled audio job selected')),
      );

      // Open subtitle import modal via [u], verify render, then cancel with Esc
      tty.send('u');
      const modalScreen = await tty.waitFor(
        (s) => s.includes('Import Subtitle File') && s.includes('.srt / .vtt / .txt'),
        { label: 'Subtitle import modal opened via [u]' },
      );
      tty.assertHealthyScreen(modalScreen, 120, 36, 'AudioView subtitle modal 120x36');
      assert.equal(useTuiStore.getState().inputCaptured, true, 'Modal must capture input');

      tty.send('\x1b');
      const closedScreen = await tty.waitFor(
        (s) => !s.includes('Import Subtitle File') && useTuiStore.getState().inputCaptured === false,
        { label: 'Subtitle import modal cancelled via Esc' },
      );
      tty.assertHealthyScreen(closedScreen, 120, 36, 'AudioView after Esc close');
      assert.equal(useTuiStore.getState().inputCaptured, false);

      // Resize to 80x24 in default mode and verify clean rendering
      tty.resize(80, 24);
      const narrowDefault = await tty.waitFor(
        (s) =>
          s.includes('Diagnostics & Quota') &&
          s.includes('Preflight:') &&
          s.split('\n').length <= 24,
        { label: 'AudioView 80x24 default mode' },
      );
      tty.assertHealthyScreen(narrowDefault, 80, 24, 'AudioView 80x24 default');
      assert.equal(aiCalls, 0, 'AudioView diagnostics & subtitle modal cancel must make 0 LLM calls');
    } finally {
      safeUnmount(inkInstance);
      await tty.flush();
      tty.dispose();
      await host.dispose();
    }
  });

  // ── Section 2: Round 51 AudioView Transcript Corrections Review (P2 ConfirmDialog) ──
  test('2.1) countPendingCorrections unit logic & audio.corrections.review 0-pending refusal (0 model calls)', async () => {
    assert.deepEqual(countPendingCorrections(null), { pending: 0, applied: 0, items: [] });
    assert.deepEqual(countPendingCorrections(undefined), { pending: 0, applied: 0, items: [] });
    assert.deepEqual(countPendingCorrections({ id: 'plain-1' }), { pending: 0, applied: 0, items: [] });
    assert.deepEqual(
      countPendingCorrections({ id: 'empty-1', audio: { corrections: { applied: [], skipped: [] } } }),
      { pending: 0, applied: 0, items: [] },
    );

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

    const countOnlySummary = countPendingCorrections({
      id: 'talk-u2',
      audio: {
        corrections: {
          appliedCount: 3,
          skipped: [
            null,
            { wrong: 'eigenvectorr', right: 'eigenvector', skipped: 'low-confidence' },
            { wrong: 'accepted', right: 'accept', skipped: 'low-confidence', review: { verdict: 'accept' } },
            { wrong: 'other-reason', right: 'other', skipped: 'already-applied' },
          ],
        },
      },
    });
    assert.equal(countOnlySummary.applied, 3);
    assert.equal(countOnlySummary.pending, 1);
    assert.deepEqual(countOnlySummary.items, [{ wrong: 'eigenvectorr', right: 'eigenvector' }]);

    const fallbackMiss = countPendingCorrections(
      {
        id: 'res-miss',
        sourceId: 'missing-src',
        audio: {
          corrections: {
            applied: [],
            skipped: [{ wrong: 'markov', right: 'Markov', skipped: 'low-confidence' }],
          },
        },
      },
      [{ id: 'other-src', audio: { corrections: { applied: [], skipped: [] } } }],
    );
    assert.equal(fallbackMiss.applied, 0);
    assert.equal(fallbackMiss.pending, 1);
    assert.equal(fallbackMiss.items[0].right, 'Markov');

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

    // Host integration: 0 pending corrections & unknown sourceId return normalized error with 0 model calls
    const base = await temps.make('r51-host');
    const dshHome = join(base, 'dsh-home');
    const libraryRoot = join(base, 'library');
    await mkdir(libraryRoot, { recursive: true });
    process.env.DSH_HOME = dshHome;

    await seedAudioTranscripts(libraryRoot, [
      {
        id: 'talk-zero',
        title: 'Lecture Zero Pending',
        text: 'This lecture transcript already has all corrections reviewed.',
        courses: ['CS101'],
        audio: {
          sourceIds: ['talk-zero'],
          corrections: {
            applied: [{ wrong: 'neural net', right: 'neural network', context: 'A neural net.' }],
            appliedCount: 1,
            skipped: [
              {
                wrong: 'layer norm',
                right: 'LayerNorm',
                context: 'Use layer norm here.',
                skipped: 'low-confidence',
                review: { at: '2026-11-22T00:00:00.000Z', verdict: 'reject', reason: 'Original is fine' },
              },
            ],
            skippedCount: 1,
          },
        },
      },
    ]);

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

      const unknownRes = await host.call('audio.corrections.review', { sourceId: 'nonexistent-talk' });
      assert.equal(unknownRes.ok, false, 'audio.corrections.review must fail for unknown sourceId');
      assert.ok(unknownRes.error?.message, 'unknown sourceId refusal must include error message');

      const emptyArgRes = await host.call('audio.corrections.review', {});
      assert.equal(emptyArgRes.ok, false, 'audio.corrections.review must fail for missing sourceId');
      assert.ok(emptyArgRes.error?.message, 'missing sourceId refusal must include error message');
      assert.equal(aiCalls, 0, 'audio.corrections.review with 0 pending must make 0 model calls');
    } finally {
      await host.dispose();
    }
  });

  test('2.2) AudioView PTY E2E (120x36 & 80x24 zh): pending badge/samples, [c] P2 ConfirmDialog, [n]/Esc cancel with 0 model calls', async () => {
    const base = await temps.make('r51-pty');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');
    await mkdir(libraryRoot, { recursive: true });

    await seedAudioTranscripts(libraryRoot, [
      {
        id: 'talk-review',
        title: 'ML Lecture 04',
        text: 'Gradient decent updates weights. Back prop computes gradients efficiently.',
        courses: ['CS101'],
        audio: {
          sourceIds: ['talk-review'],
          corrections: {
            applied: [{ wrong: 'hyper param', right: 'hyperparameter', context: 'Tune hyper param.' }],
            appliedCount: 1,
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
            skippedCount: 2,
          },
        },
      },
    ]);

    let aiCalls = 0;
    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
    resetTuiStore('zh', false, { loading: true });

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      injectedComplete: async () => {
        aiCalls += 1;
        return '{"decisions":[]}';
      },
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

      // Re-open with [c] and cancel via Esc -> 0 model calls
      tty.send('c');
      await tty.waitFor(
        (s) => s.includes('AI 复核转写存疑处') && useTuiStore.getState().inputCaptured === true,
        { label: 'ConfirmDialog re-opened via [c]' },
      );
      tty.send('\x1b');
      await tty.waitFor(
        (s) => !s.includes('AI 复核转写存疑处') && useTuiStore.getState().inputCaptured === false,
        { label: 'ConfirmDialog cancelled via Esc' },
      );
      assert.equal(aiCalls, 0, 'Cancelling ConfirmDialog with Esc must make 0 model calls');

      // Resize to 80x24 default zh and verify clean rendering
      tty.resize(80, 24);
      const zhNarrow = await tty.waitFor(
        (s) =>
          s.includes('已完成转写稿') &&
          s.includes('ML Lecture 04') &&
          s.split('\n').length <= 24,
        { label: 'AudioView zh 80x24' },
      );
      tty.assertHealthyScreen(zhNarrow, 80, 24, 'AudioView zh 80x24');
      assert.equal(aiCalls, 0);
    } finally {
      safeUnmount(inkInstance);
      await tty.flush();
      tty.dispose();
      await host.dispose();
    }
  });

  // ── Section 3: Round 67 AudioView [/] Live Filter & [x] Atomic Markdown Export ──
  test('3.1) Unit: formatAudioTranscriptMarkdown handles zh/en, [MM:SS] segments, plain fallback & pending corrections', () => {
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

    const mdZh = formatAudioTranscriptMarkdown({
      result: segmentedResult,
      detail: segmentedDetail,
      lang: 'zh',
      generatedAt: '2026-11-22 21:30',
    });
    assert.match(mdZh, /^# Operating Systems Week 3/m);
    assert.match(mdZh, /- 导出时间: 2026-11-22 21:30/);
    assert.match(mdZh, /- 创建时间: 2026-11-20T10:00:00Z/);
    assert.match(mdZh, /- 课程: CS301/);
    assert.match(mdZh, /- 文件: os-week3\.m4a/);
    assert.match(mdZh, /- 时长: 02:05/);
    assert.match(mdZh, /- 转写服务: siliconflow/);
    assert.match(mdZh, /- 语言: zh-CN/);
    assert.match(mdZh, /- ID: `aud-seg-1`/);
    assert.match(mdZh, /## 转写正文/);
    assert.match(mdZh, /\[00:00\] Prof: Welcome to virtual memory\./);
    assert.match(mdZh, /\[01:05\] Page tables map virtual pages to physical frames\./);
    assert.match(mdZh, /## 待复核存疑处 \(1\)/);
    assert.match(mdZh, /\*\*page faulted\*\* -> \*\*page fault\*\* \(术语拼写\) -- "A page faulted occurs on miss\."/);
    assert.ok(!mdZh.includes('resolved-term'), 'already-reviewed correction must not be listed as pending');

    const mdEnPlain = formatAudioTranscriptMarkdown({
      result: {
        id: 'aud-plain-2',
        title: 'Linear Algebra Recap',
        course: 'MATH202',
        transcript: 'Eigenvalues satisfy det(A - lambda I) = 0.',
        durationSec: 42,
        provider: 'groq',
        language: 'en',
        createdAt: '2026-11-21T08:00:00Z',
      },
      detail: null,
      lang: 'en',
      generatedAt: '2026-11-22 21:35',
    });
    assert.match(mdEnPlain, /^# Linear Algebra Recap/m);
    assert.match(mdEnPlain, /- Exported: 2026-11-22 21:35/);
    assert.match(mdEnPlain, /- Created: 2026-11-21T08:00:00Z/);
    assert.match(mdEnPlain, /- Course: MATH202/);
    assert.match(mdEnPlain, /- Duration: 00:42/);
    assert.match(mdEnPlain, /- Provider: groq/);
    assert.match(mdEnPlain, /- Language: en/);
    assert.match(mdEnPlain, /- ID: `aud-plain-2`/);
    assert.match(mdEnPlain, /## Transcript/);
    assert.match(mdEnPlain, /Eigenvalues satisfy det\(A - lambda I\) = 0\./);
    assert.ok(!mdEnPlain.includes('Pending Uncertain Corrections'));

    // Edge cases: zh plain fallback from detail.text, nested audio.* metadata, bilingual segment & empty transcript
    const mdZhMinimal = formatAudioTranscriptMarkdown({
      result: {
        id: 'aud-min-3',
        title: 'Minimal Audio',
        audio: { fileName: 'nested.wav', durationSec: 9, provider: 'free', language: 'en' },
      },
      detail: { id: 'aud-min-3', text: 'Fallback detail text content.', segments: [] },
      lang: 'zh',
      generatedAt: '2026-11-22 22:00',
    });
    assert.match(mdZhMinimal, /^# Minimal Audio/m);
    assert.match(mdZhMinimal, /- 文件: nested\.wav/);
    assert.match(mdZhMinimal, /- 时长: 00:09/);
    assert.match(mdZhMinimal, /- 转写服务: free/);
    assert.match(mdZhMinimal, /- 语言: en/);
    assert.match(mdZhMinimal, /## 转写正文/);
    assert.match(mdZhMinimal, /Fallback detail text content\./);
    assert.ok(!mdZhMinimal.includes('待复核存疑处'));

    const mdBilingualEmpty = formatAudioTranscriptMarkdown({
      result: {
        id: 'aud-bi-4',
        title: 'Bilingual Lecture',
        segments: [{ timestamp: '[02:10]', en: 'Consensus', zh: '共识' }],
      },
      detail: null,
      lang: 'en',
      generatedAt: '2026-11-22 22:05',
    });
    assert.match(mdBilingualEmpty, /\[02:10\] Consensus \/ 共识/);

    const mdEmptyBodyZh = formatAudioTranscriptMarkdown({
      result: { id: 'aud-empty-5' },
      detail: null,
      lang: 'zh',
      generatedAt: '2026-11-22 22:10',
    });
    assert.match(mdEmptyBodyZh, /^# aud-empty-5/m);
    assert.match(mdEmptyBodyZh, /（暂无转写正文）/);

    const mdEmptyBodyEn = formatAudioTranscriptMarkdown({
      result: { id: 'aud-empty-6', title: 'Empty En' },
      detail: null,
      lang: 'en',
      generatedAt: '2026-11-22 22:15',
    });
    assert.match(mdEmptyBodyEn, /\(Empty transcript\)/);
  });

  test('3.2) AudioView PTY E2E (120x36 zh): [a] nav, [/] live filter + Enter, [x] atomic MD export, Esc clear & 0/2 empty guard (0 model calls)', async () => {
    const base = await temps.make('r67-zh');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
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
        format: 'audio',
        courses: ['CS302'],
        durationSec: 90,
        provider: 'groq',
        language: 'en',
        text: 'Two-phase locking guarantees conflict serializability.',
      },
    ]);

    let aiCalls = 0;
    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
    resetTuiStore('zh', false);

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
      const hintKeys = useTuiStore.getState().footerHints.map((h) => h.key);
      assert.ok(hintKeys.includes('/') && hintKeys.includes('x'), `AudioView footerHints must include / and x: ${hintKeys.join(',')}`);
      assert.equal(aiCalls, 0);

      // Press '/' to open live filter bar and filter by transcript snippet
      tty.send('/');
      await tty.waitFor(
        (s) => s.includes('[筛选 2/2]') && useTuiStore.getState().inputCaptured === true,
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
        (s) => s.includes('[已筛选 1/2]') && useTuiStore.getState().inputCaptured === false,
        { label: 'Filter confirmed via Enter' },
      );
      tty.assertHealthyScreen(filteredApplied, 120, 36, 'AudioView filter applied zh');

      // Press 'x' to export selected audio transcript atomically (0 model calls)
      useTuiStore.setState({ toasts: [] });
      tty.send('x');
      const audioBackupsDir = join(resolve(libraryRoot), 'backups');
      await tty.waitFor(
        () =>
          useTuiStore
            .getState()
            .toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已导出逐字稿')),
        { label: '[x] export success toast zh' },
      );

      const audioExport = await findExportedBackupFile(audioBackupsDir, 'studyhub-audio', 'md', todayLocalYmd());
      assert.ok(audioExport, `expected studyhub-audio-${todayLocalYmd()}-HHmmss.md in ${audioBackupsDir}`);
      const exported = await readFile(audioExport.path, 'utf8');
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

      // Re-filter to 0/2 -> verify no-selection guard on [x]
      tty.send('/');
      await tty.waitFor(
        (s) => s.includes('[筛选 2/2]') && useTuiStore.getState().inputCaptured === true,
        { label: 'Re-open filter bar zh' },
      );
      tty.send('zzz-no-match');
      await tty.waitFor((s) => s.includes('[筛选 0/2]'), { label: '0/2 filter state zh' });
      tty.send('\r');
      await tty.waitFor(
        (s) => s.includes('[已筛选 0/2]') && useTuiStore.getState().inputCaptured === false,
        { label: '0/2 applied state zh' },
      );
      useTuiStore.setState({ toasts: [] });
      tty.send('x');
      await tty.waitFor(
        () =>
          useTuiStore
            .getState()
            .toasts.some((toast) => toast.tone === 'info' && toast.text.includes('请先选择一条音频转写记录')),
        { label: '[x] empty-selection info toast zh' },
      );
      assert.equal(aiCalls, 0);
    } finally {
      safeUnmount(inkInstance);
      await tty.flush();
      tty.dispose();
      await host.dispose();
    }
  });

  // ── Section 4: Round 43 TasksView Job Queue Control ([p]: pause/resume, +/-: concurrency) ──
  test('4.1) Tasks host integration: job.control pause -> resume -> set { concurrency } -> invalid patch errors -> restore -> cancel', async () => {
    const base = await temps.make('r43-host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');
    const stub = createControllableTranslationStub();

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      injectedComplete: stub.complete,
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      const imp = await host.call('materials.document.import', {
        filename: 'notes.md',
        dataBase64: Buffer.from(buildLongMarkdown()).toString('base64'),
      });
      assert.equal(imp.ok, true, imp.error?.message);
      const documentId = imp.value.documentId;
      const sourceId = imp.value.document.sources[0].id;

      const started = await host.call('generation.translation.start', {
        documentId,
        scope: { sourceIds: [sourceId] },
        target: 'zh',
        concurrency: 1,
      });
      assert.equal(started.ok, true, started.error?.message);
      const jobId = started.value.jobId;
      assert.ok(jobId, 'translation jobId must be returned');

      await stub.waitForFirstCall();

      const snapInit = await host.call('snapshot', {});
      assert.equal(snapInit.ok, true);
      const jobRow = (snapInit.value.jobs || []).find((j) => j.id === jobId || j.contract?.jobId === jobId);
      assert.ok(jobRow, 'running translation job must appear in snapshot');
      assert.equal(jobRow.contract?.actions?.pause?.available, true);
      assert.equal(jobRow.contract?.actions?.set?.available, true);
      const concSetting = (jobRow.contract?.actions?.set?.settings || []).find((s) => s.key === 'concurrency');
      assert.ok(concSetting, 'concurrency setting must be exposed in contract');
      assert.equal(concSetting.value, 1);
      assert.equal(concSetting.min, 1);
      assert.equal(concSetting.max, 3);

      // Pause while wave 1 is in flight -> pausing, then release wave 1 -> paused
      const pauseRes = await host.call('job.control', { jobId, action: 'pause' });
      assert.equal(pauseRes.ok, true, pauseRes.error?.message);
      assert.equal(pauseRes.value.jobId, jobId);
      assert.equal(pauseRes.value.action, 'pause');
      assert.equal(pauseRes.value.applied?.paused, true);

      stub.releaseFirst();
      const pausedRow = await pollUntil(
        async () => {
          const s = await host.call('snapshot', {});
          const row = (s.value?.jobs || []).find((j) => j.id === jobId || j.contract?.jobId === jobId);
          return row?.contract?.status === 'paused' ? row : null;
        },
        { label: 'job to reach paused checkpoint' },
      );
      assert.equal(pausedRow.contract.actions.resume.available, true);

      // Resume -> hold subsequent wave so job stays running while we test set + invalid patches
      stub.setHoldAfterResume(true);
      const resumeRes = await host.call('job.control', { jobId, action: 'resume' });
      assert.equal(resumeRes.ok, true, resumeRes.error?.message);
      assert.equal(resumeRes.value.jobId, jobId);
      assert.equal(resumeRes.value.action, 'resume');
      assert.equal(resumeRes.value.applied?.paused, false);

      const resumedRow = await pollUntil(
        async () => {
          const s = await host.call('snapshot', {});
          const row = (s.value?.jobs || []).find((j) => j.id === jobId || j.contract?.jobId === jobId);
          return row?.contract?.status === 'running' ? row : null;
        },
        { label: 'job to resume running' },
      );
      assert.equal(resumedRow.contract.actions.pause.available, true);

      // Set concurrency -> 3
      const setRes = await host.call('job.control', {
        jobId,
        action: 'set',
        patch: { concurrency: 3 },
      });
      assert.equal(setRes.ok, true, setRes.error?.message);
      assert.equal(setRes.value.jobId, jobId);
      assert.equal(setRes.value.action, 'set');
      assert.deepEqual(setRes.value.applied, { concurrency: 3 });
      assert.equal(setRes.value.values?.concurrency, 3);

      // Invalid patch & unknown jobId errors
      const unknownControl = await host.call('job.control', {
        jobId: 'unknown-job-control-id',
        action: 'pause',
      });
      assert.equal(unknownControl.ok, false, 'job.control on unknown jobId must fail');
      assert.ok(unknownControl.error?.message, 'job.control unknown jobId must include error message');

      const outOfBounds = await host.call('job.control', {
        jobId,
        action: 'set',
        patch: { concurrency: 99 },
      });
      assert.equal(outOfBounds.ok, false, 'out-of-bounds concurrency must fail');
      assert.match(outOfBounds.error?.message ?? '', /concurrency/i);

      const pausedInSet = await host.call('job.control', {
        jobId,
        action: 'set',
        patch: { paused: true },
      });
      assert.equal(pausedInSet.ok, false, 'paused inside set patch must fail');
      assert.equal(pausedInSet.error?.code, 'unknown-setting');

      const missingPatch = await host.call('job.control', {
        jobId,
        action: 'set',
      });
      assert.equal(missingPatch.ok, false, 'missing patch must fail');

      // Restore concurrency -> 2
      const restoreRes = await host.call('job.control', {
        jobId,
        action: 'set',
        patch: { concurrency: 2 },
      });
      assert.equal(restoreRes.ok, true, restoreRes.error?.message);
      assert.equal(restoreRes.value.action, 'set');
      assert.equal(restoreRes.value.values?.concurrency, 2);

      const snapAfter = await host.call('snapshot', {});
      const rowAfter = (snapAfter.value.jobs || []).find((j) => j.id === jobId || j.contract?.jobId === jobId);
      const settingAfter = (rowAfter?.contract?.actions?.set?.settings || []).find((s) => s.key === 'concurrency');
      assert.equal(settingAfter?.value, 2);

      const cancelRes = await host.call('job.control', { jobId, action: 'cancel' });
      assert.equal(cancelRes.ok, true, cancelRes.error?.message);
      stub.releaseAll();
      const canceledRow = await pollUntil(
        async () => {
          const s = await host.call('snapshot', {});
          const row = (s.value?.jobs || []).find((j) => j.id === jobId || j.contract?.jobId === jobId);
          return row && row.status !== 'running' ? row : null;
        },
        { label: 'job to leave running after cancel' },
      );
      assert.notEqual(canceledRow.status, 'running');
    } finally {
      stub.releaseAll();
      await host.dispose();
    }
  });

  test('4.2) TasksView PTY E2E (120x36 & 80x24 zh): [p] pause/resume & [+]/[-] concurrency min/max bounds', async () => {
    const base = await temps.make('r43-pty');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');
    const stub = createControllableTranslationStub();

    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
    resetTuiStore('zh', false, { loading: true });
    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      injectedComplete: stub.complete,
      skipAutoProbe: true,
      language: 'zh',
    });

    const imp = await host.call('materials.document.import', {
      filename: 'notes-zh.md',
      dataBase64: Buffer.from(buildLongMarkdown()).toString('base64'),
    });
    assert.equal(imp.ok, true, imp.error?.message);

    const started = await host.call('generation.translation.start', {
      documentId: imp.value.documentId,
      scope: { sourceIds: [imp.value.document.sources[0].id] },
      target: 'zh',
      concurrency: 1,
    });
    assert.equal(started.ok, true, started.error?.message);
    const jobId = started.value.jobId;
    await stub.waitForFirstCall();

    const tty = createVirtualTty(120, 36);
    let inkInstance = null;
    try {
      inkInstance = render(React.createElement(StudyHubTuiApp, { host, asciiMode: false }), {
        stdin: tty.stdin,
        stdout: tty.stdout,
        stderr: tty.stderr,
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await tty.firstFramePromise;
      await tty.waitFor((s) => s.includes('学习库') || s.includes('Library'), { label: 'Initial render' });

      tty.send('t');
      const activeScreen = await tty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'tasks' &&
          s.includes('后台任务') &&
          s.includes('活跃') &&
          s.includes('1x'),
        { label: 'TasksView active job with 活跃 pill and 1x badge' },
      );
      tty.assertHealthyScreen(activeScreen, 120, 36, 'TasksView zh active 120x36');
      assert.equal(useTuiStore.getState().page, 'tasks');

      // Press 'p' to pause while wave 1 is in flight, then release wave 1 so it reaches paused
      tty.send('p');
      await tty.waitFor(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('已暂停任务队列')),
        { label: 'Pause toast in zh' },
      );
      stub.releaseFirst();

      const pausedWide = await tty.waitFor(
        (s) => s.includes('已暂停') && s.includes('1x'),
        { label: 'TasksView paused state at 120x36' },
      );
      tty.assertHealthyScreen(pausedWide, 120, 36, 'TasksView zh paused 120x36');

      // Resize to 80x24 while paused
      tty.resize(80, 24);
      const pausedNarrow = await tty.waitFor(
        (s) => s.includes('已暂停') && s.includes('1x') && s.split('\n').length <= 24,
        { label: 'TasksView paused state at 80x24' },
      );
      tty.assertHealthyScreen(pausedNarrow, 80, 24, 'TasksView zh paused 80x24');

      // Hold post-resume calls so wave 2 stays running while testing concurrency controls
      stub.setHoldAfterResume(true);

      // Press 'p' to resume at 80x24
      tty.send('p');
      await tty.waitFor(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('已恢复任务队列')),
        { label: 'Resume toast in zh' },
      );
      await tty.waitFor((s) => s.includes('活跃') && s.includes('1x'), { label: 'Resumed active pill at 80x24' });

      // Resize back to 120x36 and test concurrency 1x -> 2x -> 3x -> max boundary -> 2x -> 1x -> min boundary
      tty.resize(120, 36);
      await tty.waitFor((s) => s.includes('监控后台任务'), { label: 'Restored 120x36' });

      clearStoreToasts();
      tty.send('+');
      await tty.waitFor(
        (s) =>
          s.includes('2x') &&
          useTuiStore.getState().toasts.some((toast) => toast.text.includes('并发数已调整为 2x')),
        { label: 'Concurrency increased to 2x' },
      );
      tty.assertHealthyScreen(tty.readScreen(), 120, 36, 'TasksView zh 2x 120x36');

      clearStoreToasts();
      tty.send('+');
      await tty.waitFor(
        (s) =>
          s.includes('3x') &&
          useTuiStore.getState().toasts.some((toast) => toast.text.includes('并发数已调整为 3x')),
        { label: 'Concurrency increased to 3x' },
      );

      clearStoreToasts();
      tty.send('+');
      await tty.waitFor(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('并发数已达上限 (3x)')),
        { label: 'Max concurrency boundary toast in zh' },
      );

      clearStoreToasts();
      tty.send('-');
      await tty.waitFor(
        (s) =>
          s.includes('2x') &&
          useTuiStore.getState().toasts.some((toast) => toast.text.includes('并发数已调整为 2x')),
        { label: 'Concurrency decreased to 2x' },
      );

      clearStoreToasts();
      tty.send('-');
      await tty.waitFor(
        (s) =>
          s.includes('1x') &&
          useTuiStore.getState().toasts.some((toast) => toast.text.includes('并发数已调整为 1x')),
        { label: 'Concurrency decreased to 1x' },
      );

      clearStoreToasts();
      tty.send('-');
      await tty.waitFor(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('并发数已达下限 (1x)')),
        { label: 'Min concurrency boundary toast in zh' },
      );
      tty.assertHealthyScreen(tty.readScreen(), 120, 36, 'TasksView zh min boundary 120x36');

      await host.call('job.control', { jobId, action: 'cancel' });
      stub.releaseAll();
    } finally {
      stub.releaseAll();
      safeUnmount(inkInstance);
      await tty.flush();
      tty.dispose();
      await host.dispose();
    }
  });

  // ── Section 5: Round 49 TasksView Interrupted Job Recovery ([R]: coverage.recover) ──
  test('5.1) coverage.recover {} returns { recovered: 0 } idempotently with 0 model calls', async () => {
    const base = await temps.make('r49-host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');
    let modelCalls = 0;

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      injectedComplete: async () => {
        modelCalls += 1;
        throw new Error('coverage.recover must not invoke model calls');
      },
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      const first = await host.call('coverage.recover', {});
      assert.equal(first.ok, true, first.error?.message);
      assert.deepEqual(first.value, { recovered: 0 });
      assert.equal(modelCalls, 0);

      const second = await host.call('coverage.recover', {});
      assert.equal(second.ok, true, second.error?.message);
      assert.deepEqual(second.value, { recovered: 0 });
      assert.equal(modelCalls, 0);

      const snap = await host.call('snapshot', {});
      assert.equal(snap.ok, true, snap.error?.message);
      assert.ok(Array.isArray(snap.value?.jobs));
      assert.equal(modelCalls, 0);
    } finally {
      await host.dispose();
    }
  });

  test('5.2) TasksView PTY E2E (120x36 & 80x24 zh): [R] triggers coverage.recover toast cleanly with 0 model calls', async () => {
    const base = await temps.make('r49-pty');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');
    let modelCalls = 0;

    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
    resetTuiStore('zh', false, { loading: true });
    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      injectedComplete: async () => {
        modelCalls += 1;
        throw new Error('0-token recover must not invoke model');
      },
      skipAutoProbe: true,
      language: 'zh',
    });

    const tty = createVirtualTty(120, 36);
    let inkInstance = null;
    try {
      inkInstance = render(React.createElement(StudyHubTuiApp, { host, asciiMode: false, autoLaunchpad: false }), {
        stdin: tty.stdin,
        stdout: tty.stdout,
        stderr: tty.stderr,
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await tty.firstFramePromise;
      await tty.waitFor(
        (s) =>
          !useTuiStore.getState().loading &&
          useTuiStore.getState().snapshot !== null &&
          !useTuiStore.getState().showLaunchpad &&
          (s.includes('学习库') || s.includes('Library')),
        { label: 'Initial zh render' },
      );

      tty.send('t');
      const tasksWide = await tty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'tasks' &&
          !useTuiStore.getState().showLaunchpad &&
          s.includes('后台任务') &&
          s.includes('[R] 恢复'),
        { label: 'TasksView zh 120x36 with [R] hint' },
      );
      tty.assertHealthyScreen(tasksWide, 120, 36, 'TasksView zh 120x36');
      assert.equal(useTuiStore.getState().page, 'tasks');

      clearStoreToasts();
      tty.send('R');
      const toastWide = await tty.waitFor(
        (s) =>
          useTuiStore.getState().toasts.some((toast) => toast.text.includes('当前没有可恢复的中断任务')) &&
          s.includes('当前没有可恢复的中断任务'),
        { label: 'TasksView zh [R] recover toast at 120x36' },
      );
      tty.assertHealthyScreen(toastWide, 120, 36, 'TasksView zh recover toast 120x36');

      clearStoreToasts();
      tty.resize(80, 24);
      const tasksNarrow = await tty.waitFor(
        (s) => s.includes('后台任务') && s.split('\n').length <= 24,
        { label: 'TasksView zh 80x24' },
      );
      tty.assertHealthyScreen(tasksNarrow, 80, 24, 'TasksView zh 80x24');

      tty.send('R');
      const toastNarrow = await tty.waitFor(
        (s) =>
          useTuiStore.getState().toasts.some((toast) => toast.text.includes('当前没有可恢复的中断任务')) &&
          s.includes('当前没有可恢复的中断任务'),
        { label: 'TasksView zh [R] recover toast at 80x24' },
      );
      tty.assertHealthyScreen(toastNarrow, 80, 24, 'TasksView zh recover toast 80x24');
      assert.equal(modelCalls, 0);
    } finally {
      safeUnmount(inkInstance);
      await tty.flush();
      tty.dispose();
      await host.dispose();
    }
  });

  // ── Section 6: Round 63 TasksView [P] job.parallel ──
  test('6.1) job.parallel host integration (0 real model calls): unknown/empty error + queued job promotion + running refusal', async () => {
    const base = await temps.make('r63-host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');
    const stub = createDeferredStub();

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      injectedComplete: stub.complete,
      skipAutoProbe: true,
      language: 'zh',
    });

    try {
      const unknownRes = await host.call('job.parallel', { jobId: 'unknown-job-r63' });
      assert.equal(unknownRes.ok, false);
      assert.ok(unknownRes.error?.message && unknownRes.error.message.toLowerCase().includes('not found'));
      assert.equal(stub.getEnteredCount(), 0);

      const emptyRes = await host.call('job.parallel', {});
      assert.equal(emptyRes.ok, false);
      assert.ok(typeof emptyRes.error?.message === 'string' && emptyRes.error.message.length > 0);
      assert.equal(stub.getEnteredCount(), 0);

      const imp1 = await host.call('materials.document.import', {
        filename: 'doc1.md',
        dataBase64: Buffer.from(buildSampleDoc('doc1')).toString('base64'),
      });
      assert.equal(imp1.ok, true, imp1.error?.message);

      const imp2 = await host.call('materials.document.import', {
        filename: 'doc2.md',
        dataBase64: Buffer.from(buildSampleDoc('doc2')).toString('base64'),
      });
      assert.equal(imp2.ok, true, imp2.error?.message);

      const start1 = await host.call('generation.translation.start', {
        documentId: imp1.value.documentId,
        scope: { sourceIds: [imp1.value.document.sources[0].id] },
        target: 'zh',
        concurrency: 1,
      });
      assert.equal(start1.ok, true, start1.error?.message);
      const job1Id = start1.value.jobId;

      await stub.waitForEntered(1);

      const start2 = await host.call('generation.translation.start', {
        documentId: imp2.value.documentId,
        scope: { sourceIds: [imp2.value.document.sources[0].id] },
        target: 'zh',
        concurrency: 1,
      });
      assert.equal(start2.ok, true, start2.error?.message);
      const job2Id = start2.value.jobId;

      const queuedSnap = await pollUntil(
        async () => {
          const s = await host.call('snapshot', {});
          const row = (s.value?.jobs || []).find((j) => j.id === job2Id || j.contract?.jobId === job2Id);
          return row?.status === 'queued' && row?.contract?.actions?.parallel?.available === true ? row : null;
        },
        { label: 'job2 queued with actions.parallel.available=true' },
      );
      assert.equal(queuedSnap.contract.actions.parallel.available, true);
      assert.equal(stub.getEnteredCount(), 1, 'queued job2 must not start before job.parallel');

      // Running job1 must be refused cleanly
      const refuseRunning = await host.call('job.parallel', { jobId: job1Id });
      assert.equal(refuseRunning.ok, false);
      assert.ok(refuseRunning.error?.message && refuseRunning.error.message.includes('已经开始'));

      // Promote queued job2 with real job.parallel
      const promoted = await host.call('job.parallel', { jobId: job2Id });
      assert.equal(promoted.ok, true, promoted.error?.message);
      assert.equal(promoted.value.jobId, job2Id);
      assert.equal(promoted.value.action, 'parallel');
      assert.ok(promoted.value.attemptId, 'job.parallel must return attemptId');
      assert.equal(promoted.value.parallel, true);
      assert.equal(promoted.value.status, 'running');
      assert.ok(typeof promoted.value.note === 'string' && promoted.value.note.includes('并行'));

      await stub.waitForEntered(2);
      const runningSnap = await host.call('snapshot', {});
      assert.equal(runningSnap.ok, true);
      const runningJob2 = (runningSnap.value?.jobs || []).find((j) => j.id === job2Id || j.contract?.jobId === job2Id);
      assert.equal(runningJob2?.status, 'running');

      const c1 = await host.call('job.cancel', { jobId: job1Id });
      const c2 = await host.call('job.cancel', { jobId: job2Id });
      assert.equal(c1.ok, true, c1.error?.message);
      assert.equal(c2.ok, true, c2.error?.message);
      stub.releaseAll();
      await pollUntil(
        async () => {
          const s = await host.call('snapshot', {});
          const active = (s.value?.jobs || []).filter((j) => j.status === 'running' || j.status === 'queued');
          return active.length === 0;
        },
        { label: 'all translation jobs stopped after cancel' },
      );
    } finally {
      stub.releaseAll();
      await host.dispose();
    }
  });

  test('6.2) TasksView PTY E2E (120x36 zh): [P] promotes queued job & warns gracefully on completed job (0 model calls)', async () => {
    const base = await temps.make('r63-pty');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');

    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
    resetTuiStore('zh', false);

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

    const { host, parallelCalls } = createMockJobsHost(
      rawHost,
      [
        {
          id: 'job-done-1',
          title: 'R63 已完成任务',
          type: 'generation',
          status: 'complete',
          progress: 1,
          phase: '已完成',
          startedAt: '2026-11-22T10:00:00.000Z',
          finishedAt: '2026-11-22T10:01:00.000Z',
          calls: [],
          contract: {
            jobId: 'job-done-1',
            status: 'complete',
            actions: { parallel: { available: false, reason: { code: 'job-ended' } } },
          },
        },
        {
          id: 'job-queued-1',
          title: 'R63 排队出题任务',
          type: 'generation',
          status: 'queued',
          progress: 0,
          phase: '排队等待中',
          startedAt: '2026-11-22T10:02:00.000Z',
          calls: [],
          contract: {
            jobId: 'job-queued-1',
            status: 'queued',
            actions: { parallel: { available: true } },
          },
        },
      ],
      { zhNote: true, parallelEnabled: true },
    );

    const tty = createVirtualTty(120, 36);
    let inkInstance = null;
    try {
      inkInstance = render(React.createElement(StudyHubTuiApp, { host, asciiMode: false }), {
        stdin: tty.stdin,
        stdout: tty.stdout,
        stderr: tty.stderr,
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await tty.firstFramePromise;
      await tty.waitFor((s) => s.includes('学习库') || s.includes('Memento'), { label: 'Initial zh render' });

      tty.send('t');
      const tasksScreen = await tty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'tasks' &&
          s.includes('R63 排队出题任务') &&
          s.includes('立即并行'),
        { label: 'TasksView zh with queued job and [P] 立即并行 hint' },
      );
      tty.assertHealthyScreen(tasksScreen, 120, 36, 'TasksView zh queued 120x36');

      // Press 'P' on selected queued job -> invokes job.parallel with exact jobId & renders success toast
      clearStoreToasts();
      tty.send('P');
      const successScreen = await tty.waitFor(
        (s) =>
          parallelCalls.some((c) => c.jobId === 'job-queued-1') &&
          useTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已要求并行')) &&
          s.includes('已要求并行'),
        { label: 'TasksView zh [P] success toast' },
      );
      tty.assertHealthyScreen(successScreen, 120, 36, 'TasksView zh after [P] success');
      assert.ok(parallelCalls.some((c) => c.jobId === 'job-queued-1'));

      // Move selection down ('j') to completed job -> wait for detail pane update -> press 'P' -> graceful warning toast
      clearStoreToasts();
      tty.send('j');
      await tty.waitFor((s) => s.includes('阶段: 已完成'), { label: 'Selection moved to completed job' });
      tty.send('P');
      const warnScreen = await tty.waitFor(
        (s) =>
          parallelCalls.some((c) => c.jobId === 'job-done-1') &&
          useTuiStore.getState().toasts.some((toast) => toast.tone === 'warning' && toast.text.includes('不能再要求并行')) &&
          s.includes('不能再要求并行'),
        { label: 'TasksView zh [P] completed job warning toast' },
      );
      tty.assertHealthyScreen(warnScreen, 120, 36, 'TasksView zh after [P] warning');
      assert.equal(modelCalls, 0);
    } finally {
      safeUnmount(inkInstance);
      await tty.flush();
      tty.dispose();
      await rawHost.dispose();
    }
  });

  // ── Section 7: Round 71 TasksView [/] Live Job Filter & [X] Atomic Markdown Export ──
  test('7.1) Unit: formatTasksMarkdown (zh/en, table columns, pipe escaping, empty state) & HelpOverlay/KEYBINDINGS sync', () => {
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

    const mdZh = formatTasksMarkdown({
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

    const mdEn = formatTasksMarkdown({
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

    const emptyZh = formatTasksMarkdown({
      jobs: [],
      filterTab: 'archived',
      filterQuery: '',
      lang: 'zh',
      generatedAt: '2026-11-22 12:00',
    });
    assert.ok(emptyZh.includes('archived'));
    assert.ok(emptyZh.includes('**任务总数**: 0'));
    assert.ok(emptyZh.includes('当前筛选下暂无任务记录'));

    const emptyEn = formatTasksMarkdown({
      jobs: [],
      filterTab: 'all',
      lang: 'en',
      generatedAt: '2026-11-22 12:00',
    });
    assert.ok(emptyEn.includes('No jobs match the current filter'));

    // Edge cases: missing optional fields, percentage > 1, clamping <0 and >100, Date/epoch timestamps, and filterTab labels
    const minimalMd = formatTasksMarkdown({
      jobs: [
        { id: 'job-min-3', status: 'failed', progress: 75, updatedAt: new Date('invalid') },
        { id: 'job-clamp-lo', title: 'Low Clamp', status: 'queued', progress: -0.2, startedAt: Number.NaN },
        { id: 'job-clamp-hi', title: 'High Clamp', status: 'complete', progress: 150, createdAt: 'custom-ts' },
      ],
      filterTab: 'archived',
      lang: 'en',
      generatedAt: '2026-11-22 13:00',
    });
    assert.ok(minimalMd.includes('Archived (archived)'));
    assert.ok(minimalMd.includes('failed: 1'));
    assert.ok(minimalMd.includes('queued: 1'));
    assert.ok(minimalMd.includes('complete: 1'));
    assert.ok(minimalMd.includes('| 1 | job-min-3 | job | failed | 75% | - | - |'));
    assert.ok(minimalMd.includes('| 2 | Low Clamp | job | queued | 0% | - | - |'));
    assert.ok(minimalMd.includes('| 3 | High Clamp | job | complete | 100% | - | custom-ts |'));

    const zhTabMd = formatTasksMarkdown({
      jobs: [{ id: 'job-epoch-4', title: 'Epoch Job', status: 'running', progress: 0.5, updatedAt: 1700000000000 }],
      filterTab: 'running',
      lang: 'zh',
      generatedAt: '2026-11-22 13:05',
    });
    assert.ok(zhTabMd.includes('运行中 (running)'));
    assert.ok(zhTabMd.includes('50%'));
    assert.ok(!zhTabMd.includes('**筛选关键词**'), 'empty filterQuery must omit filter line');

    const defaultEmptyMd = formatTasksMarkdown({});
    assert.ok(defaultEmptyMd.includes('# StudyHub Background Jobs Summary'));
    assert.ok(defaultEmptyMd.includes('All (all)'));
    assert.ok(defaultEmptyMd.includes('**Total Jobs**: 0'));
    assert.ok(defaultEmptyMd.includes('**Status Breakdown**: None'));

    // Verify HelpOverlay has exactly 15 sections, Round 59/71 entries, and all Tasks & Audio keys + KEYBINDINGS.md sync
    const secEn = featureShortcuts('en');
    const secZh = featureShortcuts('zh');
    assert.equal(secEn.length, 15);
    assert.equal(secZh.length, 15);
    const libSecEn = secEn.find((s) => s.title.includes('Library'));
    const tasksSecEn = secEn.find((s) => s.title.includes('Tasks'));
    const libSecZh = secZh.find((s) => s.title.includes('Library'));
    const tasksSecZh = secZh.find((s) => s.title.includes('Tasks'));
    assert.ok(libSecEn?.items.some((i) => i.key === '/' && i.label === 'Filter decks by keyword'));
    assert.ok(libSecEn?.items.some((i) => i.key === 'g' && i.label === 'AI Guided Study (B/u/Q)'));
    assert.ok(libSecZh?.items.some((i) => i.key === '/' && i.label === '关键词筛选题组'));
    assert.ok(tasksSecEn?.items.some((i) => i.key === 'w / o / m' && i.label === 'Workflows ctx / Output / Msg'));
    assert.ok(tasksSecEn?.items.some((i) => i.key === 'e / D' && i.label === 'Export / Purge Traces'));
    assert.ok(tasksSecEn?.items.some((i) => i.key === 'p' && i.label === 'Pause tasks / Audio preflight'));
    assert.ok(tasksSecEn?.items.some((i) => i.key === 'P' && i.label === 'Promote queued job to parallel'));
    assert.ok(tasksSecEn?.items.some((i) => i.key === '+/-' && i.label === 'Concurrency'));
    assert.ok(tasksSecEn?.items.some((i) => i.key === 'R' && i.label === 'Recover jobs / Retry audio'));
    assert.ok(tasksSecEn?.items.some((i) => i.key === 'u' && i.label === 'Import subtitles'));
    assert.ok(tasksSecEn?.items.some((i) => i.key === 'c' && i.label === 'Review audio corrections'));
    assert.ok(tasksSecEn?.items.some((i) => i.key === '/ / x' && i.label === 'Filter audio / Export transcript MD'));
    assert.ok(tasksSecEn?.items.some((i) => i.key === 't: /  X' && i.label === 'Filter jobs / Export jobs MD'));
    assert.ok(tasksSecZh?.items.some((i) => i.key === 'w / o / m' && i.label === '工作流上下文 / 输出 / 指令'));
    assert.ok(tasksSecZh?.items.some((i) => i.key === 'e / D' && i.label === '导出 / 清空调用轨迹'));
    assert.ok(tasksSecZh?.items.some((i) => i.key === 'p' && i.label === '暂停任务 / 音频自检'));
    assert.ok(tasksSecZh?.items.some((i) => i.key === 'P' && i.label === '排队任务立即并行启动'));
    assert.ok(tasksSecZh?.items.some((i) => i.key === '+/-' && i.label === '并发数'));
    assert.ok(tasksSecZh?.items.some((i) => i.key === 'R' && i.label === '恢复中断任务 / 重试音频'));
    assert.ok(tasksSecZh?.items.some((i) => i.key === 'u' && i.label === '导入字幕'));
    assert.ok(tasksSecZh?.items.some((i) => i.key === 'c' && i.label === '复核音频存疑处'));
    assert.ok(tasksSecZh?.items.some((i) => i.key === '/ / x' && i.label === '筛选音频 / 导出转写 MD'));
    assert.ok(tasksSecZh?.items.some((i) => i.key === 't: /  X' && i.label === '筛选任务 / 导出任务汇总 MD'));

    const keybindingsMd = fs.readFileSync(join(pkgRoot, 'docs/KEYBINDINGS.md'), 'utf8');
    assert.ok(keybindingsMd.includes('filter decks by keyword'));
    assert.ok(keybindingsMd.includes('studyhub-tasks[-<slug>]-YYYY-MM-DD-HHmmss.md'));
    assert.ok(keybindingsMd.includes('workflow.context'));
    assert.ok(keybindingsMd.includes('promote queued job to parallel'));
    assert.ok(keybindingsMd.includes('recover interrupted jobs'));
    assert.ok(keybindingsMd.includes('review transcript corrections (P2-guarded)'));
    assert.ok(keybindingsMd.includes('export transcript Markdown'));
  });

  test('7.2) TasksView PTY E2E (120x36 zh): [/] live filter + [X] atomic export + [Esc] clear + empty filter guard (0 model calls)', async () => {
    const base = await temps.make('r71-pty');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');

    await saveTuiPreferences({ language: 'zh', asciiMode: false });
    resetTuiStore('zh', false);

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

    const { host } = createMockJobsHost(rawHost, [
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
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await tty.firstFramePromise;
      await tty.waitFor((s) => s.includes('学习库') || s.includes('Memento'), { label: 'Initial zh render' });

      tty.send('t');
      await tty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'tasks' &&
          s.includes('R71 分布式共识') &&
          s.includes('R71 操作系统出题'),
        { label: 'TasksView zh with 2 jobs' },
      );

      tty.send('2');
      const allScreen = await tty.waitFor(
        (s) =>
          s.includes('2. 全部 (2)') &&
          useTuiStore.getState().footerHints.some((h) => h.key === '/' && h.label === '筛选') &&
          useTuiStore.getState().footerHints.some((h) => h.key === 'X' && h.label === '导出MD'),
        { label: 'TasksView zh Tab 2 (All)' },
      );
      tty.assertHealthyScreen(allScreen, 120, 36, 'TasksView zh Tab 2 120x36');
      assert.ok(useTuiStore.getState().footerHints.some((h) => h.key === 'X' && h.label === '导出MD'));

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

      clearStoreToasts();
      tty.send('X');
      const tasksBackupsDir = join(libraryRoot, 'backups');
      const exportScreen = await tty.waitFor(
        (s) =>
          useTuiStore
            .getState()
            .toasts.some(
              (toast) =>
                toast.tone === 'success' &&
                toast.text.includes('已导出 1 条任务汇总') &&
                toast.text.includes('studyhub-tasks-'),
            ) &&
          s.includes('已导出 1 条任务汇总'),
        { label: 'TasksView zh [X] export success toast' },
      );
      tty.assertHealthyScreen(exportScreen, 120, 36, 'TasksView zh after [X] export');

      const tasksExport = await findExportedBackupFile(tasksBackupsDir, 'studyhub-tasks', 'md', todayLocalYmd());
      assert.ok(tasksExport, `expected studyhub-tasks-${todayLocalYmd()}-HHmmss.md in ${tasksBackupsDir}`);
      const exportedMd = await readFile(tasksExport.path, 'utf8');
      assert.ok(exportedMd.includes('# StudyHub 后台任务汇总报告'));
      assert.ok(exportedMd.includes('**筛选关键词**: translation'));
      assert.ok(exportedMd.includes('**任务总数**: 1'));
      assert.ok(exportedMd.includes('| # | 标题 | 类型 | 状态 | 进度 | 课程 | 更新/创建时间 |'));
      assert.ok(exportedMd.includes('R71 分布式共识译文任务'));
      assert.ok(!exportedMd.includes('R71 操作系统出题任务'));

      tty.send('\x1b');
      const clearedScreen = await tty.waitFor(
        (s) => !s.includes('[已筛选') && s.includes('R71 操作系统出题') && s.includes('R71 分布式共识'),
        { label: 'Esc clears active filter in normal mode zh' },
      );
      tty.assertHealthyScreen(clearedScreen, 120, 36, 'TasksView zh after Esc clear');

      // Empty filter + 'X' shows friendly info toast
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
          useTuiStore
            .getState()
            .toasts.some((toast) => toast.tone === 'info' && toast.text.includes('当前筛选下暂无可导出的任务记录')),
        { label: 'Empty filter [X] friendly info toast zh' },
      );
      tty.send('\x1b');
      await tty.waitFor((s) => !s.includes('[已筛选') && s.includes('R71 操作系统出题'), { label: 'Esc clears empty filter zh' });

      assert.equal(modelCalls, 0);
    } finally {
      safeUnmount(inkInstance);
      await tty.flush();
      tty.dispose();
      await rawHost.dispose();
    }
  });

  // ── Section 8: Round 59 WorkflowHistoryModal Context Inspector + HelpOverlay Sync ──
  test('8.1) Workflow host integration (0 model calls): workflow.list -> workflow.context & workflow.session.get', async () => {
    const base = await temps.make('r59-host');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
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
      assert.equal(ctxRes.value?.session?.topic, '拉格朗日中值定理专练');
      assert.equal(ctxRes.value?.session?.goal, '掌握中值定理辅助函数构造方法');
      assert.equal(ctxRes.value?.session?.status, 'active');
      assert.equal(ctxRes.value?.session?.course?.name, '高等数学');
      assert.equal(ctxRes.value?.session?.currentStepId, 'step-2');
      assert.equal(ctxRes.value?.session?.records?.['step-1']?.outcome, 'done');
      assert.equal(ctxRes.value?.session?.records?.['step-1']?.output, '确认闭区间连续与开区间可导。');
      assert.ok(Array.isArray(ctxRes.value?.session?.template?.steps) && ctxRes.value.session.template.steps.length === 2);
      assert.equal(ctxRes.value?.resources?.cardCount, 1, 'workflow.context resources must count scoped cards');
      assert.ok(Array.isArray(ctxRes.value?.resources?.scopeDecks) && ctxRes.value.resources.scopeDecks.includes('中值定理题组'));

      const sesRes = await host.call('workflow.session.get', { id: firstWorkflow.id });
      assert.equal(sesRes.ok, true, `workflow.session.get failed: ${sesRes.error?.message}`);
      assert.equal(sesRes.value?.session?.id, sessionId);
      assert.equal(sesRes.value?.session?.template?.id, templateId);
      assert.equal(sesRes.value?.session?.history?.length, 1);
      assert.equal(sesRes.value?.resources?.cardCount, 1);

      const missingSesRes = await host.call('workflow.session.get', { id: 'nonexistent-wf-session' });
      assert.equal(missingSesRes.ok, false, 'workflow.session.get must fail for unknown session id');
      assert.ok(missingSesRes.error?.message, 'workflow.session.get unknown id must include error message');

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

  test('8.2) WorkflowHistoryModal PTY E2E (120x36 zh): TasksView -> w -> c/Enter context -> r refresh -> b/Esc -> ? HelpOverlay', async () => {
    const base = await temps.make('r59-pty-zh');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
    const libraryRoot = join(base, 'library');

    let aiCalls = 0;
    let fetchCalls = 0;
    resetTuiStore('zh', false);
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
      await tty.waitFor((s) => s.includes('中值定理题组') || s.includes('学习库'), {
        timeoutMs: 8_000,
        label: 'LibraryView initial zh',
      });
      tty.send('t');
      const tasksInit = await tty.waitFor(
        (s) => s.includes('监控后台任务') && s.includes('1. 运行中') && !s.includes('正在加载页面'),
        { timeoutMs: 8_000, label: 'TasksView rendered zh' },
      );
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
      safeUnmount(inkInstance);
      await tty.flush();
      tty.dispose();
      await host.dispose();
    }
  });

  test('8.3) WorkflowHistoryModal PTY E2E (80x24 en): empty workflow list -> c opens Global Context -> Esc closes cleanly', async () => {
    const base = await temps.make('r59-pty-empty');
    const env = sanitizedTestEnv({ DSH_HOME: join(base, 'dsh-home') });
    const libraryRoot = join(base, 'library');

    let aiCalls = 0;
    let fetchCalls = 0;
    resetTuiStore('en', true);
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
      assert.equal(fetchCalls, 0);
    } finally {
      safeUnmount(inkInstance);
      await tty.flush();
      tty.dispose();
      await host.dispose();
    }
  });
});
