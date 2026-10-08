import { BLUEPRINT_FIELDS, freshState, presentBlueprint } from './blueprint-view.js';
import { finishBuild } from './stage-save.js';
import { stageContext } from './stage-context.js';
import { readPapers } from './stage-papers.js';
import { readWindows, uniteExtras } from './stage-slides.js';
import { unitePapers } from './stage-union.js';
import { BLUEPRINT_TITLE } from './messages.js';

export const EXAM_BLUEPRINT_KIND = 'exam-blueprint-build';
/* What a retry and a stop keep, said to the console (see lib/job-contract.js): a retry goes on from the model calls that finished
   (the answers are kept for this Job while the plan is the same), a stop saves nothing. */
const CAPABILITIES = Object.freeze({ cancel: true, set: false, retry: true, pauseMode: 'checkpoint', recoveryMode: 'none', executionModes: ['direct'],
  retryKeeps: 'completed', stopKeeps: 'nothing' });

/**
 * One exam point list build, bottom-up (plan revision 5): the chosen sample papers are read first (what each question tests, in two levels), the points of several
 * chunks of paper are united (the model may join synonyms, the program checks nothing is lost), the lecture slides are read in windows for the places of those points
 * and for what the papers did not reach, the extra points of the windows are united the same way, and ONE material is saved through the materials context
 * (lib/exam-blueprint-material.js). The queue, lifecycle, control, metering and the task console are the runtime's; the plan, the library and the model are the domain's
 * (blueprint/plan.js, blueprint/union.js, the bindings of the submit), and every model call is a Step of the gateway. The stages are the stage-*.js files of this folder.
 * Not durable. A stop or a failure saves nothing; the answers of the calls that finished are kept for a retry or a resume of this same Job (they are the answers
 * to this plan, by its key).
 */
export const examBlueprintDefinition = {
  kind: EXAM_BLUEPRINT_KIND, version: 1, title: BLUEPRINT_TITLE, legacyFields: BLUEPRINT_FIELDS, capabilities: CAPABILITIES,
  legacyId: input => `blueprint-${input.runId}`,
  // Whole the moment submit returns: a second start, the list and the console find it at once.
  initialPresentation: (input, { blueprint }) => presentBlueprint(input, freshState(blueprint.plan)),

  async run(context, input, { blueprint: env }) {
    const { plan, kept } = env, state = freshState(plan);
    if (kept.planKey !== plan.planKey) { kept.results.clear(); kept.planKey = plan.planKey; }
    const ctx = stageContext(context, input, env, state, presentBlueprint(input, state));
    state.stage = 'checking'; ctx.show();
    const papers = await readPapers(ctx);
    const base = await unitePapers(ctx, papers);
    await uniteExtras(ctx, base, await readWindows(ctx, base));
    return finishBuild(ctx, base);
  },
};
