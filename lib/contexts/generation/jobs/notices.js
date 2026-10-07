/* The notice of a settled run of the generation family (generate, supplement, repair, publish): the kernel's settlement sink, not a call of the executor. The kernel delivers it
   once per settled event: in process for a run that is not durable (`definition.notifications`, given the bindings the run was submitted with) and through the stored
   `deliveries` for one that is (the sinks of the persistence port, whose notifier comes from the closure of `persistence.open`, never from bindings). A session notice cannot
   be repeated without telling the learner twice, so it is at-most-once: a process that dies between the claim and the delivery loses it, it never doubles it. */

const LEGACY_STATUS = { paused: 'running', pausing: 'running', interrupted: 'failed' };

/** The run as the notifier has always read it (id, type, status, stage, the card's own fields), from the settled contract alone: the same after a restart as before it. */
export function runFacade(view) {
  return { ...(view.detail?.legacy || {}), id: view.runtime.legacyId, type: view.kind, status: LEGACY_STATUS[view.status] || view.status,
    stage: view.error?.message || view.stage?.text || view.stage?.code, startedAt: view.startedAt, finishedAt: view.finishedAt };
}

/** The sinks of a run. `closure` is the binding `persistence.open` was given: the notifier of a durable run lives there. */
export function generationNotices(closure) {
  // A run a restart found interrupted is not announced: it has something left to continue (the card offers 接着做); the Attempt tried again settles and is.
  const deliver = (_event, view, bindings) => { if (view.status !== 'interrupted') (bindings ?? closure)?.announce?.(runFacade(view)); };
  return [{ channel: 'session', idempotent: false, deliver }];
}
