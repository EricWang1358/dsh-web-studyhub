import { get } from '../../util.js';
import { findCard } from '../../prereq.js';
import { initialReview, optionOrder, schedule } from '../../domain.js';
import { cardScheduleSettings } from '../../card-schedule.js';
import { cardLevel } from '../../mastery.js';
import { projection } from '../../study-state.js';
import { settlePrerequisiteCredit } from '../../rubric-grading.js';
import { claimGrading, gradingIndexOf, releaseGrading } from './grading-marker.js';

/* What happens around a background grade of a practice answer (#1031): the marker while the job runs, the correction a learner reads before a missed
   question comes back, and the one manual change of an AI grade. The grade itself is stored by lib/rubric-grading.js commitRubricGrade. */

/**
 * One extra recall attempt per card at the tail of this run: practice after feedback, not a second spaced-repetition interval. The one place that
 * queues it, for a wrong answer (review.answer) and for a miss read after the learner had left the question (review.correction.ack).
 */
export function queueTailRetry(run, entry, live, deckId) {
  if (entry.retry || run.entries.some((e) => e.retry && e.card.id === entry.card.id && (e.deckId ?? run.deckId) === deckId)) return false;
  run.entries.push({
    deckId,
    card: structuredClone(live),
    // Reshuffle so the retry tests recall, not the remembered position.
    order: entry.order ? optionOrder(live) : undefined,
    startedAt: Date.now(),
    feedback: null,
    revealed: false,
    selected: null,
    retry: true,
  });
  entry.feedback.retryQueued = true;
  return true;
}

/** The entry an op names by its place in the run, checked against the card the page showed. */
function namedEntry(run, a) {
  const entry = Number.isInteger(a.entryIndex) ? run.entries[a.entryIndex] : null;
  if (!entry || entry.card.id !== a.cardId) throw new Error('Question changed; refresh review');
  return entry;
}

const liveCardOf = (s, deckId, entry) => {
  try { return findCard(s, { deckId, cardId: entry.card.id }); } catch { return null; }
};

export const gradingMutations = {
  /* The grade job's own marker (lib/assist.js writes it when the job starts and removes it when the job fails; the commit removes it on success).
     Panel-internal: never the assistant's (lib/assistant-boundary.js). */
  'review.grading': (s, a) => {
    const run = get(s.runs, a.runId, 'Review');
    if (typeof a.taskId !== 'string' || !a.taskId) throw new Error('taskId is required');
    // The job's own marker, wherever its question is now; also once the round has ended (the job may outlive it).
    if (a.release === true) {
      const at = gradingIndexOf(run, a.taskId);
      if (at < 0 || !releaseGrading(run.entries[at], a.taskId)) throw Object.assign(new Error('Nothing to release'), { noWrite: { released: false } });
      return { released: true };
    }
    // An exam is graded after submission, a closed round is over: nothing to hold.
    if (run.mode === 'exam' || run.closedAt) throw Object.assign(new Error('No grading marker for this run'), { noWrite: { marked: false } });
    const entry = namedEntry(run, a);
    if (entry.feedback) throw new Error('这道题已经有结果了');
    claimGrading(entry, a.taskId);
    return { marked: true };
  },
  /* 我看懂了 · 加入重练: a miss whose grade landed after the learner had left the question waits for this before its tail retry is queued. */
  'review.correction.ack': (s, a) => {
    const run = get(s.runs, a.runId, 'Review');
    if (run.mode === 'exam') throw new Error('模拟考没有订正重练');
    const entry = namedEntry(run, a);
    if (!entry.feedback?.correctionPending) throw new Error('这道题没有待看的订正');
    const deckId = entry.deckId ?? run.deckId;
    entry.feedback.correctionPending = false;
    entry.feedback.correctionSeenAt = new Date().toISOString();
    if (!run.closedAt) queueTailRetry(run, entry, liveCardOf(s, deckId, entry)?.card ?? entry.card, deckId);
    return projection(s, run);
  },
  /* The learner's one change of an AI grade: only an AI-marked answer (a rubric, made or derived), never a retry, a self-grade or an exam, and only
     while the round is open. The grade the AI gave stays next to the new one (gradeOriginal), the schedule is made again from the review the
     question had before this answer, and prerequisite credit follows the new grade through the same helper the commit uses. */
  'review.grade.adjust': (s, a) => {
    if (!Number.isInteger(a.grade) || a.grade < 0 || a.grade > 5) throw new Error('评分必须是 0 到 5 的整数');
    const run = get(s.runs, a.runId, 'Review');
    if (run.mode === 'exam') throw new Error('模拟考成绩不能手动改分');
    if (run.closedAt) throw new Error('这一轮已经结束，不能再改分');
    const entry = namedEntry(run, a);
    const feedback = entry.feedback;
    if (entry.retry || !feedback?.rubric || feedback.taskCheck) throw new Error('只有 AI 批改的答案可以改分');
    const deckId = entry.deckId ?? run.deckId;
    const found = liveCardOf(s, deckId, entry);
    if (!found) throw new Error('这道题已不在题组里');
    const { deck, card: live } = found;
    const timestamp = new Date().toISOString();
    const stale = !!feedback.updatedAfterOpening;
    const before = structuredClone(entry.reviewBefore ?? null) ?? initialReview(s.settings);
    const after = stale ? before : schedule(before, a.grade, timestamp, cardScheduleSettings(s, deck, live).settings);
    if (!stale) live.review = after;
    const attempt = s.attempts.findLast((item) => item.runId === run.id && item.quiz_id === live.id && item.assessment === 'rubric' && !item.retry
      && item.timestamp === feedback.gradedAt);
    if (!('gradeOriginal' in feedback)) feedback.gradeOriginal = feedback.grade;
    Object.assign(feedback, { grade: a.grade, correct: a.grade >= 3, nextDue: after.due_at, adjustedAt: timestamp,
      level: cardLevel({ ...live, review: after }, a.grade) });
    if (a.grade > 1) feedback.correctionPending = false;
    if (attempt) {
      if (!('gradeOriginal' in attempt)) attempt.gradeOriginal = attempt.grade;
      Object.assign(attempt, { grade: a.grade, correct: a.grade >= 3, after, adjustedAt: timestamp });
    }
    const assistance = attempt?.assistance || {};
    settlePrerequisiteCredit(s, { run, entry, deckId, cardId: live.id, timestamp,
      eligible: a.grade >= 3 && !assistance.used && assistance.unseenStatus !== 'unknown' && !stale && !run.similarFor });
    return projection(s, run);
  },
};
