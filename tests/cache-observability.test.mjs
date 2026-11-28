import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { callTiming, jobTiming, tokensPerSecond } from '../lib/job-timing.js';
import { createModelGateway } from '../lib/jobs/gateway.js';
import { validateRuntimeContract } from '../lib/jobs/contract.js';
import { stepOfCall } from '../lib/contexts/generation/jobs/generation-view.js';
import { stageUsage } from '../lib/stage-usage.js';
import { unifyCall } from '../lib/job-calls.js';
import { coachDailyJobs, createCoachDaily } from '../lib/coach-daily.js';
import { createUsageLedger, recordedModels } from '../lib/model-usage.js';
import { reportUsage, withUsageSink } from '../lib/usage-scope.js';
import { runCorrectionAgent } from '../lib/live-correction-agent.js';
import { createAssistChildren } from '../lib/assist-child.js';
import { assistDefinition } from '../lib/contexts/study/jobs/assist.js';
import { audioDashboard, audioReasoning, audioUsageFetch, recordAudioUsage, usageTokens, keyId } from '../lib/audio-dashboard.js';
import { gatewayAudioTransport } from '../lib/audio-gateway.js';
import { cacheHitPercent } from '../lib/token-usage.js';
import { createOperations } from '../lib/contexts/jobs/operations.js';
import { createOutputStore } from '../lib/job-output.js';
import { goldenRuntimeContracts } from './fixtures/unified-runtime-contract.mjs';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';

const ui = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { compactCacheSummary, usageNotes } from './ui/token-usage.js';
  export { default as GenerationTrace } from './ui/GenerationTrace.jsx';
  export { callFacts } from './ui/tasks/OutputPanel.jsx';
  export { default as RequestTracePanel } from './ui/tasks/RequestTracePanel.jsx';
  export { default as TaskBody } from './ui/tasks/TaskBody.jsx';
  export { batchSummary } from './ui/tasks/coach-batch.js';
  export { taskFacts } from './ui/tasks/task-facts.js';
  export { AudioDashboardView } from './ui/AudioDashboard.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

const HAN = /[㐀-鿿]/;
const at = (seconds) => new Date(Date.UTC(2026, 10, 20, 10, 0, seconds)).toISOString();
const textOf = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const renderInApp = (element, { language = 'zh', core = {} } = {}) => {
  ui.setUiLanguage(language);
  try {
    return renderToStaticMarkup(inApp(ui, element, { data: {}, app: { lib: { taskFocus: null }, host: {}, core } }));
  } finally {
    ui.setUiLanguage('zh');
  }
};

function gatewaySetup(host, ledger) {
  const record = structuredClone(goldenRuntimeContracts.running);
  record.calls = [];
  record.runtime.steps = [];
  record.capabilities.executionModes = ['direct', 'subagent'];
  const controller = new AbortController();
  const context = {
    jobId: record.jobId,
    attemptId: record.attemptId,
    signal: controller.signal,
    assertCurrent() { controller.signal.throwIfAborted(); },
  };
  return { record, gateway: createModelGateway({ context, record, host, ledger }) };
}

test('P0 v2 TPS bugfix: job-timing falls back to call.tokenUsage.outputTokens', () => {
  const v2Call = {
    callId: 'v2-1',
    kind: 'author',
    status: 'ok',
    startedAt: at(0),
    firstOutputAt: at(2),
    endedAt: at(12),
    tokenUsage: { uncachedInputTokens: 1000, cacheReadTokens: 4000, cacheWriteTokens: 0, outputTokens: 2500 },
  };
  assert.deepEqual(callTiming(v2Call), { ttftMs: 2000, ttftSteps: 1, decodeMs: 10000, decodeTokens: 2500 });
  assert.equal(tokensPerSecond(jobTiming({ calls: [v2Call] })), 250);
});

test('gateway stamps model label, counts physical usageCalls across retries, and forwards light hedge option', async () => {
  const ledgerEvents = [];
  const lightCalls = [];
  const host = {
    ctx: {},
    sessionId: 's1',
    route: { provider: 'deepseek', model: 'deepseek-chat' },
    complete: async () => {
      reportUsage({ uncachedInputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }, { calls: 1 });
      reportUsage({ uncachedInputTokens: 100, outputTokens: 40, cacheReadTokens: 800, cacheWriteTokens: 0 }, { calls: 1 });
      return 'ok';
    },
    light: async (_system, _prompt, req) => {
      lightCalls.push(req);
      reportUsage({ uncachedInputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 }, { calls: 1 });
      return 'light-ok';
    },
  };
  const { record, gateway } = gatewaySetup(host, (call) => { ledgerEvents.push({ callId: call.callId, usageCalls: call.usageCalls }); });
  const policy = { purpose: 'author', feature: 'generate', requestedEffort: 'default', executionMode: 'direct', budget: null };

  await gateway.step('author:1', policy).complete('sys', 'prompt');
  const call = record.calls[0];
  assert.equal(call.model, 'deepseek/deepseek-chat');
  assert.equal(call.usageCalls, 2);
  assert.equal(ledgerEvents[0].usageCalls, 2);
  assert.equal(stepOfCall(call).tokenUsage.calls, 2);
  validateRuntimeContract(record);

  await gateway.step('weigh:1', policy, { model: 'light', hedge: false }).complete('sys', 'prompt');
  assert.equal(lightCalls[0].hedge, false);
  assert.throws(() => gateway.step('weigh:2', policy, { model: 'light', hedge: 'no' }), { code: 'invalid-step-labels' });
});

test('gateway subagent path reads sessionQuery usage + timing with live foldSessionUsage fallback', async () => {
  const parent = { id: 'parent-1' };
  const timing = { ttftMs: 1200, ttftSteps: 2, decodeMs: 4000, decodeTokens: 800 };
  const storedUsage = { uncachedInputTokens: 200, outputTokens: 800, cacheReadTokens: 1000, cacheWriteTokens: 0 };
  const subagents = {
    getProvider: () => ({ capabilities: { toolFilter: true, agentOptions: true } }),
    start: async () => ({
      id: 'child-stored',
      result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: '{"ok":true}' }] }),
      dispose: async () => {},
    }),
  };
  const sessionQuery = {
    observeSession: async (_id) => ({
      events: [
        { type: 'assistant/message', data: { turn: 0, step: 0, message: {}, stream: [], usage: { inputTokens: 100, outputTokens: 400 } } },
        { type: 'assistant/message', data: { turn: 0, step: 1, message: {}, stream: [], usage: { inputTokens: 100, outputTokens: 400 } } },
      ],
      projections: { values: { tokenUsage: storedUsage, sessionStats: timing } },
      [Symbol.dispose]() {},
    }),
  };
  const ctx = {
    get: (key) => (key === 'subagents' ? subagents : key === 'agents' ? { get: () => parent } : key === 'sessionQuery' ? sessionQuery : undefined),
  };
  const { record, gateway } = gatewaySetup({ ctx, sessionId: parent.id, route: { provider: 'p', model: 'm' } });
  const policy = { purpose: 'repair', feature: 'repair', requestedEffort: 'default', executionMode: 'agent-required', budget: null };
  await gateway.step('repair:1', policy).complete('sys', 'prompt');

  assert.equal(record.calls[0].model, 'p/m');
  assert.deepEqual(record.calls[0].tokenUsage, storedUsage);
  assert.equal(record.calls[0].usageCalls, 2);
  assert.deepEqual(record.calls[0].timing, timing);
  assert.deepEqual(stepOfCall(record.calls[0]).timing, timing);
  assert.equal(stepOfCall(record.calls[0]).tokenUsage.calls, 2);
  validateRuntimeContract(record);

  // Fallback to live session when sessionQuery fails
  const liveEvents = [
    { type: 'assistant/message', data: { turn: 0, step: 0, message: {}, stream: [], usage: { inputTokens: 300, outputTokens: 50, cacheReadTokens: 600 } } },
  ];
  const fallbackSubagents = {
    getProvider: () => ({ capabilities: { toolFilter: true, agentOptions: true } }),
    start: async () => ({
      id: 'child-live',
      localAgent: { session: { seq: liveEvents.length, eventAt: (i) => liveEvents[i] } },
      result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: '{"ok":true}' }] }),
      dispose: async () => {},
    }),
  };
  const fallbackCtx = {
    get: (key) => (key === 'subagents' ? fallbackSubagents : key === 'agents' ? { get: () => parent } : key === 'sessionQuery' ? { observeSession: async () => { throw new Error('gone'); } } : undefined),
  };
  const fb = gatewaySetup({ ctx: fallbackCtx, sessionId: parent.id, route: { provider: 'p', model: 'm' } });
  await fb.gateway.step('repair:2', policy).complete('sys', 'prompt');
  assert.deepEqual(fb.record.calls[0].tokenUsage, { uncachedInputTokens: 300, outputTokens: 50, cacheReadTokens: 600, cacheWriteTokens: 0 });
  assert.equal(fb.record.calls[0].usageCalls, 1);
  validateRuntimeContract(fb.record);
});

test('coach daily splits cacheWrite from cacheRead, avoids 100% hit inflation, and stays backward-compatible', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'coach-cache-write-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const now = Date.UTC(2026, 10, 20, 12, 0, 0);
  const daily = createCoachDaily(root, { now: () => now });
  const entry = daily.begin({ targets: 2 });
  await daily.finish(entry, {
    status: 'ok', targets: 2, generated: 2, passed: 2, skipped: 0,
    tokens: { input: 50, output: 300, cache: 0, cacheWrite: 5000 },
    message: '备好 2 道定制题',
  });
  const data = await daily.read();
  const [job] = coachDailyJobs({ data, state: {}, now });
  assert.deepEqual(job.tokenUsage, { uncachedInputTokens: 50, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 5000, calls: 1 });
  assert.equal(cacheHitPercent(job.tokenUsage), '0', 'cold Anthropic cacheWrite is 0% hit, never 100%');
  assert.match(ui.batchSummary(job.coachDaily.batches[0]), /5\.4K tok/, 'batchSummary sums cacheWrite into total tokens');
  const facts = Object.fromEntries(ui.taskFacts(job).map((f) => [f.label, f.value]));
  assert.equal(facts['令牌 入/出/缓存'], '5.1K/300/0', 'cache slot stays 0 (cacheRead only), input includes cacheWrite');

  // Backward-compatible legacy batch without cacheWrite
  const legacyBatch = { status: 'ok', targets: 1, generated: 1, passed: 1, tokens: { input: 1000, output: 200, cache: 500 } };
  assert.match(ui.batchSummary(legacyBatch), /1\.7K tok/);
});

test('recordedModels wraps spawnCorrection, live-correction-agent and assist-child report usage cleanly', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'usage-reporting-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledger = createUsageLedger(root);
  const complete = Object.assign(async () => 'c', {
    spawnCorrection: async () => {
      reportUsage({ uncachedInputTokens: 120, outputTokens: 30, cacheReadTokens: 400, cacheWriteTokens: 0 }, { calls: 1 });
      return 'corrected';
    },
  });
  const wrapped = recordedModels({ complete, light: async () => 'l', spawnCorrection: complete.spawnCorrection }, ledger, 'audio');
  await wrapped.complete.spawnCorrection('s', 'p');
  await wrapped.spawnCorrection('s', 'p');
  const summary = await ledger.summary({ days: 7 });
  assert.equal(summary.byFeature.audio.calls, 2);
  assert.equal(summary.byFeature.audio.cacheReadTokens, 800);

  // live-correction-agent reports usage via sessionQuery or live fold
  const reported = [];
  const parent = { id: 'parent-live' };
  const corrEvents = [{ type: 'assistant/message', data: { turn: 0, step: 0, message: {}, stream: [], usage: { inputTokens: 80, outputTokens: 20, cacheReadTokens: 300 } } }];
  const corrCtx = {
    get: (key) => (key === 'subagents'
      ? { getProvider: () => ({ capabilities: { toolFilter: true, agentOptions: true } }),
        start: async () => ({ id: 'corr-1', localAgent: { session: { seq: 1, eventAt: (i) => corrEvents[i] } },
          result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: '{"corrections":[]}' }] }), dispose: async () => {} }) }
      : key === 'agents' ? { get: () => parent } : undefined),
  };
  await withUsageSink({ key: 't', sink: (u, m) => reported.push({ u, m }) }, () =>
    runCorrectionAgent(corrCtx, { provider: 'p', model: 'm' }, parent.id, 'sys', 'prompt'), { feature: 'audio' });
  assert.equal(reported.length, 1);
  assert.deepEqual(reported[0].u, { uncachedInputTokens: 80, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 0 });
  assert.equal(reported[0].m.feature, 'audio');

  // assist-child reports turn-1 usage and per-followup delta usage only (no cumulative double count)
  const pool = createAssistChildren();
  const sessionEvents = [
    { type: 'assistant/message', data: { turn: 0, step: 0, message: { content: [{ type: 'text', text: '{"turn":1}' }] }, stream: [], usage: { inputTokens: 500, outputTokens: 100, cacheReadTokens: 0 } } },
  ];
  const localAgent = {
    status: 'idle',
    session: {
      get seq() { return sessionEvents.length; },
      snapshotEvents: (from = 0) => sessionEvents.slice(from),
      eventAt: (i) => sessionEvents[i],
    },
    followup() {
      sessionEvents.push(
        { type: 'assistant/message', data: { turn: 1, step: 0, message: { content: [{ type: 'text', text: '{"turn":2}' }] }, stream: [], usage: { inputTokens: 50, outputTokens: 80, cacheReadTokens: 450 } } },
        { type: 'turn/end', data: { reason: { kind: 'completed' } } },
      );
    },
    whenIdle: async () => {},
    cancel() {},
  };
  const assistCap = {
    ctx: {},
    sessionId: 'sess-1',
    parent,
    subagents: {
      start: async () => ({
        id: 'assist-1',
        localAgent,
        result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: '{"turn":1}' }] }),
        dispose: async () => {},
      }),
    },
  };
  const turn1Reports = [], turn2Reports = [];
  await withUsageSink({ key: 't1', sink: (u, m) => turn1Reports.push({ u, m }) }, () =>
    pool.withAssistChild(assistCap, { root, key: 'k1', request: { signal: new AbortController().signal }, followupPrompt: [], task: {}, reuse: true, consume: (raw) => raw }));
  await withUsageSink({ key: 't2', sink: (u, m) => turn2Reports.push({ u, m }) }, () =>
    pool.withAssistChild(assistCap, { root, key: 'k1', request: { signal: new AbortController().signal }, followupPrompt: [{ type: 'text', text: 'next' }], task: {}, reuse: true, consume: (raw) => raw }));
  pool.clearAssistChildren(root);

  assert.equal(turn1Reports.length, 1);
  assert.deepEqual(turn1Reports[0].u, { uncachedInputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 });
  assert.equal(turn2Reports.length, 1);
  assert.deepEqual(turn2Reports[0].u, { uncachedInputTokens: 50, outputTokens: 80, cacheReadTokens: 450, cacheWriteTokens: 0 }, 'followup reports delta only, not turn-1 + turn-2');

  // assistDefinition captures subagent usage onto gateway Call without leaking to outer sink
  const outerLeaks = [];
  const { record, gateway } = gatewaySetup({ ctx: {}, sessionId: 's', route: { provider: 'p', model: 'm' } });
  const admission = assistDefinition.admit({ present() {} }, { job: { cardId: 'c1' } });
  await withUsageSink({ key: 'outer', sink: (u) => outerLeaks.push(u) }, () =>
    assistDefinition.run(
      { admission, gateway, signal: new AbortController().signal },
      { job: { cardId: 'c1' } },
      {
        controller: new AbortController(),
        work: async (exec) => {
          await exec.child(async () => {
            reportUsage({ uncachedInputTokens: 40, outputTokens: 20, cacheReadTokens: 200, cacheWriteTokens: 0 }, { calls: 1 });
            return { message: 'done' };
          }, () => ({ childId: 'assist-1', parentId: 'p1' }));
          return { message: 'done' };
        },
      },
    ));
  assert.equal(outerLeaks.length, 0, 'outsideUsageScope prevents double-counting into outer sink');
  assert.deepEqual(record.calls[0].tokenUsage, { uncachedInputTokens: 40, outputTokens: 20, cacheReadTokens: 200, cacheWriteTokens: 0 });
  assert.equal(record.calls[0].usageCalls, 1);
});

test('audio cached-tokens extraction, JSONL persistence/aggregation, proofreadReasoning default, and UI rendering', async (t) => {
  assert.equal(usageTokens({ usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100, cachedContentTokenCount: 700 } }).cachedInputTokens, 700);
  assert.equal(usageTokens({ usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 600 } } }).cachedInputTokens, 600);
  assert.equal(usageTokens({ usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_cache_hit_tokens: 500 } }).cachedInputTokens, 500);
  assert.equal(audioReasoning({}, 'proofread'), 'low');

  const dir = await mkdtemp(join(tmpdir(), 'audio-cache-'));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  t.after(async () => {
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    await rm(dir, { recursive: true, force: true });
  });
  const settings = { freeKey: 'AIza_test_free_00000000000000', paidKey: '', groqKey: 'gsk_test_00000000000000000000', siliconflowKey: '', transcribeModel: 'm-t', textModel: 'm-x', groqTranscribeModel: 'g-t', groqTextModel: 'g-x', siliconflowTranscribeModel: 's-t', dailyLimits: {} };
  const meteredFetch = audioUsageFetch(settings, async () =>
    new Response(JSON.stringify({ usage: { prompt_tokens: 1000, completion_tokens: 120, prompt_tokens_details: { cached_tokens: 650 } } }), { status: 200 }));
  await meteredFetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${settings.groqKey}` }, audioUsage: { model: 'g-x', stage: 'proofread' } });

  // Also test gatewayAudioTransport persists cachedInputTokens
  const { record, gateway } = gatewaySetup();
  const transport = gatewayAudioTransport(gateway, async () => ({
    status: 200, ok: true, headers: new Headers(),
    json: async () => ({ usageMetadata: { promptTokenCount: 2000, candidatesTokenCount: 200, cachedContentTokenCount: 1500 } }),
  }), settings);
  await gateway.step('proofread:1', { purpose: 'proofread', feature: 'audio', requestedEffort: 'low', executionMode: 'direct', budget: null })
    .run(() => transport('free')('https://generativelanguage.googleapis.com/v1beta/models/m-x:generateContent', { method: 'POST', headers: { 'x-goog-api-key': settings.freeKey } }));
  assert.equal(record.calls[0].ledgerEvent.cachedInputTokens, 1500);

  // Older row without cachedInputTokens stays backward-compatible
  await recordAudioUsage({ type: 'request', tier: 'free', keyId: keyId(settings.freeKey), at: Date.now(), model: 'm-x', status: 200, inputTokens: 100, outputTokens: 10 });
  const dash = await audioDashboard(settings);
  const free = dash.providers.find((p) => p.tier === 'free');
  const groq = dash.providers.find((p) => p.tier === 'groq');
  assert.equal(free.today.cachedInputTokens, 1500);
  assert.equal(groq.today.cachedInputTokens, 650);

  const pubSettings = { freeKey: { set: true, hint: '••••0000' }, paidKey: { set: false }, groqKey: { set: true, hint: '••••0000' }, siliconflowKey: { set: false }, dailyLimits: {}, transcribeModel: 'm-t', textModel: 'm-x', proofreadReasoning: 'low', translateReasoning: 'low' };
  const zhHtml = textOf(renderInApp(React.createElement(ui.AudioDashboardView, { data: dash, settings: pubSettings, busy: false, refresh() {}, save() {} }), { language: 'zh' }));
  assert.match(zhHtml, /含缓存 2,150/);
  const enHtml = textOf(renderInApp(React.createElement(ui.AudioDashboardView, { data: dash, settings: pubSettings, busy: false, refresh() {}, save() {} }), { language: 'en' }));
  assert.match(enHtml, /2,150 cached/);
  assert.doesNotMatch(enHtml, HAN);
});

test('per-stage & per-call cache observability: stageUsage, unifyCall, job.trace, GenerationTrace, OutputPanel, RequestTracePanel, TaskBody', async () => {
  const stepUsage = { uncachedInputTokens: 2000, cacheReadTokens: 8000, cacheWriteTokens: 1000, outputTokens: 500, calls: 1 };
  const stages = stageUsage({
    steps: [
      { id: 's1', stage: 'Writing and self-checking questions', status: 'complete', tokenUsage: stepUsage, startedAt: at(0), finishedAt: at(10) },
      { id: 's2', stage: 'Writing and self-checking questions', status: 'complete', tokenUsage: { uncachedInputTokens: 1000, cacheReadTokens: 9000, cacheWriteTokens: 0, outputTokens: 400, calls: 1 }, startedAt: at(10), finishedAt: at(20) },
    ],
  });
  assert.equal(stages.author.uncachedInputTokens, 3000);
  assert.equal(stages.author.cacheReadTokens, 17000);
  assert.equal(stages.author.cacheWriteTokens, 1000);
  assert.equal(stages.author.outputTokens, 900);
  assert.equal(stages.author.cacheHitPercent, '81');

  const unified = unifyCall({ id: 'c1', stage: 'Authoring', status: 'complete', tokenUsage: stepUsage });
  assert.deepEqual(unified.tokenUsage, { uncachedInputTokens: 2000, cacheReadTokens: 8000, cacheWriteTokens: 1000, outputTokens: 500 });

  // job.trace & job.trace.export include tokenUsage + cacheHitPercent + model
  const outputs = createOutputStore();
  outputs.recordTrace('job-1', 'c1', { stage: 'Planning evidence and learning targets', purpose: 'plan', runner: 'direct', system: 'SYS', prompt: 'PRM', containsSolution: false });
  const job = {
    id: 'job-1', root: 'r', status: 'complete', startedAt: at(0), finishedAt: at(10),
    contract: {
      contractVersion: 2, jobId: 'job-1', kind: 'generation', status: 'complete',
      calls: [{ callId: 'c1', kind: 'plan', stage: 'Planning evidence and learning targets', status: 'ok', runner: 'direct', model: 'deepseek/deepseek-chat', startedAt: at(0), endedAt: at(5), tokenUsage: { uncachedInputTokens: 2000, cacheReadTokens: 8000, cacheWriteTokens: 0, outputTokens: 400 } }],
    },
  };
  const { handlers: ops } = createOperations({
    state: { root: 'r', read: async () => ({ drafts: [], decks: [] }), update: async (fn) => fn({ learner: {} }) },
    work: { jobs: new Map([['job-1', job]]), settled: new Map(), generationMessengers: new Map(), generationControllers: new Map(), jobControls: new Map(), jobOutputs: outputs },
    jobServices: { activeJob: () => false, publicJob: (j) => j, dropRetry() {}, forgetRetry() {}, snapshotJob: (j) => j },
  });
  const trace = await ops['job.trace']({ jobId: 'job-1' });
  assert.equal(trace.calls[0].model, 'deepseek/deepseek-chat');
  assert.deepEqual(trace.calls[0].tokenUsage, { uncachedInputTokens: 2000, cacheReadTokens: 8000, cacheWriteTokens: 0, outputTokens: 400 });
  assert.equal(trace.calls[0].cacheHitPercent, '80');
  const exported = await ops['job.trace.export']({ jobId: 'job-1' });
  assert.equal(exported.calls[0].cacheHitPercent, '80');
  assert.equal(exported.calls[0].tokenUsage.cacheReadTokens, 8000);

  // compactCacheSummary + GenerationTrace + OutputPanel callFacts (zh & en, no price/currency)
  ui.setUiLanguage('zh');
  assert.equal(ui.compactCacheSummary(stepUsage), '缓存命中 73%（读 8K / 写 1K）');
  assert.match(ui.callFacts({ tokens: 11500, tokenUsage: stepUsage }), /缓存命中 73%（读 8K \/ 写 1K）/);
  const traceHtml = textOf(renderInApp(React.createElement(ui.GenerationTrace, {
    job: { id: 'j', status: 'complete', steps: [{ id: 's1', stage: 'Writing and self-checking questions', status: 'complete', tokenUsage: stepUsage }], tokenUsage: stepUsage },
    defaultOpen: true,
  }), { language: 'zh' }));
  assert.match(traceHtml, /缓存命中 73%（读 8K \/ 写 1K）/);
  assert.doesNotMatch(traceHtml, /[¥￥$]|价格|费用|price|cost/i);

  ui.setUiLanguage('en');
  assert.equal(ui.compactCacheSummary(stepUsage), 'Cache hit 73% (read 8K / write 1K)');
  assert.match(ui.callFacts({ tokens: 11500, tokenUsage: stepUsage }), /Cache hit 73% \(read 8K \/ write 1K\)/);
  ui.setUiLanguage('zh');

  // TaskBody shows 发送内容 tab for course-book-build and companion-lesson-build
  for (const kind of ['course-book-build', 'companion-lesson-build']) {
    const task = {
      id: `job-${kind}`, type: kind, status: 'running', startedAt: at(0),
      contract: {
        contractVersion: 1, jobId: `job-${kind}`, kind, status: 'running',
        stage: { code: 'running', text: 'running' },
        progress: { done: 0, total: 1, unit: 'steps', percent: 0, segments: [] },
        usage: { tokens: null, tokenUsage: null, calls: 0 },
        execution: { mode: 'direct' }, detail: { book: { board: [] } },
        startedAt: at(0), calls: [], events: [],
      },
    };
    const bodyHtml = renderInApp(React.createElement(ui.TaskBody, { task }), { language: 'zh' });
    assert.match(bodyHtml, />发送内容</, `${kind} exposes request trace tab`);
  }
});
