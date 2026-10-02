import { createHash } from 'node:crypto';
import { id } from '../../util.js';
import { ownWork } from '../../runtime/work-ownership.js';
import { withJobUsage } from '../../usage-scope.js';
import { compactEstimate } from '../../token-estimate.js';
import { notify } from '../../inbox.js';
import { TARGETS, TRANSLATION_LIMITS } from '../../passage-translation.js';

/* 翻译本页 / 翻译本章 as an ordinary background job (generation.translation.*), in the machinery the supplement job of the
   reader uses (selection-jobs.js): the job table (`work.jobs`), the per-library queue, the cancel controller, the usage scope,
   the token estimate, the notice to the session and an inbox letter.

   The job only schedules, tracks and reports. What is translated, checked and kept is materials.translation.translate; the job
   asks it for one wave of paragraphs at a time (a wave is as many paragraphs as `concurrency` batches carry), so progress is
   counted as paragraphs, what is done is already kept when the wave ends, and a stop loses at most the wave in flight.
   Paragraphs that already have a translation are never in the job, so nothing is paid for twice. */

const clone = value => structuredClone(value);
const iso = () => new Date().toISOString();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const errorText = error => error?.message || String(error);
const english = request => request?.language === 'en';
const STEP_LIMIT = 40;
/** A job that has run this long stops: a chapter of a long book is a long run, but not an endless one. */
export const TRANSLATION_JOB_TIMEOUT_MS = 60 * 60 * 1000;

export function createTranslationJobs(core, ports) {
  const { jobs, queues, settled, generationControllers } = ports.work;
  const { activeJob, pruneJobs, publicJob } = ports.jobServices;
  const { root } = core;
  const mine = job => job.root === root && job.origin === 'translation';
  const liveJobs = () => [...jobs.values()].filter(mine);
  const handle = (job, ahead = 0, extra = {}) => ({ jobId: job.id, status: job.status, queuedBehind: ahead, job: publicJob(job), ...extra });

  const identityOf = args => ({ ...(args.documentId ? { documentId: args.documentId } : { sourceId: args.sourceId }), ...(args.revision ? { revision: args.revision } : {}) });
  const checked = args => {
    if (!args.documentId && !args.sourceId) throw new Error('Name the document to translate');
    if (args.target !== undefined && !TARGETS.includes(args.target)) throw new Error('Translation target must be zh or en');
    const scope = args.scope && Array.isArray(args.scope.sourceIds) ? { sourceIds: args.scope.sourceIds.filter(item => typeof item === 'string') } : null;
    if (!scope && !Array.isArray(args.passages)) throw new Error('Name the sources (scope) or the passages to translate');
    return { identity: identityOf(args), scope, passages: scope ? null : args.passages, ...(args.target ? { target: args.target } : {}) };
  };

  async function start(args, request = {}) {
    const { identity, scope, passages, target } = checked(args);
    const scoped = { ...request, workOwner: request.workOwner ?? core.workOwner };
    const payload = { ...identity, ...(scope ? { scope } : { passages }), ...(target ? { target } : {}) };
    if (args.estimate === true) return { status: 'estimate', ...await core.materials('materials.translation.translate', { ...payload, estimate: true }, scoped) };
    if (typeof (core.complete || request.complete) !== 'function')
      throw Object.assign(new Error('A model is required to translate'), { code: 'CAPABILITY_UNAVAILABLE' });

    // What there is to do: the paragraphs of the sources that have no translation yet, or the explicit passages that have none.
    let meta, todo;
    if (scope) {
      meta = await core.materials('materials.translation.plan', payload, scoped);
      todo = meta.passages.filter(item => item.state === 'todo' || item.state === 'reuse').map(({ sourceId, text, ordinal }) => ({ sourceId, text, ordinal }));
    } else {
      meta = await core.materials('materials.translation.translate', { ...payload, estimate: true }, scoped);
      todo = meta.results.filter(item => item.status === 'todo' || item.status === 'reused').map(item => passages[item.index]);
      meta.sourceIds ||= [...new Set(todo.map(item => item.sourceId).filter(Boolean))];
    }
    if (!todo.length) return { jobId: null, status: 'nothing', total: 0, job: null };
    const concurrency = Number.isInteger(args.concurrency) ? Math.min(TRANSLATION_LIMITS.concurrency.max, Math.max(TRANSLATION_LIMITS.concurrency.min, args.concurrency)) : TRANSLATION_LIMITS.concurrency.default;
    const semantic = digest({ documentId: meta.documentId, revision: meta.revision, target: meta.target, keys: todo.map(item => `${item.sourceId}|${item.ordinal ?? 0}|${item.text.length}|${item.text.slice(0, 40)}`) });
    const running = liveJobs().find(job => activeJob(job) && job.semantic === semantic);
    if (running) return handle(running, 0, { alreadyRunning: true });

    pruneJobs();
    const ahead = [...jobs.values()].filter(job => job.root === root && activeJob(job)).length, controller = new AbortController();
    const requestedId = args.documentId || args.sourceId, sourceIds = scope ? meta.sourceIds.filter(item => scope.sourceIds.includes(item)) : meta.sourceIds;
    const job = { id: id(), root, type: 'translation', origin: 'translation', semantic, documentId: meta.documentId, requestedId, revision: meta.revision, sourceIds, targetTitle: meta.title || '',
      scopeLabel: typeof args.label === 'string' ? args.label.slice(0, 80) : '', target: meta.target, total: todo.length, done: 0, translated: 0, reused: 0, rejected: 0, requestedTotal: todo.length, savedCount: 0,
      concurrency, parts: 1, steps: [], messages: [], status: ahead ? 'queued' : 'running', stage: ahead ? 'Waiting for the previous generation' : 'Writing translations 0/' + todo.length,
      totalTimeoutSeconds: TRANSLATION_JOB_TIMEOUT_MS / 1000, startedAt: iso(), language: request.language };
    if (!ahead) job.runStartedAt = job.startedAt;
    // What this run is expected to use, kept to set beside what it did use; an estimate is never a reason to refuse.
    try {
      const priced = await core.materials('materials.translation.translate', { ...identity, revision: meta.revision, passages: todo, target: meta.target, estimate: true }, scoped);
      job.estimate = compactEstimate(priced.estimate);
    } catch { /* an estimate is a convenience */ }
    ownWork(job, scoped.workOwner);
    jobs.set(job.id, job);
    generationControllers.set(job.id, controller);

    const model = (system, prompt, options = {}) => {
      controller.signal.throwIfAborted();
      const step = { id: id(), stage: job.stage, status: 'starting', startedAt: iso() };
      job.steps.push(step);
      if (job.steps.length > STEP_LIMIT) job.steps.splice(0, job.steps.length - STEP_LIMIT);
      return Promise.resolve().then(() => withJobUsage(job, step, () => (core.complete || request.complete)(system, prompt,
        { ...options, jobId: job.id, stage: step.stage, signal: controller.signal, resultOwner: 'plugin', onEvent: event => Object.assign(step, event) })))
        .then(value => { controller.signal.throwIfAborted(); step.runtime ||= 'direct'; step.status = 'complete'; return value; },
          error => { step.status = 'failed'; throw error; })
        .finally(() => { step.finishedAt = iso(); });
    };

    const finish = async () => {
      job.finishedAt = iso();
      const complete = job.status === 'complete', failed = job.status === 'failed';
      if (complete || failed) {
        const detail = complete ? (english(request) ? `Translated ${job.translated + job.reused} paragraphs${job.rejected ? `; ${job.rejected} could not be translated` : ''}` : `译好 ${job.translated + job.reused} 段${job.rejected ? `，${job.rejected} 段没有译成` : ''}`) : job.stage;
        try {
          await ports.mail(state => notify(state, { kind: complete ? 'translate-result' : 'translate-failed', jobId: job.id, filename: job.targetTitle || job.requestedId, sourceIds: job.sourceIds, detail }));
        } catch { /* the reader and the job list keep the result */ }
      }
      ports.announce?.(job);
    };
    const run = async () => {
      if (controller.signal.aborted) {
        job.status = 'cancelled'; job.outcome = 'cancelled'; job.stage = 'Cancelled before starting';
        generationControllers.delete(job.id);
        await finish();
        return;
      }
      const timer = setTimeout(() => {
        job.status = 'cancelling'; job.stage = 'Time budget reached; stopping workers';
        controller.abort(Object.assign(new Error('Translation reached its time budget; translated paragraphs are kept'), { code: 'GENERATION_BUDGET' }));
      }, job.totalTimeoutSeconds * 1000);
      job.status = 'running'; job.runStartedAt = iso();
      job.stage = `Writing translations ${job.done}/${job.total}`;
      try {
        const wave = concurrency * TRANSLATION_LIMITS.batchItems;
        for (let at = 0; at < todo.length; at += wave) {
          controller.signal.throwIfAborted();
          const slice = todo.slice(at, at + wave);
          const result = await core.materials('materials.translation.translate', { ...identity, revision: meta.revision, target: meta.target, passages: slice, concurrency },
            { ...scoped, signal: controller.signal, complete: model, language: request.language });
          job.translated += result.counts.translated; job.reused += result.counts.reused;
          job.rejected += result.counts.rejected + result.counts.unlocated;
          job.done += slice.length; job.savedCount = job.translated + job.reused;
          job.stage = `Writing translations ${job.done}/${job.total}`;
        }
        job.status = 'complete'; job.outcome = job.rejected ? 'partial' : 'translated';
        job.stage = job.rejected ? `Translated ${job.savedCount} of ${job.total} paragraphs; ${job.rejected} could not be translated` : `Translated ${job.total} paragraphs`;
      } catch (error) {
        const stopped = controller.signal.aborted;
        const budget = controller.signal.reason?.code === 'GENERATION_BUDGET' && !job.cancelRequestedAt;
        job.status = stopped && !budget ? 'cancelled' : 'failed';
        job.outcome = job.status === 'cancelled' ? 'cancelled' : budget ? 'budget' : 'failed';
        job.stage = stopped ? errorText(controller.signal.reason) : errorText(error);
      } finally {
        clearTimeout(timer);
        generationControllers.delete(job.id);
        await finish();
      }
    };
    const done = (queues.get(root) || Promise.resolve()).then(run);
    queues.set(root, done);
    settled.set(job.id, done);
    void done.finally(() => { settled.delete(job.id); if (queues.get(root) === done) queues.delete(root); });
    return handle(job, ahead);
  }

  /** The state of one translation job. */
  async function status(args) {
    const job = liveJobs().find(item => item.id === args.jobId);
    if (!job) throw new Error('Translation job does not exist');
    return { job: publicJob(job) };
  }

  /** The translation jobs of one material (or of the library), oldest first. */
  async function list(args = {}) {
    const wanted = job => !args.documentId && !args.sourceId
      || (args.documentId && (job.documentId === args.documentId || job.requestedId === args.documentId)) || (args.sourceId && job.sourceIds?.includes(args.sourceId));
    return { jobs: liveJobs().filter(wanted).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt)).map(item => clone(publicJob(item))) };
  }

  return { 'generation.translation.start': start, 'generation.translation.status': status, 'generation.translation.jobs': list };
}
