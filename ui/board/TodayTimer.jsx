import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { formatClock, formatDateTime, joinMeta } from '../format.js';
import {
  Button, Dialog, Field, Icon, IconButton, NumberInput, Select, Switch, TextInput, Tooltip, useNow, useToast,
} from '../components/index.js';
import {
  ACTUAL_MINUTES_MAX, TIMER_BREAK_MAX, TIMER_WORK_MAX, isMeaningfulTitle, resolveTimerPrefs, selectTodayTimeLog, timerSnapshot,
} from '../../lib/board-model.js';
import { playTimerChime } from '../sound-effects.js';
import { useLiveEffect } from '../use-async.js';
import FocusRitualDial from '../desk-atelier/FocusRitualDial.jsx';
import BreathingHalo from '../desk-atelier/BreathingHalo.jsx';
import FocusSoundscapePill from '../desk-atelier/FocusSoundscapePill.jsx';
import FocusAmbientCanvas, {
  FocusAmbientControls,
  loadAmbientMode,
  saveAmbientMode,
} from '../desk-atelier/FocusAmbientCanvas.jsx';

const CUSTOM_CARD = '__custom__';
let cachedChimeDialog = null;

export function notificationPermissionState() {
  if (typeof globalThis.Notification !== 'function') return 'unsupported';
  return globalThis.Notification.permission || 'default';
}

export function timerMinutesError(raw, max) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return '';
  const num = Number(trimmed);
  if (!Number.isInteger(num) || num < 1 || num > max) {
    return uiFormat('请输入 1–{0} 的整数', [max]);
  }
  return '';
}

function sendSystemNotification(title, body) {
  try {
    if (typeof globalThis.Notification !== 'function') return;
    if (globalThis.Notification.permission === 'granted') {
      new globalThis.Notification(title, { body });
    }
  } catch {
    // Ignore environments where Notification constructor is unavailable.
  }
}

function timerStateLabel(snap) {
  if (!snap) return '';
  if (snap.mode === 'break') return snap.finished ? ui('休息到点了') : snap.paused ? ui('休息已暂停') : ui('休息中');
  if (snap.finished) return ui('到点了');
  return snap.paused ? ui('已暂停') : ui('正在专注');
}

/** Narrow-viewport sticky bottom bar for an active focus/break timer (#858). */
export function TodayTimerBar({
  board, readOnly = false, nowMs: nowProp, onPause, onResume, onComplete, onOpenFullscreen,
}) {
  const timer = board?.timer || null;
  const liveNow = useNow(1000, { enabled: Boolean(timer && !timer.pausedAt) && nowProp === undefined });
  const nowMs = nowProp ?? liveNow;
  const snap = useMemo(() => timerSnapshot(timer, nowMs), [timer, nowMs]);
  if (!snap) return null;
  const title = snap.mode === 'break' ? ui('休息片刻') : snap.cardTitle;
  return (
    <aside className="board-timer-bar" aria-label={ui('专注计时')}>
      <div className="board-timer-bar__info">
        <span className="board-timer-bar__title">{title}</span>
        <span className="board-timer-bar__clock">{formatClock(snap.remainingMs)}</span>
      </div>
      <div className="board-timer-bar__actions">
        {snap.finished ? (
          <Button variant="primary" size="sm" icon="check" disabled={readOnly} onClick={() => onComplete?.(snap)}>
            {snap.mode === 'break' ? ui('结束休息') : uiFormat('记 {0} 分钟', [snap.loggedMinutes])}
          </Button>
        ) : snap.paused ? (
          <Button variant="secondary" size="sm" icon="play" disabled={readOnly} onClick={onResume}>
            {ui('继续')}
          </Button>
        ) : (
          <Button variant="secondary" size="sm" disabled={readOnly} onClick={onPause}>
            {ui('暂停')}
          </Button>
        )}
        <IconButton
          icon={<Icon name="fit" size={16} />}
          size="sm"
          label={ui('全屏专注')}
          onClick={onOpenFullscreen}
        />
      </div>
    </aside>
  );
}

/** Desktop side timer block + manual log / duration prefs + Fullscreen Focus dialog (#858). */
export default function TodayTimer({
  board, today, todayCards = [], readOnly = false, nowMs: nowProp,
  fullscreen = false, onFullscreenChange,
  onStartFreeFocus, onStartBreak, onPause, onResume, onCancel, onComplete, onSavePrefs, onAddLog, onEditLog, onRemoveLog,
}) {
  const toast = useToast();
  const timer = board?.timer || null;
  const prefs = useMemo(() => resolveTimerPrefs(board), [board]);
  const todayLog = useMemo(() => selectTodayTimeLog(board, today), [board, today]);
  const liveNow = useNow(1000, { enabled: Boolean(timer && !timer.pausedAt) && nowProp === undefined });
  const nowMs = nowProp ?? liveNow;
  const snap = useMemo(() => timerSnapshot(timer, nowMs), [timer, nowMs]);

  const [panelMode, setPanelMode] = useState('');
  const [offerBreak, setOfferBreak] = useState(false);
  const [breathOpen, setBreathOpen] = useState(false);
  const [chimeOpen, setChimeOpen] = useState(false);
  const [ChimeDialog, setChimeDialog] = useState(() => cachedChimeDialog);
  const [ambientMode, setAmbientMode] = useState(() => loadAmbientMode());

  useLiveEffect((isLive) => {
    if (!chimeOpen || ChimeDialog) return undefined;
    import('../desk-atelier/DeskChimeDialog.jsx')
      .then((mod) => {
        cachedChimeDialog = mod?.default || null;
        if (!isLive()) return;
        if (cachedChimeDialog) setChimeDialog(() => cachedChimeDialog);
        else setChimeOpen(false);
      })
      .catch(() => {
        if (isLive()) setChimeOpen(false);
      });
    return undefined;
  }, [chimeOpen, ChimeDialog]);

  const handleAmbientChange = (nextMode) => {
    setAmbientMode(saveAmbientMode(nextMode));
  };

  // Manual log state
  const defaultCardChoice = todayCards[0]?.id || CUSTOM_CARD;
  const [manualCardId, setManualCardId] = useState(defaultCardChoice);
  const [manualTitle, setManualTitle] = useState('');
  const [manualMinutes, setManualMinutes] = useState(() => String(prefs.workMinutes));
  const [submittingManual, setSubmittingManual] = useState(false);

  // Prefs state
  const [workDraft, setWorkDraft] = useState(() => String(prefs.workMinutes));
  const [breakDraft, setBreakDraft] = useState(() => String(prefs.breakMinutes));
  const [soundDraft, setSoundDraft] = useState(() => prefs.sound);
  const [notifyDraft, setNotifyDraft] = useState(() => prefs.notify);
  const [savingPrefs, setSavingPrefs] = useState(false);

  // Inline log edit state
  const [editingLogId, setEditingLogId] = useState('');
  const [editingMinutes, setEditingMinutes] = useState('');
  const [savingLogEdit, setSavingLogEdit] = useState(false);

  // One-time alert tracking when an active countdown crosses 0:00 (never auto-starts next block).
  const prevSnapRef = useRef(null);
  const alertedIdRef = useRef('');

  useEffect(() => {
    const prev = prevSnapRef.current;
    prevSnapRef.current = snap;
    if (!snap) return;
    if (prev && prev.id === snap.id && !prev.finished && snap.finished && alertedIdRef.current !== snap.id) {
      alertedIdRef.current = snap.id;
      const msg = snap.mode === 'break'
        ? ui('休息到点了。')
        : uiFormat('专注到点了：{0}', [snap.cardTitle]);
      toast.show({ tone: 'info', message: msg });
      if (prefs.sound) playTimerChime();
      if (prefs.notify) sendSystemNotification(ui('专注计时'), msg);
    }
  }, [snap, prefs.sound, prefs.notify, toast]);

  useEffect(() => {
    if (timer) setOfferBreak(false);
    if (timer?.mode === 'work') setBreathOpen(false);
  }, [timer]);

  useEffect(() => {
    if (!snap && fullscreen) onFullscreenChange?.(false);
  }, [snap, fullscreen, onFullscreenChange]);

  const cardOptions = useMemo(() => [
    ...todayCards.map((card) => ({ value: card.id, label: card.title })),
    { value: CUSTOM_CARD, label: ui('不关联卡片（自己写名称）') },
  ], [todayCards]);

  const openPrefsPanel = () => {
    if (panelMode === 'prefs') {
      setPanelMode('');
      return;
    }
    setWorkDraft(String(prefs.workMinutes));
    setBreakDraft(String(prefs.breakMinutes));
    setSoundDraft(prefs.sound);
    setNotifyDraft(prefs.notify);
    setPanelMode('prefs');
  };

  const openManualPanel = () => {
    if (panelMode === 'manual') {
      setPanelMode('');
      return;
    }
    const validExisting = todayCards.some((card) => card.id === manualCardId);
    setManualCardId(validExisting ? manualCardId : (todayCards[0]?.id || CUSTOM_CARD));
    setManualMinutes(String(prefs.workMinutes));
    setPanelMode('manual');
  };

  const [notifyPermission, setNotifyPermission] = useState(notificationPermissionState);
  useEffect(() => {
    if (panelMode === 'prefs') setNotifyPermission(notificationPermissionState());
  }, [panelMode]);
  const notifyBlocked = notifyPermission === 'unsupported' || notifyPermission === 'denied';
  const notifyHint = notifyBlocked
    ? (notifyPermission === 'unsupported'
      ? ui('当前环境不支持系统通知，建议开启上方「到点声音提醒」。')
      : notifyDraft
        ? ui('浏览器已禁用系统通知权限，到点不会弹出；请在浏览器设置中允许，或改开上方「到点声音提醒」。')
        : ui('浏览器已禁用系统通知权限；请在浏览器设置中允许，或改开上方「到点声音提醒」。'))
    : undefined;

  const handleNotifyToggle = async (checked) => {
    const currentPerm = notificationPermissionState();
    setNotifyPermission(currentPerm);
    if (checked && (currentPerm === 'unsupported' || currentPerm === 'denied')) {
      setNotifyDraft(false);
      return;
    }
    if (checked && currentPerm === 'default' && typeof globalThis.Notification === 'function') {
      try {
        const perm = await globalThis.Notification.requestPermission();
        setNotifyPermission(perm);
        setNotifyDraft(perm === 'granted');
        return;
      } catch {
        setNotifyPermission('denied');
        setNotifyDraft(false);
        return;
      }
    }
    setNotifyDraft(checked);
  };

  const parsedWork = Number(workDraft);
  const parsedBreak = Number(breakDraft);
  const workError = timerMinutesError(workDraft, TIMER_WORK_MAX);
  const breakError = timerMinutesError(breakDraft, TIMER_BREAK_MAX);
  const prefsValid = Number.isInteger(parsedWork) && parsedWork >= 1 && parsedWork <= TIMER_WORK_MAX
    && Number.isInteger(parsedBreak) && parsedBreak >= 1 && parsedBreak <= TIMER_BREAK_MAX;

  const submitPrefs = async (event) => {
    event.preventDefault();
    if (readOnly || savingPrefs || !prefsValid) return;
    setSavingPrefs(true);
    const ok = await onSavePrefs?.({
      workMinutes: parsedWork,
      breakMinutes: parsedBreak,
      sound: soundDraft,
      notify: notifyDraft,
    });
    setSavingPrefs(false);
    if (ok) setPanelMode('');
  };

  const parsedManualMinutes = Number(manualMinutes);
  const manualMinutesError = timerMinutesError(manualMinutes, ACTUAL_MINUTES_MAX);
  const manualHasCard = manualCardId !== CUSTOM_CARD && todayCards.some((card) => card.id === manualCardId);
  const manualTitleError = !manualHasCard && manualTitle.trim() && !isMeaningfulTitle(manualTitle.trim())
    ? ui('请输入有效的专注内容名称')
    : '';
  const manualValid = Number.isInteger(parsedManualMinutes)
    && parsedManualMinutes >= 1
    && parsedManualMinutes <= ACTUAL_MINUTES_MAX
    && (manualHasCard || isMeaningfulTitle(manualTitle.trim()));

  const submitManual = async (event) => {
    event.preventDefault();
    if (readOnly || submittingManual || !manualValid) return;
    setSubmittingManual(true);
    const linked = manualHasCard ? todayCards.find((card) => card.id === manualCardId) : null;
    const ok = await onAddLog?.({
      ...(linked ? { cardId: linked.id, cardTitle: linked.title } : { cardTitle: manualTitle.trim() }),
      minutes: parsedManualMinutes,
      date: today,
    });
    setSubmittingManual(false);
    if (ok) {
      setManualTitle('');
      setPanelMode('');
    }
  };

  const handleComplete = async (currentSnap) => {
    if (!currentSnap || readOnly) return;
    const wasWork = currentSnap.mode === 'work';
    const ok = await onComplete?.(currentSnap);
    if (ok) {
      onFullscreenChange?.(false);
      if (wasWork) setOfferBreak(true);
    }
  };

  const handleCancel = async () => {
    if (readOnly) return;
    const ok = await onCancel?.();
    if (ok) onFullscreenChange?.(false);
  };

  const handleFreeFocus = async (openFullscreen = false) => {
    if (readOnly || !onStartFreeFocus) return;
    setOfferBreak(false);
    const ok = await onStartFreeFocus(ui('自由专注'));
    if (ok && openFullscreen) onFullscreenChange?.(true);
  };

  const startEditLog = (entry) => {
    setEditingLogId(entry.id);
    setEditingMinutes(String(entry.minutes));
  };

  const parsedEditMinutes = Number(editingMinutes);
  const editMinutesError = timerMinutesError(editingMinutes, ACTUAL_MINUTES_MAX);
  const editValid = Number.isInteger(parsedEditMinutes) && parsedEditMinutes >= 1 && parsedEditMinutes <= ACTUAL_MINUTES_MAX;

  const submitEditLog = async (event, entry) => {
    event.preventDefault();
    if (readOnly || savingLogEdit || !editValid) return;
    setSavingLogEdit(true);
    const ok = await onEditLog?.(entry, parsedEditMinutes);
    setSavingLogEdit(false);
    if (ok) setEditingLogId('');
  };

  const activeCard = snap?.cardId ? board?.cards?.[snap.cardId] : null;
  const activeSubtitle = activeCard?.learningTask?.reason || activeCard?.note || '';
  const reversedEntries = useMemo(() => [...todayLog.entries].reverse(), [todayLog.entries]);
  const dialProgress = snap && snap.durationMs > 0
    ? Math.min(1, Math.max(0, snap.elapsedMs / snap.durationMs))
    : 0;
  const dialState = snap
    ? (snap.paused ? 'paused' : snap.finished ? 'finished' : 'running')
    : 'idle';

  return (
    <>
      <section className="board-timer" aria-label={ui('专注计时')}>
        <header className="board-timer__head">
          <div className="board-timer__heading">
            <h3 className="board-timer__title">{ui('专注计时')}</h3>
            <Tooltip
              layer
              content={ui('只计算手动点击「开始专注」或「补记一段」的时长；数据仅保存在本机，不会上传。')}
            >
              <span className="board-today__focus-help" tabIndex={0} role="img" aria-label={ui('专注计时说明')}>
                <Icon name="help" size={14} />
              </span>
            </Tooltip>
          </div>
          <div className="board-timer__head-actions">
            {snap && (
              <IconButton
                icon={<Icon name="fit" size={16} />}
                size="sm"
                label={ui('全屏专注')}
                onClick={() => onFullscreenChange?.(true)}
              />
            )}
            {!readOnly && (
              <Button
                variant="quiet"
                size="sm"
                icon="settings"
                aria-expanded={panelMode === 'prefs'}
                onClick={openPrefsPanel}
              >
                {ui('改时长')}
              </Button>
            )}
          </div>
        </header>

        {snap ? (
          <div className="board-timer__active">
            <div className="board-timer__status-row">
              <span className="board-chip board-timer__badge" data-timer-mode={snap.mode}>
                {timerStateLabel(snap)}
              </span>
              <span className="board-timer__target">
                {snap.mode === 'break' ? ui('休息片刻') : snap.cardTitle}
              </span>
            </div>

            <FocusRitualDial
              size="compact"
              remainingLabel={formatClock(snap.remainingMs)}
              progress={dialProgress}
              mode={snap.mode}
              state={dialState}
              clockClassName="board-timer__clock desk-dial__clock"
              clockState={dialState}
            />

            {snap.mode === 'break' && (
              breathOpen ? (
                <BreathingHalo compact onClose={() => setBreathOpen(false)} />
              ) : (
                <div className="desk-breath-trigger desk-break-rituals">
                  <Button
                    variant="quiet"
                    size="sm"
                    icon="sparkle"
                    onClick={() => setBreathOpen(true)}
                  >
                    {ui('60 秒呼吸引导')}
                  </Button>
                  <Button
                    variant="quiet"
                    size="sm"
                    icon="sparkle"
                    onClick={() => setChimeOpen(true)}
                  >
                    {ui('五声风铃')}
                  </Button>
                </div>
              )
            )}

            <div className="board-timer__controls">
              {!snap.finished && (
                snap.paused ? (
                  <Button variant="secondary" size="sm" icon="play" disabled={readOnly} onClick={onResume}>
                    {ui('继续')}
                  </Button>
                ) : (
                  <Button variant="secondary" size="sm" disabled={readOnly} onClick={onPause}>
                    {ui('暂停')}
                  </Button>
                )
              )}
              <Button
                variant="primary"
                size="sm"
                icon="check"
                disabled={readOnly}
                onClick={() => handleComplete(snap)}
              >
                {snap.mode === 'break'
                  ? ui('结束休息')
                  : uiFormat('完成，记 {0} 分钟', [snap.loggedMinutes])}
              </Button>
              <Button variant="quiet" size="sm" icon="close" disabled={readOnly} onClick={handleCancel}>
                {ui('放弃这一个')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="board-timer__idle">
            <FocusRitualDial
              size="compact"
              state="idle"
              remainingLabel={formatClock(prefs.workMinutes * 60_000)}
              clockClassName="board-timer__clock is-idle desk-dial__clock"
            />
            <p className="board-timer__meta">
              {uiFormat('番茄 {0} 分钟 · 休息 {1} 分钟', [prefs.workMinutes, prefs.breakMinutes])}
            </p>
            {!readOnly && onStartFreeFocus && (
              <div className="desk-free-focus">
                <Button
                  variant="primary"
                  size="sm"
                  icon="play"
                  onClick={() => handleFreeFocus(false)}
                >
                  {ui('自由专注')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  icon="fit"
                  onClick={() => handleFreeFocus(true)}
                >
                  {ui('全屏专注')}
                </Button>
              </div>
            )}
            <p className="board-timer__hint">
              {ui('点卡片上的「开始专注」才开始计时。')}
              {!readOnly && onStartFreeFocus && (
                <span className="desk-free-focus__sub">{ui('也可直接开启一段自由专注。')}</span>
              )}
            </p>
            {offerBreak && !readOnly && (
              <div className="board-timer__break-offer">
                <Button
                  variant="secondary"
                  size="sm"
                  icon="clock"
                  onClick={() => onStartBreak?.(prefs.breakMinutes)}
                >
                  {uiFormat('休息 {0} 分钟', [prefs.breakMinutes])}
                </Button>
                <Button
                  variant="quiet"
                  size="sm"
                  icon="sparkle"
                  aria-expanded={breathOpen}
                  onClick={() => setBreathOpen((open) => !open)}
                >
                  {ui('60 秒呼吸引导')}
                </Button>
                <Button
                  variant="quiet"
                  size="sm"
                  icon="sparkle"
                  onClick={() => setChimeOpen(true)}
                >
                  {ui('五声风铃')}
                </Button>
              </div>
            )}
            {offerBreak && breathOpen && (
              <BreathingHalo compact onClose={() => setBreathOpen(false)} />
            )}
          </div>
        )}

        {panelMode === 'prefs' && !readOnly && (
          <form className="board-timer__form" onSubmit={submitPrefs} aria-label={ui('改时长')}>
            <div className="board-timer__form-grid">
              <Field label={ui('专注时长')} width="full" error={workError || undefined}>
                <NumberInput
                  min={1}
                  max={TIMER_WORK_MAX}
                  step={1}
                  inputMode="numeric"
                  suffix={ui('分钟')}
                  value={workDraft}
                  onChange={(event) => setWorkDraft(event.target.value)}
                />
              </Field>
              <Field label={ui('休息时长')} width="full" error={breakError || undefined}>
                <NumberInput
                  min={1}
                  max={TIMER_BREAK_MAX}
                  step={1}
                  inputMode="numeric"
                  suffix={ui('分钟')}
                  value={breakDraft}
                  onChange={(event) => setBreakDraft(event.target.value)}
                />
              </Field>
            </div>
            <Switch label={ui('到点声音提醒')} checked={soundDraft} onChange={setSoundDraft} />
            <Switch
              label={ui('到点系统通知')}
              checked={notifyDraft}
              disabled={notifyBlocked && !notifyDraft}
              hint={notifyHint}
              onChange={handleNotifyToggle}
            />
            <div className="board-timer__form-actions">
              <Button type="submit" variant="primary" size="sm" busy={savingPrefs} disabled={savingPrefs || !prefsValid}>
                {ui('保存设置')}
              </Button>
              <Button variant="quiet" size="sm" onClick={() => setPanelMode('')}>
                {ui('取消')}
              </Button>
            </div>
          </form>
        )}

        <div className="board-timer__foot">
          <span className="board-timer__summary">
            {uiFormat('今日已专注 {0} 分钟', [todayLog.totalMinutes])}
          </span>
          {!readOnly && (
            <Button
              variant="quiet"
              size="sm"
              icon="plus"
              aria-expanded={panelMode === 'manual'}
              onClick={openManualPanel}
            >
              {ui('补记一段')}
            </Button>
          )}
        </div>

        {panelMode === 'manual' && !readOnly && (
          <form className="board-timer__form" onSubmit={submitManual} aria-label={ui('补记一段')}>
            <Field label={ui('关联卡片')} width="full">
              <Select
                options={cardOptions}
                value={manualCardId}
                onChange={(val) => setManualCardId(val)}
              />
            </Field>
            {manualCardId === CUSTOM_CARD && (
              <Field label={ui('专注内容')} width="full" error={manualTitleError || undefined}>
                <TextInput
                  value={manualTitle}
                  maxLength={500}
                  placeholder={ui('例如：整理错题笔记')}
                  onChange={(event) => setManualTitle(event.target.value)}
                />
              </Field>
            )}
            <Field label={ui('专注时长')} width="full" error={manualMinutesError || undefined}>
              <NumberInput
                min={1}
                max={ACTUAL_MINUTES_MAX}
                step={1}
                inputMode="numeric"
                suffix={ui('分钟')}
                value={manualMinutes}
                onChange={(event) => setManualMinutes(event.target.value)}
              />
            </Field>
            <div className="board-timer__form-actions">
              <Button
                type="submit"
                variant="primary"
                size="sm"
                busy={submittingManual}
                disabled={submittingManual || !manualValid}
              >
                {ui('记录这一段')}
              </Button>
              <Button variant="quiet" size="sm" onClick={() => setPanelMode('')}>
                {ui('取消')}
              </Button>
            </div>
          </form>
        )}

        {reversedEntries.length > 0 && (
          <ul className="board-timer__logs" aria-label={ui('今日专注记录')}>
            {reversedEntries.map((entry) => (
              <li key={entry.id} className="board-timer__log">
                {editingLogId === entry.id ? (
                  <form className="board-timer__log-edit" onSubmit={(event) => submitEditLog(event, entry)}>
                    <span className="board-timer__log-title">{entry.cardTitle}</span>
                    <div className="board-timer__log-edit-row">
                      <NumberInput
                        min={1}
                        max={ACTUAL_MINUTES_MAX}
                        step={1}
                        inputMode="numeric"
                        suffix={ui('分钟')}
                        aria-label={ui('专注时长')}
                        value={editingMinutes}
                        onChange={(event) => setEditingMinutes(event.target.value)}
                      />
                      <Button
                        type="submit"
                        variant="primary"
                        size="sm"
                        busy={savingLogEdit}
                        disabled={savingLogEdit || !editValid}
                      >
                        {ui('保存')}
                      </Button>
                      <Button variant="quiet" size="sm" onClick={() => setEditingLogId('')}>
                        {ui('取消')}
                      </Button>
                    </div>
                    {editMinutesError && <p className="field-error" role="alert">{editMinutesError}</p>}
                  </form>
                ) : (
                  <>
                    <div className="board-timer__log-main">
                      <span className="board-timer__log-time">{formatDateTime(entry.startedAt, 'time')}</span>
                      <span className="board-timer__log-title">{entry.cardTitle}</span>
                    </div>
                    <div className="board-timer__log-side">
                      <span className="board-timer__log-mins">{uiFormat('{0} 分钟', [entry.minutes])}</span>
                      {!readOnly && (
                        <>
                          <IconButton
                            icon={<Icon name="edit" size={14} />}
                            size="sm"
                            label={uiFormat('修改时长：{0}', [entry.cardTitle])}
                            onClick={() => startEditLog(entry)}
                          />
                          <IconButton
                            icon={<Icon name="trash" size={14} />}
                            size="sm"
                            label={uiFormat('删除记录：{0}', [entry.cardTitle])}
                            onClick={() => onRemoveLog?.(entry)}
                          />
                        </>
                      )}
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {fullscreen && snap && (
        <Dialog
          size="full"
          title={ui('全屏专注')}
          closeLabel={ui('退出全屏专注')}
          className="board-focus-dialog"
          bodyClassName="board-focus-dialog__body"
          contentClassName="board-focus-dialog__content"
          onClose={() => onFullscreenChange?.(false)}
        >
          <div className="desk-focus-stage-wrap">
            <FocusAmbientCanvas mode={ambientMode} />
            <div className="desk-focus-stage-inner">
              <div className="board-focus-stage">
                <span className="board-chip board-timer__badge" data-timer-mode={snap.mode}>
                  {timerStateLabel(snap)}
                </span>
                <h3 className="board-focus-stage__title">
                  {snap.mode === 'break' ? ui('休息片刻') : snap.cardTitle}
                </h3>
                {snap.mode === 'work' && activeSubtitle && (
                  <p className="board-focus-stage__note">{activeSubtitle}</p>
                )}
                <FocusRitualDial
                  size="stage"
                  remainingLabel={formatClock(snap.remainingMs)}
                  progress={dialProgress}
                  mode={snap.mode}
                  state={dialState}
                  clockClassName="board-focus-stage__clock desk-dial__clock"
                  clockState={dialState}
                />
                {snap.mode === 'break' && (
                  <div className="board-focus-stage__bar">
                    {breathOpen ? (
                      <BreathingHalo onClose={() => setBreathOpen(false)} />
                    ) : (
                      <div className="desk-breath-trigger desk-break-rituals">
                        <Button
                          variant="quiet"
                          size="sm"
                          icon="sparkle"
                          onClick={() => setBreathOpen(true)}
                        >
                          {ui('60 秒呼吸引导')}
                        </Button>
                        <Button
                          variant="quiet"
                          size="sm"
                          icon="sparkle"
                          onClick={() => setChimeOpen(true)}
                        >
                          {ui('五声风铃')}
                        </Button>
                      </div>
                    )}
                  </div>
                )}
                <div className="board-focus-stage__actions">
                  {!snap.finished && (
                    snap.paused ? (
                      <Button variant="secondary" icon="play" disabled={readOnly} onClick={onResume}>
                        {ui('继续')}
                      </Button>
                    ) : (
                      <Button variant="secondary" disabled={readOnly} onClick={onPause}>
                        {ui('暂停')}
                      </Button>
                    )
                  )}
                  <Button
                    variant="primary"
                    icon="check"
                    disabled={readOnly}
                    onClick={() => handleComplete(snap)}
                  >
                    {snap.mode === 'break'
                      ? ui('结束休息')
                      : uiFormat('完成，记 {0} 分钟', [snap.loggedMinutes])}
                  </Button>
                  <Button variant="quiet" icon="close" disabled={readOnly} onClick={handleCancel}>
                    {ui('放弃这一个')}
                  </Button>
                </div>
                <FocusSoundscapePill />
                <FocusAmbientControls mode={ambientMode} onChange={handleAmbientChange} />
                <p className="board-focus-stage__meta">
                  {joinMeta([
                    uiFormat('今日已专注 {0} 分钟', [todayLog.totalMinutes]),
                    ui('仅保存在本机'),
                  ])}
                </p>
              </div>
            </div>
          </div>
        </Dialog>
      )}
      {chimeOpen && ChimeDialog && (
        <ChimeDialog onClose={() => setChimeOpen(false)} />
      )}
    </>
  );
}
