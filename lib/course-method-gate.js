import { decksInCourse } from './focus.js';
import { latestOutcomes } from './mastery.js';
import { methodProgress } from './course-method-progress.js';

/* 阶段检验 (#777 S3a): what the current stage's check rests on, read from the learner's own answers — no model call, nothing generated. The check's items
   are the course's existing questions (the stage does not make new ones to test you). How an item counts and how many must is the stage's own gate (its
   level, the 过关宽严 the card edits): 松一点 counts an answer of any grade; 适中 counts a last answer that was right (grade 3 or more, the line
   lib/mastery.js draws between weak and everything else), passes at about two thirds and suggests going on at four fifths; 严格一点 asks for all of them
   right. The last stage has no next one to suggest. A course with no questions has nothing to check yet, and says so rather than "100% passed". */

/** Each gate: what makes one question count, the share that passes the stage's check, and the share at which the next stage is suggested. */
export const GATE_RULES = Object.freeze({
  loose: Object.freeze({ counts: 'answered', pass: 2 / 3, advance: 0.8 }),
  medium: Object.freeze({ counts: 'right', pass: 2 / 3, advance: 0.8 }),
  strict: Object.freeze({ counts: 'right', pass: 1, advance: 1 }),
});
/** 约三分之二答对算过（标准宽松，owner 定的）: the default gate's check. */
export const CHECK_PASS_RATIO = GATE_RULES.medium.pass;
/** 过 80% 才建议进入下一阶段: the default gate's suggestion. */
export const ADVANCE_RATIO = GATE_RULES.medium.advance;

const atLeast = (share, total) => Math.ceil(share * total - 1e-9);

/**
 * `{ course, index, stage, level, counts, total, passed, ratio, checkPassed, ready, toReady, last, basis }` for `course` (a name, like
 * lib/course-method-progress.js): the current stage of its 学法 and how its check stands. `counts`: 'answered' or 'right', what made `passed`; `toReady`:
 * how many more until the next stage is suggested; `ready` is never true on the last stage. `basis: 'cards'` — the items are the course's existing
 * questions; case questions count by their last grade until the point-level grading the owner asked for lands.
 */
export function stageGate(state, course, progress = methodProgress(state, course)) {
  const level = GATE_RULES[progress.stage?.level] ? progress.stage.level : 'medium', rule = GATE_RULES[level];
  const outcome = latestOutcomes(state?.attempts || []);
  let total = 0, passed = 0;
  for (const deck of decksInCourse(state, course)) {
    for (const card of deck.cards || []) {
      if (card.suspended) continue;
      total += 1;
      const grade = outcome(deck.id, card.id);
      if (rule.counts === 'answered' ? grade !== undefined : Number.isFinite(grade) && grade >= 3) passed += 1;
    }
  }
  const last = progress.index >= progress.total - 1, needed = atLeast(rule.advance, total);
  return { course, index: progress.index, stage: progress.stage, level, counts: rule.counts, total, passed, ratio: total ? passed / total : 0,
    checkPassed: total > 0 && passed >= atLeast(rule.pass, total), ready: !last && total > 0 && passed >= needed, toReady: Math.max(0, needed - passed), last,
    basis: 'cards' };
}
