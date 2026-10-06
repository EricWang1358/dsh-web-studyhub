import { createSingleAudioPersistence } from '../../../audio-runtime-store.js';
import { readAudioBatch } from '../../../audio-batch.js';
import { executeAudioJob, storeDocuments } from '../../../audio-job.js';
import { audioSourceId, textKey } from '../../../audio-import.js';
import { assertImportSettings } from '../../../audio-settings.js';
import { admitSlot, pumpSlots } from '../../../jobs/scheduler.js';
import { SINGLE_FIELDS, presentSingle, singleView } from './single-view.js';
import { singleNotifications } from './single-notifications.js';

const PUBLISH_STEP = 'publish:1';

/** One recording through the shared audio pipeline. Attempt-local state lives on the
 * admission lease (`context.admission.state`); nothing is written onto the bindings. */
export const singleAudioDefinition = {
  kind: 'audio-import', version: 1, title: 'Audio import', legacyFields: SINGLE_FIELDS,
  capabilities: { cancel: true, retry: true, set: true, pauseMode: 'checkpoint', recoveryMode: 'resume-checkpoint', executionModes: ['direct', 'subagent'] },
  persistence: { async open(input, { worker, cleanup }) {
    const persistence = createSingleAudioPersistence(worker.store.root, { library: worker.audioStore, notifications: singleNotifications(worker, cleanup) });
    return { ...await persistence.open(input), waitForDelivery: true };
  } },

  async admit(context, input, { worker, work }) {
    const record = await readAudioBatch(worker.store.root, input.singleId);
    const view = singleView(record, { singleId: input.singleId, language: worker.language });
    context.present(presentSingle(view));
    // The same refusal as every other import path, with the settings as they are now.
    const settings = assertImportSettings(await worker.audioSettings(), { paidOnly: input.paidOnly === true, hostModel: !!worker.complete });
    const checkpoint = (await context.persistence.store.load())?.checkpoint;
    const preparedCheckpoint = checkpoint?.stepKey === PUBLISH_STEP ? checkpoint : null;
    const pipeline = await context.persistence.createPipelineCache(settings, checkpoint && !preparedCheckpoint ? checkpoint : null);
    Object.assign(settings, pipeline.settings);
    const lease = await holdTranscriptionSlot(context, work.audioGate, settings.transcribeConcurrency);
    const state = { view, settings, pipeline, preparedCheckpoint, controlValues: null };
    try {
      context.signal.throwIfAborted();
      if (context.pauseRequested) await context.saveCheckpoint(await pipeline.checkpoint('queued', pipeline.controls));
      return { ...lease, state };
    } catch (error) { await lease.finish(); throw error; }
  },

  async run(context, input, binding) {
    const { state } = context.admission, persistence = context.persistence;
    const pauseBoundary = async phase => {
      if (context.pauseRequested) await context.saveCheckpoint(await state.pipeline.checkpoint(phase, state.controlValues || state.pipeline.controls));
    };
    const prepared = state.preparedCheckpoint ? await persistence.readPreparedArtifacts(PUBLISH_STEP)
      : await transcribeAndPrepare(context, input, binding, state, pauseBoundary);
    const committed = await context.commitArtifact(PUBLISH_STEP, async () => prepared, { publish: persistence.publishArtifacts });
    return { refs: committed.refs, completeness: 'complete' };
  },
};

/** Wait for the host's transcription slot; the pipeline releases it early once audio is transcribed. */
async function holdTranscriptionSlot(context, gate, limit) {
  gate.limit = limit; pumpSlots(gate);
  let start, finish, release;
  const admitted = new Promise(resolve => { start = resolve; }), held = new Promise(resolve => { finish = resolve; });
  const signal = AbortSignal.any([context.signal, context.pauseSignal]);
  const drained = admitSlot(gate, context.attemptId, signal, free => { release = free; start(); return held; });
  await admitted;
  return { release: () => release?.(), async finish() { finish(); await drained; } };
}

/** The 任务 console controls of a running import, kept on the attempt state for checkpoints. */
function pipelineControls(context, work, state) {
  const { pipeline, view } = state;
  return { outputs: work.jobOutputs,
    setTranscribeLimit(limit) { work.audioGate.limit = limit; pumpSlots(work.audioGate); },
    register(_job, control) {
      if (Object.keys(pipeline.controls).length) control.patch(pipeline.controls);
      const remember = () => { state.controlValues = Object.fromEntries(Object.entries(control.values).filter(([key]) => key !== 'paused')); };
      remember();
      context.controls({
        settings: () => Object.entries(control.spec).filter(([key]) => key !== 'paused').map(([key, rule]) => ({ key, ...rule, value: control.values[key] })),
        patch: patch => { const result = control.patch(patch); remember(); return result; },
        close: () => { control.close(); work.jobOutputs.endJob(view.id); },
      });
    },
  };
}

async function transcribeAndPrepare(context, input, { worker, work }, state, pauseBoundary) {
  const { view, settings, pipeline } = state;
  const result = await executeAudioJob({ job: view, args: input, settings, store: worker.audioStore, complete: worker.complete, fetch: worker.fetch,
    signal: context.signal, publish: false, releaseSlot: context.admission.release, controls: pipelineControls(context, work, state),
    resources: context.resources, gateway: context.gateway,
    managed: { cache: pipeline.cache, keySettings: pipeline.settings, milestones: true, pauseRequested: () => context.pauseRequested, pauseBoundary } });
  await pauseBoundary('publish');
  const key = textKey({ settings: pipeline.settings, subject: String(input.subject || '').trim(), vocabulary: input.vocabulary || [] });
  const ids = result.documents.map((_, index) => audioSourceId(result.meta.hash || input.inputHash, key, index));
  let sources;
  await storeDocuments({ store: { publishSources: value => { sources = value; } }, ids, documents: result.documents,
    title: String(input.title || '').trim() || view.filename, meta: result.meta, corrections: result.corrections, courses: input.courses, language: view.language });
  const prepared = await context.persistence.prepareArtifacts(PUBLISH_STEP, sources);
  await context.saveCheckpoint(prepared.checkpoint);
  return prepared;
}
