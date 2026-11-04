/* The size of a practice round and where the learner stands in it: the one place that says it (#660).
   A wrong answer queues ONE extra try of that question at the end of the round (lib/contexts/study/operations.js, `retry: true`). That extra try is
   a re-ask (再练), not a bigger round: the total shown when the round started is the total all the way through, and the re-ask has its own count.
   The run view, the sidebar's resume line, the deck rows and the course rows all read this, so they cannot say 2/5 where the page says 2/4.

   roundPosition({ entries, index }) -> {
     total:   the questions of the round (re-asks not counted), fixed from the first question to the last;
     at:      the 1-based question the learner is on, never above `total` (on a re-ask: `total`, the round is full);
     retries: how many re-asks the round holds (waiting or done);
     retryAt: 1-based number of the re-ask on screen, 0 when the question on screen is not a re-ask;
     last:    the question on screen is the last one in the queue (the button says 完成, not 下一题) } */
export function roundPosition({ entries = [], index = 0 } = {}) {
  const total = entries.filter((entry) => !entry.retry).length;
  const here = Math.min(Math.max(Number(index) || 0, 0), entries.length);
  const onRetry = here < entries.length && !!entries[here].retry;
  return {
    total,
    at: onRetry ? total : Math.min(here + 1, total),
    retries: entries.length - total,
    retryAt: onRetry ? entries.slice(0, here + 1).filter((entry) => entry.retry).length : 0,
    last: here >= entries.length - 1,
  };
}

/** `{ index, total }` for a list that draws 「第 index+1 / total 题」 (the sidebar, the deck and course rows): the round's own size, the position never past it. */
export function roundListing(run) {
  const { total, at } = roundPosition(run);
  return { index: Math.max(0, at - 1), total };
}
