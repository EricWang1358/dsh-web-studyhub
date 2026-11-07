import { decksInCourse } from './focus.js';
import { latestOutcomes } from './mastery.js';
import { methodProgress } from './course-method-progress.js';

/* 阶段检验 (#777 S3a): what the current stage's check rests on, read from the learner's own answers — no model call, nothing generated. The check's items
   are the course's existing questions (the stage does not make new ones to test you); an item is passed when its last answer was right (grade 3 or more,
   the line lib/mastery.js draws between weak and everything else). The stage's own check passes at about two thirds; the home suggests going on at four
   fifths. A course with no questions has nothing to check yet, and says so rather than "100% passed". */

/** 约三分之二答对算过（标准宽松，owner 定的）. */
export const CHECK_PASS_RATIO = 2 / 3;
/** 过 80% 才在首页建议进入下一阶段. */
export const ADVANCE_RATIO = 0.8;

/**
 * `{ course, index, stage, total, passed, ratio, checkPassed, ready, basis }` for `course` (a name, like lib/course-method-progress.js): the current
 * stage of its 学法 and how its check stands. `basis: 'cards'` — the items are the course's existing questions; case questions count by their last grade
 * until the point-level grading of S3b, which the owner asked for, lands.
 */
export function stageGate(state, course, progress = methodProgress(state, course)) {
  const outcome = latestOutcomes(state?.attempts);
  let total = 0, passed = 0;
  for (const deck of decksInCourse(state, course)) {
    for (const card of deck.cards || []) {
      if (card.suspended) continue;
      total += 1;
      const grade = outcome(deck.id, card.id);
      if (Number.isFinite(grade) && grade >= 3) passed += 1;
    }
  }
  const ratio = total ? passed / total : 0;
  return { course, index: progress.index, stage: progress.stage, total, passed, ratio,
    checkPassed: total > 0 && ratio >= CHECK_PASS_RATIO, ready: total > 0 && ratio >= ADVANCE_RATIO, basis: 'cards' };
}
