import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { createJobLifecycle } from '../lib/jobs/lifecycle.js';
import { validateRuntimeContract } from '../lib/jobs/contract.js';
import { createRuntimeWork } from '../lib/runtime/work.js';
import { chooseEffort } from '../lib/model-effort.js';

// S4-1: the model families as the PUBLISHED kernel sees them. The table is the machine form of
// docs/plans/unified-job-runtime/s4-1-model-contract.md; later steps register production definitions with the same facts.
// Nothing here adds an interface: every row is driven through lifecycle.register / scoped / gateway as they are.
const DIRECT = ['direct'], BOTH = ['direct', 'subagent'], NO_PAUSE = 'capability-unsupported', NOT_PAUSED = 'not-paused';
const base = { cancel: true, pauseMode: 'unsupported', retry: false, set: false, recoveryMode: 'none' };
const FAMILIES = {
  translation: { domain: 'generation.v1', purpose: 'translate', feature: 'other', mode: 'agent-preferred', effort: 'default', refs: 'source',
    capabilities: { ...base, pauseMode: 'checkpoint', set: true, executionModes: BOTH },
    running: { cancel: true, pause: true, resume: NOT_PAUSED, retry: NO_PAUSE, set: true } },
  'coach-prep': { domain: 'coach.v1', purpose: 'prep', feature: 'coach', mode: 'direct', effort: 'lowest', refs: null,
    capabilities: { ...base, executionModes: DIRECT },
    running: { cancel: true, pause: NO_PAUSE, resume: NOT_PAUSED, retry: NO_PAUSE, set: NO_PAUSE } },
  'daily-recap': { domain: 'notes.v1', purpose: 'other', feature: 'other', mode: 'direct', effort: 'default', refs: 'note',
    capabilities: { ...base, executionModes: DIRECT },
    running: { cancel: true, pause: NO_PAUSE, resume: NOT_PAUSED, retry: NO_PAUSE, set: NO_PAUSE } },
  'workflow-teaching': { domain: 'workflows.v1', purpose: 'author', feature: 'flow', mode: 'direct', effort: 'default', refs: null,
    capabilities: { ...base, executionModes: DIRECT },
    running: { cancel: true, pause: NO_PAUSE, resume: NOT_PAUSED, retry: NO_PAUSE, set: NO_PAUSE } },
  'workflow-skeleton': { domain: 'workflows.v1', purpose: 'plan', feature: 'flow', mode: 'direct', effort: 'default', refs: 'skeleton',
    capabilities: { ...base, executionModes: DIRECT },
    running: { cancel: true, pause: NO_PAUSE, resume: NOT_PAUSED, retry: NO_PAUSE, set: NO_PAUSE } },
  assist: { domain: 'study.v1', purpose: 'other', feature: 'coach', mode: 'direct', effort: 'default', refs: 'card',
    capabilities: { ...base, executionModes: BOTH },
    running: { cancel: true, pause: NO_PAUSE, resume: NOT_PAUSED, retry: NO_PAUSE, set: NO_PAUSE } },
};
const ACTIONS = ['cancel', 'pause', 'resume', 'retry', 'set'];

const deferred = () => Promise.withResolvers();
function executor(agentId) {
  let starts = 0, stops = 0;
  return { assertAvailable() {}, witness: () => ({ pid: process.pid, host: 'fixture', instance: agentId }), inspect: () => ({ state: 'lost' }),
    start({ run, cancel }) { void run(); return { id: `${agentId}:${++starts}`, ownerAgentId: agentId, append() {}, stop(reason) { stops++; cancel(reason); } }; },
    get stops() { return stops; } };
}
const route = { provider: 'fixture', model: 'fixture' };
const hostOf = (ctx = {}, sessionId = 'session-A') => ({ ctx, route, sessionId, complete: async () => 'reply' });
const policyOf = row => ({ purpose: row.purpose, feature: row.feature, requestedEffort: row.effort, executionMode: row.mode, budget: null });

/** One kernel, every family registered under its own domain, one gated run per job so a test can look at the running state. */
async function fixture(t, { run = {}, admit = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'model-definitions-')), work = createRuntimeWork(), lifecycle = createJobLifecycle(root, work), ctx = new Context(), gates = new Map();
  for (const [kind, row] of Object.entries(FAMILIES)) {
    lifecycle.register(ctx, row.domain, { kind, version: 1, title: kind, capabilities: row.capabilities, ...(admit[kind] ? { admit: admit[kind] } : {}),
      async run(context) {
        const gate = gates.get(context.jobId);
        if (row.capabilities.set) context.controls({ settings: () => [{ key: 'concurrency', type: 'int', min: 1, max: 3, value: 2 }], patch: patch => patch, close() {} });
        await context.gateway.step(`${kind}:1`, policyOf(row)).complete('system', 'prompt');
        gate?.started.resolve(); await gate?.release.promise;
        return run[kind]?.(context) ?? { refs: row.refs ? [{ kind: row.refs, id: `${kind}-result` }] : [], completeness: 'complete' };
      } });
  }
  t.after(async () => { for (const gate of gates.values()) gate.release.resolve(); await lifecycle.dispose(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
  const owner = Symbol('plugin work owner');
  const port = (kind, { who = owner, agent = executor('agent-A'), host = hostOf() } = {}) =>
    lifecycle.scoped({ owner: who, domain: FAMILIES[kind].domain, executor: agent, modelHost: host });
  const gated = async (kind, options) => {
    const agent = options?.agent ?? executor('agent-A'), jobs = port(kind, { ...options, agent }), gate = { started: deferred(), release: deferred() };
    const submitted = await jobs.submit(kind, { fixture: kind });
    gates.set(submitted.jobId, gate); await gate.started.promise;
    return { jobs, agent, gate, id: submitted.jobId, status: () => jobs.status(submitted.jobId) };
  };
  return { work, lifecycle, owner, port, gated };
}

test('every model family registers on the published registry and its running Job states only real, refusable actions', async t => {
  const f = await fixture(t);
  for (const [kind, row] of Object.entries(FAMILIES)) {
    const job = await f.gated(kind), view = job.status();
    assert.equal(validateRuntimeContract(view).kind, kind);
    assert.equal(view.status, 'running'); assert.deepEqual(view.capabilities.executionModes, row.capabilities.executionModes);
    for (const action of ACTIONS) {
      const expected = row.running[action];
      assert.equal(view.actions[action].available, expected === true, `${kind}.${action}`);
      if (expected === true) continue;
      assert.equal(view.actions[action].reason.code, expected, `${kind}.${action} reason`);
      await assert.rejects(() => job.jobs.control(job.id, action), { code: expected }, `${kind}.${action} refusal`);
    }
    assert.equal(view.actions.pause.mode, row.capabilities.pauseMode);
    const [call] = view.calls;
    assert.deepEqual([call.kind, call.feature, call.requestedEffort, call.executionMode], [row.purpose, row.feature, row.effort, row.mode], `${kind} policy on the Call`);
    assert.equal(call.stepKey, `${kind}:1`);
    job.gate.release.resolve();
    const ended = await job.jobs.wait(job.id);
    assert.equal(ended.status, 'complete'); assert.equal(ended.result.completeness, 'complete');
    assert.deepEqual(ended.result.refs, row.refs ? [{ kind: row.refs, id: `${kind}-result` }] : []);
    assert.equal(ended.usage.calls, 1);
  }
});

test('cancel stops exactly the targeted Job; its sibling of the same library keeps running', async t => {
  const f = await fixture(t), first = await f.gated('coach-prep'), second = await f.gated('coach-prep');
  await first.jobs.control(first.id, 'cancel'); first.gate.release.resolve();
  assert.equal((await first.jobs.wait(first.id)).status, 'cancelled');
  assert.equal(second.status().status, 'running'); assert.equal(second.agent.stops, 0);
  second.gate.release.resolve(); assert.equal((await second.jobs.wait(second.id)).status, 'complete');
});

test('sessions of one library share view and control; another owner or another domain sees nothing', async t => {
  const f = await fixture(t), job = await f.gated('translation');
  const legacyId = job.status().runtime.legacyId, otherSession = executor('agent-B');
  assert.equal(f.lifecycle.visible(legacyId, f.owner), true);
  // Another session of the same plugin owner reaches the same Job through the compatible port the console and tools use.
  const compatible = f.lifecycle.compatible(legacyId, f.owner, { jobExecutor: otherSession });
  assert.equal(compatible.status(job.id).status, 'running');
  await compatible.control(job.id, 'cancel'); job.gate.release.resolve();
  assert.equal((await compatible.wait(job.id)).status, 'cancelled'); assert.equal(job.agent.stops, 1);
  assert.equal(otherSession.stops, 0, 'the stop goes to the executor that admitted the Attempt');
  const other = Symbol('extension owner');
  assert.equal(f.lifecycle.visible(legacyId, other), false);
  assert.throws(() => f.lifecycle.compatible(legacyId, other), { code: 'job-not-found' });
  assert.throws(() => f.lifecycle.compatible(legacyId, undefined), { code: 'job-not-found' });
  assert.throws(() => f.port('translation', { who: other }).status(job.id), { code: 'job-not-found' });
  assert.throws(() => f.port('coach-prep').status(job.id), { code: 'job-not-found' }, 'a family cannot read another family\'s Job');
  await assert.rejects(() => f.port('coach-prep').submit('translation', {}), /unavailable/);
});

test('direct calls, a one-shot native child and an existing reusable child all belong to the same Job, Attempt and Step', async t => {
  const started = [], parent = { id: 'session-A' };
  const subagents = { getProvider: () => ({ capabilities: { toolFilter: true, agentOptions: true } }),
    start: async (_, request) => { started.push(request); return { id: 'child-1', result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'child reply' }] }), dispose: async () => {} }; } };
  const native = { get: key => key === 'agents' ? { get: id => id === parent.id ? parent : undefined } : key === 'subagents' ? subagents : undefined };
  const f = await fixture(t, { run: { assist: async context => {
    const policy = policyOf(FAMILIES.assist);
    await context.gateway.step('direct', policy).complete('s', 'p');
    await context.gateway.step('preferred', { ...policy, executionMode: 'agent-preferred' }).complete('s', 'p');
    // assist-child keeps one child for several tasks: the Job observes the host's own attempt, it does not own the child.
    const reused = context.gateway.step('reused', policy);
    await reused.run(() => reused.observe({ boundary: 'host-attempt', runner: 'subagent', kind: 'other' },
      async () => ({ value: 'follow-up', childId: 'child-reused', parentId: parent.id, tokenUsage: { uncachedInputTokens: 3, outputTokens: 2 } })));
    return { refs: [{ kind: 'card', id: 'c1' }], completeness: 'complete' };
  } } });
  const job = await f.gated('assist', { host: hostOf(native) });
  job.gate.release.resolve();
  const ended = await job.jobs.wait(job.id), [direct, preferred, reused] = ended.calls.filter(call => call.stepKey !== 'assist:1');
  const attempt = ended.runtime.attempts.at(-1).attemptId;
  for (const call of ended.calls) {
    assert.equal(call.jobId, ended.jobId); assert.equal(call.attemptId, attempt);
    assert.ok(ended.runtime.steps.some(step => step.stepRunId === call.stepRunId && step.stepKey === call.stepKey && step.attemptId === attempt), 'the Call names a real Step run');
  }
  assert.deepEqual([direct.runner, preferred.runner, reused.runner], ['direct', 'subagent', 'subagent']);
  assert.deepEqual([preferred.childId, preferred.parentId], ['child-1', parent.id]);
  assert.deepEqual([reused.childId, reused.parentId, reused.tokens], ['child-reused', parent.id, 5]);
  assert.equal(started.length, 1); assert.equal(ended.execution.mode, 'mixed');
  validateRuntimeContract(ended);
  // A direct-only definition cannot silently turn a preferred step into a child: it must declare both modes (S4-8 does, behind its own switch).
  const directOnly = await fixture(t, { run: { 'coach-prep': context => context.gateway.step('x', { ...policyOf(FAMILIES['coach-prep']), executionMode: 'agent-preferred' }).complete('s', 'p') } });
  const jobs = directOnly.port('coach-prep', { host: hostOf(native) }), refused = await jobs.wait((await jobs.submit('coach-prep', {})).jobId);
  assert.equal(refused.status, 'failed'); assert.equal(refused.error.code, 'execution-mode-unsupported');
});

test('a lease that still owns a reusable child keeps the Job unsettled until the host has released it', async t => {
  const entered = deferred(), release = deferred(); let released = false, settled = false;
  const f = await fixture(t, { admit: { assist: async () => ({ async finish() { entered.resolve(); await release.promise; released = true; } }) } });
  const job = await f.gated('assist'), waiting = job.jobs.wait(job.id).then(view => { settled = true; return view; });
  job.gate.release.resolve(); await entered.promise;
  assert.equal(settled, false); assert.equal(job.status().status, 'running');
  release.resolve();
  assert.equal((await waiting).status, 'complete'); assert.equal(released, true);
});

test('the library queue stays the one waiting place: admit holds a Job queued, cancel settles it at once, the slot is passed on', async t => {
  const chain = { tail: Promise.resolve() }, finished = [];
  const admit = async context => {
    const ahead = chain.tail; let pass; chain.tail = new Promise(resolve => { pass = resolve; });
    const aborted = new Promise((_, reject) => context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }));
    try { await Promise.race([ahead, aborted]); } catch (error) { void ahead.then(pass); throw error; }
    return { finish() { finished.push(context.attemptId); pass(); } };
  };
  const f = await fixture(t, { admit: { translation: admit } });
  const first = await f.gated('translation'), jobs = f.port('translation'), second = await jobs.submit('translation', {}), third = await jobs.submit('translation', {});
  assert.equal(jobs.status(second.jobId).status, 'queued'); assert.equal(jobs.status(second.jobId).stage.code, 'queued');
  await jobs.control(second.jobId, 'cancel');
  assert.equal((await jobs.wait(second.jobId)).status, 'cancelled'); assert.equal(jobs.status(second.jobId).calls.length, 0);
  assert.equal(jobs.status(third.jobId).status, 'queued', 'the cancelled Job did not let its successor jump the queue');
  first.gate.release.resolve(); await first.jobs.wait(first.id);
  assert.equal((await jobs.wait(third.jobId)).status, 'complete');
  assert.equal(finished.length, 2, 'every admitted lease was finished exactly once');
});

test('a time limit ends the Job cancelled with its stop reason (translation\'s failed/budget needs a legacy mapping, see the S4-1 gaps)', async t => {
  const f = await fixture(t, { run: { translation: context => new Promise(resolve => context.signal.addEventListener('abort', () => resolve({ refs: [] }), { once: true })) } });
  const jobs = f.port('translation'), job = await jobs.submit('translation', {}, { executionTimeoutMs: 20 });
  const ended = await jobs.wait(job.jobId);
  assert.equal(ended.status, 'cancelled'); assert.equal(ended.detail.stopReason, 'execution-timeout'); assert.equal(ended.error, null);
});

test('coach-prep\'s "lowest" effort resolves to the same level the light path picks', () => {
  for (const [efforts, light] of [[[{ id: 'high' }, { id: 'low' }, { id: 'none', name: 'Off' }], 'none'], [[{ id: 'max' }, { id: 'low' }], 'low'], [[{ id: 'high' }, { id: 'max' }], 'high']])
    assert.equal(chooseEffort(efforts, 'lowest').id, light);
});

test('the S4-1 document names every family kind and each gap it hands to the kernel owner', async () => {
  const text = await readFile(new URL('../docs/plans/unified-job-runtime/s4-1-model-contract.md', import.meta.url), 'utf8');
  for (const kind of Object.keys(FAMILIES)) assert.ok(text.includes(`\`${kind}\``), `${kind} is in the document`);
  for (const gap of ['G1', 'G2', 'G3', 'G4', 'G5']) assert.ok(text.includes(gap), `${gap} is in the document`);
});
