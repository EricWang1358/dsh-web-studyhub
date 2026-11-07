import { decksInCourse } from './focus.js';
import { latestOutcomes } from './mastery.js';
import { courseMethod } from './course-method.js';

/* Where the learner is in a course's 学法 (#775 S1b): the first stage whose work is not done yet, read from what the library holds — no model call, nothing
   stored. A stage is done by its activity, not by a clock: 发布 when the course has a material, 按批练 when every question of its active decks has been
   answered at least once; 复习 (and any other activity) is never "done", so it is where a course rests once the earlier stages are passed. A course with
   its own method is measured by its own stages, in its own order. */

const text = value => typeof value === 'string' && value.trim().length > 0;

/** Whether the work a stage stands for has been done: publish — a material of the course; practice — every question answered at least once. */
function stageDone(stage, { materials, cards, answered }) {
  if (stage.activity === 'publish') return materials > 0;
  if (stage.activity === 'practice') return cards > 0 && answered >= cards;
  return false;
}

/**
 * `{ course, index, stage, total, counts: { materials, cards, answered } }` for `course` (a name, like lib/focus-progress.js). The default package is
 * measured when the course has no method of its own, so every course has an answer.
 */
export function methodProgress(state, course) {
  const record = (state?.courses || []).find(item => item && item.name === course) ?? null;
  const method = courseMethod(record);
  const materials = (state?.sources || []).filter(source => source && !source.archived && text(source.text)
    && (Array.isArray(source.courses) ? source.courses.includes(course) : source.course === course)).length;
  const outcome = latestOutcomes(state?.attempts);
  let cards = 0, answered = 0;
  for (const deck of decksInCourse(state, course)) {
    for (const card of deck.cards || []) {
      if (card.suspended) continue;
      cards += 1;
      if (outcome(deck.id, card.id)) answered += 1;
    }
  }
  const counts = { materials, cards, answered };
  let index = 0;
  while (index < method.stages.length - 1 && stageDone(method.stages[index], counts)) index += 1;
  return { course, index, stage: method.stages[index], total: method.stages.length, counts };
}
