import { planPath } from './mastery.js';
import { currentCourse } from './focus.js';
import { learningScope } from './learning-scope.js';
import { courseActivityRules } from './course-active.js';
import { resolvePracticeSettings, roundLimits } from './practice-settings.js';

/* The daily path: the round the home card promises and 开始今日学习 starts, so the number on the card and the questions in the round are
   the same cards. A round is the due reviews, then the weak cards, then new ones (lib/mastery.js planPath), at most the learner's round size
   (设置 › 练习). Class mode studies one course at a time: the round is the CURRENT course's, and the work that waits in the other courses
   is counted once, apart. Interview mode, and a library without a current course, plan every active course. Pure: no I/O. */

/** The cap and the new-card limit of a round, from the library's saved 练习 settings. */
export const roundOptions = state => roundLimits(resolvePracticeSettings(state.settings?.practice).roundSize);

/**
 * Today's round for the home: { plan (planPath's result), course (name or null), scope ([{ deckId }] the round runs on; [] = every active course),
 * elsewhere (due or weak cards in the other courses, not in the round) }.
 */
export function dailyPlan(state, { outcome, now = Date.now() } = {}) {
  const options = { now, ...roundOptions(state) };
  const rules = courseActivityRules(state);
  const active = state.decks.filter(deck => rules.deckActive(deck));
  const course = state.focus?.mode === 'interview' ? null : currentCourse(state);
  if (course == null) return { plan: planPath(active, outcome, options), course: null, scope: [], elsewhere: 0 };
  const scope = learningScope(state, { course }).scope;
  const inside = new Set(scope.map(ref => ref.deckId));
  const plan = planPath(state.decks.filter(deck => inside.has(deck.id)), outcome, options);
  // 为你定制 decks belong to no course (and to no course round): they have their own link.
  const others = planPath(active.filter(deck => !inside.has(deck.id) && !deck.systemKind), outcome, options);
  return { plan, course, scope, elsewhere: others.counts.due + others.counts.weak };
}
