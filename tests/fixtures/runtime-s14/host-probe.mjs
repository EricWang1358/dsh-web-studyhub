import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
export async function probeGateway({ ctx, parent, sourceRoot, route, until }) {
  const files = ['lib/jobs/gateway.js', 'lib/jobs/lifecycle.js', 'lib/jobs/executor.js', 'lib/host-capabilities.js', 'lib/index.js', 'lib/model-usage.js', 'lib/audio-gateway.js', 'lib/audio-dashboard.js', 'lib/gemini.js', 'lib/audio-job.js'];
  const load = file => import(pathToFileURL(join(sourceRoot, file)).href);
  const [{ createJobLifecycle }, { createRuntimeWork }, { dshJobExecutor }, { modelCompletion }] = await Promise.all([
    'lib/jobs/lifecycle.js', 'lib/runtime/work.js', 'lib/jobs/executor.js', 'lib/index.js',
  ].map(load));
  const lifecycle = createJobLifecycle(join(process.env.DSH_HOME, 's14-probe-library'), createRuntimeWork());
  const owner = Symbol('gateway-host-probe'), host = { ctx: parent.ctx, sessionId: parent.id, route, complete: modelCompletion(ctx, () => route, parent.id) };
  const port = lifecycle.scoped({ owner, domain: 'gateway.v1', executor: dshJobExecutor(ctx, parent), modelHost: host });
  lifecycle.register(ctx, 'gateway.v1', { kind: 's14-gateway', version: 1, capabilities: { executionModes: ['direct', 'subagent'] }, run: async context => {
    for (const executionMode of ['direct', 'agent-required']) {
      const result = await context.gateway.step(executionMode, { purpose: 'probe', feature: 'other', requestedEffort: 'default', executionMode, budget: { timeoutMs: 10000, maxOutputTokens: 100 } }).complete('Return a short answer.', 'Answer gateway probe.');
      assert.ok(result.length > 0);
    }
    await context.gateway.step('effort-fallback', { purpose: 'probe', feature: 'other', requestedEffort: 'highest', executionMode: 'direct', budget: null }).complete('Return short text.', 'Probe effort mapping.');
    return { refs: [] };
  } });
  try {
    const submitted = await port.submit('s14-gateway', {}), finished = await port.wait(submitted.jobId);
    assert.equal(finished.status, 'complete', JSON.stringify(finished.error));
    assert.equal(finished.calls.length, 3); assert.equal(finished.execution.mode, 'mixed');
    const [direct, child] = finished.calls;
    for (const call of finished.calls) {
      assert.equal(call.jobId, submitted.jobId); assert.equal(call.attemptId, submitted.attemptId);
      assert.equal(call.observation.boundary, 'host-attempt'); assert.equal(call.observation.requestCount, null);
      assert.ok(call.tokens > 0); assert.equal(call.status, 'ok');
    }
    assert.equal(direct.runner, 'direct'); assert.equal(child.runner, 'subagent');
    assert.equal(child.parentId, parent.id); assert.ok(child.childId);
    await until(() => !ctx.get('agents').get(child.childId), 'gateway child disposal');
    assert.equal(finished.calls[2].requestedEffort, 'highest');
    assert.equal(finished.calls[2].fallbackReason, 'unsupported');
    const held = Promise.withResolvers(), admitted = Promise.withResolvers();
    const subagents = parent.ctx.get('subagents'); let lateChild;
    const slow = { getProvider: (...args) => subagents.getProvider(...args), start: async (...args) => {
      const handle = await subagents.start(...args); lateChild = handle.id; admitted.resolve(); await held.promise; return handle;
    } };
    const slowHost = { ...host, ctx: { llm: parent.ctx.llm, get: key => key === 'subagents' ? slow : parent.ctx.get(key) } };
    const slowPort = lifecycle.scoped({ owner, domain: 'gateway.v1', executor: dshJobExecutor(ctx, parent), modelHost: slowHost });
    const cancelling = await slowPort.submit('s14-gateway', {});
    try {
      await admitted.promise; await slowPort.control(cancelling.jobId, 'cancel');
      assert.equal(slowPort.status(cancelling.jobId).status, 'cancelling');
    } finally { held.resolve(); }
    assert.equal((await slowPort.wait(cancelling.jobId)).status, 'cancelled');
    await until(() => !ctx.get('agents').get(lateChild), 'late admitted child disposal');
    const fingerprints = Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(join(sourceRoot, file))).digest('hex')])));
    return { status: finished.status, nativeJob: finished.runtime.attempts[0].executor, calls: finished.calls, fingerprints,
      childDisposed: true, lateAdmissionCancellationDrained: true, paidModel: false, observation: 'actual installed rc.2 host with local fake adapter; current production modules, installed StudyHub package unchanged' };
  } finally { await lifecycle.dispose(); }
}
