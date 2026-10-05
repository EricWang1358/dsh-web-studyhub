import { STATUSES, ACTIONS, RUNTIME_CONTRACT_VERSION, readJobContract } from './jobs/contract.js';
export { STATUSES, ACTIONS, PAUSE_MODES } from './jobs/contract.js';
import { jobCalls, jobEvents } from './job-calls.js';
import { stageCodeOf } from './contexts/jobs/contracts.js';
import { audioProgress, AUDIO_ORDER } from './audio-progress.js';
import { totalTokens } from './token-usage.js';
import { withStageCodes } from './contexts/jobs/contracts.js';
import { readPartPlan } from './part-plan.js';

/* THE PUBLIC CONTRACT OF A JOB (v1). Written down in docs/job-contract.md; this module is the only code that produces it.

   The plugin already has several kinds of background job (audio imports, PDF conversions, question runs, translations, repairs, publication checks,
   third-party tasks), each with its own record and its own vocabulary. This adapter reads such a record and says, in ONE shape, what a consumer
   (the 任务 console, a compact card, an agent) may rely on. A consumer never reads a job's internals: if the contract cannot say it, the contract
   is what grows. Nothing here is persisted and nothing is invented: a field the job cannot know is null or absent, never a guess.

   contract = {
     contractVersion: 1,
     jobId,            what survives a retry (an audio batch's id), else the job's own id
     attemptId?,       the id of the current attempt, only for kinds that have retries
     kind,             'audio-import' | 'pdf-convert' | 'translation' | 'generation' | 'supplement' | 'draft-repair' | 'draft-publish' | 'coach-daily' | 'extension'
     title,            the name the learner knows it by (a file, a deck, a document), or null
     status,           queued | running | pausing | paused | cancelling | cancelled | complete | failed | interrupted
     endReason?,       'user-cancel' | 'superseded' (why a cancelled job ended)
     stage,            { code, args?, text? }  a code the interface translates; `text` is the producer's own prose, a fallback only
     progress,         { done, total | null, unit | null, percent | null, segments: [{ stage, done, total }] }
     actions,          { cancel, pause, resume, retry, set }  each { available, reason?: { code, ... } };
                       pause also { mode: 'unsupported' | 'queued-only' | 'checkpoint', waiting?: { reason, count } },
                       set also { settings: [{ key, type: 'int'|'enum'|'bool', min?, max?, values?, value }] }
     result,           { refs: [{ kind: 'source' | 'draft' | 'deck' | 'document', id }], completeness: 'complete' | 'partial' | null }
     error,            null | { message, code? }
     usage,            { tokens | null, tokenUsage | null, calls }
     execution,        { mode: 'direct' | 'subagent' | 'mixed' | null }
     detail,           an object of plain data that only the kind's own section reads
     startedAt, finishedAt?,
     calls,            [call]  see below
     events,           [{ id, at, level, tag, code, args, text? }]
   }
   call = { callId, jobId, attemptId?, stepKey, kind, stage, slot | null, startedAt, endedAt, [queuedAt], [firstOutputAt], status, runner, childId, parentId,
            part, parts, reasoning, tokens, [file], [reason], [error] (why a failed call failed, in words) }   times are present only when they were observed; a retry or a fallback is a call of its own. */

export const CONTRACT_VERSION = 1;
export const STATUS = Object.freeze(Object.fromEntries(STATUSES.map((name) => [name.toUpperCase(), name])));
const LIVE = new Set([STATUS.QUEUED, STATUS.RUNNING, STATUS.PAUSING, STATUS.PAUSED, STATUS.CANCELLING]);
/** Still a live job: waiting, working, pausing or paused, or stopping. */
export const isLiveStatus = (status) => LIVE.has(status);

/** What each kind of job declares it can do. `pause`: checkpoint = a boundary where finished work is already kept, queued-only = only before it starts. */
const CAPABILITIES = Object.freeze({
  'audio-import': { cancel: true, pause: 'checkpoint', retry: true, set: true, unit: 'files', lineage: true },
  'pdf-convert': { cancel: true, pause: 'unsupported', retry: true, set: false, unit: 'pages' },
  translation: { cancel: true, pause: 'checkpoint', retry: false, set: true, unit: 'paragraphs' },
  // A running question run keeps nothing a pause could stop at, and the library's queue cannot skip a held job: no pause yet (queued-only is declared, not used).
  generation: { cancel: true, pause: 'unsupported', retry: false, set: true, unit: 'questions' },
  supplement: { cancel: true, pause: 'unsupported', retry: false, set: true, unit: 'questions' },
  'draft-repair': { cancel: true, pause: 'unsupported', retry: false, set: false, unit: 'questions' },
  'draft-publish': { cancel: false, pause: 'unsupported', retry: false, set: false, unit: null },
  extension: { cancel: true, pause: 'unsupported', retry: false, set: false, unit: null },
  // 为你定制 by the day (lib/coach-daily.js): a day is a record, not a run, so it cannot be stopped; "pause" is a checkpoint at the batch boundary (no new batch starts today,
  // the one in flight finishes); its limits and reasoning level are live settings. Only today's row can be adjusted.
  'coach-daily': { cancel: false, pause: 'checkpoint', retry: false, set: true, unit: 'cards', daily: true },
});

export function kindOf(job) {
  switch (job?.type) {
    case undefined: case null: case '': case 'generate': return 'generation';
    case 'audio-import': case 'pdf-convert': case 'translation': case 'supplement': case 'draft-repair': case 'draft-publish': case 'coach-daily': return job.type;
    default: return 'extension';
  }
}

const ACTIVE = new Set(['queued', 'running', 'cancelling']);
const RETRYABLE_STATUS = new Set(['failed', 'cancelled', 'interrupted']);
const isActive = (job) => ACTIVE.has(job?.status) || (!STATUSES.includes(job?.status) && !job?.finishedAt && !['complete', 'done', 'partial', 'superseded'].includes(job?.status));

/** The lifecycle status, from the legacy one and the pause flags. */
function statusOf(job, running) {
  switch (job.status) {
    case 'queued': return job.paused === true ? 'paused' : 'queued';
    case 'running': return job.paused === true ? (job.pausedAt && running === 0 ? 'paused' : 'pausing') : 'running';
    case 'cancelling': case 'cancelled': case 'complete': case 'failed': case 'interrupted': return job.status;
    case 'done': case 'partial': return 'complete';
    case 'superseded': return 'cancelled';
    default: return job.finishedAt ? 'failed' : 'running';
  }
}

const STAGE_PHASE = { audio: (job) => job.phase || 'queued', pdf: (job) => job.phase || 'queued' };

function stageOf(job, kind, status) {
  const text = typeof job.stage === 'string' ? job.stage : undefined, withText = (stage) => (text ? { ...stage, text } : stage);
  if (['complete', 'failed', 'cancelled', 'interrupted'].includes(status)) return withText({ code: 'finished', args: { status } });
  switch (kind) {
    case 'audio-import': return withText({ code: `audio.${STAGE_PHASE.audio(job)}`, args: { done: job.done ?? 0, total: job.total ?? null } });
    case 'pdf-convert': return withText({ code: `pdf.${STAGE_PHASE.pdf(job)}`, args: { done: job.done ?? 0, total: job.total > 0 ? job.total : null } });
    case 'translation': return withText({ code: job.status === 'queued' ? 'translation.queued' : 'translation.writing', args: { done: job.done ?? 0, total: job.total ?? null } });
    case 'generation': case 'supplement': case 'draft-repair': case 'draft-publish': {
      const code = stageCodeOf({ ...job, status: job.status === 'done' ? 'complete' : job.status }) || 'authoring';
      return withText({ code: `${kind === 'draft-repair' ? 'repair' : kind === 'draft-publish' ? 'publish' : 'generation'}.${code}`, args: { ...(job.parts > 1 ? { parts: job.parts } : {}) } });
    }
    default: return withText({ code: job.status === 'queued' ? 'task.queued' : 'task.running' });
  }
}

const members = (job) => (Array.isArray(job.members) ? job.members.filter((member) => member.status !== 'skipped') : []);
const percentOf = (done, total) => (total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : null);
const GENERATION_STAGES = ['plan', 'blueprint', 'author', 'review', 'repair'];

function progressOf(job, kind, calls, status) {
  const unit = CAPABILITIES[kind].unit;
  switch (kind) {
    case 'audio-import': {
      const list = members(job), stage = (name) => list.length ? list : [job];
      const segments = AUDIO_ORDER.map((name) => ({ stage: name, done: stage(name).reduce((sum, member) => sum + (member.steps?.[name]?.done || 0), 0),
        total: stage(name).reduce((sum, member) => sum + (member.steps?.[name]?.total || 0), 0) })).filter((segment) => segment.total > 0);
      segments.push({ stage: 'save', done: status === 'complete' ? 1 : 0, total: 1 });
      const done = list.length ? list.filter((member) => member.status === 'complete').length : status === 'complete' ? 1 : 0, total = list.length || 1;
      return { done, total, unit, percent: audioProgress({ ...job, status: job.status === 'done' ? 'complete' : job.status }).percent, segments };
    }
    case 'pdf-convert': case 'translation': {
      const total = job.total > 0 ? job.total : null;
      return { done: job.done ?? 0, total, unit, percent: status === 'complete' ? 100 : percentOf(job.done, total), segments: [{ stage: 'author', done: job.done ?? 0, total: total ?? 0 }] };
    }
    case 'generation': case 'supplement': {
      const total = job.requestedTotal > 0 ? job.requestedTotal : null, done = job.savedCount ?? 0;
      const counted = new Map(GENERATION_STAGES.map((stage) => [stage, { done: 0, total: 0 }]));
      for (const call of calls) { const bucket = counted.get(call.kind); if (bucket) { bucket.total += 1; if (call.status === 'ok') bucket.done += 1; } }
      return { done, total, unit, percent: status === 'complete' ? 100 : percentOf(done, total),
        segments: GENERATION_STAGES.map((stage) => ({ stage, ...counted.get(stage) })).filter((segment) => segment.total > 0) };
    }
    case 'coach-daily': {
      const { generated = 0, passed = 0 } = job.coachDaily?.metrics || {};
      return { done: passed, total: generated > 0 ? generated : null, unit, percent: percentOf(passed, generated), segments: [] };
    }
    case 'draft-repair': {
      const total = job.count > 0 ? job.count : null;
      return { done: job.savedCount ?? 0, total, unit, percent: status === 'complete' ? 100 : percentOf(job.savedCount, total), segments: [] };
    }
    default: {
      const total = job.total > 0 ? job.total : null;
      return { done: job.done ?? 0, total, unit, percent: status === 'complete' ? 100 : percentOf(job.done, total), segments: [] };
    }
  }
}

const REASONS = {
  'job-ended': '这个任务已经结束，不能再这样操作。',
  'not-ended': '任务还在进行，结束后才能重试。',
  'not-retryable': '这个任务不能重试：它已经完成，或没有可接着做的进度。',
  'capability-unsupported': '这类任务不支持这个操作。',
  'no-safe-checkpoint': '这类任务一旦开始就没有安全的暂停点，只能在排队时暂停；可以停止它，已完成的部分会保留。',
  'already-paused': '任务已经暂停，或正在暂停。',
  'not-paused': '任务没有暂停。',
  'already-cancelling': '任务正在停止。',
  'no-control-yet': '任务还没有开始，现在不能调整或暂停。',
  'unknown-action': '不认识这个操作。',
  archived: '这个任务已归档，是只读记录；取消归档后才能操作。',
};
export const reasonText = (code) => REASONS[code] || REASONS['capability-unsupported'];

/** Whether `name` may be done to this job now: { available: true } or { available: false, reason: { code } }. */
function actionState(job, caps, name) {
  // A day of 为你定制 is adjustable while it is today (whatever it is doing); a past day is a record.
  const active = caps.daily ? job.today === true : isActive(job), no = (code, extra = {}) => ({ available: false, reason: { code, ...extra } }), yes = { available: true };
  const paused = job.paused === true, hasControl = !!job.control;
  switch (name) {
    case 'cancel':
      if (caps.daily) return no('capability-unsupported');
      if (job.status === 'cancelling') return no('already-cancelling');
      if (!active) return no('job-ended');
      return caps.cancel ? yes : no('capability-unsupported');
    case 'pause': {
      if (!active) return no('job-ended');
      if (job.status === 'cancelling') return no('already-cancelling');
      if (paused) return no('already-paused');
      if (caps.pause === 'unsupported') return no('capability-unsupported');
      if (caps.pause === 'queued-only' && job.status !== 'queued') return no('no-safe-checkpoint');
      return hasControl ? yes : no('no-control-yet');
    }
    case 'resume':
      if (!active) return no('job-ended');
      if (caps.pause === 'unsupported') return no('capability-unsupported');
      return paused ? yes : no('not-paused');
    case 'retry':
      if (!caps.retry) return no('capability-unsupported');
      if (active) return no('not-ended');
      return RETRYABLE_STATUS.has(job.status) && job.retryable === true ? yes : no('not-retryable');
    case 'set':
      if (!active) return no('job-ended');
      if (!caps.set) return no('capability-unsupported');
      return hasControl ? yes : no('no-control-yet');
    default: return no('unknown-action');
  }
}

const storedCapabilities = (stored) => stored?.contractVersion === RUNTIME_CONTRACT_VERSION ? {
  cancel: stored.capabilities.cancel, pause: stored.capabilities.pauseMode,
  retry: stored.capabilities.retry, set: stored.capabilities.set,
} : {};

/** The one judge of legality: { ok: true } or { ok: false, code, message }. `job.control` answers with it before it touches a job. */
export function checkAction(job, name, overrides = {}) {
  if (!ACTIONS.includes(name)) return { ok: false, code: 'unknown-action', message: `${reasonText('unknown-action')}（${String(name)}）` };
  const stored = job?.restoredContract ? readJobContract(job.restoredContract) : null;
  const state = actionState(job, { ...CAPABILITIES[kindOf(job)], ...storedCapabilities(stored), ...overrides }, name);
  return state.available ? { ok: true } : { ok: false, code: state.reason.code, message: reasonText(state.reason.code) };
}

function settingsOf(job) {
  const control = job.control;
  if (!control?.limits) return undefined;
  return Object.entries(control.limits).filter(([key]) => key !== 'paused' && key in (control.values || {}))
    .map(([key, rule]) => ({ key, ...rule, value: control.values[key] }));
}

const FORMAT_NOTE = /实际内容是\s*([A-Za-z0-9]+)/;
function withoutFile(warning, filenames) {
  for (const name of filenames) if (warning.startsWith(`${name}：`)) return { file: name, text: warning.slice(name.length + 1) };
  return { file: null, text: warning };
}

/** One row per file (one for a recording on its own), and the warnings grouped: a warning that several files share is ONE notice with a count. */
function audioDetail(job) {
  const list = Array.isArray(job.members) && job.members.length ? job.members : [job], names = list.map((member) => member.filename).filter(Boolean);
  const files = list.map((member, index) => {
    const own = (member.warnings || []).filter((text) => typeof text === 'string');
    const format = own.map((text) => FORMAT_NOTE.exec(text)?.[1]).find(Boolean);
    const progress = audioProgress({ ...member, status: member.status === 'done' ? 'complete' : member.status });
    return { index, filename: member.filename ?? job.filename, status: member.status === 'skipped' ? 'skipped' : member.status ?? job.status, phase: member.phase ?? null,
      ...(Number.isFinite(progress.percent) ? { percent: progress.percent } : {}), steps: member.steps ?? {},
      ...(member.reused ? { reused: true } : {}), ...(member.issue ? { issue: member.issue } : {}), ...(typeof member.stage === 'string' && ['failed', 'blocked'].includes(member.status) ? { stage: member.stage } : {}),
      ...(format ? { actualFormat: format.toUpperCase() } : {}),
      ...(own.some((text) => !FORMAT_NOTE.test(text)) ? { warnings: own.filter((text) => !FORMAT_NOTE.test(text)) } : {}) };
  });
  const seen = new Map();
  const add = (text) => {
    const format = FORMAT_NOTE.exec(text)?.[1]?.toUpperCase(), key = format ? `format:${format}` : text;
    if (!seen.has(key)) seen.set(key, format ? { code: 'format-mismatch', actualFormat: format, count: 0, text } : { code: 'warning', count: 0, text });
    seen.get(key).count += 1;
  };
  if (Array.isArray(job.members) && job.members.length) {
    for (const member of job.members) for (const text of member.warnings || []) add(text);
    // A warning the batch keeps for a file ("a.mp3：...") that the file's own row does not already carry is marked on that row too.
    for (const warning of job.warnings || []) {
      const split = withoutFile(warning, names), at = split.file ? list.findIndex((member) => member.filename === split.file) : -1;
      if (at >= 0 && (list[at].warnings || []).includes(split.text)) continue;
      add(split.text);
      if (at < 0) continue;
      const format = FORMAT_NOTE.exec(split.text)?.[1];
      if (format) files[at].actualFormat = format.toUpperCase(); else (files[at].warnings ||= []).push(split.text);
    }
  } else for (const warning of job.warnings || []) add(warning);
  const requests = (usage) => (usage?.free?.requests || 0) + (usage?.paid?.requests || 0);
  const usage = job.usage ? { gemini: { free: job.usage.free?.requests || 0, paid: job.usage.paid?.requests || 0 }, siliconflow: job.usage.siliconflow?.requests || 0, groq: job.usage.groq?.requests || 0,
    paidUsd: job.usage.estimatedPaidTranscribeUsd || 0, ...(job.usageRun && requests(job.usageRun) !== requests(job.usage) ? { thisRun: { free: job.usageRun.free?.requests || 0, paid: job.usageRun.paid?.requests || 0 } } : {}) } : null;
  const outcome = job.status === 'complete' && !job.review ? { reusedWhole: !!job.reused, corrected: job.corrected ?? 0, uncertain: job.uncertain ?? 0 } : {};
  return { files, notices: [...seen.values()], usage, ...outcome, ...(job.review ? { review: { applied: job.review.applied ?? 0, rejected: job.review.rejected ?? 0, unsure: job.review.unsure ?? 0 } } : {}), textProvider: job.textProvider ?? null, minutes: job.minutes ?? null, parallel: job.parallel ?? null, recordings: names.length,
    ...(job.blocked ? { blocked: { index: job.blocked.index, filename: job.blocked.filename } } : {}) };
}

/** The parts of a question run: for each, how its stages went (from its calls) and, once the run has reported, what it kept. */
function generationParts(job, calls) {
  const reported = new Map((job.partReport?.parts || []).map((part) => [part.part, part]));
  const count = Math.max(job.parts || 0, reported.size), covers = readPartPlan(job.partPlan);
  return Array.from({ length: count }, (_, index) => {
    const part = index + 1, own = calls.filter((call) => call.part === part), stages = {};
    for (const kind of ['author', 'review', 'repair']) {
      const mine = own.filter((call) => call.kind === kind);
      if (mine.length) stages[kind] = mine.some((call) => call.status === 'running') ? 'running' : mine.every((call) => call.status === 'ok') ? 'ok' : mine.some((call) => call.status === 'failed') ? 'failed' : 'ok';
    }
    const done = reported.get(part);
    return { part, stages, status: done?.status ?? (own.some((call) => call.status === 'running') ? 'running' : own.length ? 'working' : 'waiting'),
      ...(covers.get(part) || {}),
      ...(done ? { asked: done.asked, kept: done.kept, ...(done.reasons ? { reasons: done.reasons } : {}) } : {}) };
  });
}

function detailOf(job, kind, calls) {
  switch (kind) {
    case 'audio-import': return audioDetail(job);
    case 'pdf-convert': return { filename: job.filename ?? null, route: job.route ?? null, converter: job.converter ?? null, chunk: job.chunk ?? null, adaptive: job.route === 'local' && !!job.local?.adaptive, note: job.note ?? null,
      eta: job.local?.eta ?? null, window: job.local?.window ?? null, liveness: job.liveness ?? null, warnings: job.warnings ?? [] };
    case 'translation': return { documentId: job.documentId ?? null, target: job.target ?? null, targetTitle: job.targetTitle ?? null, translated: job.translated ?? 0,
      reused: job.reused ?? 0, rejected: job.rejected ?? 0, scopeLabel: job.scopeLabel ?? null };
    case 'generation': case 'supplement': return { deckTitle: job.deckTitle ?? null, targetTitle: job.targetTitle ?? null, parts: job.parts ?? null, batchSize: job.batchSize ?? null,
      concurrency: job.concurrency ?? null, throttle: job.throttle ?? null, fills: job.fills ?? null, messages: Array.isArray(job.messages) ? job.messages.length : 0,
      partReport: job.partReport ? { summary: job.partReport.summary ?? null } : null, estimate: job.estimate ?? null, draftId: job.draftId ?? null,
      partList: generationParts(job, calls) };
    // The day of 为你定制: its batches, the day's figures, the tokens in, out and from cache, and the settings in force today (lib/coach-daily.js).
    case 'coach-daily': { const day = job.coachDaily || {}; return { date: day.date ?? null, today: !!job.today, batches: day.batches ?? [], metrics: day.metrics ?? {}, tokens: day.tokens ?? { input: 0, output: 0, cache: 0 }, paused: !!day.paused, limits: day.limits ?? null }; }
    default: return { label: job.label ?? null, warnings: job.warnings ?? [] };
  }
}

function resultOf(job, kind, status) {
  const refs = [];
  for (const id of job.sourceIds || []) if (['audio-import', 'pdf-convert', 'translation'].includes(kind) && status === 'complete') refs.push({ kind: 'source', id });
  if (job.publication?.deckId) refs.push({ kind: 'deck', id: job.publication.deckId });
  else if (job.draftId && ['generation', 'draft-repair', 'draft-publish', 'supplement'].includes(kind)) refs.push({ kind: 'draft', id: job.draftId });
  let completeness = null;
  if (status === 'complete') {
    const short = ['generation'].includes(kind) && job.requestedTotal > 0 && (job.savedCount ?? 0) < job.requestedTotal;
    const rejected = kind === 'translation' && job.rejected > 0;
    completeness = job.status === 'partial' || short || rejected ? 'partial' : 'complete';
  }
  return { refs, completeness };
}

const RUNNERS = (calls) => new Set(calls.map((call) => call.runner).filter(Boolean));
function executionOf(calls) {
  const runners = RUNNERS(calls);
  if (!runners.size) return { mode: null };
  const sub = runners.has('subagent'), direct = [...runners].some((runner) => runner !== 'subagent');
  return { mode: sub && direct ? 'mixed' : sub ? 'subagent' : 'direct' };
}

const titleOf = (job, kind) => {
  if (kind === 'coach-daily') return job.date ?? null;
  const pick = kind === 'audio-import' || kind === 'pdf-convert' ? [job.filename] : kind === 'translation' ? [job.targetTitle, job.requestedId]
    : kind === 'extension' ? [job.label, job.filename] : [job.deckTitle, job.targetTitle];
  return pick.find((value) => typeof value === 'string' && value.trim()) ?? null;
};

const identity = (job, kind) => {
  const stable = CAPABILITIES[kind].lineage ? job.batchId || job.singleId : null;
  return stable ? { jobId: stable, attemptId: job.id } : { jobId: job.id };
};

const stepKeyOf = (call) => (call.part != null ? `${call.kind}:${call.part}` : call.kind);

/** The calls of the job in the contract's call shape. */
function contractCalls(job, who) {
  return jobCalls(job).map(({ id, queuedMs, ...call }) => {
    const queuedAt = Number.isFinite(queuedMs) && Date.parse(call.startedAt) ? new Date(Date.parse(call.startedAt) - queuedMs).toISOString() : undefined;
    return { callId: id, jobId: who.jobId, ...(who.attemptId ? { attemptId: who.attemptId } : {}), stepKey: stepKeyOf(call), ...call, ...(queuedAt ? { queuedAt } : {}) };
  });
}

/** A contract nobody can act on: every action unavailable because the job is archived, no settings, and the moment it was put away (lib/job-archive.js; the console's quick path uses it too). */
export function archivedContract(contract, at) {
  const actions = Object.fromEntries(ACTIONS.map((name) => [name, { available: false, reason: { code: 'archived' } }]));
  actions.pause.mode = contract.actions?.pause?.mode ?? 'unsupported';
  return { ...contract, actions, archivedAt: at };
}

/** A job brought back from the archive when nothing else can rebuild it (a question run, a translation): its stored contract, with the actions of an ended job. */
function restoredContract(job) {
  const stored = readJobContract(job.restoredContract), { archivedAt: _archivedAt, ...rest } = stored;
  const { actions } = jobContract({ type: stored.kind === 'generation' ? undefined : stored.kind, status: stored.status, finishedAt: job.finishedAt }, storedCapabilities(stored));
  return readJobContract({ ...rest, actions });
}

/** A job in the public contract. */
export function jobContract(job, overrides = {}) {
  if (job?.restoredContract) return restoredContract(job);
  if (job?.contract) return readJobContract(job.contract);
  const kind = kindOf(job), calls = jobCalls(job), who = identity(job, kind), caps = { ...CAPABILITIES[kind], ...overrides };
  const status = statusOf(job, calls.filter((call) => call.status === 'running').length);
  const running = calls.filter((call) => call.status === 'running').length;
  const actions = Object.fromEntries(ACTIONS.map((name) => [name, actionState(job, caps, name)]));
  actions.pause.mode = caps.pause;
  if (status === 'pausing') actions.pause.waiting = { reason: 'calls-in-flight', count: running };
  if (actions.set.available) actions.set.settings = settingsOf(job) || [];
  const ended = ['complete', 'failed', 'cancelled', 'interrupted'].includes(status);
  const failed = status === 'failed' || status === 'interrupted';
  const tokenUsage = job.tokenUsage ?? null;
  return {
    contractVersion: CONTRACT_VERSION, ...who, kind, title: titleOf(job, kind), status,
    ...(status === 'cancelled' ? (job.status === 'superseded' ? { endReason: 'superseded' } : job.cancelRequestedAt ? { endReason: 'user-cancel' } : {}) : {}),
    stage: stageOf(job, kind, status),
    progress: progressOf(job, kind, calls, status),
    actions, result: resultOf(job, kind, status),
    error: failed ? { message: typeof job.stage === 'string' ? job.stage : '', ...(job.errorCode ? { code: job.errorCode } : {}) } : null,
    usage: { tokens: tokenUsage ? totalTokens(tokenUsage) : null, tokenUsage, calls: tokenUsage?.calls ?? calls.filter((call) => call.kind !== 'wait').length },
    execution: executionOf(calls), detail: detailOf(job, kind, calls),
    startedAt: job.startedAt ?? null, ...(ended && job.finishedAt ? { finishedAt: job.finishedAt } : {}),
    calls: contractCalls(job, who), events: jobEvents(job),
  };
}

/** A job as the snapshot shows it: the lean job the cards have always read, plus its contract (which holds the calls and the log). Never the library path. */
export function snapshotJob(job) {
  const { root: _root, waits: _waits, events: _events, restoredContract: _restored, restoredArchive: _archive, ...rest } = job;
  return withStageCodes({ ...rest, contract: jobContract(job) });
}
