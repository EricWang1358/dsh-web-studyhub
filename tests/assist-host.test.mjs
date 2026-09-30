import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { startAssist, assistView, clearAssist } from '../lib/assist.js';
import { createHostHandler } from '../lib/host.js';
import { runCorrectionAgent } from '../lib/live-correction-agent.js';
import { LiveSession, register, unregister } from '../lib/live.js';
import { GeminiTiers } from '../lib/gemini.js';
import { runGenerationAgent } from '../lib/generation-agent.js';
import { backgroundCapability, startBoundedChild } from '../lib/host-capabilities.js';

const evidence = 'Bridge separates an abstraction from its implementation so the two can vary independently.';
const card = { id: 'c', kind: 'flashcard', topic: 'Bridge', objective: 'Explain Bridge', prompt: 'What does Bridge separate?', answer: 'Abstraction and implementation.', hint: 'Two dimensions.', explanation: 'Both vary independently.', misconception: 'It adapts interfaces.', citations: [{ sourceId: 's', quote: evidence }] };
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const until = async predicate => { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error('Task did not settle'); };
function desktopHost(cwd, output, { failure, delayedCreation } = {}) {
  const calls = { created: [], started: [], disposed: [] };
  const coordinator = { id: 'coordinator' };
  const agents = { get: () => undefined, create: async spec => {
    calls.created.push(spec);
    await delayedCreation;
    return { agent: coordinator, dispose: async () => calls.disposed.push('coordinator') };
  } };
  const subagents = { getProvider: () => ({ capabilities: { toolFilter: true, agentOptions: true } }),
    start: async (kind, request) => {
      calls.started.push(request);
      assert.equal(kind, 'spawn'); assert.equal(request.parent, coordinator);
      if (failure === 'admission') throw new Error('admission failed');
      return { id: 'desktop-child',
        localAgent: { session: { seq: 1, eventAt: () => ({ type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'model connection failed' } } } }) } },
        result: Promise.resolve({ stopReason: failure ? 'error' : 'completed', output: [{ type: 'text', text: output }] }),
        dispose: async () => calls.disposed.push('child') };
    } };
  const ctx = { sessions: { get: () => ({ header: { cwd } }) },
    get: key => key === 'agents' ? agents : key === 'subagents' ? subagents : undefined };
  return { ctx, calls };
}
async function fixture(t, complete) {
  const root = await mkdtemp(join(tmpdir(), 'study-assist-host-'));
  t.after(async () => { clearAssist(root); await rm(root, { recursive: true, force: true }); });
  const service = new StudyService(root, { complete });
  await service.store.update(s => { s.sources.push({ id: 's', title: 'Lecture', text: evidence }); s.decks.push({ id: 'd', title: 'Patterns', course: 'Software', cards: [structuredClone(card)] }); });
  return { root, service, start: (ctx = {}, extra = {}) => startAssist(ctx, { root, service, sessionId: 'parent', mode: 'ask', ref: { deckId: 'd', cardId: 'c' }, text: 'Explain it', helpChoices: ['example'], card, deckTitle: 'Patterns', route: { provider: 'p', model: 'm' }, ...extra }), task: () => assistView(root).tasks.at(-1) };
}

test('cold desktop help and improvement use real children and release their own coordinator', async t => {
  for (const mode of ['ask', 'improve']) {
    let direct = 0;
    const f = await fixture(t, async () => { direct++; throw new Error('unexpected direct call'); });
    const output = mode === 'ask' ? { answer: 'Two independent dimensions.' } :
      { patch: { explanation: 'Abstraction and implementation vary independently.' }, reason: 'Clarify.' };
    const { ctx, calls } = desktopHost(f.root, JSON.stringify(output));
    const task = await f.start(ctx, { mode, helpChoices: [] });
    assert.equal(task.runtime, 'subagent');
    await until(() => f.task().status !== 'running');
    assert.equal(f.task().status, 'done', f.task().message);
    assert.equal(f.task().childId, 'desktop-child'); assert.equal(direct, 0);
    assert.equal(calls.created.length, 1);
    assert.deepEqual(calls.created[0].agentOptions, { provider: 'p', model: 'm' });
    assert.equal(calls.created[0].meta.cwd, f.root);
    assert.equal(calls.created[0].meta.parentSession, 'parent');
    assert.notEqual(calls.created[0].sessionId, 'parent');
    assert.deepEqual(calls.started[0].toolFilter, { allow: [] });
    assert.deepEqual(calls.disposed, ['child', 'coordinator']);
  }
});

test('cold desktop generation and historical correction use the selected model through child agents', async () => {
  for (const mode of ['generation', 'correction']) {
    const { ctx, calls } = desktopHost(process.cwd(), '{"items":[]}');
    const route = { provider: 'selected', model: 'selected-model' };
    const direct = async () => { throw new Error('unexpected direct call'); };
    const events = [];
    const result = mode === 'generation' ?
      await runGenerationAgent(ctx, route, 'parent', 'system', 'prompt', { jobId: 'job', stage: 'Writing', onEvent: event => events.push(event) }, direct) :
      await runCorrectionAgent(ctx, route, 'parent', 'system', 'prompt', { reasoningEffort: 'default' }, direct);
    assert.equal(result, '{"items":[]}');
    assert.deepEqual(calls.started[0].agentOptions, route);
    assert.deepEqual(calls.disposed, ['child', 'coordinator']);
    if (events.length) assert.equal(events.at(-1).childId, 'desktop-child');
  }
});

test('cold desktop native failures retain terminal diagnostics and never re-run through the direct model', async t => {
  for (const failure of ['admission', 'result']) {
    let direct = 0;
    const f = await fixture(t, async () => { direct++; return '{"answer":"unexpected"}'; });
    const { ctx, calls } = desktopHost(f.root, '{}', { failure });
    await f.start(ctx); await until(() => f.task().status !== 'running');
    assert.equal(f.task().status, 'failed'); assert.equal(direct, 0);
    assert.match(f.task().message, failure === 'admission' ? /admission failed/ : /model connection failed/);
    assert.equal((await f.service.store.read()).decks[0].cards[0].followups, undefined);
    assert.deepEqual(calls.disposed, failure === 'admission' ? ['coordinator'] : ['child', 'coordinator']);
  }
});

test('cancellation releases a coordinator created late without admitting a child', async () => {
  const release = gate();
  const { ctx, calls } = desktopHost(process.cwd(), '{}', { delayedCreation: release.promise });
  const capability = backgroundCapability(ctx, 'parent', { provider: 'p', model: 'm' });
  const controller = new AbortController();
  const work = startBoundedChild(capability.subagents, { signal: controller.signal }, capability);
  await until(() => calls.created.length === 1);
  controller.abort(new Error('cancelled'));
  await assert.rejects(work, /cancelled/);
  release.resolve(); await until(() => calls.disposed.length === 1);
  assert.equal(calls.started.length, 0); assert.deepEqual(calls.disposed, ['coordinator']);
});

test('a persisted desktop session supplies workspace metadata without resuming its chat', async () => {
  const { ctx, calls } = desktopHost(process.cwd(), '{}');
  const original = ctx.get;
  ctx.sessions.get = () => undefined;
  ctx.get = key => key === 'sessionPersistence' ? { stat: async () => ({ header: { cwd: process.cwd() } }) } : original(key);
  const capability = backgroundCapability(ctx, 'parent', { provider: 'p', model: 'm' });
  const run = await startBoundedChild(capability.subagents, { signal: new AbortController().signal }, capability);
  await run.result; await run.dispose();
  assert.equal(calls.created[0].meta.cwd, process.cwd());
  assert.deepEqual(calls.disposed, ['child', 'coordinator']);
});

test('cold desktop cancellation drains a late admitted child before disposing its coordinator', async () => {
  const release = gate();
  const { ctx, calls } = desktopHost(process.cwd(), '{}');
  const capability = backgroundCapability(ctx, 'parent', { provider: 'p', model: 'm' });
  const original = capability.subagents.start;
  let admitting = false;
  capability.subagents.start = async (...args) => { admitting = true; await release.promise; return original(...args); };
  const controller = new AbortController();
  const work = startBoundedChild(capability.subagents, { signal: controller.signal }, capability);
  await until(() => admitting);
  controller.abort(new Error('cancelled'));
  await assert.rejects(work, /cancelled/);
  assert.deepEqual(calls.disposed, []);
  release.resolve(); await until(() => calls.disposed.length === 2);
  assert.deepEqual(calls.disposed, ['child', 'coordinator']);
});

test('background assist accepts unescaped line breaks in model JSON without another request', async t => {
  const answer = 'First explain the abstraction.\n\nThen explain the implementation.\tBoth vary independently.';
  const raw = '{"answer":"' + answer + '","summary":"已追加解答。"}';
  let count = 0;
  const f = await fixture(t, async () => { count++; return raw; });
  const schedule = { repetitions: 1, interval_days: 1, ease_factor: 2.5, due_at: '2026-10-01T05:52:00.000Z' };
  await f.service.store.update(state => { state.decks[0].cards[0].review = schedule; });
  await f.start();
  await until(() => f.task().status !== 'running');
  assert.equal(f.task().status, 'done', f.task().message);
  assert.equal(count, 1);
  const state = await f.service.store.read();
  assert.equal(state.decks[0].cards[0].followups[0].answer, answer);
  assert.deepEqual(state.decks[0].cards[0].review, schedule);
});

test('desktop without a running parent saves help in the background and sends the normal inbox letter', async t => {
  const release = gate(); let options;
  const f = await fixture(t, async (_s, prompt, opts) => { options = opts; assert.match(prompt, /Both vary independently/); await release.promise; return JSON.stringify({ answer: 'Think of two independent dimensions.', summary: '已追加解答。' }); });
  const task = await f.start();
  assert.equal(task.status, 'running'); assert.equal(task.runtime, 'direct');
  release.resolve(); await until(() => f.task().status !== 'running');
  assert.equal(f.task().status, 'done'); assert.equal(options.task, 'assist');
  const state = await f.service.store.read();
  assert.equal(state.decks[0].cards[0].followups[0].answer, 'Think of two independent dimensions.');
  assert.equal(state.inbox.at(-1).kind, 'followup');
});

test('native admission failure terminates accurately and never invokes the direct fallback', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return '{}'; });
  const ctx = { get: key => key === 'agents' ? { get: () => ({}) } : { getProvider: () => ({ capabilities: { toolFilter: true, agentOptions: true } }), start: async () => { throw new Error('provider admission failed'); } } };
  await f.start(ctx); await until(() => f.task().status !== 'running');
  assert.equal(f.task().status, 'failed'); assert.match(f.task().message, /provider admission failed/); assert.equal(calls, 0);
});

test('timeout and concurrent card edits reject late results without changing the library', async t => {
  for (const mode of ['timeout', 'edit']) {
    const release = gate();
    const f = await fixture(t, async () => { await release.promise; return JSON.stringify({ answer: 'Obsolete answer.' }); });
    await f.start({}, mode === 'timeout' ? { timeoutMs: 15 } : {});
    if (mode === 'edit') await f.service.call('card.update', { deckId: 'd', cardId: 'c', patch: { explanation: 'A newer explanation.' } });
    else await until(() => f.task().status === 'failed');
    release.resolve(); await until(() => f.task().status === 'failed');
    await new Promise(r => setTimeout(r, 20));
    assert.equal((await f.service.store.read()).decks[0].cards[0].followups?.length || 0, 0);
  }
});

test('an unchanged library snapshot still delivers the latest failed assist status', async t => {
  const release = gate();
  const f = await fixture(t, async () => { await release.promise; throw new Error('model unavailable'); });
  const ctx = { sessions: { get: () => ({ header: { cwd: f.root } }) }, get: () => undefined };
  const handle = createHostHandler(ctx, { libraryRoot: f.root });
  await f.start();
  const first = await handle('call', { sessionId: 'parent', action: 'snapshot' });
  release.resolve(); await until(() => f.task().status === 'failed');
  const next = await handle('call', { sessionId: 'parent', action: 'snapshot', args: { since: first.value.fingerprint } });
  assert.equal(next.value.unchanged, undefined); assert.equal(next.value.assist[0].status, 'failed');
});

test('historical transcript correction uses a bounded direct request when the host has no native parent', async () => {
  let calls = 0;
  const result = await runCorrectionAgent({}, { provider: 'p', model: 'm' }, 'parent', 'system', 'prompt', {}, async () => { calls++; return '{"items":[]}'; });
  assert.equal(result, '{"items":[]}'); assert.equal(calls, 1);
});

test('native help uses the selected route, no tools, commits a validated change and preserves undo', async t => {
  let dispatched, disposed = 0, fallback = 0;
  const f = await fixture(t, async () => { fallback++; return '{}'; });
  const ctx = { get: key => key === 'agents' ? { get: () => ({ id: 'parent' }) } : {
    getProvider: () => ({ capabilities: { toolFilter: true, agentOptions: true } }),
    start: async (_kind, request) => { dispatched = request; return { id: 'native-child', result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: JSON.stringify({ patch: { explanation: 'Abstraction and implementation vary independently.' }, reason: 'Clarified the two dimensions.' }) }] }), dispose: async () => { disposed++; } }; },
  } };
  await f.start(ctx, { mode: 'improve', helpChoices: [], text: 'Clarify the explanation' });
  await until(() => f.task().status !== 'running');
  assert.equal(f.task().status, 'done'); assert.equal(f.task().childId, 'native-child');
  assert.deepEqual(dispatched.toolFilter.allow, []); assert.deepEqual(dispatched.agentOptions, { provider: 'p', model: 'm' });
  assert.equal(disposed, 1); assert.equal(fallback, 0);
  assert.match((await f.service.store.read()).decks[0].cards[0].explanation, /Abstraction/);
  await f.service.call('card.revert', { deckId: 'd', cardId: 'c' });
  assert.equal((await f.service.store.read()).decks[0].cards[0].explanation, card.explanation);
});

test('requested prerequisites can link and create; invalid or unrequested proposals commit nothing', async t => {
  for (const kind of ['existing', 'new', 'unrequested', 'invalid']) {
    const prereq = { ...card, prompt: 'Which two dimensions can vary independently?', objective: 'Name independent dimensions' };
    delete prereq.id;
    const f = await fixture(t, async () => JSON.stringify({ answer: 'The abstraction is independent.', prerequisites:
      kind === 'existing' ? [{ requires: { deckId: 'd', cardId: 'existing' } }] : [{ card: { ...prereq, ...(kind === 'invalid' ? { citations: [{ sourceId: 'missing', quote: evidence }] } : {}) } }] }));
    if (kind === 'existing') await f.service.store.update(s => s.decks[0].cards.push({ ...prereq, id: 'existing' }));
    await f.start({}, { helpChoices: kind === 'unrequested' ? ['example'] : ['prerequisite'] });
    await until(() => f.task().status !== 'running');
    const state = await f.service.store.read();
    if (['existing', 'new'].includes(kind)) {
      assert.equal(f.task().status, 'done', f.task().message);
      assert.equal(state.decks[0].cards.length, 2);
      assert.equal(state.decks[0].cards[0].requires.length, 1);
      assert.equal(state.decks[0].cards[0].followups.length, 1);
    } else {
      assert.equal(f.task().status, 'failed'); assert.equal(state.decks[0].cards.length, 1);
      assert.equal(state.decks[0].cards[0].followups, undefined); assert.equal(state.inbox.length, 0);
    }
  }
});

test('missing route-override or tool restriction capability uses direct help without starting a child', async t => {
  for (const capabilities of [{ toolFilter: false, agentOptions: true }, { toolFilter: true, agentOptions: false }]) {
    let spawned = 0;
    const f = await fixture(t, async () => '{"answer":"Direct help."}');
    const ctx = { get: key => key === 'agents' ? { get: () => ({}) } : { getProvider: () => ({ capabilities }), start: () => { spawned++; } } };
    await f.start(ctx); await until(() => f.task().status !== 'running');
    assert.equal(f.task().runtime, 'direct'); assert.equal(f.task().status, 'done'); assert.equal(spawned, 0);
  }
});

test('native timeout discards output and disposes even a child admitted after timeout', async t => {
  for (const phase of ['admission', 'result']) {
    let disposed = 0, calls = 0;
    const release = gate();
    const f = await fixture(t, async () => { calls++; return '{}'; });
    const ctx = { get: key => key === 'agents' ? { get: () => ({}) } : {
      getProvider: () => ({ capabilities: { toolFilter: true, agentOptions: true } }), start: async () => {
        if (phase === 'admission') await release.promise;
        return { id: 'late-child', result: phase === 'result' ? release.promise : Promise.resolve({ stopReason: 'completed', output: [] }), dispose: async () => { disposed++; } };
      },
    } };
    await f.start(ctx, { timeoutMs: 10 }); await until(() => f.task().status === 'failed');
    release.resolve({ stopReason: 'completed', output: [{ type: 'text', text: '{"answer":"Late"}' }] });
    await until(() => disposed === 1);
    assert.equal(calls, 0); assert.equal((await f.service.store.read()).inbox.length, 0);
  }
});

test('service language wrappers preserve background correction and Gemini never invokes the host child', async t => {
  let hostCalls = 0, geminiCalls = 0;
  const complete = Object.assign(async () => '{}', { spawnCorrection: async () => { hostCalls++; return '{"items":[]}'; } });
  const f = await fixture(t, complete);
  assert.equal(typeof f.service.complete.spawnCorrection, 'function');
  assert.equal(typeof f.service.light.spawnCorrection, 'function');
  for (const textProvider of ['host', 'gemini']) {
    f.service.audioSettings = async () => ({ textProvider, liveCorrectionReasoning: 'low', liveTranslateModel: 'test-model', freeKey: 'test-key' });
    f.service.fetch = async () => { geminiCalls++; return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"items":[]}' }] } }] }), { status: 200 }); };
    const session = new LiveSession({ id: textProvider, tiers: new GeminiTiers({}), save: async () => {}, saved: { segments: [{ id: 1, en: 'Old sentence.', zh: '旧句。' }], correction: { tasks: [{ id: 'correction', status: 'failed', attempts: 0, ids: [1], evidenceIds: [1], reason: 'Check wording.' }] } } });
    register(f.root, session);
    t.after(async () => { await session.retirePersistence(); unregister(f.root, session.id); });
    await f.service.call('live.correct.background', { id: session.id });
    await session.correction.settled();
    assert.equal(session.correction.tasks[0].status, 'done', session.correction.tasks[0].error);
  }
  assert.equal(hostCalls, 1); assert.equal(geminiCalls, 1);
});
