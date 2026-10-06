/* How long a job's model calls took to answer: DSH's own figures where the host has them,
   our own observation of the same boundaries where it does not.

   The 任务 console shows the two figures DSH's session statistics panel shows
   (dsh-session-stats, the `sessionStats` projection): 首 token 平均（TTFT） and
   输出速度（TPS）. Those four counters — ttftMs, ttftSteps, decodeMs, decodeTokens —
   are DSH's own fold over one DSH session (step/start → the first token delta → the
   settled assistant message), and this module copies them field for field so a job
   reads exactly like the harness's own 会话统计.

   A job is not one DSH session, though. It is many calls: each generation phase runs
   as its own one-shot DSH child (whose `sessionStats` the host already serves through
   the same observation lease lib/token-usage.js reads token usage from), while audio
   text and translation phases call the model directly on this plugin's own client
   (lib/index.js), which is no agent session and therefore has no projection at all.
   So, exactly as readSessionUsage does for tokens, the host's figures are AUTHORITATIVE
   and this module's own observation is the fallback:

     - a call whose child session reported `sessionStats` contributes those counters
       unchanged (one child may hold several model calls; DSH counted them all);
     - any other call contributes the same boundaries measured here: the wait
       firstOutputAt − startedAt, and the writing endedAt − firstOutputAt over the
       output tokens the provider itself reported.

   A call that can say neither is left out and never guessed at: a cancelled or
   still-running call, a provider that does not stream (a transcription), a call whose
   usage was never reported. DSH's fold skips a step with no token delta for the same
   reason. Only a call that has ENDED counts — DSH settles a step at its assistant
   message — so a running job's figures are its settled calls' and grow as calls finish.

   Nothing here is persisted and nothing is invented; a count is never derived from the
   length of a text. Reasoning tokens are inside outputTokens (lib/token-usage.js), so
   they count as writing here too. */

/** One observed timestamp as epoch ms, or NaN. */
const at = (value) => (typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN);

const isCount = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * DSH's own counters for one call, when its child session reported them: the `sessionStats`
 * view, kept field for field. Null when the call has none or it is not trustworthy.
 */
export function dshTiming(timing) {
  if (!timing || typeof timing !== 'object') return null;
  const { ttftMs, ttftSteps, decodeMs, decodeTokens } = timing;
  if (![ttftMs, ttftSteps, decodeMs, decodeTokens].every(isCount)) return null;
  return { ttftMs, ttftSteps, decodeMs, decodeTokens };
}

/**
 * What one call contributes to the two figures, as DSH's own four counters.
 *
 * The host's `sessionStats` for the call wins when it is there. Otherwise the same boundaries are
 * observed here: one settled step, whose wait and decode span are only used when the call really
 * observed them (both timestamps, in order) and whose decode is only counted when the provider
 * reported output tokens — exactly the guard DSH puts on its own fold.
 * @param call a call of the job contract (lib/job-contract.js)
 * @returns {{ ttftMs: number, ttftSteps: number, decodeMs: number, decodeTokens: number }}
 */
export function callTiming(call) {
  const host = dshTiming(call?.timing);
  if (host) return host;
  const start = at(call?.startedAt), first = at(call?.firstOutputAt), end = at(call?.endedAt);
  const outputTokens = isCount(call?.outputTokens) ? call.outputTokens : null;
  // A call whose first token came before it started or after it ended is not a measurement to use.
  const settled = Number.isFinite(start) && Number.isFinite(first) && Number.isFinite(end) && first >= start && end >= first;
  if (!settled) return { ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 };
  const decode = outputTokens === null ? null : end - first;
  return { ttftMs: first - start, ttftSteps: 1, decodeMs: decode === null ? 0 : decode, decodeTokens: decode === null ? 0 : outputTokens };
}

/**
 * DSH's counters over a job's calls: the same four fields its `sessionStats` view carries,
 * added up the way its fold adds them (each settled step adds its wait, and its decode span
 * only when that step also reported output tokens).
 * @param calls the calls of a job contract (`contract.calls`)
 */
export function foldCallTiming(calls) {
  let ttftMs = 0, ttftSteps = 0, decodeMs = 0, decodeTokens = 0;
  for (const call of Array.isArray(calls) ? calls : []) {
    // A rate-limit wait is a call of the console's timeline, not a model request; it has no timing to add.
    if (!call || call.kind === 'wait') continue;
    const counted = callTiming(call);
    ttftMs += counted.ttftMs;
    ttftSteps += counted.ttftSteps;
    decodeMs += counted.decodeMs;
    decodeTokens += counted.decodeTokens;
  }
  return { ttftMs, ttftSteps, decodeMs, decodeTokens };
}

/** The same fold, from a job contract, a snapshot job, or the list of calls itself. */
export function jobTiming(job) {
  return foldCallTiming(Array.isArray(job) ? job : job?.calls);
}

/** DSH's 首 token 平均: the mean wait over the steps that reported a first token, or null. */
export const ttftAverageMs = (stats) => (stats?.ttftSteps > 0 ? stats.ttftMs / stats.ttftSteps : null);

/** DSH's 输出速度: decoded output tokens per second of decode time, or null when nothing was decoded. */
export const tokensPerSecond = (stats) => (stats?.decodeMs > 0 ? stats.decodeTokens / (stats.decodeMs / 1000) : null);
