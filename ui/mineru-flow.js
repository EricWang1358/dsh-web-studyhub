/* The pure side of the MinerU conversion entry (cloud and local): which route to lead with, how a PDF goes to the
   backend, and how long things take in words. No React, no DOM beyond a File's own methods, so it runs in tests. */

import { uploadInChunks } from './upload.js';
import { formatBytes } from './format.js';
import { JOB_TYPES } from '../lib/job-status.js';

const MB = 1024 * 1024;

/**
 * Hand a PDF to the backend in small pieces (the panel transport caps a request): start, chunks, finish. Nothing leaves the
 * computer here; the backend keeps the file in the DSH home until a conversion is started or the upload is cancelled.
 * onProgress(fraction 0..1); signal stops between pieces. Resolves the upload id.
 */
export const uploadPdf = (call, file, { onProgress, signal } = {}) => uploadInChunks(call, 'mineru', file, { onProgress: onProgress && ((fraction) => onProgress(fraction)), signal });

/** Whole minutes for a duration in seconds, at least 1 (an estimate is never shown as "0 minutes"). */
export const minutesOf = seconds => Math.max(1, Math.round(Number(seconds) / 60));

/** The local estimate for a book: seconds per page of the tier times its pages (measured once on one CPU laptop; always labelled an estimate). */
export function localEstimate(pages, tier, estimates = {}) {
  const per = Number(estimates[tier]);
  return Number.isFinite(per) && per > 0 ? Math.round(pages * per) : null;
}

/** A size given in megabytes, in the one size style (formatBytes): "800 MB", "1.2 GB"; '' when it is not a number. */
export function sizeLabel(megabytes) {
  const value = Number(megabytes);
  return Number.isFinite(value) ? formatBytes(value * MB) : '';
}

/** "1–50" for a piece of pages, "7" for a single page. */
export const pageRange = (start, end) => (start === end ? `${start}` : `${start}–${end}`);

/** Whether a conversion job is the kind the card draws. */
export const isConvertJob = job => job?.type === JOB_TYPES.PDF_CONVERT;

/* ---------- the conversion history (解析历史) ---------- */

/** How many rows the history shows at first; "显示更多" adds this many again. */
export const HISTORY_PAGE = 10;

const midnightOf = time => { const date = new Date(time); return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime(); };

/**
 * The rows of the history grouped by the day they started, newest day first and newest row first inside it.
 * Each group: { key, when: 'today' | 'yesterday' | 'date' | 'unknown', day (ms of that midnight, or null), rows }.
 */
export function groupHistoryByDay(records = [], now = Date.now()) {
  const sorted = [...records].sort((a, b) => (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0));
  const today = midnightOf(now), yesterday = midnightOf(today - 1), groups = [];
  for (const row of sorted) {
    const time = Date.parse(row.startedAt), day = Number.isFinite(time) ? midnightOf(time) : null, key = day === null ? 'unknown' : String(day);
    let group = groups.find(item => item.key === key);
    if (!group) { group = { key, when: day === null ? 'unknown' : day === today ? 'today' : day === yesterday ? 'yesterday' : 'date', day, rows: [] }; groups.push(group); }
    group.rows.push(row);
  }
  return groups;
}

/**
 * What makes the history worth asking the backend again: a conversion job appearing, or changing state (running, done, failed, stopped).
 * Page-by-page progress does not change it, so the list is read when something ends, not on every tick.
 */
export const historyRefreshKey = jobs => (Array.isArray(jobs) ? jobs : []).filter(isConvertJob).map(job => `${job.id}:${job.status}`).sort().join('|');

/** The phase codes the backend reports, in the order a conversion goes through them (the local route has just one). */
export const CLOUD_PHASES = Object.freeze(['split', 'upload', 'parse', 'download', 'merge', 'save']);
export const LOCAL_PHASES = Object.freeze(['local', 'merge', 'save']);
