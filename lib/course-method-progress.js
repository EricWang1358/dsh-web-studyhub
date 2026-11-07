import { decksInCourse } from './focus.js';
import { latestOutcomes } from './mastery.js';
import { atLeast, courseMethod, gateRule } from './course-method.js';

/* Where the learner is in a course's 学法 (#775 S1b): the first stage whose work is not done yet, read from what the library holds — no model call, nothing
   stored. A stage is done by its activity, not by a clock: 导入资料 when the course has a material, 按批练 when its gate is enough (four in five of the
   course's questions answered, or answered right, by its level); 复习 (and any other activity) is never "done", so it is where a course rests once the
   earlier stages are passed. A course with
   its own method is measured by its own stages, in its own order. */

const text = value => typeof value === 'string' && value.trim().length > 0;

/** Whether the work a stage stands for has been done: publish — a material of the course; practice — its own gate is enough to go on (lib/course-method-gate.js
    counts the same way, so the card's 「再答对 N 道」 runs out exactly when the stage moves on). */
function stageDone(stage, { materials, cards, answered, right }) {
  if (stage.activity === 'publish') return materials > 0;
  if (stage.activity === 'practice') {
    const rule = gateRule(stage.level);
    return cards > 0 && (rule.counts === 'answered' ? answered : right) >= atLeast(rule.advance, cards);
  }
  return false;
}

/**
 * `{ course, index, stage, total, counts: { materials, cards, answered, right }, own }` for `course` (a name, like lib/focus-progress.js). The default package is
 * measured when the course has no method of its own, so every course has an answer.
 */
export function methodProgress(state, course) {
  const record = (state?.courses || []).find(item => item && item.name === course) ?? null;
  const method = courseMethod(record);
  const materials = (state?.sources || []).filter(source => source && !source.archived && text(source.text)
    && (Array.isArray(source.courses) ? source.courses.includes(course) : source.course === course)).length;
  const outcome = latestOutcomes(state?.attempts);
  let cards = 0, answered = 0, right = 0;
  for (const deck of decksInCourse(state, course)) {
    for (const card of deck.cards || []) {
      if (card.suspended) continue;
      cards += 1;
      const grade = outcome(deck.id, card.id);
      // A grade of 0 is a wrong answer, still an answer.
      if (grade !== undefined) answered += 1;
      if (Number.isFinite(grade) && grade >= 3) right += 1;
    }
  }
  const counts = { materials, cards, answered, right };
  let index = 0;
  while (index < method.stages.length - 1 && stageDone(method.stages[index], counts)) index += 1;
  // `own`: the stages are the course's own words; false means the default package, whose words a screen draws from the catalogue.
  return { course, index, stage: method.stages[index], total: method.stages.length, counts, own: !!record?.method };
}
