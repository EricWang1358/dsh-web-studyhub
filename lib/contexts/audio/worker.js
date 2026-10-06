import { pathOf, restorable, restoreManagedAudio, runsOnRuntime, startManagedAudio } from './jobs/submit-audio.js';
import { skipMembers } from '../../audio-batch-skip.js';
import { explainBatchRefusal } from '../../audio-batch-runtime-store.js';
import { AUDIO_TEXT, savedAs } from '../../audio-messages.js';
import { admitSlot as admitAudio, pumpSlots as pumpAudio } from '../../jobs/scheduler.js';
import { createJobNotifier } from '../../runtime/job-notice.js';
import { ownWork } from "../../runtime/work-ownership.js";
import { id } from "../../util.js";
import { extname } from "node:path";
import { AUDIO_EXTENSIONS } from "../../audio-file.js";
import { assertImportSettings, readAudioSettings } from "../../audio-settings.js";
import { executeAudioJob } from "../../audio-job.js";
import { executeAudioBatch, listAudioBatches, readAudioBatch, removeAudioBatch, saveAudioBatch, sweepRetiredAudioBatches, verifySingleAudioInput } from "../../audio-batch.js";
import { LiveSession, makeTranslator, readSaved, writeSaved } from "../../live.js";
import { GeminiTiers } from "../../gemini.js";
import { makeCorrector } from "../../live-correction.js";
import { notify } from "../../inbox.js";
import { languageSystem } from '../../language.js';
import { createConvertWorker } from './convert.js';
import { providerLevel } from '../../model-effort.js';
import { jobArchive } from '../../job-archive.js';
import { RUNTIME_CONTRACT_VERSION, validateRuntimeContract } from '../../jobs/contract.js';
import { jobCleanup } from '../../job-cleanup.js';

export function createAudioWorker(worker, work, jobServices) {
  const { registered, register } = worker.sessions;
  const { discardUpload, adoptStoredUpload } = worker.uploads;
  const { jobs, settled, retryable, generationControllers, audioGate, recoveredBatches, jobControls, jobOutputs } = work;
  const { activeJob, pruneJobs } = jobServices;
/** The host's transcription gate follows the learner's "transcription concurrency" setting (shared by every library of the host). */
async function syncAudioGate(service) {
  try {
    const settings = await service.audioSettings();
    audioGate.limit = settings.transcribeConcurrency;
    pumpAudio(audioGate);
  } catch { /* the gate keeps its limit */ }
}

/** What a running import hands to the 任务 console's controls: where its control is registered, and how the host's transcription gate is moved. */
const persisters = new Map();
const liveControls = {
  outputs: jobOutputs,
  // The boundary of a pause is reached: what the job knows is written down (the finished windows are already kept in their checkpoints).
  onPaused: (job) => persisters.get(job.id)?.(job),
  register: (job, control) => { jobControls.set(job.id, control); },
  setTranscribeLimit: (limit) => { audioGate.limit = limit; pumpAudio(audioGate); },
};

function startAudioJob(service, filename, work, { cleanup, fields = {}, orchestrates = false, persist } = {}) {
  if (service.providerResources?.enabled && !fields.singleId)
    throw Object.assign(new Error('Shared provider quota currently supports single audio imports only'), { code: 'capability-unverified' });
  const root = service.store.root, gate = audioGate;
  const audioJobs = [...jobs.values()].filter((j) => j.root === root && j.type === "audio-import" && activeJob(j));
  if (audioJobs.some((j) => fields.batchId ? j.batchId === fields.batchId : !j.batchId && j.filename === filename)) throw new Error(AUDIO_TEXT.alreadyRunning);
  pruneJobs();
  const waits = gate.active.size >= gate.limit;
  const queuedBehind = waits ? gate.waiting.length + 1 : 0;
  const job = {
    id: id(), root, type: "audio-import", filename, status: waits ? "queued" : "running",
    stage: waits ? AUDIO_TEXT.queued : AUDIO_TEXT.reading, phase: waits ? "queued" : "read", done: 0, total: 0,
    warnings: [], startedAt: new Date().toISOString(), ...fields, language: service.language,
  };
  ownWork(job, service.workOwner);
  jobs.set(job.id, job);
  if (persist) persisters.set(job.id, persist);
  retryable.set(job.id, { filename, work, cleanup, ...(fields.singleId ? { singleId: fields.singleId } : {}) });
  const controller = new AbortController();
  generationControllers.set(job.id, controller);
  const run = async (release) => {
    if (controller.signal.aborted) {
      job.status = "cancelled";
      job.retryable = true;
      job.finishedAt ||= new Date().toISOString();
      generationControllers.delete(job.id);
      await persist?.(job);
      return;
    }
    job.status = "running";
    job.phase = "read";
    job.stage = AUDIO_TEXT.reading;
    job.startedAt = new Date().toISOString(); // the time spent working, not the time spent waiting for a slot
    let resourceLease;
    try {
      resourceLease = service.providerResources?.open(controller.signal);
      await work(job, controller.signal, (taskId, signal, member) => admitAudio(gate, taskId, signal, member), release, resourceLease?.resources);
      controller.signal.throwIfAborted();
      job.status = "complete";
      job.phase = "done";
      job.stage = job.summary ? job.summary : job.reused ? AUDIO_TEXT.reused : savedAs(job.sourceIds.length, job.corrected);
      // Done for good: nothing to resume, so the uploaded copy of the audio can go.
      retryable.delete(job.id);
      if (!persist) { try { await cleanup?.(); } catch { /* an old copy is removed by age later */ } }
    } catch (error) {
      job.status = controller.signal.aborted && job.cancelRequestedAt ? "cancelled" : "failed";
      // Kept for a retry: what was transcribed, proofread and translated is saved, so trying again only does the rest.
      job.retryable = retryable.has(job.id);
      job.stage = job.status === "cancelled" ? AUDIO_TEXT.cancelled : String(error.message || error).slice(0, 400);
    } finally {
      await resourceLease?.finish();
      generationControllers.delete(job.id);
      // Nothing is left to adjust once the import is over.
      jobControls.get(job.id)?.close();
      jobControls.delete(job.id);
      jobOutputs.endJob(job.id);
      persisters.delete(job.id);
      job.finishedAt = new Date().toISOString();
      // Persisted jobs resume from manifests, so a failed job needs no model/service closure.
      const retained = retryable.get(job.id);
      if (retained && (job.singleId || job.batchId)) retryable.set(job.id, {
        singleId: job.singleId, batchId: job.batchId, cleanup: retained.cleanup,
      });
      try {
        await persist?.(job);
        if (persist && job.status === 'complete') await cleanup?.();
      } catch { job.warnings.push('任务进度或原文件清理未能保存；已完成的逐段检查点仍保留。'); }
      try {
        await service.store.update(s => {
          for (const message of s.inbox || []) if (message.jobId === job.id) message.sourceIds = job.sourceIds || [];
          notify(s, { kind: job.status === 'complete' ? 'audio-result' : 'audio-failed', jobId: job.id,
            filename: job.filename, sourceIds: job.sourceIds,
            detail: job.status === 'failed' && job.retryable ? `${job.stage.length > 90 ? job.stage.slice(0, 89) + '…' : job.stage} 已完成的部分已保存，可在「音频转写」页点「接着做」` : job.stage });
        });
      } catch { job.warnings.push('信箱通知未能保存，请在音频转写页查看任务结果。'); }
      service.announceJob(job);
    }
  };
  const done = orchestrates ? Promise.resolve().then(run) : admitAudio(gate, job.id, controller.signal, run);
  settled.set(job.id, done);
  void done.finally(() => { settled.delete(job.id); });
  return {
    jobId: job.id, status: job.status, queuedBehind,
    next: AUDIO_TEXT.started,
  };
}

async function preparedAudioSettings(service, args) {
  return assertImportSettings(await service.audioSettings(), { paidOnly: args.paidOnly === true, hostModel: !!service.complete });
}

/** What leaves with a manifest record once it is done: a batch's inputs, a single import's inputs and uploaded copy. */
const manifestCleanup = (root, record) => record.kind === 'single' ? singleCleanup(root, record) : batchCleanup(root, record.id);

/** A batch's working copy leaves with the job: its inputs once it is done, all of it when it is dismissed. */
const batchCleanup = (root, batchId) => () => removeAudioBatch(root, batchId, { inputsOnly: true });

/** Start a batch, or retry it (`skip`: the files to leave out first). Which executor runs it follows the batch's switch and record. */
async function startBatch(service, batch, { retry = false, skip } = {}) {
  const root = service.store.root;
  if (runsOnRuntime(service, batch)) {
    const prepareRetry = skip === undefined ? undefined : () => skipMembers(root, batch.id, skip);
    return startManagedAudio(service, batch, { retry, cleanup: batchCleanup(root, batch.id), extra: { batchId: batch.id }, prepareRetry,
      explain: error => explainBatchRefusal(root, batch.id, error) });
  }
  const undo = skip === undefined ? undefined : await skipMembers(root, batch.id, skip);
  try { return await startLegacyBatch(service, await readAudioBatch(root, batch.id), { retry }); } catch (error) { await undo?.(); throw error; }
}

async function startLegacyBatch(service, batch, { retry = false } = {}) {
  await syncAudioGate(service);
  const fields = { id: retry ? id() : batch.job.id, batchId: batch.id, warnings: batch.job.warnings || [], courses: batch.args.courses };
  const started = startAudioJob(service, batch.title, async (job, signal, admit) => {
    const settings = await preparedAudioSettings(service, batch.args);
    await executeAudioBatch({ root: service.store.root, batch, job, signal, settings, store: service.audioStore || service.store, complete: service.complete, fetch: service.fetch, admit, controls: liveControls });
  }, { fields, orchestrates: true, persist: job => saveAudioBatch(service.store.root, batch, job),
    cleanup: batchCleanup(service.store.root, batch.id) });
  await saveAudioBatch(service.store.root, batch, jobs.get(started.jobId));
  return { ...started, batchId: batch.id };
}

function singleCleanup(root, record) {
  return async () => {
    await removeAudioBatch(root, record.id, { inputsOnly: true });
    if (record.upload) {
      try { await discardUpload(await adoptStoredUpload(root, record.upload)); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  };
}

async function startSingleAudio(service, record, { retry = false } = {}) {
  if (runsOnRuntime(service, record)) {
    if (!retry && [...jobs.values()].some(job => job.root === service.store.root && job.type === 'audio-import' && activeJob(job) && !job.batchId && job.filename === record.job.filename)) throw new Error(AUDIO_TEXT.alreadyRunning);
    pruneJobs();
    return startManagedAudio(service, record, { retry, cleanup: singleCleanup(service.store.root, record) });
  }
  const root = service.store.root;
  if (retry) await verifySingleAudioInput(record);
  if (retry) record.job.id = id();
  await saveAudioBatch(root, record);
  await syncAudioGate(service);
  return startAudioJob(service, record.job.filename, async (job, signal, admit, release, resources) => {
    const settings = await preparedAudioSettings(service, record.args);
    await executeAudioJob({ job, args: record.args, settings, store: service.audioStore || service.store,
      complete: service.complete, fetch: service.fetch, signal, releaseSlot: release, controls: liveControls, resources });
  }, { fields: { id: record.job.id, singleId: record.id },
    persist: job => saveAudioBatch(root, record, job), cleanup: singleCleanup(root, record) });
}

/* Bring back what the last run left: the jobs of the batch and single-import folders, the PDF conversions and the pre-manifest cards. Once per library, and again
   on request (`again`: after an archived job was unarchived, so its folder is read once more). What is ARCHIVED (job-archive.json) is not brought back: it stays a
   read-only record until it is unarchived; records that have outlived the archive's limits are trimmed here and their working folders cleaned. */
function recoverAudioBatches(service, { again = false } = {}) {
  const root = service.store.root;
  const run = async () => {
    // Finish deleting batches dismissed before the last shutdown; they are already invisible to listAudioBatches().
    void sweepRetiredAudioBatches(root).catch(error => console.error('[study] retired audio cleanup failed:', error?.message || error));
    const archive = jobArchive(root);
    for (const record of (await archive.trim()).evicted) if (record.files) void jobCleanup.dismissBatch(root, record.files).catch(() => {});
    const archived = new Set((await archive.list()).flatMap(record => record.ids));
    // Restored v2 rows are history: their observed archive aliases/folder must not reopen a legacy retry.
    for (const job of jobs.values()) if (job.root === root && job.restoredContract?.contractVersion === RUNTIME_CONTRACT_VERSION) {
      for (const name of [job.id, job.restoredContract.jobId, ...(job.restoredArchive?.ids || []), job.restoredArchive?.files]) if (name) archived.add(name);
    }
    for (const batch of await listAudioBatches(root)) {
      if (archived.has(batch.id) || archived.has(batch.job?.id)) continue;
      const own = pathOf(batch).lineage;
      if (restorable(service, batch)) {
        await restoreManagedAudio(service, batch, manifestCleanup(root, batch));
        continue;
      }
      if ([...jobs.values()].some(job => job.root === root && job[own] === batch.id)) continue;
      if (Object.hasOwn(batch, 'runtimeJob')) {
        // Before the runtime adapter is installed, retain canonical observations
        // as read-only. A legacy worker cannot declare its executor lost or
        // resume it under a different lifecycle owner.
        if (batch.runtimeJob?.schemaVersion !== 1) throw Object.assign(new Error('unsupported-store-version'), { code: 'unsupported-store-version' });
        const contract = validateRuntimeContract(batch.runtimeJob.contract);
        for (const action of Object.keys(contract.actions)) contract.actions[action] = { ...contract.actions[action], available: false, reason: { code: 'kernel-recovery-required' } };
        const job = ownWork({ ...batch.job, root, [own]: batch.id, type: contract.kind, contract, retryable: false }, service.workOwner);
        jobs.set(job.id, job); continue;
      }
      const job = { ...batch.job, root, [own]: batch.id };
      if (activeJob(job)) Object.assign(job, { status: 'failed', retryable: true, stage: '上次导入已中断；已完成的部分已保存，点「接着做」继续', finishedAt: new Date().toISOString() });
      jobs.set(job.id, job);
      if (job.status !== 'complete') { job.retryable = true; retryable.set(job.id, { [own]: batch.id, cleanup: manifestCleanup(root, batch) }); }
    }
    // Cloud PDF conversions the last run left unfinished come back as retryable jobs (same job list, same retry flow).
    await convert.recoverConvertJobs(service, { archived });
    // Before single-file manifests existed, only the failed inbox letter survived.
    // Show a recovery card rather than silently losing the task; the original
    // submitted path/options cannot be guessed, so the learner must reselect it.
    const state = await service.store.read();
    for (const letter of (state.inbox || []).filter(item => item.kind === 'audio-failed').slice(-50)) {
      if (jobs.has(letter.jobId) || archived.has(letter.jobId) || !AUDIO_EXTENSIONS.includes(extname(letter.filename || '').toLowerCase())) continue;
      jobs.set(letter.jobId, { id: letter.jobId, root, type: 'audio-import', filename: letter.filename,
        status: 'failed', phase: 'unknown', stage: '旧版任务没有保存原文件位置和提交参数。请重新选择同一录音；相同内容和设置的已存检查点会复用。',
        legacy: true, relinkable: true, retryable: false, finishedAt: letter.at, startedAt: letter.at });
    }
  };
  const started = () => run().catch(error => { recoveredBatches.delete(root); throw error; });
  if (!recoveredBatches.has(root)) recoveredBatches.set(root, started());
  else if (again) recoveredBatches.set(root, recoveredBatches.get(root).catch(() => {}).then(started));
  return recoveredBatches.get(root);
}

function liveTranslation(service, settings, { subject, vocabulary, paidOnly = false }) {
  const hostModel = service.light || service.complete;
  if (settings.textProvider === 'host' && !hostModel) throw new Error('当前没有可用的对话模型；请在音频设置里选择 Gemini');
  if (settings.textProvider !== 'host' && !settings.freeKey && !settings.paidKey) throw new Error('请先在音频设置中配置 Gemini 密钥');
  const tiers = new GeminiTiers({ keys: { free: settings.freeKey, paid: settings.paidKey }, fetch: service.fetch, skipFree: paidOnly });
  const complete = settings.textProvider === 'host' ? hostModel
    : (system, prompt, options) => tiers.complete(settings.liveTranslateModel, system, prompt, { signal: options?.signal, label: '实时翻译' });
  return { tiers, translate: makeTranslator({ complete, subject, vocabulary }) };
}

function liveCorrector(service, settings, { subject, vocabulary, paidOnly = false }) {
  const tiers = new GeminiTiers({ keys: { free: settings.freeKey, paid: settings.paidKey }, fetch: service.fetch, skipFree: paidOnly });
  const reasoning = settings.liveCorrectionReasoning || 'low';
  const spawn = service.light?.spawnCorrection || service.complete?.spawnCorrection;
  const complete = settings.textProvider === 'host'
    ? (system, prompt, options) => (service.light || service.complete)(system, prompt, { ...options, reasoningEffort: reasoning, maxTokens: 4096 })
    : (system, prompt, options) => tiers.complete(settings.liveTranslateModel, languageSystem(system, service.language), prompt, { ...options, thinkingLevel: providerLevel(reasoning), label: '上下文校正' });
  const background = settings.textProvider === 'host' && spawn
    ? (system, prompt, options) => spawn(system, prompt, { ...options, reasoningEffort: reasoning })
    : complete;
  return makeCorrector({ complete, background,
    subject, vocabulary, modelKey: `${settings.textProvider}:${settings.liveTranslateModel}:${reasoning}`,
    usage: settings.textProvider === 'host' ? undefined : () => tiers.summary() });
}

async function liveSessionOf(service, id) {
  const root = service.store.root;
  if (typeof id !== "string" || !id) throw new Error("需要实录编号 id");
  const existing = registered(root, id);
  if (existing) return existing;
  const saved = await readSaved(root, id);
  const session = new LiveSession({ id: saved.id, title: saved.title, tiers: new GeminiTiers({}), translate: null, save: (data) => writeSaved(root, data), saved });
  register(root, session);
  return session;
}
async function audioSettings() {
    const settings = await readAudioSettings();
    return settings.textProvider === "auto" ? { ...settings, textProvider: worker.complete || worker.light ? "host" : "gemini" } : settings;
  }
const announceJob = createJobNotifier(worker.notify);
  worker.audioSettings ||= audioSettings;
  worker.announceJob = announceJob;
  const convert = createConvertWorker(worker, work, jobServices);
  return { convert, pumpAudio, admitAudio, startAudioJob, preparedAudioSettings, startBatch, singleCleanup, startSingleAudio, recoverAudioBatches, liveTranslation, liveCorrector, liveSessionOf, audioSettings, announceJob };
}
