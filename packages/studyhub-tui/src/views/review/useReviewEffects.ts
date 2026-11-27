import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { ReviewRun } from '../../host/sample-actions.js';
import type { StudySnapshot, UiLanguage } from '../../types/contracts.js';
import { useTuiStore } from '../../state/store.js';
import { buildReviewWindowTitle, writeTerminalTitle } from '../../render/terminal-title.js';
import {
  extractUserAnswerText,
  type CardFeedbackShape,
  type CardSolutionShape,
  type NormalizedKind,
} from './review-helpers.js';
import { shouldScheduleStuckNudge } from './stuck-nudge.js';
import {
  buildWrongStreakBanner,
  createWrongStreakState,
  recordReviewOutcome,
  shouldTriggerWrongStreakNudge,
  type WrongStreakState,
} from './wrong-streak-nudge.js';
import { buildFatigueNudgeBanner, shouldShowFatigueNudge } from './fatigue-nudge.js';
import { buildAssistantCardContextPayload } from './review-view-model.js';

export interface UseReviewEffectsParams {
  run: ReviewRun | null;
  cardId: string | null;
  cardKey: string;
  kind: NormalizedKind;
  isFinished: boolean;
  hasActiveRound: boolean;
  revealed: boolean;
  feedback: CardFeedbackShape | null;
  solution: CardSolutionShape | null;
  hasCitation: boolean;
  canCoachNudge: boolean;
  nudgeModalOpen: boolean;
  setNudgeModalOpen: Dispatch<SetStateAction<boolean>>;
  proactiveHints: boolean;
  isActive: boolean;
  clozeEditing: boolean;
  openEditing: boolean;
  cardScopeActive: boolean;
  selectedIds: string[];
  clozeInputs: Record<string, string>;
  openDraft: string;
  lang: UiLanguage;
  asciiMode: boolean;
  stuckActivityTick: number;
  stuckNudgeDelayMs: number;
  sources?: StudySnapshot['sources'];
  mountedRef: MutableRefObject<boolean>;
  currentCardIdRef: MutableRefObject<string | null>;
  setStuckNudgeVisible: Dispatch<SetStateAction<boolean>>;
  setWrongStreakBanner: Dispatch<SetStateAction<string | null>>;
  setFatigueBanner: Dispatch<SetStateAction<string | null>>;
}

export function useReviewEffects(p: UseReviewEffectsParams): void {
  const {
    run,
    cardId,
    cardKey,
    kind,
    isFinished,
    hasActiveRound,
    revealed,
    feedback,
    solution,
    hasCitation,
    canCoachNudge,
    nudgeModalOpen,
    setNudgeModalOpen,
    proactiveHints,
    isActive,
    clozeEditing,
    openEditing,
    cardScopeActive,
    selectedIds,
    clozeInputs,
    openDraft,
    lang,
    asciiMode,
    stuckActivityTick,
    stuckNudgeDelayMs,
    sources,
    mountedRef,
    currentCardIdRef,
    setStuckNudgeVisible,
    setWrongStreakBanner,
    setFatigueBanner,
  } = p;

  const nudgedCardIdsRef = useRef<Set<string>>(new Set());
  const roundNudgeCountRef = useRef(0);
  const lastNudgeAtRef = useRef<number | null>(null);
  const wrongStreakRef = useRef<WrongStreakState>(createWrongStreakState());
  const fatigueShownRef = useRef(false);

  // Guard quit while an active review round is open
  useEffect(() => {
    if (!hasActiveRound) return undefined;
    return useTuiStore.getState().registerQuitGuard(() => {
      useTuiStore.getState().setQuitConfirmOpen(true);
      return true;
    });
  }, [hasActiveRound]);

  // Auto-close coach nudge modal when card no longer qualifies
  useEffect(() => {
    if (!canCoachNudge && nudgeModalOpen) {
      setNudgeModalOpen(false);
    }
  }, [canCoachNudge, nudgeModalOpen, setNudgeModalOpen]);

  // Clear inline proactive banners when moving to another card
  useEffect(() => {
    setStuckNudgeVisible(false);
    setWrongStreakBanner(null);
    setFatigueBanner(null);
  }, [cardKey, setStuckNudgeVisible, setWrongStreakBanner, setFatigueBanner]);

  // Round 95 Track D9: Proactive pacing fatigue rest suggestion (>= 25 answered, max 1/round)
  useEffect(() => {
    const answeredInRound = Number(run?.answered ?? 0) || 0;
    if (
      shouldShowFatigueNudge({
        enabled: proactiveHints,
        isActive,
        isEditing: clozeEditing || openEditing,
        anyModalOpen: !cardScopeActive,
        answeredInRound,
        alreadyShownInRound: fatigueShownRef.current,
      })
    ) {
      fatigueShownRef.current = true;
      setFatigueBanner(buildFatigueNudgeBanner(answeredInRound, lang, asciiMode));
    }
  }, [run?.answered, proactiveHints, isActive, clozeEditing, openEditing, cardScopeActive, lang, asciiMode, setFatigueBanner]);

  // Round 86 Track D3: Proactive 3-wrong streak attribution banner
  useEffect(() => {
    if (!cardId || !feedback) return;
    const next = recordReviewOutcome(wrongStreakRef.current, {
      cardId,
      prompt: String(run?.card?.prompt || ''),
      userAnswer: extractUserAnswerText(run, kind, selectedIds, clozeInputs, openDraft, lang),
      topic: typeof run?.card?.topic === 'string' ? run.card.topic : undefined,
      correct: feedback.correct,
      grade: feedback.grade,
    });
    wrongStreakRef.current = next;
    if (
      shouldTriggerWrongStreakNudge({
        enabled: proactiveHints,
        isActive,
        isEditing: clozeEditing || openEditing,
        anyModalOpen: !cardScopeActive,
        state: next,
      })
    ) {
      wrongStreakRef.current = {
        recentWrong: [],
        roundNudgeCount: next.roundNudgeCount + 1,
        lastNudgeAt: Date.now(),
      };
      setWrongStreakBanner(buildWrongStreakBanner(next.recentWrong, lang, asciiMode));
    }
  }, [
    cardId,
    feedback,
    proactiveHints,
    isActive,
    clozeEditing,
    openEditing,
    cardScopeActive,
    run,
    kind,
    selectedIds,
    clozeInputs,
    openDraft,
    lang,
    asciiMode,
    setWrongStreakBanner,
  ]);

  // Round 83 Track D1: Proactive 20s stuck nudge (one-shot, never interrupts typing)
  useEffect(() => {
    if (
      !shouldScheduleStuckNudge({
        enabled: proactiveHints,
        isActive,
        revealed,
        hasFeedback: Boolean(feedback),
        isEditing: clozeEditing || openEditing,
        anyModalOpen: !cardScopeActive,
        cardId,
        nudgedCardIds: nudgedCardIdsRef.current,
        roundNudgeCount: roundNudgeCountRef.current,
        lastNudgeAt: lastNudgeAtRef.current,
      })
    ) {
      return undefined;
    }
    const targetCardId = cardId!;
    const timer = setTimeout(() => {
      if (!mountedRef.current || currentCardIdRef.current !== targetCardId) return;
      nudgedCardIdsRef.current.add(targetCardId);
      roundNudgeCountRef.current += 1;
      lastNudgeAtRef.current = Date.now();
      setStuckNudgeVisible(true);
    }, Math.max(10, stuckNudgeDelayMs));
    return () => clearTimeout(timer);
  }, [
    proactiveHints,
    isActive,
    revealed,
    feedback,
    clozeEditing,
    openEditing,
    cardScopeActive,
    cardId,
    stuckActivityTick,
    stuckNudgeDelayMs,
    mountedRef,
    currentCardIdRef,
    setStuckNudgeVisible,
  ]);

  // Round 87 Track C4: OSC 2 terminal window title with live review progress
  useEffect(() => {
    if (!run || isFinished) return undefined;
    const total = Math.max(1, Number(run.total || run.navigation?.length || 1));
    const at = Math.min(total, Number(run.position?.at ?? run.index + 1) || 1);
    writeTerminalTitle(
      buildReviewWindowTitle({ at, total, title: typeof run.title === 'string' ? run.title : undefined, lang }),
      { asciiMode },
    );
    return undefined;
  }, [run, isFinished, lang, asciiMode]);

  useEffect(() => () => {
    writeTerminalTitle('StudyHub', { asciiMode });
  }, [asciiMode]);

  // Sync rich current card context into persistent AI Assistant (#1315/#1319/#1445)
  useEffect(() => {
    if (!run || !cardId || isFinished) return;
    useTuiStore.getState().setAssistantCardContext(
      buildAssistantCardContextPayload({
        run,
        cardId,
        kind,
        selectedIds,
        clozeInputs,
        openDraft,
        feedback,
        revealed,
        hasCitation,
        lang,
        solution,
        sources,
      }),
    );
  }, [
    run,
    cardId,
    isFinished,
    kind,
    selectedIds,
    clozeInputs,
    openDraft,
    feedback,
    revealed,
    hasCitation,
    lang,
    solution,
    sources,
  ]);
}
