import { id } from '../../../util.js';
import { readAudioSettings } from '../../../audio-settings.js';
import { planBook } from './plan.js';
import { COURSE_BOOK_KIND } from './jobs/course-book-build.js';
import { COURSE_OUTLINE_KIND } from '../outline/jobs/course-outline-build.js';
import { REFUSALS as OUTLINE_REFUSALS } from '../outline/jobs/messages.js';
import { REFUSALS, jobTitle } from './jobs/messages.js';
import { learnerTextPoints } from '../../../course-book-files.js';

const refuse = (code, language) => Object.assign(new Error(REFUSALS[code](language)), { code });

/**
 * `generation.courseBook.build`: check the request (stage 0: no model, nothing started when it refuses) and hand it to the unified runtime as one Job.
 * No estimate and no confirmation: the task page shows what it used, as every task does. One build per course at a time: a second start answers with the
 * running one; while the course's outline is being organised by its own task, the book waits for it (refused). `ports.read()` is the library as this
 * context reads it; `ports.materials(action, payload)` is the materials context; `ports.runtime` is `{ jobs, sharedQuota }`.
 */
export function createCourseBookJobs(ports) {
  const { runtime, read, materials, work, activeJob } = ports;
  async function build(args = {}, request = {}) {
    const language = args.language === 'en' || request.language === 'en' ? 'en' : 'zh';
    if (!runtime?.jobs) throw refuse('executor-unavailable', language);
    // The parallel calls run at the learner's text concurrency (the setting the audio pipeline's text steps use).
    const concurrency = (await readAudioSettings().catch(() => null))?.textConcurrency;
    const state = await read();
    const plan = planBook(state, { ...args, language, concurrency });
    if (runtime.sharedQuota) throw refuse('capability-unverified', language);
    const active = kind => [...work.jobs.values()].find(job => job.type === kind && activeJob(job) && job.contract?.detail?.course === plan.course);
    const running = active(COURSE_BOOK_KIND);
    if (running) return { jobId: running.id, status: running.status, alreadyRunning: true };
    if (active(COURSE_OUTLINE_KIND)) throw refuse('course-book-outline-running', language);
    // Asked to organise the outline again (`rebuildOutline`) over the learner's own text: the same question as the outline build's (#461). The rebuild this
    // task makes by itself (the materials changed, or the outline is the quick one from the names) is not asked: the text follows its pages
    // (lib/course-book-remap.js), and a note no new point holds enough of waits in 未归位; a material cut into parts follows into its biggest part, whatever it is called.
    const own = args.rebuildOutline === true && args.confirm !== true && plan.mode === 'full' ? learnerTextPoints(state, plan.course) : [];
    if (own.length) throw Object.assign(new Error(OUTLINE_REFUSALS['course-outline-book-confirm'](language, own)), { code: 'course-outline-book-confirm' });
    const input = { runId: id(), title: jobTitle(language, plan.course), language, scopeHash: plan.scopeHash, course: plan.course,
      ...(plan.previous ? { supersedes: plan.previous.id } : {}) };
    const bindings = { courseBook: { plan, kept: { results: new Map(), planKey: null },
      // The creation time is written here (the records themselves are deterministic); what they replace is archived in the same write, and only then.
      ingest: async (records, archive) => {
        const createdAt = new Date().toISOString();
        await materials('materials.sources.ingest', { sources: records.map(record => ({ ...record, createdAt })), ...(archive.length ? { archive } : {}) }, request);
      },
      // The inventory is written as soon as it is read (the one it replaces is removed: it is a cache).
      saveInventory: async (record, replaces) => {
        await materials('materials.sources.ingest', { sources: [{ ...record, createdAt: new Date().toISOString() }], ...(replaces ? { archive: [replaces] } : {}) }, request);
      } } };
    try {
      const started = await runtime.jobs.submit(COURSE_BOOK_KIND, input, {}, bindings);
      return { jobId: started.runtime.legacyId, status: 'running', steps: plan.steps };
    } catch (error) {
      if (REFUSALS[error?.code]) throw refuse(error.code, language);
      throw OUTLINE_REFUSALS[error?.code] ? Object.assign(new Error(OUTLINE_REFUSALS[error.code](language)), { code: error.code }) : error;
    }
  }
  return { 'generation.courseBook.build': build };
}
