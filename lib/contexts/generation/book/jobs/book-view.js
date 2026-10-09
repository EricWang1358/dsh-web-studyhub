import { stageText } from './messages.js';

/** What `job.status` reads from the record beyond the contract. */
export const BOOK_FIELDS = Object.freeze(['runId', 'scopeHash', 'bookStage']);

/** The state of one attempt. The steps of the outline stage and of the notes are known from the plan when the outline is kept, else once the outline is made. */
export const freshBookState = plan => ({ stage: 'queued', targetId: plan.previous?.id ?? null, supersedes: plan.previous?.id ?? null, course: plan.course,
  mode: plan.mode, outline: null, outlineSteps: plan.outlinePlan?.steps ?? 0, outlineDone: 0,
  notes: { done: 0, total: plan.work?.bodyBatches.length ?? 0 }, exam: { done: 0, total: plan.work?.examBatches.length ?? 0 },
  leaves: 0, written: 0, kept: 0, examWritten: 0, dropped: 0, missed: 0, empty: 0, reused: 0, unchanged: false });

const outlineDone = state => (state.outline ? state.outline.map.done + state.outline.reduce.done + state.outline.papers.done : state.outlineDone);

/** The presentation reader of one build; `state` is the attempt's own. The same reader describes the Job before its first turn. */
export function presentBook(input, state) {
  return observed => {
    const { status, error } = observed;
    const steps = outlineDone(state) + state.notes.done + state.exam.done, total = state.outlineSteps + state.notes.total + state.exam.total;
    const stage = status === 'complete' ? 'complete' : status === 'cancelled' ? 'cancelled' : status === 'paused' ? 'paused' : status === 'queued' ? 'queued' : state.stage;
    return {
      title: input.title,
      stage: { code: `course-book.${stage}`, text: status === 'failed' ? error?.message ?? '' : stageText(input.language, stage, state) },
      progress: { done: status === 'complete' ? total : Math.min(steps, total), total, unit: 'steps', percent: null, segments: [] },
      // `targetId`: the book this build is about (the one it replaces while it runs, the saved one once saved); `course`: the course it is for.
      detail: { targetId: state.targetId, supersedes: state.supersedes, course: state.course, book: {
        stage, mode: state.mode, outline: state.outline ? state.outline.stage : null, notes: { ...state.notes }, exam: { ...state.exam }, leaves: state.leaves,
        written: state.written, kept: state.kept, examWritten: state.examWritten, dropped: state.dropped, missed: state.missed, empty: state.empty, reused: state.reused,
        unchanged: state.unchanged } },
      legacy: { runId: input.runId, scopeHash: input.scopeHash, bookStage: stage },
    };
  };
}
