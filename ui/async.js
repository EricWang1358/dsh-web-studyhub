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
  const before = current.queueVersion || 0, after = next.queueVersion || 0;
  if (after > before) return next;
  if (after !== before || current.index !== next.index || current.revealed !== next.revealed || !!current.feedback !== !!next.feedback) return current;
  const fields = ["prerequisites", "card", "solution", "revision", "sourceIds", "navigation", "coach", "vote", "level"];
  if (fields.every((key) => JSON.stringify(current[key]) === JSON.stringify(next[key]))) return current;
  return { ...current, ...Object.fromEntries(fields.map((key) => [key, next[key]])) };
}
