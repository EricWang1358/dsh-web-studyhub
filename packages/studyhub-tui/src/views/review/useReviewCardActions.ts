import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { HostClient, UiLanguage } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { getReview, startReview, tryAction, type ReviewRun } from '../../host/sample-actions.js';
import type { LruCache } from '../../render/lru.js';
import {
  currentDeckIdOf,
  type CardFeedbackShape,
  type CardTranslation,
  type NormalizedKind,
} from './review-helpers.js';
import { buildGuidedStudyCardContext, type CardGradeResponse } from './review-view-model.js';

export interface UseReviewCardActionsParams {
  host: HostClient;
  lang: UiLanguage;
  notify: (message: string, tone?: 'info' | 'success' | 'warning' | 'error') => void;
  refresh: () => Promise<void>;
  applyRun: (next: ReviewRun | null, shouldRefreshSnapshot?: boolean) => void;
  clearDraftTimer: () => void;
  run: ReviewRun | null;
  cardId: string | null;
  cardKey: string;
  kind: NormalizedKind;
  isRubricEligibleKind: boolean;
  revealed: boolean;
  feedback: CardFeedbackShape | null;
  busy: boolean;
  gradingBusy: boolean;
  focusBusy: boolean;
  translating: boolean;
  showTranslation: boolean;
  userAnswerText: string;
  gradeAnswerText: string;
  flagReason: string;
  focusOverrideByCard: Record<string, boolean>;
  canAdjustGrade: boolean;
  canAckCorrection: boolean;
  mountedRef: MutableRefObject<boolean>;
  busyRef: MutableRefObject<boolean>;
  runRef: MutableRefObject<ReviewRun | null>;
  currentCardIdRef: MutableRefObject<string | null>;
  translationCacheRef: MutableRefObject<LruCache<string, CardTranslation>>;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setFlagModalOpen: Dispatch<SetStateAction<boolean>>;
  setFlagReason: Dispatch<SetStateAction<string>>;
  setGradeAdjustModalOpen: Dispatch<SetStateAction<boolean>>;
  setOpenEditing: Dispatch<SetStateAction<boolean>>;
  setFocusOverrideByCard: Dispatch<SetStateAction<Record<string, boolean>>>;
  setFocusBusy: Dispatch<SetStateAction<boolean>>;
  setGradingBusy: Dispatch<SetStateAction<boolean>>;
  setGradeResult: Dispatch<SetStateAction<CardGradeResponse | null>>;
  setGradeError: Dispatch<SetStateAction<string | null>>;
  setShowTranslation: Dispatch<SetStateAction<boolean>>;
  setTranslating: Dispatch<SetStateAction<boolean>>;
  setTranslationTick: Dispatch<SetStateAction<number>>;
}

export function useReviewCardActions(p: UseReviewCardActionsParams) {
  const {
    host,
    lang,
    notify,
    refresh,
    applyRun,
    clearDraftTimer,
    run,
    cardId,
    cardKey,
    kind,
    isRubricEligibleKind,
    revealed,
    feedback,
    busy,
    gradingBusy,
    focusBusy,
    translating,
    showTranslation,
    userAnswerText,
    gradeAnswerText,
    flagReason,
    focusOverrideByCard,
    canAdjustGrade,
    canAckCorrection,
    mountedRef,
    busyRef,
    runRef,
    currentCardIdRef,
    translationCacheRef,
    setBusy,
    setFlagModalOpen,
    setFlagReason,
    setGradeAdjustModalOpen,
    setOpenEditing,
    setFocusOverrideByCard,
    setFocusBusy,
    setGradingBusy,
    setGradeResult,
    setGradeError,
    setShowTranslation,
    setTranslating,
    setTranslationTick,
  } = p;

  // Monotonic tokens invalidate stale in-flight card actions across rapid card/run switches.
  const translateSeqRef = useRef(0);
  const gradeSeqRef = useRef(0);
  const focusSeqRef = useRef(0);

  useEffect(() => {
    translateSeqRef.current += 1;
    gradeSeqRef.current += 1;
  }, [cardKey]);

  const handleSubmitFlag = useCallback(async () => {
    const deckId = run?.deckId || run?.navigation?.find((n) => n.index === run.index)?.deckId || '';
    if (!deckId || !cardId) {
      setFlagModalOpen(false);
      return;
    }
    const res = await tryAction(host, 'card.flag', {
      deckId,
      cardId,
      reason: flagReason.trim() || t(lang, '需复核/待改进', 'Flagged in review'),
    });
    if (!mountedRef.current) return;
    setFlagModalOpen(false);
    setFlagReason('');
    if (res.ok) notify(t(lang, '已标记题目', 'Card flagged'), 'success');
    else notify(res.error?.message || t(lang, '标记失败', 'Flag failed'), 'error');
  }, [run, cardId, flagReason, host, lang, notify, mountedRef, setFlagModalOpen, setFlagReason]);

  const handleToggleTranslate = useCallback(async () => {
    if (!run?.card || !cardId || translating) return;
    if (showTranslation) {
      setShowTranslation(false);
      return;
    }
    const cached = translationCacheRef.current.get(cardId);
    if (cached) {
      setShowTranslation(true);
      return;
    }
    const deckId = currentDeckIdOf(run);
    const targetCardId = cardId;
    const targetRunId = run.id;
    const seq = ++translateSeqRef.current;
    setTranslating(true);
    const res = await tryAction<{ translation?: CardTranslation | null }>(host, 'card.translate', {
      ...(deckId ? { deckId } : {}),
      cardId: targetCardId,
    });
    if (!mountedRef.current) return;
    const isStillCurrent =
      translateSeqRef.current === seq &&
      currentCardIdRef.current === targetCardId &&
      runRef.current?.id === targetRunId;
    if (res.ok && res.value?.translation) {
      translationCacheRef.current.set(targetCardId, res.value.translation);
      setTranslationTick((v) => v + 1);
      if (isStillCurrent) {
        setTranslating(false);
        setShowTranslation(true);
      }
      return;
    }
    if (!isStillCurrent) return;
    setTranslating(false);
    notify(
      res.error?.message ||
        t(lang, '翻译失败：请先在设置中配置可用模型', 'Translation unavailable: configure a model in Settings'),
      'warning',
    );
  }, [
    run,
    cardId,
    translating,
    showTranslation,
    host,
    notify,
    lang,
    mountedRef,
    runRef,
    translationCacheRef,
    currentCardIdRef,
    setShowTranslation,
    setTranslating,
    setTranslationTick,
  ]);

  const handleRubricGrade = useCallback(async () => {
    if (!run?.id || !cardId || busyRef.current || busy || gradingBusy || !isRubricEligibleKind) return;
    clearDraftTimer();
    const answer = gradeAnswerText;
    if (!answer) {
      notify(
        t(lang, '请先按 [i] 输入作答后再按 [G] AI 评分', 'Press [i] to type your answer before [G] AI rubric grading'),
        'warning',
      );
      return;
    }
    const deckId = currentDeckIdOf(run);
    const cardAtStart = cardId;
    const runAtStart = run.id;
    const seq = ++gradeSeqRef.current;
    const isStillCurrent = () =>
      mountedRef.current &&
      gradeSeqRef.current === seq &&
      runRef.current?.id === runAtStart &&
      currentCardIdRef.current === cardAtStart;

    setGradingBusy(true);
    setGradeError(null);
    const res = await tryAction<CardGradeResponse>(host, 'card.grade', {
      cardId: cardAtStart,
      ...(deckId ? { deckId } : {}),
      answer,
      runId: runAtStart,
      language: lang,
    });
    if (!isStillCurrent()) return;
    setGradingBusy(false);
    if (!res.ok || !res.value) {
      const msg = res.error?.message || t(lang, 'AI 按标准批改失败', 'AI rubric grading failed');
      setGradeError(msg);
      notify(msg, 'warning');
      return;
    }
    setGradeResult(res.value);
    setOpenEditing(false);
    const scoreTotal = res.value.total ?? res.value.rubric?.total ?? 0;
    const scoreMax = res.value.max ?? res.value.rubric?.max ?? 0;
    notify(
      res.value.message ||
        t(lang, `AI 批改完成：${scoreTotal}/${scoreMax} 分`, `AI grading complete: ${scoreTotal}/${scoreMax} marks`),
      'success',
    );
    try {
      const refreshed = await getReview(host, runAtStart);
      if (!isStillCurrent()) return;
      applyRun(refreshed, true);
    } catch {
      // Keep local gradeResult displayed even if run refresh fails
    }
  }, [
    run,
    cardId,
    busyRef,
    busy,
    gradingBusy,
    isRubricEligibleKind,
    clearDraftTimer,
    gradeAnswerText,
    host,
    lang,
    notify,
    applyRun,
    mountedRef,
    runRef,
    currentCardIdRef,
    setGradingBusy,
    setGradeError,
    setGradeResult,
    setOpenEditing,
  ]);

  const handleToggleFocus = useCallback(async () => {
    if (!run?.id || !cardId || focusBusy) return;
    const deckId = currentDeckIdOf(run);
    const targetCardId = cardId;
    const runIdAtStart = run.id;
    const seq = ++focusSeqRef.current;
    setFocusBusy(true);
    const res = await tryAction<{ ok?: boolean; focus?: boolean }>(host, 'card.focus', {
      ...(deckId ? { deckId } : {}),
      cardId: targetCardId,
    });
    if (!mountedRef.current) return;
    if (focusSeqRef.current === seq) setFocusBusy(false);
    if (!res.ok) {
      notify(res.error?.message || t(lang, '切换重点标记失败', 'Failed to toggle focus'), 'error');
      return;
    }
    const nextFocus =
      typeof res.value?.focus === 'boolean'
        ? res.value.focus
        : !(focusOverrideByCard[targetCardId] ?? Boolean(run.card?.focus));
    setFocusOverrideByCard((prev) => ({ ...prev, [targetCardId]: nextFocus }));
    notify(
      nextFocus
        ? t(lang, '已标为考纲重点（优先安排复习）', 'Marked as Focus (priority review)')
        : t(lang, '已取消考纲重点标记', 'Removed Focus mark'),
      'success',
    );
    void refresh();
    try {
      const refreshed = await getReview(host, runIdAtStart);
      const latestRun = runRef.current;
      if (
        mountedRef.current &&
        latestRun &&
        latestRun.id === runIdAtStart &&
        !latestRun.complete &&
        !latestRun.closed &&
        currentCardIdRef.current === targetCardId
      ) {
        applyRun(refreshed);
      }
    } catch {
      // Local focusOverrideByCard keeps badge accurate even if getReview fails
    }
  }, [
    run,
    cardId,
    focusBusy,
    host,
    notify,
    lang,
    focusOverrideByCard,
    refresh,
    applyRun,
    mountedRef,
    runRef,
    currentCardIdRef,
    setFocusBusy,
    setFocusOverrideByCard,
  ]);

  const handleAdjustGrade = useCallback(
    async (grade: number) => {
      if (!run?.id || !cardId || busyRef.current || busy || !canAdjustGrade) return;
      const runIdAtStart = run.id;
      busyRef.current = true;
      setBusy(true);
      try {
        const res = await tryAction<ReviewRun>(host, 'review.grade.adjust', {
          runId: runIdAtStart,
          entryIndex: run.index,
          cardId,
          grade,
        });
        if (!mountedRef.current || runRef.current?.id !== runIdAtStart) return;
        if (!res.ok || !res.value) {
          notify(res.error?.message || t(lang, '调整评分失败', 'Failed to adjust grade'), 'error');
          return;
        }
        setGradeAdjustModalOpen(false);
        setGradeResult(null);
        applyRun(res.value, true);
        notify(t(lang, `已将 AI 评分调整为 ${grade}`, `Adjusted AI grade to ${grade}`), 'success');
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setBusy(false);
      }
    },
    [
      run,
      cardId,
      busy,
      canAdjustGrade,
      host,
      applyRun,
      notify,
      lang,
      busyRef,
      mountedRef,
      runRef,
      setBusy,
      setGradeAdjustModalOpen,
      setGradeResult,
    ],
  );

  const handleAckCorrection = useCallback(async () => {
    if (!run?.id || !cardId || busyRef.current || busy || !canAckCorrection) return;
    const runIdAtStart = run.id;
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await tryAction<ReviewRun>(host, 'review.correction.ack', {
        runId: runIdAtStart,
        entryIndex: run.index,
        cardId,
      });
      if (!mountedRef.current || runRef.current?.id !== runIdAtStart) return;
      if (!res.ok || !res.value) {
        notify(res.error?.message || t(lang, '确认订正失败', 'Failed to acknowledge correction'), 'error');
        return;
      }
      applyRun(res.value, true);
      notify(t(lang, '已确认订正并加入本轮重练', 'Correction acknowledged and queued for retry'), 'success');
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }, [run, cardId, busy, canAckCorrection, host, applyRun, notify, lang, busyRef, mountedRef, runRef, setBusy]);

  const handleRedoCard = useCallback(async () => {
    if (!run || !cardId || busyRef.current || busy) return;
    if (!revealed && !feedback) {
      notify(t(lang, '请先作答或翻看答案后再重做本题', 'Answer or reveal first to redo this card'), 'info');
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const nextRun = await startReview(host, {
        mode: 'path',
        scope: [{ deckId: currentDeckIdOf(run) ?? '', cardId }],
        fresh: true,
      });
      if (!mountedRef.current) return;
      applyRun(nextRun, true);
      notify(t(lang, '已重做当前题目', 'Restarted current card'), 'info');
    } catch (err) {
      if (!mountedRef.current) return;
      notify(err instanceof Error ? err.message : t(lang, '重做题目失败', 'Failed to redo card'), 'error');
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }, [run, cardId, busy, revealed, feedback, host, applyRun, notify, lang, busyRef, mountedRef, setBusy]);

  const openGuidedStudy = useCallback(
    (opts?: { focused?: boolean; extra?: { isWrong?: boolean; revealed?: boolean } }) => {
      if (!run) return;
      const store = useTuiStore.getState();
      store.openAssistant({
        tab: 'guided',
        stage: 'question',
        focused: opts?.focused ?? true,
        cardContext: buildGuidedStudyCardContext({
          prevCtx: store.assistantCardContext,
          run,
          cardId,
          userAnswer: userAnswerText,
          kind,
          extra: opts?.extra,
        }),
      });
    },
    [run, cardId, userAnswerText, kind],
  );

  return {
    handleSubmitFlag,
    handleToggleTranslate,
    handleRubricGrade,
    handleToggleFocus,
    handleAdjustGrade,
    handleAckCorrection,
    handleRedoCard,
    openGuidedStudy,
  };
}
