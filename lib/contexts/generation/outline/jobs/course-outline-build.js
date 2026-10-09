import { makeAsk } from '../../blueprint/jobs/ask.js';
import { OUTLINE_FIELDS, freshState, presentOutline } from './outline-view.js';
import { OUTLINE_JOB_TITLE } from './messages.js';
import { mapStage, paperStage, reduceStage, saveStage } from './stages.js';

export const COURSE_OUTLINE_KIND = 'course-outline-build';
/* What a retry and a stop keep, said to the console (see lib/job-contract.js): a retry goes on from the model calls that finished (kept for this Job while the
   plan is the same), a stop saves nothing. */
const CAPABILITIES = Object.freeze({ cancel: true, set: false, retry: true, pauseMode: 'checkpoint', recoveryMode: 'none', executionModes: ['direct'],
  retryKeeps: 'completed', stopKeeps: 'nothing' });

/**
 * One course outline build: the course's materials, described compactly, are grouped into knowledge points a batch at a time (map), the points are arranged into
 * chapters and sections in learning order (reduce), the chosen sample papers mark the leaves they test (papers), and ONE record is saved through the materials
 * context (lib/course-outline-book.js). The queue, lifecycle, control, metering and the task console are the runtime's; the plan, the library and the model
 * are the domain's (outline/plan.js, outline/tree.js, the bindings of the submit), and every model call is a Step of the gateway. Not durable: a stop or a
 * failure saves nothing; the answers of the calls that finished are kept for a retry or a resume of this same Job.
 */
export const courseOutlineDefinition = {
  kind: COURSE_OUTLINE_KIND, version: 1, title: OUTLINE_JOB_TITLE, legacyFields: OUTLINE_FIELDS, capabilities: CAPABILITIES,
  legacyId: input => `course-outline-${input.runId}`,
  // Whole the moment submit returns: a second start, the page and the console find it at once.
  initialPresentation: (input, { courseOutline }) => presentOutline(input, freshState(courseOutline.plan)),

  async run(context, input, { courseOutline: env }) {
    const { plan, kept } = env, state = freshState(plan);
    if (kept.planKey !== plan.planKey) { kept.results.clear(); kept.planKey = plan.planKey; }
    const reader = presentOutline(input, state);
    const show = () => { try { context.present(reader); } catch { /* the Attempt is over: nothing is left to show */ } };
    const ctx = { context, input, env, plan, state, show, boundary: ref => context.checkpoint(ref), ask: makeAsk(context, kept, state) };
    state.stage = 'checking'; show();
    const outline = await reduceStage(ctx, await mapStage(ctx));
    await paperStage(ctx, outline);
    return saveStage(ctx, outline);
  },
};
