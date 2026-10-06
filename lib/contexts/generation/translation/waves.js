import { TRANSLATION_LIMITS } from '../../../passage-translation.js';

const iso = () => new Date().toISOString();
const errorText = error => error?.message || String(error);

/**
 * The waves of one translation job: as many paragraphs as `concurrency` batches carry, one wave at a time, each kept as it finishes (the job only schedules
 * and counts; what is translated, checked and kept is materials.translation.translate through `translate(slice, live, ask)`). One body for both executors: the
 * in-process one and the unified runtime's. `beforeWave(at)` may end the run at a wave boundary by throwing (a checkpoint pause is a Symbol, not a failure
 * and not an ending: nothing is reported, the run is taken up again from what is kept).
 */
export async function translateWaves({ job, control, controller, ask, todo, beforeWave, generationControllers, jobControls, finish, translate }) {
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
      const result = await translate(slice, live, ask);
      job.translated += result.counts.translated; job.reused += result.counts.reused;
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
