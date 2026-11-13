import { randomUUID } from 'node:crypto';
import { ASSIST } from './settings.js';
import { MAX_WAIT_SECONDS } from '../../runtime/web-gemini-settings.js';

/* A question whose answer is being graded in the background (#1031). The op that starts a grade job writes `entry.grading = { taskId, since, boot }`
   on the run entry; the commit of the grade (lib/rubric-grading.js) or the job's failure removes it. While it is live the question counts as answered,
   pending: 先跳过, 下一题 and the round's count do not send the learner back to it, and nothing else may grade it (review.answer, review.reveal, a second
   grade job). A marker is live only in the process that wrote it (`boot`) and for at most STALE_MS: after a restart the job is gone, so its marker
   is ignored and the next write to the entry drops it; the question is simply waiting again. */

/** This process. A marker written by another process (a restart) names a job that no longer runs. */
export const PROCESS_BOOT = randomUUID();
/** Strictly longer than any grade job may run: lib/assist.js stops a job after ASSIST.timeoutMs, or after the web model's wait when that is longer
    (at most MAX_WAIT_SECONDS), and the commit gets five more minutes. A marker this old belongs to a job that can no longer finish. */
export const GRADING_STALE_MS = Math.max(ASSIST.timeoutMs, MAX_WAIT_SECONDS * 1000) + 5 * 60 * 1000;

/** Is a grade job of this process still working on the entry? */
export function gradingPending(entry, now = Date.now()) {
  const marker = entry?.grading;
  if (!marker || typeof marker !== 'object' || marker.boot !== PROCESS_BOOT) return false;
  const since = Date.parse(marker.since);
  return Number.isFinite(since) && now - since < GRADING_STALE_MS;
}

/** The message every refused write says while a grade job holds the question. */
export const GRADING_BUSY = '这道题正在批改，等结果出来再作答';

/** Refuse a write that would grade the entry a second time while its job runs; drop a marker that is no longer live. */
export function assertNotGrading(entry) {
  if (gradingPending(entry)) throw new Error(GRADING_BUSY);
  if (entry?.grading) delete entry.grading;
}

/** Mark the entry as being graded by `taskId`. Refused while another live job holds it. */
export function claimGrading(entry, taskId, now = Date.now()) {
  if (gradingPending(entry, now) && entry.grading.taskId !== taskId) throw new Error(GRADING_BUSY);
  entry.grading = { taskId, since: new Date(now).toISOString(), boot: PROCESS_BOOT };
}

/** The place in the run of the entry the grade job `taskId` holds, or -1. The job finds its question by its own marker, never by the place it had
    when the job started: a round edited meanwhile (review.queue.edit, review.skip) moves the question. */
export const gradingIndexOf = (run, taskId) => (typeof taskId === 'string' && taskId ? (run?.entries || []).findIndex((entry) => entry?.grading?.taskId === taskId) : -1);

/** The job `taskId` ended without a grade (or any job when taskId is omitted): the question is waiting again. True when a marker was removed. */
export function releaseGrading(entry, taskId) {
  if (!entry?.grading || (taskId !== undefined && entry.grading.taskId !== taskId)) return false;
  delete entry.grading;
  return true;
}
