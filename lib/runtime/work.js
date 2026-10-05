/** Work belongs to one runtime, even when its library path is shared. */
export function createRuntimeWork() {
  return {
    coachInflight: new Map(),
    translateInflight: new Map(),
    followupInflight: new Map(),
    suggestionInflight: new Map(),
    coachReplyInflight: new Map(),
    coachTasks: new Map(),
    coachQueues: new Map(),
    rewriteSlots: new Map(),
    prepPending: new Map(),
    jobs: new Map(),
    queues: new Map(),
    retryable: new Map(),
    settled: new Map(),
    noteJobs: new Map(),
    generationMessengers: new Map(),
    generationControllers: new Map(),
    // The live hand on a running job (lib/job-control.js), by job id; a job takes its control out when it ends.
    jobControls: new Map(),
    captureQueues: new Map(),
    recoveredBatches: new Map(),
    audioGate: { limit: 1, active: new Set(), waiting: [] },
    selectionActive: new Map(),
    workflowTeachingJobs: new Map(), workflowSkeletonJobs: new Map(), workflowModelCalls: new Map(),
  };
}
