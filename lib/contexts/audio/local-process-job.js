/* What the Jobs of the audio context that run local programs (the Marker install, the local MinerU setup) share. */

/** Logical states in which such a Job still holds its slot. */
export const ACTIVE_STATUSES = Object.freeze(['queued', 'running', 'cancelling']);

/** Run one piece of work as an observed local call of a Job: its own Step (numbered, so a step that repeats stays distinct), `local-process`,
 * the side effect it declares. The work's own timeouts stay the only ones: the Step carries no budget. */
export const observeLocalWith = (gateway, purpose, feature) => {
  const policy = Object.freeze({ purpose, feature, budget: null });
  let count = 0;
  return (kind, work, { sideEffect }) => {
    const step = gateway.step(`${purpose}:${++count}:${kind}`, policy);
    // A process that exited non-zero is a failed Call, not an ok one that happens to carry a bad code.
    return step.run(() => step.observe({ boundary: 'local-process', kind, sideEffect }, async signal => {
      const value = await work(signal);
      return { value, ...(Number.isInteger(value?.code) && value.code !== 0 ? { status: 500 } : {}) };
    }));
  };
};
