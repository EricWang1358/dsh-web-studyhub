/* Light 陪学 calls (rewrite, nudge, followup, translation, variants) hit the
   model in the background; a single empty reply or a provider hiccup used to
   surface as a failed task ("Model returned no text"). Retry those a couple
   of times with backoff. A timeout or a caller abort is not retried: the
   attempt already spent its whole budget, or nobody wants the answer. */

export const MODEL_RETRY_DELAYS_MS = [800, 2000];

const TRANSIENT =
  /Model returned no text|overloaded|rate.?limit|too many requests|temporar(il)?y|unavailable|\b(408|409|425|429|500|502|503|504|520|522|524|529)\b|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|fetch failed|network|stream (closed|ended|error)|premature/i;

const TRANSIENT_CODES = /^(RATE_LIMIT|TRANSPORT|OVERLOADED|SERVER|SERVER_ERROR|UNAVAILABLE|STALLED)$/i;

export function isTransientModelError(error) {
  if (!error) return false;
  if (error.name === "AbortError" || error.name === "TimeoutError") return false;
  if (TRANSIENT_CODES.test(String(error.code || ""))) return true;
  if (Number(error.status) === 429 || Number(error.status) >= 500) return true;
  return TRANSIENT.test(`${error.message || ""} ${error.code || ""} ${error.status || ""}`);
}
/** Any failure of the model call itself, as opposed to a bad reply we could correct. */
export const isModelFailure = (error) =>
  !!error && (error.modelFailure === true || error.name === "TimeoutError" || error.name === "AbortError" || isTransientModelError(error));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Call fn, retrying transient model failures after each delay in turn. */
export async function withModelRetry(fn, { delays = MODEL_RETRY_DELAYS_MS } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= delays.length || !isTransientModelError(error)) {
        if (attempt > 0 && error && typeof error === "object") error.attempts = attempt + 1;
        throw error;
      }
      await sleep(delays[attempt]);
    }
  }
}

/** Learner-facing wording for a background model failure. */
export function modelFailureMessage(error) {
  const message = String(error?.message || error || "");
  const tries = error?.attempts > 1 ? `，已自动重试 ${error.attempts - 1} 次` : "";
  if (/Model returned no text/i.test(message)) return `模型这次没有返回内容${tries}`;
  if (error?.name === "TimeoutError" || /timed? ?out|aborted/i.test(message)) return "模型长时间没有响应（请求超时），可以稍后重试";
  if (/RATE_LIMIT/i.test(error?.code || "") || Number(error?.status) === 429) return `模型请求太频繁，被限流了${tries}`;
  if (isTransientModelError(error)) return `模型服务暂时不可用${tries}`;
  return message.slice(0, 200);
}

/** Error for a stream that ended with a provider `error`/`aborted` finish. */
export function streamFailure(finish, { timedOut = false, timeoutMs = 0 } = {}) {
  if (timedOut) {
    const error = new Error(`Model timed out after ${Math.round(timeoutMs / 1000)}s`);
    error.name = "TimeoutError";
    return error;
  }
  const failure = finish?.failure || {};
  const error = new Error(failure.message || `Model stream ${finish?.kind || "failed"}`);
  if (finish?.kind === "aborted") error.name = "AbortError";
  if (failure.code) error.code = failure.code;
  if (failure.status) error.status = failure.status;
  if (failure.providerRetryAfterMs) error.retryAfterMs = failure.providerRetryAfterMs;
  return error;
}

/**
 * Start one attempt; if it has produced no chunk at all after hedgeMs, start a
 * second one in parallel and keep whichever answers first (the other is
 * aborted). A stalled provider request usually stays stalled, while a fresh
 * one is served normally. run(signal, onChunk) resolves to the reply text.
 */
export function hedgeFirstChunk(run, { hedgeMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const attempts = [];
    let settled = false,
      streaming = false,
      timer = null;
    const finish = (fn, value, winner) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const a of attempts) if (a !== winner) a.controller.abort();
      fn(value);
    };
    const launch = () => {
      const attempt = { controller: new AbortController(), done: false };
      attempts.push(attempt);
      run(attempt.controller.signal, () => {
        if (!streaming) {
          streaming = true;
          clearTimeout(timer);
        }
      }).then(
        (text) => finish(resolve, text, attempt),
        (error) => {
          attempt.done = true;
          // Another attempt still running may yet answer; wait for it.
          if (attempts.every((a) => a.done)) finish(reject, error);
        },
      );
    };
    launch();
    timer = setTimeout(() => {
      if (!settled && !streaming && !attempts[0].done) launch();
    }, hedgeMs);
  });
}
