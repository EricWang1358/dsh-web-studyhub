import { stageText } from './messages.js';

/** What `job.status` reads from the record beyond the contract. */
export const OUTLINE_FIELDS = Object.freeze(['runId', 'scopeHash', 'outlineStage']);

export const freshState = plan => ({ stage: 'queued', targetId: plan.supersedes ?? null, supersedes: plan.supersedes ?? null, course: plan.course,
  inventory: { done: 0, total: plan.inventory?.calls.length ?? 0, failed: 0 }, cluster: { done: 0, total: 0 }, order: { done: 0, total: 0 },
  map: { done: 0, total: plan.batches.length }, reduce: { done: 0, total: plan.base ? 0 : 1 }, papers: { done: 0, total: plan.paperChunks.length },
  chapters: 0, leaves: 0, leftover: 0, units: 0, invalid: 0, repeated: 0, merged: 0, unverified: 0, reused: 0, materials: plan.described.documents.length });

/** The presentation reader of one build; `state` is the attempt's own. The same reader describes the Job before its first turn. */
export function presentOutline(input, state) {
  return observed => {
    const steps = state.inventory.done + state.cluster.done + state.order.done + state.map.done + state.reduce.done + state.papers.done;
    const total = state.inventory.total + state.cluster.total + state.order.total + state.map.total + state.reduce.total + state.papers.total;
    const { status, error } = observed;
    const stage = status === 'complete' ? 'complete' : status === 'cancelled' ? 'cancelled' : status === 'paused' ? 'paused' : status === 'queued' ? 'queued' : state.stage;
    return {
      title: input.title,
      stage: { code: `course-outline.${stage}`, text: status === 'failed' ? error?.message ?? '' : stageText(input.language, stage, state) },
      progress: { done: status === 'complete' ? total : steps, total, unit: 'steps', percent: null, segments: [] },
      // `targetId`: the outline this build is about (the one it replaces while it runs, the saved one once saved); `course`: the course it is for.
      detail: { targetId: state.targetId, supersedes: state.supersedes, course: state.course, outline: {
        stage, inventory: { ...state.inventory }, cluster: { ...state.cluster }, order: { ...state.order }, map: { ...state.map }, reduce: { ...state.reduce },
        papers: { ...state.papers }, materials: state.materials,
        chapters: state.chapters, leaves: state.leaves,
        units: state.units, leftover: state.leftover, invalid: state.invalid, repeated: state.repeated, merged: state.merged, unverified: state.unverified, reused: state.reused } },
      legacy: { runId: input.runId, scopeHash: input.scopeHash, outlineStage: stage },
    };
  };
}
