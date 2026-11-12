import { useEffect, useLayoutEffect, useRef } from 'react';
import { hasActiveCoursePlan, shouldLandOnToday } from '../../lib/board-model.js';
import { pageAvailable } from '../capabilities.js';
import { PAGES, PAGE_IDS } from '../pages.js';

const useInitialEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** First available page when the default 学习库 ('library') is disabled in modular installations. */
export function fallbackLandingPage(data) {
  if (pageAvailable(data, 'library')) return 'library';
  return PAGE_IDS.find(id => PAGES[id].main && pageAvailable(data, id))
    || PAGE_IDS.find(id => PAGES[id].group && pageAvailable(data, id))
    || 'settings';
}

/**
 * Decision 1 (#854 / #855): when StudyHub opens, land on 「待办 → 今日」 if the learner has an active 备考计划
 * or open items for today on the board; otherwise stay on 学习库 (or the first available page such as 资料 when
 * 学习库's contexts are disabled). Evaluated once on initial open so explicit navigation is never overridden.
 */
export function useInitialLanding({ loading, data, boardState, nav, setBoardView, navigationCount }) {
  const decided = useRef(false), redirectedFromLibrary = useRef(false);
  useInitialEffect(() => {
    if (decided.current || loading || !data) return;
    if (navigationCount() === 0 && nav.page === 'library' && !pageAvailable(data, 'library')) {
      if (hasActiveCoursePlan(data)) {
        decided.current = true;
        setBoardView('today');
        nav.forcePage('board');
        return;
      }
      const fallback = fallbackLandingPage(data);
      if (fallback !== 'library') {
        redirectedFromLibrary.current = true;
        nav.forcePage(fallback);
      }
    }
    if (!hasActiveCoursePlan(data) && !boardState.board && !boardState.error) return;
    decided.current = true;
    if (navigationCount() > 0 || (nav.page !== 'library' && !redirectedFromLibrary.current)) return;
    if (shouldLandOnToday({ data, board: boardState.board })) {
      setBoardView('today');
      nav.forcePage('board');
    }
  }, [loading, data, boardState.board, boardState.error, nav, setBoardView, navigationCount]);
}
