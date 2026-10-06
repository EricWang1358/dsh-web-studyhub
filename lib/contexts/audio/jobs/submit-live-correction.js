import { audioRefusal } from '../../../audio-messages.js';

export const LIVE_CORRECTION_KIND = 'audio-live-correction';

/**
 * Put the correction of a live class under its Job (one at a time: a class already driven is left alone). The class itself is handed over, not copied.
 * A refusal comes back in the learner's words and leaves the class free to be driven again.
 */
export async function startLiveCorrection(service, session) {
  if (!session.correction.claim()) return;
  try { await service.runtimeJobs.submit(LIVE_CORRECTION_KIND, { sessionId: session.id }, {}, { ...service.runtimeBinding(), session }); }
  catch (error) { session.correction.release(); throw audioRefusal(error); }
}
