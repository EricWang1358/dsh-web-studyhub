import { makeAsk } from '../../blueprint/jobs/ask.js';
import { BOOK_FIELDS, freshBookState, presentBook } from './book-view.js';
import { BOOK_JOB_TITLE } from './messages.js';
import { bodyStage, examStage, outlineStage, saveStage, workOf } from './stages.js';

export const COURSE_BOOK_KIND = 'course-book-build';
/* What a retry and a stop keep, said to the console (see lib/job-contract.js): a retry goes on from the model calls that finished (kept for this Job while the
   plan is the same), a stop saves nothing. */
const CAPABILITIES = Object.freeze({ cancel: true, set: false, retry: true, pauseMode: 'checkpoint', recoveryMode: 'none', executionModes: ['direct'],
  retryKeeps: 'completed', stopKeeps: 'nothing' });

/**
 * One review book build: the course's outline first when it is missing or out of date (the outline build's own stages, lib/contexts/generation/outline), then
 * for each knowledge point whose texts changed an explanation from its own materials (notes), with sample papers what they test of the points whose paper
 * places changed (exam),
 * and ONE write of the notes (and the outline it made) through the materials context (lib/course-book.js). The queue, lifecycle, control, metering and the task
 * console are the runtime's; every model call is a Step of the gateway. Not durable: a stop or a failure saves nothing; the answers of the calls that finished are
 * kept for a retry or a resume of this same Job.
 */
export const courseBookDefinition = {
  kind: COURSE_BOOK_KIND, version: 1, title: BOOK_JOB_TITLE, legacyFields: BOOK_FIELDS, capabilities: CAPABILITIES,
  legacyId: input => `course-book-${input.runId}`,
  // Whole the moment submit returns: a second start, the page and the console find it at once.
  initialPresentation: (input, { courseBook }) => presentBook(input, freshBookState(courseBook.plan)),

  async run(context, input, { courseBook: env }) {
    const { plan, kept } = env, state = freshBookState(plan);
    if (kept.planKey !== plan.planKey) { kept.results.clear(); kept.planKey = plan.planKey; }
    const reader = presentBook(input, state);
    const show = () => { try { context.present(reader); } catch { /* the Attempt is over: nothing is left to show */ } };
    const ctx = { context, input, env, plan, state, show, kept, boundary: ref => context.checkpoint(ref), ask: makeAsk(context, kept, state) };
    state.stage = 'checking'; show();
    const { record, held } = await outlineStage(ctx);
    const work = workOf(ctx, record);
    show();
    await bodyStage(ctx, work);
    await examStage(ctx, work);
    return saveStage(ctx, work, record, held);
  },
};
