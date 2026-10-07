import { createHash } from 'node:crypto';
import { id } from '../../util.js';
import { estimateRun, createTextMeasure, compactEstimate } from '../../token-estimate.js';
import { GENERATION_TIMEOUT_MS, GENERATION_JOB_TIMEOUT_MS } from '../../generation-limits.js';
import { GENERATION_STAGE_TEXT } from '../jobs/contracts.js';
import { notify } from '../../inbox.js';
import { passageKey } from '../../selection-evidence.js';
import { libraryQueue } from './jobs/library-queue.js';
import { startGeneration } from './jobs/submit-generation.js';

/* Selected-passage supplementation as an ordinary background job (the reader's learning panel used to wait on one
   host call for the whole plan, write and independent review, with nothing to see and nothing to stop).

   This layer only schedules, tracks and reports the operations of selection.js, in the machinery every other
   generation job uses: the job table (`work.jobs`), the per-library queue, the cancel controller, the usage scope,
   the token estimate, the notice to the session and an inbox letter. What is saved, and when, is unchanged:
   questions that passed the independent review are appended once, atomically, to the chosen deck, keyed by the
   operationId. The job is a `supplement` job (`origin: 'selection'`), so the job list and its cards already know it. */

const ACTIVE_RECORD = ['preparing', 'writing', 'reviewing'];
const clone = value => structuredClone(value);
const text = (zh, en, language) => (language === 'en' ? en : zh);
const iso = () => new Date().toISOString();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const errorText = error => error?.message || String(error);

/** The dropped candidates of a run, one record each, with the reasons the review gave (lib/generation.js keeps them on the editorial). */
const rejectedOf = record => (Array.isArray(record?.editorial?.omitted) ? record.editorial.omitted : [])
  .map(item => ({ kind: item.kind, topic: item.topic, objective: item.objective, prompt: item.prompt, reasons: item.reasons || [] }));

/** What a persisted operation says about the job that ran it. */
export function applyRecord(job, record, { recovery = false } = {}) {
  job.operationState = record.status;
  if (record.status === 'complete' && record.receipt) {
    const receipt = record.receipt;
    job.status = 'complete'; job.outcome = 'saved';
    job.savedCount = receipt.added; job.passed = receipt.added;
    job.rejected = rejectedOf(record);
    job.publication = { deckId: receipt.deckId, added: receipt.added, total: receipt.total, accepted: receipt.added, rejected: job.rejected.length,
      cardIds: receipt.cardIds || [], firstCardId: receipt.cardIds?.[0] || null, version: receipt.version, remainingDraftId: null };
    job.stage = `Added ${receipt.added} questions to ${job.targetTitle}; total ${receipt.total}`;
    return job;
  }
  job.savedCount = 0;
  job.rejected = rejectedOf(record);
  if (record.accepted?.length) job.passed = record.accepted.length;
  if (record.status === 'conflict') { job.status = 'failed'; job.outcome = 'conflict'; }
  else if (record.status === 'cancelled') { job.status = 'cancelled'; job.outcome = 'cancelled'; }
  // With the restart switch a record that passed its review and was not saved yet is unfinished work too, not a review failure.
  else if (ACTIVE_RECORD.includes(record.status) || (recovery && record.status === 'reviewed')) { job.status = 'failed'; job.outcome = 'interrupted'; }
  else { job.status = 'failed'; job.outcome = 'review-failed'; }
  job.stage = record.error || (job.outcome === 'interrupted' ? 'The run was interrupted before it finished' : 'No question passed the independent review');
  return job;
}

export function createSelectionJobs(core, ports) {
  const { jobs, queues, settled, generationControllers } = ports.work;
  const { activeJob, pruneJobs, publicJob } = ports.jobServices;
  const { root } = core;
  const queue = libraryQueue({ queues, settled });
  // Behind `runtime.pilot.generation` a supplement is a job of the unified runtime; behind `generationRestart` an operation the last process left unfinished goes on from its record.
  const runtime = ports.runtime ?? {}, managed = runtime.pilot?.generation === true, recovery = managed && runtime.pilot?.generationRestart === true;
  const mine = job => job.root === root && job.origin === 'selection';
  const liveJobs = () => [...jobs.values()].filter(mine);
  const liveFor = (operationId, except) => liveJobs().filter(job => job.operationId === operationId && !except(job)).at(-1);
  const semanticOf = ({ deckId, count, kind, focus, selection }) => digest({ deckId, count, kind, focus: focus || '', quote: selection.quote, sourceId: selection.sourceId || '' });
  const languageName = (args, request) => args.language || (request.language === 'en' ? 'English' : '中文');

  /** The job of a persisted operation after a restart: read-only, with the same fields. */
  async function fromRecord(record, request) {
    let title = record.deckTitle || '';
    if (!title) { try { const found = await core.bank.get(record.deckId, request); title = (found.deck || found).title || ''; } catch { /* the deck may be gone */ } }
    const job = { id: `selection:${record.operationId}`, type: 'supplement', origin: 'selection', operationId: record.operationId,
      mergeTargetId: record.deckId, deckId: record.deckId, targetTitle: title, deckTitle: title, selection: clone(record.selection),
      sourceIds: [record.selection.sourceId], kind: record.request.kind, count: record.request.count, requestedTotal: record.request.count, parts: 1,
      steps: [], messages: [], startedAt: record.createdAt, finishedAt: record.updatedAt, language: request.language, root };
    applyRecord(job, record, { recovery });
    return job;
  }

  async function handle(job, ahead = 0) {
    return { jobId: job.id, operationId: job.operationId, status: job.status, queuedBehind: ahead, deckId: job.deckId, job: publicJob(job) };
  }

  /** The answer an operation that already has one gets again (the same operationId never starts twice): its running job, or what the library kept of it. */
  async function replay(args, request) {
    const { count, kind } = core.normalize(args), operationId = args.operationId;
    const semantic = semanticOf({ deckId: args.deckId, count, kind, focus: args.focus, selection: args.selection });
    const running = liveFor(operationId, () => false);
    if (running && running.semantic !== semantic) throw new Error('Operation ID was already used for a different request');
    if (running && activeJob(running)) return handle(running);
    const prior = await core.get(operationId);
    if (prior && semanticOf({ deckId: prior.deckId, count: prior.request.count, kind: prior.request.kind, focus: prior.request.focus, selection: prior.selection }) !== semantic)
      throw new Error('Operation ID was already used for a different request');
    if (prior?.status === 'complete') return handle(running?.status === 'complete' ? running : await fromRecord(prior, request));
    return undefined;
  }

  /** The run of an operation, ready to queue: the checks that refuse it early, the card it shows and the executor. Nothing is queued here.
   * `self`: the logical job that is preparing again (a retry), which is not its own rival. */
  async function prepare(args, request = {}, { self } = {}) {
    const own = job => self !== undefined && job.contract?.jobId === self;
    const { count, kind } = core.normalize(args);
    const operationId = args.operationId;
    const semantic = semanticOf({ deckId: args.deckId, count, kind, focus: args.focus, selection: args.selection });
    // Refuse early what would fail minutes later: an unavailable model, a stale passage, a missing deck.
    const scoped = { ...request, workOwner: request.workOwner ?? core.workOwner };
    if (typeof (core.complete || request.complete) !== 'function')
      throw Object.assign(new Error('A model is required for selected-text generation'), { code: 'CAPABILITY_UNAVAILABLE' });
    const selection = await core.resolve(args.selection, scoped);
    const destination = await core.bank.get(args.deckId, scoped);
    const deck = destination.deck || destination;
    if (!Array.isArray(deck.cards) || deck.archived || deck.systemKind) throw new Error('Append target must be an active ordinary deck');
    const duplicate = liveJobs().find(job => activeJob(job) && job.operationId !== operationId && !own(job) && job.deckId === args.deckId && passageKey(job.selection) === passageKey(selection));
    if (duplicate) throw Object.assign(new Error(text('这段原文补到这个题组的任务已在进行，请等它完成，或先停止它再重新开始。',
      'A supplement for this passage and deck is already running; wait for it or stop it first.', request.language)), { code: 'DUPLICATE_SUPPLEMENT', jobId: duplicate.id });

    pruneJobs();
    const ahead = [...jobs.values()].filter(job => job.root === root && activeJob(job) && !own(job)).length;
    const job = { id: id(), root, type: 'supplement', origin: 'selection', operationId, semantic, mergeTargetId: args.deckId, deckId: args.deckId,
      targetTitle: deck.title || '', deckTitle: deck.title || '', selection: clone(selection), sourceIds: [selection.sourceId], kind, count, requestedTotal: count,
      savedCount: 0, passed: 0, parts: 1, steps: [], messages: [], concurrency: 1, status: ahead ? 'queued' : 'running',
      stage: ahead ? 'Waiting for the previous generation' : GENERATION_STAGE_TEXT.planning,
      generationTimeoutSeconds: GENERATION_TIMEOUT_MS / 1000, totalTimeoutSeconds: GENERATION_JOB_TIMEOUT_MS / 1000, startedAt: iso(), language: request.language };
    if (!ahead) job.runStartedAt = job.startedAt;
    // What this run is expected to use, kept to set beside what it did use (WP27); an estimate is never a reason to refuse.
    try {
      const sources = await core.evidence(selection, scoped);
      const own = deck.cards.map(card => card.objective).filter(Boolean);
      job.estimate = compactEstimate(estimateRun('generate', { sources, count, kind, language: languageName(args, request),
        focus: `${args.focus || ''}\nSelected passage: ${selection.quote}`, existing: own, pinnedExisting: own, singlePart: true },
      { measure: createTextMeasure({ tokenMeter: request.tokenMeter }) }));
    } catch { /* an estimate is a convenience */ }

    const progress = (event, controller) => {
      if (controller.signal.aborted) return;
      if (event.stage) job.stage = event.stage;
      if (Number.isInteger(event.written)) job.written = event.written;
      if (Number.isInteger(event.passed)) job.passed = event.passed;
    };
    const freshVersion = async () => { const found = await core.bank.get(args.deckId, scoped); return found.version ?? (found.deck || found).contentVersion ?? 0; };

    /** Continue what an earlier attempt of this operation left, or start over when it saved nothing worth keeping. */
    async function proceed(run) {
      const prior = await core.get(operationId);
      const waited = ahead > 0;
      if (prior?.status === 'conflict' && prior.reviewPassed && prior.accepted?.length)
        return core.commit({ operationId, expectedVersion: await freshVersion() }, run);
      if (prior && ['review-failed', 'cancelled'].includes(prior.status) && prior.candidates?.length && !prior.reviewPassed)
        return core.review({ operationId, expectedVersion: await freshVersion() }, run);
      if (recovery && prior?.status === 'reviewed' && prior.reviewPassed) return core.commit({ operationId, expectedVersion: await freshVersion() }, run);
      if (recovery && prior && ACTIVE_RECORD.includes(prior.status) && prior.candidates?.length && !prior.reviewPassed)
        return core.review({ operationId, expectedVersion: await freshVersion() }, run);
      if (prior && ACTIVE_RECORD.includes(prior.status)) return core.supplement({ ...args, count, kind, expectedVersion: prior.expectedVersion }, run);
      if (prior) await core.clear(operationId);
      // Waiting behind other work means the deck may have moved on legitimately; the guard protects the run itself.
      return core.supplement({ ...args, count, kind, ...(waited ? { expectedVersion: await freshVersion() } : {}) }, run);
    }

    const finish = async job => {
      job.finishedAt = iso();
      if (job.status === 'complete' && job.publication?.added > 0) {
        const deckTitle = job.targetTitle, rejected = job.rejected?.length || 0;
        const detail = `补入 ${job.publication.added} 张到「${deckTitle}」${rejected ? `，${rejected} 张未通过审阅` : ''}`;
        try { await ports.mail(state => notify(state, { kind: 'passage-added', deckId: job.deckId, cardId: job.publication.firstCardId, detail })); }
        catch { /* the panel and the job list keep the result */ }
      }
      if (!managed) ports.announce?.(job);
    };
    const execute = async ({ job, controller, models }) => {
      const complete = (system, prompt, context = {}) => models.call(system, prompt, { ...context, stage: job.stage, signal: controller.signal });
      if (controller.signal.aborted) {
        job.status = 'cancelled'; job.outcome = 'cancelled'; job.stage = 'Cancelled before starting';
        generationControllers.delete(job.id);
        await finish(job);
        return;
      }
      const timer = setTimeout(() => {
        job.status = 'cancelling'; job.stage = 'Time budget reached; stopping workers';
        controller.abort(Object.assign(new Error('Generation reached its 20-minute total budget; nothing was saved'), { code: 'GENERATION_BUDGET' }));
      }, job.totalTimeoutSeconds * 1000);
      job.status = 'running'; job.runStartedAt = iso();
      if (job.stage === 'Waiting for the previous generation') job.stage = GENERATION_STAGE_TEXT.planning;
      try {
        const record = await proceed({ signal: controller.signal, language: request.language, workOwner: scoped.workOwner, complete, onProgress: event => progress(event, controller) });
        applyRecord(job, record, { recovery });
        const budget = controller.signal.reason?.code === 'GENERATION_BUDGET';
        if (job.status === 'cancelled' && budget && !job.cancelRequestedAt) { job.status = 'failed'; job.outcome = 'budget'; job.stage = errorText(controller.signal.reason); }
      } catch (error) {
        job.status = controller.signal.aborted && job.cancelRequestedAt ? 'cancelled' : 'failed';
        job.outcome = job.status === 'cancelled' ? 'cancelled' : 'review-failed';
        job.stage = controller.signal.aborted ? errorText(controller.signal.reason) : errorText(error);
      } finally {
        clearTimeout(timer);
        generationControllers.delete(job.id);
        await finish(job);
      }
    };
    const task = { kind: 'supplement', args, root, seed: job, execute, models: { performance: {}, feature: runtime.feature ?? 'generate' } };
    return { task, ahead, scoped };
  }

  /** Queue the run of an operation. A retry of a job of the runtime prepares its run again from the arguments it was asked with: the operation's record decides what is left to do. */
  async function start(args, request = {}) {
    const answered = await replay(args, request);
    if (answered) return answered;
    const { task, ahead, scoped } = await prepare(args, request);
    const env = { managed, jobs: runtime.jobs, sharedQuota: runtime.sharedQuota === true, queue, workOwner: scoped.workOwner, work: ports.work,
      ask: core.complete || request.complete, announce: ports.announce, prepare: async ({ runId }) => (await prepare(args, request, { self: runId })).task };
    const started = await startGeneration(env, task);
    return handle(jobs.get(started.jobId), ahead);
  }

  /** The state of one operation: the live job, or what the library kept of it. */
  async function status(args, request = {}) {
    const live = liveFor(args.operationId, () => false);
    if (live) return { job: publicJob(live) };
    const record = await core.get(args.operationId);
    if (!record) throw new Error('Selection operation does not exist');
    return { job: publicJob(await fromRecord(record, request)) };
  }

  /** The supplement jobs of one material (or of the library), running first. */
  async function list(args = {}) {
    const wanted = job => !args.documentId || job.selection?.documentId === args.documentId;
    const found = liveJobs().filter(wanted).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    return { jobs: found.map(publicJob) };
  }

  return { 'generation.selection.start': start, 'generation.selection.status': status, 'generation.selection.jobs': list };
}
