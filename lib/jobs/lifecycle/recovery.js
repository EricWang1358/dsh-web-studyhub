import { usageLedger } from '../../model-usage.js';
import { errorOf, terminal } from './shared.js';

/** Restart identification over the existing manifest: only a confirmed-lost
 * executor is marked interrupted; anything unconfirmed blocks recovery. */
export function recoveryOps(k) {
  const openPersistence = async (definition, input, bindings) => {
    const port = await definition.persistence.open(structuredClone(input), bindings);
    return { ...port,
      validateAccounting: async () => { await usageLedger(k.root).validate(); await port.validateAccounting?.(); },
      replayCall: async call => {
        if (call.observation.boundary === 'host-attempt' && call.tokenUsage) {
          await usageLedger(k.root).record({ callId: call.callId, feature: call.feature, usage: call.tokenUsage, calls: 1, at: Date.parse(call.startedAt) });
        } else if (port.replayCall) await port.replayCall(call);
        else throw errorOf('ledger-invalid');
      },
    };
  };

  const markInterrupted = (entry, contract) => {
    const attempt = contract.runtime.attempts.at(-1);
    const observation = entry.executor?.inspect?.(attempt.executor, entry.durable.metadata.executorWitness) || { state: 'unknown' };
    if (observation.state !== 'lost') { entry.recoveryBlocked = observation.state === 'alive' ? 'executor-alive' : 'executor-unknown'; return; }
    attempt.status = 'interrupted'; attempt.endReason = 'executor-lost';
    contract.status = 'interrupted'; contract.runtime.activeAttemptId = null; contract.stage = { code: 'interrupted' };
    for (const step of contract.runtime.steps) if (step.attemptId === attempt.attemptId && ['queued', 'running'].includes(step.status)) step.status = 'interrupted';
    contract.detail.executorLoss = observation.reason || 'executor-lost';
  };

  const identifyRecovery = async entry => {
    const contract = entry.job.contract; entry.recoveryBlocked = null;
    if (contract.runtime.activeAttemptId) markInterrupted(entry, contract);
    if (!entry.recoveryBlocked && entry.definition.capabilities.recoveryMode === 'none') entry.recoveryBlocked = 'recovery-unsupported';
    k.refresh(contract, entry);
    if (!entry.recoveryBlocked) {
      try { await entry.durable.preflight(entry.definition.version); }
      catch (error) { entry.recoveryBlocked = error.code || 'recovery-validation-failed'; }
    }
    if (terminal(contract.status)) {
      try { await k.finishLogical(entry); } catch (error) { entry.recoveryBlocked = error.code || 'store-write-failed'; }
    }
  };

  return { openPersistence, identifyRecovery };
}
