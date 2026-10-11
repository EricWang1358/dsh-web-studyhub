import { makeAsk } from '../../blueprint/jobs/ask.js';
import { createParallel } from '../../inventory/parallel.js';
import { inventoryStage } from '../../inventory/stage.js';
import { BOOK_FIELDS, freshBookState, presentBook } from './book-view.js';
import { leafStage } from './leaf-stage.js';
import { BOOK_JOB_TITLE } from './messages.js';
import { examStage, outlineStage, planStage, saveStage } from './stages.js';

export const COURSE_BOOK_KIND = 'course-book-build';
/* What a retry and a stop keep, said to the console (see lib/job-contract.js): a retry goes on from the model calls that finished (kept for this Job while the
   plan is the same); a stop keeps the inventory already read (written at once), nothing of the book. */
const CAPABILITIES = Object.freeze({ cancel: true, set: false, retry: true, pauseMode: 'checkpoint', recoveryMode: 'none', executionModes: ['direct'],
  retryKeeps: 'completed', stopKeeps: 'completed' });

/**
 * One review book build, a quality workflow: (1) the inventory of every page range of every material, in parallel (inventory/stage.js); (2) the outline
 * built from it when it is missing, out of date or not built from it (outline/jobs/inventory-stages.js); (3) per knowledge point a MUST-COVER checklist
 * (book/work.js); (4) every point written in parallel from its own pages, reviewed by an independent call and repaired at most twice
 * (jobs/leaf-stage.js); (5) the exam notes with sample papers; (6) ONE write of the notes, their glossary and coverage (and the outline it made). An
 * unchanged point costs no call; a point still short after its repairs is kept, marked, and the Job ends partial with only those left to do.
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
    ctx.parallel = createParallel(ctx, { limit: plan.concurrency });
    ctx.inventory = (await inventoryStage(ctx, ctx.parallel)).record;
    const first = await outlineStage(ctx);
    const { work, outline, held } = await planStage(ctx, first.record, first.held);
    ctx.boundary('leaves');
    await leafStage(ctx, work);
    await examStage(ctx, work);
    return saveStage(ctx, work, outline, held);
  },
};
