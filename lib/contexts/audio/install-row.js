import { randomUUID } from 'node:crypto';
import { ownWork } from '../../runtime/work-ownership.js';
import { installSteps } from './install/install-view.js';

/* (Kept out of ./install, the Job modules: this is the original path.) An install that is not a Job (its pilot switch off, the default) still shows in the shared task list and the task console: one row of type
   `local-install` that the engine's `row` seam opens when the run starts, keeps up to date and closes when it ends. The run's AbortController is
   registered like any background run's, so Stop in the console reaches it (job.cancel says what is kept). The row carries its step text (第 n/N 步：…)
   and its steps (installSteps: a job's steps are its model calls), which the console shows in place of the model-call panels (an install makes none). */

export const INSTALL_ROW_TYPE = 'local-install';
const END = Object.freeze({ complete: 'complete', cancelled: 'cancelled', failed: 'failed' });

/** The `row` seam of an installer for this library: `{ tool, label, total, stageOf(state), stages, nameOf(id) }` say what the row shows. */
export function installRow(ports, { tool, label, total, stageOf, stages = [], nameOf = id => id }) {
  return run => {
    const { jobs, generationControllers } = ports.work;
    const stepsOf = (state, status = 'running') => installSteps({ stages, done: state.done, stage: state.stage, status, nameOf });
    const job = ownWork({ id: `${tool}-install-${randomUUID().slice(0, 8)}`, root: ports.state.root, type: INSTALL_ROW_TYPE, tool, label,
      status: 'running', stage: stageOf(run.state), done: 0, total, installSteps: stepsOf(run.state), folder: run.state.folder || '', ...(run.state.tier ? { tier: run.state.tier } : {}),
      startedAt: run.state.startedAt || new Date().toISOString() }, ports.worker.workOwner);
    jobs.set(job.id, job);
    if (run.controller) generationControllers.set(job.id, run.controller);
    const doneOf = state => (Array.isArray(state.done) ? state.done.length : 0);
    return {
      update(state) { if (job.status === 'running') Object.assign(job, { stage: stageOf(state), done: doneOf(state), installSteps: stepsOf(state) }); },
      close(state) {
        const status = END[state.status] || 'failed';
        Object.assign(job, { status, stage: stageOf(state), done: state.status === 'complete' ? total : doneOf(state), installSteps: stepsOf(state, status),
          finishedAt: state.finishedAt || new Date().toISOString() });
        generationControllers.delete(job.id);
      },
    };
  };
}
