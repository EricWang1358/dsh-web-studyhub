import { makeAsk } from '../../blueprint/jobs/ask.js';
import { createParallel } from '../../inventory/parallel.js';
import { inventoryStage } from '../../inventory/stage.js';
import { BOOK_FIELDS, freshBookState, presentBook } from './book-view.js';
import { leafStage } from './leaf-stage.js';
import { cardStage } from './card-stage.js';
import { confusableStage } from './confusable-stage.js';
import { BOOK_JOB_TITLE } from './messages.js';
import { kitStage } from './kit-stage.js';
import { examStage, outlineStage, planStage, refuseMovedOutline, saveStage } from './stages.js';

export const COURSE_BOOK_KIND = 'course-book-build';
/* What a retry and a stop keep, said to the console (see lib/job-contract.js): a retry goes on from the model calls that finished (kept for this Job while the
   plan is the same); a stop keeps the inventory already read (written at once), nothing of the book. */
const CAPABILITIES = Object.freeze({ cancel: true, set: false, retry: true, pauseMode: 'checkpoint', recoveryMode: 'none', executionModes: ['direct'],
  retryKeeps: 'completed', stopKeeps: 'completed' });

/**
 * One review book build, a quality workflow: (1) the inventory of every page range of every material, in parallel (inventory/stage.js); (2) the outline
 * built from it when it is missing, out of date or not built from it (outline/jobs/inventory-stages.js); (3) per knowledge point a MUST-COVER checklist
 * (book/work.js); (4) every point written in parallel from its own pages, reviewed by an independent call and repaired at most twice
 * (jobs/leaf-stage.js); (5) the term cards of every written unit that has none, from its text (jobs/card-stage.js), then a comparison of each pair of cards the
 * book calls opposite or parallel (jobs/confusable-stage.js); (6) the exam notes and the exam
 * answer kit with sample papers (jobs/kit-stage.js); (7) ONE write of the notes, their glossary
 * and coverage (and the outline it made). An unchanged point costs no call; a point still short after its repairs is kept, marked, and the Job ends
 * partial with only those left to do.
 * A build with many points to write first makes a SAMPLE (#710, jobs/sample-stage.js): (3) narrows the work to two points, (5) writes their exam notes
 * but not the answer kit (it is the whole papers', not a point's: the rest's build makes it), (6) saves them with the scale of the rest, and the Job ends
 * partial, the book waiting for the learner; their next build ('confirm') keeps those two and writes the rest like them.
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
    await refuseMovedOutline(ctx);
    ctx.parallel = createParallel(ctx, { limit: plan.concurrency });
    ctx.inventory = (await inventoryStage(ctx, ctx.parallel)).record;
    const first = await outlineStage(ctx);
    const { work, outline, held, sample } = await planStage(ctx, first.record, first.held);
    ctx.boundary('leaves');
    await leafStage(ctx, work);
    await cardStage(ctx, work);
    // A sample's build keeps the comparisons the book had (the rest's build compares the pairs of all its cards).
    if (!sample) await confusableStage(ctx, work);
    await examStage(ctx, work);
    // The sample's build leaves the answer kit to the rest's (its calls are in the scale of the rest).
    if (!sample) await kitStage(ctx, work);
    return saveStage(ctx, work, outline, held, sample);
  },
};
