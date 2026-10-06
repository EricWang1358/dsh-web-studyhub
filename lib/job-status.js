/* Job statuses and job types, as the host reports them. Pure data and predicates: the panel and the host import the
   same module, so adding a status ("paused") is one edit here and not a hunt through every page. */

export const JOB_STATUS = Object.freeze({
  QUEUED: 'queued', RUNNING: 'running', CANCELLING: 'cancelling', CANCELLED: 'cancelled',
  COMPLETE: 'complete', FAILED: 'failed', INTERRUPTED: 'interrupted',
});

/** The `type` of a background job. */
export const JOB_TYPES = Object.freeze({
  AUDIO_IMPORT: 'audio-import', AUDIO_BATCH: 'audio-batch', AUDIO_SUBTITLES: 'audio-subtitles', AUDIO_REVIEW: 'audio-review', AUDIO_LIVE_SAVE: 'audio-live-save', PDF_CONVERT: 'pdf-convert', TRANSLATION: 'translation',
  SUPPLEMENT: 'supplement', DRAFT_REPAIR: 'draft-repair', DRAFT_PUBLISH: 'draft-publish',
  // One day of 为你定制 (lib/coach-daily.js): a record the 任务 console lists, never a job the rest of the app waits for or draws a card for.
  COACH_DAILY: 'coach-daily',
});

/** The audio family: kinds that share the audio page's card and the console's audio section. A new audio kind is one entry here. */
export const AUDIO_JOB_TYPES = Object.freeze([JOB_TYPES.AUDIO_IMPORT, JOB_TYPES.AUDIO_BATCH, JOB_TYPES.AUDIO_SUBTITLES, JOB_TYPES.AUDIO_REVIEW, JOB_TYPES.AUDIO_LIVE_SAVE]);
export const isAudioJob = (job) => AUDIO_JOB_TYPES.includes(job?.type);

const ACTIVE = new Set([JOB_STATUS.QUEUED, JOB_STATUS.RUNNING, JOB_STATUS.CANCELLING]);
const CANCELLABLE = new Set([JOB_STATUS.QUEUED, JOB_STATUS.RUNNING]);

/** Still moving: waiting, working, or stopping. */
export const isActiveJob = (job) => ACTIVE.has(job?.status) && job?.type !== JOB_TYPES.COACH_DAILY;

/** A job that is one part of another row of the 任务 console (a batch of 为你定制 belongs to its day) names that row in `listedIn`: it is no row, archive record or count of its own. */
export const isOwnRow = (job) => !job?.listedIn;
/** How many finished parts of other rows the job table keeps per library (the day of 为你定制 keeps its batches itself). */
export const PART_JOBS_KEPT = 20;

/** A stop request still means something: not already stopping, not finished. */
export const isCancellable = (job) => CANCELLABLE.has(job?.status) && job?.type !== JOB_TYPES.COACH_DAILY;
