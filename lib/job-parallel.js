import { isRateLimit } from './rate-limit.js';
import { isPermanentModelError } from './model-retry.js';
import { isPermanentFailure } from './generation-failure.js';
import { recordEvent } from './job-calls.js';
import { kindOf } from './job-contract.js';

/* 要求并行 (3.0.2). The library's jobs of the question family (generation, supplement, selection fill, repair, translation) wait in ONE queue, one at a time, in the order they were
   accepted (lib/contexts/generation/jobs/library-queue.js). That stays the default. 要求并行 takes ONE queued job out of the wait: it starts at once, beside the job ahead.

   The rule that keeps the queue honest:
   - The job keeps its place in the library's chain. When the chain reaches it, it simply continues as the library's job (its `parallel` mark is cleared) and the jobs behind it go on
     waiting for it: a job submitted later waits for the parallel job too (conservative), so at most ONE job that did not ask for it runs at a time, and any number may run beside it.
   - A model call that fails under PRESSURE (a rate limit, an overloaded service, a timeout) sends every parallel job of the library back to the queue FIRST: its calls that are running
     finish, no new one starts (the hold is read where a model call is admitted), and it shows 排队中 with the reason. It goes on by itself when the chain reaches it. This runs before the
     failing job's own back-off (lib/batch.js halves its budget only after the error has left the model adapter), so the extra load is taken away before the job that failed slows down.
   - Nothing is persisted: a restart interrupts everything as it always did.

   The table of live runs is a Map by job id (the snapshot reads clones of the cards), so the shared work object (lib/runtime/work.js) is untouched; an entry goes when its run is over. A job of the unified runtime has no entry here: it is refused. */

/** The kinds that wait in the library's queue and can be started beside it. (A publication check is not one: its review does not go through the job's model adapter.) */
export const PARALLEL_KINDS = Object.freeze(['generation', 'supplement', 'draft-repair', 'translation']);
const CHAIN_KINDS = new Set([...PARALLEL_KINDS, 'draft-publish']);
const ACTIVE = new Set(['queued', 'running', 'cancelling']);
const entries = new Map();

/** Plain words for why 要求并行 is refused (the contract's `actions.parallel.reason.code`; the console says the same in its own words). */
export const PARALLEL_REASONS = Object.freeze({
  'job-ended': '这个任务已经结束，不能再要求并行。',
  'not-queued': '这个任务已经开始，只有排队中的任务可以要求并行。',
  'already-parallel': '这个任务已经在并行进行。',
  'capability-unsupported': '这类任务不支持并行。',
  'runtime-owned': '这个任务由统一任务运行时管理，暂时不能要求并行。',
  'already-cancelling': '任务正在停止。',
});
export const overlapText = (title) => `不能并行：「${title}」正在处理同一份草稿、题组或资料，两个任务同时写会互相覆盖；等它结束，或先停止它。`;

const CAUSE_WORDS = Object.freeze({ 'rate-limit': '模型请求太频繁，被限流了', overloaded: '模型服务繁忙', timeout: '模型长时间没有响应' });
const titleOf = (job) => [job.deckTitle, job.targetTitle, job.label].find((value) => typeof value === 'string' && value.trim()) || '';
const iso = () => new Date().toISOString();
const isActive = (job) => ACTIVE.has(job?.status);

/** What a job writes, as keys: the draft it holds, the deck it adds to, the document it translates. Two active jobs that share a key must not run side by side. */
export function targetsOf(job) {
  const keys = new Set();
  if (job.draftId) keys.add(`draft:${job.draftId}`);
  const deck = job.mergeTargetId || job.deckId;
  if (deck) keys.add(`deck:${deck}`);
  if (kindOf(job) === 'translation' && job.documentId) keys.add(`document:${job.documentId}`);
  return keys;
}

/** The active job of the library that writes what `job` writes, or null. */
export function overlapOf(job, jobs) {
  const mine = targetsOf(job);
  if (!mine.size) return null;
  for (const other of jobs) {
    if (other.id === job.id || other.root !== job.root || !isActive(other)) continue;
    for (const key of targetsOf(other)) if (mine.has(key)) return other;
  }
  return null;
}

/** Whether a failed model call is PRESSURE (the provider is busy, not refusing): a rate limit, an overloaded or unavailable service, a timeout. A refused key, no credit or a stop is not. */
export function pressureCause(error) {
  if (!error || error.name === 'AbortError' || isPermanentModelError(error) || isPermanentFailure(error)) return null;
  const status = Number(error.status ?? error.statusCode), code = String(error.code || ''), text = String(error.message ?? error);
  if (isRateLimit(error) || /^RATE_LIMIT$/i.test(code)) return 'rate-limit';
  if (status === 503 || status === 529 || /^(OVERLOADED|UNAVAILABLE)$/i.test(code) || /overloaded|service unavailable|temporarily unavailable/i.test(text)) return 'overloaded';
  if (error.name === 'TimeoutError' || status === 408 || status === 504 || /^(TIMEOUT|STALLED)$/i.test(code) || /timed? ?out|did not respond/i.test(text)) return 'timeout';
  return null;
}

/** The library's queue turn of a job, as a thunk for `queue.run`: `turn()` starts the job unless it was already started beside the queue. */
export function queuedRun(job, execute) {
  const entry = { job, execute, promise: null, held: false, gates: new Set() };
  entries.set(job.id, entry);
  return Object.freeze({
    turn() {
      if (!entry.promise) { entry.promise = execute(); track(entry); return entry.promise; }
      // Started beside the queue and the chain has reached it: from here it is the library's job, and what waits behind it waits for it.
      if (entry.held) release(entry, 'parallel-resumed');
      delete job.parallel; delete job.parallelAt;
      return entry.promise;
    },
  });
}

/** The entry goes when its run is over. */
function track(entry) { void entry.promise.catch(() => {}).finally(() => entries.delete(entry.job.id)); }

function release(entry, code) {
  const { job } = entry;
  entry.held = false;
  for (const open of [...entry.gates]) open();
  delete job.requeued;
  if (job.status === 'queued') job.status = 'running';
  recordEvent(job, { level: 'done', code });
}

/** Held in the queue after a model error: the call about to start waits here (a stop ends the wait with its reason). Resolves at once for every job that is not held. */
export function admitCall(job, signal) {
  const entry = entries.get(job.id);
  if (!entry?.held) return undefined;
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const open = () => { cleanup(); resolve(); };
    const stop = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => { entry.gates.delete(open); signal?.removeEventListener('abort', stop); };
    entry.gates.add(open);
    signal?.addEventListener('abort', stop, { once: true });
  });
}

/** Start the queued job now, beside the job(s) ahead of it (or let a held one go on). `settled` is what job.wait waits on. Returns the card. */
export function startParallel(card, { settled } = {}) {
  const entry = entries.get(card.id);
  if (!entry) throw new Error(PARALLEL_REASONS['runtime-owned']);
  const { job } = entry;
  job.parallel = true;
  job.parallelAt = iso();
  if (entry.held) release(entry, 'parallel-started');
  else {
    entry.promise = entry.execute();
    track(entry);
    settled?.set(job.id, entry.promise);
    void entry.promise.finally(() => { delete job.parallel; delete job.parallelAt; delete job.requeued; entry.held = false; for (const open of [...entry.gates]) open(); });
    if (job.status === 'queued') job.status = 'running';
    recordEvent(job, { level: 'done', code: 'parallel-started' });
  }
  return job;
}

/** A model call of `failed` failed under pressure: every parallel job of its library that still runs goes back to the queue, before anything else reacts to the error. */
export function stepBack(jobs, failed, error) {
  const cause = pressureCause(error);
  if (!cause) return [];
  const sent = [];
  for (const job of jobs.values()) {
    const entry = entries.get(job.id);
    if (!entry || job.root !== failed.root || job.parallel !== true || !isActive(job) || job.status === 'cancelling') continue;
    entry.held = true;
    delete job.parallel; delete job.parallelAt;
    job.requeued = { at: iso(), cause, by: failed.id, ...(titleOf(failed) ? { byTitle: titleOf(failed) } : {}) };
    job.status = 'queued';
    job.stage = `模型报错，已退回排队：等前面的任务完成后自动继续（原因：${CAUSE_WORDS[cause]}）`;
    recordEvent(job, { level: 'warn', code: 'parallel-requeued', args: { cause, by: failed.id, ...(job.id === failed.id ? { self: true } : {}) } });
    sent.push(job.id);
  }
  return sent;
}

/** The job's own check: refuse with a plain sentence, or return nothing. `jobs`: the library's jobs (cards), `runtimeOwned`: whether the unified runtime has it. */
export function refusalOf(job, jobs, { runtimeOwned = false } = {}) {
  if (runtimeOwned) return { code: 'runtime-owned' };
  if (!job || !PARALLEL_KINDS.includes(kindOf(job))) return { code: 'capability-unsupported' };
  if (!isActive(job)) return { code: 'job-ended' };
  if (!entries.has(job.id)) return { code: 'runtime-owned' };
  if (job.status === 'cancelling' || job.cancelRequestedAt) return { code: 'already-cancelling' };
  if (job.parallel === true) return { code: 'already-parallel' };
  if (job.status !== 'queued') return { code: 'not-queued' };
  const other = overlapOf(job, jobs);
  if (other) return { code: 'target-busy', by: { jobId: other.id, title: titleOf(other) } };
  return null;
}

export const refusalText = (refusal) => refusal.code === 'target-busy' ? overlapText(refusal.by.title || '另一个任务') : PARALLEL_REASONS[refusal.code] || PARALLEL_REASONS['capability-unsupported'];

/** `actions.parallel` of the contract: { available, reason?, afterError? }, for a job of a kind that can have it (others carry none). Needs the library's jobs, so the snapshot adds it. */
export function parallelAction(job, jobs, options) {
  if (!job || !PARALLEL_KINDS.includes(kindOf(job)) || job.restoredContract) return null;
  const refusal = refusalOf(job, jobs, options);
  if (refusal) return { available: false, reason: refusal };
  return { available: true, ...(job.requeued ? { afterError: { cause: job.requeued.cause } } : {}) };
}

/** What the job waits behind, for the console to name: the library's oldest job of the queue that is still active and was accepted before it. */
export function aheadOf(job, jobs) {
  const at = Date.parse(job.startedAt) || 0;
  const before = jobs.filter((other) => other.id !== job.id && other.root === job.root && isActive(other) && CHAIN_KINDS.has(kindOf(other)) && (Date.parse(other.startedAt) || 0) <= at)
    .sort((a, b) => (Date.parse(a.startedAt) || 0) - (Date.parse(b.startedAt) || 0));
  const head = before.find((other) => other.status === 'running') || before[0];
  return head ? { count: before.length, head: { jobId: head.id, title: titleOf(head), status: head.status } } : null;
}

/** A job as the snapshot shows it, with what only the library can say: `actions.parallel` (whether 要求并行 may be asked, or why not) and, for a queued job, `detail.queue` { count, head } (what it waits behind).
 *  A job of the unified runtime (contract v2) is left as it is: it has no 要求并行. */
export function offerParallel(view, job, jobs) {
  if (view?.contract?.contractVersion !== 1) return view;
  const action = parallelAction(job, jobs), ahead = job.status === 'queued' && PARALLEL_KINDS.includes(kindOf(job)) ? aheadOf(job, jobs) : null;
  if (!action && !ahead) return view;
  const { contract } = view;
  return { ...view, contract: { ...contract, ...(action ? { actions: { ...contract.actions, parallel: action } } : {}), ...(ahead ? { detail: { ...contract.detail, queue: ahead } } : {}) } };
}
