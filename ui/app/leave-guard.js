/* The beat a page takes to leave (leaveDelayMs, ui/appearance-prefs.js): the old page fades while the next one is on its way.
   A press on the fading page must do nothing, or a learner who clicks fast acts on a page they already left. This used to be
   `pointer-events: none` on the leaving page (ui/motion.css), but that property is inherited: setting it restyled every element of
   the old page inside the click, before the fade could start (scripts/qa/page-switch-perf.mjs). Refusing the press here costs nothing
   until a press happens. */

const LEAVING_PAGE = 'main > :is(.page, .review-page, .board-page)';

/** Refuse a press that landed on the page that is leaving; anything else (the top bar, a banner) goes through. */
export function refuseLeavingPress(event) {
  if (!event.target?.closest?.(LEAVING_PAGE)) return;
  event.preventDefault();
  event.stopPropagation();
}
