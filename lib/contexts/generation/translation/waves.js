import { TRANSLATION_LIMITS } from '../../../passage-translation.js';
import { TRANSLATION_COOLING_MS, TRANSLATION_COOLING_TRIES } from './settings.js';

const iso = () => new Date().toISOString();
const errorText = error => error?.message || String(error);
/** The model (or the provider in front of it) says it is busy: a reason to wait a moment, not a reason to give up. */
const busy = error => error?.status === 429 || error?.code === 429 || /\b429\b|rate.?limit|too many requests/i.test(error?.message || '');
const pause = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms), stop = () => { clearTimeout(timer); reject(signal.reason); };
  signal.addEventListener('abort', stop, { once: true });
});

/**
 * The waves of one translation job: as many paragraphs as `concurrency` batches carry, one wave at a time, each kept as it finishes (the job only schedules
 * and counts; what is translated, checked and kept is materials.translation.translate through `translate(slice, live, ask)`). One body for both executors: the
 * in-process one and the unified runtime's. `beforeWave(at)` may end the run at a wave boundary by throwing (a checkpoint pause is a Symbol, not a failure
 * and not an ending: nothing is reported, the run is taken up again from what is kept). With `cooling` (translations parallel to generation, which share the model's
 * rate limit) a wave the model answered with "busy" is asked again after a doubling wait, one batch at a time, instead of failing the job.
 */
export async function translateWaves({ job, control, controller, ask, todo, beforeWave, generationControllers, jobControls, finish, translate, cooling = false }) {
  let paused = false;
  const timer = setTimeout(() => {
    job.status = 'cancelling'; job.stage = 'Time budget reached; stopping workers';
    controller.abort(Object.assign(new Error('Translation reached its time budget; translated paragraphs are kept'), { code: 'GENERATION_BUDGET' }));
  }, job.totalTimeoutSeconds * 1000);
  job.status = 'running'; job.runStartedAt = iso();
  job.stage = `Writing translations ${job.done}/${job.total}`;
  try {
    for (let at = 0; at < todo.length;) {
      controller.signal.throwIfAborted();
      // A paused job starts no new wave; the wave in flight finishes. The next wave is sized by the concurrency in force when it starts.
      await control.waitIfPaused(controller.signal);
      await beforeWave?.(at);
      const live = control.values.concurrency, wave = live * TRANSLATION_LIMITS.batchItems;
      const slice = todo.slice(at, at + wave);
      at += wave;
      let result, cooled = 0;
      for (;;) {
        try { result = await translate(slice, cooled ? 1 : live, ask); break; }
        catch (error) {
          if (!cooling || !busy(error) || cooled >= TRANSLATION_COOLING_TRIES || controller.signal.aborted) throw error;
          job.stage = 'The model is busy; waiting before asking again';
          await pause(TRANSLATION_COOLING_MS * 2 ** cooled, controller.signal);
          cooled += 1;
        }
      }
      // What an earlier try of this wave kept is found as already translated by the next one.
      job.translated += result.counts.translated + (cooled ? result.counts.cached : 0); job.reused += result.counts.reused;
      job.rejected += result.counts.rejected + result.counts.unlocated;
      job.done += slice.length; job.savedCount = job.translated + job.reused;
      job.stage = `Writing translations ${job.done}/${job.total}`;
    }
    job.status = 'complete'; job.outcome = job.rejected ? 'partial' : 'translated';
    job.stage = job.rejected ? `Translated ${job.savedCount} of ${job.total} paragraphs; ${job.rejected} could not be translated` : `Translated ${job.total} paragraphs`;
  } catch (error) {
    if (typeof error === 'symbol') { paused = true; throw error; }
    const stopped = controller.signal.aborted;
    const budget = controller.signal.reason?.code === 'GENERATION_BUDGET' && !job.cancelRequestedAt;
    job.status = stopped && !budget ? 'cancelled' : 'failed';
    job.outcome = job.status === 'cancelled' ? 'cancelled' : budget ? 'budget' : 'failed';
    job.stage = stopped ? errorText(controller.signal.reason) : errorText(error);
  } finally {
    clearTimeout(timer);
    generationControllers.delete(job.id);
    jobControls?.delete(job.id); control.close();
    if (!paused) await finish(job);
  }
}
