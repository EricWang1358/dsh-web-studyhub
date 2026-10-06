// Manual audit companion: real installed services and Agents, synthetic producers/errors.
// No new provider, permit service, controller, configuration or production route is installed.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function probeResourceScope({ ctx, parent, sibling, sdkRoot, route, signal, until }) {
  const jobs = ctx.get('jobs'), held = [], retries = [];
  const { agentEvents } = await import(pathToFileURL(join(sdkRoot, 'dsh-agent/lib/index.js')).href);
  const { BlockAssembler, createUserMessage } = await import(pathToFileURL(join(sdkRoot, 'dsh-llm/lib/index.js')).href);
  const events = agent => Array.from({ length: Number(agent.session.seq) }, (_, seq) => agent.session.eventAt(seq));
  const start = owner => {
    const done = Promise.withResolvers();
    const id = jobs.start({ owner: owner.id, kind: 's13-resource-audit', label: 'isolated S1-3 capacity audit',
      run: () => ({ done: done.promise, cancel() {} }) });
    held.push({ id, owner, done }); return held.at(-1);
  };
  try {
    // Default config is unchanged. Ten exact-owner slots, not ten provider calls.
    for (let i = 0; i < 10; i++) start(parent);
    assert.throws(() => start(parent), /background job limit reached/);
    const foreign = start(sibling);
    assert.equal(jobs.get(foreign.id, sibling.id).status, 'running');
    const first = held[0]; jobs.kill(first.id, parent.id);
    assert.equal(jobs.get(first.id, parent.id).status, 'stopping');
    assert.throws(() => start(parent), /background job limit reached/);
    first.done.resolve({ status: 'killed' });
    assert.equal((await jobs.wait(first.id, 1000, parent.id, signal)).status, 'killed');
    const replacement = start(parent);
    assert.equal(jobs.get(replacement.id, parent.id).status, 'running');

    // Exercise the real installed retry plugin at its public agent error event.
    // The 429 is an explicitly synthetic event, not a provider HTTP response.
    const policy = { mode: 'normal', maxRetries: 2, retryableCodes: ['RATE_LIMITED'], initialDelayMs: 10000, maxDelayMs: 10000, jitterRatio: 0 };
    for (const agent of [parent, sibling]) {
      const controller = new AbortController(); const fused = AbortSignal.any([signal, controller.signal]);
      const entry = { agent, controller, done: false };
      entry.promise = agentEvents(ctx, agent).waterfall('agent/request-error', {
        turn: 1, step: 1, provider: route.provider,
        failure: { message: 'synthetic S1-3 rate refusal', code: 'RATE_LIMITED', status: 429, providerRetryAfterMs: 10000 },
        retryPolicy: policy, signal: fused,
      }, () => Promise.resolve(undefined)).finally(() => { entry.done = true; });
      retries.push(entry);
    }
    await until(() => [parent, sibling].every(agent => events(agent).some(e => e.type === 'llm/retry')), 'real retry events in two sessions');
    const records = [parent, sibling].map(agent => events(agent).filter(e => e.type === 'llm/retry').at(-1).data);
    assert.deepEqual(records.map(r => r.retry), [1, 1]);
    assert.notEqual(records[0].retryId, records[1].retryId);
    assert.deepEqual(records.map(r => r.delayMs), [10000, 10000]);
    assert.ok(retries.every(r => !r.done));
    const llm = sibling.ctx.get('llm'), assembler = new BlockAssembler();
    const call = await llm.resolveCallConfig(route, signal);
    for await (const chunk of llm.stream({ ...call, sessionId: sibling.id, signal,
      messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'S1-3 local fake stream during synthetic retry wait.' }] })] })) assembler.push(chunk);
    assert.equal(assembler.finish.kind, 'stop');
    assert.ok(retries.every(r => !r.done), 'direct stream must finish while both real retry waits remain pending');
    return { jobs: { exactOwnerCeiling: 10, siblingAdmittedAtParentCeiling: true, stoppingConsumesCapacity: true, replacementAfterSettlement: true },
      retry: { injectedSynthetic429: true, counters: records.map(r => r.retry), independentRetryIds: true, observedDelayMs: records.map(r => r.delayMs),
        sameProviderDirectStreamCompletedDuringWait: true, finish: assembler.finish.kind },
      conclusion: 'Inspected rc.2 owner-job and session-retry mechanisms do not supply a shared provider-request admission barrier on ctx.llm.stream.',
      limitations: ['Synthetic failures entered the real retry extension point; provider HTTP 429 mapping is not tested.',
        'No cross-process quota guarantee or global claim about every DSH package.', 'No shared-provider production policy implemented.'] };
  } finally {
    for (const retry of retries) retry.controller.abort(new Error('S1-3 audit cleanup'));
    await Promise.allSettled(retries.map(r => r.promise));
    for (const item of held) item.done.resolve({ status: 'killed' });
    for (const item of held) { await jobs.wait(item.id, 1000, item.owner.id); jobs.remove(item.id, item.owner.id); }
  }
}
