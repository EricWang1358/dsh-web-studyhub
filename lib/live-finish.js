import { storeDocuments } from './audio-job.js';
import { AUDIO_TEXT, liveFinishFailed, liveNoTranslation, liveNotPolished } from './audio-messages.js';
import { mainlyChinese } from './live-correction-settings.js';
import { quickDocuments } from './live-save.js';
import { liveSourceId, storeLiveNotes } from './live-job.js';
import { importCourses } from './source-courses.js';

/* 「保存为资料」 of a class that has ended is never refused. The class is saved as the bilingual transcript and its class notes; when something is missing
   (sentences the context polish has not reached, translations that failed) one job of the task console finishes it first, each part bounded by the time it
   may take, and whatever cannot be finished is said in the job's result while the transcript is saved anyway. */

export const LIVE_FINISH = Object.freeze({
  /** The longest the polish of what is left may take, and the longest the missing translations may take. */
  polishMs: 240_000,
  translateMs: 90_000,
  pollMs: 300,
  /** How long to wait for a started pass to show as running (a driven correction wakes on its own loop). */
  startMs: 1500,
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const needsTranslation = segment => !!segment.en && ['pending', 'error'].includes(segment.zhState) && !mainlyChinese(segment.en);

/** What a save would still have to finish: sentences the polish has not reached (skipped ones keep their text and are not counted) and translations that failed. */
export function liveLeftToFinish(session, { model = true } = {}) {
  if (!model) return { polish: 0, translations: 0 };
  return { polish: session.correction.snapshot().pending, translations: session.segments.filter(needsTranslation).length };
}

/** Wait until `done()` holds, the time is up, or the job is stopped. True when it held. */
async function waitUntil(done, ms, signal, pollMs = LIVE_FINISH.pollMs) {
  const until = Date.now() + ms;
  while (!done()) {
    signal?.throwIfAborted();
    if (Date.now() >= until) return false;
    await sleep(pollMs);
  }
  return true;
}

/** The quick save: the class as a bilingual transcript, and its class notes (`complete` makes them from the transcript when the polish made none). */
export async function saveLiveQuick({ store, session, language, complete, signal }) {
  const segments = session.segments.filter(segment => segment.en);
  const documents = quickDocuments(session.title, segments, language), whole = documents.join('\n');
  const ids = documents.map((_, index) => liveSourceId(session, 'quick', whole, index));
  await storeDocuments({ store, ids, documents, title: session.title, courses: importCourses({ course: session.course }), corrections: { applied: [], skipped: [] }, language,
    meta: { live: true, sessionId: session.id, filename: session.title, seconds: Math.round(session.elapsedMs / 1000), titleEn: 'Live Class Transcript', partCount: documents.length, proofread: false } });
  const noteSourceId = await storeLiveNotes(store, session, language, { complete, signal });
  return { ids, noteSourceId, titleEn: 'Live Class Transcript', parts: documents.length };
}

/**
 * The job body: finish the polish through the correction path (`call('live.correct')`), finish the translations (`call('live.retry')`), then save. A step that
 * fails or runs out of time costs only itself: it becomes a warning of the job and the transcript is saved with what the class has.
 */
export async function executeLiveFinishSave({ job, session, call, store, language, complete, signal, limits = LIVE_FINISH }) {
  job.warnings ||= [];
  const snapshot = () => session.correction.snapshot();
  const left = liveLeftToFinish(session);
  if (left.polish) {
    job.stage = AUDIO_TEXT.liveFinishPolish; job.phase = 'polish';
    try {
      await call('live.correct', { id: session.id });
      await waitUntil(() => snapshot().running || snapshot().pending === 0, limits.startMs, signal, limits.pollMs);
      await waitUntil(() => !snapshot().running, limits.polishMs, signal, limits.pollMs);
    } catch (error) { signal.throwIfAborted(); job.warnings.push(liveFinishFailed(AUDIO_TEXT.liveFinishPolish, String(error.message || error).slice(0, 160))); }
    if (snapshot().pending) job.warnings.push(liveNotPolished(snapshot().pending));
  }
  if (left.translations) {
    job.stage = AUDIO_TEXT.liveFinishTranslate; job.phase = 'translate';
    try {
      await call('live.retry', { id: session.id });
      await waitUntil(() => !session.pendingSegments().length && !session.translating.running, limits.translateMs, signal, limits.pollMs);
    } catch (error) { signal.throwIfAborted(); job.warnings.push(liveFinishFailed(AUDIO_TEXT.liveFinishTranslate, String(error.message || error).slice(0, 160))); }
    const missing = session.segments.filter(needsTranslation).length;
    if (missing) job.warnings.push(liveNoTranslation(missing));
  }
  signal.throwIfAborted();
  job.stage = AUDIO_TEXT.liveFinishSave; job.phase = 'save';
  const saved = await saveLiveQuick({ store, session, language, complete, signal });
  if (!saved.noteSourceId) job.warnings.push(AUDIO_TEXT.liveNoNotes);
  Object.assign(job, { sourceIds: [...saved.ids, ...(saved.noteSourceId ? [saved.noteSourceId] : [])], titleEn: saved.titleEn, partCount: saved.parts,
    summary: job.warnings.length ? AUDIO_TEXT.liveFinishedPartly : AUDIO_TEXT.liveFinishedAll });
}
