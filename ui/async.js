/** Identity fence for model responses that may arrive after navigation or a rewrite. */
export const reviewEntryKey = (run) => run?.card
  ? JSON.stringify([run.id, run.index, run.card.id, run.queueVersion || 0, run.revision || 0])
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
  const before = current.queueVersion || 0, after = next.queueVersion || 0;
  if (after > before) return next;
  if (after !== before || current.index !== next.index || current.revealed !== next.revealed || !!current.feedback !== !!next.feedback) return current;
  const fields = ["prerequisites", "card", "solution", "revision", "sourceIds", "navigation", "coach", "vote", "level", "origin"];
  if (fields.every((key) => JSON.stringify(current[key]) === JSON.stringify(next[key]))) return current;
  return { ...current, ...Object.fromEntries(fields.map((key) => [key, next[key]])) };
}
