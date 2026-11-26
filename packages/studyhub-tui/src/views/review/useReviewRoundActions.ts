import { useCallback, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { HostClient, NavigationContext, StudySnapshot, UiLanguage } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { currentCourse } from '../../shell/data.js';
import {
  answerReview,
  currentCardId,
  endReview,
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
import {
  currentDeckIdOf,
  extractFeedback,
  resolveClozeBlanks,
  skipTargetIndex,
  type CardFeedbackShape,
} from './review-helpers.js';
import { DRAFT_SAVE_DEBOUNCE_MS, type PendingDraftRestore } from './review-view-model.js';

export interface UseReviewRoundActionsParams {
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
  isRubricEligibleKind: boolean;
  isSelfGraded: boolean;
  revealed: boolean;
  feedback: CardFeedbackShape | null;
  busy: boolean;
  openDraft: string;
  endedRestoreFrame: PracticeContextFrame | null;
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
  setRun: Dispatch<SetStateAction<ReviewRun | null>>;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setLoadError: Dispatch<SetStateAction<string | null>>;
  setEndedRestoreFrame: Dispatch<SetStateAction<PracticeContextFrame | null>>;
}

export function useReviewRoundActions(p: UseReviewRoundActionsParams) {
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
    isRubricEligibleKind,
    isSelfGraded,
    revealed,
    feedback,
    busy,
    openDraft,
    endedRestoreFrame,
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
    setRun,
    setLoading,
    setBusy,
    setLoadError,
    setEndedRestoreFrame,
  } = p;

  const loadSeqRef = useRef(0);

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
      const seq = ++loadSeqRef.current;
      clearDraftTimer();
      setLoading(true);
      setLoadError(null);
      setEndedRestoreFrame(null);
      const pendingRestore = !forceFresh ? useTuiStore.getState().consumePendingPracticeRestore() : null;
      const targetRunId = !forceFresh ? pendingRestore?.runId || navContext.runId || activeRunId : null;
      if (targetRunId) {
        const res = await tryAction<ReviewRun>(host, 'review.get', { runId: targetRunId });
        if (!mountedRef.current || loadSeqRef.current !== seq) return;
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
            if (!mountedRef.current || loadSeqRef.current !== seq) return;
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
      if (!mountedRef.current || loadSeqRef.current !== seq) return;
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
      if (busyRef.current || busy) return;
      busyRef.current = true;
      setBusy(true);
      try {
        const next = await fn();
        applyRun(next, refreshAfter || Boolean(next.complete || next.closed));
      } catch (err) {
        if (mountedRef.current) notify(err instanceof Error ? err.message : String(err), 'error');
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setBusy(false);
      }
    },
    [busy, busyRef, applyRun, notify, mountedRef, setBusy],
  );

  const handleReveal = useCallback(() => {
    if (!run?.id || !cardId || busyRef.current || busy || revealed) return;
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
  }, [run, cardId, busyRef, busy, revealed, clearDraftTimer, isRubricEligibleKind, openDraft, runAction, host]);

  const handleSubmitChoice = useCallback(
    (ids: string[]) => {
      if (!run?.id || !cardId || busyRef.current || busy || feedback || ids.length === 0) return;
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
    [run, cardId, busyRef, busy, feedback, clearDraftTimer, runAction, host],
  );

  const handleSubmitCloze = useCallback(
    (vals: Record<string, string>) => {
      if (!run?.id || !cardId || busyRef.current || busy || feedback) return;
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
    [run, cardId, busyRef, busy, feedback, clearDraftTimer, runAction, host, notify, lang],
  );

  const handleFsrsGrade = useCallback(
    (grade: number) => {
      if (!run?.id || !cardId || busyRef.current || busy || feedback || !revealed) return;
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
    [
      run,
      cardId,
      busyRef,
      busy,
      feedback,
      revealed,
      clearDraftTimer,
      snapshot,
      isRubricEligibleKind,
      openDraft,
      runAction,
      host,
    ],
  );

  const handleMove = useCallback(
    (direction: -1 | 1) => {
      if (!run?.id || busyRef.current || busy) return;
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
    [run, busyRef, busy, feedback, revealed, isSelfGraded, clearDraftTimer, runAction, host, notify, lang],
  );

  const handleSkip = useCallback(() => {
    if (!run?.id || !cardId || busyRef.current || busy || feedback) return;
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
  }, [run, cardId, busyRef, busy, feedback, clearDraftTimer, runAction, host, notify, lang]);

  const handleUndo = useCallback(() => {
    if (!run?.id || busyRef.current || busy) return;
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
  }, [run, busyRef, busy, clearDraftTimer, runAction, host, notify, lang]);

  const handleEndRound = useCallback(() => {
    if (!run?.id || busyRef.current || busy) return;
    clearDraftTimer();
    skipUnmountPushRef.current = true;
    const endedId = run.id;
    useTuiStore.setState((st) => ({
      practiceStack: st.practiceStack.filter((f) => f.runId !== endedId),
    }));
    void runAction(() => endReview(host, endedId), true);
  }, [run, busyRef, busy, clearDraftTimer, runAction, host, skipUnmountPushRef]);

  const handlePracticeWeak = useCallback(() => {
    if (!run?.id || busyRef.current || busy) return;
    clearDraftTimer();
    void runAction(async () => {
      const res = await tryAction<ReviewRun>(host, 'review.weak.start', { runId: run.id });
      if (!res.ok || !res.value) {
        throw new Error(res.error?.message || t(lang, '本轮暂无薄弱题', 'No weak cards to retry'));
      }
      return res.value;
    });
  }, [run, busyRef, busy, clearDraftTimer, runAction, host, lang]);

  const handleRetryEndedCard = useCallback(async () => {
    if (!endedRestoreFrame?.cardId) return;
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setEndedRestoreFrame(null);
    try {
      const nextRun = await startReview(host, {
        mode: 'path',
        scope: [{ deckId: endedRestoreFrame.deckId || '', cardId: endedRestoreFrame.cardId }],
        fresh: true,
      });
      if (!mountedRef.current || loadSeqRef.current !== seq) return;
      setLoading(false);
      applyRun(nextRun, true);
    } catch (err) {
      if (!mountedRef.current || loadSeqRef.current !== seq) return;
      setLoading(false);
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [endedRestoreFrame, host, applyRun, mountedRef, setLoading, setEndedRestoreFrame, setLoadError]);

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
    handlePracticeWeak,
    handleRetryEndedCard,
  };
}
