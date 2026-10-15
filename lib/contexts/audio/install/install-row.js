import { randomUUID } from 'node:crypto';
import { ownWork } from '../../../runtime/work-ownership.js';

/* An install that is not a Job (its pilot switch off, the default) still shows in the shared task list and the task console: one row of type
   `local-install` that the engine's `row` seam opens when the run starts, keeps up to date and closes when it ends. The run's AbortController is
   registered like any background run's, so Stop in the console reaches it (job.cancel says what is kept). */

export const INSTALL_ROW_TYPE = 'local-install';
const END = Object.freeze({ complete: 'complete', cancelled: 'cancelled', failed: 'failed' });

/** The `row` seam of an installer for this library: `{ tool, label, total, stageOf(state) }` say what the row shows. */
export function installRow(ports, { tool, label, total, stageOf }) {
  return run => {
    const { jobs, generationControllers } = ports.work;
    const job = ownWork({ id: `${tool}-install-${randomUUID().slice(0, 8)}`, root: ports.state.root, type: INSTALL_ROW_TYPE, tool, label,
      status: 'running', stage: stageOf(run.state), done: 0, total, startedAt: run.state.startedAt || new Date().toISOString() }, ports.worker.workOwner);
    jobs.set(job.id, job);
    if (run.controller) generationControllers.set(job.id, run.controller);
    const doneOf = state => (Array.isArray(state.done) ? state.done.length : 0);
    return {
      update(state) { if (job.status === 'running') Object.assign(job, { stage: stageOf(state), done: doneOf(state) }); },
      close(state) {
        Object.assign(job, { status: END[state.status] || 'failed', stage: stageOf(state), done: state.status === 'complete' ? total : doneOf(state),
          finishedAt: state.finishedAt || new Date().toISOString() });
        generationControllers.delete(job.id);
      },
    };
  };
}
