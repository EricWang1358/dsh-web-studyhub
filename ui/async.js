/** Identity fence for model responses that may arrive after navigation or a rewrite. */
export const reviewEntryKey = (run) => run?.card
  ? JSON.stringify([run.id, run.index, run.card.id, run.queueVersion || 0, run.revision || 0])
  : "";

/** The question on screen for a voice answer (#1031): the round, its place, the card and whether it is the retry. Unlike reviewEntryKey it outlives a
 * queue edit (review.queue.edit from the main chat) and a content resync (review.get), which leave the same question in front of the learner. */
export const voiceScopeKey = (run) => run?.card
  ? JSON.stringify([run.id, run.index, run.card.id, !!run.retry])
  : "";

/** Keep answer writes ordered; a failed last write blocks navigation/submit
 * until a subsequent selection has been saved successfully. */
export function createWriteQueue() {
  let tail = Promise.resolve();
  return {
    enqueue(write) {
      tail = tail.catch(() => {}).then(write);
      return tail;
    },
    flush() {
      return tail;
    },
  };
}

/** Accept explicit question resets, but never let an older poll undo an answer. */
export function mergeReviewPoll(current, next) {
  if (!current || current.id !== next.id) return current;
  // Another tab can end a run while its last model request is still pending.
  if (next.closed) return next;
  // A rubric grading finished in the background (WP12): its feedback arrives with the poll.
  if (!current.feedback && next.feedback?.rubric && current.index === next.index) return next;
  const before = current.queueVersion || 0, after = next.queueVersion || 0;
  if (after > before) return next;
  if (after !== before || current.index !== next.index || current.revealed !== next.revealed || !!current.feedback !== !!next.feedback) return current;
  // `intervals`: the gaps under the 0–5 buttons follow the clock (a new day changes them), so each poll brings them up to date.
  // `grading` / `correctionsPending` (#1031): a background grade started or failed on this question, a miss graded after the learner left it.
  const fields = ["prerequisites", "card", "solution", "revision", "sourceIds", "navigation", "coach", "vote", "level", "origin", "intervals", "grading", "correctionsPending"];
  if (fields.every((key) => JSON.stringify(current[key]) === JSON.stringify(next[key]))) return current;
  return { ...current, ...Object.fromEntries(fields.map((key) => [key, next[key]])) };
}
