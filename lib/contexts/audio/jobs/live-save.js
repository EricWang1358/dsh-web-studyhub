import { assertTextModel } from '../../../audio-job.js';
import { livePlan } from '../../../live-job.js';
import { liveSaveNotice } from '../../../audio-messages.js';
import { writeLetter } from './notifications.js';
import { holdTranscriptionSlot } from './slot.js';
import { audioFacade } from './view.js';
import { LIVE_SAVE_FIELDS, liveSaveView, presentLiveSave } from './live-save-view.js';
import { runLiveSave } from './live-save-run.js';

/**
 * "Proofread and save" of a live class as a job of the unified runtime. Like a transcription it waits for the host's transcription slot (the gate wait is
 * kept as it was); its input is the class held in memory (and in its snapshot file), so nothing is saved for a restart: saving the class again reuses
 * what was proofread and translated. It can be retried while the process lives; it cannot be paused or recovered. The class itself is not touched:
 * stopping the save never closes or rebuilds the class's connection.
 */
export const liveSaveDefinition = {
  kind: 'audio-live-save', version: 1, title: 'Class save', legacyFields: LIVE_SAVE_FIELDS,
  capabilities: { cancel: true, set: false, retry: true, pauseMode: 'unsupported', recoveryMode: 'none', executionModes: ['direct', 'subagent'] },
  notifications: [
    { channel: 'inbox', deliver: (_event, contract, { worker }) => writeLetter(worker, audioFacade(contract)) },
    { channel: 'session', deliver: (_event, contract, { worker }) => worker.notify?.(liveSaveNotice(audioFacade(contract), contract.detail.legacy?.language)) },
  ],

  async admit(context, input, { worker, work, session }) {
    const settings = await worker.audioSettings();
    assertTextModel(settings, worker.complete);
    const plan = livePlan({ session, settings }), view = liveSaveView(plan, { language: worker.language, settings });
    context.present(presentLiveSave(view));
    const lease = await holdTranscriptionSlot(context, work.audioGate);
    return { ...lease, state: { view, plan, settings, args: input } };
  },

  run: (context, _input, binding) => runLiveSave(context, binding),
};
