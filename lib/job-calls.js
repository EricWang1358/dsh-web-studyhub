import { stepStageCode } from './contexts/jobs/contracts.js';
import { totalTokens } from './token-usage.js';
import { modelFailureMessage } from './model-retry.js';

/* What a job records about its model calls, and how the snapshot shows it. Pure data and small recorders, no I/O.

   Every producer already keeps the calls of its job in its own list: an audio import its `tasks` (per file), a question run its `steps`.
   This module reads those lists, plus the rate-limit waits and the events recorded here, as ONE shape (`unifyCall`) with ONE bound
   (the newest MAX_CALLS), so the 任务 console draws a timeline of any job without knowing which kind it is. Nothing is copied into
   the library store: the lists live on the in-memory job (a batch manifest keeps what it always kept), and every list is bounded.

   call: { id, kind, stage, slot, startedAt, endedAt, status, runner, childId, parentId, part, parts, reasoning, tokens,
           [queuedMs], [file], [reason], [reused], [error], [reasoningReason], [reasoningName], [reasoningEffort], [inputChars], [outputPreview] }
     kind     transcribe | proofread | translate | title | plan | blueprint | author | review | repair | publish | prep (a batch of 为你定制) | wait | other
     status   running | ok | failed | cancelled | skipped | waiting (a rate-limit back-off in progress)
     runner   subagent (a DSH sub-agent: childId opens it) | direct (the model path of this plugin) | gemini | ... | null while unknown
     slot     the lane: the lowest free slot of the pool or budget the call ran in, 1-based; null for calls that have no pool (transcription) */

// No node:crypto here: the console's browser bundle reads this module too (through the contract).
const newId = () => globalThis.crypto.randomUUID();

export const MAX_CALLS = 300;
export const MAX_EVENTS = 200;
export const MAX_WAITS = 100;

const STAGE_KIND = { planning: 'plan', blueprinting: 'blueprint', authoring: 'author', reviewing: 'review', repairing: 'repair', publishing: 'publish' };
const KINDS = new Set(['transcribe', 'proofread', 'translate', 'title', 'plan', 'blueprint', 'author', 'review', 'repair', 'publish', 'prep', 'wait']);
const STATUS = { starting: 'running', running: 'running', finishing: 'running', complete: 'ok', failed: 'failed', cancelled: 'cancelled', skipped: 'skipped' };
const LEVELS = new Set(['info', 'step', 'warn', 'error', 'done']);

const kindOf = (raw, fallback) => {
  if (KINDS.has(raw.kind)) return raw.kind;
  if (fallback) return fallback;
  return STAGE_KIND[stepStageCode(raw)] || 'other';
};

/** One record of a job's own list (an audio task, a generation step) or a wait, in the one call shape. */
export function unifyCall(raw, { kind: fallback, file } = {}) {
  const wait = raw.kind === 'wait';
  const call = {
    id: raw.id, kind: kindOf(raw, fallback), stage: raw.stage ?? null, slot: Number.isInteger(raw.slot) ? raw.slot : null,
    startedAt: raw.startedAt ?? null, endedAt: raw.finishedAt ?? raw.endedAt ?? null,
    status: wait ? (raw.endedAt ? 'ok' : 'waiting') : STATUS[raw.status] || 'running',
    runner: raw.runtime ?? raw.runner ?? null, childId: raw.childId ?? null, parentId: raw.parentId ?? null,
    part: raw.part ?? null, parts: raw.parts ?? null, reasoning: raw.reasoning ?? raw.reasoningEffort ?? null,
    tokens: raw.tokenUsage ? totalTokens(raw.tokenUsage) : null,
  };
  if (Number.isFinite(raw.queuedMs)) call.queuedMs = raw.queuedMs;
  if (file) call.file = file;
  if (raw.reason) call.reason = raw.reason;
  if (raw.reused === true) call.reused = true;
  if (raw.error) call.error = String(raw.error).slice(0, 200);
  if (raw.firstOutputAt) call.firstOutputAt = raw.firstOutputAt;
  // What can be said about a call without opening its session: what the reasoning setting did (when the model had no such level), the size of its prompt, the start of its answer.
  if (raw.reasoningReason) call.reasoningReason = raw.reasoningReason;
  if (raw.reasoningName) call.reasoningName = String(raw.reasoningName).slice(0, 40);
  if (raw.reasoningEffort && raw.reasoningEffort !== call.reasoning) call.reasoningEffort = raw.reasoningEffort;
  if (raw.inputChars > 0) call.inputChars = raw.inputChars;
  if (raw.outputPreview) call.outputPreview = String(raw.outputPreview).slice(0, 240);
  return call;
}

/** A call of a job ended in failure: mark it and keep the reason in words (the log says why, and whether it was tried again). A cancel is not a failure. */
export function failStep(step, error) {
  step.status = error?.name === 'AbortError' ? 'cancelled' : 'failed';
  if (step.status === 'failed') step.error = modelFailureMessage(error).slice(0, 200);
}

const stepsOf = (owner) => (Array.isArray(owner?.steps) ? owner.steps : []);
const tasksOf = (owner) => (Array.isArray(owner?.tasks) ? owner.tasks : []);

/** The newest MAX_CALLS calls of a job, oldest first: its own tasks and steps, those of each file of a batch, and its waits. */
export function jobCalls(job) {
  const base = job?.type === 'translation' ? { kind: 'translate' } : {};
  const unified = [];
  // A single recording's own calls belong to that file (a batch's members carry theirs), so the console's timeline can give the recording one lane.
  const own = job?.type === 'audio-import' && job.filename && !(Array.isArray(job.members) && job.members.length) ? { ...base, file: String(job.filename) } : base;
  for (const raw of [...tasksOf(job), ...stepsOf(job)]) unified.push(unifyCall(raw, own));
  for (const member of Array.isArray(job?.members) ? job.members : [])
    for (const raw of [...tasksOf(member), ...stepsOf(member)]) unified.push(unifyCall(raw, { ...base, file: member.filename }));
  for (const wait of Array.isArray(job?.waits) ? job.waits : []) unified.push(unifyCall({ ...wait, kind: 'wait' }));
  const time = (call) => Date.parse(call.startedAt) || 0;
  return unified.map((call, index) => ({ call, index })).sort((a, b) => time(a.call) - time(b.call) || a.index - b.index)
    .map(({ call }) => call).slice(-MAX_CALLS);
}

const bounded = (list, limit) => { if (list.length > limit) list.splice(0, list.length - limit); return list; };

/**
 * A back-off that a rate limit forced, as { phase: 'start' | 'end', id, slot, reason, ms, at }: the start opens a wait, the end closes the
 * one with the same id. The list is bounded (MAX_WAITS).
 */
export function recordWait(job, { id, phase, slot, reason = 'rate-limit', ms, at = new Date().toISOString() }) {
  job.waits ||= [];
  if (phase === 'start') {
    job.waits.push({ id, kind: 'wait', reason, slot: slot ?? null, ms: ms ?? null, startedAt: at, endedAt: null });
    bounded(job.waits, MAX_WAITS);
  } else { const open = job.waits.find((wait) => wait.id === id); if (open) open.endedAt = at; }
  return job;
}

/**
 * A line of the job's log: { id, at, level, tag, code, args, [text] }. `code` and `args` are what the UI translates; `text` is prose the
 * producer already wrote (a warning, a stage). Level: info | step | warn | error | done. Bounded (MAX_EVENTS).
 */
export function recordEvent(job, { level = 'info', tag = null, code, args = null, text }) {
  job.events ||= [];
  const event = { id: newId(), at: new Date().toISOString(), level: LEVELS.has(level) ? level : 'info', tag, code, args, ...(text !== undefined ? { text } : {}) };
  job.events.push(event);
  bounded(job.events, MAX_EVENTS);
  return event;
}

const lastSeen = new WeakMap();
const STATUS_LEVEL = { complete: 'done', partial: 'warn', failed: 'error', interrupted: 'error', cancelled: 'warn' };

/**
 * Look at a job and note, once, that its status or stage changed. A producer that knows more (a rate limit, a milestone) records its own
 * events; this catches the rest, so every kind of job has a log without each one being rewritten. The first look at a job that already
 * has a log (one restored after a restart) only sets the baseline.
 */
export function observeJob(job) {
  const before = lastSeen.get(job), now = { status: job.status, stage: job.stage ?? '' };
  lastSeen.set(job, now);
  if (!before && job.events?.length) return;
  if (before && before.status === now.status && before.stage === now.stage) return;
  if (!before || before.status !== now.status) recordEvent(job, { level: STATUS_LEVEL[now.status] || 'info', code: 'status', args: { status: now.status }, text: now.stage });
  else recordEvent(job, { level: 'step', code: 'stage', text: now.stage });
}

/** The log of a job, oldest first: its own events and those of each file of a batch (each knowing its file). Bounded like every list here. */
export function jobEvents(job) {
  const own = Array.isArray(job?.events) ? job.events : [];
  const files = (Array.isArray(job?.members) ? job.members : []).flatMap((member) => (Array.isArray(member.events) ? member.events : []).map((event) => ({ ...event, file: member.filename })));
  if (!files.length) return own;
  const time = (event) => Date.parse(event.at) || 0;
  return [...own, ...files].map((event, index) => ({ event, index })).sort((a, b) => time(a.event) - time(b.event) || a.index - b.index).map(({ event }) => event).slice(-MAX_EVENTS);
}
