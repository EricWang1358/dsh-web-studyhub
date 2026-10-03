import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { createAssistService } from '../lib/assist.js';
import { createHostHandler } from '../lib/host.js';
import { runCorrectionAgent } from '../lib/live-correction-agent.js';
import { LiveSession } from '../lib/live.js';
import { GeminiTiers } from '../lib/gemini.js';
import { runGenerationAgent } from '../lib/generation-agent.js';
import { backgroundCapability, startBoundedChild } from '../lib/host-capabilities.js';
import { createAssistChildren } from '../lib/assist-child.js';

const evidence = 'Bridge separates an abstraction from its implementation so the two can vary independently.';
test('native initial and reused help omit embedded raster bytes without changing the saved card', async t => {
  const f = await fixture(t, async () => { throw new Error('unexpected direct call'); });
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1kAAAAASUVORK5CYII=';
  await f.service.store.update(s => { s.decks[0].cards[0].prompt += ` ![diagram](${image})`; });
  const { ctx, calls } = reusableHost(f.root);
  await f.start(ctx); await until(() => f.task().status !== 'running');
  assert.equal(f.task().status, 'done', f.task().message);
  const first = calls.started[0].prompt[0].text;
  assert.doesNotMatch(first, /iVBOR|data:image/); assert.match(first, /do not infer/);
  await f.start(ctx, { text: `Explain this ![diagram](${image})` });
  await until(() => f.task().status !== 'running');
  assert.equal(f.task().status, 'done', f.task().message);
  assert.equal(calls.followups.length, 1);
  const followup = JSON.stringify(calls.followups[0]);
  assert.doesNotMatch(followup, /iVBOR|data:image/); assert.match(followup, /omitted/);
  assert.ok((await f.service.store.read()).decks[0].cards[0].prompt.includes(image));
});
const card = { id: 'c', kind: 'flashcard', topic: 'Bridge', objective: 'Explain Bridge', prompt: 'What does Bridge separate?', answer: 'Abstraction and implementation.', hint: 'Two dimensions.', explanation: 'Both vary independently.', misconception: 'It adapts interfaces.', citations: [{ sourceId: 's', quote: evidence }] };
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const until = async predicate => { for (let i = 0; i < 200; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error('Task did not settle'); };
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

function reusableHost(cwd) {
  const calls = { created: [], started: [], disposed: [], followups: [], children: [] };
  const agents = { get: () => undefined, create: async spec => {
    calls.created.push(spec);
    return { agent: { id: 'coordinator' }, dispose: async () => calls.disposed.push('coordinator') };
  } };
  const subagents = { getProvider: () => ({ capabilities: { toolFilter: true, agentOptions: true } }), start: async (_, request) => {
    const childId = `child-${calls.started.length + 1}`, events = [];
    calls.started.push(request);
    const session = { get seq() { return events.length; }, eventAt: at => events[at], snapshotEvents: from => events.slice(from) };
    const child = { status: 'idle', session, cancel: () => {},
      followup: message => {
        calls.followups.push({ childId, message });
        events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '{"answer":"The same teacher explains the follow-up."}' }] } } },
          { type: 'turn/end', data: { reason: { kind: 'completed' } } });
      }, whenIdle: async () => {} };
    calls.children.push(child);
    return { id: childId, localAgent: child, result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: '{"answer":"First explanation."}' }] }),
      dispose: async () => calls.disposed.push(childId) };
  } };
  const ctx = { sessions: { get: () => ({ header: { cwd } }) }, get: key => key === 'agents' ? agents : key === 'subagents' ? subagents : undefined };
  return { ctx, calls };
}
async function fixture(t, complete) {
  const root = await mkdtemp(join(tmpdir(), 'study-assist-host-'));
  const children = createAssistChildren(), assist = createAssistService({ children });
  t.after(async () => { assist.dispose(); await rm(root, { recursive: true, force: true }); });
  const service = new StudyService(root, { complete });
  await service.store.update(s => { s.sources.push({ id: 's', title: 'Lecture', text: evidence }); s.decks.push({ id: 'd', title: 'Patterns', course: 'Software', cards: [structuredClone(card)] }); });
  return { root, service, assist, children, start: (ctx = {}, extra = {}) => assist.startAssist(ctx, { root, service, sessionId: 'parent', mode: 'ask', ref: { deckId: 'd', cardId: 'c' }, text: 'Explain it', helpChoices: ['example'], card, deckTitle: 'Patterns', route: { provider: 'p', model: 'm' }, ...extra }), task: () => assist.assistView(root).tasks.at(-1) };
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

test('same-question help reuses the existing idle native child and keeps replies out of the parent', async t => {
  const f = await fixture(t, async () => { throw new Error('unexpected direct call'); });
  const { ctx, calls } = reusableHost(f.root);
  await f.start(ctx, { text: 'Explain the separation' });
  await until(() => f.task().status === 'done');
  const first = f.task();
  assert.deepEqual(calls.disposed, [], 'the idle teacher should remain available briefly');
  await f.start(ctx, { text: 'Use another example' });
  await until(() => f.task().status === 'done');
  assert.equal(calls.started.length, 1, 'same question must not spawn another child');
  assert.equal(calls.created.length, 1);
  assert.equal(f.task().childId, first.childId);
  assert.equal(f.task().reused, true);
  assert.equal(calls.followups.length, 1);
  assert.match(calls.followups[0].message.content[0].text, /Use another example/);
  assert.ok(!calls.followups[0].message.content[0].text.includes(evidence), 'stable evidence should not be resent');
  assert.deepEqual(calls.started[0].toolFilter, { allow: [] });
  assert.equal((await f.service.store.read()).decks[0].cards[0].followups.length, 2);
  f.assist.clearAssist(f.root);
  await until(() => calls.disposed.length === 2);
});

test('simultaneous same-question requests serialize through one child and save distinct answers', async t => {
  const f = await fixture(t, async () => {}), { ctx, calls } = reusableHost(f.root);
  await Promise.all([f.start(ctx, { text: 'First question' }), f.start(ctx, { text: 'Second question' })]);
  await until(() => f.assist.assistView(f.root).tasks.every(task => task.status === 'done'));
  assert.equal(calls.started.length, 1);
  assert.equal(calls.followups.length, 1);
  assert.equal((await f.service.store.read()).decks[0].cards[0].followups.length, 2);
});

test('changed content, evidence, model, language or card starts a fresh teacher', async t => {
  const f = await fixture(t, async () => {}), { ctx, calls } = reusableHost(f.root);
  const finish = async extra => { await f.start(ctx, extra); await until(() => f.task().status !== 'running'); assert.equal(f.task().status, 'done', f.task().message); };
  await finish();
  await f.service.call('card.update', { deckId: 'd', cardId: 'c', patch: { explanation: 'Updated interpretation.' } });
  await finish();
  await f.service.store.update(state => { state.sources[0].text += ' Extra source context.'; });
  await finish();
  await finish({ route: { provider: 'p', model: 'another' } });
  await finish({ route: { provider: 'p', model: 'another' }, language: 'en' });
  await f.service.store.update(state => state.decks[0].cards.push({ ...card, id: 'other' }));
  await finish({ ref: { deckId: 'd', cardId: 'other' }, card: { ...card, id: 'other' } });
  assert.equal(calls.started.length, 6);
  assert.equal(calls.followups.length, 0);
  assert.equal(calls.disposed.filter(value => value.startsWith('child')).length, 5);
});

test('teacher reuse expires after two idle minutes and rotates after eight turns', async t => {
  const f = await fixture(t, async () => {}), { ctx, calls } = reusableHost(f.root);
  const finish = async () => { await f.start(ctx); await until(() => f.task().status === 'done'); };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await f.start(ctx);
  // Let filesystem work settle before advancing only the idle timer.
  while (f.task().status === 'running') await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(120001);
  t.mock.timers.reset();
  await until(() => calls.disposed.length === 2);
  for (let turn = 0; turn < 8; turn++) await finish();
  assert.equal(calls.started.length, 2);
  assert.equal(calls.followups.length, 7);
  assert.equal(calls.disposed.filter(value => value.startsWith('child')).length, 2);
  await finish();
  assert.equal(calls.started.length, 3);
});

test('only four idle teachers remain and plugin disposal releases their handles', async t => {
  const f = await fixture(t, async () => {}), hosts = Array.from({ length: 5 }, () => reusableHost(f.root));
  for (const { ctx } of hosts) { await f.start(ctx); await until(() => f.task().status === 'done'); }
  await until(() => hosts[0].calls.disposed.length === 2);
  for (const host of hosts.slice(1)) { assert.equal(host.calls.disposed.length, 0); f.children.disposeAssistChildren(host.ctx); }
  await until(() => hosts.every(host => host.calls.disposed.length === 2));
});

test('fresh teachers and direct fallback receive bounded durable question-answer history', async t => {
  let payload;
  const f = await fixture(t, async (system, input) => { payload = JSON.parse(input); return '{"answer":"Direct continuation."}'; });
  for (let i = 0; i < 5; i++) await f.service.call('card.followup.add', { deckId: 'd', cardId: 'c', question: `Earlier question ${i}`, answer: `Earlier answer ${i}` });
  await f.start();
  await until(() => f.task().status === 'done');
  assert.deepEqual(payload.history.map(item => item.question), ['Earlier question 2', 'Earlier question 3', 'Earlier question 4']);
});

test('a follow-up with no new completed output never saves the previous answer again', async t => {
  const f = await fixture(t, async () => {}), { ctx, calls } = reusableHost(f.root);
  await f.start(ctx); await until(() => f.task().status === 'done');
  calls.children[0].followup = () => {};
  await f.start(ctx, { text: 'A second question' });
  await until(() => f.task().status === 'failed');
  assert.equal((await f.service.store.read()).decks[0].cards[0].followups.length, 1);
  await until(() => calls.disposed.length === 2);
  await f.start(ctx); await until(() => f.task().status === 'done');
  assert.equal(calls.started.length, 2);
});

test('timed-out reused children discard late output, release handles and are not reused again', async t => {
  const f = await fixture(t, async () => {}), { ctx, calls } = reusableHost(f.root);
  await f.start(ctx); await until(() => f.task().status === 'done');
  const release = gate(); let cancelled = 0;
  calls.children[0].whenIdle = () => release.promise;
  calls.children[0].cancel = () => { cancelled++; };
  await f.start(ctx, { text: 'Slow follow-up', timeoutMs: 15 });
  await until(() => f.task().status === 'failed');
  release.resolve();
  await until(() => calls.disposed.length === 2);
  assert.equal(cancelled, 1);
  assert.equal((await f.service.store.read()).decks[0].cards[0].followups.length, 1);
  await f.start(ctx); await until(() => f.task().status === 'done');
  assert.equal(calls.started.length, 2);
});

test('one-shot fallback completion awaits actual asynchronous handle disposal', async t => {
  const f = await fixture(t, async () => {}), release = gate();
  const ctx = { get: key => key === 'agents' ? { get: () => ({ id: 'parent' }) } : {
    getProvider: () => ({ capabilities: { toolFilter: true, agentOptions: true } }),
    start: async () => ({ id: 'child', result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: '{"answer":"An answer."}' }] }), dispose: () => release.promise }),
  } };
  await f.start(ctx);
  await until(async () => (await f.service.store.read()).decks[0].cards[0].followups?.length === 1);
  assert.equal(f.task().status, 'running');
  release.resolve();
  await until(() => f.task().status === 'done');
});

test('plugin shutdown cancels a retired active teacher and prevents late result saving', async t => {
  const f = await fixture(t, async () => {}), { ctx, calls } = reusableHost(f.root);
  let cleanup;
  ctx.effect = setup => { cleanup = setup(); };
  createHostHandler(ctx, {}, undefined, { assist: f.assist });
  const release = gate(), save = f.service.saveAssistResult.bind(f.service);
  let waiting = false;
  f.service.saveAssistResult = async args => { waiting = true; await release.promise; return save(args); };
  await f.start(ctx);
  await until(() => waiting);
  await f.service.store.update(state => state.decks[0].cards.push({ ...card, id: 'other' }));
  await f.start(ctx, { ref: { deckId: 'd', cardId: 'other' }, card: { ...card, id: 'other' } });
  await until(() => calls.started.length === 2);
  cleanup();
  release.resolve();
  await until(() => f.assist.assistView(f.root).tasks.every(task => task.status === 'failed'));
  await until(() => calls.disposed.length === 4);
  assert.ok((await f.service.store.read()).decks[0].cards.every(item => !item.followups?.length));
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
  const handle = createHostHandler(ctx, { libraryRoot: f.root }, undefined, { assist: f.assist });
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

test('a reply the validator refuses is sent back once with the reason and fixed without the learner resubmitting; a second refusal fails the task', async t => {
  const prereq = { ...card, prompt: 'Which two dimensions can vary independently?', objective: 'Name independent dimensions' };
  delete prereq.id;
  const bad = { answer: 'The abstraction is independent.', prerequisites: [{ card: { ...prereq, citations: [{ sourceId: 'missing', quote: evidence }] } }] };
  const good = { answer: 'The abstraction is independent.', prerequisites: [{ card: prereq }] };
  for (const [name, replies, status, calls] of [['fixed on the second reply', [bad, good], 'done', 2], ['refused twice', [bad, bad], 'failed', 2]]) {
    const seen = [];
    const f = await fixture(t, async (system, payload) => { seen.push({ system, payload }); return JSON.stringify(replies[Math.min(seen.length - 1, replies.length - 1)]); });
    await f.start({}, { helpChoices: ['prerequisite'] });
    await until(() => f.task().status !== 'running');
    const state = await f.service.store.read();
    assert.equal(f.task().status, status, `${name}: ${f.task().message}`);
    assert.equal(seen.length, calls, `${name}: exactly one retry, never a loop`);
    assert.match(seen[1].payload, /REFUSED_REPLY/, 'the refused reply goes back');
    assert.match(seen[1].payload, /REASON/, 'with the reason');
    assert.equal(f.task().repaired, true);
    if (status === 'done') { assert.equal(state.decks[0].cards.length, 2); assert.equal(state.decks[0].cards[0].followups.length, 1); }
    else { assert.equal(state.decks[0].cards.length, 1); assert.equal(state.decks[0].cards[0].followups, undefined); }
  }
});

test('修题 never turns a plain question into a half cloze: a stem with {{blank}} markers on a non-cloze card is refused, repaired once, and the card stays a plain question', async t => {
  const broken = { patch: { prompt: 'Bridge separates two things. The two are {{blank}}.', answer: 'Abstraction and implementation.' }, reason: 'Turned the question into a fill-in' };
  const fixed = { patch: { prompt: 'Which two dimensions does Bridge separate, and why does that help?', answer: 'Abstraction and implementation, so each varies independently.' }, reason: 'Made the stem a complete question' };
  for (const [name, replies, status] of [['repaired on the second reply', [broken, fixed], 'done'], ['refused twice', [broken, broken], 'failed']]) {
    const seen = [];
    const f = await fixture(t, async (system, payload) => { seen.push({ system, payload }); return JSON.stringify(replies[Math.min(seen.length - 1, replies.length - 1)]); });
    await f.start({}, { mode: 'improve', helpChoices: [], text: 'Make the question clearer' });
    await until(() => f.task().status !== 'running');
    const state = await f.service.store.read();
    assert.equal(f.task().status, status, `${name}: ${f.task().message}`);
    assert.doesNotMatch(state.decks[0].cards[0].prompt, /\{\{/, `${name}: the stored stem has no blank markers`);
    assert.equal(state.decks[0].cards[0].kind, 'flashcard');
    assert.match(seen[0].system, /Never convert|do not convert/i, 'the instruction forbids changing the kind');
    assert.match(seen[0].system, /\{\{/, 'and names the marker so the model knows what is refused');
    if (status === 'done') assert.match(state.decks[0].cards[0].prompt, /Which two dimensions/);
    else assert.equal(state.decks[0].cards[0].prompt, card.prompt, `${name}: nothing was changed`);
  }
});

test('出成题: a Q&A or a typed knowledge point becomes one new question, as a prerequisite (linked) or on its own, validated like every other card', async t => {
  const spec = { ...card, prompt: 'Which two dimensions can vary independently in Bridge?', objective: 'Name independent dimensions' }; delete spec.id;
  const asked = [];
  const cases = [
    ['from a Q&A, as a prerequisite', { derive: { relation: 'prerequisite', followupId: 'fu1' }, text: '' }, { card: spec }, 'done', 2, true],
    ['from a typed point, standalone', { derive: { relation: 'standalone' }, text: 'Why does Bridge help?' }, { card: spec }, 'done', 2, false],
    ['a duplicate of the current question is refused', { derive: { relation: 'standalone' }, text: 'x' }, { card: { ...spec, prompt: card.prompt } }, 'failed', 1, false],
    ['a stem with blank markers is refused', { derive: { relation: 'standalone' }, text: 'x' }, { card: { ...spec, prompt: 'Two are {{blank}}.' } }, 'failed', 1, false],
    ['a vague point is answered with noChange and nothing is created', { derive: { relation: 'prerequisite' }, text: 'stuff' }, { noChange: 'The point is too vague to make a question.' }, 'done', 1, false],
  ];
  for (const [name, args, reply, status, cards, linked] of cases) {
    const f = await fixture(t, async (system, payload) => { asked.push(payload); return JSON.stringify(reply); });
    await f.service.store.update(s => { s.decks[0].cards[0].followups = [{ id: 'fu1', question: 'What is a bridge?', answer: 'It separates two dimensions so each varies independently.', digest: undefined }]; });
    const digestFix = await f.service.store.read();
    await f.start({}, { mode: 'derive', helpChoices: [], ...args });
    await until(() => f.task().status !== 'running');
    const state = await f.service.store.read();
    assert.equal(f.task().status, status, `${name}: ${f.task().message}`);
    assert.equal(state.decks[0].cards.length, cards, `${name}: cards`);
    assert.equal(Boolean(state.decks[0].cards[0].requires?.length), linked, `${name}: link`);
    if (status === 'done' && cards === 2) assert.equal(state.decks[0].cards[1].prompt, spec.prompt);
    assert.ok(digestFix);
  }
  assert.match(asked[0], /What is a bridge\?/, 'the Q&A reaches the model as the basis');
});

test('the task remembers what was asked (choices and the learner own question) so a failed one can be sent again or edited', async t => {
  const f = await fixture(t, async () => '{"answer":"x"}');
  await f.start({}, { helpChoices: ['example', 'prerequisite'], text: 'Why does retry amplify load?' });
  await until(() => f.task().status !== 'running');
  assert.deepEqual(f.task().choices, ['example', 'prerequisite']);
  assert.equal(f.task().question, 'Why does retry amplify load?');
});

test('a prerequisite that points at a question that is not there (or at the question itself) is skipped: the explanation is still saved and the task still completes', async t => {
  for (const [kind, requires] of [['ghost', { deckId: 'd', cardId: '6b18fba5-81f3-430c-81ea-bb817048ee41' }], ['no-deck', { cardId: 'nowhere' }], ['self', { deckId: 'd', cardId: 'c' }]]) {
    const f = await fixture(t, async () => JSON.stringify({ answer: 'The abstraction is independent.', prerequisites: [{ requires }] }));
    await f.start({}, { helpChoices: ['prerequisite'] });
    await until(() => f.task().status !== 'running');
    const state = await f.service.store.read();
    assert.equal(f.task().status, 'done', `${kind}: ${f.task().message}`);
    assert.equal(state.decks[0].cards.length, 1, `${kind}: nothing invented`);
    assert.equal(state.decks[0].cards[0].requires ?? undefined, undefined, `${kind}: no link was made`);
    assert.equal(state.decks[0].cards[0].followups.length, 1, `${kind}: the explanation was kept`);
    assert.match(f.task().message, /前置题.*(略过|没有保存)|prerequisite/i, `${kind}: it says so`);
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
    f.service.runtime.liveSessions.register(f.root, session);
    t.after(async () => { await session.retirePersistence(); f.service.runtime.liveSessions.unregister(f.root, session.id); });
    await f.service.call('live.correct.background', { id: session.id });
    await session.correction.settled();
    assert.equal(session.correction.tasks[0].status, 'done', session.correction.tasks[0].error);
  }
  assert.equal(hostCalls, 1); assert.equal(geminiCalls, 1);
});
