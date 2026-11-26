import test from 'node:test';
import assert from 'node:assert/strict';
import { directCacheSessionId, hasModelSdk, modelCompletion } from '../lib/runtime/host-model.js';
import { modelServices } from '../lib/runtime/models.js';
import { createModelGateway } from '../lib/jobs/gateway.js';
import { gatewayModels } from '../lib/contexts/generation/jobs/gateway-model.js';
import { legacyModels } from '../lib/contexts/generation/jobs/legacy-model.js';
import { usageFromTokenUsage } from '../lib/token-usage.js';
import { createOutputStore } from '../lib/job-output.js';
import { GENERATION_TIMEOUT_MS } from '../lib/generation-limits.js';
import { isTransientModelError, withModelRetry } from '../lib/model-retry.js';
import { goldenRuntimeContracts } from './fixtures/unified-runtime-contract.mjs';

const textChunks = (text, extra = []) => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  ...extra,
  { type: 'finish', reason: { kind: 'stop' } },
];

test('directCacheSessionId produces stable synthetic IDs <= 64 chars that never collide with parent chat IDs', () => {
  assert.equal(directCacheSessionId('job-123', 'parent-chat'), 'study-job:job-123');
  assert.equal(directCacheSessionId(undefined, 'parent-chat'), 'study-direct:parent-chat');
  assert.notEqual(directCacheSessionId(undefined, 'parent-chat'), 'parent-chat');
  assert.equal(directCacheSessionId(undefined, undefined), undefined);
  assert.equal(directCacheSessionId('study-job:job-123', 'parent-chat'), 'study-job:job-123', 'already prefixed is not double-prefixed');
  assert.equal(directCacheSessionId('study-direct:parent-chat'), 'study-direct:parent-chat');

  const longA = 'a'.repeat(60) + '-alpha';
  const longB = 'a'.repeat(60) + '-beta';
  const idA = directCacheSessionId(longA);
  const idB = directCacheSessionId(longB);
  assert.ok(idA.length <= 64 && idB.length <= 64, 'clamped to <= 64 chars for OpenAI prompt_cache_key');
  assert.notEqual(idA, idB, 'long IDs sharing a prefix stay distinct via hash suffix');
  assert.equal(directCacheSessionId(longA), idA, 'deterministic across calls');

  const longParent = 'p'.repeat(80);
  const directId = directCacheSessionId(undefined, longParent);
  assert.ok(directId.startsWith('study-direct:') && directId.length <= 64);
});

test('usageFromTokenUsage coerces null cache fields to 0 without dropping valid usage', () => {
  assert.deepEqual(
    usageFromTokenUsage({ inputTokens: 1200, outputTokens: 300, cacheReadTokens: null, cacheWriteTokens: null }),
    { uncachedInputTokens: 1200, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 },
  );
  assert.deepEqual(
    usageFromTokenUsage({ inputTokens: 500, outputTokens: 100, cacheReadTokens: 400, cacheWriteTokens: null }),
    { uncachedInputTokens: 500, outputTokens: 100, cacheReadTokens: 400, cacheWriteTokens: 0 },
  );
  assert.equal(usageFromTokenUsage({ inputTokens: null, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }), null);
  assert.equal(usageFromTokenUsage({ inputTokens: 100, outputTokens: null, cacheReadTokens: 0, cacheWriteTokens: 0 }), null);
  assert.equal(usageFromTokenUsage({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 'bad', cacheWriteTokens: 0 }), null);
  assert.equal(usageFromTokenUsage({ inputTokens: 100, outputTokens: 50, cacheReadTokens: -1, cacheWriteTokens: 0 }), null);
  assert.equal(usageFromTokenUsage({ inputTokens: 100, outputTokens: 50, cacheReadTokens: Number.NaN, cacheWriteTokens: 0 }), null);
});

test('createOutputStore defaults to a 65536-char ring buffer for direct-mode output inspection', () => {
  const store = createOutputStore();
  store.open('job-1', 'call-exact');
  const exact = 'x'.repeat(65536);
  store.append('job-1', 'call-exact', exact);
  const full = store.read('job-1', 'call-exact', 0);
  assert.equal(full.total, 65536);
  assert.equal(full.text, exact);
  assert.equal(full.reset, false);
  assert.equal(store.size('job-1', 'call-exact'), 65536);

  store.open('job-1', 'call-overflow');
  const tail = 'b'.repeat(65536);
  store.append('job-1', 'call-overflow', 'a'.repeat(1000) + tail);
  const kept = store.read('job-1', 'call-overflow', 0);
  assert.equal(kept.total, 66536);
  assert.equal(kept.text, tail);
  assert.equal(kept.reset, true);
  assert.equal(store.size('job-1', 'call-overflow'), 65536);
});

test('modelServices keeps system prompt invariant when omitting local image payloads (appends note to prompt tail)', async () => {
  const seen = [];
  const { complete } = modelServices({
    language: 'en',
    complete: async (system, prompt) => { seen.push({ system, prompt }); return 'ok'; },
  });
  await complete('Shared system', 'Plain page text');
  await complete('Shared system', 'Page with ![fig](data:image/png;base64,iVBORw0KGgo=) image');
  assert.equal(seen[0].system, seen[1].system, 'system prompt must stay byte-identical across calls');
  assert.ok(!seen[1].system.includes('Local image bytes are omitted'));
  assert.ok(!seen[1].prompt.includes('base64,'));
  assert.ok(seen[1].prompt.includes('[local image payload omitted]'));
  assert.ok(seen[1].prompt.endsWith('Local image bytes are omitted. Use only the surrounding text; do not infer or claim to see image contents.'));
});

test('gateway and legacy-model stamp firstOutputAt on first reasoning-delta as well as text-delta', async () => {
  // 1. Gateway direct path.
  const record = structuredClone(goldenRuntimeContracts.running);
  record.jobId = 'job-abc-123';
  record.calls = [];
  record.runtime.steps = [];
  const controller = new AbortController();
  const requests = [];
  const host = {
    ctx: {},
    sessionId: 'parent-chat-1',
    route: () => ({ provider: 'p', model: 'm' }),
    complete: async (_system, _prompt, request) => {
      requests.push(request);
      request.onReasoning?.(0);
      assert.equal(record.calls[0].firstOutputAt, undefined, 'zero-length reasoning does not stamp firstOutputAt');
      request.onReasoning?.(42);
      const stamped = record.calls[0].firstOutputAt;
      assert.ok(typeof stamped === 'string' && stamped.length > 0, 'first positive reasoning delta stamps firstOutputAt');
      request.onOutput?.('{"ok":true}');
      assert.equal(record.calls[0].firstOutputAt, stamped, 'later text delta keeps the initial firstOutputAt');
      return '{"ok":true}';
    },
  };
  const context = { jobId: 'job-abc-123', attemptId: record.attemptId, signal: controller.signal, assertCurrent() {} };
  const gateway = createModelGateway({ context, record, host });
  const models = gatewayModels({
    gateway,
    control: { values: {} },
    performance: {},
    feature: 'generate',
    outputs: { open() {}, append() {}, reasoning() {}, close() {} },
    jobId: () => 'job-abc-123',
    refresh() {},
  });
  await models.call('sys', 'prompt', { kind: 'author', stage: 'Writing and self-checking questions', part: 1, signal: controller.signal });
  assert.equal(record.calls[0].executionMode, 'direct');
  assert.equal(record.calls[0].runner, 'direct');
  assert.equal(requests[0].timeoutMs, GENERATION_TIMEOUT_MS);
  assert.equal(requests[0].cacheSessionId, 'study-job:job-abc-123');
  assert.equal(requests[0].retryTransient, true);

  // 2. Legacy model path.
  const job = { id: 'legacy-job-9', steps: [] };
  const legacySeen = [];
  const outputs = { open() {}, append() {}, reasoning() {}, close() {} };
  const legacy = legacyModels({
    job,
    control: { values: {} },
    feature: 'generate',
    ask: async (_system, _prompt, options) => {
      legacySeen.push(options);
      options.onReasoning?.(0);
      assert.equal(job.steps[0].firstOutputAt, undefined);
      options.onReasoning?.(18);
      const stamped = job.steps[0].firstOutputAt;
      assert.ok(typeof stamped === 'string' && stamped.length > 0);
      options.onOutput?.('{"ok":true}');
      assert.equal(job.steps[0].firstOutputAt, stamped);
      return '{"ok":true}';
    },
    askLight: async (_system, _prompt, options) => {
      legacySeen.push(options);
      return '{}';
    },
    outputs,
    messengers: new Map(),
  });
  await legacy.call('sys', 'prompt', { stage: 'Planning evidence and learning targets', kind: 'plan', signal: controller.signal });
  await legacy.weigh('sys', 'prompt', { stage: 'Weighing sections', signal: controller.signal });
  assert.equal(legacySeen[0].cacheSessionId, 'study-job:legacy-job-9');
  assert.equal(legacySeen[1].cacheSessionId, 'study-job:legacy-job-9');
});

test('gatewayModels defaults question generation and translate to direct even when native subagent exists, capping translate effort to low', async () => {
  const record = structuredClone(goldenRuntimeContracts.running);
  record.jobId = 'job-mode-1';
  record.calls = [];
  record.runtime.steps = [];
  record.capabilities.executionModes = ['direct', 'subagent'];
  const controller = new AbortController();
  let subagentCalls = 0;
  let directCalls = 0;
  const subagents = {
    start: async () => {
      subagentCalls++;
      return { id: `child-${subagentCalls}`, result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: '{}' }] }), dispose: async () => {} };
    },
    getProvider: name => (name === 'spawn' ? { capabilities: { agentOptions: true, toolFilter: true } } : null),
  };
  const ctx = { get: key => (key === 'subagents' ? subagents : key === 'agents' ? new Map([['parent-1', { id: 'parent-1' }]]) : undefined) };
  const host = { ctx, sessionId: 'parent-1', route: () => ({ provider: 'p', model: 'm' }), complete: async () => { directCalls++; return '{}'; } };
  const context = { jobId: 'job-mode-1', attemptId: record.attemptId, signal: controller.signal, assertCurrent() {} };
  const gateway = createModelGateway({ context, record, host });
  const models = gatewayModels({
    gateway,
    control: { values: {} },
    performance: {},
    feature: 'generate',
    outputs: { open() {}, append() {}, reasoning() {}, close() {} },
    jobId: () => 'job-mode-1',
    refresh() {},
  });

  await models.call('sys', 'prompt', { kind: 'author', stage: 'Writing and self-checking questions', part: 1, signal: controller.signal });
  assert.equal(directCalls, 1);
  assert.equal(subagentCalls, 0);
  assert.equal(record.calls[0].executionMode, 'direct');
  assert.equal(record.calls[0].runner, 'direct');

  await models.call('sys', 'prompt', { kind: 'translate', stage: 'Translating batch 1/1', part: 1, signal: controller.signal });
  assert.equal(directCalls, 2);
  assert.equal(subagentCalls, 0);
  assert.equal(record.calls[1].executionMode, 'direct');
  assert.equal(record.calls[1].runner, 'direct');
  assert.equal(record.calls[1].requestedEffort, 'low');
});

test('modelCompletion uses direct by default for generation, isolates synthetic sessionId, honors execution.timeoutMs, and retries non-429 transient errors only', async (t) => {
  if (!hasModelSdk()) return t.skip('Host SDK absent');

  const streamCalls = [];
  let subagentStarts = 0;
  const parent = { id: 'live-parent-chat-uuid' };
  const subagents = {
    getProvider: () => ({ capabilities: { toolFilter: true, agentOptions: true } }),
    start: async () => {
      subagentStarts++;
      return { id: 'child-1', result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: '{"via":"subagent"}' }] }), dispose: async () => {} };
    },
  };
  const makeCtx = (streamImpl) => ({
    get: (name) => (name === 'subagents' ? subagents : name === 'agents' ? { get: (id) => (id === parent.id ? parent : undefined) } : undefined),
    llm: {
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } }),
      resolveCallConfig: async (config) => config,
      stream: streamImpl,
    },
  });

  // 1. Default generation runs direct with shared synthetic study-job:<jobId> sessionId, never raw parent.id.
  const complete = modelCompletion(
    makeCtx(async function* (options) {
      streamCalls.push(options);
      yield* textChunks('{"ok":true}');
    }),
    () => ({ provider: 'p', model: 'm' }),
    parent.id,
  );
  const events = [];
  const r1 = await complete('sys1', 'p1', { jobId: 'gen-job-42', stage: 'Planning', onEvent: (e) => events.push(e) });
  const r2 = await complete('sys2', 'p2', { jobId: 'gen-job-42', stage: 'Authoring', onEvent: (e) => events.push(e) });
  assert.equal(r1, '{"ok":true}');
  assert.equal(r2, '{"ok":true}');
  assert.equal(subagentStarts, 0, 'generation defaults to direct even when native subagents exist');
  assert.deepEqual(streamCalls.map((c) => c.sessionId), ['study-job:gen-job-42', 'study-job:gen-job-42']);
  assert.ok(events.some((e) => e.runtime === 'direct' && e.status === 'complete'));

  // 2. Explicit subagent mode remains supported.
  const sub = await complete('sys3', 'p3', { jobId: 'gen-job-42', stage: 'Writing', executionMode: 'subagent', onEvent() {} });
  assert.equal(sub, '{"via":"subagent"}');
  assert.equal(subagentStarts, 1);

  // 3. Plain direct call without jobId never passes raw parent.id to ctx.llm.stream.
  await complete('sys4', 'p4');
  assert.equal(streamCalls.at(-1).sessionId, `study-direct:${parent.id}`);
  assert.notEqual(streamCalls.at(-1).sessionId, parent.id);

  // 4. task: 'assist' honors execution.timeoutMs instead of hardcoding 8 minutes.
  const slowComplete = modelCompletion(
    makeCtx(async function* ({ signal }) {
      const keepAlive = setTimeout(() => {}, 1000);
      try {
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      } finally {
        clearTimeout(keepAlive);
      }
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } } };
    }),
    () => ({ provider: 'p', model: 'm' }),
    parent.id,
  );
  await assert.rejects(
    () => slowComplete('sys', 'prompt', { task: 'assist', timeoutMs: 40, route: { provider: 'p', model: 'm' } }),
    (error) => error.name === 'TimeoutError' && error.modelFailure === true,
  );

  // 5. Direct retryTransient retries non-429 transient errors (503/EMPTY_RESPONSE) but skips 429 RATE_LIMIT.
  let flakyAttempts = 0;
  const flakyComplete = modelCompletion(
    makeCtx(async function* () {
      flakyAttempts++;
      if (flakyAttempts === 1) {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'server error', code: 'SERVER', status: 503 } } };
        return;
      }
      if (flakyAttempts === 2) {
        yield { type: 'finish', reason: { kind: 'stop' } }; // empty response -> "Model returned no text"
        return;
      }
      yield* textChunks('{"recovered":true}');
    }),
    () => ({ provider: 'p', model: 'm' }),
    parent.id,
  );
  assert.equal(
    await flakyComplete('sys', 'prompt', { task: 'assist', retryTransient: true, retryDelays: [1, 1], cacheSessionId: 'study-job:retry-1' }),
    '{"recovered":true}',
  );
  assert.equal(flakyAttempts, 3);

  let rateLimitAttempts = 0;
  const rateLimited = modelCompletion(
    makeCtx(async function* () {
      rateLimitAttempts++;
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'Too many requests', code: 'RATE_LIMIT', status: 429 } } };
    }),
    () => ({ provider: 'p', model: 'm' }),
    parent.id,
  );
  await assert.rejects(
    () => rateLimited('sys', 'prompt', { task: 'assist', retryTransient: true, retryDelays: [1, 1] }),
    (error) => error.code === 'RATE_LIMIT' && error.status === 429,
  );
  assert.equal(rateLimitAttempts, 1, '429 RATE_LIMIT is not retried inside host-model so batch.js owns rate-limit backoff');
});

test('withModelRetry recognizes EMPTY_RESPONSE and aborts retry sleep immediately on signal abort', async () => {
  assert.equal(isTransientModelError({ code: 'EMPTY_RESPONSE', message: 'empty' }), true);
  const controller = new AbortController();
  let calls = 0;
  const startedAt = Date.now();
  const pending = withModelRetry(async () => {
    calls++;
    setTimeout(() => controller.abort(new Error('cancelled-during-backoff')), 15);
    throw Object.assign(new Error('temporary glitch'), { code: 'SERVER', status: 503 });
  }, { delays: [10_000], signal: controller.signal });
  await assert.rejects(pending, /cancelled-during-backoff/);
  assert.equal(calls, 1);
  assert.ok(Date.now() - startedAt < 2000, 'backoff sleep exited promptly on abort');
});
