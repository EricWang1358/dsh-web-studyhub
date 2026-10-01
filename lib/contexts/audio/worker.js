import { createJobNotifier } from '../../runtime/job-notice.js';
import { ownWork } from "../../runtime/work-ownership.js";
import { id } from "../../util.js";
import { extname } from "node:path";
import { AUDIO_EXTENSIONS } from "../../audio-file.js";
import { readAudioSettings } from "../../audio-settings.js";
import { executeAudioJob } from "../../audio-job.js";
import { executeAudioBatch, listAudioBatches, removeAudioBatch, saveAudioBatch, verifySingleAudioInput } from "../../audio-batch.js";
import { LiveSession, makeTranslator, readSaved, writeSaved } from "../../live.js";
import { GeminiTiers } from "../../gemini.js";
import { makeCorrector } from "../../live-correction.js";
import { notify } from "../../inbox.js";
import { languageSystem } from '../../language.js';

export function createAudioWorker(worker, work, jobServices) {
  const { registered, register } = worker.sessions;
  const { discardUpload, adoptStoredUpload } = worker.uploads;
  const { jobs, settled, retryable, generationControllers, audioGate, recoveredBatches } = work;
  const { activeJob, pruneJobs } = jobServices;
function pumpAudio(gate) {
  while (gate.waiting.length && gate.active.size < gate.limit) {
    const next = gate.waiting.shift();
    gate.active.add(next.id);
    next.start();
  }
}

function admitAudio(gate, taskId, signal, work) {
  let onAbort;
  const turn = new Promise(resolve => {
    gate.waiting.push({ id: taskId, start: resolve });
    onAbort = () => { const at = gate.waiting.findIndex(entry => entry.id === taskId); if (at >= 0) { gate.waiting.splice(at, 1); resolve(); } };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  pumpAudio(gate);
  return turn.then(work).finally(() => { signal.removeEventListener('abort', onAbort); gate.active.delete(taskId); pumpAudio(gate); });
}

function startAudioJob(service, filename, work, { cleanup, fields = {}, orchestrates = false, persist } = {}) {
  const root = service.store.root, gate = audioGate;
  const audioJobs = [...jobs.values()].filter((j) => j.root === root && j.type === "audio-import" && activeJob(j));
  if (audioJobs.some((j) => fields.batchId ? j.batchId === fields.batchId : !j.batchId && j.filename === filename)) throw new Error("这个音频已经在处理，请等它完成");
  pruneJobs();
  const waits = gate.active.size >= gate.limit;
  const queuedBehind = waits ? gate.waiting.length + 1 : 0;
  const job = {
    id: id(), root, type: "audio-import", filename, status: waits ? "queued" : "running",
    stage: waits ? "排队中" : "读取音频", phase: waits ? "queued" : "read", done: 0, total: 0,
    warnings: [], startedAt: new Date().toISOString(), ...fields, language: service.language,
  };
  ownWork(job, service.workOwner);
  jobs.set(job.id, job);
  retryable.set(job.id, { filename, work, cleanup, ...(fields.singleId ? { singleId: fields.singleId } : {}) });
  const controller = new AbortController();
  generationControllers.set(job.id, controller);
  const run = async () => {
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
    job.stage = "读取音频";
    job.startedAt = new Date().toISOString(); // the time spent working, not the time spent waiting for a slot
    try {
      await work(job, controller.signal, (taskId, signal, member) => admitAudio(gate, taskId, signal, member));
      controller.signal.throwIfAborted();
      job.status = "complete";
      job.phase = "done";
      job.stage = job.summary ? job.summary : job.reused ? "这段内容已按同样设置处理过，直接复用"
        : `已存为 ${job.sourceIds.length} 份资料${job.corrected === undefined ? "" : `，校对修正 ${job.corrected} 处`}`;
      // Done for good: nothing to resume, so the uploaded copy of the audio can go.
      retryable.delete(job.id);
      if (!persist) { try { await cleanup?.(); } catch { /* an old copy is removed by age later */ } }
    } catch (error) {
      job.status = controller.signal.aborted && job.cancelRequestedAt ? "cancelled" : "failed";
      // Kept for a retry: what was transcribed, proofread and translated is saved, so trying again only does the rest.
      job.retryable = retryable.has(job.id);
      job.stage = job.status === "cancelled" ? "已取消；已完成的部分会保留，再来一次会接着做" : String(error.message || error).slice(0, 400);
    } finally {
      generationControllers.delete(job.id);
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
            detail: job.status === 'failed' && job.retryable ? `${job.stage.length > 90 ? job.stage.slice(0, 89) + '…' : job.stage} 已完成的部分已保存，可在「音频转录」页点「接着做」` : job.stage });
        });
      } catch { job.warnings.push('信箱通知未能保存，请在音频转录页查看任务结果。'); }
      service.announceJob(job);
    }
  };
  const done = orchestrates ? Promise.resolve().then(run) : admitAudio(gate, job.id, controller.signal, run);
  settled.set(job.id, done);
  void done.finally(() => { settled.delete(job.id); });
  return {
    jobId: job.id, status: job.status, queuedBehind,
    next: "转写、校对和翻译在后台进行，长录音需要几分钟到十几分钟。告诉学习者已开始，进度在学习面板的资料页；只有明确要等待时才用 job.wait，不要轮询或重复提交。完成后是一份资料，不会自动出题。",
  };
}

async function preparedAudioSettings(service, args) {
  const settings = await service.audioSettings();
  if (!settings.freeKey && !settings.paidKey && !settings.groqKey)
    throw new Error('还没有配置 Gemini API 密钥（转写至少要有一把 Gemini 或 Groq 密钥）：请在「设置 › 音频转写」里填写（不要贴到对话里），或设置环境变量 GEMINI_FREE_API_KEY / GEMINI_PAID_API_KEY / GROQ_API_KEY');
  if (args.paidOnly === true && !settings.paidKey) throw new Error('选择了只用付费密钥，但还没有配置付费密钥');
  if (settings.textProvider === 'host' && !service.complete) throw new Error('当前没有可用的对话模型；请在设置里把文本处理改为 Gemini');
  return settings;
}

async function startBatch(service, batch, { retry = false } = {}) {
  const fields = { id: retry ? id() : batch.job.id, batchId: batch.id, warnings: batch.job.warnings || [], courses: batch.args.courses };
  const started = startAudioJob(service, batch.title, async (job, signal, admit) => {
    const settings = await preparedAudioSettings(service, batch.args);
    await executeAudioBatch({ root: service.store.root, batch, job, signal, settings, store: service.audioStore || service.store, complete: service.complete, fetch: service.fetch, admit });
  }, { fields, orchestrates: true, persist: job => saveAudioBatch(service.store.root, batch, job),
    cleanup: () => removeAudioBatch(service.store.root, batch.id, { inputsOnly: true }) });
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
  const root = service.store.root;
  if (retry) await verifySingleAudioInput(record);
  if (retry) record.job.id = id();
  await saveAudioBatch(root, record);
  return startAudioJob(service, record.job.filename, async (job, signal) => {
    const settings = await preparedAudioSettings(service, record.args);
    await executeAudioJob({ job, args: record.args, settings, store: service.audioStore || service.store,
      complete: service.complete, fetch: service.fetch, signal });
  }, { fields: { id: record.job.id, singleId: record.id },
    persist: job => saveAudioBatch(root, record, job), cleanup: singleCleanup(root, record) });
}

function recoverAudioBatches(service) {
  const root = service.store.root;
  if (!recoveredBatches.has(root)) recoveredBatches.set(root, (async () => {
    for (const batch of await listAudioBatches(root)) {
      if (batch.kind === 'single') {
        if ([...jobs.values()].some(job => job.root === root && job.singleId === batch.id)) continue;
        const job = { ...batch.job, root, singleId: batch.id };
        if (activeJob(job)) Object.assign(job, { status: 'failed', retryable: true,
          stage: '上次导入已中断；已完成的部分已保存，点「接着做」继续', finishedAt: new Date().toISOString() });
        jobs.set(job.id, job);
        if (job.status !== 'complete') {
          job.retryable = true;
          retryable.set(job.id, { singleId: batch.id, cleanup: singleCleanup(root, batch) });
        }
        continue;
      }
      if ([...jobs.values()].some(job => job.root === root && job.batchId === batch.id)) continue;
      const job = { ...batch.job, root };
      if (activeJob(job)) Object.assign(job, { status: 'failed', retryable: true, stage: '上次导入已中断；已完成的部分已保存，点「接着做」继续', finishedAt: new Date().toISOString() });
      jobs.set(job.id, job);
      if (job.status !== 'complete') { job.retryable = true; retryable.set(job.id, { batchId: batch.id, cleanup: () => removeAudioBatch(root, batch.id, { inputsOnly: true }) }); }
    }
    // Before single-file manifests existed, only the failed inbox letter survived.
    // Show a recovery card rather than silently losing the task; the original
    // submitted path/options cannot be guessed, so the learner must reselect it.
    const state = await service.store.read();
    for (const letter of (state.inbox || []).filter(item => item.kind === 'audio-failed').slice(-50)) {
      if (jobs.has(letter.jobId) || !AUDIO_EXTENSIONS.includes(extname(letter.filename || '').toLowerCase())) continue;
      jobs.set(letter.jobId, { id: letter.jobId, root, type: 'audio-import', filename: letter.filename,
        status: 'failed', phase: 'unknown', stage: '旧版任务没有保存原文件位置和提交参数。请重新选择同一录音；相同内容和设置的已存检查点会复用。',
        legacy: true, relinkable: true, retryable: false, finishedAt: letter.at, startedAt: letter.at });
    }
  })().catch(error => { recoveredBatches.delete(root); throw error; }));
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
    : (system, prompt, options) => tiers.complete(settings.liveTranslateModel, languageSystem(system, service.language), prompt, { ...options, thinkingLevel: reasoning, label: '上下文校正' });
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
  return { pumpAudio, admitAudio, startAudioJob, preparedAudioSettings, startBatch, singleCleanup, startSingleAudio, recoverAudioBatches, liveTranslation, liveCorrector, liveSessionOf, audioSettings, announceJob };
}
