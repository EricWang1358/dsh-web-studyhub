import { createHash } from 'node:crypto';
import { id } from '../../util.js';
import { ownWork } from '../../runtime/work-ownership.js';
import { withJobUsage } from '../../usage-scope.js';
import { failStep } from '../../job-calls.js';
import { compactEstimate } from '../../token-estimate.js';
import { notify } from '../../inbox.js';
import { TARGETS, TRANSLATION_LIMITS } from '../../passage-translation.js';
import { translationControl } from '../../job-control.js';
import { libraryQueue } from './jobs/library-queue.js';
import { startTranslation } from './translation/jobs/submit-translation.js';
import { TRANSLATION_JOB_TIMEOUT_MS, TRANSLATION_STEP_LIMIT } from './translation/settings.js';
import { translateWaves } from './translation/waves.js';

/* 翻译本页 / 翻译本章 as an ordinary background job (generation.translation.*), in the machinery the supplement job of the
   reader uses (selection-jobs.js): the job table (`work.jobs`), the per-library queue, the cancel controller, the usage scope,
   the token estimate, the notice to the session and an inbox letter.

   The job only schedules, tracks and reports. What is translated, checked and kept is materials.translation.translate; the job
   asks it for one wave of paragraphs at a time (a wave is as many paragraphs as `concurrency` batches carry), so progress is
   counted as paragraphs, what is done is already kept when the wave ends, and a stop loses at most the wave in flight.
   Paragraphs that already have a translation are never in the job, so nothing is paid for twice.

   Behind `runtime.pilot.translation` the same card is run by a job of the unified runtime (translation/jobs): the queue turn, the lifecycle,
   every model call and the usage are the runtime's, the waves below are the same code. */

export { TRANSLATION_JOB_TIMEOUT_MS };
const clone = value => structuredClone(value);
const iso = () => new Date().toISOString();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const english = request => request?.language === 'en';

export function createTranslationJobs(core, ports) {
  const { jobs, queues, settled, generationControllers, jobControls, jobOutputs } = ports.work;
  const { activeJob, pruneJobs, publicJob } = ports.jobServices;
  const { root } = core;
  const queue = libraryQueue({ queues, settled });
  const env = { managed: ports.runtime?.pilot?.translation === true, jobs: ports.runtime?.jobs, sharedQuota: ports.runtime?.sharedQuota === true, queue,
    feature: ports.runtime?.feature ?? 'other', work: { jobs, generationControllers, jobControls, jobOutputs } };
  const mine = job => job.root === root && job.origin === 'translation';
  const liveJobs = () => [...jobs.values()].filter(mine);
  const handle = (job, ahead = 0, extra = {}) => ({ jobId: job.id, status: job.status, queuedBehind: ahead, job: publicJob(job), ...extra });

  const identityOf = args => ({ ...(args.documentId ? { documentId: args.documentId } : { sourceId: args.sourceId }), ...(args.revision ? { revision: args.revision } : {}) });
  const checked = args => {
    if (!args.documentId && !args.sourceId) throw new Error('Name the document to translate');
    if (args.target !== undefined && !TARGETS.includes(args.target)) throw new Error('Translation target must be zh or en');
    const scope = args.scope && (Array.isArray(args.scope.sourceIds) || Number.isInteger(args.scope.chapter))
      ? { ...(Array.isArray(args.scope.sourceIds) ? { sourceIds: args.scope.sourceIds.filter(item => typeof item === 'string') } : {}), ...(Number.isInteger(args.scope.chapter) ? { chapter: args.scope.chapter } : {}) } : null;
    if (!scope && !Array.isArray(args.passages)) throw new Error('Name the sources (scope) or the passages to translate');
    return { identity: identityOf(args), scope, passages: scope ? null : args.passages, ...(args.target ? { target: args.target } : {}),
      ...(args.retranslate === true && !scope ? { retranslate: true, comment: typeof args.comment === 'string' ? args.comment.slice(0, TRANSLATION_LIMITS.maxComment) : '' } : {}) };
  };

  async function start(args, request = {}) {
    const { identity, scope, passages, target, retranslate, comment } = checked(args);
    const scoped = { ...request, workOwner: request.workOwner ?? core.workOwner };
    const payload = { ...identity, ...(scope ? { scope } : { passages }), ...(target ? { target } : {}), ...(retranslate ? { retranslate, comment } : {}) };
    if (args.estimate === true) return { status: 'estimate', ...await core.materials('materials.translation.translate', { ...payload, estimate: true }, scoped) };
    if (typeof (core.complete || request.complete) !== 'function')
      throw Object.assign(new Error('A model is required to translate'), { code: 'CAPABILITY_UNAVAILABLE' });

    // What there is to do: the paragraphs of the sources that have no translation yet, or the explicit passages that have none.
    const planOf = async extra => {
      let meta, todo;
      if (scope) {
        meta = await core.materials('materials.translation.plan', { ...payload, ...extra }, scoped);
        todo = meta.passages.filter(item => item.state === 'todo' || item.state === 'reuse').map(({ sourceId, text, ordinal }) => ({ sourceId, text, ordinal }));
      } else {
        meta = await core.materials('materials.translation.translate', { ...payload, ...extra, estimate: true }, scoped);
        todo = meta.results.filter(item => item.status === 'todo' || item.status === 'reused').map(item => passages[item.index]);
        meta.sourceIds ||= [...new Set(todo.map(item => item.sourceId).filter(Boolean))];
      }
      return { meta, todo };
    };
    const { meta, todo } = await planOf({});
    if (!todo.length) return { jobId: null, status: 'nothing', total: 0, job: null };
    // A job run by the runtime keeps the glossary of the moment it was submitted: every wave (and a resume) asks with it, whatever is saved later.
    const frozen = env.managed ? { glossary: meta.glossary } : {};
    const concurrency = Number.isInteger(args.concurrency) ? Math.min(TRANSLATION_LIMITS.concurrency.max, Math.max(TRANSLATION_LIMITS.concurrency.min, args.concurrency)) : TRANSLATION_LIMITS.concurrency.default;
    const semantic = digest({ documentId: meta.documentId, revision: meta.revision, target: meta.target, retranslate: !!retranslate, comment: comment || '', keys: todo.map(item => `${item.sourceId}|${item.ordinal ?? 0}|${item.text.length}|${item.text.slice(0, 40)}`) });
    const running = liveJobs().find(job => activeJob(job) && job.semantic === semantic);
    if (running) return handle(running, 0, { alreadyRunning: true });

    pruneJobs();
    const ahead = [...jobs.values()].filter(job => job.root === root && activeJob(job)).length, controller = new AbortController();
    const requestedId = args.documentId || args.sourceId, sourceIds = scope ? (scope.sourceIds ? meta.sourceIds.filter(item => scope.sourceIds.includes(item)) : meta.scopeSourceIds) : meta.sourceIds;
    const job = { id: id(), root, type: 'translation', origin: 'translation', semantic, documentId: meta.documentId, requestedId, revision: meta.revision, sourceIds, targetTitle: meta.title || '',
      scopeLabel: typeof args.label === 'string' ? args.label.slice(0, 80) : '', target: meta.target, total: todo.length, done: 0, translated: 0, reused: 0, rejected: 0, requestedTotal: todo.length, savedCount: 0,
      concurrency, parts: 1, steps: [], messages: [], status: ahead ? 'queued' : 'running', stage: ahead ? 'Waiting for the previous generation' : 'Writing translations 0/' + todo.length,
      totalTimeoutSeconds: TRANSLATION_JOB_TIMEOUT_MS / 1000, startedAt: iso(), language: request.language };
    if (!ahead) job.runStartedAt = job.startedAt;
    // What this run is expected to use, kept to set beside what it did use; an estimate is never a reason to refuse.
    try {
      const priced = await core.materials('materials.translation.translate', { ...identity, revision: meta.revision, passages: todo, target: meta.target, estimate: true, ...(retranslate ? { retranslate, comment } : {}) }, scoped);
      job.estimate = compactEstimate(priced.estimate);
    } catch { /* an estimate is a convenience */ }
    // The console's hand on this run: how many paragraphs the next wave takes, and pause between waves.
    const makeControl = card => translationControl({ job: card, limits: TRANSLATION_LIMITS.concurrency, concurrency });

    const finish = async job => {
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
    /** A job stopped while it still waited for the library: nothing was asked of the model, and it ends here, at once. */
    const cancelBeforeStart = async (card, control) => {
      card.status = 'cancelled'; card.outcome = 'cancelled'; card.stage = 'Cancelled before starting';
      generationControllers.delete(card.id);
      jobControls?.delete(card.id); control.close(); jobOutputs?.endJob(card.id);
      await finish(card);
    };
    /** The waves of this run, whoever carries them: `ask` is the model, `todo` what is still to do, `beforeWave(at)` may stop the run at a wave boundary. */
    const execute = ({ job: card, control, controller: stopper, ask, todo: left, beforeWave }) => translateWaves({ job: card, control, controller: stopper, ask, todo: left, beforeWave,
      generationControllers, jobControls, finish, translate: (slice, live, wave) => core.materials('materials.translation.translate', { ...identity, revision: meta.revision, target: meta.target,
        passages: slice, concurrency: live, ...frozen, ...(retranslate ? { retranslate, comment } : {}) }, { ...scoped, signal: stopper.signal, complete: wave, language: request.language }) });

    if (env.managed) {
      const started = await startTranslation(env, { kind: 'translation', args, root, seed: job, todo, makeControl, execute, cancelBeforeStart, feature: env.feature,
        // A resumed run asks what is still to do (the kept waves are not sent again).
        replan: async () => (await planOf(frozen)).todo });
      // The handle shows the card as submitted, under the id the runtime gave the job (the runtime's own record is presented from its first turn).
      return handle({ ...job, id: started.jobId }, ahead);
    }

    ownWork(job, scoped.workOwner);
    jobs.set(job.id, job);
    generationControllers.set(job.id, controller);
    const control = makeControl(job);
    jobControls?.set(job.id, control);

    const model = (system, prompt, options = {}) => {
      controller.signal.throwIfAborted();
      const step = { id: id(), stage: job.stage, status: 'starting', startedAt: iso() };
      job.steps.push(step);
      if (job.steps.length > TRANSLATION_STEP_LIMIT) job.steps.splice(0, job.steps.length - TRANSLATION_STEP_LIMIT);
      jobOutputs?.open(job.id, step.id);
      return Promise.resolve().then(() => withJobUsage(job, step, () => (core.complete || request.complete)(system, prompt,
        { ...options, jobId: job.id, stage: step.stage, signal: controller.signal, resultOwner: 'plugin', onEvent: event => Object.assign(step, event),
          onOutput: text => { step.firstOutputAt ??= iso(); jobOutputs?.append(job.id, step.id, text); }, onReasoning: count => jobOutputs?.reasoning(job.id, step.id, count) })))
        .then(value => { controller.signal.throwIfAborted(); step.runtime ||= 'direct'; step.status = 'complete'; return value; },
          error => { failStep(step, error); throw error; })
        .finally(() => { jobOutputs?.close(job.id, step.id); step.finishedAt = iso(); });
    };
    const run = async () => {
      if (controller.signal.aborted) { await cancelBeforeStart(job, control); return; }
      await execute({ job, control, controller, ask: model, todo });
    };
    queue.run(root, job.id, run);
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
