import { admitSlot } from '../../jobs/scheduler.js';

/* What the Jobs of the audio context that work outside this process (the Marker install, the local MinerU setup, the PDF conversion) share. */

/** Logical states in which such a Job still holds its slot. */
export const ACTIVE_STATUSES = Object.freeze(['queued', 'running', 'cancelling']);

/** Run one piece of work as an observed call of a Job: its own Step (numbered, so a step that repeats stays distinct), the boundary it happens at
 * (`local-process` for a program on this computer, `external-request` for one request to a service), the side effect it declares. The work's own
 * timeouts stay the only ones: the Step carries no budget. */
export const observeLocalWith = (gateway, purpose, feature) => {
  const policy = Object.freeze({ purpose, feature, budget: null });
  let count = 0;
  return (kind, work, { sideEffect, boundary = 'local-process' }) => {
    const step = gateway.step(`${purpose}:${++count}:${kind}`, policy);
    // A process that exited non-zero is a failed Call, not an ok one that happens to carry a bad code.
    return step.run(() => step.observe({ boundary, kind, sideEffect }, async signal => {
      const value = await work(signal);
      return { value, ...(Number.isInteger(value?.code) && value.code !== 0 ? { status: 500 } : {}) };
    }));
  };
};

/** Wait for a free slot of a gate (`{ limit, active: Set, waiting: [] }`) and hold it until the returned lease is finished: what a Job that must not run beside another
 * one does in `admit`. Stopping while queued takes the Job out of the waiting line. */
export async function holdSlot(context, gate) {
  let start, finish, release;
  const admitted = new Promise(resolve => { start = resolve; }), held = new Promise(resolve => { finish = resolve; });
  const drained = admitSlot(gate, context.attemptId, context.signal, free => { release = free; start(); return held; });
  await admitted;
  return { release: () => release?.(), async finish() { finish(); await drained; } };
}
