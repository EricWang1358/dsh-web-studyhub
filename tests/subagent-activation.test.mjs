import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { runGenerationAgent } from '../lib/generation-agent.js';
import { runCorrectionAgent } from '../lib/live-correction-agent.js';
import { backgroundCapability, startBoundedChild } from '../lib/host-capabilities.js';
import { subagentApi, boundChildTools, startWorker, WORKER_PRESET } from '../lib/subagent-api.js';
import { foldSessionUsage } from '../lib/token-usage.js';

/*
 * DSH 0.2.1-rc.2 rewrote the sub-agent API (@deepseek-ai/dsh-subagent lib/index.js:3036 startActivation,
 * :3133 drainChildren; start / startContinuable / drainContinuableChildren are gone) and the spawn provider's
 * capabilities are { agentOptions, agentPreset, outputSchema, depthLimit } (no toolFilter, no persona).
 * Before this fix every StudyHub child silently fell back to direct model calls on such a host.
 * The fake below follows that API: a receipt { childId, messageId, result, dispose }, the result arriving after
 * DSH has torn the settled child down, and the child announced through `agent/created` before its first prompt.
 */
function activationHost({ observe = true, stopReason = 'completed', text = '{"ok":true}', presets = true, inherits = false, desktop = false, teacher = false } = {}) {
  const listeners = new Set(), calls = { start: [], disposed: 0, messages: [] }, created = [], followups = [];
  const tools = { restricted: [], mode: undefined, restrict(filter) { this.restricted.push(filter); return () => {}; }, presentAs(mode) { this.mode = mode; } };
  const parent = { id: 'learner' };
  const live = new Map(desktop ? [] : [[parent.id, parent]]);
  const usageEvent = { type: 'assistant/usage', data: {} };
  const subagents = {
    getProvider: () => ({ name: 'spawn', inheritsParentContext: inherits, prepareContinuable() {},
      capabilities: { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true } }),
    async startActivation(spec) {
      calls.start.push(spec);
      spec.signal.throwIfAborted(); // dsh-subagent 0.2.1 startLocal, unguarded
      const child = { id: spec.childId, status: 'running', ctx: { get: name => name === 'tools' ? tools : undefined },
        session: { seq: 2, eventAt: seq => [usageEvent, { type: 'turn/end', data: { reason: { kind: stopReason,
          ...(stopReason === 'error' ? { error: { code: 'NO_ADAPTER', message: 'no adapter' } } : {}) } } }][seq] } };
      // A torn-down DSH 0.2.1 Agent still says 'idle' and keeps its teacher methods.
      if (teacher) Object.assign(child, { followup: message => followups.push(message), whenIdle: async () => {}, cancel() {} },
        { session: { ...child.session, snapshotEvents: () => [] } });
      live.set(child.id, child);
      if (observe) for (const listener of listeners) await listener({ agent: child });
      const result = new Promise(resolve => setImmediate(() => {
        live.delete(child.id); // DSH releases a settled child before its result resolves
        child.status = 'idle';
        resolve({ stopReason, output: [{ type: 'text', text }] });
      }));
      return { childId: spec.childId, messageId: 'message-1', result, dispose: async () => { calls.disposed++; } };
    },
    sendMessage: async (sender, target, content) => { calls.messages.push({ sender, target, content }); return 'message-2'; },
  };
  const ctx = {
    on: (name, listener) => { if (name !== 'agent/created') return () => {}; listeners.add(listener); return () => listeners.delete(listener); },
    get: name => name === 'subagents' ? subagents : name === 'agents' ? agents
      : name === 'agentPresets' && presets ? { mount() {} } : undefined,
    // A cold panel: the conversation is not live, its folder is known from the session header.
    ...(desktop ? { sessions: { get: id => id === 'panel' ? { header: { cwd: 'D:/work' } } : undefined } } : {}),
  };
  const agents = { get: id => live.get(id),
    ...(desktop ? { async create(options) { const agent = { id: options.sessionId, meta: options.meta }; created.push(agent);
      return { agent, dispose: async () => {} }; } } : {}) };
  return { ctx, subagents, parent, tools, calls, listeners, created, followups };
}

const route = { provider: 'p', model: 'm' };
const phase = (host, execution = {}) => {
  const events = [];
  let direct = 0;
  const run = runGenerationAgent(host.ctx, route, host.parent.id, 'Assessment editor', 'Evidence',
    { jobId: 'job-12345678', stage: 'Reviewing', onEvent: event => events.push(event), ...execution }, async () => { direct++; return 'direct'; });
  return { run, events, direct: () => direct };
};

test('the API of each host release is told apart', () => {
  assert.equal(subagentApi({ startActivation() {} }), 'activation');
  assert.equal(subagentApi({ start() {} }), 'legacy');
  assert.equal(subagentApi({}), null);
  assert.equal(subagentApi(undefined), null);
});

test('a DSH 0.2.1 host counts as able to run StudyHub children (no silent direct fallback)', () => {
  const host = activationHost();
  const capability = backgroundCapability(host.ctx, host.parent.id, route);
  assert.equal(capability.native, true);
  assert.equal(capability.api, 'activation');
  assert.equal(backgroundCapability(activationHost({ presets: false }).ctx, 'learner', route).native, false, 'needs the preset registry');
  assert.equal(backgroundCapability(activationHost({ inherits: true }).ctx, 'learner', route).native, false, 'a forking provider cannot select a preset');
});

test('a DSH 0.2.0 host keeps its own API', () => {
  const parent = { id: 'learner' };
  const subagents = { start() {}, getProvider: () => ({ capabilities: { toolFilter: true, agentOptions: true } }) };
  const ctx = { get: name => name === 'subagents' ? subagents : name === 'agents' ? { get: () => parent } : undefined };
  const capability = backgroundCapability(ctx, parent.id, route);
  assert.equal(capability.native, true);
  assert.equal(capability.api, 'legacy');
});

test('a plugin-owned phase runs as a tool-less study-worker child whose result never reaches the chat', async () => {
  const host = activationHost({ text: '{"corrections":[]}' });
  const { run, events, direct } = phase(host, { resultOwner: 'plugin' });
  assert.equal(await run, '{"corrections":[]}');
  assert.equal(direct(), 0);
  const [spec] = host.calls.start;
  assert.equal(spec.provider, 'spawn');
  assert.equal(spec.delivery, 'caller', 'the result comes back to StudyHub, not into the conversation');
  assert.equal(spec.request.agentPreset, WORKER_PRESET);
  assert.equal(spec.request.parent, host.parent);
  assert.deepEqual(spec.request.agentOptions, route);
  assert.equal(spec.request.toolFilter, undefined, 'DSH 0.2.1 has no per-request toolFilter');
  assert.equal(spec.request.persona, undefined);
  assert.match(spec.label, /Study job-1234.*Reviewing/);
  assert.deepEqual(host.tools.restricted, [{ allow: [] }], 'host-wide tools are masked on the exact child');
  assert.equal(host.tools.mode, 'native', 'no code-mode transport for the child');
  assert.equal(events.find(event => event.childId)?.childId, spec.childId);
  assert.equal(events.at(-1).status, 'complete');
  assert.equal(host.calls.disposed, 1);
  assert.equal(host.listeners.size, 0, 'the creation listener is removed');
});

test('a conversation-owned phase forwards follow-up requirements to the child through its parent', async () => {
  const host = activationHost();
  let messenger, forwarded;
  const { run, events } = phase(host, { setMessenger: fn => {
    messenger = fn;
    if (fn && !forwarded) forwarded = fn('Use Chinese');
  } });
  assert.equal(await run, '{"ok":true}');
  const [spec] = host.calls.start;
  assert.equal(spec.delivery, 'caller');
  assert.equal(spec.request.agentPreset, WORKER_PRESET);
  assert.doesNotMatch(spec.request.prompt[0].text, /send_message/, 'the worker has no tools to message back with');
  assert.deepEqual(await forwarded, { messageId: 'message-2', childId: spec.childId });
  assert.equal(host.calls.messages[0].sender, host.parent);
  assert.equal(host.calls.messages[0].target, spec.childId);
  assert.equal(host.calls.messages[0].content[0].text, 'Use Chinese');
  assert.equal(messenger, null, 'the messenger is withdrawn when the phase ends');
  assert.ok(events.some(event => event.status === 'running' && event.communication && event.childId === spec.childId));
  assert.equal(events.at(-1).status, 'complete');
});

test('a child whose creation DSH did not announce is stopped instead of running with host tools', async () => {
  const host = activationHost({ observe: false });
  const { run, direct } = phase(host, { resultOwner: 'plugin' });
  await assert.rejects(run, /not observed/);
  assert.equal(host.calls.disposed, 1);
  assert.equal(direct(), 0);
});

test('a failed child keeps the provider error code and is released', async () => {
  for (const resultOwner of ['plugin', undefined]) {
    const host = activationHost({ stopReason: 'error' });
    const { run, events } = phase(host, { resultOwner });
    await assert.rejects(run, error => error.code === 'NO_ADAPTER' && error.modelFailure === true);
    assert.equal(events.at(-1).status, 'failed');
    assert.equal(host.calls.disposed, 1);
  }
});

test('a settled child still hands its events to usage and is never reused as a live teacher', async () => {
  const host = activationHost();
  const capability = backgroundCapability(host.ctx, host.parent.id, route);
  const run = await startBoundedChild(host.subagents, { parent: host.parent, label: 'Assist', signal: new AbortController().signal,
    agentOptions: route, prompt: [{ type: 'text', text: 'Task' }] }, capability);
  assert.equal(run.localAgent?.status, 'running', 'the live child while it runs');
  assert.equal((await run.result).stopReason, 'completed');
  assert.equal(run.localAgent.status, 'settled');
  assert.equal(typeof run.localAgent.followup, 'undefined');
  assert.equal(run.localAgent.session.eventAt(1).type, 'turn/end');
  assert.doesNotThrow(() => foldSessionUsage(run.localAgent.session));
  await run.dispose();
});

/*
 * A cold StudyHub panel (no live chat agent) runs its children under a fresh idle coordinator (the desktop path).
 * A real DSH 0.2.1 Agent that has been torn down still reports status 'idle' and still has followup / whenIdle /
 * cancel (dsh-agent-loop 0.2.1 lib/index.js:790-808), so a settled child must never be handed out as a teacher.
 */
function coldPanelHost() {
  return activationHost({ desktop: true, teacher: true });
}

test('a cold panel (no live chat) never reuses a settled DSH 0.2.1 child as a teacher', async () => {
  const host = coldPanelHost();
  const capability = backgroundCapability(host.ctx, 'panel', route);
  assert.equal(capability.parent, undefined, 'no live chat agent');
  assert.equal(capability.desktop, true);
  assert.equal(capability.native, true);
  const request = () => ({ label: 'Assist', signal: new AbortController().signal, agentOptions: route,
    prompt: [{ type: 'text', text: 'Task' }] });

  const run = await startBoundedChild(host.subagents, request(), capability);
  assert.equal(run.localAgent?.status, 'running', 'the live child while it runs');
  await run.result;
  assert.equal(run.localAgent?.status, 'settled', 'after settlement localAgent is the read-only stub, not the torn-down Agent');
  assert.equal(typeof run.localAgent.followup, 'undefined');
  await run.dispose();

  const { createAssistChildren } = await import('../lib/assist-child.js');
  const children = createAssistChildren();
  const ask = async () => {
    const task = {};
    const raw = await children.withAssistChild(capability, { root: 'r', key: 'card-1', task, reuse: true,
      followupPrompt: [{ type: 'text', text: 'Again' }], request: request(), consume: async raw => raw });
    return { raw, task };
  };
  const first = await ask();
  const second = await ask();
  assert.equal(first.raw, '{"ok":true}');
  assert.equal(second.raw, '{"ok":true}');
  assert.equal(second.task.reused, false, 'the second ask starts a new child');
  assert.notEqual(second.task.childId, first.task.childId);
  assert.equal(host.followups.length, 0, 'followup() is never called on a torn-down child');
  assert.equal(host.calls.start.length, 3);
  children.disposeAssistChildren(host.ctx);
});

test('a worker started without a signal still gets one (DSH 0.2.1 calls signal.throwIfAborted unguarded)', async () => {
  const host = activationHost();
  const run = await startWorker(host.ctx, host.subagents, { parent: host.parent, label: 'Assist', prompt: [{ type: 'text', text: 'Task' }] });
  assert.equal(typeof host.calls.start[0].signal?.throwIfAborted, 'function');
  assert.equal(host.calls.start[0].signal.aborted, false);
  assert.equal((await run.result).stopReason, 'completed');
});

test('live transcript correction runs on a DSH 0.2.1 child too', async () => {
  const host = activationHost({ text: '{"corrections":[],"note":"ok"}' });
  const text = await runCorrectionAgent(host.ctx, route, host.parent.id, 'system', 'prompt', {}, async () => 'direct');
  assert.equal(text, '{"corrections":[],"note":"ok"}');
  assert.equal(host.calls.start[0].request.agentPreset, WORKER_PRESET);
  assert.deepEqual(host.tools.restricted, [{ allow: [] }]);
});

test('installed DSH tools: the mask hides host-wide tools from the exact child only', async (t) => {
  const require = createRequire(import.meta.url);
  let toolsPath;
  try { toolsPath = require.resolve('@deepseek-ai/dsh-tools'); }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    t.skip('Optional DSH host SDK is not installed');
    return;
  }
  const fromTools = createRequire(toolsPath);
  const load = name => import(pathToFileURL(fromTools.resolve(name)).href);
  const [{ Context }, { createScope }, { default: ToolRuntime }] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-scope'), load('@deepseek-ai/dsh-tools'),
  ]);
  const ctx = new Context();
  ctx.provide('systemPrompt');
  ctx.set('systemPrompt', { tools: () => () => {}, section: () => () => {}, getSectionOrder: () => 0 });
  const runtime = new ToolRuntime(ctx, { mode: 'native' });
  for (const name of ['study_workspace', 'working_directory'])
    runtime.register({ name, description: name, parameters: {}, output: { schema: { type: 'object', properties: {} }, render: () => [] }, execute: async () => ({}) });
  const child = { id: 'study-child' }, other = { id: 'learner' };
  const childScope = createScope(ctx, child), otherScope = createScope(ctx, other);
  child.ctx = childScope.ctx; other.ctx = otherScope.ctx;
  const bound = boundChildTools(ctx, child.id);
  try {
    ctx.emit('agent/created', { agent: other });
    assert.equal(bound.bounded(), false);
    ctx.emit('agent/created', { agent: child });
    assert.equal(bound.error(), undefined);
    assert.equal(bound.bounded(), true);
    assert.deepEqual(runtime.schemas(child).map(tool => tool.name), []);
    assert.deepEqual(runtime.schemas(other).map(tool => tool.name).sort(), ['study_workspace', 'working_directory']);
  } finally { bound.dispose(); await childScope.dispose(); await otherScope.dispose(); }
});
