import { stageText } from './messages.js';

/** What `job.status` reads from the record beyond the contract. */
export const BLUEPRINT_FIELDS = Object.freeze(['runId', 'scopeHash', 'blueprintStage']);

export const freshState = plan => ({ stage: 'queued', windows: { done: 0, total: plan.windows.length }, paper: { done: 0, total: plan.paperChunks.length * 2 }, points: 0,
  dropped: { evidence: 0, points: 0 }, reused: 0, unmatched: [], skippedPages: plan.inputs.flatMap(input => input.skippedPages ?? []) });

/** The presentation reader of one build; `state` is the attempt's own. The same reader describes the Job before its first turn. */
export function presentBlueprint(input, state) {
  const steps = state.windows.done + state.paper.done, total = state.windows.total + state.paper.total;
  return observed => {
    const { status, error } = observed;
    const stage = status === 'complete' ? 'complete' : status === 'cancelled' ? 'cancelled' : status === 'paused' ? 'paused' : status === 'queued' ? 'queued' : state.stage;
    return {
      title: input.title,
      stage: { code: `blueprint.${stage}`, text: status === 'failed' ? error?.message ?? '' : stageText(input.language, stage, state) },
      progress: { done: status === 'complete' ? total : steps, total, unit: 'steps', percent: null, segments: [] },
      detail: { blueprint: { stage, windows: { ...state.windows }, paper: { ...state.paper }, points: state.points, dropped: { ...state.dropped }, reused: state.reused,
        skippedPages: [...state.skippedPages], unmatchedQuestions: [...state.unmatched] } },
      legacy: { runId: input.runId, scopeHash: input.scopeHash, blueprintStage: stage },
    };
  };
}
