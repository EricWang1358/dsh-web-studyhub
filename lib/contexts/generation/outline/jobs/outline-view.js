import { stageText } from './messages.js';

/** What `job.status` reads from the record beyond the contract. */
export const OUTLINE_FIELDS = Object.freeze(['runId', 'scopeHash', 'outlineStage']);

export const freshState = plan => ({ stage: 'queued', targetId: plan.supersedes ?? null, supersedes: plan.supersedes ?? null, course: plan.course,
  map: { done: 0, total: plan.batches.length }, reduce: { done: 0, total: 1 }, papers: { done: 0, total: plan.paperChunks.length },
  chapters: 0, leaves: 0, leftover: 0, units: 0, invalid: 0, repeated: 0, merged: 0, unverified: 0, reused: 0, materials: plan.described.documents.length });

/** The presentation reader of one build; `state` is the attempt's own. The same reader describes the Job before its first turn. */
export function presentOutline(input, state) {
  const steps = state.map.done + state.reduce.done + state.papers.done, total = state.map.total + state.reduce.total + state.papers.total;
  return observed => {
    const { status, error } = observed;
    const stage = status === 'complete' ? 'complete' : status === 'cancelled' ? 'cancelled' : status === 'paused' ? 'paused' : status === 'queued' ? 'queued' : state.stage;
    return {
      title: input.title,
      stage: { code: `course-outline.${stage}`, text: status === 'failed' ? error?.message ?? '' : stageText(input.language, stage, state) },
      progress: { done: status === 'complete' ? total : steps, total, unit: 'steps', percent: null, segments: [] },
      // `targetId`: the outline this build is about (the one it replaces while it runs, the saved one once saved); `course`: the course it is for.
      detail: { targetId: state.targetId, supersedes: state.supersedes, course: state.course, outline: {
        stage, map: { ...state.map }, reduce: { ...state.reduce }, papers: { ...state.papers }, materials: state.materials, chapters: state.chapters, leaves: state.leaves,
        units: state.units, leftover: state.leftover, invalid: state.invalid, repeated: state.repeated, merged: state.merged, unverified: state.unverified, reused: state.reused } },
      legacy: { runId: input.runId, scopeHash: input.scopeHash, outlineStage: stage },
    };
  };
}
