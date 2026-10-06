import { RetrievalError } from '../../../retrieval.js';
import { INDEX_TEXT } from '../../../retrieval-messages.js';
import { canIngest, indexUnavailable } from '../../../retrieval-index.js';
import { ALL_COURSES } from '../index-plan.js';
import { ACTIVE_STATUSES, INDEX_KIND, runView } from './retrieval-index-view.js';

const NEEDS_SESSION = 'retrieval-index-needs-session';

/** start / status / cancel / building of retrieval.index.* on the runtime. `ports.retrievalRuntime` brings the scoped job port and the
 * background-safe ports a build keeps using after the request has ended. One library has one build: the check and the submit sit in the same tick. */
export function createJobIndexRuns({ ports, planner }) {
  const { jobs, background } = ports.retrievalRuntime;
  const mine = () => jobs.list().filter(job => job.kind === INDEX_KIND);
  const active = () => mine().find(job => ACTIVE_STATUSES.includes(job.status));
  const joined = (job, course) => {
    const view = runView(job, { course });
    return course === view.course ? view : { ...view, requestedCourse: course };
  };
  return Object.freeze({
    async start(a) {
      const course = a.course ?? ALL_COURSES;
      if (active()) return joined(active(), course);
      if (!canIngest(ports.retrieval)) throw indexUnavailable();
      const { picked, plan, firstRun } = await planner.prepare(a.course);
      if (!picked.length) throw new Error(INDEX_TEXT.noSources);
      if (active()) return joined(active(), course);
      try {
        const admitted = Promise.withResolvers();
        const submitted = await jobs.submit(INDEX_KIND, { course }, {}, { ...background(), admitted: admitted.resolve });
        // The receipt is the build as admitted (course, total, first-run known), or as it ended if admission refused it.
        await Promise.race([admitted.promise, jobs.wait(submitted.jobId)]);
        const known = { course, total: plan.add.length + plan.remove.length, unchanged: plan.unchanged, firstRun, startedAt: new Date().toISOString() };
        return runView(jobs.status(submitted.jobId), known);
      } catch (error) {
        throw error.code === 'executor-unavailable' ? new RetrievalError(NEEDS_SESSION, INDEX_TEXT.needsSession) : error;
      }
    },
    async status() { const job = active() ?? mine().at(-1); return job ? runView(job) : { status: 'idle' }; },
    async cancel() {
      const job = active();
      if (job) await jobs.control(job.jobId, 'cancel');
      const latest = active() ?? mine().at(-1);
      return latest ? runView(latest) : { status: 'idle' };
    },
    async building() {
      const job = active(), view = job && runView(job);
      return view ? { course: view.course, stage: view.stage, done: view.done, total: view.total } : null;
    },
  });
}
