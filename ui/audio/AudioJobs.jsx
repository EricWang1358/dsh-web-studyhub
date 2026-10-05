import React from "react";
import { ui } from "../i18n.js";
import CompactJobCard from "../tasks/CompactJobCard.jsx";
export { parallelNote, reuseNote } from "./audio-notes.js";
export { reasoningNote } from "../EffortSelect.jsx";
import { isActiveJob, JOB_TYPES } from "../../lib/job-status.js";

/* The background audio imports on the pages that start them (the add-source form, the sources page, the reader): each one is the compact job card, and
   everything more (every file, the parallel timeline, the live output, the log, the controls) is in the 任务 console, which 「查看详情」 opens with the
   job selected. What stays here are the real-progress estimate and the one button the page itself can answer (the transcript, the original recording,
   the audio settings); the plain-words notes both share are in ./audio-notes.js. */

const isActive = isActiveJob;
/** A failure that the audio settings can fix: offer the way there. */
export const aboutSettings = (message) => /设置|密钥|Settings|API key|\bkey\b/i.test(String(message || ""));


/** The work in the order it happens, and how much of the whole each part usually is. */
const ORDER = ["transcribe", "proofread", "translate"];
const WEIGHT = { transcribe: 0.25, proofread: 0.3, translate: 0.45 };

/** Whether proofreading or translation actually ran for this job (or any member of a batch). */
export function textStepsRan(job = {}) {
  if (["proofread", "translate"].some((phase) => job.steps?.[phase]?.done > 0)) return true;
  if ((job.tasks || []).some((task) => ["proofread", "translate"].includes(task.kind) && task.status === "complete")) return true;
  return (job.members || []).some((member) => textStepsRan(member));
}

/**
 * Overall progress from the real step counts: each phase counts for its share of the work, and inside a phase it is
 * the segments finished out of the segments there are. `flight` is the share of the segment now being worked on,
 * which is shown as moving because no one can say how far along a single request is. `eta` is what is left of the
 * current phase at the pace of its finished segments (null until one has taken real time).
 */
export function audioProgress(job, now = Date.now()) {
  if (job.status === "complete") return { percent: 100, flight: 0, eta: null };
  // A review is one step: batches decided out of batches there are.
  if (job.review) return { percent: job.total > 0 ? Math.min(99, Math.floor(job.done / job.total * 100)) : 0,
    flight: isActive(job) && job.total > 0 ? Math.min(100 / job.total, 99) : 0, eta: null };
  if (job.members?.length) {
    const values = job.members.map(member => audioProgress(member, now));
    return { percent: Math.min(99, Math.floor(values.reduce((sum, value) => sum + value.percent, 0) / values.length)),
      flight: isActive(job) ? values.reduce((sum, value) => sum + value.flight, 0) / values.length : 0, eta: null };
  }
  const steps = job.steps || {}, reached = ORDER.indexOf(job.phase);
  let solid = 0;
  ORDER.forEach((phase, index) => {
    const step = steps[phase];
    solid += WEIGHT[phase] * (step?.total > 0 ? step.done / step.total : step || index < reached ? 1 : 0);
  });
  const percent = Math.min(99, Math.floor(solid * 100 + 1e-9));
  const step = steps[job.phase];
  if (!isActive(job) || !ORDER.includes(job.phase) || !(step?.total > 0) || step.done >= step.total) return { percent, flight: 0, eta: null };
  const pace = job.pace?.[job.phase], left = step.total - step.done;
  const eta = pace?.each ? Math.max(pace.each * 0.1, pace.each - Math.max(0, now - pace.at)) + pace.each * (left - 1) : null;
  return { percent, flight: Math.max(0, Math.min(WEIGHT[job.phase] / step.total * 100, 99 - percent)), eta };
}

/** What the card's one button does when this page knows better than the console: open the transcript, pick the recording again, or the audio settings. */
function primaryOf(job, { onOpenSources, onLegacyRetry, onOpenSettings }) {
  if (job.legacy && onLegacyRetry) return { label: ui("重新选择原录音继续"), run: () => onLegacyRetry(job) };
  if (job.status === "failed" && onOpenSettings && aboutSettings(job.stage)) return { label: ui("打开音频设置"), run: onOpenSettings };
  if (job.status === "complete" && job.sourceIds?.length > 0 && onOpenSources) return { label: ui("打开逐字稿"), run: () => onOpenSources(job.sourceIds) };
  return undefined;
}

/** Progress and results of audio imports; shown in the add-source form and at the top of the sources page. */
export function AudioJobs({ data, busy, act, onOpenSources, onLegacyRetry, onOpenSettings }) {
  const jobs = (data.jobs || []).filter((job) => job.type === JOB_TYPES.AUDIO_IMPORT);
  return jobs.length ? <div className="cjc-list audio-jobs">{jobs.map((job) => <CompactJobCard key={job.id} job={job}
    onStop={act ? () => act("job.control", { jobId: job.batchId || job.id, action: "cancel" }) : undefined}
    primary={primaryOf(job, { onOpenSources, onLegacyRetry, onOpenSettings })} />)}</div> : null;
}
