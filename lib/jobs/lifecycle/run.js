import { usageLedger } from '../../model-usage.js';
import { createModelGateway } from '../gateway.js';
import { validateRuntimeContract } from '../contract.js';
import { createAttemptContext } from './attempt-context.js';
import { finalizeAttempt } from './finalize.js';
import { checkpointPause, iso } from './shared.js';

/** One physical Attempt: admit → run → classify the outcome → finalize. */
export async function runAttempt(k, entry, attempt, { admitted, queueTimer, resolvePhysical }) {
  if (entry.durable && !await admitted) return { status: 'failed' };
  const c = entry.job.contract, leases = {};
  let state = { outcome: { status: 'failed' }, finalState: { status: 'failed' } };
  const context = createAttemptContext(k, entry, attempt, leases);
  try {
    k.assertCurrent(entry, attempt);
    if (entry.pauseRequested && c.capabilities.pauseMode === 'queued-only') throw checkpointPause;
    if (entry.definition.admit) leases.admissionLease = await entry.definition.admit(context, structuredClone(entry.input), entry.bindings);
    k.assertCurrent(entry, attempt);
    k.removeTimer(entry, queueTimer);
    c.status = 'running'; attempt.status = 'running'; attempt.startedAt = iso(); c.startedAt ??= attempt.startedAt;
    c.stage = { code: 'running' }; k.refresh(c, entry);
    if (entry.durable) await k.persist(entry);
    k.timer(entry, entry.policy.executionTimeoutMs, 'execution-timeout');
    leases.resourceLease = entry.resourceScope?.open(entry.controller.signal);
    leases.gateway = createModelGateway({
      context: { jobId: c.jobId, attemptId: attempt.attemptId, signal: entry.controller.signal,
        requiresExternalObservation: !!leases.resourceLease?.enabled, assertCurrent: () => k.assertCurrent(entry, attempt) },
      record: c, host: entry.modelHost, durability: entry.durable,
      ledger: call => usageLedger(k.root).record({ callId: call.callId, feature: call.feature, usage: call.tokenUsage, calls: 1, at: Date.parse(call.startedAt) }),
    });
    const result = await entry.definition.run(context, structuredClone(entry.input), entry.bindings);
    await leases.gateway.drain();
    k.assertCurrent(entry, attempt);
    const output = structuredClone(result || { refs: [], completeness: null });
    output.completeness ??= null;
    validateRuntimeContract({ ...k.snapshot(entry), result: output });
    state = { finalState: { status: 'complete', result: output }, outcome: { status: 'completed' } };
  } catch (error) {
    state = classifyError(k, entry, error);
  } finally {
    state = await finalizeAttempt(k, entry, leases, state, resolvePhysical);
  }
  return state.outcome;
}

function classifyError(k, entry, error) {
  const mode = entry.job.contract.capabilities.pauseMode;
  if (error === checkpointPause && !entry.controller.signal.aborted && k.live(entry)) {
    return {
      finalState: { status: 'paused', attemptStatus: mode === 'queued-only' ? 'cancelled' : 'complete',
        ...(mode === 'checkpoint' ? { attemptEndReason: 'checkpoint-pause', checkpointRef: entry.checkpointRef } : {}) },
      outcome: { status: mode === 'queued-only' ? 'killed' : 'completed' },
    };
  }
  return { outcome: { status: 'failed' }, finalState: { status: 'failed', error: { message: String(error?.message || error), ...(error?.code ? { code: error.code } : {}) } } };
}
