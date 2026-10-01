/* Case practice on the page (WP12): highlights of the scenario, the phases of
   a timed case paper (reading → writing → transcription for paper practice),
   pacing per question, and the per-run draft kept in the browser. Pure apart
   from the guarded localStorage helpers, so it is tested without a DOM. */
import { HIGHLIGHT_COLORS, isBlank, paceStatus } from "../lib/case-study.js";

export { HIGHLIGHT_COLORS };

/* ---------- highlights ---------- */

const byStart = (a, b) => a.paragraph - b.paragraph || a.start - b.start;
/**
 * Add a highlight; it paints over the overlapped parts of earlier ones in the
 * same paragraph (they are trimmed or split), so marks never stack.
 */
export function addHighlight(list = [], next) {
  const kept = [];
  for (const item of list) {
    if (item.paragraph !== next.paragraph || item.end <= next.start || item.start >= next.end) { kept.push(item); continue; }
    if (item.start < next.start) kept.push({ ...item, end: next.start });
    if (item.end > next.end) kept.push({ ...item, id: `${item.id}~${next.end}`, start: next.end });
  }
  return [...kept, next].sort(byStart);
}
export const removeHighlight = (list = [], id) => list.filter((item) => item.id !== id);
export const recolorHighlight = (list = [], id, color) => list.map((item) => item.id === id ? { ...item, color } : item);
export const annotateHighlight = (list = [], id, note) => list.map((item) => {
  if (item.id !== id) return item;
  const { note: _old, ...rest } = item;
  return String(note || "").trim() ? { ...rest, note: String(note).trim().slice(0, 500) } : rest;
});

/** A paragraph cut into plain and highlighted pieces, in order. */
export function segmentParagraph(text = "", highlights = []) {
  const marks = highlights.filter((item) => item.start < text.length && item.end > item.start).sort((a, b) => a.start - b.start);
  const pieces = [];
  let at = 0;
  for (const mark of marks) {
    const start = Math.max(mark.start, at), end = Math.min(mark.end, text.length);
    if (end <= start) continue;
    if (start > at) pieces.push({ text: text.slice(at, start) });
    pieces.push({ text: text.slice(start, end), id: mark.id, color: mark.color, note: mark.note });
    at = end;
  }
  if (at < text.length) pieces.push({ text: text.slice(at) });
  return pieces;
}

/* ---------- a timed case paper ---------- */

/**
 * Where a paper stands. Reading locks the editors (highlighting stays on);
 * writing is timed; paper practice hides the editors while the time runs and
 * then opens a transcription phase that is not counted against the timer.
 * @param session { startedAt, readingMinutes, writingMinutes, handwriting, readingEndedAt?, writingEndedAt?, submittedAt? }
 */
export function paperPhase(session, now = Date.now()) {
  if (!session) return "writing";
  if (session.submittedAt) return "submitted";
  const start = Date.parse(session.startedAt);
  if (!Number.isFinite(start)) return "writing";
  const readingEnd = Number.isFinite(Date.parse(session.readingEndedAt)) ? Date.parse(session.readingEndedAt) : start + (session.readingMinutes || 0) * 60000;
  if (now < readingEnd) return "reading";
  const writingEnd = Number.isFinite(Date.parse(session.writingEndedAt)) ? Date.parse(session.writingEndedAt) : readingEnd + (session.writingMinutes || 0) * 60000;
  if (now < writingEnd) return "writing";
  return session.handwriting ? "transcribe" : "over";
}
/** Milliseconds left in the current timed phase (0 when untimed or over). */
export function phaseRemaining(session, now = Date.now()) {
  const phase = paperPhase(session, now), start = Date.parse(session?.startedAt);
  if (!Number.isFinite(start) || !["reading", "writing"].includes(phase)) return 0;
  const readingEnd = Number.isFinite(Date.parse(session.readingEndedAt)) ? Date.parse(session.readingEndedAt) : start + (session.readingMinutes || 0) * 60000;
  if (phase === "reading") return Math.max(0, readingEnd - now);
  const writingEnd = Number.isFinite(Date.parse(session.writingEndedAt)) ? Date.parse(session.writingEndedAt) : readingEnd + (session.writingMinutes || 0) * 60000;
  return Math.max(0, writingEnd - now);
}
/** Whether the learner can type answers in this phase. */
export const canType = (phase, handwriting) => phase === "transcribe" || (phase === "writing" && !handwriting);
/** Minutes of writing used so far (for live pacing). */
export function writingElapsedMs(session, now = Date.now()) {
  const start = Date.parse(session?.startedAt);
  if (!Number.isFinite(start)) return 0;
  const readingEnd = Number.isFinite(Date.parse(session.readingEndedAt)) ? Date.parse(session.readingEndedAt) : start + (session.readingMinutes || 0) * 60000;
  return Math.max(0, Math.min(now, readingEnd + (session.writingMinutes || 0) * 60000) - readingEnd);
}
/** Live pacing of a paper from the answers so far. */
export const livePace = (plan, session, answers = {}, now = Date.now()) =>
  paceStatus(plan, { elapsedMs: writingElapsedMs(session, now), answeredIds: Object.keys(answers).filter((id) => !isBlank(answers[id])) });
/** Time on each question: the active question collects the elapsed time of each tick. */
export function tickQuestion(perQuestion = {}, activeId, deltaMs) {
  if (!activeId || !(deltaMs > 0)) return perQuestion;
  return { ...perQuestion, [activeId]: Math.round((perQuestion[activeId] || 0) + Math.min(deltaMs, 5000)) };
}

/* ---------- the browser draft of one run ---------- */

const KEY = "study-case";
export const sessionKey = (root, runId) => `${KEY}:${root || ""}:${runId}`;
export function readSession(root, runId) {
  try { const value = JSON.parse(localStorage.getItem(sessionKey(root, runId)) || "null"); return value && typeof value === "object" ? value : null; }
  catch { return null; }
}
export function writeSession(root, runId, value) {
  try { if (value) localStorage.setItem(sessionKey(root, runId), JSON.stringify(value)); else localStorage.removeItem(sessionKey(root, runId)); return true; }
  catch { return false; }
}
