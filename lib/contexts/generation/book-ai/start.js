import { id } from '../../../util.js';
import { planAi } from './plan.js';
import { COURSE_BOOK_AI_KIND } from './jobs/course-book-ai.js';
import { REFUSALS } from './jobs/messages.js';

const refuse = (code, language) => Object.assign(new Error(REFUSALS[code](language)), { code });

/**
 * `generation.courseBook.explain`: check the request (no model, nothing started when it refuses) and hand it to the unified runtime as one Job, visible in the
 * task console. No estimate and no confirmation. The language is the request's. `ports.read()` is the library as this context reads it; `ports.materials` is
 * the materials context (the block is written by its `book.aiWrite`, in the book's writer queue); `ports.runtime` is `{ jobs, sharedQuota }`.
 */
export function createCourseBookAiJobs(ports) {
  const { runtime, read, materials } = ports;
  async function explain(args = {}, request = {}) {
    const language = args.language === 'en' || request.language === 'en' ? 'en' : 'zh';
    if (!runtime?.jobs) throw refuse('executor-unavailable', language);
    const plan = planAi(await read(), { ...args, language });
    if (runtime.sharedQuota) throw refuse('capability-unverified', language);
    const blockId = args.replace || `ai${id().replace(/[^0-9a-z]/gi, '').slice(0, 12)}`;
    const input = { runId: id(), blockId, title: plan.title, language, course: plan.course, heading: plan.leaf.hid, mode: plan.mode, scopeHash: plan.key };
    const bindings = { courseBookAi: { plan, kept: { results: new Map() }, write: block => materials('materials.book.aiWrite', block, request) } };
    try {
      const started = await runtime.jobs.submit(COURSE_BOOK_AI_KIND, input, {}, bindings);
      return { jobId: started.runtime.legacyId, status: 'running', blockId };
    } catch (error) {
      if (REFUSALS[error?.code]) throw refuse(error.code, language);
      throw error;
    }
  }
  return { 'generation.courseBook.explain': explain };
}
