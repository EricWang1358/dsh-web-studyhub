import { randomUUID } from 'node:crypto';
import { INDEX_TEXT } from '../../../retrieval-messages.js';
import { buildIndex, canIngest, indexUnavailable, writeManifest } from '../../../retrieval-index.js';
import { adoptIndexProvider } from './adopt-index.js';
import { ALL_COURSES } from './index-plan.js';

/* The build of each library runs in the background (one at a time) and is polled; it is not a generation job.
   This is the build with runtime.pilot.retrievalIndex off; the same entry points on the runtime are in ./jobs. */
const runs = new Map();
const publicRun = ({ controller: _controller, promise: _promise, ...run }) => ({ ...run, failed: run.failed.slice(0, 10), failedCount: run.failed.length });

/** start / status / cancel / building over the host port of `ports`; `planner` is the library reader of ./index-plan.js. */
export function createLegacyIndexRuns({ ports, planner }) {
  const root = ports.state.root;
  return Object.freeze({
    async start(a) {
      const current = runs.get(root);
      if (current?.status === 'running') return publicRun(current);
      if (!canIngest(ports.retrieval)) throw indexUnavailable();
      const { picked, library, manifest, plan, firstRun } = await planner.prepare(a.course);
      if (!picked.length) throw new Error(INDEX_TEXT.noSources);
      const run = { runId: randomUUID(), course: a.course ?? ALL_COURSES, status: 'running', stage: 'preparing', done: 0, total: plan.add.length + plan.remove.length,
        added: 0, removed: 0, unchanged: plan.unchanged, failed: [], firstRun, startedAt: new Date().toISOString(), controller: new AbortController() };
      runs.set(root, run);
      run.promise = (async () => {
        try {
          const summary = await buildIndex({ port: ports.retrieval, sources: picked, library, manifest, firstRun: run.firstRun, signal: run.controller.signal,
            onProgress: event => { run.stage = event.stage; run.done = event.done; run.total = event.total; }, save: value => writeManifest(root, value) });
          Object.assign(run, summary, { status: 'complete', stage: 'done', done: run.total });
          await adoptIndexProvider(ports.retrieval);
        } catch (error) {
          if (run.controller.signal.aborted) Object.assign(run, { status: 'cancelled', stage: 'cancelled' });
          else Object.assign(run, { status: 'failed', stage: 'failed', error: String(error?.message || error).slice(0, 400), ...(error?.code ? { errorCode: error.code } : {}) });
        } finally { run.finishedAt = new Date().toISOString(); }
      })();
      return publicRun(run);
    },
    async status() { const run = runs.get(root); return run ? publicRun(run) : { status: 'idle' }; },
    async cancel() {
      const run = runs.get(root);
      if (run?.status === 'running') run.controller.abort();
      return run ? publicRun(run) : { status: 'idle' };
    },
    async building() { const run = runs.get(root); return run?.status === 'running' ? { course: run.course, stage: run.stage, done: run.done, total: run.total } : null; },
  });
}
