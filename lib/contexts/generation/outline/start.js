import { id } from '../../../util.js';
import { planOutline, planPapersOnly } from './plan.js';
import { COURSE_OUTLINE_KIND } from './jobs/course-outline-build.js';
import { REFUSALS, jobTitle } from './jobs/messages.js';

/** The 复习全书 build's kind (lib/contexts/generation/book/jobs/course-book-build.js), named here so this folder does not import the one built on it. */
const BOOK_KIND = 'course-book-build';

const refuse = (code, language) => Object.assign(new Error(REFUSALS[code](language)), { code });

/**
 * `generation.courseOutline.build`: check the request (stage 0: no model, nothing started when it refuses) and hand it to the unified runtime as one Job.
 * No estimate and no confirmation: the task page shows what it used, as every task does. One build per course at a time: a second start answers with the
 * running one. `ports.read()` is the library as this context reads it; `ports.materials(action, payload)` is the materials context; `ports.runtime` is
 * `{ jobs, sharedQuota }`.
 */
export function createCourseOutlineJobs(ports) {
  const { runtime, read, materials, work, activeJob } = ports;
  async function build(args = {}, request = {}) {
    const language = args.language === 'en' || request.language === 'en' ? 'en' : 'zh';
    if (!runtime?.jobs) throw refuse('executor-unavailable', language);
    const plan = args.papersOnly === true ? planPapersOnly(await read(), { ...args, language }) : planOutline(await read(), { ...args, language });
    if (runtime.sharedQuota) throw refuse('capability-unverified', language);
    const active = kind => [...work.jobs.values()].find(job => job.type === kind && activeJob(job) && job.contract?.detail?.course === plan.course);
    const running = active(COURSE_OUTLINE_KIND);
    if (running) return { jobId: running.id, status: running.status, alreadyRunning: true };
    // A 复习全书 build of the course may be organising its outline right now (lib/contexts/generation/book): one outline at a time.
    if (active(BOOK_KIND)) throw refuse('course-outline-book-running', language);
    const input = { runId: id(), title: jobTitle(language, plan.course), language, scopeHash: plan.scopeHash, course: plan.course,
      ...(plan.supersedes ? { supersedes: plan.supersedes } : {}) };
    const bindings = { courseOutline: { plan, kept: { results: new Map(), planKey: null },
      // The creation time is written here (the record itself is deterministic); the outline it replaces is archived in the same write, and only then.
      ingest: async (record, replaces) => {
        await materials('materials.sources.ingest', { sources: [{ ...record, createdAt: new Date().toISOString() }], ...(replaces ? { archive: [replaces] } : {}) }, request);
      } } };
    try {
      const started = await runtime.jobs.submit(COURSE_OUTLINE_KIND, input, {}, bindings);
      return { jobId: started.runtime.legacyId, status: 'running', steps: plan.steps };
    } catch (error) {
      throw REFUSALS[error?.code] ? refuse(error.code, language) : error;
    }
  }
  return { 'generation.courseOutline.build': build };
}
