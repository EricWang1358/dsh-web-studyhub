/* 到考试日 (#894): which of three bands a crunch point (冲刺考点, lib/course-book-crunch.js) is in on its course's exam day, projected as if
   the learner did no further review. Pure: no I/O, no model call, nothing stored.

   solid  到考试日仍稳  solid today and still solid on the exam day
   slip   会掉          solid today, not on the exam day
   weak   已经不稳      not solid today

   "Solid" is the readiness rule and nothing else (lib/custom-readiness.js SOLID: a question is solid when it is 已掌握 or was answered right
   on enough days and its last answer was not wrong; a point when at least half of its questions are and none is weak). The projection only
   takes solidity away: a question is AT RISK when it was answered (its mastery level is not 新) and its recall at local 00:00 of the exam
   day (lib/sm2.js examDayStart, the instant exam alignment #916 schedules to), on the scheduler's own forgetting curve (lib/sm2.js
   retrievabilityAt), is below the target recall the scheduler gives that question (the learner's request_retention, raised for a 重点
   question as lib/sm2.js focusScheduleSettings raises it). The point slips when, with its at-risk questions counted as not solid, the
   readiness rule would no longer call it solid. So the share of questions a point may lose is the readiness rule's own half, not a second
   threshold; the only number is the target recall, the scheduler's.

   No band (null): no exam date, an exam date in the past, the exam day itself (nothing is left to project: the day's recall is today's, and
   the crunch plan only has 翻看 left), and a point none of whose questions was ever answered (its 新 wording stays).

   The recall numbers stay in here: the band and the order of the at-risk questions leave, never a percentage (the issue: FSRS's default
   weights are not proven for learners with a handful of answers per question, so a band is all the data carries). */
import { defaults, examDayStart, focusScheduleSettings, retrievabilityAt } from './sm2.js';
import { pointSolid } from './custom-readiness.js';
import { daysBetween, isDate } from './crunch-plan.js';

/** The three bands, as a crunch point carries them in `examDay.band`. */
export const EXAM_BANDS = Object.freeze(['solid', 'slip', 'weak']);

/** The target recall the scheduler gives a question: the learner's, or the raised one of a 重点 question. */
const targetRecall = (settings, focus) => Number(focusScheduleSettings(settings ?? defaults, { isFocus: focus })?.request_retention ?? defaults.request_retention);

/** Whether an exam date is ahead of today (strictly later): the only case a band is given. */
export const examAhead = (examDate, today) => isDate(examDate) && isDate(today) && daysBetween(today, examDate) >= 1;

/**
 * The exam-day band of one point (see the top of this file).
 * questions: [{ review (the card's stored review), answered, solid, weak (the readiness rule's, today), focus }]
 * exam: { examDate, today (YYYY-MM-DD), settings (the library settings: the curve's weights and the target recall) }
 * -> null (no band) or { band, atRisk: [{ index (into questions), recall }] }, the at-risk questions lowest projected recall first.
 */
export function examDayBand(questions, { examDate, today, settings }) {
  if (!examAhead(examDate, today) || !questions.some(question => question.answered)) return null;
  const at = examDayStart(examDate), recall = retrievabilityAt(settings ?? defaults), atRisk = [];
  const projected = questions.map((question, index) => {
    if (!question.answered) return question;
    const value = recall(question.review, at);
    if (value >= targetRecall(settings, question.focus === true)) return question;
    atRisk.push({ index, recall: value });
    return { ...question, solid: false };
  });
  const band = !pointSolid(questions) ? 'weak' : pointSolid(projected) ? 'solid' : 'slip';
  return { band, atRisk: atRisk.sort((a, b) => a.recall - b.recall || a.index - b.index) };
}
