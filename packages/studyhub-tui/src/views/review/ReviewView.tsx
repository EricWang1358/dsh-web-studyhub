import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useKeyScope } from '../../input/hooks.js';
import type { KeyHint, ViewProps } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { useShellActions } from '../../shell/actions.js';
import { currentCardId, type ReviewRun } from '../../host/sample-actions.js';
import { useTheme } from '../../theme/tokens.js';
import { Divider } from '../../components/Badge.js';
import { LAYOUT_BP, computeProseLayout } from '../../layout/index.js';
import { MarkdownView } from '../../components/MarkdownView.js';
import { Panel } from '../../components/Panel.js';
import { useFooterHints } from '../../components/hooks.js';
import { ClickableBox } from '../../components/mouse.js';
import { saveTuiPreferences } from '../../host/tui-prefs.js';
import type { PracticeContextFrame } from '../../state/practice-stack.js';
import { LruCache } from '../../render/lru.js';
import { renderMarkdownLines } from '../../render/markdown.js';
import { displayWidth } from '../../render/cjk.js';
import { buildFileHyperlinkUrl } from '../../render/osc8.js';
import {
  MAX_TRANSLATION_CACHE,
  buildClozeBlankDiffs,
  canAdjustAiGrade,
  extractCitation,
  extractFeedback,
  extractReferenceAnswer,
  extractSolution,
  extractUserAnswerText,
  kindLabel,
  normalizeCardKind,
  resolveClozeBlanks,
  resolveOptions,
  type AiTurn,
  type CardFeedbackShape,
  type CardOptionItem,
  type CardTranslation,
} from './review-helpers.js';
import type { SavedFollowupItem } from './AiHelpDrawer.js';
import type { CoachNudgeNote } from './CoachNudgeModal.js';
import { STUCK_NUDGE_DELAY_MS } from './stuck-nudge.js';
import {
  EMPTY_CLAIMED_KEYS,
  buildCardClaimedKeys,
  buildPostAnswerMarkdown,
  buildReviewFooterHints,
  buildReviewStemMarkdown,
  countSavedFollowups,
  isRubricEligibleCardKind,
  resolveInitialCardDraft,
  resolvePracticeReturnOrigin,
  type CardGradeResponse,
  type PendingDraftRestore,
  type RubricSummaryShape,
} from './review-view-model.js';
import { useReviewRoundActions } from './useReviewRoundActions.js';
import { useReviewCardActions } from './useReviewCardActions.js';
import { useReviewEffects } from './useReviewEffects.js';
import { handleReviewCardKey, handleReviewEmptyKey } from './review-key-handler.js';
import { ReviewEmptyStates } from './ReviewEmptyStates.js';
import { ReviewCardTopBar, ReviewStuckNudgeBanner } from './ReviewCardChrome.js';
import { ReviewAnswerInput } from './ReviewAnswerInput.js';
import {
  ReviewFeedbackHeader,
  ReviewPostAnswerFooter,
  ReviewQuickActionStrip,
} from './ReviewFeedbackSections.js';
import { ReviewOverlays } from './ReviewOverlays.js';

export const ReviewView: React.FC<ViewProps & { stuckNudgeDelayMs?: number }> = ({
  host,
  width,
  height,
  isActive,
  stuckNudgeDelayMs = STUCK_NUDGE_DELAY_MS,
}) => {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const mathUnicode = useTuiStore((s) => s.preferences.mathUnicode);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const proactiveHints = useTuiStore((s) => s.preferences.proactiveHints !== false);
  const setPreferences = useTuiStore((s) => s.setPreferences);
  const navContext = useTuiStore((s) => s.navContext);
  const activeRunId = useTuiStore((s) => s.activeRunId);
  const snapshot = useTuiStore((s) => s.snapshot);
  const setActiveRunId = useTuiStore((s) => s.setActiveRunId);
  const pendingReviewRunSeq = useTuiStore((s) => s.pendingReviewRunSeq);
  const navigate = useTuiStore((s) => s.navigate);
  const goBack = useTuiStore((s) => s.goBack);
  const notify = useTuiStore((s) => s.notify);
  const { refresh } = useShellActions();

  const [run, setRun] = useState<ReviewRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [endedRestoreFrame, setEndedRestoreFrame] = useState<PracticeContextFrame | null>(null);

  // Per-card local input state
  const [cursorOpt, setCursorOpt] = useState(0);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [clozeInputs, setClozeInputs] = useState<Record<string, string>>({});
  const [activeBlankIdx, setActiveBlankIdx] = useState(0);
  const [clozeEditing, setClozeEditing] = useState(false);
  const [openDraft, setOpenDraft] = useState('');
  const [openEditing, setOpenEditing] = useState(false);

  // Overlays, rubric grading & translation
  const [aiDrawerOpen, setAiDrawerOpen] = useState(false);
  const [aiHistoryByCard, setAiHistoryByCard] = useState<Record<string, AiTurn[]>>({});
  const [savedFollowupsByCard, setSavedFollowupsByCard] = useState<Record<string, SavedFollowupItem[]>>({});
  const [flagModalOpen, setFlagModalOpen] = useState(false);
  const [flagReason, setFlagReason] = useState('');
  const [similarModalOpen, setSimilarModalOpen] = useState(false);
  const [cardToolsModalOpen, setCardToolsModalOpen] = useState(false);
  const [queueModalOpen, setQueueModalOpen] = useState(false);
  const [retellModalOpen, setRetellModalOpen] = useState(false);
  const [answerCardModalOpen, setAnswerCardModalOpen] = useState(false);
  const [gradeAdjustModalOpen, setGradeAdjustModalOpen] = useState(false);
  const [nudgeModalOpen, setNudgeModalOpen] = useState(false);
  const [confirmEndOpen, setConfirmEndOpen] = useState(false);
  const [focusOverrideByCard, setFocusOverrideByCard] = useState<Record<string, boolean>>({});
  const [focusBusy, setFocusBusy] = useState(false);
  const [gradingBusy, setGradingBusy] = useState(false);
  const [gradeResult, setGradeResult] = useState<CardGradeResponse | null>(null);
  const [gradeError, setGradeError] = useState<string | null>(null);
  const [showTranslation, setShowTranslation] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [translationTick, setTranslationTick] = useState(0);
  const [stuckNudgeVisible, setStuckNudgeVisible] = useState(false);
  const [stuckActivityTick, setStuckActivityTick] = useState(0);
  const [wrongStreakBanner, setWrongStreakBanner] = useState<string | null>(null);
  const [fatigueBanner, setFatigueBanner] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const translationCacheRef = useRef(new LruCache<string, CardTranslation>(MAX_TRANSLATION_CACHE));
  const nudgeCacheRef = useRef<Map<string, CoachNudgeNote>>(new Map());
  const currentCardIdRef = useRef<string | null>(null);
  const runRef = useRef<ReviewRun | null>(null);
  runRef.current = run;
  const selectedIdsRef = useRef<string[]>(selectedIds);
  selectedIdsRef.current = selectedIds;
  const clozeInputsRef = useRef<Record<string, string>>(clozeInputs);
  clozeInputsRef.current = clozeInputs;
  const openDraftRef = useRef<string>(openDraft);
  openDraftRef.current = openDraft;
  const pendingDraftRestoreRef = useRef<PendingDraftRestore | null>(null);
  const skipUnmountPushRef = useRef(false);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cardId = currentCardId(run);
  currentCardIdRef.current = cardId;
  const cardKey = `${run?.id ?? ''}:${run?.index ?? -1}:${cardId ?? ''}`;

  const kind = normalizeCardKind(run);
  const isRubricEligibleKind = isRubricEligibleCardKind(kind, String(run?.card?.kind || ''));
  const feedback: CardFeedbackShape | null = extractFeedback(run);
  const solution = extractSolution(run);
  const isFinished = Boolean(run && (run.complete || run.closed));
  const hasActiveRound = Boolean(run && !isFinished);
  const revealed = Boolean(run?.revealed || feedback);
  const isSelfGraded = kind === 'flashcard' || isRubricEligibleKind;
  const needsRating = Boolean(run && !isFinished && revealed && !feedback && !gradeResult && isSelfGraded);
  const canUndo = Boolean(run && run.mode !== 'exam' && (run as { undoable?: unknown }).undoable);
  const canAdjustGrade = canAdjustAiGrade(run, run ? (run.entry ?? { retry: Boolean(run.retry) }) : null, feedback);
  const canAckCorrection = Boolean(run && !isFinished && run.mode !== 'exam' && feedback?.correctionPending);
  const canCoachNudge = Boolean(
    run && !isFinished && run.mode !== 'exam' && feedback && typeof feedback.grade === 'number' && feedback.grade < 3,
  );
  const canRedo = Boolean(run && cardId && (revealed || feedback));
  const nudgeCacheKey = `${run?.id ?? ''}:${run?.index ?? -1}:${cardId ?? ''}:${feedback?.grade ?? ''}:${feedback?.correct ?? ''}`;

  const options: CardOptionItem[] = useMemo(
    () => resolveOptions(run?.card as Record<string, unknown> | undefined, kind, lang),
    [run?.card, kind, lang],
  );
  const clozeData = useMemo(
    () => (kind === 'fill_blank' ? resolveClozeBlanks(run?.card as Record<string, unknown> | undefined) : null),
    [kind, run?.card],
  );
  const effectiveClozeValues = useMemo(() => {
    const fbAns = feedback?.answers;
    return fbAns && typeof fbAns === 'object' ? { ...fbAns, ...clozeInputs } : clozeInputs;
  }, [feedback, clozeInputs]);
  const clozeBlankDiffs = useMemo(
    () =>
      kind === 'fill_blank' && clozeData && (revealed || feedback)
        ? buildClozeBlankDiffs(clozeData.blanks, effectiveClozeValues, feedback, solution)
        : [],
    [kind, clozeData, revealed, feedback, effectiveClozeValues, solution],
  );
  const citation = useMemo(() => extractCitation(run), [run]);
  const intervals = useMemo(() => {
    const raw = (run as { intervals?: unknown } | null)?.intervals;
    return Array.isArray(raw) ? (raw as Array<number | null | undefined>) : null;
  }, [run]);
  const gradeAnswerText = useMemo(() => {
    const draft = openDraft.trim();
    if (draft) return draft;
    if (typeof feedback?.answer === 'string' && feedback.answer.trim()) return feedback.answer.trim();
    const serverDraft = (run as { draft?: { text?: unknown } } | null)?.draft?.text;
    return typeof serverDraft === 'string' && serverDraft.trim() ? serverDraft.trim() : '';
  }, [openDraft, feedback, run]);
  const canRubricGrade = Boolean(run && !isFinished && isRubricEligibleKind && gradeAnswerText.length > 0);
  const activeRubric = useMemo<RubricSummaryShape | null>(() => {
    if (gradeResult?.rubric) return gradeResult.rubric;
    const fbRubric = (feedback as { rubric?: unknown } | null)?.rubric;
    return fbRubric && typeof fbRubric === 'object' ? (fbRubric as RubricSummaryShape) : null;
  }, [gradeResult, feedback]);
  const userAnswerText = useMemo(
    () => extractUserAnswerText(run, kind, selectedIds, clozeInputs, openDraft, lang),
    [run, kind, selectedIds, clozeInputs, openDraft, lang],
  );

  const roundActions = useReviewRoundActions({
    host, lang, navContext, activeRunId, snapshot, setActiveRunId, notify, refresh,
    run, cardId, isRubricEligibleKind, isSelfGraded, revealed, feedback, busy, openDraft, endedRestoreFrame,
    mountedRef, busyRef, runRef, currentCardIdRef, selectedIdsRef, clozeInputsRef, openDraftRef,
    pendingDraftRestoreRef, skipUnmountPushRef, draftTimerRef,
    setRun, setLoading, setBusy, setLoadError, setEndedRestoreFrame,
  });

  const { clearDraftTimer, pushCurrentToPracticeStack, applyRun, loadInitialRun } = roundActions;

  const cardActions = useReviewCardActions({
    host, lang, notify, refresh, applyRun, clearDraftTimer,
    run, cardId, cardKey, kind, isRubricEligibleKind, revealed, feedback,
    busy, gradingBusy, focusBusy, translating, showTranslation,
    userAnswerText, gradeAnswerText, flagReason, focusOverrideByCard, canAdjustGrade, canAckCorrection,
    mountedRef, busyRef, runRef, currentCardIdRef, translationCacheRef,
    setBusy, setFlagModalOpen, setFlagReason, setGradeAdjustModalOpen, setOpenEditing,
    setFocusOverrideByCard, setFocusBusy, setGradingBusy, setGradeResult, setGradeError,
    setShowTranslation, setTranslating, setTranslationTick,
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearDraftTimer();
      if (!skipUnmountPushRef.current) {
        const destPage = useTuiStore.getState().page;
        if (destPage !== 'review' && destPage !== 'library') {
          pushCurrentToPracticeStack(resolvePracticeReturnOrigin(destPage));
        }
      }
    };
  }, [clearDraftTimer, pushCurrentToPracticeStack]);

  useEffect(() => {
    clearDraftTimer();
    const restored = resolveInitialCardDraft({
      run: runRef.current,
      stackRestore: pendingDraftRestoreRef.current,
    });
    if (restored.consumedStackRestore) pendingDraftRestoreRef.current = null;
    setCursorOpt(0);
    setSelectedIds(restored.selected);
    setClozeInputs(restored.clozeInputs);
    setActiveBlankIdx(0);
    setClozeEditing(false);
    setOpenDraft(restored.openDraft);
    setOpenEditing(false);
    setGradeAdjustModalOpen(false);
    setNudgeModalOpen(false);
    setGradingBusy(false);
    setGradeResult(null);
    setGradeError(null);
    setShowTranslation(false);
    setTranslating(false);
    return () => clearDraftTimer();
  }, [cardKey, clearDraftTimer]);

  useEffect(() => {
    if (!pendingReviewRunSeq) return;
    const next = useTuiStore.getState().consumePendingReviewRun();
    if (!next) return;
    const nextId = typeof next.id === 'string' ? next.id : '';
    const onScreen = navContext.runId || activeRunId || '';
    if (nextId && onScreen && nextId !== onScreen) return;
    applyRun(next as unknown as ReviewRun, true);
  }, [pendingReviewRunSeq, applyRun, navContext.runId, activeRunId]);

  const loadInitialRunRef = useRef(loadInitialRun);
  loadInitialRunRef.current = loadInitialRun;
  useEffect(() => {
    void loadInitialRunRef.current(false);
  }, [navContext.runId, navContext.deckId, navContext.course, navContext.mode]);

  const cardClaimedKeys = useMemo<readonly string[]>(
    () =>
      buildCardClaimedKeys({
        isActive,
        hasRun: Boolean(run),
        isFinished,
        isRubricEligibleKind,
        canAdjustGrade,
        canAckCorrection,
        kind,
      }),
    [isActive, run, isFinished, isRubricEligibleKind, canAdjustGrade, canAckCorrection, kind],
  );

  const hints: KeyHint[] = useMemo(
    () =>
      buildReviewFooterHints({
        loading, run, isFinished, revealed, feedback, kind, isRubricEligibleKind, needsRating,
        canRubricGrade, activeRubric, canAdjustGrade, canAckCorrection, canCoachNudge, canRedo,
        canUndo, mathUnicode, hasCitation: Boolean(citation), lang,
      }),
    [
      loading, run, isFinished, revealed, feedback, kind, isRubricEligibleKind, needsRating,
      canRubricGrade, activeRubric, canAdjustGrade, canAckCorrection, canCoachNudge, canRedo,
      canUndo, mathUnicode, citation, lang,
    ],
  );

  const cardScopeActive = useKeyScope({
    id: 'ReviewView:card',
    active: isActive && Boolean(run) && !isFinished,
    keys: cardClaimedKeys,
    onKey: (input, key) =>
      handleReviewCardKey(input, key, {
        run, busy, lang, mathUnicode, kind, isRubricEligibleKind, needsRating, feedback,
        canAdjustGrade, canAckCorrection, canCoachNudge, citation, options, cursorOpt, selectedIds,
        stuckNudgeVisible, setStuckNudgeVisible,
        bumpStuckActivity: () => setStuckActivityTick((v) => v + 1),
        setSkipUnmountPush: (v) => { skipUnmountPushRef.current = v; },
        loadInitialRun, goBack, navigate, notify, setPreferences, setAiDrawerOpen, setRetellModalOpen,
        setGradeAdjustModalOpen, setNudgeModalOpen, setSimilarModalOpen, setCardToolsModalOpen,
        setQueueModalOpen, setAnswerCardModalOpen, setFlagReason, setFlagModalOpen, setConfirmEndOpen,
        setOpenEditing, setClozeEditing, setCursorOpt, setSelectedIds,
        openGuidedStudy: () => cardActions.openGuidedStudy({ focused: true }),
        pushCurrentToPracticeStack,
        handleToggleFocus: cardActions.handleToggleFocus,
        handleRubricGrade: cardActions.handleRubricGrade,
        handleAckCorrection: cardActions.handleAckCorrection,
        handleToggleTranslate: cardActions.handleToggleTranslate,
        handleRedoCard: cardActions.handleRedoCard,
        handleUndo: roundActions.handleUndo,
        handleSkip: roundActions.handleSkip,
        handleMove: roundActions.handleMove,
        handleFsrsGrade: roundActions.handleFsrsGrade,
        handleReveal: roundActions.handleReveal,
        handleSubmitChoice: roundActions.handleSubmitChoice,
      }),
  });
  useFooterHints(hints, cardScopeActive);

  useKeyScope({
    id: 'ReviewView:empty',
    active: isActive && !loading && (!run || Boolean(endedRestoreFrame)),
    keys: EMPTY_CLAIMED_KEYS,
    onKey: (input, key) =>
      handleReviewEmptyKey(input, key, {
        endedRestoreFrame,
        setEndedRestoreFrame,
        handleRetryEndedCard: roundActions.handleRetryEndedCard,
        navigate,
        goBack,
        loadInitialRun,
      }),
  });

  useReviewEffects({
    run, cardId, cardKey, kind, isFinished, hasActiveRound, revealed, feedback, solution,
    hasCitation: Boolean(citation), canCoachNudge, nudgeModalOpen, setNudgeModalOpen,
    proactiveHints, isActive, clozeEditing, openEditing, cardScopeActive,
    selectedIds, clozeInputs, openDraft, lang, asciiMode, stuckActivityTick, stuckNudgeDelayMs,
    sources: snapshot?.sources, mountedRef, currentCardIdRef,
    setStuckNudgeVisible, setWrongStreakBanner, setFatigueBanner,
  });

  const activeTranslation = useMemo<CardTranslation | null>(() => {
    if (!showTranslation || !cardId) return null;
    void translationTick;
    return translationCacheRef.current.get(cardId) ?? null;
  }, [showTranslation, cardId, translationTick]);

  const citationUrl = useMemo(() => {
    if (!citation) return '';
    const src = snapshot?.sources?.find((s) => s.id === citation.sourceId);
    const rawPath =
      (typeof src?.filePath === 'string' && src.filePath) ||
      (typeof src?.path === 'string' && src.path) ||
      (typeof src?.localPath === 'string' && src.localPath) ||
      (typeof src?.url === 'string' && src.url) ||
      '';
    return rawPath ? buildFileHyperlinkUrl(rawPath, citation.pageNumber) : '';
  }, [citation, snapshot?.sources]);

  const handleAiHistoryChange = useCallback((targetCardId: string, nextTurns: AiTurn[]) => {
    setAiHistoryByCard((prev) => ({ ...prev, [targetCardId]: nextTurns }));
  }, []);

  const handleSavedFollowup = useCallback((targetCardId: string, item: SavedFollowupItem) => {
    setSavedFollowupsByCard((prev) => {
      const existing = prev[targetCardId] ?? [];
      const idx = existing.findIndex(
        (x) => (item.id && x.id === item.id) || (item.question && x.question === item.question),
      );
      if (idx >= 0) {
        const next = [...existing];
        next[idx] = item;
        return { ...prev, [targetCardId]: next };
      }
      return { ...prev, [targetCardId]: [...existing, item] };
    });
  }, []);

  const savedFollowupCount = useMemo(
    () => countSavedFollowups(run, cardId ? savedFollowupsByCard[cardId] ?? [] : []),
    [run, cardId, savedFollowupsByCard],
  );

  const stemMarkdown = useMemo(
    () =>
      buildReviewStemMarkdown({
        run, kind, clozeData, effectiveClozeValues, revealed, solution, activeTranslation, asciiMode,
      }),
    [run, kind, clozeData, effectiveClozeValues, revealed, solution, activeTranslation, asciiMode],
  );

  const referenceAnswer = useMemo(
    () => (run && revealed ? extractReferenceAnswer(run, kind, lang) : ''),
    [revealed, run, kind, lang],
  );

  const postAnswerMarkdown = useMemo(
    () => buildPostAnswerMarkdown({ activeRubric, asciiMode, revealed, solution, activeTranslation, lang }),
    [activeRubric, asciiMode, revealed, solution, activeTranslation, lang],
  );

  if (loading || endedRestoreFrame || !run || isFinished) {
    return (
      <ReviewEmptyStates
        loading={loading}
        endedRestoreFrame={endedRestoreFrame}
        run={run}
        isFinished={isFinished}
        loadError={loadError}
        host={host}
        width={width}
        height={height}
        isActive={isActive}
        lang={lang}
        asciiMode={asciiMode}
        mathUnicode={mathUnicode}
        onPracticeWeak={roundActions.handlePracticeWeak}
        onNewRound={() => void loadInitialRun(true)}
        onGoLibrary={() => navigate('library')}
      />
    );
  }

  const sideBySideAi = aiDrawerOpen && width >= LAYOUT_BP.AI_DRAWER_SIDE;
  const cardPaneW = sideBySideAi ? Math.max(44, Math.floor(width * 0.56)) : width;
  const aiPaneW = sideBySideAi ? Math.max(32, width - cardPaneW - 1) : width;

  const totalCount = Math.max(1, Number(run.total || run.navigation?.length || 1));
  const atNum = Math.min(totalCount, Number(run.position?.at ?? run.index + 1) || 1);
  const answeredCount = Number(run.answered ?? 0) || 0;
  const topicName = typeof run.card?.topic === 'string' && run.card.topic ? run.card.topic : '';
  const isCardFocused =
    cardId && cardId in focusOverrideByCard ? focusOverrideByCard[cardId] : Boolean(run.card?.focus);

  const innerW = Math.max(20, cardPaneW - 4);
  const postAnswerMaxH = Math.max(3, height - (innerW < LAYOUT_BP.COMPACT ? 22 : 18));
  const postAnswerViewH = postAnswerMarkdown
    ? Math.min(
        postAnswerMaxH,
        Math.max(
          1,
          renderMarkdownLines(postAnswerMarkdown, {
            width: Math.max(8, innerW - 1),
            theme,
            mathUnicode,
            ascii: asciiMode,
          }).length,
        ),
      )
    : postAnswerMaxH;
  const progressRatio = totalCount > 0 ? Math.min(1, answeredCount / totalCount) : 0;
  const panelTitleStr = String(run.title || t(lang, 'FSRS-6 间隔复习', 'FSRS-6 Review'));
  const panelBadgeStr = `${atNum}/${totalCount}`;
  const panelSubtitleStr = `${kindLabel(kind, lang)}${topicName ? `${asciiMode ? ' - ' : ' · '}${topicName}` : ''}`;
  const panelHeaderAvail = Math.max(
    0,
    cardPaneW - 4 - 2 - (displayWidth(` ${panelBadgeStr} `) + 1) - (panelSubtitleStr ? 2 : 0) - 1,
  );
  const panelHeaderTruncated =
    displayWidth(`${asciiMode ? '>' : '▶'} ${panelTitleStr}`) + displayWidth(panelSubtitleStr) > panelHeaderAvail;
  const { proseWidth, marginLeft } = computeProseLayout(innerW);

  const quickActionHandlers: Record<string, () => void> = {
    h: () => setAiDrawerOpen((v) => !v),
    T: () => cardActions.openGuidedStudy({ focused: true }),
    S: () => setSimilarModalOpen(true),
    '*': () => void cardActions.handleToggleFocus(),
    R: () => void cardActions.handleRedoCard(),
    G: () => void cardActions.handleRubricGrade(),
    A: () => setAnswerCardModalOpen(true),
    W: () => void cardActions.handleToggleTranslate(),
    D: () => setCardToolsModalOpen(true),
    Q: () => {
      if (run.mode !== 'exam') setQueueModalOpen(true);
      else notify(t(lang, '模拟考试队列已锁定，不能修改', 'Exam queue is locked'), 'info');
    },
    E: () => { setFlagReason(''); setFlagModalOpen(true); },
    s: () => { if (!feedback) roundActions.handleSkip(); },
    u: () => roundActions.handleUndo(),
    nav: () => roundActions.handleMove(1),
    J: () => setGradeAdjustModalOpen(true),
    K: () => void cardActions.handleAckCorrection(),
    N: () => setNudgeModalOpen(true),
  };

  return (
    <Box flexDirection="row" width={width} height={height}>
      {!(aiDrawerOpen && !sideBySideAi) ? (
        <Panel
          title={panelTitleStr}
          icon={asciiMode ? '>' : '▶'}
          badge={panelBadgeStr}
          badgeTone="primary"
          subtitle={panelSubtitleStr}
          focused={cardScopeActive}
          width={cardPaneW}
          height={height}
          paddingX={1}
        >
          <ReviewCardTopBar
            innerW={innerW}
            progressRatio={progressRatio}
            answeredCount={answeredCount}
            totalCount={totalCount}
            retry={Boolean(run.retry)}
            isCardFocused={isCardFocused}
            busy={busy}
            translating={translating}
            isActive={isActive}
            hasTranslation={Boolean(activeTranslation)}
            mathUnicode={mathUnicode}
            lang={lang}
            asciiMode={asciiMode}
            panelHeaderTruncated={panelHeaderTruncated}
            panelTitleStr={panelTitleStr}
            panelSubtitleStr={panelSubtitleStr}
          />
          <Divider width={innerW} />
          <Box flexGrow={1} />

          <Box flexDirection="column" flexShrink={0} width={innerW} paddingLeft={marginLeft} marginY={0}>
            <MarkdownView markdown={stemMarkdown} width={proseWidth} mathUnicode={mathUnicode} />
          </Box>

          {stuckNudgeVisible && !revealed && !feedback ? (
            <ReviewStuckNudgeBanner
              innerW={innerW}
              lang={lang}
              asciiMode={asciiMode}
              cardScopeActive={cardScopeActive}
              onDisableProactiveHints={() => {
                setStuckNudgeVisible(false);
                setPreferences({ proactiveHints: false });
                const dshHome = (host as { dshHome?: string }).dshHome;
                void saveTuiPreferences({ proactiveHints: false }, dshHome ? { env: { DSH_HOME: dshHome } } : undefined).catch(() => {});
                notify(t(lang, '主动学习提示已关闭（可用 /proactive 重开）', 'Proactive hints turned off'), 'info');
              }}
            />
          ) : null}

          <ReviewAnswerInput
            kind={kind} isRubricEligibleKind={isRubricEligibleKind} options={options} clozeData={clozeData}
            feedback={feedback} solution={solution} revealed={revealed} activeTranslation={activeTranslation}
            cursorOpt={cursorOpt} selectedIds={selectedIds} clozeInputs={clozeInputs}
            activeBlankIdx={activeBlankIdx} clozeEditing={clozeEditing} openDraft={openDraft} openEditing={openEditing}
            innerW={innerW} isActive={isActive} cardScopeActive={cardScopeActive} lang={lang} asciiMode={asciiMode}
            setCursorOpt={setCursorOpt} setSelectedIds={setSelectedIds} setClozeInputs={setClozeInputs}
            setActiveBlankIdx={setActiveBlankIdx} setClozeEditing={setClozeEditing} setOpenDraft={setOpenDraft}
            setOpenEditing={setOpenEditing} onSubmitChoice={roundActions.handleSubmitChoice}
            onSubmitCloze={roundActions.handleSubmitCloze} onReveal={roundActions.handleReveal}
            onScheduleDraftSave={roundActions.scheduleDraftSave}
          />

          {revealed || activeRubric || gradingBusy || gradeError ? (
            <Box flexDirection="column" marginTop={1} width={innerW} flexShrink={1} overflow="hidden">
              <Divider
                width={innerW}
                label={revealed ? t(lang, '答案与解析', 'Answer & Explanation') : t(lang, 'AI 评分反馈', 'AI Rubric Feedback')}
              />

              <ReviewFeedbackHeader
                innerW={innerW} lang={lang} asciiMode={asciiMode} isActive={isActive}
                gradingBusy={gradingBusy} gradeError={gradeError} feedback={feedback}
                userAnswerText={userAnswerText} canUndo={canUndo} clozeBlankDiffs={clozeBlankDiffs}
                activeRubric={activeRubric} gradeResult={gradeResult} canAckCorrection={canAckCorrection}
                revealed={revealed} referenceAnswer={referenceAnswer} activeTranslation={activeTranslation}
              />

              {postAnswerMarkdown ? (
                <Box marginTop={0} flexShrink={1} overflow="hidden">
                  <MarkdownView
                    markdown={postAnswerMarkdown}
                    width={innerW}
                    height={postAnswerViewH}
                    mathUnicode={mathUnicode}
                    isActive={cardScopeActive && revealed}
                    vimNavKeys={false}
                    spacePageDown={false}
                  />
                </Box>
              ) : null}

              <ReviewPostAnswerFooter
                innerW={innerW} lang={lang} asciiMode={asciiMode} cardScopeActive={cardScopeActive}
                proactiveHints={proactiveHints} wrongStreakBanner={wrongStreakBanner} fatigueBanner={fatigueBanner}
                revealed={revealed} citation={citation} citationUrl={citationUrl} needsRating={needsRating}
                canRubricGrade={canRubricGrade} activeRubric={activeRubric} intervals={intervals}
                onClickWrongStreak={() => {
                  setWrongStreakBanner(null);
                  cardActions.openGuidedStudy({ focused: true, extra: { isWrong: true, revealed: true } });
                }}
                onDismissFatigue={() => setFatigueBanner(null)}
                onOpenCitation={() => {
                  if (!citation) return;
                  pushCurrentToPracticeStack('source');
                  skipUnmountPushRef.current = true;
                  navigate('sources', { sourceId: citation.sourceId, pageNumber: citation.pageNumber });
                }}
                onRubricGrade={() => void cardActions.handleRubricGrade()}
                onFsrsGrade={roundActions.handleFsrsGrade}
              />
            </Box>
          ) : null}

          {savedFollowupCount > 0 ? (
            <ClickableBox
              marginTop={revealed ? 0 : 1}
              flexShrink={0}
              clickActive={cardScopeActive}
              onClick={() => setAiDrawerOpen(true)}
            >
              <Text color={theme.ai}>
                {`${asciiMode ? '*' : '✦'} ${t(
                  lang,
                  `已存讲解 ${savedFollowupCount} 条，按 [h] 查看`,
                  `${savedFollowupCount} saved explanation(s) — press [h] to view`,
                )}`}
              </Text>
            </ClickableBox>
          ) : null}

          <Box flexGrow={1} />
          <ReviewQuickActionStrip
            innerW={innerW} lang={lang} asciiMode={asciiMode} cardScopeActive={cardScopeActive}
            isCardFocused={isCardFocused} canRubricGrade={canRubricGrade} canRedo={canRedo}
            canAdjustGrade={canAdjustGrade} canAckCorrection={canAckCorrection} canCoachNudge={canCoachNudge}
            actionHandlers={quickActionHandlers}
          />
        </Panel>
      ) : null}

      {sideBySideAi ? <Box width={1} /> : null}

      <ReviewOverlays
        host={host} run={run} cardId={cardId} kind={kind} userAnswerText={userAnswerText}
        width={width} height={height} aiPaneW={aiPaneW} isActive={isActive}
        lang={lang} asciiMode={asciiMode} mathUnicode={mathUnicode} busy={busy} busyRef={busyRef}
        feedback={feedback} answeredCount={answeredCount} totalCount={totalCount}
        canAdjustGrade={canAdjustGrade} canCoachNudge={canCoachNudge}
        aiDrawerOpen={aiDrawerOpen} retellModalOpen={retellModalOpen} similarModalOpen={similarModalOpen}
        cardToolsModalOpen={cardToolsModalOpen} queueModalOpen={queueModalOpen} answerCardModalOpen={answerCardModalOpen}
        nudgeModalOpen={nudgeModalOpen} flagModalOpen={flagModalOpen} flagReason={flagReason}
        gradeAdjustModalOpen={gradeAdjustModalOpen} confirmEndOpen={confirmEndOpen}
        aiHistoryByCard={aiHistoryByCard} savedFollowupsByCard={savedFollowupsByCard}
        initialNudgeNote={nudgeCacheRef.current.get(nudgeCacheKey) ?? null}
        onAiHistoryChange={handleAiHistoryChange} onSavedFollowup={handleSavedFollowup}
        onCloseAiDrawer={() => setAiDrawerOpen(false)} onCloseRetell={() => setRetellModalOpen(false)}
        onNavigateToSource={(loc) => {
          pushCurrentToPracticeStack('source');
          skipUnmountPushRef.current = true;
          navigate('sources', { sourceId: loc.sourceId, pageNumber: loc.pageNumber });
        }}
        onCloseSimilar={() => setSimilarModalOpen(false)}
        onStartSimilarRun={(nextRun) => { pushCurrentToPracticeStack('similar'); applyRun(nextRun, true); }}
        onCloseCardTools={() => setCardToolsModalOpen(false)}
        onRunUpdated={(nextRun) => applyRun(nextRun, true)}
        onCardEdited={(editedId) => { translationCacheRef.current.delete(editedId); setShowTranslation(false); }}
        onFocusChanged={(cid, focused) => setFocusOverrideByCard((prev) => ({ ...prev, [cid]: focused }))}
        onRefreshSnapshot={() => void refresh()}
        onCloseQueue={() => setQueueModalOpen(false)} onCloseAnswerCard={() => setAnswerCardModalOpen(false)}
        onNudgeNoteUpdate={(note) => { nudgeCacheRef.current.set(nudgeCacheKey, note); }}
        onCloseNudge={() => setNudgeModalOpen(false)} onFlagReasonChange={setFlagReason}
        onSubmitFlag={() => void cardActions.handleSubmitFlag()} onCloseFlag={() => setFlagModalOpen(false)}
        onSelectGradeAdjust={(grade) => void cardActions.handleAdjustGrade(grade)}
        onCloseGradeAdjust={() => setGradeAdjustModalOpen(false)}
        onConfirmEndRound={() => { setConfirmEndOpen(false); roundActions.handleEndRound(); }}
        onCancelEndRound={() => setConfirmEndOpen(false)}
      />
    </Box>
  );
};
