import { useEffect, useLayoutEffect, useRef } from 'react';
import { hasActiveCoursePlan, shouldLandOnToday } from '../../lib/board-model.js';

const useInitialEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Decision 1 (#854 / #855): when StudyHub opens, land on 「待办 → 今日」 if the learner has an active 备考计划
 * or open items for today on the board; otherwise stay on 学习库. Evaluated once on initial open so explicit
 * navigation is never overridden, and committed before paint when snapshot already carries an active plan.
 */
export function useInitialLanding({ loading, data, boardState, nav, setBoardView, navigationCount }) {
  const decided = useRef(false);
  useInitialEffect(() => {
    if (decided.current || loading || !data) return;
    if (!hasActiveCoursePlan(data) && !boardState.board && !boardState.error) return;
    decided.current = true;
    if (navigationCount() > 0 || nav.page !== 'library') return;
    if (shouldLandOnToday({ data, board: boardState.board })) {
      setBoardView('today');
      nav.forcePage('board');
    }
  }, [loading, data, boardState.board, boardState.error, nav, setBoardView, navigationCount]);
}
