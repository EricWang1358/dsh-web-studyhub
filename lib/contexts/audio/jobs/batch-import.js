import { ASSEMBLE_STEP, createBatchAudioPersistence } from '../../../audio-batch-runtime-store.js';
import { assembleBatch, batchUsage, holdForBlockedMember } from '../../../audio-batch-members.js';
import { poolHooks, storeDocuments } from '../../../audio-job.js';
import { TEXT_CONCURRENCY, clampCount, createPool } from '../../../audio-pool.js';
import { audioControl } from '../../../job-control.js';
import { AUDIO_TEXT } from '../../../audio-messages.js';
import { assertImportSettings } from '../../../audio-settings.js';
import { BATCH_FIELDS, batchView, presentBatch } from './batch-view.js';
import { runBatchMember } from './batch-member.js';
import { audioNotifications } from './notifications.js';
import { applyTranscribeLimit, consoleControls } from './controls.js';

/** A batch of recordings assembled into one combined transcript. Attempt-local state lives on the admission lease; the files take the host's
 * transcription slot one at a time, and a pause ends the attempt at a file boundary (finished files are committed, the rest wait). */
export const batchAudioDefinition = {
  kind: 'audio-batch', version: 1, title: 'Audio batch', legacyFields: BATCH_FIELDS,
  capabilities: { cancel: true, retry: true, set: true, pauseMode: 'checkpoint', recoveryMode: 'resume-checkpoint', executionModes: ['direct', 'subagent'] },
  persistence: { async open(input, { worker, cleanup }) {
    const persistence = createBatchAudioPersistence(worker.store.root, { library: worker.audioStore, notifications: audioNotifications(worker, cleanup) });
    return { ...await persistence.open(input), waitForDelivery: true };
  } },

  async admit(context, input, { worker, work }) {
    const persistence = context.persistence, record = await persistence.loadBatch();
    // The same refusal as every other import path, with the settings as they are now.
    const settings = assertImportSettings(await worker.audioSettings(), { paidOnly: input.paidOnly === true, hostModel: !!worker.complete });
    const checkpoint = (await persistence.store.load())?.checkpoint;
    const prepared = checkpoint?.stepKey === ASSEMBLE_STEP ? checkpoint : null;
    const checkpointer = await persistence.createCheckpointer(settings, checkpoint && !prepared ? checkpoint : null);
    Object.assign(settings, checkpointer.settings);
    const view = batchView(record, { language: worker.language, settings });
    context.present(presentBatch(view, record));
    applyTranscribeLimit(work.audioGate, settings.transcribeConcurrency);
    const state = { record, view, settings, checkpointer, prepared, results: Array(record.members.length), controlValues: null };
    if (context.pauseRequested) await context.saveCheckpoint(await checkpointer.save('queued', checkpointer.controls));
    return { state };
  },

  async run(context, _input, binding) {
    const { state } = context.admission, persistence = context.persistence;
    const prepared = state.prepared ? await persistence.readPreparedArtifacts(ASSEMBLE_STEP) : await runMembers(context, state, binding);
    const committed = await context.commitArtifact(ASSEMBLE_STEP, async () => prepared, { publish: persistence.publishArtifacts });
    return { refs: committed.refs, completeness: 'complete' };
  },
};

async function runMembers(context, state, binding) {
  const { record, view, settings, checkpointer } = state, { work } = binding;
  if (!record.members.some(member => !member.skipped)) throw new Error(AUDIO_TEXT.allSkipped);
  view.phase = 'batch';
  await holdForBlockedMember({ batch: record, view, settings, save: () => context.persistence.saveMembers(record) });
  // One text pool for the whole batch: the files overlap (file N+1 is transcribed while file N is proofread), but the DSH model is asked
  // for no more than the learner's text concurrency at any moment.
  state.pools = { text: createPool({ limit: clampCount(settings.textConcurrency, TEXT_CONCURRENCY), ...poolHooks(view) }) };
  view.parallel = { ...view.parallel, text: state.pools.text.state, transcribe: { limit: settings.transcribeConcurrency } };
  // The batch is adjusted as one: the text pool every file shares, the transcription gate, the reasoning of the steps still to come.
  const controls = consoleControls(context, work, { view, saved: checkpointer.controls, remember: values => { state.controlValues = values; } });
  controls.register(view, audioControl({ job: view, settings, pools: state.pools, setTranscribeLimit: controls.setTranscribeLimit }));
  const outcomes = await Promise.allSettled(record.members.map((_member, index) => runBatchMember(context, state, binding, index)));
  context.signal.throwIfAborted();
  const failed = outcomes.find(outcome => outcome.status === 'rejected');
  if (failed) throw failed.reason;
  // A pause ends the attempt here, with every started file committed.
  if (context.pauseRequested) await context.saveCheckpoint(await checkpointer.save('members', state.controlValues || checkpointer.controls));
  return prepareAssembly(context, state);
}

/** The combined sources, prepared and saved as the checkpoint of the one publish step. */
async function prepareAssembly(context, state) {
  const { record, view, results } = state, included = record.members.filter(member => !member.skipped);
  view.phase = 'assemble';
  const assembly = assembleBatch(record, included, results.filter(Boolean));
  let sources;
  await storeDocuments({ store: { publishSources: value => { sources = value; } }, ids: assembly.ids, documents: assembly.documents, title: record.title,
    corrections: assembly.corrections, courses: record.args.courses, language: view.language,
    meta: { course: record.args.course, usage: batchUsage(record, view.members).usage, batch: { id: record.id, title: record.title, members: assembly.members } } });
  Object.assign(view, { corrected: assembly.corrections.applied.length, uncertain: assembly.uncertain });
  const prepared = await context.persistence.prepareArtifacts(ASSEMBLE_STEP, sources);
  await context.saveCheckpoint(prepared.checkpoint);
  return prepared;
}
