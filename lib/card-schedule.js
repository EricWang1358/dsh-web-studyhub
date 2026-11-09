/* The scheduling settings of one question, derived in one place (#882). Every path that schedules a question passes
   these to lib/sm2.js `schedule` / `nextIntervals`: a practice answer and its button preview, a mock exam, prerequisite
   credit, rubric grading, the oral mock and the sample library's history. The library's own settings are the base; a
   focus question (重点, lib/focus-points.js) gets the raised target recall (lib/sm2.js focusScheduleSettings). */
import { focusScheduleSettings } from "./sm2.js";
import { courseOf } from "./focus.js";
import { courseFocusTopics, isFocusCard } from "./focus-points.js";

/** `{ settings, isFocus }` for `card` in `deck` (a deck without a course, such as a system deck, takes no course focus topics). */
export function cardScheduleSettings(state, deck, card) {
  const focusTopics = deck ? courseFocusTopics(state, courseOf(deck)) : [];
  const isFocus = isFocusCard(card, { focusTopics });
  return { settings: focusScheduleSettings(state.settings, { isFocus }), isFocus };
}
