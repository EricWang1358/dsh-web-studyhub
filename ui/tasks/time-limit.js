import { ui, uiFormat } from '../i18n.js';
import { hitCallTimeout, hitTimeLimit } from '../generation-status.js';
import { isLiveStatus } from './task-model.js';
import { elapsedMs } from './task-facts.js';

/* What the 任务 page says about a task's time limit and about the steps that took the time. Plain functions over a job's contract (docs/job-contract.md detail.timeLimit
   and calls), no React: the strip (TimeLimit.jsx), the timeline's marks (Timeline.jsx) and the tests read these and nothing else. */

/** The one place the setting of the limit is edited: its field in 设置 › 出题偏好 (ui/GenerationSettings.jsx jobTimeoutMinutes). The console links there and builds no editor of its own. */
export const LIMIT_ANCHOR = 'settings-generation-time';

/**
 * The rule for a step that ran long: longer than `times` x the median of the steps of the same kind that finished (not counting itself), and longer than `floorMs`.
 * A step of a kind nothing else has finished is held to the floor alone. A running step counts up to now.
 */
export const LONG_CALL = Object.freeze({ times: 3, floorMs: 2 * 60 * 1000 });

const stamp = (value) => { const time = Date.parse(value); return Number.isFinite(time) ? time : null; };

/** How long a call took (or has taken, while it runs, up to `now`); null when it has no start. */
export function callMs(call, now) {
  const from = stamp(call?.startedAt);
  if (from === null) return null;
  return Math.max(0, (stamp(call.endedAt) ?? now) - from);
}

/** The rule behind a step marked as long, in the tooltip of the mark (the same sentence on the strip and on the bar), and what 'slowest' means. */
export const longRuleText = () => uiFormat('明显偏久：用时超过同类已完成步骤中位数的 {0} 倍，并且超过 {1} 分钟（同类还没有完成的步骤时，只看 {1} 分钟）。', [LONG_CALL.times, LONG_CALL.floorMs / 60000]);
export const slowestText = () => ui('这个任务里用时最长的一步，已在时限内用掉了最多的时间。');

/** A step of the work: a rate-limit wait is not one, and neither is a transcript taken from the saved one. */
const isStep = (call) => call.kind !== 'wait' && !call.reused;
const finished = (call) => !!call.endedAt && (call.status === 'ok' || call.status === 'failed');
const median = (values) => { const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1; return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };

/** How long `call` may run before it is long: the larger of the floor and `times` x the median of the other finished steps of its kind. */
export function longCallMs(calls, call) {
  const others = (calls || []).filter((other) => other !== call && other.callId !== call.callId && other.kind === call.kind && isStep(other) && finished(other))
    .map((other) => callMs(other, 0)).filter((ms) => ms !== null);
  return Math.max(LONG_CALL.floorMs, others.length ? LONG_CALL.times * median(others) : 0);
}

/**
 * The steps to point at, longest first: [{ callId, mark, ms, running }]. `mark` 'long' is a step past the rule above; 'slowest' is the longest step of a task that ended by its time limit
 * (named even when nothing is out of line with its kind: three planning calls of nine minutes are all long and none is longer than its siblings). Nothing else is marked.
 */
export function slowSteps(calls, { now = Date.now(), hitLimit = false } = {}) {
  const timed = (calls || []).filter(isStep).map((call) => ({ call, ms: callMs(call, now) })).filter((item) => item.ms !== null).sort((a, b) => b.ms - a.ms);
  const entry = ({ call, ms }, mark) => ({ callId: call.callId, mark, ms, running: !call.endedAt });
  const long = timed.filter(({ call, ms }) => ms > longCallMs(calls, call)).map((item) => entry(item, 'long'));
  if (long.length) return hitLimit ? [{ ...long[0], mark: 'slowest' }, ...long.slice(1)] : long;
  return hitLimit && timed.length && timed[0].ms > 0 ? [entry(timed[0], 'slowest')] : [];
}

/** Did this call fail at the limit of one call (`callSeconds`, detail.timeLimit)? It ran that long (a few seconds short allowed: the clock starts a moment after the call is logged) and its own error is the model not answering. */
export function callLimitHit(call, callSeconds, now) {
  if (!(callSeconds > 0) || call?.status !== 'failed') return false;
  const ms = callMs(call, now);
  return ms !== null && ms >= callSeconds * 1000 - 5000 && hitCallTimeout(call.error);
}

/** The marks of the timeline's bars: Map(callId -> 'long' | 'slowest'). */
export const marksOf = (steps) => new Map((steps || []).map((step) => [step.callId, step.mark]));

/**
 * What the strip says about the limit: { scope, seconds, callSeconds, keeps, adjustable, live, usedMs, hit, rounds }, or null for a task whose record knows no limit (an older record, an audio import).
 * `usedMs` counts against the limit: the task's 已用 for a whole-run limit; for a limit per round, the time since the round in flight made its first call (null when no round is in flight).
 * `hit`: the task has ended and its own words say the limit ended it (generation-status.js hitTimeLimit, the classifier of the list row). `rounds`: the rounds of a coverage run that reached it.
 */
export function limitFacts(contract, { now = Date.now() } = {}) {
  const limit = contract?.detail?.timeLimit;
  if (!limit || !(limit.seconds > 0)) return null;
  const live = isLiveStatus(contract.status);
  let usedMs = null;
  if (contract.status === 'queued') usedMs = null;
  else if (limit.scope === 'round') {
    const round = contract.detail.run?.running;
    const starts = live && round != null ? (contract.calls || []).filter((call) => call.round === round).map((call) => stamp(call.startedAt)).filter((time) => time !== null) : [];
    usedMs = starts.length ? Math.max(0, now - Math.min(...starts)) : null;
  } else usedMs = elapsedMs(contract, live, now);
  const rounds = (contract.detail.run?.list || []).filter((item) => item.reason === 'timeout').map((item) => item.round);
  return { scope: limit.scope, seconds: limit.seconds, callSeconds: limit.callSeconds ?? null, keeps: limit.keeps ?? 'questions', adjustable: limit.scope !== 'fixed', live, usedMs,
    hit: !live && hitTimeLimit(contract.error?.message || contract.stage?.text), rounds };
}
