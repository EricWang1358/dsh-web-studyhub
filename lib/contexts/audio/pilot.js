import { createSingleAudioPersistence } from '../../audio-runtime-store.js';
import { readAudioBatch } from '../../audio-batch.js';
import { executeAudioJob, storeDocuments } from '../../audio-job.js';
import { audioSourceId, textKey } from '../../audio-import.js';
import { admitSlot, pumpSlots } from '../../jobs/scheduler.js';
import { jobContract } from '../../job-contract.js';
import { notify } from '../../inbox.js';

const fields = ['filename', 'singleId', 'phase', 'done', 'total', 'steps', 'warnings', 'sourceIds', 'usage', 'usageRun', 'retryable', 'language',
  'parallel', 'pace', 'minutes', 'chunks', 'estimatedUsd', 'titleEn', 'partCount', 'corrected', 'uncertain', 'reused', 'diagnostics', 'textProvider', 'vocabulary'];
const receipt = contract => ({ jobId: contract.runtime.legacyId, status: contract.status, queuedBehind: contract.detail.queuedBehind || 0,
  next: '转写、校对和翻译在后台进行，进度在学习面板的资料页；只有明确要等待时才用 job.wait，不要轮询或重复提交。完成后是一份资料，不会自动出题。' });
const facade = contract => ({ ...contract.detail.legacy, id: contract.runtime.legacyId, type: contract.kind,
  status: contract.status === 'interrupted' ? 'failed' : contract.status, stage: contract.error?.message || contract.stage.text || contract.stage.code,
  sourceIds: contract.result.refs.filter(ref => ref.kind === 'source').map(ref => ref.id) });

export const singleAudioDefinition = {
  kind: 'audio-import', version: 1, title: 'Audio import', legacyFields: fields,
  capabilities: { cancel: true, retry: true, set: true, pauseMode: 'checkpoint', recoveryMode: 'resume-checkpoint', executionModes: ['direct', 'subagent'] },
  persistence: { async open(input, binding) {
    const { worker } = binding;
    const port = await createSingleAudioPersistence(worker.store.root, { library: worker.audioStore,
      notifications: [
        { channel: 'inbox', idempotent: true, async deliver(_event, contract) {
          const job = facade(contract);
          await worker.store.update(state => {
            for (const message of state.inbox || []) if (message.jobId === job.id) message.sourceIds = job.sourceIds;
            notify(state, { kind: job.status === 'complete' ? 'audio-result' : 'audio-failed', jobId: job.id,
              filename: job.filename, sourceIds: job.sourceIds, detail: job.stage });
          });
        } },
        { channel: 'session', idempotent: false, deliver(_event, contract) { worker.announceJob(facade(contract)); } },
        { channel: 'input-cleanup', idempotent: true, async deliver(_event, contract) { if (contract.status === 'complete') await binding.cleanup?.(); } },
      ] }).open(input);
    binding.persistence = port;
    return { ...port, waitForDelivery: true };
  } },
  async admit(context, input, binding) {
    const { worker, work, persistence } = binding;
    const record = await readAudioBatch(worker.store.root, input.singleId);
    const view = binding.view = { ...record.job, type: 'audio-import', singleId: input.singleId, warnings: [...(record.job.warnings || [])], language: worker.language };
    context.present(observed => {
      Object.assign(view, { id: observed.legacyId, status: observed.status, startedAt: observed.startedAt, finishedAt: observed.finishedAt,
        retryable: observed.status !== 'complete', sourceIds: observed.result.refs.filter(ref => ref.kind === 'source').map(ref => ref.id) });
      if (observed.status === 'complete') { view.phase = 'done'; view.stage = view.reused ? '这段内容已按同样设置处理过，直接复用'
        : `已存为 ${view.sourceIds.length} 份资料${view.corrected === undefined ? '' : `，校对修正 ${view.corrected} 处`}`; }
      else if (observed.status === 'cancelled') view.stage = '已取消；已完成的部分会保留，再来一次会接着做';
      else if (observed.error) view.stage = observed.error.message;
      const projected = jobContract(view);
      return { title: projected.title, stage: projected.stage, progress: projected.progress, detail: projected.detail,
        legacy: Object.fromEntries(fields.filter(key => view[key] !== undefined).map(key => [key, view[key]])), events: projected.events };
    });
    binding.settings = await worker.audioSettings();
    const saved = await persistence.store.load();
    const checkpoint = saved?.checkpoint;
    binding.preparedCheckpoint = checkpoint?.stepKey === 'publish:1' ? checkpoint : null;
    binding.pipeline = await persistence.createPipelineCache(binding.settings, checkpoint && !binding.preparedCheckpoint ? checkpoint : null);
    Object.assign(binding.settings, binding.pipeline.settings);
    const gate = work.audioGate; gate.limit = binding.settings.transcribeConcurrency; pumpSlots(gate);
    let start, finish, release;
    const admitted = new Promise(resolve => { start = resolve; }), held = new Promise(resolve => { finish = resolve; });
    const signal = AbortSignal.any([context.signal, context.pauseSignal]);
    const drained = admitSlot(gate, context.attemptId, signal, free => { release = free; start(); return held; });
    const lease = { release: () => release?.(), async finish() { finish(); await drained; } };
    await admitted;
    try {
      context.signal.throwIfAborted();
      if (context.pauseRequested) await context.saveCheckpoint(await binding.pipeline.checkpoint('queued', binding.pipeline.controls));
      return lease;
    } catch (error) { await lease.finish(); throw error; }
  },
  async run(context, input, binding) {
    const { worker, work, view, persistence, pipeline, settings } = binding;
    const pauseBoundary = async phase => { if (context.pauseRequested) await context.saveCheckpoint(await pipeline.checkpoint(phase, binding.controlValues || pipeline.controls)); };
    let prepared;
    if (binding.preparedCheckpoint) prepared = await persistence.readPreparedArtifacts('publish:1');
    else {
      const controls = { outputs: work.jobOutputs,
        setTranscribeLimit(limit) { work.audioGate.limit = limit; pumpSlots(work.audioGate); },
        register(_job, control) {
          if (Object.keys(pipeline.controls).length) control.patch(pipeline.controls);
          const rememberControls = () => { binding.controlValues = Object.fromEntries(Object.entries(control.values).filter(([key]) => key !== 'paused')); };
          rememberControls();
          context.controls({
          settings: () => Object.entries(control.spec).filter(([key]) => key !== 'paused').map(([key, rule]) => ({ key, ...rule, value: control.values[key] })),
          patch: patch => { const result = control.patch(patch); rememberControls(); return result; }, close: () => { control.close(); work.jobOutputs.endJob(view.id); },
        }); },
      };
      const result = await executeAudioJob({ job: view, args: input, settings, store: worker.audioStore, complete: worker.complete, fetch: worker.fetch,
        signal: context.signal, publish: false, releaseSlot: context.admission.release, controls, resources: context.resources, gateway: context.gateway,
        managed: { cache: pipeline.cache, keySettings: pipeline.settings, milestones: true, pauseRequested: () => context.pauseRequested, pauseBoundary } });
      await pauseBoundary('publish');
      const key = textKey({ settings: pipeline.settings, subject: String(input.subject || '').trim(), vocabulary: input.vocabulary || [] });
      const ids = result.documents.map((_, index) => audioSourceId(result.meta.hash || input.inputHash, key, index));
      let sources;
      await storeDocuments({ store: { publishSources: value => { sources = value; } }, ids, documents: result.documents,
        title: String(input.title || '').trim() || view.filename, meta: result.meta, corrections: result.corrections, courses: input.courses, language: view.language });
      prepared = await persistence.prepareArtifacts('publish:1', sources);
      await context.saveCheckpoint(prepared.checkpoint);
    }
    const committed = await context.commitArtifact('publish:1', async () => prepared, { publish: persistence.publishArtifacts });
    return { refs: committed.refs, completeness: 'complete' };
  },
};

export async function startManagedSingle(service, record, { retry = false, cleanup } = {}) {
  const binding = service.runtimeBinding(); binding.cleanup = cleanup;
  const jobs = service.runtimeJobs;
  if (record.runtimeJob) {
    const restored = await jobs.restore('audio-import', { singleId: record.id }, binding);
    if (!retry) return receipt(restored);
    return receipt(await jobs.recover(restored.jobId, 'retry'));
  }
  return receipt(await jobs.submit('audio-import', { singleId: record.id }, {}, binding));
}
