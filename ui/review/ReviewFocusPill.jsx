import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { formatClock } from '../format.js';
import { useInjectCss } from '../shared.js';
import { Badge, Button, Chip, Field, IconButton, NumberInput, Popover, useNow, useToast } from '../components/index.js';
import {
  TIMER_BREAK_MAX,
  TIMER_WORK_MAX,
  localDate,
  resolveTimerPrefs,
  selectTodayTimeLog,
  timerSnapshot,
} from '../../lib/board-model.js';
import { useBoardTimer } from '../board/use-board-timer.js';
import { playTimerChime } from '../sound-effects.js';
import {
  DAILY_GOAL_MAX,
  DAILY_GOAL_MIN,
  DAILY_GOAL_PRESETS,
  computeTodayPace,
  formatTodayPaceLine,
  normalizeDailyGoal,
  useDailyGoal,
} from './today-pace.js';
import css from './review-focus-pill.css';

export const FOCUS_PRESETS = Object.freeze([
  { workMinutes: 25, breakMinutes: 5 },
  { workMinutes: 45, breakMinutes: 10 },
]);

function timerStateLabel(snap) {
  if (!snap) return '';
  if (snap.mode === 'break') return snap.finished ? ui('休息到点了') : snap.paused ? ui('休息已暂停') : ui('休息中');
  if (snap.finished) return ui('到点了');
  return snap.paused ? ui('已暂停') : ui('正在专注');
}

function pillStateTag(snap) {
  if (!snap) return '';
  if (snap.finished) return ui('到点了');
  if (snap.paused) return ui('已暂停');
  if (snap.mode === 'break') return ui('休息中');
  return '';
}

/** Lightweight in-quiz 25+5 focus timer pill & daily-goal pace popover synced with `board.timer.*`. */
export default function ReviewFocusPill({
  boardState,
  attempts = [],
  todayPaceSummary = null,
  focusTitle = '',
  root = '',
  today: todayProp,
  nowMs: nowProp,
  goal: controlledGoal,
  onGoalChange: saveGoal,
  onBoardChanged,
  defaultOpen = false,
}) {
  useInjectCss(css, 'study-review-focus-pill');
  const toast = useToast();
  const board = boardState?.board || null;
  const readOnly = !board || Boolean(board.readOnly);
  const timer = board?.timer || null;
  const today = todayProp || localDate(nowProp !== undefined ? new Date(nowProp) : new Date());
  const prefs = useMemo(() => resolveTimerPrefs(board), [board]);
  const todayLog = useMemo(() => selectTodayTimeLog(board, today), [board, today]);

  const liveNow = useNow(1000, { enabled: Boolean(timer && !timer.pausedAt) && nowProp === undefined });
  const nowMs = nowProp ?? liveNow;
  const snap = useMemo(() => timerSnapshot(timer, nowMs), [timer, nowMs]);

  const [ownGoal, setOwnGoal] = useDailyGoal({ root, today });
  const goal = controlledGoal !== undefined ? controlledGoal : ownGoal;
  const updateGoal = useCallback((next) => {
    const normalized = normalizeDailyGoal(next);
    if (saveGoal) saveGoal(normalized);
    else setOwnGoal(normalized);
  }, [saveGoal, setOwnGoal]);

  const [open, setOpen] = useState(defaultOpen);
  const [offerBreak, setOfferBreak] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [workDraft, setWorkDraft] = useState(() => String(prefs.workMinutes));
  const [breakDraft, setBreakDraft] = useState(() => String(prefs.breakMinutes));
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [goalDraft, setGoalDraft] = useState(() => (goal !== null ? String(goal) : ''));
  const [announcement, setAnnouncement] = useState('');
  const announced = useRef(0);
  const say = useCallback((message) => {
    announced.current += 1;
    setAnnouncement(announced.current % 2 ? message : `${message}\u200b`);
  }, []);

  const {
    startFreeFocus,
    startBreak,
    pauseTimer,
    resumeTimer,
    cancelTimer,
    completeTimer,
    saveTimerPrefs,
  } = useBoardTimer({ mutate: boardState?.mutate, today, say, onBoardChanged });

  useEffect(() => { setGoalDraft(goal !== null ? String(goal) : ''); }, [goal]);
  useEffect(() => { if (timer) setOfferBreak(false); }, [timer]);

  const prevSnapRef = useRef(null);
  const alertedIdRef = useRef('');
  useEffect(() => {
    const prev = prevSnapRef.current;
    prevSnapRef.current = snap;
    if (!snap) return;
    if (prev && prev.id === snap.id && !prev.finished && snap.finished && alertedIdRef.current !== snap.id) {
      alertedIdRef.current = snap.id;
      const msg = snap.mode === 'break' ? ui('休息到点了。') : uiFormat('专注到点了：{0}', [snap.cardTitle]);
      toast.show({ tone: 'info', message: msg });
      if (prefs.sound) playTimerChime();
    }
  }, [snap, prefs.sound, toast]);

  // Only compute pace while the popover is open so 1 Hz timer ticks never scan attempts[].
  const todayPace = useMemo(() => (
    open
      ? computeTodayPace({
          attempts,
          summary: todayPaceSummary,
          goal,
          focusMinutes: prefs.workMinutes,
          breakMinutes: prefs.breakMinutes,
          today,
        })
      : null
  ), [open, attempts, todayPaceSummary, goal, prefs.workMinutes, prefs.breakMinutes, today]);

  const paceLine = todayPace ? formatTodayPaceLine(todayPace) : '';
  const effectiveTitle = typeof focusTitle === 'string' && focusTitle.trim() ? focusTitle.trim() : ui('自由专注');

  const focusStart = async () => {
    if (readOnly) return;
    setOfferBreak(false);
    await startFreeFocus(effectiveTitle);
  };

  const focusResume = async () => {
    if (readOnly) return;
    await resumeTimer();
  };

  const recordComplete = async () => {
    if (!snap || readOnly) return;
    const wasWork = snap.mode === 'work';
    const ok = await completeTimer(snap);
    if (ok && wasWork) setOfferBreak(true);
  };

  const cancelSession = async () => {
    if (readOnly) return;
    if (await cancelTimer()) setOpen(false);
  };

  const focusBreak = async () => {
    if (readOnly) return;
    setOfferBreak(false);
    if (snap && snap.mode === 'work' && snap.finished && !(await completeTimer(snap))) return;
    await startBreak(prefs.breakMinutes);
  };

  const applyPreset = async (preset) => {
    if (readOnly || savingPrefs) return;
    if (prefs.workMinutes === preset.workMinutes && prefs.breakMinutes === preset.breakMinutes) return;
    setSavingPrefs(true);
    await saveTimerPrefs({ ...prefs, workMinutes: preset.workMinutes, breakMinutes: preset.breakMinutes });
    setSavingPrefs(false);
  };

  const parsedWork = Number(workDraft);
  const parsedBreak = Number(breakDraft);
  const prefsValid = Number.isInteger(parsedWork) && parsedWork >= 1 && parsedWork <= TIMER_WORK_MAX
    && Number.isInteger(parsedBreak) && parsedBreak >= 1 && parsedBreak <= TIMER_BREAK_MAX;

  const savePrefs = async (event) => {
    event.preventDefault();
    if (readOnly || savingPrefs || !prefsValid) return;
    setSavingPrefs(true);
    const ok = await saveTimerPrefs({ ...prefs, workMinutes: parsedWork, breakMinutes: parsedBreak });
    setSavingPrefs(false);
    if (ok) setPrefsOpen(false);
  };

  const parsedGoal = normalizeDailyGoal(goalDraft);
  const applyGoal = (event) => {
    event.preventDefault();
    if (goalDraft.trim() === '') { updateGoal(null); return; }
    if (parsedGoal !== null) updateGoal(parsedGoal);
  };

  if (!boardState) return null;

  const progressRatio = snap && snap.durationMs > 0 ? Math.min(1, Math.max(0, snap.elapsedMs / snap.durationMs)) : 0;
  const timerState = snap ? (snap.finished ? 'finished' : snap.paused ? 'paused' : 'running') : 'idle';
  const stateTag = pillStateTag(snap);
  const idleLabel = uiFormat('番茄 {0}+{1}', [prefs.workMinutes, prefs.breakMinutes]);
  const badgeTone = !snap ? 'neutral' : snap.mode === 'break' ? 'success' : snap.finished ? 'info' : 'neutral';

  const popoverBody = open ? (
    <>
      {snap ? (
        <>
          <div className="rfp-pop__head">
            <Badge size="sm" tone={badgeTone}>{timerStateLabel(snap)}</Badge>
            <span className="rfp-pop__title">{snap.mode === 'break' ? ui('休息片刻') : snap.cardTitle}</span>
          </div>
          <p className="rfp-pop__clock">{formatClock(snap.remainingMs)}</p>
          <div className="rfp-pop__bar" aria-hidden="true">
            <span className="rfp-pop__fill" data-timer-mode={snap.mode} style={{ transform: `scaleX(${progressRatio})` }} />
          </div>
          <div className="rfp-pop__row">
            {!snap.finished && (snap.paused
              ? <Button variant="secondary" size="sm" disabled={readOnly} onClick={focusResume}>{ui('继续')}</Button>
              : <Button variant="secondary" size="sm" disabled={readOnly} onClick={pauseTimer}>{ui('暂停')}</Button>)}
            <Button variant="primary" size="sm" icon="check" disabled={readOnly} onClick={recordComplete}>
              {snap.mode === 'break' ? ui('结束休息') : uiFormat('完成，记 {0} 分钟', [snap.loggedMinutes])}
            </Button>
            {snap.mode === 'work' && snap.finished && (
              <Button variant="secondary" size="sm" icon="clock" disabled={readOnly} onClick={focusBreak}>
                {uiFormat('休息 {0} 分钟', [prefs.breakMinutes])}
              </Button>
            )}
            <Button variant="quiet" size="sm" icon="close" disabled={readOnly} onClick={cancelSession}>{ui('放弃这一个')}</Button>
          </div>
        </>
      ) : (
        <>
          <div className="rfp-pop__head">
            <Badge size="sm">{ui('专注计时')}</Badge>
            <span className="rfp-pop__title">{uiFormat('番茄 {0} 分钟 · 休息 {1} 分钟', [prefs.workMinutes, prefs.breakMinutes])}</span>
          </div>
          <div className="rfp-pop__row">
            <Button variant="primary" size="sm" icon="clock" disabled={readOnly} onClick={focusStart}>{ui('开始计时')}</Button>
            <Button variant={offerBreak ? 'secondary' : 'quiet'} size="sm" icon="clock" disabled={readOnly} onClick={focusBreak}>
              {uiFormat('休息 {0} 分钟', [prefs.breakMinutes])}
            </Button>
          </div>
        </>
      )}

      <div className="rfp-pop__sec">
        <div className="rfp-pop__head">
          <span className="rfp-pop__label">{ui('专注节奏')}</span>
          {!readOnly && (
            <Button
              variant="quiet"
              size="sm"
              icon="settings"
              aria-expanded={prefsOpen}
              onClick={() => {
                if (!prefsOpen) { setWorkDraft(String(prefs.workMinutes)); setBreakDraft(String(prefs.breakMinutes)); }
                setPrefsOpen((prev) => !prev);
              }}
            >
              {ui('改时长')}
            </Button>
          )}
        </div>
        <div className="rfp-pop__row" role="group" aria-label={ui('专注节奏')}>
          {FOCUS_PRESETS.map((preset) => (
            <Chip
              key={`${preset.workMinutes}-${preset.breakMinutes}`}
              size="sm"
              selected={prefs.workMinutes === preset.workMinutes && prefs.breakMinutes === preset.breakMinutes}
              disabled={readOnly || savingPrefs}
              onClick={() => applyPreset(preset)}
            >
              {`${preset.workMinutes}+${preset.breakMinutes}`}
            </Chip>
          ))}
        </div>
        {prefsOpen && !readOnly && (
          <form className="rfp-pop__prefs" onSubmit={savePrefs}>
            <div className="rfp-pop__grid">
              <Field label={ui('专注时长')} width="full">
                <NumberInput min={1} max={TIMER_WORK_MAX} step={1} suffix={ui('分钟')} value={workDraft} onChange={(e) => setWorkDraft(e.target.value)} />
              </Field>
              <Field label={ui('休息时长')} width="full">
                <NumberInput min={1} max={TIMER_BREAK_MAX} step={1} suffix={ui('分钟')} value={breakDraft} onChange={(e) => setBreakDraft(e.target.value)} />
              </Field>
            </div>
            <div className="rfp-pop__row">
              <Button type="submit" variant="primary" size="sm" busy={savingPrefs} disabled={savingPrefs || !prefsValid}>{ui('保存设置')}</Button>
              <Button variant="quiet" size="sm" onClick={() => setPrefsOpen(false)}>{ui('取消')}</Button>
            </div>
          </form>
        )}
      </div>

      <div className="rfp-pop__sec">
        <div className="rfp-pop__head">
          <span className="rfp-pop__label">{ui('今日刷题目标')}</span>
          {goal !== null && <Button variant="quiet" size="sm" onClick={() => updateGoal(null)}>{ui('清除目标')}</Button>}
        </div>
        <div className="rfp-pop__row" role="group" aria-label={ui('今日刷题目标')}>
          {DAILY_GOAL_PRESETS.map((preset) => (
            <Chip key={preset} size="sm" selected={goal === preset} onClick={() => updateGoal(goal === preset ? null : preset)}>
              {uiFormat('{0} 题', [preset])}
            </Chip>
          ))}
        </div>
        <form className="rfp-pop__form" onSubmit={applyGoal}>
          <NumberInput
            min={DAILY_GOAL_MIN}
            max={DAILY_GOAL_MAX}
            step={1}
            aria-label={ui('自定义今日目标题数')}
            placeholder={ui('自定义题数')}
            value={goalDraft}
            onChange={(e) => setGoalDraft(e.target.value)}
          />
          <Button type="submit" variant="secondary" size="sm" disabled={goalDraft.trim() !== '' && parsedGoal === null}>{ui('设定')}</Button>
        </form>
        <p className="rfp-pop__pace" data-goal-met={todayPace?.goalMet ? 'true' : undefined}>{paceLine}</p>
      </div>

      <div className="rfp-pop__foot">
        <span>{uiFormat('今日已专注 {0} 分钟', [todayLog.totalMinutes])}</span>
        <span>{ui('与待办同步')}</span>
      </div>
    </>
  ) : null;

  return (
    <div className="rfp" data-testid="review-focus-pill">
      {snap ? (
        <Popover
          label={ui('专注计时与今日目标')}
          open={open}
          onOpenChange={setOpen}
          panelClassName="rfp-pop"
          trigger={({ props, ref }) => (
            <Button
              ref={ref}
              variant="secondary"
              size="sm"
              className="rfp__btn"
              data-timer-mode={snap.mode}
              data-timer-state={timerState}
              aria-label={uiFormat('{0} · 剩余 {1}', [timerStateLabel(snap), formatClock(snap.remainingMs)])}
              {...props}
              onClick={() => setOpen((prev) => !prev)}
            >
              <span className="rfp__dot" aria-hidden="true" />
              <span className="rfp__clock">{formatClock(snap.remainingMs)}</span>
              {stateTag && <span className="rfp__tag">{stateTag}</span>}
            </Button>
          )}
        >
          {popoverBody}
        </Popover>
      ) : (
        <>
          <Button variant="secondary" size="sm" icon="clock" className="rfp__btn" data-timer-state="idle" disabled={readOnly} onClick={focusStart}>
            {idleLabel}
          </Button>
          <Popover
            label={ui('专注计时与今日目标')}
            open={open}
            onOpenChange={setOpen}
            panelClassName="rfp-pop"
            trigger={({ props, ref }) => (
              <IconButton ref={ref} icon="chevron-down" size="sm" variant="quiet" label={ui('专注与今日目标')} className="rfp__more" {...props} />
            )}
          >
            {popoverBody}
          </Popover>
        </>
      )}
      <div className="sh-visually-hidden" role="status" aria-live="polite">{announcement}</div>
    </div>
  );
}
