import { liveCorrectionModels } from './live-correction-models.js';
import { AUDIO_TEXT, correctionTitle } from '../../../audio-messages.js';

/** What the console shows of a class's correction: its title, how far through the class it has been, and its counters. */
const present = (session, title) => () => {
  const snapshot = session.correction.snapshot(), total = session.segments.length;
  return { title, stage: { code: 'task.running', text: AUDIO_TEXT.liveCorrecting },
    progress: { done: snapshot.covered, total, unit: null, percent: total ? Math.min(100, Math.round(snapshot.covered / total * 100)) : null, segments: [] },
    detail: { liveCorrection: { covered: snapshot.covered, pending: snapshot.pending, calls: snapshot.calls, cacheHits: snapshot.cacheHits, error: snapshot.error,
      background: { running: snapshot.background.running, pending: snapshot.background.pending, failed: snapshot.background.failed } } } };
};

/**
 * The context correction of one live class, as ONE job for as long as the class needs it: it runs the correction passes (a pass every thirty seconds
 * while the class is live, one more when it ends) and the background requests about older sentences on its own gateway, so every request is a call and
 * the class's correction has a total. The cursor, versions, memory and notes stay with the class (RollingCorrection); the class's connection is
 * never touched: stopping this job only stops correcting. Nothing is kept for a restart: a resumed class starts a new job.
 */
export const liveCorrectionDefinition = {
  kind: 'audio-live-correction', version: 1, title: 'Live class correction',
  capabilities: { cancel: true, set: false, retry: false, pauseMode: 'unsupported', recoveryMode: 'none', executionModes: ['direct', 'subagent'] },

  async admit(context, _input, { worker, session }) {
    const settings = await worker.audioSettings();
    context.present(present(session, correctionTitle(session.title)));
    // Whatever ends this attempt, the class is free to be driven again.
    return { finish: () => session.correction.release(), state: { settings } };
  },

  async run(context, _input, binding) {
    const { session } = binding, { settings } = context.admission.state;
    const models = liveCorrectionModels(context, binding, { settings, session });
    await session.correction.serve({ correct: models.correct, signal: context.signal });
    return { refs: [], completeness: 'complete' };
  },
};
