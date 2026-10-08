import { stageText } from './messages.js';

/** What `job.status` reads from the record beyond the contract. */
export const BLUEPRINT_FIELDS = Object.freeze(['runId', 'scopeHash', 'blueprintStage']);

export const freshState = plan => ({ stage: 'queued', targetId: plan.supersedes ?? null, supersedes: plan.supersedes ?? null, course: plan.course ?? null,
  papers: { done: 0, total: plan.paperChunks.length }, windows: { done: 0, total: plan.windows.length },
  merge: { done: 0, total: (plan.mergeNeeded ? 1 : 0) + (plan.extraMergeNeeded ? 1 : 0) },
  points: 0, dropped: { evidence: 0, unresolved: 0, points: 0, questions: 0, places: 0 }, unverifiedQuestions: 0, reused: 0, unmatched: [], mergeRepaired: null,
  skippedPages: plan.inputs.flatMap(input => input.skippedPages ?? []), skippedWindows: [] });

/** The presentation reader of one build; `state` is the attempt's own. The same reader describes the Job before its first turn. */
export function presentBlueprint(input, state) {
  const steps = state.papers.done + state.merge.done + state.windows.done, total = state.papers.total + state.merge.total + state.windows.total;
  return observed => {
    const { status, error } = observed;
    const stage = status === 'complete' ? 'complete' : status === 'cancelled' ? 'cancelled' : status === 'paused' ? 'paused' : status === 'queued' ? 'queued' : state.stage;
    return {
      title: input.title,
      stage: { code: `blueprint.${stage}`, text: status === 'failed' ? error?.message ?? '' : stageText(input.language, stage, state) },
      progress: { done: status === 'complete' ? total : steps, total, unit: 'steps', percent: null, segments: [] },
      // `targetId` is the row of the 备考补习 page this build is about: the list it replaces while it runs, the saved list once it is saved (null for a first build still running).
      // `course` is the course the list is for (null when none), so the page can tell which rows are about the course it shows.
      detail: { targetId: state.targetId, supersedes: state.supersedes, course: state.course, blueprint: {
        stage, papers: { ...state.papers }, merge: { ...state.merge }, windows: { ...state.windows }, points: state.points,
        dropped: { ...state.dropped }, unverifiedQuestions: state.unverifiedQuestions, reused: state.reused, skippedPages: [...state.skippedPages],
        skippedWindows: state.skippedWindows.map(item => ({ number: item.number, pages: [...item.pages] })), unmatchedQuestions: [...state.unmatched],
        ...(state.mergeRepaired ? { mergeRepaired: { ...state.mergeRepaired } } : {}) } },
      legacy: { runId: input.runId, scopeHash: input.scopeHash, blueprintStage: stage },
    };
  };
}
