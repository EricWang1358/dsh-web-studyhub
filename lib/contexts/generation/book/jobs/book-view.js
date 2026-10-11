import { stageText } from './messages.js';

/** What `job.status` reads from the record beyond the contract. */
export const BOOK_FIELDS = Object.freeze(['runId', 'scopeHash', 'bookStage']);

/** The state of one attempt. The points to write are known once the inventory and the outline are; their steps join the total then. */
export const freshBookState = plan => ({ stage: 'queued', targetId: plan.previous?.id ?? null, supersedes: plan.previous?.id ?? null, course: plan.course,
  mode: plan.mode, inventory: { done: 0, total: plan.inventory?.calls.length ?? 0, failed: 0 }, outline: null, outlineSteps: plan.outlinePlan?.steps ?? 0,
  leaves: { total: 0, done: 0, ok: 0, short: 0, failed: 0 }, calls: { review: 0, repair: 0 }, board: [], exam: { done: 0, total: 0 },
  saved: 0, kept: 0, examWritten: 0, dropped: 0, missed: 0, empty: 0, repaired: 0, short: 0, reused: 0, unchanged: false, pool: null });

const OUTLINE_PARTS = ['inventory', 'cluster', 'order', 'map', 'reduce', 'papers'];
const outlineDone = state => (state.outline ? OUTLINE_PARTS.reduce((sum, part) => sum + (state.outline[part]?.done ?? 0), 0) : 0);
const outlineTotal = state => (state.outline ? OUTLINE_PARTS.reduce((sum, part) => sum + (state.outline[part]?.total ?? 0), 0) : state.outlineSteps);

/** The presentation reader of one build; `state` is the attempt's own. The same reader describes the Job before its first turn. */
export function presentBook(input, state) {
  return observed => {
    const { status, error } = observed;
    const steps = state.inventory.done + outlineDone(state) + state.leaves.done + state.exam.done;
    const total = state.inventory.total + outlineTotal(state) + state.leaves.total + state.exam.total;
    const stage = status === 'complete' ? 'complete' : status === 'cancelled' ? 'cancelled' : status === 'paused' ? 'paused' : status === 'queued' ? 'queued' : state.stage;
    return {
      title: input.title,
      stage: { code: `course-book.${stage}`, text: status === 'failed' ? error?.message ?? '' : stageText(input.language, stage, state) },
      progress: { done: status === 'complete' ? total : Math.min(steps, total), total, unit: 'steps', percent: null, segments: [] },
      // `targetId`: the book this build is about (the one it replaces while it runs, the saved one once saved); `course`: the course it is for. `board`: each
      // point being worked on and its state (waiting, writing, reviewing, ok, short, failed), what the console and the book page say.
      detail: { targetId: state.targetId, supersedes: state.supersedes, course: state.course, book: {
        stage, mode: state.mode, inventory: { ...state.inventory }, outline: state.outline ? state.outline.stage : null, leaves: { ...state.leaves },
        board: state.board.map(row => ({ ...row })), exam: { ...state.exam }, saved: state.saved, kept: state.kept, examWritten: state.examWritten, dropped: state.dropped,
        missed: state.missed, empty: state.empty, repaired: state.repaired, short: state.short, reused: state.reused, unchanged: state.unchanged,
        ...(state.pool ? { pool: { ...state.pool } } : {}) } },
      legacy: { runId: input.runId, scopeHash: input.scopeHash, bookStage: stage },
    };
  };
}