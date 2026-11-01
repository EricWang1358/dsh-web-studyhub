/* One time limit over a piece of work that asks a model, however many calls it makes: a second try does not get a limit of its own (tests/generation-suggest-golden.test.mjs, suggest.timeout).
   What to do with the answer stays with the caller: reading it differs at each place. */

export const MODEL_TIMEOUT_MESSAGE = 'The model did not respond in time (timeout)';

/** `work(race, signal)` runs under a limit of `ms`: `race(call)` is `call`, or a rejection with MODEL_TIMEOUT_MESSAGE once the limit has passed, and `signal` then aborts, so a call that was handed it stops
    spending tokens nobody will read. The error is a TimeoutError, which lib/model-retry.js does not ask again. The timer never outlives the work. */
export async function withinDeadline(ms, work) {
  const stop = new AbortController();
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = Object.assign(new Error(MODEL_TIMEOUT_MESSAGE), { name: 'TimeoutError' });
      // In this order: a call that answers the abort with an error of its own loses the race to the time limit.
      reject(error);
      stop.abort(error);
    }, ms);
  });
  // The limit may pass between two calls: nothing is racing it then, and that is no unhandled rejection. The next race sees it.
  expired.catch(() => {});
  try { return await work(call => Promise.race([call, expired]), stop.signal); } finally { clearTimeout(timer); }
}
