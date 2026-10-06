import { validateRuntimeContract } from '../contract.js';
import { LIMITS } from '../limits.js';
import { checkpointPause, errorOf, terminal } from './shared.js';

/** The only API a definition's admit/run receive. Every publishing call is fenced
 * by the current Attempt; `leases` is filled by the runner as admission proceeds. */
export function createAttemptContext(k, entry, attempt, leases) {
  const c = entry.job.contract;
  const current = () => k.assertCurrent(entry, attempt);
  return Object.freeze({
    get gateway() { if (!leases.gateway) throw errorOf('model-not-admitted'); return leases.gateway; },
    signal: entry.controller.signal, jobId: c.jobId, attemptId: attempt.attemptId, checkpointRef: entry.checkpointRef,
    get resources() { return leases.resourceLease?.resources; },
    get admission() { return leases.admissionLease; },
    pauseSignal: entry.pauseController.signal,
    present(reader) {
      current(); if (typeof reader !== 'function') throw errorOf('invalid-presentation');
      const previous = entry.presentation; entry.presentation = reader;
      try { k.present(c, entry); } catch (error) { entry.presentation = previous; throw error; }
    },
    controls(adapter) {
      current();
      if (!c.capabilities.set || typeof adapter?.settings !== 'function' || typeof adapter?.patch !== 'function') throw errorOf('invalid-control-adapter');
      entry.controls = adapter; k.refresh(c, entry);
    },
    get pauseRequested() { return entry.pauseRequested; },
    output(text) { current(); if (typeof text !== 'string') throw errorOf('invalid-output'); entry.handle.append(text); },
    progress(value) {
      current();
      const next = { ...c.progress, ...structuredClone(value) };
      validateRuntimeContract({ ...k.snapshot(entry), progress: next }); c.progress = next;
    },
    // Async preparation may outlive cancellation; publication is a short,
    // synchronous domain commit, fenced again after preparation completes.
    async commit(prepare, publish) {
      current();
      if (typeof publish !== 'function' || publish.constructor.name === 'AsyncFunction') throw errorOf('async-publication-unsupported');
      const prepared = await prepare(); current();
      const result = publish(prepared);
      if (result?.then) throw errorOf('async-publication-unsupported');
      return result;
    },
    commitArtifact(stepKey, prepare, adapter) {
      current();
      if (!entry.durable || typeof adapter?.publish !== 'function' || typeof stepKey !== 'string' || !stepKey
        || stepKey.length > LIMITS.stepKeyLength) throw errorOf('recovery-unsupported');
      const pending = commitArtifact(k, entry, attempt, { stepKey, prepare, adapter });
      entry.commitsPending.add(pending);
      void pending.catch(error => { entry.commitErrors.push(error); }).finally(() => entry.commitsPending.delete(pending));
      return pending;
    },
    async saveCheckpoint(checkpoint) {
      current();
      if (!entry.durable) throw errorOf('recovery-unsupported');
      await entry.durable.port.validateCheckpoint(checkpoint); current();
      entry.durable.metadata.checkpoint = structuredClone(checkpoint); entry.checkpointRef = checkpoint.ref;
      attempt.checkpointRef = checkpoint.ref; await k.persist(entry);
      if (entry.pauseRequested) throw checkpointPause;
    },
    checkpoint(ref) {
      current();
      if (!entry.pauseRequested) return false;
      if (typeof ref !== 'string' || !ref || (entry.durable && entry.durable.metadata.checkpoint?.ref !== ref)) throw errorOf('no-safe-checkpoint');
      entry.checkpointRef = ref; throw checkpointPause;
    },
    async request(run, { timeoutMs } = {}) {
      current();
      const timeout = k.timer(entry, timeoutMs, 'request-timeout');
      try { const value = await run(entry.controller.signal); current(); return value; }
      finally { k.removeTimer(entry, timeout); }
    },
  });
}

/** Durable artifact publication: reconcile an existing commit, else record a pending
 * commit before publishing so a crash between the two is recoverable. */
async function commitArtifact(k, entry, attempt, { stepKey, prepare, adapter }) {
  const c = entry.job.contract, commits = entry.durable.metadata.commits;
  const existing = commits.find(item => item.stepKey === stepKey);
  if (existing) {
    const receipt = await entry.durable.port.reconcileCommit(structuredClone(existing));
    if (!receipt) throw errorOf('artifact-conflict');
    k.assertCurrent(entry, attempt); return receipt;
  }
  const prepared = await prepare(); k.assertCurrent(entry, attempt);
  const commit = { stepKey, attemptId: attempt.attemptId, status: 'pending', receipt: null };
  commits.push(commit); await k.persist(entry);
  try { k.assertCurrent(entry, attempt); }
  catch (error) { commits.splice(commits.indexOf(commit), 1); await k.persist(entry); throw error; }
  // Once admitted, publication may drain through cancellation. The
  // epoch remains exclusive until this physical Attempt settles.
  const assertPublication = () => { if (c.runtime.activeAttemptId !== attempt.attemptId || terminal(c.status)) throw errorOf('stale-attempt'); };
  commit.receipt = structuredClone(await adapter.publish(prepared, { assertCurrent: assertPublication }));
  commit.status = 'complete';
  if (Array.isArray(commit.receipt?.refs)) {
    const refs = [...c.result.refs];
    for (const ref of commit.receipt.refs) if (!refs.some(item => item.kind === ref.kind && item.id === ref.id)) refs.push(ref);
    c.result = validateRuntimeContract({ ...k.snapshot(entry), result: { refs, completeness: 'partial' } }).result;
  }
  await k.persist(entry); return structuredClone(commit.receipt);
}
