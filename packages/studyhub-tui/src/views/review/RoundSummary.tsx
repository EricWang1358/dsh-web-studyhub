import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, KeyHint, UiLanguage } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { tryAction, type ReviewRun } from '../../host/sample-actions.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, EmptyState, ProgressBar, Spinner } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { MarkdownView } from '../../components/MarkdownView.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { Panel } from '../../components/Panel.js';
import { ScrollView } from '../../components/ScrollView.js';
import { SplitPane } from '../../components/SplitPane.js';
import { VirtualList } from '../../components/VirtualList.js';
import { useClaimKeys } from '../../components/focus.js';
import { useFooterHints } from '../../components/hooks.js';
import { displayWidth, truncateDisplay } from '../../render/cjk.js';
import { buildRoundNextStepSuggestion } from './round-next-step.js';
import { dueToday } from '../../shell/data.js';

interface LookBackOption {
  id?: string;
  text?: string;
  correct?: boolean;
  explanation?: string;
}

interface LookBackSolution {
  answer?: string;
  explanation?: string;
  misconception?: string;
  rubric?: string;
  options?: LookBackOption[];
  cloze?: { text?: string; answers?: Array<{ id?: string; value: string }> };
  followups?: Array<{ id?: string; question?: string; answer?: string }>;
  [k: string]: unknown;
}

interface LookBackFeedback {
  correct?: boolean;
  grade?: number;
  selected?: string[];
  answers?: Record<string, string>;
  answer?: string;
  note?: string;
  selfReported?: boolean;
  assessment?: string;
  rubric?: { total?: number; max?: number; band?: string; summary?: string };
  [k: string]: unknown;
}

interface LookBackRow {
  number?: number;
  entryIndex?: number;
  deckId?: string;
  cardId?: string;
  kind?: string;
  status: 'right' | 'wrong' | 'self' | 'grading' | 'unanswered';
  errorReason?: string;
  thinkingNote?: string;
  correctionPending?: boolean;
  hinted?: boolean;
  leech?: boolean;
  hesitant?: boolean;
  prompt?: string;
  card?: {
    id?: string;
    kind?: string;
    prompt?: string;
    topic?: string;
    answer?: string;
    explanation?: string;
    options?: LookBackOption[];
    [k: string]: unknown;
  };
  feedback?: LookBackFeedback;
  solution?: LookBackSolution;
  sourceTitle?: string;
  page?: number;
  unit?: string;
}

interface DailyStatusGroup {
  courseId?: string;
  course?: string;
  day?: string;
  timeZone?: string;
  eligible?: boolean;
  answeredCount?: number;
  hasContent?: boolean;
  noteId?: string | null;
  generation?: { status?: string; message?: string };
}

type DebriefInsightItem = string | { code?: string; title?: string; text?: string; detail?: string };

interface DebriefResult {
  version?: number;
  answered?: number;
  metrics?: Record<string, unknown>;
  insights?: DebriefInsightItem[];
  headline?: string;
  why?: string;
  next?: string;
  preparing?: boolean;
  at?: string;
  status?: unknown;
}

export interface RoundSummaryProps {
  host: HostClient;
  run: ReviewRun;
  width: number;
  height: number;
  isActive: boolean;
  mathUnicode: boolean;
  onPracticeWeak?: () => void;
  onNewRound?: () => void;
  onGoLibrary?: () => void;
  /** Backwards-compatible aliases if a caller passes retry/continue/back handlers. */
  onRetryWeak?: () => void;
  onContinue?: () => void;
  onBack?: () => void;
}

const CLAIMED_SUMMARY_KEYS: readonly string[] = Object.freeze(['w', 'R', 'g', 'b', 'v', '1', 'j', 'k', 'd']);
const SPLIT_BREAKPOINT = 84;

function formatDebriefNextLabel(nextCode: string, lang: UiLanguage): string {
  switch (nextCode) {
    case 'practice_prepared':
      return t(lang, '练习定制题', 'Practice Prepared');
    case 'review_weak':
      return t(lang, '重练薄弱题', 'Review Weak');
    case 'rest':
      return t(lang, '休息巩固', 'Take a Break');
    case 'continue_path':
      return t(lang, '继续学习路径', 'Continue Path');
    default:
      return nextCode;
  }
}

function formatDebriefInsight(item: DebriefInsightItem): string {
  if (typeof item === 'string') return item.trim();
  if (!item || typeof item !== 'object') return '';
  const title = typeof item.title === 'string' ? item.title.trim() : '';
  const text = typeof item.text === 'string' ? item.text.trim() : '';
  const detail = typeof item.detail === 'string' ? item.detail.trim() : '';
  if (title && text) return `${title}: ${text}`;
  if (title && detail) return `${title}: ${detail}`;
  return text || detail || title;
}

const DebriefModal = memo(function DebriefModal({
  debrief,
  width,
  height,
  isActive,
  onClose,
}: {
  debrief: DebriefResult;
  width: number;
  height: number;
  isActive: boolean;
  onClose: () => void;
}) {
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const shellOverlay = useTuiStore((s) => s.commandPaletteOpen || s.helpOpen || s.coursePickerOpen || s.inboxOpen);
  const effectiveActive = isActive && !shellOverlay;

  useInput(
    (input, key) => {
      if (!key.ctrl && !key.meta && input === 'd') {
        onClose();
      }
    },
    { isActive: effectiveActive },
  );

  const modalW = Math.min(72, Math.max(40, width - 4));
  const modalH = Math.min(20, Math.max(12, height - 4));
  const innerW = modalContentWidth(modalW);
  const scrollH = Math.max(4, modalH - 6);

  const debriefContent = useMemo(() => {
    const sections: string[] = [];
    if (debrief.headline) sections.push(String(debrief.headline).trim());
    if (debrief.why) {
      sections.push(`${t(lang, '原因分析', 'Why')}: ${String(debrief.why).trim()}`);
    }
    const insights = (Array.isArray(debrief.insights) ? debrief.insights : [])
      .map(formatDebriefInsight)
      .filter(Boolean);
    if (insights.length > 0) {
      sections.push([`${t(lang, '本轮洞察', 'Insights')}:`, ...insights.map((line) => `- ${line}`)].join('\n'));
    }
    if (debrief.preparing) {
      sections.push(
        t(lang, '[后台] AI 教练正在为你准备针对性变式题。', '[Background] AI Coach is preparing tailored practice variants.'),
      );
    }
    return sections.join('\n\n') || t(lang, '暂无本轮复盘详情。', 'No debrief details available.');
  }, [debrief, lang]);

  return (
    <Modal
      title={t(lang, 'AI 教练本轮复盘', 'AI Coach Debrief')}
      icon={asciiMode ? '*' : '✦'}
      tone="ai"
      width={modalW}
      height={modalH}
      onClose={onClose}
      isActive={effectiveActive}
      hints={[
        { key: 'j/k', label: t(lang, '滚动', 'Scroll') },
        { key: 'd/Esc', label: t(lang, '关闭', 'Close') },
      ]}
    >
      <Box flexDirection="row" gap={1} height={1} overflow="hidden">
        {debrief.next ? (
          <Badge
            label={`${t(lang, '建议下一步', 'Next')}: ${formatDebriefNextLabel(String(debrief.next), lang)}`}
            tone="primary"
            variant="soft"
          />
        ) : null}
        {typeof debrief.answered === 'number' ? (
          <Badge label={t(lang, `已答 ${debrief.answered} 题`, `${debrief.answered} answered`)} tone="neutral" variant="outline" />
        ) : null}
        {debrief.preparing ? (
          <Badge label={t(lang, '后台准备变式题', 'Preparing variants')} tone="warning" variant="outline" />
        ) : null}
      </Box>
      <Box height={scrollH} width={innerW} overflow="hidden">
        <ScrollView content={debriefContent} width={innerW} height={scrollH} isActive={effectiveActive} ascii={asciiMode} />
      </Box>
    </Modal>
  );
});

function cleanPromptSnippet(text: string, ascii: boolean): string {
  return String(text || '')
    .replace(/\{\{[^{}]+\}\}/g, ascii ? '___' : '＿＿')
    .replace(/[#*_`>$\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function statusFromEntry(entry: Record<string, unknown>): LookBackRow['status'] {
  const fb = entry.feedback as LookBackFeedback | null | undefined;
  if (!fb || typeof fb !== 'object') {
    return entry.grading ? 'grading' : 'unanswered';
  }
  if (fb.selfReported || fb.assessment === 'self-report') return 'self';
  if (fb.correct === true) return 'right';
  if (typeof fb.grade === 'number') return fb.grade >= 3 ? 'right' : 'wrong';
  return fb.correct === false ? 'wrong' : 'right';
}

function buildFallbackRows(run: ReviewRun): LookBackRow[] {
  const rawEntries = (run as { entries?: unknown }).entries;
  if (Array.isArray(rawEntries) && rawEntries.length > 0) {
    const typed = rawEntries as Array<Record<string, unknown>>;
    const nonRetry = typed.filter((e) => e && !e.retry);
    const list = nonRetry.length > 0 ? nonRetry : typed;
    return list.map((entry, idx) => {
      const card = (entry.card && typeof entry.card === 'object' ? entry.card : {}) as NonNullable<LookBackRow['card']>;
      const fb = entry.feedback && typeof entry.feedback === 'object' ? (entry.feedback as LookBackFeedback) : undefined;
      const solRaw = entry.solution && typeof entry.solution === 'object' ? (entry.solution as LookBackSolution) : undefined;
      const fallbackSol: LookBackSolution | undefined =
        solRaw ||
        (card.answer || card.explanation
          ? {
              ...(typeof card.answer === 'string' ? { answer: card.answer } : {}),
              ...(typeof card.explanation === 'string' ? { explanation: card.explanation } : {}),
            }
          : undefined);
      return {
        number: idx + 1,
        deckId: typeof entry.deckId === 'string' ? entry.deckId : run.deckId,
        cardId: typeof card.id === 'string' ? card.id : typeof entry.cardId === 'string' ? entry.cardId : undefined,
        kind: typeof card.kind === 'string' ? card.kind : typeof entry.kind === 'string' ? entry.kind : undefined,
        status: statusFromEntry(entry),
        prompt: String(card.prompt ?? entry.prompt ?? ''),
        card,
        ...(fb ? { feedback: fb } : {}),
        ...(fallbackSol ? { solution: fallbackSol } : {}),
        ...(typeof entry.errorReason === 'string' ? { errorReason: entry.errorReason } : {}),
        ...(typeof entry.sourceTitle === 'string' ? { sourceTitle: entry.sourceTitle } : {}),
        ...(typeof entry.page === 'number' ? { page: entry.page } : {}),
      };
    });
  }

  const missedList = Array.isArray((run as { missedCards?: unknown }).missedCards)
    ? ((run as { missedCards?: Array<{ deckId?: string; cardId?: string; topic?: string; prompt?: string }> }).missedCards ?? [])
    : [];
  const missedMap = new Map(missedList.map((m) => [m.cardId, m]));

  if (Array.isArray(run.navigation) && run.navigation.length > 0) {
    const navItems = run.navigation.filter((n) => !n.retry);
    const list = navItems.length > 0 ? navItems : run.navigation;
    return list.map((nav, idx) => {
      const missed = missedMap.get(nav.cardId);
      const status: LookBackRow['status'] = nav.grading
        ? 'grading'
        : !nav.answered
          ? 'unanswered'
          : nav.passed === true
            ? 'right'
            : nav.passed === false
              ? 'wrong'
              : missed
                ? 'wrong'
                : 'right';
      return {
        number: idx + 1,
        deckId: nav.deckId,
        cardId: nav.cardId,
        status,
        prompt: missed?.prompt || nav.topic || nav.cardId,
        card: {
          id: nav.cardId,
          prompt: missed?.prompt || nav.topic || nav.cardId,
          ...(nav.topic ? { topic: nav.topic } : {}),
        },
        ...(typeof nav.page === 'number' ? { page: nav.page } : {}),
      };
    });
  }

  return missedList.map((m, idx) => ({
    number: idx + 1,
    deckId: m.deckId,
    cardId: m.cardId,
    status: 'wrong' as const,
    prompt: m.prompt || m.topic || m.cardId || '',
    card: {
      id: m.cardId,
      prompt: m.prompt || m.topic || '',
      ...(m.topic ? { topic: m.topic } : {}),
    },
  }));
}

function formatRowRatingTag(row: LookBackRow, lang: UiLanguage): string {
  if (row.status === 'grading') return t(lang, '批改', 'Grd');
  if (row.status === 'unanswered') return t(lang, '未答', 'Skip');
  if (row.status === 'self') return t(lang, '自报', 'Self');
  const rubric = row.feedback?.rubric;
  if (rubric && typeof rubric.total === 'number' && typeof rubric.max === 'number' && rubric.max > 0) {
    return `${rubric.total}/${rubric.max}`;
  }
  const grade = row.feedback?.grade;
  if (typeof grade === 'number') {
    if (grade === 1) return t(lang, '重来', 'Again');
    if (grade === 2) return t(lang, '较难', 'Miss');
    if (grade === 3) return t(lang, '困难', 'Hard');
    if (grade === 4) return t(lang, '良好', 'Good');
    if (grade === 5) return t(lang, '简单', 'Easy');
    return `${grade}/5`;
  }
  return row.status === 'right' ? t(lang, '对', 'OK') : t(lang, '错', 'Miss');
}

function formatReferenceAnswer(row: LookBackRow): string {
  const sol = row.solution;
  if (!sol) return '';
  const opts = sol.options ?? row.card?.options;
  if (Array.isArray(opts) && opts.length > 0) {
    const correct = opts.filter((o) => o.correct);
    if (correct.length > 0) {
      return correct.map((o) => o.text || o.id || '').filter(Boolean).join(' / ');
    }
  }
  if (sol.cloze?.answers?.length) {
    return sol.cloze.answers.map((a, i) => `#${i + 1}: ${a.value}`).join(' | ');
  }
  return String(sol.answer || '').trim();
}

function formatUserAnswer(row: LookBackRow): string {
  const fb = row.feedback;
  if (!fb) return '';
  const opts = row.card?.options;
  if (Array.isArray(fb.selected) && fb.selected.length > 0) {
    return fb.selected
      .map((id) => opts?.find((o) => o.id === id)?.text || id)
      .filter(Boolean)
      .join(' / ');
  }
  if (fb.answers && typeof fb.answers === 'object') {
    const vals = Object.entries(fb.answers)
      .filter(([, v]) => String(v || '').trim())
      .map(([, v], idx) => `#${idx + 1}: ${String(v).trim()}`);
    if (vals.length > 0) return vals.join(' | ');
  }
  if (typeof fb.answer === 'string' && fb.answer.trim()) return fb.answer.trim();
  if (typeof fb.note === 'string' && fb.note.trim()) return fb.note.trim();
  return '';
}

function statusBadgeMeta(status: LookBackRow['status'], lang: UiLanguage) {
  switch (status) {
    case 'right':
      return { label: t(lang, '答对', 'Correct'), tone: 'success' as const };
    case 'wrong':
      return { label: t(lang, '需巩固', 'Missed'), tone: 'error' as const };
    case 'self':
      return { label: t(lang, '自报', 'Self'), tone: 'neutral' as const };
    case 'grading':
      return { label: t(lang, '批改中', 'Grading'), tone: 'warning' as const };
    default:
      return { label: t(lang, '未答', 'Unanswered'), tone: 'neutral' as const };
  }
}

export const RoundSummary = memo(function RoundSummary({
  host,
  run,
  width,
  height,
  isActive,
  mathUnicode,
  onPracticeWeak,
  onNewRound,
  onGoLibrary,
  onRetryWeak,
  onContinue,
  onBack,
}: RoundSummaryProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const notify = useTuiStore((s) => s.notify);
  const navigate = useTuiStore((s) => s.navigate);

  const [rows, setRows] = useState<LookBackRow[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [loadingLookBack, setLoadingLookBack] = useState(true);
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const [detailScrollTop, setDetailScrollTop] = useState(0);
  const [dailyGroup, setDailyGroup] = useState<DailyStatusGroup | null>(null);
  const [generatingRecap, setGeneratingRecap] = useState(false);
  const [retryingWeak, setRetryingWeak] = useState(false);
  const [debrief, setDebrief] = useState<DebriefResult | null>(() => (run as { debrief?: DebriefResult }).debrief ?? null);
  const [debriefOpen, setDebriefOpen] = useState(false);
  const [confirmDebriefOpen, setConfirmDebriefOpen] = useState(false);
  const [debriefBusy, setDebriefBusy] = useState(false);
  const debriefBusyRef = useRef(false);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fallbackRows = useMemo(() => buildFallbackRows(run), [run]);
  const fallbackRowsRef = useRef(fallbackRows);
  fallbackRowsRef.current = fallbackRows;

  const runDebriefRef = useRef((run as { debrief?: DebriefResult }).debrief ?? null);
  runDebriefRef.current = (run as { debrief?: DebriefResult }).debrief ?? null;

  useEffect(() => {
    let cancelled = false;
    setPreviewExpanded(false);
    setDetailScrollTop(0);
    setDebrief(runDebriefRef.current);
    setDebriefOpen(false);
    setConfirmDebriefOpen(false);
    debriefBusyRef.current = false;
    setDebriefBusy(false);

    if (!run?.id) {
      setLoadingLookBack(false);
      const fb = fallbackRowsRef.current;
      setRows(fb);
      const firstWeak = fb.findIndex((r) => r.status === 'wrong');
      setSelectedIdx(firstWeak >= 0 ? firstWeak : 0);
      return undefined;
    }

    setLoadingLookBack(true);
    void tryAction<{ rows?: LookBackRow[] }>(host, 'review.lookBack', { runId: run.id }).then((res) => {
      if (cancelled || !mountedRef.current) return;
      setLoadingLookBack(false);
      const fetched = res.ok && Array.isArray(res.value?.rows) ? res.value.rows : [];
      const nextRows = fetched.length > 0 ? fetched : fallbackRowsRef.current;
      setRows(nextRows);
      const firstWeak = nextRows.findIndex((r) => r.status === 'wrong');
      setSelectedIdx(firstWeak >= 0 ? firstWeak : 0);
    });

    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    void tryAction<{ groups?: DailyStatusGroup[] }>(host, 'note.daily.status', { runId: run.id, timeZone }).then((res) => {
      if (cancelled || !mountedRef.current) return;
      if (res.ok && Array.isArray(res.value?.groups) && res.value.groups.length > 0) {
        setDailyGroup(res.value.groups[0]);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [host, run?.id]);

  const triggerDailyRecap = useCallback(async () => {
    if (generatingRecap) return;
    if (!dailyGroup) {
      notify(t(lang, '暂无每日复盘状态数据', 'Daily recap status unavailable'), 'warning');
      return;
    }
    if (!dailyGroup.eligible) {
      notify(
        t(
          lang,
          `当天同一课程累计完成 10 道不同题目后可生成每日复盘（当前 ${dailyGroup.answeredCount ?? 0} 题）`,
          `Complete 10 distinct questions in one course today to generate a daily recap (${dailyGroup.answeredCount ?? 0} so far)`,
        ),
        'info',
      );
      return;
    }
    if (dailyGroup.noteId && dailyGroup.hasContent) {
      navigate('notes', { noteId: dailyGroup.noteId });
      return;
    }
    setGeneratingRecap(true);
    const timeZone = dailyGroup.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const res = await tryAction<{ id?: string; status?: string }>(host, 'note.daily.generate', {
      course: dailyGroup.courseId || dailyGroup.course,
      day: dailyGroup.day,
      timeZone,
    });
    if (!mountedRef.current) return;
    setGeneratingRecap(false);
    if (!res.ok) {
      notify(res.error?.message || t(lang, '生成每日复盘失败', 'Failed to generate daily recap'), 'error');
      return;
    }
    notify(t(lang, '已触发每日复盘生成，前往学习笔记查看', 'Daily recap generation started'), 'success');
    if (res.value?.id) {
      setDailyGroup((prev) => (prev ? { ...prev, noteId: res.value?.id, generation: { status: res.value?.status } } : prev));
    }
  }, [generatingRecap, dailyGroup, host, lang, notify, navigate]);

  const totalQuestions = Number((run as { questions?: number }).questions ?? run.total ?? rows.length) || 0;
  const answered = Number(
    run.answered ?? rows.filter((r) => r.status !== 'unanswered' && r.status !== 'grading').length,
  ) || 0;
  const correct = Number((run as { correct?: number }).correct ?? rows.filter((r) => r.status === 'right').length) || 0;
  const accuracy = answered > 0 ? Math.round((correct / answered) * 100) : 0;
  const rawWeakTopics = (run as Record<string, unknown>).weakTopics;
  const weakTopics = useMemo(
    () => (Array.isArray(rawWeakTopics) ? (rawWeakTopics as string[]).filter(Boolean) : []),
    [rawWeakTopics],
  );
  const rawMissed = (run as Record<string, unknown>).missedCards;
  const hasMissed =
    rows.some((r) => r.status === 'wrong') ||
    (Array.isArray(rawMissed) && rawMissed.length > 0) ||
    weakTopics.length > 0;

  const handleRetryWeak = useCallback(async () => {
    if (!hasMissed) {
      notify(t(lang, '本轮没有需要重练的错题或薄弱题', 'No weak cards to retry in this round'), 'info');
      return;
    }
    const handler = onRetryWeak ?? onPracticeWeak;
    if (handler) {
      handler();
      return;
    }
    if (!run?.id || retryingWeak) return;
    setRetryingWeak(true);
    const res = await tryAction<ReviewRun>(host, 'review.weak.start', { runId: run.id });
    if (!mountedRef.current) return;
    setRetryingWeak(false);
    if (!res.ok || !res.value?.id) {
      notify(res.error?.message || t(lang, '本轮暂无薄弱题', 'No weak cards to retry'), 'warning');
      return;
    }
    navigate('review', { runId: res.value.id });
  }, [hasMissed, onRetryWeak, onPracticeWeak, run?.id, retryingWeak, host, notify, lang, navigate]);

  const handleNewRound = useCallback(() => {
    const handler = onNewRound ?? onContinue;
    if (handler) handler();
    else navigate('review');
  }, [onNewRound, onContinue, navigate]);

  const handleGoBack = useCallback(() => {
    const handler = onGoLibrary ?? onBack;
    if (handler) handler();
    else navigate('library');
  }, [onGoLibrary, onBack, navigate]);

  const handleDebriefKey = useCallback(() => {
    if (confirmDebriefOpen || debriefOpen || debriefBusyRef.current) return;
    if (run.mode === 'exam') {
      notify(t(lang, '模拟考试请查看上方成绩单', 'Mock exam uses the exam score report'), 'info');
      return;
    }
    if (debrief && debrief.headline) {
      setDebriefOpen(true);
      return;
    }
    setConfirmDebriefOpen(true);
  }, [confirmDebriefOpen, debriefOpen, run.mode, debrief, notify, lang]);

  const handleConfirmDebrief = useCallback(async () => {
    setConfirmDebriefOpen(false);
    if (!run?.id || debriefBusyRef.current) return;
    debriefBusyRef.current = true;
    setDebriefBusy(true);
    const res = await tryAction<DebriefResult>(host, 'coach.debrief', { runId: run.id });
    debriefBusyRef.current = false;
    if (!mountedRef.current) return;
    setDebriefBusy(false);
    if (!res.ok || !res.value) {
      notify(res.error?.message || t(lang, '获取 AI 复盘点评失败', 'Failed to load AI coach debrief'), 'error');
      return;
    }
    setDebrief(res.value);
    setDebriefOpen(true);
  }, [host, lang, notify, run?.id]);

  const isNarrow = width < SPLIT_BREAKPOINT;
  const selectedRow = rows[selectedIdx] ?? null;
  const modalOpen = confirmDebriefOpen || debriefOpen;

  useClaimKeys(CLAIMED_SUMMARY_KEYS, isActive);

  const hints: KeyHint[] = useMemo(
    () => [
      { key: 'j/k', label: t(lang, '选题目', 'Select') },
      ...(selectedRow
        ? [
            {
              key: 'Enter/Space/v',
              label: previewExpanded ? t(lang, '收起解析', 'Hide Ans') : t(lang, '答案解析', 'Preview'),
            },
          ]
        : []),
      ...(hasMissed ? [{ key: 'w', label: t(lang, '重练错题', 'Retry Weak') }] : []),
      ...(run.mode !== 'exam'
        ? [{ key: 'd', label: debrief ? t(lang, '查看复盘', 'Debrief') : t(lang, 'AI复盘', 'Debrief') }]
        : []),
      { key: 'g', label: dailyGroup?.hasContent ? t(lang, '看复盘', 'View Recap') : t(lang, '每日复盘', 'Daily Recap') },
      { key: 'R', label: t(lang, '再来一轮', 'New Round') },
      { key: 'Esc/b/1', label: t(lang, '学习库', 'Library') },
    ],
    [selectedRow, previewExpanded, hasMissed, run.mode, debrief, dailyGroup?.hasContent, lang],
  );
  useFooterHints(hints, isActive);

  useInput(
    (input, key) => {
      if (isNarrow && previewExpanded && (key.escape || key.leftArrow)) {
        setPreviewExpanded(false);
        return true;
      }
      if ((key.return || input === ' ' || input === 'v') && selectedRow) {
        setDetailScrollTop(0);
        setPreviewExpanded((prev) => !prev);
        return;
      }
      if (previewExpanded) {
        if (key.pageDown || (key.ctrl && input === 'd')) {
          setDetailScrollTop((top) => top + 6);
          return;
        }
        if (key.pageUp || (key.ctrl && input === 'u')) {
          setDetailScrollTop((top) => Math.max(0, top - 6));
          return;
        }
        if (isNarrow && (key.downArrow || input === 'j')) {
          setDetailScrollTop((top) => top + 1);
          return;
        }
        if (isNarrow && (key.upArrow || input === 'k')) {
          setDetailScrollTop((top) => Math.max(0, top - 1));
          return;
        }
      }
      if (input === 'd' && !key.ctrl && !key.meta) {
        handleDebriefKey();
        return;
      }
      if (input === 'w') {
        void handleRetryWeak();
        return;
      }
      if (input === 'g') {
        void triggerDailyRecap();
        return;
      }
      if (input === 'R') {
        handleNewRound();
        return;
      }
      if (input === 'b' || input === '1' || key.escape) {
        handleGoBack();
      }
    },
    { isActive: isActive && !modalOpen },
  );

  const detailMarkdown = useMemo(() => {
    if (!selectedRow) return '';
    const prompt = String(selectedRow.card?.prompt ?? selectedRow.prompt ?? '').trim();
    const parts: string[] = [];
    if (selectedRow.card?.topic) {
      parts.push(`**${t(lang, '知识点', 'Topic')}**: ${String(selectedRow.card.topic)}`);
    }
    if (prompt) parts.push(prompt);

    const userAns = formatUserAnswer(selectedRow);
    if (userAns) {
      parts.push(`**${t(lang, '你的作答', 'Your Answer')}**: ${userAns}`);
    }

    if (previewExpanded) {
      if (selectedRow.solution) {
        const refAnswer = formatReferenceAnswer(selectedRow);
        if (refAnswer) {
          parts.push(`**${t(lang, '参考答案', 'Reference Answer')}**: ${refAnswer}`);
        }
        if (selectedRow.solution.explanation) {
          parts.push(`**${t(lang, '解析', 'Explanation')}**:\n${String(selectedRow.solution.explanation).trim()}`);
        }
        if (selectedRow.solution.misconception) {
          parts.push(`> **${t(lang, '常见误区', 'Misconception')}**: ${String(selectedRow.solution.misconception).trim()}`);
        }
        if (selectedRow.solution.rubric) {
          parts.push(`**${t(lang, '评分依据', 'Rubric')}**: ${String(selectedRow.solution.rubric).trim()}`);
        }
        if (Array.isArray(selectedRow.solution.followups) && selectedRow.solution.followups.length > 0) {
          const qaLines = selectedRow.solution.followups
            .filter((f) => f && (f.question || f.answer))
            .slice(0, 3)
            .map((f) => `- **Q**: ${String(f.question || '').trim()}\n  **A**: ${String(f.answer || '').trim()}`);
          if (qaLines.length > 0) {
            parts.push(`### ${t(lang, 'AI 追问记录', 'Follow-up Q&A')}\n${qaLines.join('\n')}`);
          }
        }
      } else {
        parts.push(
          `> ${
            selectedRow.status === 'grading'
              ? t(lang, '正在批改中，分数出来后会显示参考答案与解析。', 'Still grading; reference answer and explanation will appear once graded.')
              : t(lang, '本题本轮未作答，参考答案留待下次练习时揭晓。', 'Unanswered in this round; reference answer hidden until next attempt.')
          }`,
        );
      }
    }

    return parts.join('\n\n');
  }, [selectedRow, previewExpanded, lang]);

  const ellipsis = asciiMode ? '...' : '…';
  const headerH = height <= 24 ? 4 : 5;
  const proactiveHints = useTuiStore((s) => s.preferences.proactiveHints !== false);
  const snapshot = useTuiStore((s) => s.snapshot);
  const nextStepSuggestion = useMemo(
    () =>
      buildRoundNextStepSuggestion({
        answered,
        correct,
        weakCount: Math.max(rows.filter((r) => r.status === 'wrong').length, Math.max(0, answered - correct)),
        weakTopics,
        remainingDue: dueToday(snapshot),
        lang,
        asciiMode,
        proactiveHints,
      }),
    [answered, correct, rows, weakTopics, snapshot, lang, asciiMode, proactiveHints],
  );
  const effectiveHeaderH = nextStepSuggestion && height >= 16 ? Math.max(headerH, 5) : headerH;
  const bodyH = Math.max(6, height - effectiveHeaderH);
  const headerInnerW = Math.max(16, width - 4);
  const barW = Math.min(20, Math.max(8, Math.floor(width * 0.16)));
  const statsPrefix = `${t(lang, '已答', 'Ans')} ${answered}/${totalQuestions}  ${t(lang, '答对', 'OK')} ${correct}`;
  const weakBudget = Math.max(0, headerInnerW - displayWidth(statsPrefix) - barW - 10);
  const weakSep = asciiMode ? ' / ' : ' · ';

  const recapLine = dailyGroup?.eligible
    ? dailyGroup.hasContent
      ? t(lang, '[g] 查看今日每日复盘笔记', "[g] Open today's daily recap")
      : t(lang, '[g] 生成今日每日复盘 (Daily Recap)', '[g] Generate Daily Recap')
    : t(
        lang,
        `今日累计满 10 题可生成每日复盘 (${dailyGroup?.answeredCount ?? answered}/10)`,
        `10 questions/day unlocks Daily Recap (${dailyGroup?.answeredCount ?? answered}/10)`,
      );

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Panel
        title={t(lang, '本轮练习总结', 'Round Summary')}
        icon={asciiMode ? '*' : '★'}
        badge={answered > 0 ? `${accuracy}%` : t(lang, '已结束', 'Ended')}
        badgeTone={accuracy >= 70 ? 'success' : answered > 0 ? 'warning' : 'neutral'}
        width={width}
        height={effectiveHeaderH}
        ascii={asciiMode}
      >
        <Box flexDirection="row" alignItems="center" gap={1} height={1} overflow="hidden">
          <Text color={theme.text} bold wrap="truncate">
            {statsPrefix}
          </Text>
          <ProgressBar ratio={answered > 0 ? correct / answered : 0} width={barW} showPercent />
          {weakTopics.length > 0 && weakBudget >= 10 ? (
            <Text color={theme.warning} wrap="truncate">
              {truncateDisplay(`${t(lang, '薄弱', 'Weak')}: ${weakTopics.join(weakSep)}`, weakBudget, ellipsis)}
            </Text>
          ) : null}
          {generatingRecap || retryingWeak || debriefBusy ? (
            <Spinner
              label={
                retryingWeak
                  ? t(lang, '开启重练', 'Starting')
                  : debriefBusy
                    ? t(lang, 'AI复盘', 'Debriefing')
                    : t(lang, '生成复盘', 'Generating')
              }
              tone="ai"
              active={isActive}
            />
          ) : null}
        </Box>
        <Box flexDirection="row" alignItems="center" justifyContent="space-between" height={1} overflow="hidden">
          <Text color={theme.muted} wrap="truncate">
            {truncateDisplay(recapLine, hasMissed ? Math.max(12, headerInnerW - 22) : headerInnerW, ellipsis)}
          </Text>
          {hasMissed && headerInnerW >= 46 ? (
            <Text color={theme.warning} bold wrap="truncate">
              {t(lang, '[w] 重练错题', '[w] Retry Weak')}
            </Text>
          ) : null}
        </Box>
        {nextStepSuggestion && height >= 16 ? (
          <Box height={1} overflow="hidden">
            <Text color={theme.ai} wrap="truncate">
              {truncateDisplay(nextStepSuggestion.text, headerInnerW, ellipsis)}
            </Text>
          </Box>
        ) : null}
      </Panel>

      <SplitPane
        width={width}
        height={bodyH}
        leftWidth={0.42}
        minLeft={28}
        minRight={34}
        breakpoint={SPLIT_BREAKPOINT}
        activePane={isNarrow && previewExpanded ? 'right' : 'left'}
        leftLabel={t(lang, '题目回顾', 'Items')}
        rightLabel={t(lang, '解析详情', 'Detail')}
        left={(size) => {
          const showFooterHint = size.height >= 7;
          const listW = Math.max(10, size.width - 4);
          const listH = Math.max(3, size.height - (showFooterHint ? 3 : 2));
          return (
            <Panel
              title={t(lang, '本轮题目回顾', 'Round Look-Back')}
              badge={rows.length}
              width={size.width}
              height={size.height}
              focused={isActive && !modalOpen && !(isNarrow && previewExpanded)}
              ascii={asciiMode}
            >
              {loadingLookBack ? (
                <Spinner label={t(lang, `加载本轮回顾${ellipsis}`, `Loading look-back${ellipsis}`)} active={isActive} />
              ) : rows.length === 0 ? (
                <EmptyState
                  title={t(lang, '本轮暂无答题记录', 'No questions recorded in this round')}
                  width={listW}
                  height={listH}
                />
              ) : (
                <>
                  <VirtualList
                    items={rows}
                    width={listW}
                    height={listH}
                    selectedIndex={selectedIdx}
                    onChange={(idx) => {
                      setSelectedIdx(idx);
                      setDetailScrollTop(0);
                    }}
                    isActive={isActive && !modalOpen && !(isNarrow && previewExpanded)}
                    ascii={asciiMode}
                    keyExtractor={(r, i) => `${r.cardId || 'row'}-${i}`}
                    renderItem={(row, ctx) => {
                      const statusColor =
                        row.status === 'right'
                          ? theme.success
                          : row.status === 'wrong'
                            ? theme.error
                            : row.status === 'grading'
                              ? theme.warning
                              : theme.muted;
                      const icon =
                        row.status === 'right'
                          ? asciiMode
                            ? '+'
                            : '✓'
                          : row.status === 'wrong'
                            ? asciiMode
                              ? 'x'
                              : '✕'
                            : row.status === 'self'
                              ? asciiMode
                                ? '*'
                                : '◆'
                              : row.status === 'grading'
                                ? '~'
                                : asciiMode
                                  ? 'o'
                                  : '○';
                      const pointer = ctx.selected ? (asciiMode ? '>' : '▸') : ' ';
                      const ratingTag = `[${formatRowRatingTag(row, lang)}]`;
                      const numTag = `#${row.number ?? ctx.index + 1}`;
                      const fixedPrefix = `${pointer}${icon} ${numTag} ${ratingTag} `;
                      const snippetBudget = Math.max(4, ctx.width - displayWidth(fixedPrefix));
                      const snippet = cleanPromptSnippet(String(row.card?.prompt ?? row.prompt ?? ''), asciiMode);
                      return (
                        <Box flexDirection="row" width={ctx.width} height={1} overflow="hidden">
                          <Text color={ctx.selected ? theme.primary : theme.dim} bold={ctx.selected}>
                            {pointer}
                          </Text>
                          <Text color={statusColor} bold>{`${icon} `}</Text>
                          <Text color={ctx.selected ? theme.selectionFg : theme.muted}>{`${numTag} `}</Text>
                          <Text color={statusColor}>{`${ratingTag} `}</Text>
                          <Text color={ctx.selected ? theme.selectionFg : theme.text} wrap="truncate">
                            {truncateDisplay(snippet, snippetBudget, ellipsis)}
                          </Text>
                        </Box>
                      );
                    }}
                  />
                  {showFooterHint ? (
                    <Box height={1} width={listW} overflow="hidden">
                      <Text color={theme.dim} wrap="truncate">
                        {truncateDisplay(
                          hasMissed
                            ? t(lang, '[Enter/Space/v] 答案解析  [w] 重练  [R] 再来一轮  [b] 返回', '[Enter/Space/v] Preview  [w] Retry  [R] New  [b] Back')
                            : t(lang, '[Enter/Space/v] 答案解析  [R] 再来一轮  [b/Esc] 返回', '[Enter/Space/v] Preview  [R] New Round  [b/Esc] Back'),
                          listW,
                          ellipsis,
                        )}
                      </Text>
                    </Box>
                  ) : null}
                </>
              )}
            </Panel>
          );
        }}
        right={(size) => {
          const innerW = Math.max(12, size.width - 4);
          const innerH = Math.max(4, size.height - 2);
          const mdHeight = Math.max(2, innerH - 2);
          const badgeMeta = selectedRow ? statusBadgeMeta(selectedRow.status, lang) : null;
          const ratingLabel = selectedRow ? formatRowRatingTag(selectedRow, lang) : '';
          const subtitle = selectedRow?.sourceTitle
            ? `${selectedRow.sourceTitle}${selectedRow.page != null ? ` p.${selectedRow.page}` : ''}`
            : undefined;
          return (
            <Panel
              title={selectedRow ? `#${selectedRow.number ?? selectedIdx + 1}` : t(lang, '题目详情', 'Question Detail')}
              subtitle={subtitle}
              width={size.width}
              height={size.height}
              focused={isActive && !modalOpen && isNarrow && previewExpanded}
              ascii={asciiMode}
            >
              {selectedRow && badgeMeta ? (
                <Box flexDirection="column" width={innerW} height={innerH} overflow="hidden">
                  <Box flexDirection="row" gap={1} height={1} overflow="hidden">
                    <Badge label={badgeMeta.label} tone={badgeMeta.tone} />
                    <Badge label={ratingLabel} tone={badgeMeta.tone} variant="outline" />
                    {selectedRow.errorReason ? <Badge label={selectedRow.errorReason} tone="warning" variant="outline" /> : null}
                  </Box>
                  <Box height={mdHeight} width={innerW} overflow="hidden">
                    <MarkdownView
                      markdown={detailMarkdown}
                      width={innerW}
                      height={mdHeight}
                      mathUnicode={mathUnicode}
                      ascii={asciiMode}
                      scrollTop={detailScrollTop}
                      onScroll={setDetailScrollTop}
                    />
                  </Box>
                  <Box height={1} width={innerW} overflow="hidden">
                    <Text color={previewExpanded ? theme.accent : theme.primary} bold wrap="truncate">
                      {truncateDisplay(
                        previewExpanded
                          ? isNarrow
                            ? t(lang, '[Enter/Space/v/Esc] 收起返回列表  [j/k] 滚动', '[Enter/Space/v/Esc] Collapse  [j/k] Scroll')
                            : t(lang, '[Enter/Space/v] 收起参考答案与解析  [PgUp/PgDn] 滚动', '[Enter/Space/v] Hide Answer & Explanation  [PgUp/PgDn] Scroll')
                          : t(lang, '[Enter/Space/v] 展开参考答案与解析', '[Enter/Space/v] Show Reference Answer & Explanation'),
                        innerW,
                        ellipsis,
                      )}
                    </Text>
                  </Box>
                </Box>
              ) : (
                <EmptyState title={t(lang, '选择左侧题目查看解析', 'Select a question on the left')} width={innerW} height={innerH} />
              )}
            </Panel>
          );
        }}
      />
      {confirmDebriefOpen ? (
        <ConfirmDialog
          title={t(lang, 'AI 教练本轮复盘', 'AI Coach Round Debrief')}
          message={t(
            lang,
            '获取 AI 教练本轮复盘点评？将分析本轮作答表现；若本轮已作答满 3 题可能会调用模型生成点评与建议。',
            'Request AI Coach debrief for this round? Analyzes this round performance and may invoke the model if 3+ cards were answered.',
          )}
          confirmLabel={t(lang, '获取点评', 'Get Debrief')}
          onConfirm={() => void handleConfirmDebrief()}
          onCancel={() => setConfirmDebriefOpen(false)}
          isActive={isActive}
          width={Math.min(64, Math.max(36, width - 4))}
        />
      ) : null}
      {debriefOpen && debrief ? (
        <DebriefModal
          debrief={debrief}
          width={width}
          height={height}
          isActive={isActive}
          onClose={() => setDebriefOpen(false)}
        />
      ) : null}
    </Box>
  );
});
