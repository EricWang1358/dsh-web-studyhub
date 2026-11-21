import { useCallback } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { localDate } from '../../lib/board-model.js';

/**
 * Shared focus timer controls backed by `board.timer.*` mutations.
 * Reused by `ui/Board.jsx` and `ui/review/ReviewFocusPill.jsx` so starting,
 * pausing, resuming, cancelling, completing, or updating duration prefs stays
 * synced with `board.json` and logs work sessions into `board.timeLog`.
 */
export function useBoardTimer({ mutate, today: todayProp, say, onBoardChanged } = {}) {
  const run = useCallback(
    (action, args, options) => (mutate ? mutate(action, args, options) : Promise.resolve(false)),
    [mutate],
  );

  const startTimer = useCallback(async (card) => {
    const ok = await run('board.timer.start', { id: card.id, mode: 'work' }, { optimistic: false });
    if (ok) {
      say?.(uiFormat('已开始专注：{0}', [card.title]));
      onBoardChanged?.();
    }
    return ok;
  }, [run, say, onBoardChanged]);

  const startFreeFocus = useCallback(async (title, options = {}) => {
    const focusTitle = typeof title === 'string' && title.trim() ? title.trim() : ui('自由专注');
    const durationMinutes = Number.isInteger(options?.durationMinutes) ? options.durationMinutes : undefined;
    const ok = await run('board.timer.start', {
      mode: 'work',
      cardTitle: focusTitle,
      ...(durationMinutes !== undefined ? { durationMinutes } : {}),
    }, { optimistic: false });
    if (ok) {
      say?.(uiFormat('已开始专注：{0}', [focusTitle]));
      onBoardChanged?.();
    }
    return ok;
  }, [run, say, onBoardChanged]);

  const startBreak = useCallback(async (durationMinutes) => {
    const ok = await run('board.timer.start', {
      mode: 'break',
      cardTitle: ui('休息片刻'),
      ...(Number.isInteger(durationMinutes) ? { durationMinutes } : {}),
    }, { optimistic: false });
    if (ok) {
      say?.(Number.isInteger(durationMinutes) ? uiFormat('已开始休息 {0} 分钟', [durationMinutes]) : ui('休息片刻'));
    }
    return ok;
  }, [run, say]);

  const pauseTimer = useCallback(async () => {
    const ok = await run('board.timer.pause', {});
    if (ok) say?.(ui('已暂停专注'));
    return ok;
  }, [run, say]);

  const resumeTimer = useCallback(async () => {
    const ok = await run('board.timer.resume', {});
    if (ok) say?.(ui('继续专注'));
    return ok;
  }, [run, say]);

  const cancelTimer = useCallback(async () => {
    const ok = await run('board.timer.cancel', {});
    if (ok) say?.(ui('已放弃本次计时'));
    return ok;
  }, [run, say]);

  const completeTimer = useCallback(async (snap) => {
    const isWork = snap?.mode === 'work';
    const mins = snap?.loggedMinutes;
    const title = snap?.cardTitle || '';
    const date = todayProp || localDate();
    const ok = await run('board.timer.complete', {
      ...(isWork && Number.isInteger(mins) ? { minutes: mins, date } : {}),
    }, { optimistic: false });
    if (ok) {
      onBoardChanged?.();
      say?.(isWork ? uiFormat('已记录专注 {0} 分钟：{1}', [mins, title]) : ui('休息已结束'));
    }
    return ok;
  }, [run, todayProp, say, onBoardChanged]);

  const saveTimerPrefs = useCallback(async (prefs) => {
    const ok = await run('board.timer.prefs', prefs);
    if (ok) say?.(ui('已保存计时设置'));
    return ok;
  }, [run, say]);

  return {
    startTimer,
    startFreeFocus,
    startBreak,
    pauseTimer,
    resumeTimer,
    cancelTimer,
    completeTimer,
    saveTimerPrefs,
  };
}
