import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasModelSdk, modelCompletion } from '../lib/runtime/host-model.js';
import { gatewayCalls } from '../lib/audio-gateway-calls.js';
import { createModelGateway } from '../lib/jobs/gateway.js';
import { gatewayModels } from '../lib/contexts/generation/jobs/gateway-model.js';
import { liveCorrectionModels } from '../lib/contexts/audio/jobs/live-correction-models.js';
import { createMaterialClassifyJobs } from '../lib/contexts/materials/classify-jobs.js';
import { suggestMaterialFolders } from '../lib/contexts/materials/folder-suggest.js';
import { lightStep } from '../lib/contexts/coach/jobs/light-step.js';
import { createAssistService } from '../lib/assist.js';
import { createAssistChildren } from '../lib/assist-child.js';
import { StudyService } from '../lib/service.js';
import { AUDIO_DEFAULTS } from '../lib/audio-settings.js';
import { finishTranscript, textKey } from '../lib/audio-import.js';
import { capEffortDownward, effortsOf, lightRouteOf, policyOf } from '../lib/contexts/generation/inventory/policy.js';
import { createParallel } from '../lib/contexts/generation/inventory/parallel.js';
import { leafStage } from '../lib/contexts/generation/book/jobs/leaf-stage.js';
import { makeAsk } from '../lib/contexts/generation/blueprint/jobs/ask.js';
import { readWindows, uniteExtras } from '../lib/contexts/generation/blueprint/jobs/stage-slides.js';
import { unitePapers } from '../lib/contexts/generation/blueprint/jobs/stage-union.js';
import { paperStage } from '../lib/contexts/generation/outline/jobs/stages.js';
import { goldenRuntimeContracts } from './fixtures/unified-runtime-contract.mjs';

const textChunks = text => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', reason: { kind: 'stop' } },
];

const gate = () => {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
};

const until = async (predicate, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for condition');
};

function makeRuntimeGateway({ host, jobId = 'job-opt-1', executionModes = ['direct', 'subagent'] }) {
  const record = structuredClone(goldenRuntimeContracts.running);
  record.jobId = jobId;
  record.calls = [];
  record.runtime.steps = [];
  record.capabilities.executionModes = executionModes;
  const controller = new AbortController();
  const context = { jobId, attemptId: record.attemptId, signal: controller.signal, assertCurrent() {} };
  const gateway = createModelGateway({ context, record, host });
  return { gateway, record, controller, context };
}

test('host-model audio() defaults to direct + synthetic sessionId + retryTransient + lightRoute, while honoring explicit subagent mode', async t => {
  if (!hasModelSdk()) return t.skip('Host SDK absent');
  const streamCalls = [];
  let subagentStarts = 0;
  let attempts = 0;
  const parent = { id: 'live-parent-chat' };
  const subagents = {
    getProvider: () => ({ capabilities: { toolFilter: true, agentOptions: true } }),
    start: async () => {
      subagentStarts++;
      return { id: 'child-audio-1', result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: '{"via":"subagent"}' }] }), dispose: async () => {} };
    },
  };
  const ctx = {
    get: name => (name === 'subagents' ? subagents : name === 'agents' ? { get: id => (id === parent.id ? parent : undefined) } : undefined),
    llm: {
      listProviders: () => [{ id: 'p', name: 'p' }, { id: 'fast', name: 'fast' }],
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } }),
      resolveCallConfig: async config => config,
      stream: async function* (options) {
        streamCalls.push(options);
        attempts++;
        if (attempts === 1) {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'transient 503', code: 'SERVER', status: 503 } } };
          return;
        }
        yield* textChunks('{"ok":true}');
      },
    },
  };
  const complete = modelCompletion(ctx, () => ({ provider: 'p', model: 'main' }), parent.id);
  const events = [];
  const res = await complete('sys', 'prompt', {
    jobId: 'audio-job-9',
    stage: 'proofread',
    resultOwner: 'plugin',
    reasoningEffort: 'low',
    retryDelays: [1],
    lightRoute: { provider: 'fast', model: 'mini' },
    onEvent: event => events.push(event),
  });
  assert.equal(res, '{"ok":true}');
  assert.equal(subagentStarts, 0, 'audio() defaults to direct even when native subagents exist');
  assert.equal(attempts, 2, 'non-429 transient error retried via retryTransientDirect');
  assert.equal(streamCalls[0].sessionId, 'study-job:audio-job-9');
  assert.equal(streamCalls[0].provider, 'fast');
  assert.equal(streamCalls[0].model, 'mini');
  assert.ok(events.some(e => e.runtime === 'direct' && e.status === 'complete'));

  // Explicit subagent mode remains supported.
  const sub = await complete('sys', 'prompt', {
    jobId: 'audio-job-9',
    stage: 'proofread',
    resultOwner: 'plugin',
    reasoningEffort: 'low',
    executionMode: 'subagent',
  });
  assert.equal(sub, '{"via":"subagent"}');
  assert.equal(subagentStarts, 1);
});

test('audio-gateway-calls and live-correction-models default to direct execution (no subagent spawn)', async () => {
  let subagentStarts = 0;
  let directCalls = 0;
  const subagents = {
    getProvider: () => ({ capabilities: { toolFilter: true, agentOptions: true } }),
    start: async () => { subagentStarts++; throw new Error('unexpected subagent'); },
  };
  const ctx = { get: key => (key === 'subagents' ? subagents : key === 'agents' ? new Map([['parent', { id: 'parent' }]]) : undefined) };
  const host = {
    ctx,
    sessionId: 'parent',
    route: () => ({ provider: 'p', model: 'm' }),
    complete: async () => { directCalls++; return '{"items":[],"corrections":[]}'; },
    light: async () => { directCalls++; return '{"items":[]}'; },
  };

  // 1. audio-gateway-calls
  const audioGw = makeRuntimeGateway({ host, jobId: 'audio-direct-1' });
  const calls = gatewayCalls({
    gateway: audioGw.gateway,
    settings: { ...AUDIO_DEFAULTS, textProvider: 'host' },
    job: { id: 'audio-direct-1', filename: 'lec.wav', language: 'zh' },
  });
  await calls.text('You proofread', '{"paragraphs":[]}', { kind: 'proofread', part: 1, parts: 1, stage: '校对 1/1' });
  assert.equal(audioGw.record.calls[0].executionMode, 'direct');
  assert.equal(audioGw.record.calls[0].runner, 'direct');
  assert.equal(audioGw.record.calls[0].requestedEffort, 'low', 'default proofreadReasoning is low');
  assert.equal(subagentStarts, 0);

  // 2. live-correction-models background call
  const liveGw = makeRuntimeGateway({ host, jobId: 'live-direct-1' });
  const liveModels = liveCorrectionModels(
    { gateway: liveGw.gateway },
    { worker: { language: 'zh', fetch: async () => { throw new Error('no net'); } } },
    { settings: { textProvider: 'host', liveCorrectionReasoning: 'low', liveTranslateModel: 'm' }, session: { subject: 'CS', vocabulary: [] } },
  );
  // Invoke background via the corrector's background runner.
  await liveModels.correct.background([{ n: 1, text: 'Old.' }], [{ n: 2, text: 'Context.' }], 'clarify');
  assert.equal(liveGw.record.calls[0].executionMode, 'direct');
  assert.equal(liveGw.record.calls[0].runner, 'direct');
  assert.equal(subagentStarts, 0);
  assert.equal(directCalls, 2);
});

test('gatewayModels caps translate effort downward to low, preserves lowest, runs direct, opts into lightRoute, and sets hedge:false on weigh', async () => {
  const seenRequests = [];
  const host = {
    ctx: { llm: { listProviders: () => [{ id: 'p', name: 'p' }, { id: 'fast', name: 'fast' }] } },
    sessionId: 'parent',
    route: () => ({ provider: 'p', model: 'strong' }),
    complete: async (_s, _p, req) => { seenRequests.push({ lane: 'default', req }); return '{}'; },
    light: async (_s, _p, req) => { seenRequests.push({ lane: 'light', req }); return '{}'; },
  };
  const { gateway, record, controller } = makeRuntimeGateway({ host, jobId: 'trans-opt-1' });
  const models = gatewayModels({
    gateway,
    control: { values: {} },
    performance: {},
    lightModel: 'fast/mini',
    offersModel: () => true,
    feature: 'other',
    outputs: { open() {}, append() {}, reasoning() {}, close() {} },
    jobId: () => 'trans-opt-1',
    refresh() {},
  });
  await models.call('sys', 'prompt', { kind: 'translate', stage: 'Translating 1/2', part: 1, signal: controller.signal });
  assert.equal(record.calls[0].executionMode, 'direct');
  assert.equal(record.calls[0].requestedEffort, 'low');
  assert.equal(seenRequests[0].req.route.provider, 'fast');
  assert.equal(seenRequests[0].req.route.model, 'mini');

  await models.weigh('sys', 'prompt', { stage: 'Weighing sections', signal: controller.signal });
  assert.equal(seenRequests[1].lane, 'light');
  assert.equal(seenRequests[1].req.hedge, false);
});

test('classify-jobs passes job-scoped cacheSessionId, reasoningEffort lowest, and configured lightModel', async () => {
  const seen = [];
  const state = {
    settings: { generation: { lightModel: 'fast/mini' } },
    sources: [
      { id: 's1', title: 'Lecture 1 Consensus', text: 'Quorum intersection ensures safety.' },
      { id: 's2', title: 'Lecture 2 Storage', text: 'LSM trees batch random writes.' },
    ],
    documents: [],
  };
  const work = { jobs: new Map(), queues: new Map(), settled: new Map(), generationControllers: new Map(), jobOutputs: null };
  const classifyJobs = createMaterialClassifyJobs({
    state: { root: '/tmp/lib', read: async () => state, update: async fn => fn(state) },
    complete: async (_sys, _prompt, options) => {
      seen.push(options);
      return JSON.stringify({ folders: ['Systems'], assignments: [{ id: 'm1', folder: 'Systems' }, { id: 'm2', folder: 'Systems' }] });
    },
    language: 'en',
    work,
    jobServices: { activeJob: () => false, pruneJobs: () => {}, publicJob: j => j },
  });
  const { job } = await classifyJobs['source.folder.classify']({});
  await work.settled.get(job.id);
  assert.equal(job.status, 'complete', job.stage);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].cacheSessionId, `study-job:${job.id}`);
  assert.equal(seen[0].reasoningEffort, 'lowest');
  assert.deepEqual(seen[0].lightRoute, { provider: 'fast', model: 'mini' });
});

test('assist gates subagent spawn to mode=ask only; improve/grade/derive run direct with stable per-request cacheSessionId across repair retries', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-assist-direct-'));
  const children = createAssistChildren();
  const assist = createAssistService({ children });
  t.after(async () => { assist.dispose(); await rm(root, { recursive: true, force: true }); });

  const evidence = 'Bridge separates an abstraction from its implementation so the two can vary independently.';
  const card = {
    id: 'c1', kind: 'open', marks: 2, topic: 'Bridge', objective: 'Explain Bridge',
    prompt: 'What does Bridge separate?', answer: 'Abstraction and implementation.',
    hint: 'Two dimensions.', explanation: 'Both vary independently.', misconception: 'Adapts interfaces.',
    rubric: 'Award 2 marks for naming both abstraction and implementation.',
    rubricCriteria: [{ id: 'r1', label: 'Separation', descriptor: 'Names both dimensions', marks: 2 }],
    citations: [{ sourceId: 's1', quote: evidence }],
  };
  const directCalls = [];
  let attemptCount = 0;
  const service = new StudyService(root, {
    complete: async (_sys, _payload, opts) => {
      directCalls.push(opts);
      attemptCount++;
      // Return invalid JSON on first improve attempt to force repair retry and verify cacheSessionId stability.
      if (attemptCount === 1) return JSON.stringify({ patch: { prompt: 'Bad {{blank}}' }, reason: 'bad' });
      return JSON.stringify({ patch: { explanation: 'Abstraction and implementation vary independently.' }, reason: 'clarified' });
    },
  });
  t.after(() => service.dispose());
  await service.store.update(s => {
    s.sources.push({ id: 's1', title: 'Lecture', text: evidence });
    s.decks.push({ id: 'd1', title: 'Patterns', course: 'CS', cards: [structuredClone(card)] });
  });

  let subagentStarts = 0;
  const nativeCtx = {
    get: key => key === 'agents'
      ? { get: () => ({ id: 'parent' }) }
      : key === 'subagents'
        ? {
            getProvider: () => ({ capabilities: { toolFilter: true, agentOptions: true } }),
            start: async () => {
              subagentStarts++;
              return { id: 'child-ask', result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: '{"answer":"Ask via child"}' }] }), dispose: async () => {} };
            },
          }
        : undefined,
  };

  // 1. improve runs direct and keeps identical synthetic cacheSessionId across repair retry.
  const impTask = await assist.startAssist(nativeCtx, {
    root, service, sessionId: 'parent', mode: 'improve', ref: { deckId: 'd1', cardId: 'c1' },
    text: 'Clarify', helpChoices: [], card, deckTitle: 'Patterns', route: { provider: 'p', model: 'm' },
  });
  assert.equal(impTask.runtime, 'direct');
  await until(() => assist.assistView(root).tasks.at(-1).status !== 'running');
  assert.equal(assist.assistView(root).tasks.at(-1).status, 'done', assist.assistView(root).tasks.at(-1).message);
  assert.equal(subagentStarts, 0);
  assert.equal(directCalls.length, 2, 'initial + repair retry both ran direct');
  assert.equal(directCalls[0].cacheSessionId, directCalls[1].cacheSessionId, 'repair retry reuses identical cacheSessionId');
  assert.match(directCalls[0].cacheSessionId, /^study-job:assist-/);

  // 2. derive runs direct without spawning subagent.
  const prevDirect = directCalls.length;
  service.complete = async (_s, _p, opts) => { directCalls.push(opts); return JSON.stringify({ noChange: 'Too brief.' }); };
  const deriveTask = await assist.startAssist(nativeCtx, {
    root, service, sessionId: 'parent', mode: 'derive', ref: { deckId: 'd1', cardId: 'c1' },
    text: 'Bridge decouples', helpChoices: [], derive: { relation: 'standalone' }, card, deckTitle: 'Patterns', route: { provider: 'p', model: 'm' },
  });
  assert.equal(deriveTask.runtime, 'direct');
  await until(() => assist.assistView(root).tasks.at(-1).status !== 'running');
  assert.equal(subagentStarts, 0);
  assert.equal(directCalls.length, prevDirect + 1);

  // 3. grade runs direct without spawning subagent.
  service.complete = async (_s, _p, opts) => {
    directCalls.push(opts);
    return JSON.stringify({ verdict: 'correct', summary: 'Good.', criteria: [{ id: 'r1', met: true, note: 'Named both.' }] });
  };
  const gradeTask = await assist.startAssist(nativeCtx, {
    root, service, sessionId: 'parent', mode: 'grade', ref: { deckId: 'd1', cardId: 'c1' },
    text: 'It separates abstraction and implementation.', helpChoices: [], card, deckTitle: 'Patterns', route: { provider: 'p', model: 'm' },
  });
  assert.equal(gradeTask.runtime, 'direct');
  await until(() => assist.assistView(root).tasks.at(-1).status !== 'running');
  assert.equal(subagentStarts, 0);

  // 4. ask STILL uses reusable native subagent.
  const askTask = await assist.startAssist(nativeCtx, {
    root, service, sessionId: 'parent', mode: 'ask', ref: { deckId: 'd1', cardId: 'c1' },
    text: 'Why Bridge?', helpChoices: [], card, deckTitle: 'Patterns', route: { provider: 'p', model: 'm' },
  });
  assert.equal(askTask.runtime, 'subagent');
  await until(() => assist.assistView(root).tasks.at(-1).status !== 'running');
  assert.equal(subagentStarts, 1, 'multi-turn ask keeps reusable native subagent');
});

test('light lane honors hedge:false, batch callers pass hedge:false (folder-suggest + coach light-step)', async t => {
  if (!hasModelSdk()) return t.skip('Host SDK absent');

  // 1. host-model light lane with tiny hedgeMs=20: hedge:false fires exactly 1 stream call even after 50ms delay.
  let streamStarts = 0;
  const ctx = {
    llm: {
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low', name: 'Low' }] } }),
      resolveCallConfig: async config => config,
      stream: async function* () {
        streamStarts++;
        await new Promise(resolve => setTimeout(resolve, 45));
        yield* textChunks('{"ok":true}');
      },
    },
  };
  const light = modelCompletion(ctx, () => ({ provider: 'p', model: 'm' }), 's', { light: true, lightTimeoutMs: 5000, hedgeMs: 15 });
  await light('sys', 'prompt', { hedge: false });
  assert.equal(streamStarts, 1, 'hedge:false skips hedgeFirstChunk completely');

  // Without hedge:false, hedgeMs=15 races a second call before 45ms.
  streamStarts = 0;
  await light('sys', 'prompt');
  assert.equal(streamStarts, 2, 'default hedging still works when hedge is not false');

  // 2. folder-suggest passes hedge:false
  const folderOpts = [];
  await suggestMaterialFolders(
    { sources: [{ id: 's1', title: 'Notes', text: 'Distributed locks' }], documents: [], settings: {} },
    { mode: 'auto' },
    {
      light: async (_s, _p, opts) => {
        folderOpts.push(opts);
        return JSON.stringify({ folders: ['Systems'], assignments: [{ id: 'm1', folder: 'Systems' }] });
      },
    },
  );
  assert.equal(folderOpts.length, 1);
  assert.equal(folderOpts[0].hedge, false);

  // 3. coach/jobs/light-step passes hedge:false through gateway.step -> host.light
  const coachRequests = [];
  const { gateway } = makeRuntimeGateway({
    host: {
      ctx: {},
      sessionId: 'parent',
      route: () => ({ provider: 'p', model: 'm' }),
      light: async (_s, _p, req) => { coachRequests.push(req); return '{}'; },
    },
    jobId: 'coach-prep-1',
    executionModes: ['direct'],
  });
  await lightStep(gateway, 'prep:1')('sys', 'prompt', { reasoningEffort: 'lowest', maxTokens: 512 });
  assert.equal(coachRequests.length, 1);
  assert.equal(coachRequests[0].hedge, false);
});

test('downward-only effort caps and lightModel routing for Book/Inventory policy, parallel.ask, audio-settings, and makeAsk stages', async () => {
  // 1. capEffortDownward never raises lowest
  assert.equal(capEffortDownward('lowest', 'low'), 'lowest');
  assert.equal(capEffortDownward('low', 'low'), 'low');
  assert.equal(capEffortDownward('medium', 'low'), 'low');
  assert.equal(capEffortDownward('high', 'low'), 'low');
  assert.equal(capEffortDownward('highest', 'low'), 'low');
  assert.equal(capEffortDownward('default', 'low'), 'low');
  assert.equal(capEffortDownward('follow', 'low'), 'low');

  // 2. inventory/policy.js caps review/inventory/plan(place) downward to low, preserves lowest, and opts eligible stages into lightModel
  const defaultEfforts = effortsOf({ generation: { lightModel: 'fast/mini' } });
  assert.equal(policyOf('review', defaultEfforts).requestedEffort, 'low');
  assert.equal(policyOf('inventory', defaultEfforts).requestedEffort, 'low');
  assert.equal(policyOf('plan', defaultEfforts).requestedEffort, 'low');
  assert.equal(policyOf('place', defaultEfforts).requestedEffort, 'low');
  assert.equal(policyOf('write', defaultEfforts).requestedEffort, 'low');
  assert.equal(policyOf('repair', defaultEfforts).requestedEffort, 'low');

  const highEfforts = effortsOf({ generation: { effortPlanning: 'high', effortReview: 'highest', effortWriting: 'lowest', lightModel: 'fast/mini' } });
  assert.equal(policyOf('review', highEfforts).requestedEffort, 'low', 'book review capped downward from highest');
  assert.equal(policyOf('inventory', highEfforts).requestedEffort, 'low', 'inventory capped downward from high');
  assert.equal(policyOf('plan', highEfforts).requestedEffort, 'low', 'place(plan) capped downward from high');
  assert.equal(policyOf('write', highEfforts).requestedEffort, 'lowest', 'write lowest is never raised');

  const lowestEfforts = effortsOf({ generation: { effortPlanning: 'lowest', effortReview: 'lowest' } });
  assert.equal(policyOf('review', lowestEfforts).requestedEffort, 'lowest', 'lowest review is never raised');
  assert.equal(policyOf('inventory', lowestEfforts).requestedEffort, 'lowest', 'lowest inventory is never raised');
  assert.equal(policyOf('plan', lowestEfforts).requestedEffort, 'lowest', 'lowest place is never raised');

  for (const purpose of ['inventory', 'plan', 'place', 'cards', 'confusables', 'exam']) {
    assert.deepEqual(lightRouteOf(purpose, defaultEfforts), { provider: 'fast', model: 'mini' }, `${purpose} opts into lightModel`);
  }
  for (const purpose of ['write', 'review', 'repair', 'outline', 'kit']) {
    assert.equal(lightRouteOf(purpose, defaultEfforts), null, `${purpose} stays on main model`);
  }

  // 3. parallel.ask forwards lightRoute to gateway.step for eligible purposes only
  const stepCalls = [];
  const fakeParallelCtx = {
    context: {
      attemptId: 'att-1',
      signal: new AbortController().signal,
      pauseRequested: false,
      gateway: {
        step: (key, policy, options) => {
          stepCalls.push({ key, policy, options });
          return { complete: async () => '{"ok":true}', reuse: async () => {} };
        },
      },
    },
    kept: { results: new Map() },
    state: { reused: 0 },
    plan: { language: 'en', efforts: defaultEfforts },
    show: () => {},
    boundary: () => false,
  };
  const parallel = createParallel(fakeParallelCtx, { limit: 2 });
  await parallel.ask('inv:1', { stage: 'inventory' }, policyOf('inventory', defaultEfforts), { system: 's', prompt: 'p' }, t => JSON.parse(t));
  await parallel.ask('wr:1', { stage: 'write' }, policyOf('write', defaultEfforts), { system: 's', prompt: 'p' }, t => JSON.parse(t));
  assert.deepEqual(stepCalls[0].options.lightRoute, { provider: 'fast', model: 'mini' });
  assert.equal(stepCalls[1].options.lightRoute, undefined);

  // 4. audio-settings default proofreadReasoning is 'low' and textKey agrees
  assert.equal(AUDIO_DEFAULTS.proofreadReasoning, 'low');
  assert.equal(
    textKey({ settings: { textProvider: 'host', textModel: 'm' }, subject: '', vocabulary: [] }),
    textKey({ settings: { textProvider: 'host', textModel: 'm', proofreadReasoning: 'low' }, subject: '', vocabulary: [] }),
  );

  // 5. makeAsk defaults unchanged + downward-only overrides on stage-slides, stage-union, outline paperStage
  const recordedAsk = [];
  const fakeGateway = {
    step: (key, policy, options) => {
      recordedAsk.push({ key, policy, options });
      return {
        complete: async () => JSON.stringify({ evidence: [], extra: [], groups: [], questions: [] }),
        reuse: async () => {},
      };
    },
  };
  const baseContext = { gateway: fakeGateway, signal: new AbortController().signal };
  const defaultAsk = makeAsk(baseContext, { results: new Map() }, { reused: 0 }, { feature: 'generate' });
  await defaultAsk('k1', { stage: 'act1' }, { system: 's', prompt: 'p' }, () => ({ ok: true }), async x => x);
  assert.equal(recordedAsk.at(-1).policy.requestedEffort, 'default', 'companion/answer-card default remains default');
  assert.equal(recordedAsk.at(-1).options.lightRoute, undefined);

  const lowestAsk = makeAsk(baseContext, { results: new Map() }, { reused: 0 }, { requestedEffort: 'lowest' });
  await lowestAsk('k2', { stage: 'slides' }, { system: 's', prompt: 'p' }, () => ({ ok: true }), async x => x, { requestedEffort: 'low' });
  assert.equal(recordedAsk.at(-1).policy.requestedEffort, 'lowest', 'per-call low override never raises lowest');

  // Verify stage-slides, stage-union, and outline paperStage pass requestedEffort: 'low' + lightRoute
  const stageOpts = [];
  const captureAsk = async (_key, _labels, _prompt, _read, _settle, opts) => { stageOpts.push(opts); return null; };
  await readWindows(
    {
      plan: {
        language: 'en',
        lightRoute: { provider: 'fast', model: 'mini' },
        inputs: [{ role: 'slides' }],
        windows: [{ number: 1, inputIndex: 0, key: 'w1', slides: [{ id: 's1', page: 1, text: 'hello' }] }],
      },
      state: { stage: '', skippedWindows: [], windows: { done: 0 }, dropped: { evidence: 0, unresolved: 0, points: 0 } },
      ask: captureAsk, show: () => {}, boundary: () => {}, resolveOne: async () => null,
    },
    { listed: [], ids: new Set(), byId: new Map() },
  );
  await uniteExtras(
    {
      plan: { language: 'en', lightRoute: { provider: 'fast', model: 'mini' }, extraMergeNeeded: true, extraMergeKey: 'em' },
      state: { stage: '', merge: { done: 0 } },
      ask: captureAsk, show: () => {}, boundary: () => {},
    },
    { tree: { next: 1, points: [] } },
    [
      { title: 'Topic A', evidence: [{ sourceId: 's1', quote: 'a', role: 'slides' }], window: 1 },
      { title: 'Topic B', evidence: [{ sourceId: 's2', quote: 'b', role: 'slides' }], window: 2 },
    ],
  );
  await unitePapers(
    {
      plan: { language: 'en', lightRoute: { provider: 'fast', model: 'mini' }, mergeNeeded: true, mergeKey: 'pm' },
      state: { stage: '', merge: { done: 0 }, dropped: { questions: 0 } },
      ask: captureAsk, show: () => {}, boundary: () => {},
    },
    [
      { key: 'p1', questions: [{ label: 'Q1', points: [{ title: 'Alpha' }] }] },
      { key: 'p2', questions: [{ label: 'Q1', points: [{ title: 'Beta' }] }] },
    ],
  );
  await paperStage(
    {
      plan: {
        language: 'en',
        efforts: defaultEfforts,
        paperChunks: [{ key: 'pc1', number: 1, paper: 'p1', sources: [{ id: 'ps1', text: 'Q1 explain X' }] }],
      },
      state: { stage: '', unverified: 0, invalid: 0, papers: { done: 0 } },
      input: { language: 'en' },
      ask: async (_key, _labels, _prompt, _read, _settle, opts) => { stageOpts.push(opts); return { questions: [], extracted: [], unverified: 0 }; },
      show: () => {}, boundary: () => {},
    },
    { nodes: [{ id: 'n1', title: 'Alpha', children: [] }] },
  );
  assert.equal(stageOpts.length, 4);
  for (const opts of stageOpts) {
    assert.equal(opts.requestedEffort, 'low');
    assert.deepEqual(opts.lightRoute, { provider: 'fast', model: 'mini' });
  }
});

test('leaf-stage staggers unit #1 write when plan.anchor is active, and is deadlock-free on error and abort', async () => {
  const makeItem = n => ({
    id: `pt-${n}`, title: `Point ${n}`, path: [], fingerprint: `fp-${n}`, mode: 'write',
    checklist: [{ id: `i${n}`, alias: 'c1', kind: 'concept', name: `Concept ${n}`, priority: 'must' }],
    units: [{
      n: 1, of: 1,
      checklist: [{ id: `i${n}`, alias: 'c1', kind: 'concept', name: `Concept ${n}`, priority: 'must' }],
      segments: [{ sourceId: `src-${n}`, material: 'Lec', page: n, text: `Concept ${n} means something important.` }],
    }],
  });

  // 1. With plan.anchor active, leader write must complete before unit 2 and unit 3 start write.
  const firstGate = gate();
  const events = [];
  let writesStarted = 0;
  const runLeaf = async ({ anchor, failFirst = false, signal = new AbortController().signal }) => {
    const items = [makeItem(1), makeItem(2), makeItem(3)];
    const state = { leaves: { total: 0, done: 0, ok: 0, short: 0, failed: 0 }, calls: { review: 0, repair: 0 }, dropped: 0, repaired: 0, missed: 0, board: [] };
    const ctx = {
      context: { signal },
      plan: { language: 'en', anchor, efforts: effortsOf({}) },
      state,
      show: () => {},
      parallel: {
        each: (list, fn) => Promise.all(list.map(fn)),
        ask: async (key, labels) => {
          events.push(`start:${labels.stage}:${labels.part}`);
          if (labels.stage === 'write') {
            const idx = ++writesStarted;
            if (idx === 1) {
              await firstGate.promise;
              if (failFirst) {
                events.push(`fail:${labels.stage}:${labels.part}`);
                return null;
              }
            }
            events.push(`end:${labels.stage}:${labels.part}`);
            return { text: `Concept ${labels.part} explained [1]`, cites: [{ n: 1, ref: 'S1', quote: 'means something' }], claimed: ['i' + labels.part], dropped: 0, cards: [] };
          }
          events.push(`end:${labels.stage}:${labels.part}`);
          if (labels.stage === 'repair') return { text: `Concept ${labels.part} repaired [1]`, cites: [], claimed: ['i' + labels.part], dropped: 0, cards: [] };
          return { issues: [], checked: ['i' + labels.part] };
        },
      },
    };
    return leafStage(ctx, { items });
  };

  const pending = runLeaf({ anchor: { exemplar: 'Sample text', band: { low: 80, high: 160 } } });
  await until(() => writesStarted === 1);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(writesStarted, 1, 'followers wait until leader write finishes');
  firstGate.release();
  await pending;
  assert.equal(writesStarted, 3);
  assert.ok(events.indexOf('end:write:1') < events.indexOf('start:write:2'), 'write:2 starts after write:1 finishes');
  assert.ok(events.indexOf('end:write:1') < events.indexOf('start:write:3'), 'write:3 starts after write:1 finishes');

  // 2. Leader failure releases followers (deadlock-free).
  events.length = 0; writesStarted = 0;
  const errGate = gate();
  const errItems = [makeItem(1), makeItem(2)];
  const errState = { leaves: { total: 0, done: 0, ok: 0, short: 0, failed: 0 }, calls: { review: 0, repair: 0 }, dropped: 0, repaired: 0, missed: 0, board: [] };
  const errRun = leafStage({
    context: { signal: new AbortController().signal },
    plan: { language: 'en', anchor: { exemplar: 'Sample', band: { low: 50, high: 100 } }, efforts: effortsOf({}) },
    state: errState,
    show: () => {},
    parallel: {
      each: (list, fn) => Promise.all(list.map(fn)),
      ask: async (_key, labels) => {
        if (labels.stage === 'write' && labels.part === 1) {
          await errGate.promise;
          return null;
        }
        return labels.stage === 'write' || labels.stage === 'repair'
          ? { text: `Concept ${labels.part} ok`, cites: [], claimed: ['i2'], dropped: 0, cards: [] }
          : { issues: [], checked: ['i2'] };
      },
    },
  }, { items: errItems });
  errGate.release();
  await errRun;
  assert.equal(errState.leaves.failed, 1);
  assert.equal(errState.leaves.done, 2, 'follower completed despite leader failure');

  // 3. Abort while followers wait rejects promptly without deadlock.
  const abortController = new AbortController();
  const stuckGate = gate();
  const abortRun = leafStage({
    context: { signal: abortController.signal },
    plan: { language: 'en', anchor: { exemplar: 'Sample', band: { low: 50, high: 100 } }, efforts: effortsOf({}) },
    state: { leaves: { total: 0, done: 0, ok: 0, short: 0, failed: 0 }, calls: { review: 0, repair: 0 }, dropped: 0, repaired: 0, missed: 0, board: [] },
    show: () => {},
    parallel: {
      each: (list, fn) => Promise.all(list.map(fn)),
      ask: async (_key, labels) => {
        if (labels.part === 1) {
          await Promise.race([
            stuckGate.promise,
            new Promise((_, reject) => abortController.signal.addEventListener('abort', () => reject(abortController.signal.reason), { once: true })),
          ]);
        }
        return null;
      },
    },
  }, { items: [makeItem(1), makeItem(2)] });
  setTimeout(() => abortController.abort(new Error('stopped-warmup')), 15);
  await assert.rejects(abortRun, /stopped-warmup/);
  stuckGate.release();
});

test('audio-import staggers window #1 (so windows 2..N inherit knownFixes & titleEn), avoids bursting on failed window #1, and honors live setLimit increases', async () => {
  // 1. Multi-part recording staggers window #1 so windows 2..N inherit window #1's knownFixes and titleEn, AND calls TITLE_SYSTEM.
  const longParas = Array.from({ length: 4 }, (_, i) => `Window ${i + 1}: ${'lecture evidence '.repeat(260)}`);
  const proofSeen = [];
  const translateSeen = [];
  const kinds = [];
  const multiResult = await finishTranscript({
    paragraphs: longParas,
    filename: 'lec2.wav',
    settings: { textConcurrency: 3 },
    saved: { get: async () => null, set: async () => {} },
    keys: { raw: 'r2', text: 't2' },
    complete: async (_sys, prompt, options) => {
      kinds.push(`${options.kind}:${options.part || 0}`);
      if (options.kind === 'proofread') {
        const input = JSON.parse(prompt);
        proofSeen.push({ part: options.part, knownFixes: input.knownFixes.map(f => f.right) });
        return JSON.stringify({ corrections: [{ wrong: `Window ${options.part}`, right: `Section ${options.part}`, context: `Window ${options.part}: lecture evidence`, reason: 'term', confidence: 'high' }] });
      }
      if (options.kind === 'translate') {
        const input = JSON.parse(prompt);
        translateSeen.push({ part: options.part, previousTitles: input.previousTitles });
        return JSON.stringify({ titleEn: `Part ${options.part} Title`, titleZh: `部分 ${options.part}`, paragraphs: input.paragraphs.map(p => ({ n: p.n, zh: '译文' })) });
      }
      return '{"titleEn":"Combined Lecture Title"}';
    },
  });
  assert.equal(multiResult.titleEn, 'Combined Lecture Title');
  assert.ok(kinds.includes('title:0'), 'TITLE_SYSTEM produces recording-level title');
  assert.deepEqual(proofSeen.find(x => x.part === 2).knownFixes, ['Section 1'], 'window 2 inherits window 1 knownFixes');
  assert.deepEqual(proofSeen.find(x => x.part === 3).knownFixes, ['Section 1'], 'window 3 inherits window 1 knownFixes');
  assert.deepEqual(translateSeen.find(x => x.part === 2).previousTitles, ['Part 1 Title'], 'translate window 2 inherits window 1 titleEn');
  assert.deepEqual(translateSeen.find(x => x.part === 3).previousTitles, ['Part 1 Title'], 'translate window 3 inherits window 1 titleEn');

  // 2. Failed window #1 does not burst remaining windows: stops after streak 2 (4 calls total, not 8).
  let failedCalls = 0;
  await assert.rejects(
    finishTranscript({
      paragraphs: longParas,
      filename: 'fail.wav',
      settings: { textConcurrency: 3 },
      saved: { get: async () => null, set: async () => {} },
      keys: { raw: 'rf', text: 'tf' },
      complete: async () => { failedCalls++; throw new Error('provider down'); },
    }),
    /连续 2 段用同样的错误失败/,
  );
  assert.equal(failedCalls, 4, 'failed window #1 stays staggered and stops after 2 failing windows (4 calls)');
});
