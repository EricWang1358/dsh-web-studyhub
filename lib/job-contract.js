import { STATUSES, ACTIONS, RUNTIME_CONTRACT_VERSION, readJobContract } from './jobs/contract.js';
export { STATUSES, ACTIONS, PAUSE_MODES } from './jobs/contract.js';
import { jobCalls, jobEvents } from './job-calls.js';
import { stageCodeOf } from './contexts/jobs/contracts.js';
import { audioProgress, AUDIO_ORDER } from './audio-progress.js';
import { totalTokens } from './token-usage.js';
import { withStageCodes } from './contexts/jobs/contracts.js';
import { readPartPlan } from './part-plan.js';
import { readPlanTargets } from './plan-targets.js';
import { PUBLISH_TEXT } from './contexts/generation/jobs/messages.js';
import { runFacts } from './coverage-run.js';

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
                       retry and cancel of a runtime job may also carry keeps: 'completed' | 'nothing' (what the action keeps of the work done; absent = 'completed'), from the definition's retryKeeps / stopKeeps
     result,           { refs: [{ kind: 'source' | 'draft' | 'deck' | 'document', id }], completeness: 'complete' | 'partial' | null }
     error,            null | { message, code? }
     usage,            { tokens | null, tokenUsage | null, calls }
     execution,        { mode: 'direct' | 'subagent' | 'mixed' | null }
     detail,           an object of plain data that only the kind's own section reads (a question run or a translation carries detail.timeLimit: { seconds, scope: 'run' | 'round' | 'fixed', callSeconds | null, keeps: 'questions' | 'paragraphs' | 'nothing' });
                       a job started beside the queue by 要求并行 carries detail.parallel { at }, one sent back to the queue after a model error detail.requeued { at, cause, by }
     startedAt, finishedAt?,
     calls,            [call]  see below
     events,           [{ id, at, level, tag, code, args, text? }]
   }
   call = { callId, jobId, attemptId?, stepKey, kind, stage, slot | null, startedAt, endedAt, [queuedAt], [firstOutputAt], status, runner, childId, parentId,
            part, parts, reasoning, tokens, [outputTokens], [file], [reason], [error] (why a failed call failed, in words) }   times are present only when they were observed; a retry or a fallback is a call of its own.
            startedAt/firstOutputAt/endedAt and outputTokens are what the console's 首 token 平均（TTFT）/ 输出速度（TPS） read (lib/job-timing.js); the four are DSH's own fields. */

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
  // A question run has a checkpoint when it is a COVERAGE RUN (lib/coverage-run.js): the draft keeps every round that is done, so it can pause between two rounds, and an interrupted run continues at the next
  // round (retry). A plain run of one round keeps nothing a pause could stop at: capsOf says so per job. (queued-only is declared, not used.)
  generation: { cancel: true, pause: 'checkpoint', retry: true, set: true, unit: 'questions' },
  supplement: { cancel: true, pause: 'unsupported', retry: false, set: true, unit: 'questions' },
  'draft-repair': { cancel: true, pause: 'unsupported', retry: false, set: false, unit: 'questions' },
  'draft-publish': { cancel: false, pause: 'unsupported', retry: false, set: false, unit: null },
  extension: { cancel: true, pause: 'unsupported', retry: false, set: false, unit: null },
  // 为你定制 by the day (lib/coach-daily.js): a day is a record, not a run, so it cannot be stopped; "pause" is a checkpoint at the batch boundary (no new batch starts today,
  // the one in flight finishes); its limits and reasoning level are live settings. Only today's row can be adjusted.
  'coach-daily': { cancel: false, pause: 'checkpoint', retry: false, set: true, unit: 'cards', daily: true },
});

/** What THIS job can do: the table's declaration, narrowed for a question run that is not a coverage run (a plain run has nothing checkpointed to pause at). A plain run is still continued (接着做): it starts a continuation of the draft it kept. */
function capsOf(job, kind, overrides = {}) {
  const caps = CAPABILITIES[kind];
  if (kind !== 'generation') return { ...caps, ...overrides };
  const run = job?.coverageRun;
  return { ...caps, ...(run ? { run } : { pause: 'unsupported', plain: true }), ...overrides };
}

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
const finite = (value) => Number.isFinite(value);

/** The questions a question run is asked to reach: the plan's goal (a coverage run's whole plan, not the round it is making) or what it was asked for, whichever is more. null when nothing says. */
const questionGoal = (job) => Math.max(job.coveragePlan?.goal > 0 ? job.coveragePlan.goal : 0, job.requestedTotal > 0 ? job.requestedTotal : 0) || null;

/**
 * What a CONTINUED job (接着做, 补题, 为没覆盖的部分补题) made of its own (detail.own): { made, asked, base } = the questions it wrote, the questions it was asked for (`askedQuestions`, set when it started;
 * an older record: what its request still lacked) and the questions the draft held when it started. null for a job that did not start from a draft or a record that did not keep where it started.
 */
function ownShare(job) {
  if (!finite(job.savedAtStart)) return null;
  const base = job.savedAtStart, total = questionGoal(job);
  return { made: Math.max(0, (job.savedCount ?? 0) - base), asked: finite(job.askedQuestions) ? job.askedQuestions : Math.max(0, (total ?? 0) - base), base };
}

/**
 * The sections of a run that have a question (detail.cover): { covered, leaves, atStart, asked } = those that have one now, all the sections of the plan, how many had one when this job started, and how many
 * this job was asked to cover (the ones that had none, or the ones of its round). null when the run did not keep the counts, and for a job that started from a draft or a deck without saying where it started.
 */
function coverOf(job) {
  const run = job.coverageRun;
  if (!run || !(run.leaves > 0) || !finite(run.covered)) return null;
  if (!finite(run.coveredAtStart) && (job.continued || job.part)) return null;
  const atStart = finite(run.coveredAtStart) ? run.coveredAtStart : 0;
  return { covered: run.covered, leaves: run.leaves, atStart, asked: finite(run.askedSections) ? run.askedSections : Math.max(0, run.leaves - atStart) };
}

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
      // `done` / `total`: the questions the draft holds over the goal (the plan's whole goal, else what the run was asked for); they can exceed it (86 of 77) and are never capped to look like progress.
      // The PERCENT is what the job is for, measured from where IT began (docs/job-contract.md): a run with a plan counts the sections that have a question over the sections it was asked to cover (the plan's 覆盖),
      // a continued job the same from its own start (0% when it starts, whatever the draft already held), a plain run the questions over the request. It is 100 only when the job is complete and nothing is
      // missing, never while it runs, and a run that stopped short (a budget, no progress, sections left, a refused key) says its true fraction.
      const total = questionGoal(job), done = job.savedCount ?? 0, run = job.coverageRun, own = ownShare(job), cover = coverOf(job);
      const stop = run?.stop?.reason, met = ['complete', 'target'].includes(stop), ok = !stop || met, over = run ? met || (!stop && run.state === 'complete') : true;
      const ended = ['complete', 'failed', 'cancelled', 'interrupted'].includes(status), inherits = !!(job.continued || job.part), legacy = total > 0 ? done / total : null;
      let fraction;
      if (cover?.asked > 0) fraction = (cover.covered - cover.atStart) / cover.asked;
      else if (own?.asked > 0) fraction = own.made / own.asked;
      // A job that started from a draft and did not keep where (a record of 3.0.0) cannot say how far its own work is: unknown while it runs, the old number when it has ended.
      else if (inherits) fraction = ended ? legacy : null;
      else fraction = finite(run?.percent) ? run.percent / 100 : legacy;
      const full = status === 'complete' && ok && over && (met || total === null || done >= total);
      const percent = full ? 100 : fraction === null ? null : Math.min(99, Math.max(0, Math.round(fraction * 100)));
      const counted = new Map(GENERATION_STAGES.map((stage) => [stage, { done: 0, total: 0 }]));
      for (const call of calls) { const bucket = counted.get(call.kind); if (bucket) { bucket.total += 1; if (call.status === 'ok') bucket.done += 1; } }
      return { done, total, unit, percent,
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
  continued: '这个任务已经接着做过了，新的进度在接着做的那个任务里。',
  'capability-unsupported': '这类任务不支持这个操作。',
  'no-safe-checkpoint': '这类任务一旦开始就没有安全的暂停点，只能在排队时暂停；可以停止它，已完成的部分会保留。',
  'single-round': '这次只出一轮题，没有可以暂停的轮与轮之间；可以停止它，已通过的题会保留。',
  'already-paused': '任务已经暂停，或正在暂停。',
  'not-paused': '任务没有暂停。',
  'already-cancelling': '任务正在停止。',
  'no-control-yet': '任务还没有开始，现在不能调整或暂停。',
  'control-not-ready': '这个操作现在不可用。',
  'unknown-action': '不认识这个操作。',
  archived: '这个任务已归档，是只读记录；取消归档后才能操作。',
  // A publication that was cut short, looked at again and not safe to go on with (the generation messages).
  'publish-draft-changed': PUBLISH_TEXT.draftChanged,
  'publish-deck-changed': PUBLISH_TEXT.deckChanged,
};
export const reasonText = (code) => REASONS[code] || REASONS['capability-unsupported'];
export const hasReason = (code) => Object.hasOwn(REASONS, code);

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
      if (caps.pause === 'unsupported') return no(caps.plain ? 'single-round' : 'capability-unsupported');
      if (caps.pause === 'queued-only' && job.status !== 'queued') return no('no-safe-checkpoint');
      return hasControl ? yes : no('no-control-yet');
    }
    case 'resume':
      if (!active) return no('job-ended');
      if (caps.pause === 'unsupported') return no(caps.plain ? 'single-round' : 'capability-unsupported');
      return paused ? yes : no('not-paused');
    case 'retry':
      if (!caps.retry) return no('capability-unsupported');
      if (active) return no('not-ended');
      if (job.continuedBy) return no('continued', { by: job.continuedBy });
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
  // A saved v2 declaration does not inherit legacy single-round or coverage-run narrowing.
  plain: false, run: null,
} : {};

/** The one judge of legality: { ok: true } or { ok: false, code, message }. `job.control` answers with it before it touches a job. */
export function checkAction(job, name, overrides = {}) {
  if (!ACTIONS.includes(name)) return { ok: false, code: 'unknown-action', message: `${reasonText('unknown-action')}（${String(name)}）` };
  const stored = job?.restoredContract ? readJobContract(job.restoredContract) : null;
  const state = actionState(job, capsOf(job, kindOf(job), { ...storedCapabilities(stored), ...overrides }), name);
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
  // The parts of a coverage run are those of the round it is in (each round numbers its parts from 1): the calls of the other rounds are not theirs.
  const round = job.coverageRun?.list?.find((item) => item.status === 'running')?.round ?? [...(job.coverageRun?.list || [])].reverse().find((item) => item.status !== 'pending')?.round;
  return Array.from({ length: count }, (_, index) => {
    const part = index + 1, own = calls.filter((call) => call.part === part && (round === undefined || call.round === undefined || call.round === round)), stages = {};
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

/**
 * The time limit this job was started with, for the console to say (detail.timeLimit; docs/job-contract.md): { seconds, scope, callSeconds, keeps }, or null for a record that knows none.
 * scope 'run': the whole run (a plain question run). 'round': EACH round of a coverage run has it, the run as a whole has none (lib/contexts/generation/operations.js roundMs). 'fixed': a limit
 * nobody sets (a translation's hour, a selection run's twenty minutes); the other two are the setting 「每轮运行时限（分钟）」 of 设置 › 出题偏好 (lib/generation-settings.js jobTimeoutMinutes), taken when the
 * run started. `callSeconds` is the limit of ONE model call (lib/generation-limits.js GENERATION_TIMEOUT_MS), which no setting changes; `keeps` is what a stop by the limit leaves.
 */
function timeLimitOf(job, kind) {
  const seconds = Number(job.totalTimeoutSeconds);
  if (!(seconds > 0)) return null;
  const callSeconds = Number(job.generationTimeoutSeconds) > 0 ? Number(job.generationTimeoutSeconds) : null;
  if (kind === 'translation') return { seconds, scope: 'fixed', callSeconds, keeps: 'paragraphs' };
  if (job.origin === 'selection') return { seconds, scope: 'fixed', callSeconds, keeps: 'nothing' };
  return { seconds, scope: job.coverageRun ? 'round' : 'run', callSeconds, keeps: 'questions' };
}

/** When the job really began running (`job.runStartedAt`: the wait in the queue is not in it): the 已用 clock of the 任务 console. Absent for a record from before it was kept; a kind that never waits has none. */
const withRunStart = (detail, job) => (job.runStartedAt ? { ...detail, runStartedAt: job.runStartedAt } : detail);

/** 要求并行 (lib/job-parallel.js): `detail.parallel` { at } while the job runs beside the queue by the learner's request; `detail.requeued` { at, cause, by } while it is held in the queue after a model error
 *  (cause: 'rate-limit' | 'overloaded' | 'timeout'; by: the job whose call failed); `detail.heldMs`: the time it spent held, which neither its time limit nor 已用 counts. (An audio import's own `parallel` is its transcription limit, a different thing.) */
const withParallel = (detail, job) => ({ ...detail, ...(job.parallel === true ? { parallel: { at: job.parallelAt ?? null } } : {}), ...(job.requeued ? { requeued: { at: job.requeued.at, cause: job.requeued.cause, by: job.requeued.by } } : {}),
  ...(job.heldMs > 0 ? { heldMs: job.heldMs } : {}) });

function detailOf(job, kind, calls) {
  const limit = ['translation', 'generation', 'supplement'].includes(kind) ? timeLimitOf(job, kind) : null;
  const withLimit = (detail) => (limit ? { ...detail, timeLimit: limit } : detail);
  switch (kind) {
    case 'audio-import': return audioDetail(job);
    case 'pdf-convert': return { filename: job.filename ?? null, route: job.route ?? null, converter: job.converter ?? null, chunk: job.chunk ?? null, adaptive: job.route === 'local' && !!job.local?.adaptive, note: job.note ?? null,
      eta: job.local?.eta ?? null, window: job.local?.window ?? null, liveness: job.liveness ?? null, warnings: job.warnings ?? [],
      // Why it failed, in full (the cause, the converter's last lines, plain; fix: 'settings' when only a change of the installation helps), and the bar the converter draws now.
      failure: job.failure ?? null, toolProgress: job.toolProgress ?? null };
    case 'translation': return withLimit({ documentId: job.documentId ?? null, target: job.target ?? null, targetTitle: job.targetTitle ?? null, translated: job.translated ?? 0,
      reused: job.reused ?? 0, rejected: job.rejected ?? 0, scopeLabel: job.scopeLabel ?? null });
    case 'generation': case 'supplement': return withLimit({ deckTitle: job.deckTitle ?? null, targetTitle: job.targetTitle ?? null,
      // The questions the draft held when this job started (a continued run starts from the draft it continues): what a pace is measured from. null: a continued run of a host that did not keep it.
      keptAtStart: Number.isFinite(job.savedAtStart) ? job.savedAtStart : job.continued ? null : 0,
      // What this job made of its own, and the sections that have a question over the sections it was asked for: the headline percent and the tile of the questions are made of them (docs/job-contract.md). null: not kept / not a continued job.
      own: ownShare(job), cover: coverOf(job),
      // A new draft that will be the next part of a deck (lib/deck-parts.js): the console's title says 「Deck · 第二部分」.
      ...(job.part ? { part: { deckId: job.part.deckId, deckTitle: job.part.deckTitle, n: job.part.n, documentKey: job.part.documentKey ?? null } } : {}),
      parts: job.parts ?? null, batchSize: job.batchSize ?? null,
      concurrency: job.concurrency ?? null, throttle: job.throttle ?? null, fills: job.fills ?? null, messages: Array.isArray(job.messages) ? job.messages.length : 0,
      partReport: job.partReport ? { summary: job.partReport.summary ?? null } : null, estimate: job.estimate ?? null, draftId: job.draftId ?? null,
      partList: generationParts(job, calls),
      // The knowledge points the planning stage listed and what became of each (lib/plan-targets.js): null for a job that predates the record.
      targets: readPlanTargets(job.planTargets),
      // The rounds of a coverage run and where it is (lib/coverage-run.js runFacts: the one function the console, the draft page and the home row read): null for a plain run. What is left is each
      // round's `due` (the sections without a question, the points the planner returned); 已用 (`tokensUsed`) is this job's own count, the same number as `usage.tokens`.
      run: job.coverageRun ? { ...runFacts({ rounds: job.coverageRun.list, run: job.coverageRun, percent: job.coverageRun.percent ?? null, job }), list: job.coverageRun.list, ...(job.coverageRun.draftId ? { draftId: job.coverageRun.draftId } : {}) } : null });
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
    // A coverage run that stopped before its plan was met (the budget, no progress, sections left after the retry rounds) is partial, however many questions it wrote.
    const stoppedEarly = kind === 'generation' && !!job.coverageRun?.stop?.reason && !['complete', 'target'].includes(job.coverageRun.stop.reason);
    completeness = job.status === 'partial' || short || rejected || stoppedEarly ? 'partial' : 'complete';
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
  const kind = kindOf(job), calls = jobCalls(job), who = identity(job, kind), caps = capsOf(job, kind, overrides);
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
    ...(job.continuedBy ? { continuedBy: job.continuedBy } : {}),
    stage: stageOf(job, kind, status),
    progress: progressOf(job, kind, calls, status),
    actions, result: resultOf(job, kind, status),
    error: failed ? { message: typeof job.stage === 'string' ? job.stage : '', ...(job.errorCode ? { code: job.errorCode } : {}) } : null,
    usage: { tokens: tokenUsage ? totalTokens(tokenUsage) : null, tokenUsage, calls: tokenUsage?.calls ?? calls.filter((call) => call.kind !== 'wait').length },
    execution: executionOf(calls), detail: withParallel(withRunStart(detailOf(job, kind, calls), job), job),
    startedAt: job.startedAt ?? null, ...(ended && job.finishedAt ? { finishedAt: job.finishedAt } : {}),
    calls: contractCalls(job, who), events: jobEvents(job),
  };
}

/** A job as the snapshot shows it: the lean job the cards have always read, plus its contract (which holds the calls and the log). Never the library path. */
export function snapshotJob(job) {
  const { root: _root, waits: _waits, events: _events, restoredContract: _restored, restoredArchive: _archive, ...rest } = job;
  return withStageCodes({ ...rest, contract: jobContract(job) });
}
