import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { HostClient, NavigationContext, StudySnapshot, UiLanguage } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { currentCourse } from '../../shell/data.js';
import {
  answerReview,
  currentCardId,
  endReview,
  getReview,
  moveReview,
  revealReview,
  startReview,
  tryAction,
  type ReviewMode,
  type ReviewRun,
} from '../../host/sample-actions.js';
import { saveTuiPreferences } from '../../host/tui-prefs.js';
import {
  toLastPracticeContext,
  type PracticeContextFrame,
  type PracticeOriginKind,
} from '../../state/practice-stack.js';
import type { LruCache } from '../../render/lru.js';
import {
  currentDeckIdOf,
  extractFeedback,
  resolveClozeBlanks,
  skipTargetIndex,
  type CardFeedbackShape,
  type NormalizedKind,
  type CardTranslation,
} from './review-helpers.js';
import {
  DRAFT_SAVE_DEBOUNCE_MS,
  buildGuidedStudyCardContext,
  type CardGradeResponse,
  type PendingDraftRestore,
} from './review-view-model.js';

export interface UseReviewActionsParams {
  host: HostClient;
  lang: UiLanguage;
  navContext: NavigationContext;
  activeRunId: string | null;
  snapshot: StudySnapshot | null;
  setActiveRunId: (id: string | null) => void;
  notify: (message: string, tone?: 'info' | 'success' | 'warning' | 'error') => void;
  refresh: () => Promise<void>;
  run: ReviewRun | null;
  cardId: string | null;
  kind: NormalizedKind;
  isRubricEligibleKind: boolean;
  isSelfGraded: boolean;
  revealed: boolean;
  feedback: CardFeedbackShape | null;
  busy: boolean;
  gradingBusy: boolean;
  focusBusy: boolean;
  translating: boolean;
  showTranslation: boolean;
  openDraft: string;
  userAnswerText: string;
  gradeAnswerText: string;
  flagReason: string;
  endedRestoreFrame: PracticeContextFrame | null;
  focusOverrideByCard: Record<string, boolean>;
  canAdjustGrade: boolean;
  canAckCorrection: boolean;
  mountedRef: MutableRefObject<boolean>;
  busyRef: MutableRefObject<boolean>;
  runRef: MutableRefObject<ReviewRun | null>;
  currentCardIdRef: MutableRefObject<string | null>;
  selectedIdsRef: MutableRefObject<string[]>;
  clozeInputsRef: MutableRefObject<Record<string, string>>;
  openDraftRef: MutableRefObject<string>;
  pendingDraftRestoreRef: MutableRefObject<PendingDraftRestore | null>;
  skipUnmountPushRef: MutableRefObject<boolean>;
  draftTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  translationCacheRef: MutableRefObject<LruCache<string, CardTranslation>>;
  setRun: Dispatch<SetStateAction<ReviewRun | null>>;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setLoadError: Dispatch<SetStateAction<string | null>>;
  setEndedRestoreFrame: Dispatch<SetStateAction<PracticeContextFrame | null>>;
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

export function useReviewActions(p: UseReviewActionsParams) {
  const {
    host,
    lang,
    navContext,
    activeRunId,
    snapshot,
    setActiveRunId,
    notify,
    refresh,
    run,
    cardId,
    kind,
    isRubricEligibleKind,
    isSelfGraded,
    revealed,
    feedback,
    busy,
    gradingBusy,
    focusBusy,
    translating,
    showTranslation,
    openDraft,
    userAnswerText,
    gradeAnswerText,
    flagReason,
    endedRestoreFrame,
    focusOverrideByCard,
    canAdjustGrade,
    canAckCorrection,
    mountedRef,
    busyRef,
    runRef,
    currentCardIdRef,
    selectedIdsRef,
    clozeInputsRef,
    openDraftRef,
    pendingDraftRestoreRef,
    skipUnmountPushRef,
    draftTimerRef,
    translationCacheRef,
    setRun,
    setLoading,
    setBusy,
    setLoadError,
    setEndedRestoreFrame,
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

  const pushCurrentToPracticeStack = useCallback(
    (originKind: PracticeOriginKind) => {
      const activeRun = runRef.current;
      const cid = currentCardId(activeRun);
      if (
        !activeRun?.id ||
        !cid ||
        activeRun.complete ||
        activeRun.closed ||
        Boolean((activeRun as { summary?: unknown }).summary) ||
        (activeRun as { status?: string }).status === 'ended'
      ) {
        return;
      }
      const clozeInfo = resolveClozeBlanks(activeRun.card as Record<string, unknown> | undefined);
      const clozeDrafts = clozeInfo
        ? clozeInfo.blanks.map((b) => clozeInputsRef.current[b.id] ?? '')
        : undefined;
      const fb = extractFeedback(activeRun);
      const frame: PracticeContextFrame = {
        kind: 'review',
        returnPage: 'review',
        runId: activeRun.id,
        cardId: cid,
        deckId: currentDeckIdOf(activeRun) ?? undefined,
        cardIndex: typeof activeRun.index === 'number' ? activeRun.index : 0,
        total: typeof activeRun.total === 'number' ? activeRun.total : undefined,
        promptPreview: String(activeRun.card?.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        draft: fb
          ? undefined
          : {
              selected: selectedIdsRef.current.length > 0 ? [...selectedIdsRef.current] : undefined,
              clozeDrafts: clozeDrafts && clozeDrafts.some((s) => s.length > 0) ? clozeDrafts : undefined,
              openDraft: openDraftRef.current.length > 0 ? openDraftRef.current : undefined,
            },
        submitted: Boolean(fb),
        originKind,
        pushedAt: Date.now(),
      };
      useTuiStore.getState().pushPracticeContext(frame);
      const persistRec = toLastPracticeContext(frame);
      if (persistRec) {
        const dshHome = (host as { dshHome?: string }).dshHome;
        void saveTuiPreferences(
          { lastPracticeContext: persistRec },
          dshHome ? { env: { DSH_HOME: dshHome } } : undefined,
        ).catch(() => {});
      }
    },
    [host, runRef, selectedIdsRef, clozeInputsRef, openDraftRef],
  );

  const clearDraftTimer = useCallback(() => {
    if (draftTimerRef.current !== null) {
      clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
  }, [draftTimerRef]);

  const scheduleDraftSave = useCallback(
    (draftPatch: { text?: string; stepInputs?: Record<string, string>; selected?: string[] }) => {
      clearDraftTimer();
      const activeRun = runRef.current;
      const targetCardId = currentCardIdRef.current;
      if (
        !activeRun?.id ||
        !targetCardId ||
        activeRun.complete ||
        activeRun.closed ||
        activeRun.feedback ||
        !Number.isInteger(activeRun.index)
      ) {
        return;
      }
      const targetRunId = activeRun.id;
      const targetIndex = activeRun.index;
      draftTimerRef.current = setTimeout(() => {
        draftTimerRef.current = null;
        if (!mountedRef.current) return;
        const latestRun = runRef.current;
        if (
          !latestRun ||
          latestRun.id !== targetRunId ||
          latestRun.index !== targetIndex ||
          currentCardIdRef.current !== targetCardId ||
          latestRun.complete ||
          latestRun.closed ||
          latestRun.feedback
        ) {
          return;
        }
        void tryAction(host, 'review.draft.save', {
          runId: targetRunId,
          cardId: targetCardId,
          index: targetIndex,
          draft: draftPatch,
        }).catch(() => undefined);
      }, DRAFT_SAVE_DEBOUNCE_MS);
    },
    [clearDraftTimer, host, draftTimerRef, mountedRef, runRef, currentCardIdRef],
  );

  const applyRun = useCallback(
    (next: ReviewRun | null, shouldRefreshSnapshot = false) => {
      if (!mountedRef.current) return;
      setRun(next);
      setLoadError(null);
      if (next?.id && !next.complete && !next.closed) {
        setActiveRunId(next.id);
      } else if (next && (next.complete || next.closed)) {
        setActiveRunId(null);
      }
      if (shouldRefreshSnapshot) void refresh();
    },
    [mountedRef, setRun, setLoadError, setActiveRunId, refresh],
  );

  const loadInitialRun = useCallback(
    async (forceFresh = false) => {
      clearDraftTimer();
      setLoading(true);
      setLoadError(null);
      setEndedRestoreFrame(null);
      const pendingRestore = !forceFresh ? useTuiStore.getState().consumePendingPracticeRestore() : null;
      const targetRunId = !forceFresh ? pendingRestore?.runId || navContext.runId || activeRunId : null;
      if (targetRunId) {
        const res = await tryAction<ReviewRun>(host, 'review.get', { runId: targetRunId });
        if (!mountedRef.current) return;
        if (res.ok && res.value) {
          if (pendingRestore && (res.value.complete || res.value.closed)) {
            setLoading(false);
            setRun(null);
            setEndedRestoreFrame(pendingRestore);
            return;
          }
          let restoredRun = res.value;
          if (
            pendingRestore &&
            typeof pendingRestore.cardIndex === 'number' &&
            restoredRun.index !== pendingRestore.cardIndex &&
            !restoredRun.complete &&
            !restoredRun.closed
          ) {
            const moved = await tryAction<ReviewRun>(host, 'review.move', {
              runId: restoredRun.id,
              index: pendingRestore.cardIndex,
            });
            if (!mountedRef.current) return;
            if (moved.ok && moved.value) restoredRun = moved.value;
          }
          if (pendingRestore) {
            pendingDraftRestoreRef.current = {
              cardId: pendingRestore.cardId,
              draft: pendingRestore.draft,
              submitted: pendingRestore.submitted,
            };
          }
          setLoading(false);
          applyRun(restoredRun);
          return;
        }
        if (pendingRestore) {
          setLoading(false);
          setRun(null);
          setEndedRestoreFrame(pendingRestore);
          return;
        }
      }

      const course = navContext.course ?? currentCourse(snapshot) ?? undefined;
      const mode: ReviewMode = (navContext.mode as ReviewMode) || 'path';
      const args: Record<string, unknown> = {
        mode,
        ...(navContext.deckId ? { deckId: navContext.deckId } : {}),
        ...(course && !navContext.deckId ? { course } : {}),
        ...(!navContext.deckId && !course ? { currentCourse: true } : {}),
        ...(forceFresh ? { fresh: true } : {}),
      };
      const startRes = await tryAction<ReviewRun>(host, 'review.start', args);
      if (!mountedRef.current) return;
      setLoading(false);
      if (startRes.ok && startRes.value) {
        applyRun(startRes.value);
      } else {
        setRun(null);
        setLoadError(startRes.error?.message || t(lang, '当前没有待复习题目', 'No questions due right now'));
      }
    },
    [
      host,
      navContext.runId,
      navContext.deckId,
      navContext.course,
      navContext.mode,
      activeRunId,
      snapshot,
      applyRun,
      clearDraftTimer,
      lang,
      mountedRef,
      pendingDraftRestoreRef,
      setLoading,
      setLoadError,
      setEndedRestoreFrame,
      setRun,
    ],
  );

  const runAction = useCallback(
    async (fn: () => Promise<ReviewRun>, refreshAfter = false) => {
      if (busy) return;
      setBusy(true);
      try {
        const next = await fn();
        applyRun(next, refreshAfter || Boolean(next.complete || next.closed));
      } catch (err) {
        if (mountedRef.current) notify(err instanceof Error ? err.message : String(err), 'error');
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    [busy, applyRun, notify, mountedRef, setBusy],
  );

  const handleReveal = useCallback(() => {
    if (!run?.id || !cardId || busy || revealed) return;
    clearDraftTimer();
    const serverDraftText =
      typeof (run as { draft?: { text?: unknown } } | null)?.draft?.text === 'string'
        ? ((run as { draft?: { text?: string } }).draft?.text ?? '')
        : '';
    const shouldFlushOpenDraft = isRubricEligibleKind && openDraft !== serverDraftText;
    const pendingDraftText = openDraft;
    void runAction(async () => {
      if (shouldFlushOpenDraft) {
        await tryAction(host, 'review.draft.save', {
          runId: run.id,
          cardId,
          index: run.index,
          draft: { text: pendingDraftText },
        });
      }
      return revealReview(host, {
        runId: run.id,
        cardId,
        queueVersion: run.queueVersion ?? 0,
      });
    });
  }, [run, cardId, busy, revealed, clearDraftTimer, isRubricEligibleKind, openDraft, runAction, host]);

  const handleSubmitChoice = useCallback(
    (ids: string[]) => {
      if (!run?.id || !cardId || busy || feedback || ids.length === 0) return;
      clearDraftTimer();
      void runAction(() =>
        answerReview(host, {
          runId: run.id,
          cardId,
          selected: ids,
          queueVersion: run.queueVersion ?? 0,
        }),
      );
    },
    [run, cardId, busy, feedback, clearDraftTimer, runAction, host],
  );

  const handleSubmitCloze = useCallback(
    (vals: Record<string, string>) => {
      if (!run?.id || !cardId || busy || feedback) return;
      const anyFilled = Object.values(vals).some((v) => String(v || '').trim().length > 0);
      if (!anyFilled) {
        notify(t(lang, '请先填写至少一个空格', 'Fill in at least one blank first'), 'warning');
        return;
      }
      clearDraftTimer();
      void runAction(() =>
        answerReview(host, {
          runId: run.id,
          cardId,
          answers: vals,
          draft: { stepInputs: vals },
          queueVersion: run.queueVersion ?? 0,
        }),
      );
    },
    [run, cardId, busy, feedback, clearDraftTimer, runAction, host, notify, lang],
  );

  const handleFsrsGrade = useCallback(
    (grade: number) => {
      if (!run?.id || !cardId || busy || feedback || !revealed) return;
      clearDraftTimer();
      const practice = (snapshot?.settings as { practice?: Record<string, unknown> } | undefined)?.practice;
      const selfGradeAdvanceEnabled =
        practice?.selfGradeAdvance !== false &&
        practice?.autoAdvance !== false &&
        practice?.advanceOnPass !== false &&
        practice?.advanceOnSelfGrade !== false;
      const advanceOnSelfGrade = grade >= 3 && selfGradeAdvanceEnabled && run.mode !== 'exam';
      void runAction(() =>
        answerReview(host, {
          runId: run.id,
          cardId,
          grade,
          advanceOnSelfGrade,
          ...(isRubricEligibleKind && openDraft.length > 0 ? { draft: { text: openDraft } } : {}),
          queueVersion: run.queueVersion ?? 0,
        }),
      );
    },
    [run, cardId, busy, feedback, revealed, clearDraftTimer, snapshot, isRubricEligibleKind, openDraft, runAction, host],
  );

  const handleMove = useCallback(
    (direction: -1 | 1) => {
      if (!run?.id || busy) return;
      if (direction === 1 && !feedback && !revealed) {
        notify(t(lang, '请先作答，或按 [s] 跳过本题', 'Answer first or press [s] to skip'), 'info');
        return;
      }
      if (direction === 1 && revealed && !feedback && isSelfGraded) {
        notify(t(lang, '请先用 [0-5] 评分', 'Rate with [0-5] first'), 'info');
        return;
      }
      clearDraftTimer();
      void runAction(() => moveReview(host, run.id, { direction }));
    },
    [run, busy, feedback, revealed, isSelfGraded, clearDraftTimer, runAction, host, notify, lang],
  );

  const handleSkip = useCallback(() => {
    if (!run?.id || !cardId || busy || feedback) return;
    if (run.card?.publicationUngrable) {
      clearDraftTimer();
      void runAction(async () => {
        const res = await tryAction<ReviewRun>(host, 'review.skip', {
          runId: run.id,
          cardId,
          queueVersion: run.queueVersion ?? 0,
        });
        if (!res.ok || !res.value) throw new Error(res.error?.message || 'Skip failed');
        return res.value;
      });
      return;
    }
    const target = skipTargetIndex(run);
    if (target === null) {
      notify(t(lang, '这是最后一题待答题目，无法跳过', 'This is the last unanswered question'), 'info');
      return;
    }
    clearDraftTimer();
    void runAction(() => moveReview(host, run.id, { index: target }));
  }, [run, cardId, busy, feedback, clearDraftTimer, runAction, host, notify, lang]);

  const handleUndo = useCallback(() => {
    if (!run?.id || busy) return;
    const undoable = (run as { undoable?: unknown }).undoable;
    if (!undoable || run.mode === 'exam') {
      notify(t(lang, '当前没有可撤销的评分', 'Nothing to undo in this round'), 'info');
      return;
    }
    clearDraftTimer();
    const attemptId =
      typeof undoable === 'object' && undoable !== null && 'attemptId' in undoable
        ? (undoable as { attemptId?: string }).attemptId
        : undefined;
    void runAction(async () => {
      const res = await tryAction<ReviewRun>(host, 'review.undo', {
        runId: run.id,
        ...(attemptId ? { attemptId } : {}),
      });
      if (!res.ok || !res.value) throw new Error(res.error?.message || 'Undo failed');
      notify(t(lang, '已撤销上一题评分', 'Undid last rating'), 'success');
      return res.value;
    }, true);
  }, [run, busy, clearDraftTimer, runAction, host, notify, lang]);

  const handleEndRound = useCallback(() => {
    if (!run?.id || busy) return;
    clearDraftTimer();
    skipUnmountPushRef.current = true;
    const endedId = run.id;
    useTuiStore.setState((st) => ({
      practiceStack: st.practiceStack.filter((f) => f.runId !== endedId),
    }));
    void runAction(() => endReview(host, endedId), true);
  }, [run, busy, clearDraftTimer, runAction, host, skipUnmountPushRef]);

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

  const handlePracticeWeak = useCallback(() => {
    if (!run?.id || busy) return;
    clearDraftTimer();
    void runAction(async () => {
      const res = await tryAction<ReviewRun>(host, 'review.weak.start', { runId: run.id });
      if (!res.ok || !res.value) {
        throw new Error(res.error?.message || t(lang, '本轮暂无薄弱题', 'No weak cards to retry'));
      }
      return res.value;
    });
  }, [run, busy, clearDraftTimer, runAction, host, lang]);

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
    setTranslating(true);
    const res = await tryAction<{ translation?: CardTranslation | null }>(host, 'card.translate', {
      ...(deckId ? { deckId } : {}),
      cardId,
    });
    if (!mountedRef.current) return;
    setTranslating(false);
    if (res.ok && res.value?.translation) {
      translationCacheRef.current.set(cardId, res.value.translation);
      setTranslationTick((v) => v + 1);
      if (currentCardIdRef.current === cardId) {
        setShowTranslation(true);
      }
      return;
    }
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
    translationCacheRef,
    currentCardIdRef,
    setShowTranslation,
    setTranslating,
    setTranslationTick,
  ]);

  const handleRubricGrade = useCallback(async () => {
    if (!run?.id || !cardId || busy || gradingBusy || !isRubricEligibleKind) return;
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
    setGradingBusy(true);
    setGradeError(null);
    const res = await tryAction<CardGradeResponse>(host, 'card.grade', {
      cardId,
      ...(deckId ? { deckId } : {}),
      answer,
      runId: run.id,
      language: lang,
    });
    if (!mountedRef.current || currentCardIdRef.current !== cardAtStart) return;
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
      const refreshed = await getReview(host, run.id);
      if (!mountedRef.current || currentCardIdRef.current !== cardAtStart) return;
      applyRun(refreshed, true);
    } catch {
      // Keep local gradeResult displayed even if run refresh fails
    }
  }, [
    run,
    cardId,
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
    setFocusBusy(true);
    const res = await tryAction<{ ok?: boolean; focus?: boolean }>(host, 'card.focus', {
      ...(deckId ? { deckId } : {}),
      cardId: targetCardId,
    });
    if (!mountedRef.current) return;
    setFocusBusy(false);
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
      const refreshed = await getReview(host, run.id);
      if (mountedRef.current) applyRun(refreshed);
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
    setFocusBusy,
    setFocusOverrideByCard,
  ]);

  const handleAdjustGrade = useCallback(
    async (grade: number) => {
      if (!run?.id || !cardId || busyRef.current || busy || !canAdjustGrade) return;
      busyRef.current = true;
      setBusy(true);
      try {
        const res = await tryAction<ReviewRun>(host, 'review.grade.adjust', {
          runId: run.id,
          entryIndex: run.index,
          cardId,
          grade,
        });
        if (!mountedRef.current) return;
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
      setBusy,
      setGradeAdjustModalOpen,
      setGradeResult,
    ],
  );

  const handleAckCorrection = useCallback(async () => {
    if (!run?.id || !cardId || busyRef.current || busy || !canAckCorrection) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await tryAction<ReviewRun>(host, 'review.correction.ack', {
        runId: run.id,
        entryIndex: run.index,
        cardId,
      });
      if (!mountedRef.current) return;
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
  }, [run, cardId, busy, canAckCorrection, host, applyRun, notify, lang, busyRef, mountedRef, setBusy]);

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

  const handleRetryEndedCard = useCallback(async () => {
    if (!endedRestoreFrame?.cardId) return;
    setLoading(true);
    setEndedRestoreFrame(null);
    try {
      const nextRun = await startReview(host, {
        mode: 'path',
        scope: [{ deckId: endedRestoreFrame.deckId || '', cardId: endedRestoreFrame.cardId }],
        fresh: true,
      });
      if (!mountedRef.current) return;
      setLoading(false);
      applyRun(nextRun, true);
    } catch (err) {
      if (!mountedRef.current) return;
      setLoading(false);
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [endedRestoreFrame, host, applyRun, mountedRef, setLoading, setEndedRestoreFrame, setLoadError]);

  const openGuidedStudy = useCallback(
    (opts?: { focused?: boolean; extra?: { isWrong?: boolean; revealed?: boolean } }) => {
      if (!run) return;
      const store = useTuiStore.getState();
      store.openAssistant({
        tab: 'guided',
        stage: 'question',
        ...(opts?.focused !== undefined ? { focused: opts.focused } : { focused: true }),
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
    pushCurrentToPracticeStack,
    clearDraftTimer,
    scheduleDraftSave,
    applyRun,
    loadInitialRun,
    handleReveal,
    handleSubmitChoice,
    handleSubmitCloze,
    handleFsrsGrade,
    handleMove,
    handleSkip,
    handleUndo,
    handleEndRound,
    handleSubmitFlag,
    handlePracticeWeak,
    handleToggleTranslate,
    handleRubricGrade,
    handleToggleFocus,
    handleAdjustGrade,
    handleAckCorrection,
    handleRedoCard,
    handleRetryEndedCard,
    openGuidedStudy,
  };
}
