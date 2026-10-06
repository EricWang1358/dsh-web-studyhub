import { iso, terminal } from './shared.js';

const failed = (code, message) => ({ outcome: { status: 'failed' }, finalState: { status: 'failed', error: { code, message } } });

/** Settle one Attempt exactly once: drain commits, release every lease, decide the
 * final status, persist it, then hand the logical outcome to observers. */
export async function finalizeAttempt(k, entry, leases, state, resolvePhysical) {
  while (entry.commitsPending.size) await Promise.allSettled([...entry.commitsPending]);
  state = await releaseLeases(entry, leases, state);
  entry.controls = null;
  k.clearTimers(entry); entry.settling = true;
  if (entry.controller.signal.aborted || !k.live(entry)) {
    state = { finalState: { status: 'cancelled', endReason: 'user-cancel', attemptEndReason: 'user-cancel' }, outcome: { status: 'killed' } };
  } else if (entry.commitErrors.length && state.finalState.status === 'complete') {
    state = failed('artifact-commit-failed', 'An admitted artifact commit failed');
  }
  const next = nextRecord(entry, state.finalState);
  try { k.present(next, entry); }
  catch (error) {
    entry.presentation = null;
    next.status = 'failed'; next.runtime.attempts.at(-1).status = 'failed'; next.finishedAt ||= iso();
    next.stage = { code: 'failed' };
    next.error = { code: 'invalid-presentation', message: String(error?.message || error) };
    state = { ...state, outcome: { status: 'failed' } };
  }
  if (terminal(next.status)) { next.finishedAt = iso(); k.addSettledEvent(next); }
  k.refresh(next, { ...entry, settling: false });
  const c = entry.job.contract;
  try {
    if (entry.durable) await entry.durable.persist(next);
    for (const key of Object.keys(c)) delete c[key]; Object.assign(c, next);
    if (terminal(c.status)) { entry.notified = true; k.settleObserver(entry); }
  } catch (error) {
    Object.assign(c, next); c.detail.durabilityError = error.code || 'store-write-failed'; c.status = 'failed'; c.runtime.attempts.at(-1).status = 'failed';
    c.error = { code: 'store-write-failed', message: 'Job outcome could not be saved' }; entry.recoveryBlocked = 'store-write-failed';
    k.work.settled.delete(entry.job.id); entry.resolveLogical();
  } finally { entry.settling = false; k.refresh(c, entry); resolvePhysical(); }
  return state;
}

// Every admitted lease must get its cleanup attempt even when another
// trusted adapter fails. A failed hook cannot strand logical/physical wait.
async function releaseLeases(entry, leases, state) {
  const steps = [() => leases.gateway?.drain(), () => leases.resourceLease?.finish(), () => leases.admissionLease?.finish?.(), () => entry.controls?.close?.()];
  for (const finish of steps) {
    try { const pending = finish(); if (pending?.then) await pending; }
    catch (error) { state = failed('adapter-cleanup-failed', String(error?.message || error)); }
  }
  return state;
}

function nextRecord(entry, finalState) {
  const next = structuredClone(entry.job.contract), attempt = next.runtime.attempts.at(-1);
  next.status = finalState.status; next.stage = { code: next.status }; next.runtime.activeAttemptId = null;
  attempt.status = finalState.attemptStatus || next.status; attempt.finishedAt = iso();
  if (finalState.attemptEndReason) attempt.endReason = finalState.attemptEndReason;
  if (finalState.checkpointRef) attempt.checkpointRef = finalState.checkpointRef;
  for (const key of ['result', 'error', 'endReason']) if (finalState[key] !== undefined) next[key] = finalState[key];
  if (entry.stopReason && entry.stopReason !== 'user-cancel') next.detail.stopReason = entry.stopReason;
  if (terminal(next.status)) next.finishedAt = iso();
  return next;
}
