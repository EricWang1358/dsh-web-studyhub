import { isActiveJob } from './job-status.js';

/* Overall progress of an audio import from the real step counts. The one place: the audio card and the 任务 console both read it.
   The work in the order it happens, and how much of the whole each part usually is. */
export const AUDIO_ORDER = ['transcribe', 'proofread', 'translate'];
const ORDER = AUDIO_ORDER;
export const AUDIO_WEIGHT = { transcribe: 0.25, proofread: 0.3, translate: 0.45 };
const WEIGHT = AUDIO_WEIGHT;

/**
 * Overall progress from the real step counts: each phase counts for its share of the work, and inside a phase it is
 * the segments finished out of the segments there are. `flight` is the share of the segment now being worked on,
 * which is shown as moving because no one can say how far along a single request is. `eta` is what is left of the
 * current phase at the pace of its finished segments (null until one has taken real time).
 */
export function audioProgress(job, now = Date.now()) {
  if (job.status === 'complete') return { percent: 100, flight: 0, eta: null };
  // A review is one step: batches decided out of batches there are.
  if (job.review) return { percent: job.total > 0 ? Math.min(99, Math.floor(job.done / job.total * 100)) : 0,
    flight: isActiveJob(job) && job.total > 0 ? Math.min(100 / job.total, 99) : 0, eta: null };
  if (job.members?.length) {
    const values = job.members.map(member => audioProgress(member, now));
    return { percent: Math.min(99, Math.floor(values.reduce((sum, value) => sum + value.percent, 0) / values.length)),
      flight: isActiveJob(job) ? values.reduce((sum, value) => sum + value.flight, 0) / values.length : 0, eta: null };
  }
  const steps = job.steps || {}, reached = ORDER.indexOf(job.phase);
  let solid = 0;
  ORDER.forEach((phase, index) => {
    const step = steps[phase];
    solid += WEIGHT[phase] * (step?.total > 0 ? step.done / step.total : step || index < reached ? 1 : 0);
  });
  const percent = Math.min(99, Math.floor(solid * 100 + 1e-9));
  const step = steps[job.phase];
  if (!isActiveJob(job) || !ORDER.includes(job.phase) || !(step?.total > 0) || step.done >= step.total) return { percent, flight: 0, eta: null };
  const pace = job.pace?.[job.phase], left = step.total - step.done;
  const eta = pace?.each ? Math.max(pace.each * 0.1, pace.each - Math.max(0, now - pace.at)) + pace.each * (left - 1) : null;
  return { percent, flight: Math.max(0, Math.min(WEIGHT[job.phase] / step.total * 100, 99 - percent)), eta };
}
