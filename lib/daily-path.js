import { latestOutcomes, planPath } from './mastery.js';
import { currentCourse } from './focus.js';
import { learningScope } from './learning-scope.js';
import { courseActivityRules } from './course-active.js';
import { resolvePracticeSettings, roundLimits } from './practice-settings.js';
import { stateFocusPredicate } from './focus-points.js';
import { methodProgress, stageCardMatcher } from './course-method-progress.js';

/* The daily path: the round the home card promises and 开始今日学习 starts, so the number on the card and the questions in the round are
   the same cards. A round is the due reviews, then the weak cards, then new ones (lib/mastery.js planPath), at most the learner's round size
   (设置 › 练习). Class mode studies one course at a time: the round is the CURRENT course's, and the work that waits in the other courses
   is counted once, apart. When the current course has a custom multi-stage 学法 (`own === true`, #777), due and weak cards span ALL stages of
   the course so earlier stages' FSRS reviews are never dropped, while new cards come from the current stage's scope only. Default 「课堂跟学」
   (`own === false`) behaves 100% identically to before. Pure: no I/O. */

/** The cap and the new-card limit of a round, from the library's saved 练习 settings. */
export const roundOptions = state => roundLimits(resolvePracticeSettings(state.settings?.practice).roundSize);

/**
 * Compute one course's daily path (`{ plan, scope, scopedDecks, progress }`). Shared by `dailyPlan` and `review.start { mode: 'path', course, daily: true }`
 * so the home card count and the started round always pick the exact same cards.
 */
export function courseDailyPlan(state, course, outcome = latestOutcomes(state.attempts || []), options = {}) {
  const scope = learningScope(state, { course }).scope;
  const inside = new Set(scope.map(ref => ref.deckId));
  const scopedDecks = state.decks.filter(deck => inside.has(deck.id));
  const progress = methodProgress(state, course);
  const newFilter = progress.own ? stageCardMatcher(state, course, progress.stage) : undefined;
  const plan = planPath(scopedDecks, outcome, { ...options, ...(newFilter ? { newFilter } : {}) });
  return { plan, scope, scopedDecks, progress, inside };
}

/**
 * Today's round for the home: { plan (planPath's result), course (name or null), scope ([{ deckId }] the round runs on; [] = every active course),
 * elsewhere (due or weak cards in the other courses, not in the round) }.
 */
export function dailyPlan(state, { outcome, now = Date.now() } = {}) {
  const resolvedOutcome = outcome || latestOutcomes(state.attempts || []);
  const isFocus = stateFocusPredicate(state);
  const options = { now, isFocus, ...roundOptions(state) };
  const rules = courseActivityRules(state);
  const active = state.decks.filter(deck => rules.deckActive(deck));
  const countFocus = (decks, plan) => {
    const byId = new Map(decks.map(deck => [deck.id, deck]));
    let focusCount = 0;
    for (const deck of decks) {
      if (deck.archived) continue;
      for (const card of deck.cards) if (!card.suspended && isFocus(deck, card)) focusCount++;
    }
    const focusRound = plan.entries.filter(entry => {
      const deck = byId.get(entry.deckId);
      return deck && isFocus(deck, entry.card);
    }).length;
    return { focusCount, focusRound };
  };
  const course = state.focus?.mode === 'interview' ? null : currentCourse(state);
  if (course == null) {
    const plan = planPath(active, resolvedOutcome, options);
    return { plan, course: null, scope: [], elsewhere: 0, ...countFocus(active, plan) };
  }
  const { plan, scope, scopedDecks, inside } = courseDailyPlan(state, course, resolvedOutcome, options);
  // 为你定制 decks belong to no course (and to no course round): they have their own link.
  const others = planPath(active.filter(deck => !inside.has(deck.id) && !deck.systemKind), resolvedOutcome, options);
  return { plan, course, scope, elsewhere: others.counts.due + others.counts.weak, ...countFocus(scopedDecks, plan) };
}
