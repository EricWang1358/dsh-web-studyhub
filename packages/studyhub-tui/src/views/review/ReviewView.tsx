import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { KeyHint, ViewProps } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { currentCourse, useShellActions } from '../../shell/index.js';
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
} from '../../host/index.js';
import {
  Badge,
  Divider,
  EmptyState,
  MarkdownView,
  Modal,
  Panel,
  ProgressBar,
  Spinner,
  TextInput,
  useClaimKeys,
  useFooterHints,
  useTheme,
} from '../../components/index.js';
import { truncateDisplay } from '../../render/index.js';
import {
  FSRS_GRADES,
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
  type CardFeedbackShape,
  type CardOptionItem,
} from './review-helpers.js';
import { AiHelpDrawer } from './AiHelpDrawer.js';
import { RoundSummary } from './RoundSummary.js';

const CARD_UTIL_KEYS: readonly string[] = Object.freeze(['q', 's', 'm', ',', '.', 't', 'a', 'f', 'n']);
const RATING_DIGIT_KEYS: readonly string[] = Object.freeze(['1', '2', '3', '4']);
const CHOICE_DIGIT_KEYS: readonly string[] = Object.freeze(['1', '2', '3', '4', '5', '6']);
const TF_DIGIT_KEYS: readonly string[] = Object.freeze(['1', '2']);
const EMPTY_CLAIMED_KEYS: readonly string[] = Object.freeze(['r']);

export const ReviewView: React.FC<ViewProps> = ({ host, width, height, isActive }) => {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const mathUnicode = useTuiStore((s) => s.preferences.mathUnicode);
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

  // Overlays
  const [aiDrawerOpen, setAiDrawerOpen] = useState(false);
  const [flagModalOpen, setFlagModalOpen] = useState(false);
  const [flagReason, setFlagReason] = useState('');

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const cardId = currentCardId(run);
  const cardKey = `${run?.id ?? ''}:${run?.index ?? -1}:${cardId ?? ''}`;

  // Reset per-card input state when moving to another question
  useEffect(() => {
    setCursorOpt(0);
    setSelectedIds([]);
    setClozeInputs({});
    setActiveBlankIdx(0);
    setClozeEditing(false);
    setOpenDraft('');
    setOpenEditing(false);
  }, [cardKey]);

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
    [host, navContext.runId, navContext.deckId, navContext.course, navContext.mode, activeRunId, snapshot, applyRun, lang],
  );

  useEffect(() => {
    void loadInitialRun(false);
    // Re-run only when navigation context explicitly targets a new run/deck/course.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navContext.runId, navContext.deckId, navContext.course, navContext.mode]);

  const kind = normalizeCardKind(run);
  const feedback: CardFeedbackShape | null = extractFeedback(run);
  const solution = extractSolution(run);
  const isFinished = Boolean(run && (run.complete || run.closed));
  const revealed = Boolean(run?.revealed || feedback);
  const isSelfGraded = kind === 'flashcard' || kind === 'short_answer';
  const needsRating = Boolean(run && !isFinished && revealed && !feedback && isSelfGraded);
  const options: CardOptionItem[] = useMemo(
    () => resolveOptions(run?.card as Record<string, unknown> | undefined, kind, lang),
    [run?.card, kind, lang],
  );
  const clozeData = useMemo(
    () => (kind === 'fill_blank' ? resolveClozeBlanks(run?.card as Record<string, unknown> | undefined) : null),
    [kind, run?.card],
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
    void runAction(() =>
      revealReview(host, {
        runId: run.id,
        cardId,
        queueVersion: run.queueVersion ?? 0,
      }),
    );
  }, [run, cardId, busy, revealed, runAction, host]);

  const handleSubmitChoice = useCallback(
    (ids: string[]) => {
      if (!run?.id || !cardId || busy || feedback || ids.length === 0) return;
      void runAction(() =>
        answerReview(host, {
          runId: run.id,
          cardId,
          selected: ids,
          queueVersion: run.queueVersion ?? 0,
        }),
      );
    },
    [run, cardId, busy, feedback, runAction, host],
  );

  const handleSubmitCloze = useCallback(
    (vals: Record<string, string>) => {
      if (!run?.id || !cardId || busy || feedback) return;
      const anyFilled = Object.values(vals).some((v) => String(v || '').trim().length > 0);
      if (!anyFilled) {
        notify(t(lang, '请先填写至少一个空格', 'Fill in at least one blank first'), 'warning');
        return;
      }
      void runAction(() =>
        answerReview(host, {
          runId: run.id,
          cardId,
          answers: vals,
          queueVersion: run.queueVersion ?? 0,
        }),
      );
    },
    [run, cardId, busy, feedback, runAction, host, notify, lang],
  );

  const handleFsrsGrade = useCallback(
    (grade: number) => {
      if (!run?.id || !cardId || busy || feedback || !revealed) return;
      void runAction(() =>
        answerReview(host, {
          runId: run.id,
          cardId,
          grade,
          advanceOnSelfGrade: grade >= 4,
          queueVersion: run.queueVersion ?? 0,
        }),
      );
    },
    [run, cardId, busy, feedback, revealed, runAction, host],
  );

  const handleMove = useCallback(
    (direction: -1 | 1) => {
      if (!run?.id || busy) return;
      if (direction === 1 && !feedback && !revealed) {
        notify(t(lang, '请先作答，或按 [s] 跳过本题', 'Answer first or press [s] to skip'), 'info');
        return;
      }
      if (direction === 1 && revealed && !feedback && isSelfGraded) {
        notify(t(lang, '请先用 [1-4] 评分', 'Rate with [1-4] first'), 'info');
        return;
      }
      void runAction(() => moveReview(host, run.id, { direction }));
    },
    [run, busy, feedback, revealed, isSelfGraded, runAction, host, notify, lang],
  );

  const handleSkip = useCallback(() => {
    if (!run?.id || !cardId || busy || feedback) return;
    if (run.card?.publicationUngrable) {
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
    void runAction(() => moveReview(host, run.id, { index: target }));
  }, [run, cardId, busy, feedback, runAction, host, notify, lang]);

  const handleUndo = useCallback(() => {
    if (!run?.id || busy) return;
    const undoable = (run as { undoable?: { attemptId?: string } }).undoable;
    if (!undoable) {
      notify(t(lang, '当前没有可撤销的评分', 'Nothing to undo in this round'), 'info');
      return;
    }
    void runAction(async () => {
      const res = await tryAction<ReviewRun>(host, 'review.undo', {
        runId: run.id,
        attemptId: undoable.attemptId,
      });
      if (!res.ok || !res.value) throw new Error(res.error?.message || 'Undo failed');
      notify(t(lang, '已撤销上一题评分', 'Undid last rating'), 'success');
      return res.value;
    }, true);
  }, [run, busy, runAction, host, notify, lang]);

  const handleEndRound = useCallback(() => {
    if (!run?.id || busy) return;
    void runAction(() => endReview(host, run.id), true);
  }, [run, busy, runAction, host]);

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
    void runAction(async () => {
      const res = await tryAction<ReviewRun>(host, 'review.weak.start', { runId: run.id });
      if (!res.ok || !res.value) throw new Error(res.error?.message || t(lang, '本轮暂无薄弱题', 'No weak cards to retry'));
      return res.value;
    });
  }, [run, busy, runAction, host, lang]);

  // Phase-aware key claiming: only claim digits when rating (1-4) or picking choices (1-6 / 1-2)
  const mainActive = isActive && !aiDrawerOpen && !flagModalOpen && !clozeEditing && !openEditing && !isFinished;
  const claimedKeys = useMemo<readonly string[]>(() => {
    if (!isActive || loading) return [];
    if (!run) return EMPTY_CLAIMED_KEYS;
    if (isFinished) return [];
    if (needsRating) return [...CARD_UTIL_KEYS, ...RATING_DIGIT_KEYS];
    if (!revealed && !feedback) {
      if (kind === 'true_false') return [...CARD_UTIL_KEYS, ...TF_DIGIT_KEYS];
      if (kind === 'single' || kind === 'multiple') return [...CARD_UTIL_KEYS, ...CHOICE_DIGIT_KEYS];
    }
    return CARD_UTIL_KEYS;
  }, [isActive, loading, run, isFinished, needsRating, revealed, feedback, kind]);
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
        base.push({ key: '1/t · 2/f', label: t(lang, '判断', 'Judge') });
      } else if (kind === 'fill_blank') {
        base.push({ key: 'i/Enter', label: t(lang, '填空', 'Type') });
      } else if (kind === 'short_answer') {
        base.push({ key: 'i', label: t(lang, '作答', 'Type') });
        base.push({ key: 'Space', label: t(lang, '翻看答案', 'Reveal') });
      } else {
        base.push({ key: 'Space/Enter', label: t(lang, '翻卡', 'Flip') });
      }
    } else if (needsRating) {
      base.push({ key: '1-4', label: t(lang, 'FSRS评分', 'Rate 1-4') });
    } else {
      base.push({ key: 'Enter / .', label: t(lang, '下一题', 'Next') });
    }
    base.push({ key: 'h', label: t(lang, 'AI讲解', 'AI Help') });
    base.push({ key: 'm', label: mathUnicode ? 'Unicode' : 'LaTeX' });
    if (citation) base.push({ key: 'o', label: t(lang, '原文', 'Source') });
    base.push({ key: 'q', label: t(lang, '结束', 'End') });
    return base;
  }, [loading, run, isFinished, revealed, feedback, kind, needsRating, mathUnicode, citation, lang]);
  useFooterHints(hints, isActive && !aiDrawerOpen && !flagModalOpen && !isFinished);

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
      if (input === 'u') {
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
      if (input === 'q') {
        handleEndRound();
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

      if (kind === 'short_answer') {
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
      else if (input === 'r') void loadInitialRun(true);
    },
    { isActive: isActive && !loading && !run },
  );

  // Hooks above, early returns below.
  const userAnswerText = useMemo(
    () => extractUserAnswerText(run, kind, selectedIds, clozeInputs, openDraft, lang),
    [run, kind, selectedIds, clozeInputs, openDraft, lang],
  );

  const stemMarkdown = useMemo(() => {
    if (!run) return '';
    if (kind === 'fill_blank' && clozeData) {
      return formatClozeDisplay(clozeData.text, clozeData.blanks, clozeInputs, revealed, solution);
    }
    return String(run.card?.prompt ?? '');
  }, [run, kind, clozeData, clozeInputs, revealed, solution]);

  const referenceAnswer = useMemo(
    () => (run && revealed ? extractReferenceAnswer(run, kind, lang) : ''),
    [revealed, run, kind, lang],
  );

  if (loading) {
    return (
      <Box width={width} height={height} alignItems="center" justifyContent="center">
        <Spinner label={t(lang, '正在准备复习队列…', 'Preparing review queue…')} active={isActive} />
      </Box>
    );
  }

  if (!run) {
    return (
      <Panel title={t(lang, '刷题复习', 'Review')} icon="▶" width={width} height={height}>
        <EmptyState
          icon="✦"
          title={t(lang, '当前没有待复习题目', 'No questions due for review')}
          hint={loadError || t(lang, '可以先去学习库挑选一个题组，或导入新资料生成题目。', 'Pick a deck in Library or generate cards from Sources.')}
          actions={[
            { key: 'L', label: t(lang, '返回学习库', 'Go to Library') },
            { key: 'r', label: t(lang, '重新加载', 'Reload') },
          ]}
          width={Math.max(20, width - 4)}
          height={Math.max(6, height - 4)}
        />
      </Panel>
    );
  }

  if (isFinished) {
    return (
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

  const innerW = Math.max(20, cardPaneW - 4);
  const progressRatio = totalCount > 0 ? Math.min(1, answeredCount / totalCount) : 0;

  return (
    <Box flexDirection="row" width={width} height={height}>
      {/* Main Question Workspace (hidden on narrow terminals while AI Drawer is open) */}
      {!(aiDrawerOpen && !sideBySideAi) ? (
        <Panel
          title={String(run.title || t(lang, 'FSRS-6 间隔复习', 'FSRS-6 Review'))}
          icon="▶"
          badge={`${atNum}/${totalCount}`}
          badgeTone="primary"
          subtitle={`${kindLabel(kind, lang)}${topicName ? ` · ${topicName}` : ''}`}
          focused={mainActive}
          width={cardPaneW}
          height={height}
          paddingX={1}
        >
          {/* Top progress & status bar */}
          <Box flexDirection="row" alignItems="center" justifyContent="space-between" width={innerW} marginBottom={0}>
            <Box flexDirection="row" alignItems="center" gap={1}>
              <ProgressBar
                ratio={progressRatio}
                width={Math.min(20, Math.max(8, Math.floor(innerW * 0.25)))}
                showPercent={false}
              />
              <Text color={theme.muted}>{`${answeredCount}/${totalCount}`}</Text>
              {run.retry ? <Badge label={t(lang, '再练', 'Retry')} tone="warning" variant="soft" /> : null}
              {run.card?.focus ? <Badge label={t(lang, '重点', 'Focus')} tone="accent" variant="soft" /> : null}
            </Box>
            <Box flexDirection="row" alignItems="center" gap={1}>
              {busy ? <Spinner tone="primary" active={isActive} /> : null}
              <Badge label={mathUnicode ? '∑ Unicode' : 'TeX Raw'} tone="neutral" variant="outline" />
            </Box>
          </Box>

          <Divider width={innerW} />

          {/* Question Stem */}
          <Box flexDirection="column" width={innerW} marginY={0}>
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

                let mark = kind === 'multiple' ? (isSelected ? '[✓]' : '[ ]') : isSelected ? '(●)' : '( )';
                let lineColor = isCursor ? theme.primary : isSelected ? theme.accent : theme.text;
                if (feedback) {
                  if (isCorrectOpt) {
                    mark = '✓';
                    lineColor = theme.success;
                  } else if (isSelected && !isCorrectOpt) {
                    mark = '✕';
                    lineColor = theme.error;
                  } else {
                    mark = '·';
                    lineColor = theme.muted;
                  }
                }
                const keyTag = kind === 'true_false'
                  ? (idx === 0 ? '[1/t]' : '[2/f]')
                  : `[${idx + 1}/${String.fromCharCode(97 + idx)}]`;
                return (
                  <Box key={opt.id} flexDirection="row" width={innerW}>
                    <Text color={isCursor ? theme.primary : theme.dim} bold={isCursor}>
                      {isCursor ? '▸ ' : '  '}
                    </Text>
                    <Text color={theme.muted}>{`${keyTag} `}</Text>
                    <Text color={lineColor} bold={isSelected || isCorrectOpt || isCursor}>
                      {`${mark} ${opt.text}`}
                    </Text>
                  </Box>
                );
              })}
              {kind === 'multiple' && !feedback ? (
                <Text color={theme.dim}>
                  {t(lang, '  提示: 1-6/Space 勾选多选，Enter 提交答案', '  Hint: 1-6/Space to toggle, Enter to submit')}
                </Text>
              ) : null}
            </Box>
          ) : null}

          {/* Cloze blanks editor */}
          {kind === 'fill_blank' && clozeData && !feedback ? (
            <Box flexDirection="column" marginTop={1} width={innerW}>
              {clozeData.blanks.map((blank, idx) => {
                const isThisActive = clozeEditing && idx === activeBlankIdx;
                return (
                  <Box
                    key={blank.id}
                    flexDirection="row"
                    borderStyle="single"
                    borderColor={isThisActive ? theme.primary : theme.border}
                    paddingX={1}
                    width={Math.min(innerW, 64)}
                  >
                    <Text color={theme.muted}>{`#${idx + 1} `}</Text>
                    <TextInput
                      value={clozeInputs[blank.id] ?? ''}
                      onChange={(val) => setClozeInputs((prev) => ({ ...prev, [blank.id]: val }))}
                      isActive={isActive && !aiDrawerOpen && !flagModalOpen && isThisActive}
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

          {/* Short answer draft input */}
          {kind === 'short_answer' && !revealed ? (
            <Box
              flexDirection="column"
              marginTop={1}
              borderStyle="single"
              borderColor={openEditing ? theme.primary : theme.border}
              paddingX={1}
              width={innerW}
            >
              <Text color={theme.muted}>
                {t(lang, '你的作答（按 [i] 输入，Enter 翻看答案自评；或按 [Space] 直接翻看）:', 'Your answer ([i] to type, Enter to reveal; or [Space] to reveal):')}
              </Text>
              <TextInput
                value={openDraft}
                onChange={setOpenDraft}
                isActive={isActive && !aiDrawerOpen && !flagModalOpen && openEditing}
                width={Math.max(16, innerW - 6)}
                placeholder={t(lang, '输入你的思路或简答…', 'Type your answer or key points…')}
                onSubmit={() => {
                  setOpenEditing(false);
                  handleReveal();
                }}
                onCancel={() => setOpenEditing(false)}
              />
            </Box>
          ) : null}

          {/* Flashcard front prompt */}
          {kind === 'flashcard' && !revealed ? (
            <Box marginTop={1}>
              <Badge label={t(lang, '按 [Space] 或 [Enter] 翻开答案', 'Press [Space] or [Enter] to flip card')} tone="primary" variant="soft" />
            </Box>
          ) : null}

          {/* Post-Reveal / Post-Answer Feedback & Explanation */}
          {revealed ? (
            <Box flexDirection="column" marginTop={1} width={innerW} flexGrow={1} overflow="hidden">
              <Divider width={innerW} label={t(lang, '答案与解析', 'Answer & Explanation')} />

              {feedback ? (
                <Box flexDirection="row" alignItems="center" gap={1} marginBottom={0}>
                  <Badge
                    label={
                      feedback.correct
                        ? t(lang, '✓ 回答正确', '✓ Correct')
                        : feedback.selfReported
                          ? t(lang, '○ 已自报', '○ Self-reported')
                          : t(lang, '✕ 回答有误', '✕ Incorrect')
                    }
                    tone={feedback.correct ? 'success' : feedback.selfReported ? 'neutral' : 'error'}
                  />
                  {feedback.level ? <Badge label={String(feedback.level)} tone="accent" variant="soft" /> : null}
                  {userAnswerText ? (
                    <Text color={theme.muted}>
                      {truncateDisplay(`${t(lang, '你的作答', 'Yours')}: ${userAnswerText}`, Math.max(10, innerW - 28))}
                    </Text>
                  ) : null}
                </Box>
              ) : userAnswerText ? (
                <Text color={theme.muted}>{`${t(lang, '你的作答', 'Yours')}: ${userAnswerText}`}</Text>
              ) : null}

              <Text color={theme.success} bold>
                {`${t(lang, '参考答案', 'Reference')}: ${referenceAnswer}`}
              </Text>

              {solution?.explanation || solution?.misconception ? (
                <Box marginTop={0} flexGrow={1} overflow="hidden">
                  <MarkdownView
                    markdown={[
                      solution.explanation || '',
                      solution.misconception
                        ? `> **${t(lang, '常见误区', 'Misconception')}**: ${solution.misconception}`
                        : '',
                    ]
                      .filter(Boolean)
                      .join('\n\n')}
                    width={innerW}
                    height={Math.max(3, height - 18)}
                    mathUnicode={mathUnicode}
                  />
                </Box>
              ) : null}

              {/* Source Citation Bar */}
              {citation ? (
                <Box marginTop={0}>
                  <Text color={theme.info}>
                    {`▤ ${citation.title ? `${citation.title} ` : ''}${
                      citation.pageNumber != null
                        ? t(lang, `第 ${citation.pageNumber} 页`, `p.${citation.pageNumber}`)
                        : ''
                    } `}
                  </Text>
                  <Text color={theme.accent} bold>
                    {t(lang, '[o] 跳转原文', '[o] Open Source')}
                  </Text>
                </Box>
              ) : null}

              {/* FSRS-6 4-grade selector */}
              {needsRating ? (
                <Box flexDirection="column" marginTop={1}>
                  <Text color={theme.muted} bold>
                    {t(lang, 'FSRS-6 记忆评分（按数字键 1-4）:', 'FSRS-6 Rating (Press 1-4):')}
                  </Text>
                  <Box flexDirection="row" gap={1} marginTop={0} flexWrap="wrap">
                    {FSRS_GRADES.map((g) => {
                      const gap = intervals ? formatGapDays(intervals[g.intervalIndex], lang) : '';
                      const label = `${g.key} ${lang === 'en' ? g.labelEn : g.labelZh}${gap ? ` · ${gap}` : ''}`;
                      return <Badge key={g.key} label={label} tone={g.tone} variant="soft" />;
                    })}
                  </Box>
                </Box>
              ) : null}
            </Box>
          ) : null}

          {/* Bottom utility status strip */}
          <Box flexGrow={1} />
          <Box flexDirection="row" justifyContent="space-between" width={innerW}>
            <Text color={theme.dim}>
              {t(lang, '[h] AI讲解 · [E] 标记 · [s] 跳过 · [u] 撤销 · [,/.] 上/下题', '[h] AI Help · [E] Flag · [s] Skip · [u] Undo · [,/.] Prev/Next')}
            </Text>
          </Box>
        </Panel>
      ) : null}

      {sideBySideAi ? <Box width={1} /> : null}

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
          isActive={isActive && aiDrawerOpen && !flagModalOpen}
          mathUnicode={mathUnicode}
          onClose={() => setAiDrawerOpen(false)}
        />
      ) : null}

      {/* Quick Flag Modal */}
      {flagModalOpen ? (
        <Modal
          title={t(lang, '标记当前题目', 'Flag Current Card')}
          icon="⚑"
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
          <Box borderStyle="single" borderColor={theme.primary} paddingX={1} marginTop={1}>
            <TextInput
              value={flagReason}
              onChange={setFlagReason}
              isActive={isActive && flagModalOpen}
              width={54}
              placeholder={t(lang, '输入标记原因…', 'Reason…')}
              onSubmit={() => void handleSubmitFlag()}
              onCancel={() => setFlagModalOpen(false)}
            />
          </Box>
        </Modal>
      ) : null}
    </Box>
  );
};
