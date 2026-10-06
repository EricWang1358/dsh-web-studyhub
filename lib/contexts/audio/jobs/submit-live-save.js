import { AUDIO_TEXT } from '../../../audio-messages.js';
import { startTextJob } from './submit-text.js';

export const LIVE_SAVE_KIND = 'audio-live-save';

/** Start the proofread save of a live class on the runtime; one class is not saved twice at once. The class itself is handed over, not copied. */
export const startLiveSave = (service, { session, paidOnly }, running) =>
  startTextJob(service, { kind: LIVE_SAVE_KIND, input: { sessionId: session.id, paidOnly: paidOnly === true }, key: session.id, busy: AUDIO_TEXT.liveSaveRunning,
    gated: true, bindings: { session } }, running);
