import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { KeyHint, ViewProps } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { useShellActions } from '../../shell/actions.js';
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
import { useTheme } from '../../theme/tokens.js';
import { Badge, Divider, EmptyState, ProgressBar, Spinner } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { MarkdownView } from '../../components/MarkdownView.js';
import { Modal } from '../../components/Modal.js';
import { Panel } from '../../components/Panel.js';
import { TextInput } from '../../components/TextInput.js';
import { useClaimKeys } from '../../components/focus.js';
import { useFooterHints } from '../../components/hooks.js';
import { ClickableBox } from '../../components/mouse.js';
import { LruCache } from '../../render/lru.js';
import { displayWidth, truncateDisplay, wrapDisplay } from '../../render/cjk.js';
import {
  FSRS_GRADES,
  MAX_TRANSLATION_CACHE,
  buildClozeBlankDiffs,
  canAdjustAiGrade,
  currentDeckIdOf,
  extractCitation,
  extractFeedback,
  extractReferenceAnswer,
  extractSolution,
  extractUserAnswerText,
  formatClozeDisplay,
  formatGapDays,
  kindLabel,
  normalizeCardKind,
  resolveClozeBlanks,
  resolveOptions,
  skipTargetIndex,
  type AiTurn,
  type CardFeedbackShape,
  type CardOptionItem,
  type CardTranslation,
} from './review-helpers.js';
import type { SavedFollowupItem } from './AiHelpDrawer.js';
import type { CoachNudgeNote } from './CoachNudgeModal.js';
const AiHelpDrawer = lazy(() => import('./AiHelpDrawer.js').then((m) => ({ default: m.AiHelpDrawer })));
const AnswerCardModal = lazy(() => import('./AnswerCardModal.js').then((m) => ({ default: m.AnswerCardModal })));
const CardToolsModal = lazy(() => import('./CardToolsModal.js').then((m) => ({ default: m.CardToolsModal })));
const CoachNudgeModal = lazy(() => import('./CoachNudgeModal.js').then((m) => ({ default: m.CoachNudgeModal })));
const QueueModal = lazy(() => import('./QueueModal.js').then((m) => ({ default: m.QueueModal })));
const RetellModal = lazy(() => import('./RetellModal.js').then((m) => ({ default: m.RetellModal })));
const RoundSummary = lazy(() => import('./RoundSummary.js').then((m) => ({ default: m.RoundSummary })));
const SimilarCardsModal = lazy(() => import('./SimilarCardsModal.js').then((m) => ({ default: m.SimilarCardsModal })));
const TeachModal = lazy(() => import('./TeachModal.js').then((m) => ({ default: m.TeachModal })));

interface RubricCriterionResult {
  id: string;
  label?: string;
  score: number;
  max: number;
  ratio?: number;
  evidence?: string[];
  missing?: Array<{ id?: string; text?: string }>;
  suggestion?: string;
  note?: string;
}

interface RubricSummaryShape {
  total: number;
  max: number;
  ratio?: number;
  band?: string;
  unanswered?: boolean;
  criteria?: RubricCriterionResult[];
  summary?: string;
}

interface CardGradeResponse {
  deckId?: string;
  cardId?: string;
  runId?: string | null;
  grade?: number;
  total?: number;
  max?: number;
  rubric?: RubricSummaryShape;
  message?: string;
}

interface RunDraftShape {
  text?: unknown;
  stepInputs?: unknown;
  selected?: unknown;
  updatedAt?: unknown;
}

const DRAFT_SAVE_DEBOUNCE_MS = 600;

function isModelUnavailableMsg(msg: string): boolean {
  return /configure a model|model.*unavailable|no.*model|api.?key|unauthorized|forbidden|\b401\b|\b403\b|econnrefused|timed out|timeout|未配置|可用.*模型|模型不可用/i.test(
    msg,
  );
}

const CARD_UTIL_KEYS: readonly string[] = Object.freeze([
  'X',
  'Q',
  's',
  'm',
  ',',
  '.',
  't',
  'a',
  'f',
  'n',
  'F',
  'L',
  '*',
  'T',
  'S',
  'D',
  'A',
  'E',
  'h',
  'u',
  'o',
  'N',
]);
const RATING_DIGIT_KEYS: readonly string[] = Object.freeze(['0', '1', '2', '3', '4', '5']);
const CHOICE_DIGIT_KEYS: readonly string[] = Object.freeze(['1', '2', '3', '4', '5', '6']);
const TF_DIGIT_KEYS: readonly string[] = Object.freeze(['1', '2']);
const EMPTY_CLAIMED_KEYS: readonly string[] = Object.freeze([]);

interface GradeAdjustModalProps {
  lang: 'zh' | 'en';
  asciiMode: boolean;
  width: number;
  currentGrade: number | undefined;
  originalGrade: number | undefined;
  busy: boolean;
  isActive: boolean;
  onSelect: (grade: number) => void;
  onClose: () => void;
}

function GradeAdjustModal({
  lang,
  asciiMode,
  width,
  currentGrade,
  originalGrade,
  busy,
  isActive,
  onSelect,
  onClose,
}: GradeAdjustModalProps) {
  const theme = useTheme();
  const initialCursor =
    typeof currentGrade === 'number' && currentGrade >= 0 && currentGrade <= 5 ? currentGrade : 3;
  const [cursor, setCursor] = useState(initialCursor);

  useEffect(() => {
    if (isActive) {
      setCursor(typeof currentGrade === 'number' && currentGrade >= 0 && currentGrade <= 5 ? currentGrade : 3);
    }
  }, [isActive, currentGrade]);

  useInput(
    (input, key) => {
      if (busy) return;
      if (/^[0-5]$/.test(input)) {
        onSelect(Number(input));
        return;
      }
      if (input === 'j' || key.downArrow) {
        setCursor((prev) => (prev + 1) % FSRS_GRADES.length);
        return;
      }
      if (input === 'k' || key.upArrow) {
        setCursor((prev) => (prev - 1 + FSRS_GRADES.length) % FSRS_GRADES.length);
        return;
      }
      if (key.return) {
        onSelect(FSRS_GRADES[cursor]?.grade ?? cursor);
      }
    },
    { isActive },
  );

  return (
    <Modal
      title={t(lang, '手动调整 AI 评分', 'Adjust AI Grade')}
      icon={asciiMode ? '*' : '◆'}
      tone="primary"
      width={Math.min(56, Math.max(32, width - 6))}
      isActive={isActive}
      onClose={onClose}
      hints={[
        { key: '0-5', label: t(lang, '直接改分', 'Pick') },
        { key: 'j/k', label: t(lang, '选择', 'Move') },
        { key: 'Enter', label: t(lang, '确认', 'Confirm') },
        { key: 'Esc', label: t(lang, '取消', 'Cancel') },
      ]}
    >
      <Text color={theme.muted}>
        {typeof originalGrade === 'number' && originalGrade !== currentGrade
          ? t(lang, `当前: ${currentGrade ?? '-'}/5 (AI 原评 ${originalGrade})`, `Current: ${currentGrade ?? '-'}/5 (AI: ${originalGrade})`)
          : t(lang, `当前评分: ${currentGrade ?? '-'}/5，选择调整后的 FSRS 评分 (0-5):`, `Current grade: ${currentGrade ?? '-'}/5. Pick new FSRS grade (0-5):`)}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {FSRS_GRADES.map((g, idx) => {
          const isCursor = idx === cursor;
          const isCurrent = g.grade === currentGrade;
          const isOriginal = g.grade === originalGrade;
          const label = lang === 'en' ? g.labelEn : g.labelZh;
          return (
            <Box key={g.key} flexDirection="row" gap={1}>
              <Text color={isCursor ? theme.primary : theme.dim} bold={isCursor}>
                {isCursor ? (asciiMode ? '> ' : '▸ ') : '  '}
              </Text>
              <Text color={isCursor ? theme.primary : theme.text} bold={isCursor || isCurrent}>
                {`[${g.key}] ${label}`}
              </Text>
              {isCurrent ? <Text color={theme.accent}>{t(lang, '(当前)', '(current)')}</Text> : null}
              {isOriginal ? <Text color={theme.muted}>{t(lang, '(AI原评)', '(AI)')}</Text> : null}
            </Box>
          );
        })}
      </Box>
    </Modal>
  );
}

export const ReviewView: React.FC<ViewProps> = ({ host, width, height, isActive }) => {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const mathUnicode = useTuiStore((s) => s.preferences.mathUnicode);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const setPreferences = useTuiStore((s) => s.setPreferences);
  const navContext = useTuiStore((s) => s.navContext);
  const activeRunId = useTuiStore((s) => s.activeRunId);
  const snapshot = useTuiStore((s) => s.snapshot);
  const setActiveRunId = useTuiStore((s) => s.setActiveRunId);
  const navigate = useTuiStore((s) => s.navigate);
  const goBack = useTuiStore((s) => s.goBack);
  const notify = useTuiStore((s) => s.notify);
  const { refresh } = useShellActions();

  const [run, setRun] = useState<ReviewRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

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
  const [teachModalOpen, setTeachModalOpen] = useState(false);
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

  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const translationCacheRef = useRef(new LruCache<string, CardTranslation>(MAX_TRANSLATION_CACHE));
  const nudgeCacheRef = useRef<Map<string, CoachNudgeNote>>(new Map());
  const currentCardIdRef = useRef<string | null>(null);
  const runRef = useRef<ReviewRun | null>(null);
  runRef.current = run;
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearDraftTimer = useCallback(() => {
    if (draftTimerRef.current !== null) {
      clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearDraftTimer();
    };
  }, [clearDraftTimer]);

  const cardId = currentCardId(run);
  currentCardIdRef.current = cardId;
  const cardKey = `${run?.id ?? ''}:${run?.index ?? -1}:${cardId ?? ''}`;

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
    [clearDraftTimer, host],
  );

  // Reset per-card input state and restore any persisted entry draft when opening/moving to a question
  useEffect(() => {
    clearDraftTimer();
    const activeRun = runRef.current;
    const rawDraft =
      activeRun && !activeRun.feedback && !activeRun.complete && !activeRun.closed
        ? ((activeRun as { draft?: RunDraftShape | null }).draft ?? null)
        : null;
    const restoredText = typeof rawDraft?.text === 'string' ? rawDraft.text : '';
    const restoredCloze: Record<string, string> = {};
    if (rawDraft?.stepInputs && typeof rawDraft.stepInputs === 'object' && !Array.isArray(rawDraft.stepInputs)) {
      for (const [key, val] of Object.entries(rawDraft.stepInputs as Record<string, unknown>)) {
        if (typeof val === 'string') restoredCloze[key] = val;
      }
    }
    const restoredSelected = Array.isArray(rawDraft?.selected)
      ? rawDraft.selected.filter((id): id is string => typeof id === 'string')
      : [];

    setCursorOpt(0);
    setSelectedIds(restoredSelected);
    setClozeInputs(restoredCloze);
    setActiveBlankIdx(0);
    setClozeEditing(false);
    setOpenDraft(restoredText);
    setOpenEditing(false);
    setGradeAdjustModalOpen(false);
    setNudgeModalOpen(false);
    setGradingBusy(false);
    setGradeResult(null);
    setGradeError(null);
    setShowTranslation(false);
    setTranslating(false);
    return () => {
      clearDraftTimer();
    };
  }, [cardKey, clearDraftTimer]);

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
    [setActiveRunId, refresh],
  );

  const loadInitialRun = useCallback(
    async (forceFresh = false) => {
      clearDraftTimer();
      setLoading(true);
      setLoadError(null);
      const targetRunId = !forceFresh ? navContext.runId || activeRunId : null;
      if (targetRunId) {
        const res = await tryAction<ReviewRun>(host, 'review.get', { runId: targetRunId });
        if (!mountedRef.current) return;
        if (res.ok && res.value) {
          setLoading(false);
          applyRun(res.value);
          return;
        }
      }

      const course = navContext.course ?? currentCourse(snapshot) ?? undefined;
      const mode: ReviewMode =
        (navContext.mode as ReviewMode) || 'path';
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
    [host, navContext.runId, navContext.deckId, navContext.course, navContext.mode, activeRunId, snapshot, applyRun, clearDraftTimer, lang],
  );

  useEffect(() => {
    void loadInitialRun(false);
    // Re-run only when navigation context explicitly targets a new run/deck/course.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navContext.runId, navContext.deckId, navContext.course, navContext.mode]);

  const kind = normalizeCardKind(run);
  const rawCardKind = String(run?.card?.kind || '').toLowerCase();
  const isRubricEligibleKind =
    kind === 'short_answer' ||
    rawCardKind === 'open' ||
    rawCardKind === 'short_answer' ||
    rawCardKind === 'case';
  const feedback: CardFeedbackShape | null = extractFeedback(run);
  const solution = extractSolution(run);
  const isFinished = Boolean(run && (run.complete || run.closed));
  const hasActiveRound = Boolean(run && !isFinished);
  useEffect(() => {
    if (!hasActiveRound) return undefined;
    return useTuiStore.getState().registerQuitGuard(() => {
      useTuiStore.getState().setQuitConfirmOpen(true);
      return true;
    });
  }, [hasActiveRound]);
  const revealed = Boolean(run?.revealed || feedback);
  const isSelfGraded = kind === 'flashcard' || isRubricEligibleKind;
  const needsRating = Boolean(run && !isFinished && revealed && !feedback && !gradeResult && isSelfGraded);
  const options: CardOptionItem[] = useMemo(
    () => resolveOptions(run?.card as Record<string, unknown> | undefined, kind, lang),
    [run?.card, kind, lang],
  );
  const clozeData = useMemo(
    () => (kind === 'fill_blank' ? resolveClozeBlanks(run?.card as Record<string, unknown> | undefined) : null),
    [kind, run?.card],
  );
  const isExam = run?.mode === 'exam';
  const canUndo = Boolean(run && !isExam && (run as { undoable?: unknown }).undoable);
  const effectiveClozeValues = useMemo(() => {
    const fbAns = feedback?.answers;
    if (fbAns && typeof fbAns === 'object') {
      return { ...fbAns, ...clozeInputs };
    }
    return clozeInputs;
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

  // Actions
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
    [busy, applyRun, notify],
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
    void runAction(() => endReview(host, run.id), true);
  }, [run, busy, clearDraftTimer, runAction, host]);

  const handleSubmitFlag = useCallback(async () => {
    const deckId =
      run?.deckId ||
      run?.navigation?.find((n) => n.index === run.index)?.deckId ||
      '';
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
  }, [run, cardId, flagReason, host, lang, notify]);

  const handlePracticeWeak = useCallback(() => {
    if (!run?.id || busy) return;
    clearDraftTimer();
    void runAction(async () => {
      const res = await tryAction<ReviewRun>(host, 'review.weak.start', { runId: run.id });
      if (!res.ok || !res.value) throw new Error(res.error?.message || t(lang, '本轮暂无薄弱题', 'No weak cards to retry'));
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
  }, [run, cardId, translating, showTranslation, host, notify, lang]);

  const gradeAnswerText = useMemo(() => {
    const draft = openDraft.trim();
    if (draft) return draft;
    if (typeof feedback?.answer === 'string' && feedback.answer.trim()) return feedback.answer.trim();
    const serverDraft = (run as { draft?: { text?: unknown } } | null)?.draft?.text;
    if (typeof serverDraft === 'string' && serverDraft.trim()) return serverDraft.trim();
    return '';
  }, [openDraft, feedback, run]);

  const canRubricGrade = Boolean(run && !isFinished && isRubricEligibleKind && gradeAnswerText.length > 0);

  const activeRubric = useMemo<RubricSummaryShape | null>(() => {
    if (gradeResult?.rubric) return gradeResult.rubric;
    const fbRubric = (feedback as { rubric?: unknown } | null)?.rubric;
    if (fbRubric && typeof fbRubric === 'object') return fbRubric as RubricSummaryShape;
    return null;
  }, [gradeResult, feedback]);

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
  }, [run, cardId, busy, gradingBusy, isRubricEligibleKind, clearDraftTimer, gradeAnswerText, host, lang, notify, applyRun]);

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
  }, [run, cardId, focusBusy, host, notify, lang, focusOverrideByCard, refresh, applyRun]);

  const canAdjustGrade = canAdjustAiGrade(
    run,
    run ? (run.entry ?? { retry: Boolean(run.retry) }) : null,
    feedback,
  );
  const canAckCorrection = Boolean(run && !isFinished && run.mode !== 'exam' && feedback?.correctionPending);
  const canCoachNudge = Boolean(
    run && !isFinished && run.mode !== 'exam' && feedback && typeof feedback.grade === 'number' && feedback.grade < 3,
  );
  const nudgeCacheKey = `${run?.id ?? ''}:${run?.index ?? -1}:${cardId ?? ''}:${feedback?.grade ?? ''}:${feedback?.correct ?? ''}`;

  useEffect(() => {
    if (!canCoachNudge && nudgeModalOpen) {
      setNudgeModalOpen(false);
    }
  }, [canCoachNudge, nudgeModalOpen]);

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
        notify(
          t(lang, `已将 AI 评分调整为 ${grade}`, `Adjusted AI grade to ${grade}`),
          'success',
        );
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setBusy(false);
      }
    },
    [run, cardId, busy, canAdjustGrade, host, applyRun, notify, lang],
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
      notify(
        t(lang, '已确认订正并加入本轮重练', 'Correction acknowledged and queued for retry'),
        'success',
      );
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }, [run, cardId, busy, canAckCorrection, host, applyRun, notify, lang]);

  // Phase-aware key claiming: only claim digits when rating (0-5) or picking choices (1-6 / 1-2)
  const anyModalOpen =
    aiDrawerOpen ||
    flagModalOpen ||
    similarModalOpen ||
    cardToolsModalOpen ||
    queueModalOpen ||
    retellModalOpen ||
    teachModalOpen ||
    answerCardModalOpen ||
    gradeAdjustModalOpen ||
    nudgeModalOpen ||
    confirmEndOpen;
  const mainActive = isActive && !anyModalOpen && !clozeEditing && !openEditing && !isFinished;
  const claimedKeys = useMemo<readonly string[]>(() => {
    if (!isActive || loading) return [];
    if (!run) return EMPTY_CLAIMED_KEYS;
    if (isFinished) return [];
    const baseUtil = [
      ...CARD_UTIL_KEYS,
      ...(isRubricEligibleKind ? ['G'] : []),
      ...(canAdjustGrade ? ['J'] : []),
      ...(canAckCorrection ? ['K'] : []),
    ];
    if (needsRating) return [...baseUtil, ...RATING_DIGIT_KEYS];
    if (!revealed && !feedback) {
      if (kind === 'true_false') return [...baseUtil, ...TF_DIGIT_KEYS];
      if (kind === 'single' || kind === 'multiple') return [...baseUtil, ...CHOICE_DIGIT_KEYS];
    }
    return baseUtil;
  }, [isActive, loading, run, isFinished, isRubricEligibleKind, canAdjustGrade, canAckCorrection, needsRating, revealed, feedback, kind]);
  useClaimKeys(claimedKeys, mainActive);

  const hints: KeyHint[] = useMemo(() => {
    if (loading || !run || isFinished) return [];
    const base: KeyHint[] = [];
    if (!revealed && !feedback) {
      if (kind === 'single') base.push({ key: '1-6/a-f', label: t(lang, '选择提交', 'Select') });
      else if (kind === 'multiple') {
        base.push({ key: '1-6/Space', label: t(lang, '勾选', 'Toggle') });
        base.push({ key: 'Enter', label: t(lang, '提交', 'Submit') });
      } else if (kind === 'true_false') {
        base.push({ key: asciiMode ? '1/t - 2/f' : '1/t · 2/f', label: t(lang, '判断', 'Judge') });
      } else if (kind === 'fill_blank') {
        base.push({ key: 'i/Enter', label: t(lang, '填空', 'Type') });
      } else if (isRubricEligibleKind) {
        base.push({ key: 'i', label: t(lang, '作答', 'Type') });
        base.push({ key: 'Space', label: t(lang, '翻看答案', 'Reveal') });
      } else {
        base.push({ key: 'Space/Enter', label: t(lang, '翻卡', 'Flip') });
      }
    } else if (needsRating) {
      base.push({ key: '0-5', label: t(lang, 'FSRS评分', 'Rate 0-5') });
    } else {
      base.push({ key: 'Enter / .', label: t(lang, '下一题', 'Next') });
    }
    if (canRubricGrade && !activeRubric) {
      base.push({ key: 'G', label: t(lang, 'AI评分', 'Grade') });
    }
    if (canAdjustGrade) {
      base.push({ key: 'J', label: t(lang, '改分', 'Adjust') });
    }
    if (canAckCorrection) {
      base.push({ key: 'K', label: t(lang, '确认订正', 'Ack fix') });
    }
    if (canCoachNudge) {
      base.push({ key: 'N', label: t(lang, '陪学点拨', 'Nudge') });
    }
    base.push({ key: 'h', label: t(lang, 'AI讲解', 'AI Help') });
    base.push({ key: 'L', label: t(lang, '带学', 'Teach') });
    base.push({ key: '*', label: t(lang, '重点', 'Focus') });
    base.push({ key: 'F', label: t(lang, '复述', 'Retell') });
    base.push({ key: 'T', label: t(lang, '翻译', 'Trans') });
    base.push({ key: 'S', label: t(lang, '同类', 'Similar') });
    base.push({ key: 'D', label: t(lang, '工具', 'Tools') });
    if (run.mode !== 'exam') base.push({ key: 'Q', label: t(lang, '队列', 'Queue') });
    if (canUndo) base.push({ key: 'u', label: t(lang, '撤销评分', 'Undo') });
    base.push({ key: 'A', label: t(lang, '答题卡', 'AnswerCard') });
    base.push({ key: 'm', label: mathUnicode ? 'Unicode' : 'LaTeX' });
    if (citation) base.push({ key: 'o', label: t(lang, '原文', 'Source') });
    base.push({ key: 'X', label: t(lang, '结束', 'End') });
    return base;
  }, [
    loading,
    run,
    isFinished,
    revealed,
    feedback,
    kind,
    isRubricEligibleKind,
    needsRating,
    canRubricGrade,
    activeRubric,
    canAdjustGrade,
    canAckCorrection,
    canCoachNudge,
    canUndo,
    mathUnicode,
    asciiMode,
    citation,
    lang,
  ]);
  useFooterHints(hints, isActive && !anyModalOpen && !isFinished);

  // Main keyboard controller for active question
  useInput(
    (input, key) => {
      if (key.escape) {
        goBack();
        return;
      }
      if (!run || !run.card || busy) return;

      // Global card utilities
      if (input === 'h') {
        setAiDrawerOpen(true);
        return;
      }
      if (input === 'F') {
        setRetellModalOpen(true);
        return;
      }
      if (input === 'L') {
        setTeachModalOpen(true);
        return;
      }
      if (input === '*') {
        void handleToggleFocus();
        return;
      }
      if (input === 'G' && isRubricEligibleKind) {
        void handleRubricGrade();
        return;
      }
      if (input === 'J' && canAdjustGrade) {
        setGradeAdjustModalOpen(true);
        return;
      }
      if (input === 'K' && canAckCorrection) {
        void handleAckCorrection();
        return;
      }
      if (input === 'N') {
        if (canCoachNudge) {
          setNudgeModalOpen(true);
        } else if (run.mode === 'exam') {
          notify(t(lang, '模拟考试期间不可开启陪学点拨', 'Coach nudge is unavailable in exam mode'), 'info');
        } else if (!feedback) {
          notify(
            t(lang, '请先作答且答错或自评低于3分后再开启陪学点拨', 'Answer first (wrong or rating < 3) to open coach nudge'),
            'info',
          );
        } else {
          notify(
            t(lang, '仅在答错或自评低于3分时可开启陪学点拨', 'Coach nudge is only available for wrong answers or ratings < 3'),
            'info',
          );
        }
        return;
      }
      if (input === 'T') {
        void handleToggleTranslate();
        return;
      }
      if (input === 'S') {
        setSimilarModalOpen(true);
        return;
      }
      if (input === 'D') {
        setCardToolsModalOpen(true);
        return;
      }
      if (input === 'Q') {
        if (run.mode !== 'exam') {
          setQueueModalOpen(true);
        } else {
          notify(t(lang, '模拟考试队列已锁定，不能修改', 'Exam queue is locked'), 'info');
        }
        return;
      }
      if (input === 'A') {
        setAnswerCardModalOpen(true);
        return;
      }
      if (input === 'm') {
        setPreferences({ mathUnicode: !mathUnicode });
        return;
      }
      if (input === 'E') {
        setFlagReason('');
        setFlagModalOpen(true);
        return;
      }
      if (input === 'o' && citation) {
        navigate('sources', { sourceId: citation.sourceId, pageNumber: citation.pageNumber });
        return;
      }
      if (input === 'u' && !key.ctrl && !key.meta) {
        handleUndo();
        return;
      }
      if (input === 's' && !feedback) {
        handleSkip();
        return;
      }
      if (input === ',' || key.leftArrow) {
        handleMove(-1);
        return;
      }
      if (input === '.' || key.rightArrow) {
        handleMove(1);
        return;
      }
      if (input === 'X') {
        setConfirmEndOpen(true);
        return;
      }

      // Rating phase for flashcards & self-graded open questions
      if (needsRating) {
        const gradeSpec = FSRS_GRADES.find((g) => g.key === input);
        if (gradeSpec) {
          handleFsrsGrade(gradeSpec.grade);
        }
        return;
      }

      // Post-feedback phase: Enter advances to next card
      if (feedback) {
        if (key.return) {
          handleMove(1);
        }
        return;
      }

      // Answering phase by kind
      if (kind === 'flashcard') {
        if (input === ' ' || key.return) {
          handleReveal();
        }
        return;
      }

      if (isRubricEligibleKind) {
        if (input === ' ') {
          handleReveal();
        } else if (input === 'i' || key.return) {
          setOpenEditing(true);
        }
        return;
      }

      if (kind === 'fill_blank') {
        if (input === 'i' || key.return) {
          setClozeEditing(true);
        }
        return;
      }

      if (kind === 'true_false') {
        if (input === '1' || input === 't') {
          const id = options[0]?.id || 'true';
          setSelectedIds([id]);
          handleSubmitChoice([id]);
        } else if (input === '2' || input === 'f') {
          const id = options[1]?.id || 'false';
          setSelectedIds([id]);
          handleSubmitChoice([id]);
        } else if (key.downArrow || input === 'j') {
          setCursorOpt((prev) => Math.min(Math.max(0, options.length - 1), prev + 1));
        } else if (key.upArrow || input === 'k') {
          setCursorOpt((prev) => Math.max(0, prev - 1));
        } else if (key.return && options[cursorOpt]) {
          const id = options[cursorOpt].id;
          setSelectedIds([id]);
          handleSubmitChoice([id]);
        }
        return;
      }

      if (kind === 'single' || kind === 'multiple') {
        if (key.downArrow || input === 'j') {
          setCursorOpt((prev) => Math.min(Math.max(0, options.length - 1), prev + 1));
          return;
        }
        if (key.upArrow || input === 'k') {
          setCursorOpt((prev) => Math.max(0, prev - 1));
          return;
        }
        let pickedIdx = -1;
        if (/^[1-6]$/.test(input)) pickedIdx = Number(input) - 1;
        else if (/^[a-f]$/.test(input)) pickedIdx = input.charCodeAt(0) - 97;

        if (pickedIdx >= 0 && pickedIdx < options.length) {
          const targetId = options[pickedIdx].id;
          setCursorOpt(pickedIdx);
          if (kind === 'single') {
            setSelectedIds([targetId]);
            handleSubmitChoice([targetId]);
          } else {
            setSelectedIds((prev) =>
              prev.includes(targetId) ? prev.filter((x) => x !== targetId) : [...prev, targetId],
            );
          }
          return;
        }

        if (kind === 'multiple') {
          if (input === ' ' && options[cursorOpt]) {
            const targetId = options[cursorOpt].id;
            setSelectedIds((prev) =>
              prev.includes(targetId) ? prev.filter((x) => x !== targetId) : [...prev, targetId],
            );
            return;
          }
          if (key.return) {
            if (selectedIds.length > 0) {
              handleSubmitChoice(selectedIds);
            } else if (options[cursorOpt]) {
              const targetId = options[cursorOpt].id;
              setSelectedIds([targetId]);
              handleSubmitChoice([targetId]);
            }
          }
        } else if (kind === 'single' && key.return && options[cursorOpt]) {
          const targetId = options[cursorOpt].id;
          setSelectedIds([targetId]);
          handleSubmitChoice([targetId]);
        }
      }
    },
    { isActive: mainActive },
  );

  // Empty state shortcuts
  useInput(
    (input, key) => {
      if (key.escape) goBack();
      else if (input === 'l' || input === 'L') navigate('library');
      else if ((key.ctrl && input === 'r') || input === 'R') void loadInitialRun(true);
    },
    { isActive: isActive && !loading && !run },
  );

  // Hooks above, early returns below.
  const activeTranslation = useMemo<CardTranslation | null>(() => {
    if (!showTranslation || !cardId) return null;
    void translationTick;
    return translationCacheRef.current.get(cardId) ?? null;
  }, [showTranslation, cardId, translationTick]);

  const userAnswerText = useMemo(
    () => extractUserAnswerText(run, kind, selectedIds, clozeInputs, openDraft, lang),
    [run, kind, selectedIds, clozeInputs, openDraft, lang],
  );

  const handleAiHistoryChange = useCallback((targetCardId: string, nextTurns: AiTurn[]) => {
    setAiHistoryByCard((prev) => ({ ...prev, [targetCardId]: nextTurns }));
  }, []);

  const handleSavedFollowup = useCallback((targetCardId: string, item: SavedFollowupItem) => {
    setSavedFollowupsByCard((prev) => {
      const existing = prev[targetCardId] ?? [];
      if (existing.some((x) => x.id === item.id)) return prev;
      return { ...prev, [targetCardId]: [...existing, item] };
    });
  }, []);

  const savedFollowupCount = useMemo(() => {
    const sol = solution?.followups ?? [];
    const extra = cardId ? savedFollowupsByCard[cardId] ?? [] : [];
    if (extra.length === 0) return sol.length;
    const seen = new Set(sol.map((f) => f.id).filter(Boolean));
    let count = sol.length;
    for (const item of extra) {
      if (!item.id || !seen.has(item.id)) count += 1;
    }
    return count;
  }, [solution, cardId, savedFollowupsByCard]);

  const stemMarkdown = useMemo(() => {
    if (!run) return '';
    const baseStem =
      kind === 'fill_blank' && clozeData
        ? formatClozeDisplay(clozeData.text, clozeData.blanks, effectiveClozeValues, revealed, solution, asciiMode)
        : String(run.card?.prompt ?? '');
    if (!activeTranslation) return baseStem;
    const trStemRaw =
      kind === 'fill_blank' && activeTranslation.clozeText
        ? activeTranslation.clozeText.replace(/\{\{[^{}]+\}\}/g, asciiMode ? '___' : '＿＿')
        : activeTranslation.prompt;
    if (!trStemRaw) return baseStem;
    return `${baseStem}\n\n> **EN**: ${trStemRaw}`;
  }, [run, kind, clozeData, effectiveClozeValues, revealed, solution, activeTranslation, asciiMode]);

  const referenceAnswer = useMemo(
    () => (run && revealed ? extractReferenceAnswer(run, kind, lang) : ''),
    [revealed, run, kind, lang],
  );

  const postAnswerMarkdown = useMemo(() => {
    const blocks: string[] = [];
    if (activeRubric) {
      const criteria = Array.isArray(activeRubric.criteria) ? activeRubric.criteria : [];
      if (criteria.length > 0) {
        blocks.push(`### ${t(lang, 'AI 评分细则', 'AI Rubric Breakdown')}`);
        for (const c of criteria) {
          const mark =
            c.max > 0 && c.score >= c.max
              ? asciiMode
                ? '[+]'
                : '✓'
              : c.score > 0
                ? asciiMode
                  ? '[~]'
                  : '◐'
                : asciiMode
                  ? '[x]'
                  : '✕';
          blocks.push(`- ${mark} **${c.label || c.id}** (${c.score}/${c.max})`);
          if (Array.isArray(c.evidence) && c.evidence.length > 0) {
            blocks.push(`  - ${t(lang, '命中依据', 'Evidence')}: "${c.evidence[0]}"`);
          }
          if (Array.isArray(c.missing) && c.missing.length > 0) {
            const missTexts = c.missing
              .map((m) => (typeof m?.text === 'string' ? m.text.trim() : ''))
              .filter(Boolean);
            if (missTexts.length > 0) {
              blocks.push(`  - ${t(lang, '遗漏要点', 'Missing')}: ${missTexts.join('; ')}`);
            }
          }
          if (c.suggestion) {
            blocks.push(`  - ${t(lang, '改进建议', 'Suggestion')}: ${c.suggestion}`);
          }
        }
      }
      if (activeRubric.summary) {
        blocks.push(`> **${t(lang, '总评', 'Feedback')}**: ${activeRubric.summary}`);
      }
    }
    if (revealed) {
      if (solution?.explanation) blocks.push(solution.explanation);
      if (activeTranslation?.explanation) blocks.push(`> **EN**: ${activeTranslation.explanation}`);
      if (solution?.misconception) {
        blocks.push(`> **${t(lang, '常见误区', 'Misconception')}**: ${solution.misconception}`);
      }
    }
    return blocks.join('\n\n');
  }, [activeRubric, asciiMode, revealed, solution, activeTranslation, lang]);

  if (loading) {
    return (
      <Box width={width} height={height} alignItems="center" justifyContent="center">
        <Spinner
          label={
            asciiMode
              ? t(lang, '正在准备复习队列...', 'Preparing review queue...')
              : t(lang, '正在准备复习队列…', 'Preparing review queue…')
          }
          active={isActive}
        />
      </Box>
    );
  }

  if (!run) {
    return (
      <Panel title={t(lang, '刷题复习', 'Review')} icon={asciiMode ? '>' : '▶'} width={width} height={height}>
        <EmptyState
          icon={asciiMode ? '*' : '✦'}
          title={t(lang, '当前没有待复习题目', 'No questions due for review')}
          hint={loadError || t(lang, '可以先去学习库挑选一个题组，或导入新资料生成题目。', 'Pick a deck in Library or generate cards from Sources.')}
          actions={[
            { key: 'L', label: t(lang, '返回学习库', 'Go to Library') },
            { key: 'R', label: t(lang, '重新加载', 'Reload') },
          ]}
          width={Math.max(20, width - 4)}
          height={Math.max(6, height - 4)}
        />
      </Panel>
    );
  }

  if (isFinished) {
    return (
      <Suspense
        fallback={
          <Box paddingX={1} paddingY={1}>
            <Spinner
              label={t(
                lang,
                asciiMode ? '正在载入总结...' : '正在载入总结…',
                asciiMode ? 'Loading summary...' : 'Loading summary…',
              )}
              active={isActive}
            />
          </Box>
        }
      >
        <RoundSummary
          host={host}
          run={run}
          width={width}
          height={height}
          isActive={isActive}
          mathUnicode={mathUnicode}
          onPracticeWeak={handlePracticeWeak}
          onNewRound={() => void loadInitialRun(true)}
          onGoLibrary={() => navigate('library')}
        />
      </Suspense>
    );
  }

  // Split view width if AI Drawer is open on wide terminals; overlay on narrow terminals
  const sideBySideAi = aiDrawerOpen && width >= 104;
  const cardPaneW = sideBySideAi ? Math.max(44, Math.floor(width * 0.56)) : width;
  const aiPaneW = sideBySideAi ? Math.max(32, width - cardPaneW - 1) : width;

  const totalCount = Math.max(1, Number(run.total || run.navigation?.length || 1));
  const atNum = Math.min(totalCount, Number(run.position?.at ?? run.index + 1) || 1);
  const answeredCount = Number(run.answered ?? 0) || 0;
  const topicName = typeof run.card?.topic === 'string' && run.card.topic ? run.card.topic : '';
  const isCardFocused =
    cardId && cardId in focusOverrideByCard ? focusOverrideByCard[cardId] : Boolean(run.card?.focus);

  const innerW = Math.max(20, cardPaneW - 4);
  const progressRatio = totalCount > 0 ? Math.min(1, answeredCount / totalCount) : 0;
  const panelTitleStr = String(run.title || t(lang, 'FSRS-6 间隔复习', 'FSRS-6 Review'));
  const panelBadgeStr = `${atNum}/${totalCount}`;
  const panelSubtitleStr = `${kindLabel(kind, lang)}${topicName ? `${asciiMode ? ' - ' : ' · '}${topicName}` : ''}`;
  // Detect whether Panel top border had to truncate title or subtitle on narrow widths.
  const panelHeaderAvail = Math.max(
    0,
    cardPaneW - 4 - 2 - (displayWidth(` ${panelBadgeStr} `) + 1) - (panelSubtitleStr ? 2 : 0) - 1,
  );
  const panelHeaderTruncated =
    displayWidth(`${asciiMode ? '>' : '▶'} ${panelTitleStr}`) + displayWidth(panelSubtitleStr) > panelHeaderAvail;

  return (
    <Box flexDirection="row" width={width} height={height}>
      {/* Main Question Workspace (hidden on narrow terminals while AI Drawer is open) */}
      {!(aiDrawerOpen && !sideBySideAi) ? (
        <Panel
          title={panelTitleStr}
          icon={asciiMode ? '>' : '▶'}
          badge={panelBadgeStr}
          badgeTone="primary"
          subtitle={panelSubtitleStr}
          focused={mainActive}
          width={cardPaneW}
          height={height}
          paddingX={1}
        >
          {/* Top progress & status bar */}
          <Box flexDirection="row" alignItems="center" justifyContent="space-between" flexShrink={0} width={innerW} marginBottom={0}>
            <Box flexDirection="row" alignItems="center" gap={1}>
              <ProgressBar
                ratio={progressRatio}
                width={Math.min(20, Math.max(8, Math.floor(innerW * 0.25)))}
                showPercent={false}
              />
              <Text color={theme.muted}>{`${answeredCount}/${totalCount}`}</Text>
              {run.retry ? <Badge label={t(lang, '再练', 'Retry')} tone="warning" variant="soft" /> : null}
              {isCardFocused ? (
                <Badge
                  label={
                    asciiMode
                      ? lang === 'en'
                        ? '* Focus'
                        : '* 重点'
                      : lang === 'en'
                        ? '★ Focus'
                        : '★ 重点'
                  }
                  tone="accent"
                  variant="soft"
                />
              ) : null}
            </Box>
            <Box flexDirection="row" alignItems="center" gap={1}>
              {busy || translating ? <Spinner tone="primary" active={isActive} /> : null}
              {activeTranslation ? <Badge label="EN 译" tone="info" variant="soft" /> : null}
              <Badge label={mathUnicode ? (asciiMode ? 'Unicode' : '∑ Unicode') : 'TeX Raw'} tone="neutral" variant="outline" />
            </Box>
          </Box>
          {panelHeaderTruncated ? (
            <Box flexDirection="column" flexShrink={0} width={innerW}>
              {wrapDisplay(
                `${panelTitleStr}${asciiMode ? ' | ' : ' · '}${panelSubtitleStr}`,
                innerW,
              ).map((line, i) => (
                <Text key={`hdr-${i}`} color={theme.muted}>
                  {line}
                </Text>
              ))}
            </Box>
          ) : null}

          <Divider width={innerW} />

          {/* Question Stem */}
          <Box flexDirection="column" flexShrink={0} width={innerW} marginY={0}>
            <MarkdownView
              markdown={stemMarkdown}
              width={innerW}
              mathUnicode={mathUnicode}
            />
          </Box>

          {/* Interactive Answering Area */}
          {(kind === 'single' || kind === 'multiple' || kind === 'true_false') && options.length > 0 ? (
            <Box flexDirection="column" marginTop={1} width={innerW}>
              {options.map((opt, idx) => {
                const activeIds = feedback?.selected ?? selectedIds;
                const isSelected = activeIds.includes(opt.id);
                const isCursor = !feedback && idx === cursorOpt;
                const solOpt = solution?.options?.find((o) => o.id === opt.id);
                const isCorrectOpt = Boolean(solOpt?.correct);

                let mark =
                  kind === 'multiple'
                    ? isSelected
                      ? asciiMode
                        ? '[x]'
                        : '[✓]'
                      : '[ ]'
                    : isSelected
                      ? asciiMode
                        ? '(*)'
                        : '(●)'
                      : '( )';
                let lineColor = isCursor ? theme.primary : isSelected ? theme.accent : theme.text;
                if (feedback) {
                  if (isCorrectOpt) {
                    mark = asciiMode ? '+' : '✓';
                    lineColor = theme.success;
                  } else if (isSelected && !isCorrectOpt) {
                    mark = asciiMode ? 'x' : '✕';
                    lineColor = theme.error;
                  } else {
                    mark = asciiMode ? '.' : '·';
                    lineColor = theme.muted;
                  }
                }
                const keyTag = kind === 'true_false'
                  ? (idx === 0 ? '[1/t]' : '[2/f]')
                  : `[${idx + 1}/${String.fromCharCode(97 + idx)}]`;
                const trOptText = activeTranslation?.options?.find((o) => o.id === opt.id)?.text;
                const onClickOption = () => {
                  if (!mainActive || feedback) return;
                  setCursorOpt(idx);
                  if (kind === 'multiple') {
                    setSelectedIds((prev) =>
                      prev.includes(opt.id) ? prev.filter((x) => x !== opt.id) : [...prev, opt.id],
                    );
                  } else {
                    setSelectedIds([opt.id]);
                    handleSubmitChoice([opt.id]);
                  }
                };
                return (
                  <ClickableBox key={opt.id} flexDirection="column" width={innerW} clickActive={mainActive && !feedback} onClick={onClickOption}>
                    <Box flexDirection="row" width={innerW}>
                      <Text color={isCursor ? theme.primary : theme.dim} bold={isCursor}>
                        {isCursor ? (asciiMode ? '> ' : '▸ ') : '  '}
                      </Text>
                      <Text color={theme.muted}>{`${keyTag} `}</Text>
                      <Text color={lineColor} bold={isSelected || isCorrectOpt || isCursor}>
                        {`${mark} ${opt.text}`}
                      </Text>
                    </Box>
                    {trOptText ? (
                      <Text color={theme.muted}>{`      EN: ${trOptText}`}</Text>
                    ) : null}
                  </ClickableBox>
                );
              })}
              {kind === 'multiple' && !feedback ? (
                <ClickableBox
                  clickActive={mainActive && selectedIds.length > 0}
                  onClick={() => {
                    if (selectedIds.length > 0) handleSubmitChoice(selectedIds);
                  }}
                >
                  <Text color={theme.dim}>
                    {t(lang, '  提示: 1-6/Space 勾选多选，Enter 提交答案', '  Hint: 1-6/Space to toggle, Enter to submit')}
                  </Text>
                </ClickableBox>
              ) : null}
            </Box>
          ) : null}

          {/* Cloze blanks editor */}
          {kind === 'fill_blank' && clozeData && !feedback ? (
            <Box flexDirection="column" marginTop={1} width={innerW}>
              {clozeData.blanks.length > 1 ? (
                <Box flexDirection="row" alignItems="center" gap={1} marginBottom={0} width={innerW} overflow="hidden">
                  <Badge
                    label={`${Math.min(activeBlankIdx, Math.max(0, clozeData.blanks.length - 1)) + 1}/${clozeData.blanks.length}`}
                    tone={clozeEditing ? 'primary' : 'neutral'}
                    variant="outline"
                  />
                  <Text color={theme.dim} wrap="truncate">
                    {truncateDisplay(
                      clozeEditing
                        ? asciiMode
                          ? t(lang, 'Tab 下一空 | Enter 下一空/提交 | Esc 退出', 'Tab next blank | Enter next/submit | Esc blur')
                          : t(lang, 'Tab 下一空 · Enter 下一空/提交 · Esc 退出', 'Tab next blank · Enter next/submit · Esc blur')
                        : t(lang, '按 [i] 或 [Enter] 开始填空', 'Press [i] or [Enter] to fill blanks'),
                      Math.max(10, innerW - 10),
                      asciiMode ? '...' : '…',
                    )}
                  </Text>
                </Box>
              ) : null}
              {clozeData.blanks.map((blank, idx) => {
                const safeIdx = Math.min(activeBlankIdx, Math.max(0, clozeData.blanks.length - 1));
                const isThisActive = clozeEditing && idx === safeIdx;
                return (
                  <Box
                    key={blank.id}
                    flexDirection="row"
                    borderStyle={asciiMode ? 'classic' : 'single'}
                    borderColor={isThisActive ? theme.primary : theme.border}
                    paddingX={1}
                    width={Math.min(innerW, 64)}
                  >
                    <Text color={theme.muted}>{`#${idx + 1} `}</Text>
                    <TextInput
                      value={clozeInputs[blank.id] ?? ''}
                      onChange={(val) => {
                        const next = { ...clozeInputs, [blank.id]: val };
                        setClozeInputs(next);
                        scheduleDraftSave({ stepInputs: next });
                      }}
                      isActive={isActive && !anyModalOpen && isThisActive}
                      width={Math.max(12, Math.min(innerW, 64) - 10)}
                      placeholder={t(lang, '输入答案 (Enter 下一空/提交, Esc 退出)', 'Type answer (Enter next/submit, Esc blur)')}
                      onTab={() => {
                        setActiveBlankIdx((idx + 1) % clozeData.blanks.length);
                        return undefined;
                      }}
                      onSubmit={(val) => {
                        const updated = { ...clozeInputs, [blank.id]: val };
                        setClozeInputs(updated);
                        if (idx + 1 < clozeData.blanks.length) {
                          setActiveBlankIdx(idx + 1);
                        } else {
                          setClozeEditing(false);
                          handleSubmitCloze(updated);
                        }
                      }}
                      onCancel={() => setClozeEditing(false)}
                    />
                  </Box>
                );
              })}
            </Box>
          ) : null}

          {/* Short answer / open / case draft input */}
          {isRubricEligibleKind && !revealed ? (
            <Box
              flexDirection="column"
              marginTop={1}
              borderStyle={asciiMode ? 'classic' : 'single'}
              borderColor={openEditing ? theme.primary : theme.border}
              paddingX={1}
              width={innerW}
            >
              <Text color={theme.muted}>
                {openDraft.trim()
                  ? t(
                      lang,
                      '你的作答（[i] 编辑，Enter 翻看，[G] AI 按标准评分，[Space] 翻看）:',
                      'Your answer ([i] edit, Enter reveal, [G] AI rubric grade, [Space] reveal):',
                    )
                  : t(
                      lang,
                      '你的作答（按 [i] 输入，Enter 翻看答案；或按 [Space] 直接翻看）:',
                      'Your answer ([i] to type, Enter to reveal; or [Space] to reveal):',
                    )}
              </Text>
              <TextInput
                value={openDraft}
                onChange={(val) => {
                  setOpenDraft(val);
                  scheduleDraftSave({ text: val });
                }}
                isActive={isActive && !anyModalOpen && openEditing}
                width={Math.max(16, innerW - 6)}
                placeholder={
                  asciiMode
                    ? t(lang, '输入你的思路或简答...', 'Type your answer or key points...')
                    : t(lang, '输入你的思路或简答…', 'Type your answer or key points…')
                }
                onSubmit={() => {
                  setOpenEditing(false);
                  handleReveal();
                }}
                onCancel={() => setOpenEditing(false)}
              />
            </Box>
          ) : null}

          {/* Flashcard front prompt */}
          {kind === 'flashcard' && !isRubricEligibleKind && !revealed ? (
            <ClickableBox marginTop={1} clickActive={mainActive} onClick={() => handleReveal()}>
              <Badge label={t(lang, '按 [Space] 或 [Enter] 翻开答案', 'Press [Space] or [Enter] to flip card')} tone="primary" variant="soft" />
            </ClickableBox>
          ) : null}

          {/* Post-Reveal / Post-Answer / Rubric Grading Panel */}
          {revealed || activeRubric || gradingBusy || gradeError ? (
            <Box flexDirection="column" marginTop={1} width={innerW} flexGrow={1} overflow="hidden">
              <Divider
                width={innerW}
                label={
                  revealed
                    ? t(lang, '答案与解析', 'Answer & Explanation')
                    : t(lang, 'AI 评分反馈', 'AI Rubric Feedback')
                }
              />

              {gradingBusy ? (
                <Box marginY={0}>
                  <Spinner
                    label={
                      asciiMode
                        ? t(lang, '正在按评分标准 AI 批改...', 'Grading against rubric criteria...')
                        : t(lang, '正在按评分标准 AI 批改…', 'Grading against rubric criteria…')
                    }
                    tone="ai"
                    active={isActive}
                  />
                </Box>
              ) : null}

              {gradeError ? (
                <Box flexDirection="column" marginY={0}>
                  <Box flexDirection="row" gap={1}>
                    <Badge label={asciiMode ? '! AI评分不可用' : '▲ AI评分不可用'} tone="warning" />
                    <Text color={theme.error}>
                      {truncateDisplay(gradeError, Math.max(12, innerW - 18), asciiMode ? '...' : '…')}
                    </Text>
                  </Box>
                  <Text color={theme.muted}>
                    {isModelUnavailableMsg(gradeError)
                      ? t(
                          lang,
                          '未检测到可用 AI 模型：请按 [,] 配置模型，或按 [Space] 对照参考答案后用 [0-5] 自评。',
                          'Model unavailable: configure one in Settings ([,]), or reveal reference answer and self-rate [0-5].',
                        )
                      : t(
                          lang,
                          '暂无法按评分标准批改，请对照参考答案后用 [0-5] 自评。',
                          'Could not run rubric grading; reveal reference answer and self-rate [0-5].',
                        )}
                  </Text>
                </Box>
              ) : null}

              {(() => {
                const undoLabel = asciiMode
                  ? t(lang, '[u] 可撤销', '[u] Undoable')
                  : t(lang, '↺ [u] 可撤销', '↺ [u] Undoable');
                const yoursFull = userAnswerText ? `${t(lang, '你的作答', 'Yours')}: ${userAnswerText}` : '';
                if (feedback) {
                  const statusLabel = feedback.correct
                    ? asciiMode
                      ? t(lang, '+ 回答正确', '+ Correct')
                      : t(lang, '✓ 回答正确', '✓ Correct')
                    : feedback.selfReported
                      ? asciiMode
                        ? t(lang, 'o 已自报', 'o Self-reported')
                        : t(lang, '○ 已自报', '○ Self-reported')
                      : asciiMode
                        ? t(lang, 'x 回答有误', 'x Incorrect')
                        : t(lang, '✕ 回答有误', '✕ Incorrect');
                  const usedW =
                    displayWidth(statusLabel) +
                    2 +
                    (feedback.level ? displayWidth(String(feedback.level)) + 3 : 0) +
                    (canUndo ? displayWidth(undoLabel) + 3 : 0);
                  const fitsInline = Boolean(yoursFull) && usedW + 1 + displayWidth(yoursFull) <= innerW;
                  return (
                    <Box flexDirection="column" flexShrink={0} marginBottom={0} width={innerW}>
                      <Box flexDirection="row" alignItems="center" flexWrap="wrap" flexShrink={0} gap={1} width={innerW}>
                        <Badge
                          label={statusLabel}
                          tone={feedback.correct ? 'success' : feedback.selfReported ? 'neutral' : 'error'}
                        />
                        {feedback.level ? <Badge label={String(feedback.level)} tone="accent" variant="soft" /> : null}
                        {canUndo ? <Badge label={undoLabel} tone="info" variant="soft" /> : null}
                        {fitsInline ? <Text color={theme.muted}>{yoursFull}</Text> : null}
                      </Box>
                      {yoursFull && !fitsInline ? (
                        <Box flexDirection="column" flexShrink={0} width={innerW}>
                          {wrapDisplay(yoursFull, innerW).map((line, i) => (
                            <Text key={`ans-${i}`} color={theme.muted}>
                              {line}
                            </Text>
                          ))}
                        </Box>
                      ) : null}
                    </Box>
                  );
                }
                if (userAnswerText || canUndo) {
                  const usedW = canUndo ? displayWidth(undoLabel) + 3 : 0;
                  const fitsInline = Boolean(yoursFull) && usedW + (canUndo ? 1 : 0) + displayWidth(yoursFull) <= innerW;
                  return (
                    <Box flexDirection="column" flexShrink={0} marginBottom={0} width={innerW}>
                      {canUndo || fitsInline ? (
                        <Box flexDirection="row" alignItems="center" flexWrap="wrap" flexShrink={0} gap={1} width={innerW}>
                          {canUndo ? <Badge label={undoLabel} tone="info" variant="soft" /> : null}
                          {fitsInline ? <Text color={theme.muted}>{yoursFull}</Text> : null}
                        </Box>
                      ) : null}
                      {yoursFull && !fitsInline ? (
                        <Box flexDirection="column" flexShrink={0} width={innerW}>
                          {wrapDisplay(yoursFull, innerW).map((line, i) => (
                            <Text key={`ans-${i}`} color={theme.muted}>
                              {line}
                            </Text>
                          ))}
                        </Box>
                      ) : null}
                    </Box>
                  );
                }
                return null;
              })()}

              {clozeBlankDiffs.length > 0 ? (
                <Box flexDirection="column" marginY={0} width={innerW}>
                  {clozeBlankDiffs.map((diff) => {
                    const icon =
                      diff.matched === true
                        ? asciiMode
                          ? '+'
                          : '✓'
                        : diff.matched === false
                          ? asciiMode
                            ? 'x'
                            : '✕'
                          : asciiMode
                            ? '?'
                            : '·';
                    const statusColor =
                      diff.matched === true
                        ? theme.success
                        : diff.matched === false
                          ? theme.error
                          : theme.muted;
                    const ell = asciiMode ? '...' : '…';
                    const prefix = `#${diff.index} ${icon} `;
                    const remW = Math.max(8, innerW - displayWidth(prefix));
                    const rawUser = diff.userValue || t(lang, '(未填)', '(empty)');
                    const arrowText = asciiMode ? ' -> ' : ' → ';
                    const showMismatch = diff.matched === false && diff.expected.length > 0;
                    let shownUser = rawUser;
                    let shownExpected = diff.expected;
                    if (showMismatch) {
                      const avail = Math.max(6, remW - displayWidth(arrowText));
                      if (displayWidth(rawUser) + displayWidth(diff.expected) > avail) {
                        const userBudget = Math.max(3, Math.floor(avail * 0.45));
                        shownUser = truncateDisplay(rawUser, userBudget, ell);
                        const expBudget = Math.max(3, avail - displayWidth(shownUser));
                        shownExpected = truncateDisplay(diff.expected, expBudget, ell);
                      }
                    } else {
                      shownUser = truncateDisplay(rawUser, remW, ell);
                    }
                    const userColor = !diff.userValue
                      ? theme.muted
                      : diff.matched === true
                        ? theme.success
                        : diff.matched === false
                          ? theme.error
                          : theme.text;
                    return (
                      <Box key={diff.id} flexDirection="row" width={innerW} overflow="hidden">
                        <Text color={theme.muted}>{`#${diff.index} `}</Text>
                        <Text color={statusColor} bold>{`${icon} `}</Text>
                        <Text color={userColor}>{shownUser}</Text>
                        {showMismatch ? (
                          <>
                            <Text color={theme.muted}>{arrowText}</Text>
                            <Text color={theme.success} bold>{shownExpected}</Text>
                          </>
                        ) : null}
                      </Box>
                    );
                  })}
                </Box>
              ) : null}

              {activeRubric ? (
                <Box flexDirection="row" alignItems="center" flexWrap="wrap" flexShrink={0} gap={1} marginY={0} width={innerW}>
                  <Badge
                    label={`${t(lang, 'Rubric 得分', 'Rubric')} ${activeRubric.total}/${activeRubric.max}`}
                    tone={
                      activeRubric.max > 0 && activeRubric.total / activeRubric.max >= 0.7
                        ? 'success'
                        : activeRubric.max > 0 && activeRubric.total / activeRubric.max > 0.5
                          ? 'warning'
                          : 'error'
                    }
                  />
                  {activeRubric.band ? (
                    <Badge label={String(activeRubric.band)} tone="ai" variant="soft" />
                  ) : null}
                  {feedback?.grade !== undefined || gradeResult?.grade !== undefined ? (
                    <Badge
                      label={`FSRS ${feedback?.grade ?? gradeResult?.grade}/5`}
                      tone="accent"
                      variant="soft"
                    />
                  ) : null}
                  {feedback && typeof feedback.gradeOriginal === 'number' && feedback.gradeOriginal !== feedback.grade ? (
                    <Badge
                      label={t(
                        lang,
                        `已改分 ${feedback.grade} (AI 原评 ${feedback.gradeOriginal})`,
                        `Adjusted ${feedback.grade} (AI: ${feedback.gradeOriginal})`,
                      )}
                      tone="info"
                      variant="soft"
                    />
                  ) : null}
                </Box>
              ) : feedback && typeof feedback.gradeOriginal === 'number' && feedback.gradeOriginal !== feedback.grade ? (
                <Box flexDirection="row" alignItems="center" flexShrink={0} gap={1} marginY={0} width={innerW}>
                  <Badge
                    label={t(
                      lang,
                      `已改分 ${feedback.grade} (AI 原评 ${feedback.gradeOriginal})`,
                      `Adjusted ${feedback.grade} (AI: ${feedback.gradeOriginal})`,
                    )}
                    tone="info"
                    variant="soft"
                  />
                </Box>
              ) : null}

              {canAckCorrection ? (
                <Box flexDirection="row" alignItems="center" flexWrap="wrap" flexShrink={0} gap={1} marginY={0} width={innerW}>
                  <Badge
                    label={truncateDisplay(
                      asciiMode
                        ? t(lang, '待确认订正 - 按 [K] 确认并加入本轮重练', 'Correction pending - press [K] to confirm & queue retry')
                        : t(lang, '待确认订正 · 按 [K] 确认并加入本轮重练', 'Correction pending · press [K] to confirm & queue retry'),
                      Math.max(12, innerW - 2),
                      asciiMode ? '...' : '…',
                    )}
                    tone="warning"
                    variant="soft"
                  />
                </Box>
              ) : null}

              {revealed ? (
                <Box flexDirection="column" flexShrink={0} width={innerW}>
                  <Text color={theme.success} bold>
                    {`${t(lang, '参考答案', 'Reference')}: ${referenceAnswer}`}
                  </Text>
                  {activeTranslation?.answer ? (
                    <Text color={theme.muted}>{`EN: ${activeTranslation.answer}`}</Text>
                  ) : null}
                </Box>
              ) : null}

              {postAnswerMarkdown ? (
                <Box marginTop={0} flexGrow={1} overflow="hidden">
                  <MarkdownView
                    markdown={postAnswerMarkdown}
                    width={innerW}
                    height={Math.max(3, height - (innerW < 90 ? 22 : 18))}
                    mathUnicode={mathUnicode}
                  />
                </Box>
              ) : null}

              {/* Saved AI Explanations Hint */}
              {revealed && savedFollowupCount > 0 ? (
                <ClickableBox
                  marginTop={0}
                  clickActive={mainActive}
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

              {/* Source Citation Bar */}
              {revealed && citation ? (
                <ClickableBox
                  marginTop={0}
                  clickActive={mainActive}
                  onClick={() => navigate('sources', { sourceId: citation.sourceId, pageNumber: citation.pageNumber })}
                >
                  <Text color={theme.info}>
                    {`${asciiMode ? '#' : '▤'} ${citation.title ? `${citation.title} ` : ''}${
                      citation.pageNumber != null
                        ? t(lang, `第 ${citation.pageNumber} 页`, `p.${citation.pageNumber}`)
                        : ''
                    } `}
                  </Text>
                  <Text color={theme.accent} bold>
                    {t(lang, '[o] 跳转原文', '[o] Open Source')}
                  </Text>
                </ClickableBox>
              ) : null}

              {/* FSRS-6 6-grade selector (0-5) */}
              {needsRating ? (
                <Box flexDirection="column" marginTop={1} width={innerW}>
                  <Box flexDirection="row" justifyContent="space-between" width={innerW} overflow="hidden">
                    <Text color={theme.muted} bold wrap="truncate">
                      {innerW < 64
                        ? t(lang, 'FSRS评分 [0-5]:', 'Rate [0-5]:')
                        : t(lang, 'FSRS-6 记忆评分（按数字键 0-5）:', 'FSRS-6 Rating (Press 0-5):')}
                    </Text>
                    {canRubricGrade && !activeRubric ? (
                      <ClickableBox clickActive={mainActive} onClick={() => void handleRubricGrade()}>
                        <Text color={theme.ai} bold>
                          {t(lang, '[G] AI 按标准评分', '[G] AI Rubric Grade')}
                        </Text>
                      </ClickableBox>
                    ) : null}
                  </Box>
                  <Box flexDirection="row" gap={1} marginTop={0} width={innerW} overflow="hidden">
                    {FSRS_GRADES.map((g) => {
                      const gap = innerW >= 96 && intervals ? formatGapDays(intervals[g.intervalIndex], lang) : '';
                      const textLabel = lang === 'en' ? g.labelEn : g.labelZh;
                      const label =
                        innerW < 82
                          ? `${g.key}${lang === 'en' ? `:${textLabel}` : textLabel}`
                          : `${g.key} ${textLabel}${gap ? `${asciiMode ? ' - ' : ' · '}${gap}` : ''}`;
                      return (
                        <ClickableBox key={g.key} clickActive={mainActive} onClick={() => handleFsrsGrade(g.grade)}>
                          <Badge label={label} tone={g.tone} variant="soft" />
                        </ClickableBox>
                      );
                    })}
                  </Box>
                </Box>
              ) : null}
            </Box>
          ) : null}

          {/* Bottom utility status strip */}
          <Box flexGrow={1} />
          <Box height={1} width={innerW} flexDirection="row" overflow="hidden">
            {(() => {
              const ell = asciiMode ? '...' : '…';
              const items: Array<{ id: string; text: string; onClick: () => void }> = [
                { id: 'h', text: t(lang, '[h]讲解', '[h]Help'), onClick: () => setAiDrawerOpen((v) => !v) },
                { id: 'L', text: t(lang, '[L]带学', '[L]Teach'), onClick: () => setTeachModalOpen(true) },
                { id: '*', text: t(lang, '[*]重点', '[*]Focus'), onClick: () => void handleToggleFocus() },
                { id: 'F', text: t(lang, '[F]复述', '[F]Retell'), onClick: () => setRetellModalOpen(true) },
                ...(canRubricGrade
                  ? [{ id: 'G', text: t(lang, '[G]评分', '[G]Grade'), onClick: () => void handleRubricGrade() }]
                  : []),
                { id: 'A', text: t(lang, '[A]答题卡', '[A]AnswerCard'), onClick: () => setAnswerCardModalOpen(true) },
                { id: 'T', text: t(lang, '[T]翻译', '[T]Trans'), onClick: () => void handleToggleTranslate() },
                { id: 'S', text: t(lang, '[S]同类', '[S]Sim'), onClick: () => setSimilarModalOpen(true) },
                { id: 'D', text: t(lang, '[D]工具', '[D]Tools'), onClick: () => setCardToolsModalOpen(true) },
                {
                  id: 'Q',
                  text: t(lang, '[Q]队列', '[Q]Queue'),
                  onClick: () => {
                    if (run.mode !== 'exam') setQueueModalOpen(true);
                    else notify(t(lang, '模拟考试队列已锁定，不能修改', 'Exam queue is locked'), 'info');
                  },
                },
                {
                  id: 'E',
                  text: t(lang, '[E]标记', '[E]Flag'),
                  onClick: () => {
                    setFlagReason('');
                    setFlagModalOpen(true);
                  },
                },
                {
                  id: 's',
                  text: t(lang, '[s]跳过', '[s]Skip'),
                  onClick: () => {
                    if (!feedback) handleSkip();
                  },
                },
                { id: 'u', text: t(lang, '[u]撤销', '[u]Undo'), onClick: () => handleUndo() },
                { id: 'nav', text: t(lang, '[,/.]换题', '[,/.]Nav'), onClick: () => handleMove(1) },
                ...(canAdjustGrade
                  ? [{ id: 'J', text: t(lang, '[J]改分', '[J]Adjust'), onClick: () => setGradeAdjustModalOpen(true) }]
                  : []),
                ...(canAckCorrection
                  ? [{ id: 'K', text: t(lang, '[K]确认订正', '[K]Ack'), onClick: () => void handleAckCorrection() }]
                  : []),
                ...(canCoachNudge
                  ? [{ id: 'N', text: t(lang, '[N]陪学点拨', '[N]Nudge'), onClick: () => setNudgeModalOpen(true) }]
                  : []),
              ];
              const fullW = items.reduce((n, it, i) => n + displayWidth(it.text) + (i > 0 ? 1 : 0), 0);
              let kept = items;
              let moreHint = '';
              if (fullW > innerW) {
                moreHint =
                  innerW >= 32
                    ? ` ${ell} ${t(lang, '按?看全部', 'Press ? for all')}`
                    : ` ${ell} [?]`;
                const budget = Math.max(0, innerW - displayWidth(moreHint));
                kept = [];
                let used = 0;
                for (const item of items) {
                  const w = displayWidth(item.text);
                  const sepW = kept.length > 0 ? 1 : 0;
                  if (used + sepW + w > budget) break;
                  kept.push(item);
                  used += sepW + w;
                }
              }
              return (
                <>
                  {kept.map((item, i) => (
                    <React.Fragment key={item.id}>
                      {i > 0 ? <Text color={theme.dim}> </Text> : null}
                      <ClickableBox clickActive={mainActive} onClick={item.onClick} flexShrink={0}>
                        <Text color={theme.dim}>{item.text}</Text>
                      </ClickableBox>
                    </React.Fragment>
                  ))}
                  {moreHint ? (
                    <ClickableBox
                      clickActive={mainActive}
                      onClick={() => useTuiStore.getState().setHelpOpen(true)}
                      flexShrink={0}
                    >
                      <Text color={theme.dim}>{truncateDisplay(moreHint, Math.max(1, innerW), ell)}</Text>
                    </ClickableBox>
                  ) : null}
                </>
              );
            })()}
          </Box>
        </Panel>
      ) : null}

      {sideBySideAi ? <Box width={1} /> : null}

      {/* Lazy-loaded Heavy Modals & AI Drawer (only parsed when opened) */}
      <Suspense fallback={null}>
        {/* AI Streaming Help Drawer */}
        {aiDrawerOpen && cardId ? (
          <AiHelpDrawer
            host={host}
            run={run}
            cardId={cardId}
            kind={kind}
            userAnswer={userAnswerText}
            width={aiPaneW}
            height={height}
            isActive={isActive && aiDrawerOpen && !flagModalOpen && !similarModalOpen && !cardToolsModalOpen && !queueModalOpen && !retellModalOpen && !teachModalOpen && !answerCardModalOpen && !gradeAdjustModalOpen && !nudgeModalOpen}
            mathUnicode={mathUnicode}
            history={aiHistoryByCard[cardId]}
            onHistoryChange={handleAiHistoryChange}
            extraSavedFollowups={savedFollowupsByCard[cardId]}
            onSavedFollowup={handleSavedFollowup}
            onClose={() => setAiDrawerOpen(false)}
          />
        ) : null}

        {/* Socratic Teach Mode Modal */}
        {teachModalOpen && cardId ? (
          <TeachModal
            host={host}
            run={run}
            cardId={cardId}
            kind={kind}
            width={width}
            height={height}
            isActive={isActive && teachModalOpen && !flagModalOpen}
            mathUnicode={mathUnicode}
            onClose={() => setTeachModalOpen(false)}
          />
        ) : null}

        {/* Feynman Retell Modal */}
        {retellModalOpen && cardId ? (
          <RetellModal
            host={host}
            run={run}
            cardId={cardId}
            kind={kind}
            width={width}
            height={height}
            isActive={isActive && retellModalOpen && !flagModalOpen && !teachModalOpen}
            mathUnicode={mathUnicode}
            onClose={() => setRetellModalOpen(false)}
            onNavigateToSource={(loc) => {
              navigate('sources', { sourceId: loc.sourceId, pageNumber: loc.pageNumber });
            }}
          />
        ) : null}

        {/* Similar / Confusable Cards Modal */}
        {similarModalOpen && cardId ? (
          <SimilarCardsModal
            host={host}
            run={run}
            cardId={cardId}
            kind={kind}
            width={width}
            height={height}
            isActive={isActive && similarModalOpen && !flagModalOpen && !cardToolsModalOpen && !retellModalOpen && !teachModalOpen}
            mathUnicode={mathUnicode}
            onClose={() => setSimilarModalOpen(false)}
            onStartRun={(nextRun) => applyRun(nextRun, true)}
          />
        ) : null}

        {/* Power-User Card Tools Drawer/Modal */}
        {cardToolsModalOpen && cardId ? (
          <CardToolsModal
            host={host}
            run={run}
            cardId={cardId}
            kind={kind}
            width={width}
            height={height}
            isActive={isActive && cardToolsModalOpen && !flagModalOpen && !retellModalOpen && !teachModalOpen}
            onClose={() => setCardToolsModalOpen(false)}
            onRunUpdated={(nextRun) => applyRun(nextRun, true)}
            onCardEdited={(editedId) => {
              translationCacheRef.current.delete(editedId);
              setShowTranslation(false);
            }}
            onFocusChanged={(cid, focused) => {
              setFocusOverrideByCard((prev) => ({ ...prev, [cid]: focused }));
            }}
            onRefreshSnapshot={() => void refresh()}
          />
        ) : null}

        {/* Live Review Queue Inspector & Editor */}
        {queueModalOpen && run.mode !== 'exam' ? (
          <QueueModal
            host={host}
            run={run}
            width={width}
            height={height}
            isActive={
              isActive &&
              queueModalOpen &&
              !flagModalOpen &&
              !teachModalOpen &&
              !retellModalOpen &&
              !similarModalOpen &&
              !cardToolsModalOpen &&
              !answerCardModalOpen
            }
            onClose={() => setQueueModalOpen(false)}
            onRunUpdated={(nextRun) => applyRun(nextRun, true)}
          />
        ) : null}

        {/* Case Answer Card Modal */}
        {answerCardModalOpen && cardId ? (
          <AnswerCardModal
            host={host}
            run={run}
            cardId={cardId}
            kind={kind}
            width={width}
            height={height}
            isActive={
              isActive &&
              answerCardModalOpen &&
              !flagModalOpen &&
              !teachModalOpen &&
              !retellModalOpen &&
              !similarModalOpen &&
              !cardToolsModalOpen
            }
            mathUnicode={mathUnicode}
            onClose={() => setAnswerCardModalOpen(false)}
            onRunUpdated={(nextRun) => applyRun(nextRun, true)}
            onRefreshSnapshot={() => void refresh()}
          />
        ) : null}

        {/* Coach Nudge Modal */}
        {nudgeModalOpen && cardId && canCoachNudge ? (
          <CoachNudgeModal
            host={host}
            run={run}
            cardId={cardId}
            width={width}
            height={height}
            isActive={
              isActive &&
              nudgeModalOpen &&
              !flagModalOpen &&
              !teachModalOpen &&
              !retellModalOpen &&
              !similarModalOpen &&
              !cardToolsModalOpen &&
              !answerCardModalOpen &&
              !queueModalOpen &&
              !gradeAdjustModalOpen &&
              !confirmEndOpen
            }
            initialNote={nudgeCacheRef.current.get(nudgeCacheKey) ?? null}
            onNoteUpdate={(note) => {
              nudgeCacheRef.current.set(nudgeCacheKey, note);
            }}
            onClose={() => setNudgeModalOpen(false)}
          />
        ) : null}
      </Suspense>

      {/* Quick Flag Modal */}
      {flagModalOpen ? (
        <Modal
          title={t(lang, '标记当前题目', 'Flag Current Card')}
          icon={asciiMode ? '!' : '⚑'}
          tone="warning"
          isActive={isActive && flagModalOpen}
          onClose={() => setFlagModalOpen(false)}
          hints={[
            { key: 'Enter', label: t(lang, '提交标记', 'Submit') },
            { key: 'Esc', label: t(lang, '取消', 'Cancel') },
          ]}
        >
          <Text color={theme.muted}>
            {t(lang, '输入问题标记说明（如：答案有误、解析不清、需重点复习）：', 'Enter a reason (e.g. unclear stem, wrong key, review later):')}
          </Text>
          <Box borderStyle={asciiMode ? 'classic' : 'single'} borderColor={theme.primary} paddingX={1} marginTop={1}>
            <TextInput
              value={flagReason}
              onChange={setFlagReason}
              isActive={isActive && flagModalOpen}
              width={54}
              placeholder={asciiMode ? t(lang, '输入标记原因...', 'Reason...') : t(lang, '输入标记原因…', 'Reason…')}
              onSubmit={() => void handleSubmitFlag()}
              onCancel={() => setFlagModalOpen(false)}
            />
          </Box>
        </Modal>
      ) : null}

      {/* Manual AI Grade Adjust Modal */}
      {gradeAdjustModalOpen && canAdjustGrade ? (
        <GradeAdjustModal
          lang={lang}
          asciiMode={asciiMode}
          width={width}
          currentGrade={typeof feedback?.grade === 'number' ? feedback.grade : undefined}
          originalGrade={typeof feedback?.gradeOriginal === 'number' ? feedback.gradeOriginal : undefined}
          busy={busy}
          isActive={isActive && gradeAdjustModalOpen}
          onSelect={(grade) => void handleAdjustGrade(grade)}
          onClose={() => {
            if (!busyRef.current) setGradeAdjustModalOpen(false);
          }}
        />
      ) : null}

      {/* End Round Confirmation Dialog */}
      {confirmEndOpen ? (
        <ConfirmDialog
          title={t(lang, '结束本轮练习', 'End This Round')}
          message={t(
            lang,
            `当前已作答 ${answeredCount}/${totalCount} 题。结束后本轮不可恢复，将直接进入本轮总结；如需暂离请按 [1] 返回学习库（保留进度）。`,
            `Answered ${answeredCount}/${totalCount}. Ending closes this round permanently; press [1] to return to Library and keep progress.`,
          )}
          confirmLabel={t(lang, '结束本轮', 'End Round')}
          cancelLabel={t(lang, '继续练习', 'Keep Going')}
          danger
          isActive={isActive}
          onConfirm={() => {
            setConfirmEndOpen(false);
            handleEndRound();
          }}
          onCancel={() => setConfirmEndOpen(false)}
        />
      ) : null}
    </Box>
  );
};
