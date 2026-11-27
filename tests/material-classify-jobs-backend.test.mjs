import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { StudyService } from '../lib/service.js';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { writesFor } from '../lib/runtime/domain-contracts.js';
import { capabilityIndex, filterCapabilities } from '../lib/runtime/tools.js';
import { modelCompletion } from '../lib/runtime/host-model.js';
import { disposeIdleCoordinators } from '../lib/host-capabilities.js';
import { WORKER_PRESET } from '../lib/subagent-api.js';
import { NONE_KEY } from '../lib/jev-course-suggest.js';
import { startFakeJev } from './helpers/fake-jev.mjs';

const HAN_RE = /[\u3400-\u9fff]/;

async function createTempService(t, options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'study-classify-home-'));
  const root = await mkdtemp(join(tmpdir(), 'study-classify-jobs-'));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const service = new StudyService(root, options);
  t.after(async () => {
    await service.dispose();
    await disposeIdleCoordinators();
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { root, service };
}

function parseFirstJsonObject(text) {
  const raw = String(text ?? '');
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(raw.slice(start, i + 1));
    }
  }
  return null;
}

/**
 * Build a realistic fake DSH host (`ctx`) exercising `modelCompletion` -> `runGenerationAgent` -> `startBoundedChild` -> `startWorker` (`study-worker` DSH subagent)
 * in `'cold-panel'`, `'live-session'`, or `'direct-only'` fallback mode.
 */
function createFakeDshHost({ cwd, sessionId = 'panel-session-1', mode = 'cold-panel', replyFor }) {
  const bus = new EventEmitter();
  const liveAgents = new Map();
  const childSessions = new Map();
  const spawnedSpecs = [];
  const restrictedTools = [];
  const directSessions = [];
  let coordinatorSeq = 0;
  let directCalls = 0;

  if (mode === 'live-session') {
    liveAgents.set(sessionId, { id: sessionId });
  }

  const agentsService = {
    get: id => liveAgents.get(id),
    async create({ sessionId: coordId, meta }) {
      const id = coordId || `coord-${++coordinatorSeq}`;
      const agent = { id, meta };
      liveAgents.set(id, agent);
      return {
        agent,
        async dispose() {
          liveAgents.delete(id);
        },
      };
    },
  };

  const sessionQuery = {
    async observeSession(targetId) {
      if (targetId === sessionId) {
        return { header: { cwd }, [Symbol.dispose]() {} };
      }
      const record = childSessions.get(targetId);
      if (!record) return null;
      return {
        header: { cwd },
        events: record.events,
        projections: {
          values: {
            tokenUsage: record.usage,
            sessionStats: { ttftMs: 120, ttftSteps: 1, decodeMs: 250, decodeTokens: record.usage.outputTokens },
          },
        },
        [Symbol.dispose]() {},
      };
    },
  };

  const subagentsService = mode === 'direct-only' ? undefined : {
    getProvider(name) {
      if (name !== 'spawn') return null;
      return {
        capabilities: {
          agentOptions: true,
          agentPreset: true,
        },
        inheritsParentContext: false,
      };
    },
    async startActivation(spec) {
      spawnedSpecs.push(spec);
      const childId = spec.childId;
      const childAgent = {
        id: childId,
        session: { id: childId, seq: 0, eventAt: () => null },
        ctx: {
          get(serviceName) {
            if (serviceName === 'tools') {
              return {
                presentAs() {},
                restrict(rule) {
                  restrictedTools.push({ childId, rule });
                },
              };
            }
            return undefined;
          },
        },
      };
      liveAgents.set(childId, childAgent);
      bus.emit('agent/created', { agent: childAgent });

      const combinedPrompt = spec.prompt.map(part => part.text).join('\n');
      const resultPromise = (async () => {
        await new Promise(resolve => setImmediate(resolve));
        spec.signal?.throwIfAborted();
        const answer = await replyFor(combinedPrompt, spec);
        spec.signal?.throwIfAborted();
        const mid = Math.max(1, Math.floor(answer.length / 2));
        bus.emit('agent/assistant-stream', {
          agent: childAgent,
          frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: 'thinking...' } },
        });
        bus.emit('agent/assistant-stream', {
          agent: childAgent,
          frame: { type: 'chunk', chunk: { type: 'text-delta', text: answer.slice(0, mid) } },
        });
        bus.emit('agent/assistant-stream', {
          agent: childAgent,
          frame: { type: 'chunk', chunk: { type: 'text-delta', text: answer.slice(mid) } },
        });
        const usage = { uncachedInputTokens: 320, outputTokens: 96, cacheReadTokens: 64, cacheWriteTokens: 0 };
        const events = [
          {
            type: 'assistant/message',
            data: {
              turn: 1,
              step: 1,
              usage: { inputTokens: 320, outputTokens: 96, cacheReadTokens: 64, cacheWriteTokens: 0 },
              content: [{ type: 'text', text: answer }],
            },
          },
        ];
        childAgent.session = { seq: events.length, eventAt: idx => events[idx] };
        childSessions.set(childId, { answer, usage, events });
        liveAgents.delete(childId);
        return {
          stopReason: 'completed',
          output: [{ type: 'text', text: answer }],
        };
      })();

      return {
        childId,
        result: resultPromise,
        async dispose() {
          liveAgents.delete(childId);
        },
      };
    },
  };

  const llm = {
    listProviders: () => [{ id: 'deepseek' }],
    async resolveModelInfo() {
      return { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } };
    },
    async resolveCallConfig(cfg) {
      return cfg;
    },
    async *stream({ system, messages, signal, sessionId: streamSessionId }) {
      directCalls += 1;
      directSessions.push(streamSessionId);
      await new Promise(resolve => setImmediate(resolve));
      signal?.throwIfAborted();
      const userPrompt = messages?.[0]?.content?.[0]?.text || '';
      const answer = await replyFor(`${system}\n\n${userPrompt}`, { direct: true, signal });
      signal?.throwIfAborted();
      const mid = Math.max(1, Math.floor(answer.length / 2));
      yield { type: 'reasoning-delta', text: 'thinking...' };
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: answer.slice(0, mid) };
      yield { type: 'text-delta', index: 0, text: answer.slice(mid) };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } };
      yield { type: 'usage', usage: { inputTokens: 210, outputTokens: 64, cacheReadTokens: 0, cacheWriteTokens: 0 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };

  const ctx = {
    llm,
    sessions: new Map([[sessionId, { header: { cwd } }]]),
    on(event, listener) {
      bus.on(event, listener);
      return () => bus.off(event, listener);
    },
    get(name) {
      if (name === 'llm') return llm;
      if (name === 'subagents') return subagentsService;
      if (name === 'agents') return agentsService;
      if (name === 'agentPresets') return { get: preset => (preset === WORKER_PRESET ? { name: preset } : null) };
      if (name === 'sessionQuery') return sessionQuery;
      return undefined;
    },
  };
  ctx.root = ctx;

  const complete = modelCompletion(ctx, () => ({ provider: 'deepseek', model: 'deepseek-chat' }), sessionId);
  return {
    ctx,
    complete,
    sessionQuery,
    spawnedSpecs,
    restrictedTools,
    directSessions,
    getDirectCalls: () => directCalls,
  };
}

/* ---------- 1. Domain contracts, capability budgets & model readiness ---------- */

test('domain contracts & capability budgets: classify/organize actions declare settings writes, require model when appropriate, and fit budgets', async t => {
  assert.deepEqual(writesFor('materials', 'source.folder.classify'), ['settings']);
  assert.deepEqual(writesFor('materials', 'source.folder.dismiss'), ['settings']);
  assert.deepEqual(writesFor('materials', 'source.organize.start'), ['settings']);
  assert.deepEqual(writesFor('materials', 'source.organize.dismiss'), ['settings']);
  assert.deepEqual(writesFor('materials', 'source.courses.set'), ['sources', 'settings']);
  assert.deepEqual(writesFor('library', 'source.courses.set'), ['sources', 'settings']);

  const { service } = await createTempService(t);
  await service.call('source.add', { id: 's1', title: 'JVM GC', text: '# GC\nG1 & ZGC', courses: ['Java 八股'] });

  // Without model connected, background start actions return model_unavailable; dismiss works without a model
  const noModelClassify = await service.call('source.folder.classify', { course: 'Java 八股' });
  assert.equal(noModelClassify.available, false);
  assert.equal(noModelClassify.reason, 'model_unavailable');

  const noModelOrganize = await service.call('source.organize.start', { sourceIds: ['s1'] });
  assert.equal(noModelOrganize.available, false);
  assert.equal(noModelOrganize.reason, 'model_unavailable');

  assert.deepEqual(await service.call('source.folder.dismiss', {}), { dismissed: false });
  assert.deepEqual(await service.call('source.organize.dismiss', {}), { dismissed: false });

  // Capability index (< 8192) and library listing (< 7200, host limit 8192) budgets remain intact
  const caps = service.runtime.capabilities();
  const indexJson = JSON.stringify(capabilityIndex(caps));
  assert.ok(indexJson.length < 8192, `capability index ${indexJson.length} < 8192`);
  const libListing = JSON.stringify(filterCapabilities(caps, { context: 'library' }));
  assert.ok(libListing.length < 7200, `library listing ${libListing.length} < 7200`);

  const matOps = filterCapabilities(caps, { context: 'materials' }).contexts[0].operations.map(op => op.name);
  for (const expected of ['source.folder.classify', 'source.folder.dismiss', 'source.organize.start', 'source.organize.dismiss']) {
    assert.ok(matOps.includes(expected), `${expected} registered in materials`);
  }
});

/* ---------- 2. Direct cache-session default + explicit DSH subagent routing (cold panel + live session) & fallback ---------- */

test('direct execution default with job-scoped cacheSessionId, streaming job.output, token folding, and explicit DSH subagent opt-in/fallback', async t => {
  const folderReply = promptText => {
    const payload = parseFirstJsonObject(promptText);
    if (promptText.includes('{"folders":["Topic 1","Topic 2"]}') && !promptText.includes('"assignments"')) {
      return JSON.stringify({ folders: ['JVM 与内存', '并发编程'] });
    }
    return JSON.stringify({
      folders: ['JVM 与内存', '并发编程'],
      assignments: (payload?.items || []).map(item => ({
        id: item.id,
        folder: /并发|锁/.test(item.title) ? '并发编程' : 'JVM 与内存',
      })),
    });
  };

  // A. Default classify runs 100% direct with shared synthetic study-job:<jobId> cacheSessionId (#1261), streaming job.output, and folded usage
  {
    const root = await mkdtemp(join(tmpdir(), 'study-cold-panel-direct-'));
    const host = createFakeDshHost({ cwd: root, sessionId: 'cold-panel-sess', mode: 'cold-panel', replyFor: folderReply });
    const service = new StudyService(root, { complete: host.complete, sessionQuery: host.sessionQuery });
    t.after(async () => {
      await service.dispose();
      await disposeIdleCoordinators(host.ctx);
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });

    await service.store.update(s => {
      for (let i = 1; i <= 65; i++) {
        s.sources.push({
          id: `cp-${i}`,
          title: i % 2 === 0 ? `ReentrantLock 并发锁笔记 ${i}` : `JVM 垃圾回收笔记 ${i}`,
          text: `# 章节 ${i}\n核心原理详解。`,
          courses: ['Java 八股'],
        });
      }
    });

    const started = await service.call('source.folder.classify', { course: 'Java 八股' });
    assert.equal(started.reused, false);
    assert.equal(started.job.type, 'material-classify');

    const settled = await service.call('job.wait', { jobId: started.job.id });
    assert.equal(settled.status, 'complete');
    assert.equal(settled.phase, 'done');
    assert.equal(settled.done, 65);
    assert.equal(settled.total, 65);
    assert.equal(host.getDirectCalls(), 3, '1 taxonomy + 2 batches of 60 and 5 run direct by default (#1261)');
    assert.equal(host.spawnedSpecs.length, 0, 'no DSH subagent spawned by default');
    assert.deepEqual(
      host.directSessions,
      Array(3).fill(`study-job:${started.job.id}`),
      'all steps share the job-scoped synthetic cacheSessionId without colliding with cold-panel-sess',
    );

    const snap = await service.call('snapshot');
    const snapJob = snap.jobs.find(j => j.id === started.job.id);
    assert.ok(snapJob);
    assert.equal(snapJob.contract.kind, 'material-classify');
    assert.equal(snapJob.contract.execution.mode, 'direct');
    assert.deepEqual(snapJob.contract.result.refs, [{ kind: 'material-classify' }]);
    assert.ok(snapJob.contract.usage.tokens > 0, 'direct step tokens folded onto job');

    assert.equal(snapJob.steps.length, 3);
    assert.equal(snapJob.steps[0].stage, 'taxonomy');
    assert.equal(snapJob.steps[0].label, '归纳主题目录');
    for (const step of snapJob.steps) {
      assert.equal(step.status, 'complete');
      assert.equal(step.runtime, 'direct');
      assert.ok(step.usage?.outputTokens > 0);
      assert.ok(typeof step.startedAt === 'string' && typeof step.completedAt === 'string');
    }

    // Live / retained output buffer captured streamed direct deltas
    const out = await service.call('job.output', { jobId: started.job.id, callId: snapJob.steps[0].id, cursor: 0 });
    assert.equal(out.supported, true);
    assert.match(out.text, /JVM 与内存/);
    assert.ok(out.reasoningChars > 0);
  }

  // B. Explicit executionMode: 'subagent' still routes via cold-panel coordinator and live-session parent with tool restriction
  {
    const root = await mkdtemp(join(tmpdir(), 'study-cold-panel-subagent-'));
    const host = createFakeDshHost({ cwd: root, sessionId: 'cold-panel-sess', mode: 'cold-panel', replyFor: folderReply });
    t.after(async () => {
      await disposeIdleCoordinators(host.ctx);
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    const events = [];
    const reply = await host.complete('system', '{"folders":["Topic 1","Topic 2"]}', {
      jobId: 'explicit-subagent-cold',
      stage: 'taxonomy',
      resultOwner: 'plugin',
      reasoningEffort: 'lowest',
      executionMode: 'subagent',
      onEvent: e => events.push(e),
    });
    assert.match(reply, /JVM 与内存/);
    assert.equal(host.getDirectCalls(), 0);
    assert.equal(host.spawnedSpecs.length, 1);
    assert.equal(host.spawnedSpecs[0].agentPreset, WORKER_PRESET);
    assert.equal(host.spawnedSpecs[0].delivery, 'caller');
    assert.equal(host.restrictedTools.length, 1, 'child had host tools restricted to allow: []');
    const subEvent = events.find(e => e.childId);
    assert.ok(subEvent?.parentId && subEvent.parentId !== 'cold-panel-sess', 'cold panel uses dedicated idle coordinator parent');
  }
  {
    const root = await mkdtemp(join(tmpdir(), 'study-live-sess-subagent-'));
    const host = createFakeDshHost({ cwd: root, sessionId: 'live-chat-42', mode: 'live-session', replyFor: folderReply });
    t.after(async () => {
      await disposeIdleCoordinators(host.ctx);
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    const events = [];
    await host.complete('system', '{"folders":["Topic 1","Topic 2"]}', {
      jobId: 'explicit-subagent-live',
      stage: 'taxonomy',
      resultOwner: 'plugin',
      reasoningEffort: 'lowest',
      executionMode: 'subagent',
      onEvent: e => events.push(e),
    });
    assert.equal(host.getDirectCalls(), 0);
    const subEvent = events.find(e => e.childId);
    assert.equal(subEvent?.runtime, 'subagent');
    assert.equal(subEvent?.parentId, 'live-chat-42');
  }

  // C. Direct model fallback when DSH subagents are unavailable (even if executionMode: 'subagent' is requested)
  {
    const root = await mkdtemp(join(tmpdir(), 'study-direct-fallback-'));
    const host = createFakeDshHost({ cwd: root, sessionId: 'no-subagent-sess', mode: 'direct-only', replyFor: folderReply });
    const service = new StudyService(root, { complete: host.complete });
    t.after(async () => {
      await service.dispose();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });

    await service.call('source.add', { id: 'dr-1', title: 'JVM 类加载', text: '# 双亲委派', courses: ['Java 八股'] });
    const { job } = await service.call('source.folder.classify', { course: 'Java 八股' });
    const done = await service.call('job.wait', { jobId: job.id });
    assert.equal(done.status, 'complete');
    assert.equal(host.getDirectCalls(), 1);
    assert.equal(done.steps[0].runtime, 'direct');
    const snap = await service.call('snapshot');
    const snapJob = snap.jobs.find(j => j.id === job.id);
    assert.equal(snapJob.contract.execution.mode, 'direct');
  }
});

/* ---------- 3. Multi-step progress phases, deduplication, durable proposals, apply & dismiss ---------- */

test('source.folder.classify tracks taxonomy -> batch -> done phases, deduplicates active runs, and persists/clears settings.materialClassifyPending', async t => {
  const taxonomyGate = Promise.withResolvers();
  const taxonomyEntered = Promise.withResolvers();
  const batchGate = Promise.withResolvers();
  let batchesSeen = 0;

  const complete = async (_system, prompt) => {
    const payload = parseFirstJsonObject(prompt);
    if (!prompt.includes('"assignments"')) {
      taxonomyEntered.resolve();
      await taxonomyGate.promise;
      return JSON.stringify({ folders: ['网络协议', '数据库内核', '并发与锁'] });
    }
    batchesSeen += 1;
    if (batchesSeen === 3) {
      await batchGate.promise;
    }
    return JSON.stringify({
      assignments: (payload?.items || []).map((item, idx) => ({
        id: item.id,
        folder: ['网络协议', '数据库内核', '并发与锁'][idx % 3],
      })),
    });
  };

  const { service } = await createTempService(t, { complete });
  await service.store.update(s => {
    for (let i = 1; i <= 155; i++) {
      s.sources.push({
        id: `m-${i}`,
        title: `专题讲义 ${i}`,
        text: `# 专题 ${i}\n详细内容 ${i}`,
        courses: ['Java 八股'],
      });
    }
  });

  const first = await service.call('source.folder.classify', { course: 'Java 八股', maxFolders: 8 });
  assert.equal(first.reused, false);
  assert.equal(first.job.phase, 'taxonomy');
  assert.equal(first.job.course, 'Java 八股');
  assert.equal(first.job.done, 0);
  assert.equal(first.job.total, 155);

  await taxonomyEntered.promise;

  // Deduplicates while active
  const duplicate = await service.call('source.folder.classify', { course: 'Java 八股' });
  assert.equal(duplicate.reused, true);
  assert.equal(duplicate.job.id, first.job.id);

  // Live list reports taxonomy phase while Step 1 is running
  const liveDuringTax = await service.call('job.live.list');
  const liveTaxRow = liveDuringTax.jobs.find(j => j.id === first.job.id);
  assert.ok(liveTaxRow);
  assert.equal(liveTaxRow.phase, 'taxonomy');
  assert.equal(liveTaxRow.contract.stage.code, 'material-classify.taxonomy');
  assert.equal(liveTaxRow.contract.progress.unit, 'materials');
  assert.equal(liveTaxRow.contract.actions.cancel.available, true);

  // Release taxonomy; first two batches finish while 3rd batch waits on batchGate
  taxonomyGate.resolve();
  for (const pollUntil = Date.now() + 10_000; Date.now() < pollUntil && batchesSeen < 3;) {
    await new Promise(r => setTimeout(r, 10));
  }
  await new Promise(r => setTimeout(r, 20));

  const liveDuringBatch = await service.call('job.live.list');
  const liveBatchRow = liveDuringBatch.jobs.find(j => j.id === first.job.id);
  assert.ok(liveBatchRow);
  assert.equal(liveBatchRow.phase, 'batch');
  assert.equal(liveBatchRow.done, 120);
  assert.equal(liveBatchRow.total, 155);
  assert.equal(liveBatchRow.contract.stage.code, 'material-classify.batch');

  batchGate.resolve();
  const finished = await service.call('job.wait', { jobId: first.job.id });
  assert.equal(finished.status, 'complete');
  assert.equal(finished.phase, 'done');
  assert.equal(finished.done, 155);
  assert.equal(finished.steps.length, 4);
  assert.equal(finished.steps[0].stage, 'taxonomy');
  assert.deepEqual(
    finished.steps.slice(1).map(s => s.stage),
    ['classify-batch', 'classify-batch', 'classify-batch'],
  );

  const snapAfterDone = await service.call('snapshot');
  const pending = snapAfterDone.settings.materialClassifyPending;
  assert.ok(pending, 'durable pending proposal saved in settings');
  assert.equal(pending.jobId, first.job.id);
  assert.equal(pending.course, 'Java 八股');
  assert.ok(typeof pending.createdAt === 'string');
  assert.deepEqual(pending.folders, ['网络协议', '数据库内核', '并发与锁']);
  assert.equal(pending.suggestions.length, 155);
  assert.deepEqual(Object.keys(pending.suggestions[0]).sort(), ['currentFolder', 'key', 'suggestedFolder', 'title']);
  assert.deepEqual(pending.unmatchedKeys, []);

  // Mismatched jobId dismiss is a no-op and does NOT bump library revision
  const revBeforeWrongDismiss = snapAfterDone.revision;
  const wrongDismiss = await service.call('source.folder.dismiss', { jobId: 'non-existent-job' });
  assert.deepEqual(wrongDismiss, { dismissed: false });
  const snapAfterWrong = await service.call('snapshot');
  assert.equal(snapAfterWrong.revision, revBeforeWrongDismiss);
  assert.ok(snapAfterWrong.settings.materialClassifyPending);

  // Applying folder assignments clears settings.materialClassifyPending atomically
  const applied = await service.call('source.folder.apply', {
    assignments: pending.suggestions.map(s => ({ key: s.key, folder: s.suggestedFolder })),
  });
  assert.equal(applied.updated, 155);
  const snapAfterApply = await service.call('snapshot');
  assert.equal(snapAfterApply.settings.materialClassifyPending, undefined);
  assert.equal(Object.keys(snapAfterApply.materialFolders.items).length, 155);

  // Starting a new run after completion creates a fresh job (`reused: false`), and `source.folder.dismiss` clears it
  const second = await service.call('source.folder.classify', { keys: ['source:m-1', 'source:m-2'] });
  assert.equal(second.reused, false);
  assert.notEqual(second.job.id, first.job.id);
  await service.call('job.wait', { jobId: second.job.id });
  assert.ok((await service.call('snapshot')).settings.materialClassifyPending);
  assert.deepEqual(await service.call('source.folder.dismiss', { jobId: second.job.id }), { dismissed: true });
  assert.equal((await service.call('snapshot')).settings.materialClassifyPending, undefined);
});

/* ---------- 4. Scalable `source.organize.start` (>100 sources!), exact proposal shape, Jev hook & `source.courses.set` ---------- */

test('source.organize.start scales past 100 sources without cap, preserves exact proposal fields, clears on source.courses.set, and supports Jev', async t => {
  const complete = async (_system, prompt) => {
    const data = JSON.parse(prompt.split('\n\n')[0]);
    return JSON.stringify({
      proposals: data.sources.map((src, idx) => ({
        id: src.id,
        courses: [idx % 2 === 0 ? 'Databases' : 'Operating Systems'],
        reason: `Matched ${src.title} from course catalog (${(data.courses || []).filter(Boolean).join(', ')})`,
      })),
    });
  };

  const { service } = await createTempService(t, { complete });

  // Seed 135 unassigned sources (> 100!) plus courses in `courses` and `decks` to verify cross-context readFullState
  await service.store.update(s => {
    s.courses.push({ id: 'c-db', name: 'Databases', exam: { date: '2026-12-20', format: 'written' } });
    s.decks.push({
      id: 'd-os',
      title: 'OS Deck',
      course: 'Operating Systems',
      cards: [],
    });
    for (let i = 1; i <= 135; i++) {
      s.sources.push({
        id: `org-${i}`,
        title: `Lecture Note ${i}`,
        text: `# Lecture ${i}\nTransactions, WAL, and page tables.`,
        courses: i === 1 ? ['LegacyCourse'] : [],
      });
    }
  });

  const allIds = Array.from({ length: 135 }, (_, i) => `org-${i + 1}`);

  // Compare exact item keys against synchronous `source.organize.suggest`
  const syncSample = await service.call('source.organize.suggest', { sourceIds: ['org-1', 'org-2'] });
  const expectedProposalKeys = Object.keys(syncSample.proposals[0]).sort();
  assert.deepEqual(expectedProposalKeys, ['courses', 'expectedCourses', 'id', 'reason', 'title']);

  // Synchronous `source.organize.suggest` also handles > 100 sources cleanly now
  const syncOver100 = await service.call('source.organize.suggest', { sourceIds: allIds });
  assert.equal(syncOver100.proposals.length, 135);

  // Background `source.organize.start` over all 135 sources (3 subagent batches: 50 + 50 + 35)
  const started = await service.call('source.organize.start', { sourceIds: allIds });
  assert.equal(started.reused, false);
  assert.equal(started.job.type, 'material-organize');
  assert.equal(started.job.total, 135);

  const settled = await service.call('job.wait', { jobId: started.job.id });
  assert.equal(settled.status, 'complete');
  assert.equal(settled.phase, 'done');
  assert.equal(settled.done, 135);
  assert.equal(settled.steps.length, 3);
  for (let i = 0; i < 3; i++) {
    assert.equal(settled.steps[i].stage, 'organize-batch');
    assert.equal(settled.steps[i].label, `课程归属第 ${i + 1}/3 批`);
  }

  const snap = await service.call('snapshot');
  const snapJob = snap.jobs.find(j => j.id === started.job.id);
  assert.equal(snapJob.contract.kind, 'material-organize');
  assert.equal(snapJob.contract.progress.unit, 'materials');
  assert.deepEqual(snapJob.contract.result.refs, [{ kind: 'material-organize' }]);

  const pending = snap.settings.materialOrganizePending;
  assert.ok(pending);
  assert.equal(pending.jobId, started.job.id);
  assert.ok(typeof pending.createdAt === 'string');
  assert.equal(pending.jev, undefined);
  assert.equal(pending.proposals.length, 135);
  assert.deepEqual(Object.keys(pending.proposals[0]).sort(), expectedProposalKeys, 'exact same proposal keys as source.organize.suggest');
  assert.deepEqual(pending.proposals[0].expectedCourses, ['LegacyCourse']);
  assert.match(pending.proposals[0].reason, /Databases.*Operating Systems|Operating Systems.*Databases/, 'saw courses from both courses.v1 and bank.v1');

  // Applying via `source.courses.set` updates courses AND clears `settings.materialOrganizePending`
  const applied = await service.call('source.courses.set', {
    assignments: pending.proposals.map(p => ({
      id: p.id,
      courses: p.courses,
      expectedCourses: p.expectedCourses,
    })),
  });
  assert.equal(applied.updated, 135);
  const snapAfterSet = await service.call('snapshot');
  assert.equal(snapAfterSet.settings.materialOrganizePending, undefined);
  assert.deepEqual((await service.call('source.get', { id: 'org-1' })).courses, ['Databases']);

  // Dismiss test
  const second = await service.call('source.organize.start', { sourceIds: ['org-1', 'org-2'] });
  await service.call('job.wait', { jobId: second.job.id });
  assert.deepEqual(await service.call('source.organize.dismiss', { jobId: 'wrong-id' }), { dismissed: false });
  assert.deepEqual(await service.call('source.organize.dismiss', {}), { dismissed: true });
  assert.equal((await service.call('snapshot')).settings.materialOrganizePending, undefined);
});

test('source.organize.start integrates with experimental Jev hook when enabled', async t => {
  const home = await mkdtemp(join(tmpdir(), 'study-jev-org-job-home-'));
  const root = await mkdtemp(join(tmpdir(), 'study-jev-org-job-lib-'));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const fakeJev = await startFakeJev({
    answer: (_name, question, stateSent) => {
      const keys = Object.keys(question.criteria);
      const probs = Object.fromEntries(keys.map(k => [k, 0]));
      if (stateSent.title === 'WAL Recovery') {
        probs.Databases = 0.94;
        probs[NONE_KEY] = 0.06;
      } else {
        probs[NONE_KEY] = 0.92;
        probs.Databases = 0.08;
      }
      const top = Object.entries(probs).sort((a, b) => b[1] - a[1])[0];
      return { type: 'choice', choice: top[0], confidence: 0.9, probabilities: probs };
    },
  });
  const service = new StudyService(root, {
    complete: async (_sys, prompt) => {
      const data = JSON.parse(prompt.split('\n\n')[0]);
      return JSON.stringify({
        proposals: data.sources.map(s => ({ id: s.id, courses: ['Distributed Systems'], reason: 'Model fallback' })),
      });
    },
    jev: { baseUrl: fakeJev.baseUrl, sleep: async () => {}, random: () => 0 },
  });
  t.after(async () => {
    await service.dispose();
    await fakeJev.close();
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  await service.store.update(s => {
    s.sources.push(
      { id: 'anchor', title: 'B-Tree', text: 'Database index', courses: ['Databases'] },
      { id: 'j1', title: 'WAL Recovery', text: 'Write-ahead logging', courses: [] },
      { id: 'j2', title: 'Raft Consensus', text: 'Leader election', courses: [] },
    );
  });
  await service.call('experimental.set', { enabled: true });
  await service.call('jev.settings.set', { key: fakeJev.key, confirm: true, enabled: true, replace: { courseOrganize: true } });

  const { job } = await service.call('source.organize.start', { sourceIds: ['j1', 'j2'] });
  const done = await service.call('job.wait', { jobId: job.id });
  assert.equal(done.status, 'complete');

  const pending = (await service.call('snapshot')).settings.materialOrganizePending;
  assert.ok(pending?.jev?.enabled);
  assert.equal(pending.jev.jev, 1);
  assert.equal(pending.jev.model, 1);
  const byId = Object.fromEntries(pending.proposals.map(p => [p.id, p]));
  assert.equal(byId.j1.decidedBy, 'jev');
  assert.deepEqual(byId.j1.courses, ['Databases']);
  assert.equal(byId.j2.decidedBy, 'model');
  assert.deepEqual(byId.j2.courses, ['Distributed Systems']);
});

/* ---------- 5. Cancellation (`job.control` & `job.cancel`), context dispose, and English i18n ---------- */

test('cancellation aborts in-flight calls via job.control / job.cancel without overwriting settings.*Pending, and English UI has zero Han', async t => {
  let activeSignal = null;
  const inFlightEntered = Promise.withResolvers();

  const complete = async (_system, _prompt, options = {}) => {
    activeSignal = options.signal;
    inFlightEntered.resolve();
    await new Promise((_, reject) => {
      options.signal?.addEventListener('abort', () => reject(options.signal.reason || Object.assign(new Error('Aborted'), { name: 'AbortError' })), { once: true });
    });
    return '{}';
  };

  const { service } = await createTempService(t, { complete });
  const priorPending = {
    jobId: 'prior-job-1',
    createdAt: '2026-11-18T00:00:00.000Z',
    course: 'Java 八股',
    folders: ['既有分类'],
    suggestions: [{ key: 'source:c1', title: 'Doc 1', currentFolder: null, suggestedFolder: '既有分类' }],
    unmatchedKeys: [],
  };
  await service.store.update(s => {
    s.sources.push({ id: 'c1', title: 'Doc 1', text: '# Doc 1\nBody', courses: ['Java 八股'] });
    s.settings.materialClassifyPending = priorPending;
  });

  const { job } = await service.call('source.folder.classify', { course: 'Java 八股' });
  await inFlightEntered.promise;

  const cancelled = await service.call('job.control', { jobId: job.id, action: 'cancel' });
  assert.equal(cancelled.action, 'cancel');
  assert.equal(activeSignal?.aborted, true, 'in-flight model call signal aborted immediately');

  const settled = await service.call('job.wait', { jobId: job.id });
  assert.equal(settled.status, 'cancelled');
  assert.equal(settled.steps[0].status, 'cancelled');

  const snap = await service.call('snapshot');
  const snapJob = snap.jobs.find(j => j.id === job.id);
  assert.equal(snapJob.contract.status, 'cancelled');
  assert.equal(snapJob.contract.endReason, 'user-cancel');
  assert.deepEqual(snap.settings.materialClassifyPending, priorPending, 'cancelled run never overwrote prior pending proposal');

  // Also test cancelling `material-organize` via `job.cancel`
  const orgEntered = Promise.withResolvers();
  const root2 = await mkdtemp(join(tmpdir(), 'study-org-cancel-'));
  const runtime = createStudyRuntime(root2, {
    complete: async (_sys, _prm, opts = {}) => {
      orgEntered.resolve();
      await new Promise((_, reject) => {
        opts.signal?.addEventListener('abort', () => reject(opts.signal.reason || new Error('Aborted')), { once: true });
      });
      return '{}';
    },
  });
  t.after(async () => {
    await runtime.dispose();
    await rm(root2, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  await runtime.call('source.add', { id: 'o1', title: 'Network Notes', text: '# TCP' });
  const orgStart = await runtime.call('source.organize.start', { sourceIds: ['o1'], uiLanguage: 'en' });
  assert.ok(!HAN_RE.test(orgStart.job.stage), `English stage has no Han: ${orgStart.job.stage}`);
  await orgEntered.promise;

  await runtime.call('job.cancel', { jobId: orgStart.job.id, uiLanguage: 'en' });
  const orgSettled = await runtime.call('job.wait', { jobId: orgStart.job.id, uiLanguage: 'en' });
  assert.equal(orgSettled.status, 'cancelled');
  assert.ok(!HAN_RE.test(orgSettled.stage), `English cancelled stage has no Han: ${orgSettled.stage}`);
  const enSnap = await runtime.call('snapshot', { uiLanguage: 'en' });
  assert.equal(enSnap.settings.materialOrganizePending, undefined);
  const enJob = enSnap.jobs.find(j => j.id === orgStart.job.id);
  assert.ok(!HAN_RE.test(JSON.stringify(enJob)), 'English snapshot job has zero Han characters');

  // Verify English refusal localization has zero Han
  await assert.rejects(
    runtime.call('source.folder.classify', { course: 'MissingCourse', uiLanguage: 'en' }),
    err => !HAN_RE.test(err.message) && /No materials available/i.test(err.message),
  );
});
