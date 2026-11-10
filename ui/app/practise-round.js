/* A round of chosen questions started from a page, with a way back to where it was started: the 期末一周 card's 练 5 道 (ui/app/page-views.jsx) and the
   Today strip's 会掉 round (#894, ui/board/TodayFocusStrip.jsx) start through this one path. `app`: the intents, learn and session of ui/app/app-context.js. */
export function practiseRound({ intents, learn, session }, scope) {
  const origin = learn.captureContext();
  intents.practice(scope, { fresh: false, then: (run) => { learn.rememberContext(origin); session.enterRun(run); } });
}
