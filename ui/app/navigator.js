import { pageOf } from '../pages.js';

/* The app's one navigation (ui-consistency #109): it replaced three overlapping functions (a link, a sidebar click, the tour's switch).
     navigate(id)                                        a link: take ownership at once, keep the way back
     navigate(id, { animate, keepTrail: false, enter: 'user' })   a sidebar click: the old page lifts away, the trail starts afresh,
                                                         the page's onEnter (ui/pages.js) resets what a revisit should start fresh
     navigate(id, { keepTrail: false, enter: 'tour', scroll: true })  the feature tour: at once, back to the top of the page
   Any navigation cancels a pending leave animation and drops answers that were loading for the page being left. */

/**
 * The one gate every change of page passes (#489; ui/app/use-navigation.js hands out nothing that goes around it). A page with something the learner would lose holds it: hold(ask)
 * -> release. While held, leave(id, go) does not go: it calls ask(go), and the page calls `go` once the learner agrees (the answer also releases the gate, so what `go` does next
 * is not asked again). leave(id, go) with the page on screen leaves nothing behind and goes at once; id null is a change that is not a page but replaces this one (another course).
 */
export function createLeaveGate(getPage) {
  let ask = null;
  return {
    hold(asker) { ask = asker; return () => { if (ask === asker) ask = null; }; },
    leave(id, go) {
      if (!ask || id === getPage()) { go(); return; }
      ask(() => { ask = null; go(); });
    },
  };
}

/**
 * deps: { getPage, setPage, setPageTarget, bumpNavigation, leaveTimer: { current }, clearTimer, setTimer, leaveDelay(), clearTrail,
 *   setError, scrollTop, enterContext(id) }. enterContext(id) is called when the click happens and returns what onEnter may
 *   reset (resetExam, openBoardFresh, clearNote, clearGraphScope).
 */
export function createNavigator(deps) {
  function navigate(id, { animate = false, keepTrail = true, enter = false, scroll = false } = {}) {
    deps.bumpNavigation();
    deps.clearTimer(deps.leaveTimer.current);
    if (!keepTrail) deps.clearTrail();
    const context = enter ? deps.enterContext(id) : null;
    const arrive = () => {
      if (enter) {
        if (enter === 'user') deps.setError('');
        pageOf(id)?.onEnter?.(context, enter);
      }
      deps.setPageTarget(null);
      deps.setPage(id);
      if (scroll) deps.scrollTop();
    };
    const delay = animate ? deps.leaveDelay() : 0;
    if (!delay || id === deps.getPage()) { arrive(); return; }
    deps.setPageTarget(id);
    deps.leaveTimer.current = deps.setTimer(arrive, delay);
  }
  return { navigate };
}
