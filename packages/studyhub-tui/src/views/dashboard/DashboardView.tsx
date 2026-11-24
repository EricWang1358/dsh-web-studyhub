import React, { Suspense, lazy, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { StudySnapshot, ViewProps } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { atomicWriteExportText, defaultBackupFilePath, todayLocalYmd } from '../../host/atomic-write.js';
import { tryAction } from '../../host/sample-actions.js';
import { currentCourse, dueToday } from '../../shell/data.js';
import { useShellActions } from '../../shell/actions.js';
import { useTheme } from '../../theme/tokens.js';
import { EmptyState, Spinner } from '../../components/Badge.js';
import { Panel } from '../../components/Panel.js';
import { TextInput } from '../../components/TextInput.js';
import { VirtualList, type VirtualListRenderContext } from '../../components/VirtualList.js';
import { useClaimKeys, useInputCapture } from '../../components/focus.js';
import { useFooterHints } from '../../components/hooks.js';
import { displayWidth, padDisplay, truncateDisplay } from '../../render/cjk.js';
import {
  renderBarChart,
  renderHeatmap,
  renderProgressBar,
  renderStatTable,
  type BarChartItem,
  type HeatmapDay,
} from '../../render/charts.js';

const StudyMapModal = lazy(() =>
  import('./StudyMapModal.js').then((m) => ({ default: m.StudyMapModal })),
);

interface WeakTopicRow {
  deckId: string;
  deckTitle: string;
  course: string;
  topic: string;
  wrong: number;
  lastAt: string;
  cards: Array<{ deckId: string; cardId: string }>;
}

interface ForecastDay {
  date: string;
  count: number;
  overdue?: number;
  cards?: Array<{ deckId: string; cardId: string }>;
  truncated?: boolean;
}

interface StatsResponse {
  today?: string;
  totals?: {
    attempts?: number;
    activeDays?: number;
    streak?: number;
    correctRate?: number | null;
    recentRate?: number | null;
    recentAttempts?: number;
    cards?: number;
    due?: number;
    mastered?: number;
    weak?: number;
  };
  heatmap?: HeatmapDay[];
  weakTopics?: WeakTopicRow[];
  weakScope?: Array<{ deckId: string; cardId: string }>;
  forecast?: {
    days?: ForecastDay[];
    later?: number;
    hidden?: {
      today?: number;
      count?: number;
      later?: number;
    };
  };
}

interface DailyPlanProfile {
  weekdayMinutes?: number;
  weekendMinutes?: number;
  observedWeekdayMinutes?: number;
  observedWeekendMinutes?: number;
  sampleDays?: number;
  source?: string;
}

interface DailyPlanResponse {
  date?: string;
  budgetMinutes?: number;
  spentMinutes?: number;
  budgetBasis?: string;
  profile?: DailyPlanProfile;
}

interface UsageTotals {
  uncachedInputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  calls?: number;
}

interface UsageSummaryResponse {
  days?: number;
  byFeature?: Record<string, UsageTotals>;
  total?: UsageTotals;
}

interface DeckProgressEntry {
  total?: number;
  mastery?: number;
  due?: number;
  counts?: {
    new?: number;
    weak?: number;
    learning?: number;
    familiar?: number;
    mastered?: number;
  };
}

export type DrillItem =
  | {
      kind: 'weak';
      key: string;
      course: string;
      topic: string;
      wrong: number;
      cardCount: number;
      cards: Array<{ deckId: string; cardId: string }>;
    }
  | {
      kind: 'course';
      key: string;
      course: string;
      label: string;
      masteryPct: number;
      totalCards: number;
      dueCount: number;
      weakCount: number;
    };

export type DashboardDrillFilterable =
  | { kind: 'weak'; topic?: string | null; course?: string | null }
  | { kind: 'course'; label?: string | null; course?: string | null };

/**
 * Filter dashboard drill items (weak topics and course rows) by a case-insensitive substring query.
 */
export function filterDashboardDrillItems<T extends DashboardDrillFilterable>(
  items: readonly T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items as T[];
  return items.filter((item) => {
    if (item.kind === 'weak') {
      return (
        (item.topic ?? '').toLowerCase().includes(q) ||
        (item.course ?? '').toLowerCase().includes(q)
      );
    }
    return (
      (item.label ?? '').toLowerCase().includes(q) ||
      (item.course ?? '').toLowerCase().includes(q)
    );
  });
}

function formatForecastLabel(date: string, index: number, lang: 'zh' | 'en'): string {
  if (index === 0) return t(lang, '今日', 'Today');
  const parsed = new Date(`${date}T12:00:00Z`);
  const dow = Number.isFinite(parsed.getTime()) ? parsed.getUTCDay() : 0;
  const zhDays = ['日', '一', '二', '三', '四', '五', '六'];
  const enDays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const mmdd = date.length >= 10 ? date.slice(5, 10) : date;
  return `${mmdd} ${lang === 'zh' ? zhDays[dow] : enDays[dow]}`;
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function totalTokensOf(u?: UsageTotals | null): number {
  if (!u) return 0;
  return (
    (Number(u.uncachedInputTokens) || 0) +
    (Number(u.outputTokens) || 0) +
    (Number(u.cacheReadTokens) || 0) +
    (Number(u.cacheWriteTokens) || 0)
  );
}

export type UsageWindowDays = 7 | 30 | 90;

export interface DashboardCourseReportRow {
  rawCourse?: string;
  label: string;
  masteryPct: number;
  totalCards: number;
  dueCount: number;
  weakCount: number;
}

export interface DashboardReportInput {
  stats: StatsResponse | null;
  dailyPlan?: DailyPlanResponse | null;
  usage: UsageSummaryResponse | null;
  usageDays: UsageWindowDays;
  courseRows: readonly DashboardCourseReportRow[];
  focusCourse?: string | null;
  lang: 'zh' | 'en';
  generatedAt?: string;
}

function escapeMdCell(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

export function formatDashboardMarkdownReport({
  stats,
  dailyPlan,
  usage,
  usageDays,
  courseRows,
  focusCourse,
  lang,
  generatedAt,
}: DashboardReportInput): string {
  const reportDate = generatedAt || stats?.today || todayLocalYmd();
  const totals = stats?.totals;
  const totalCards = totals?.cards ?? courseRows.reduce((sum, row) => sum + (Number(row.totalCards) || 0), 0);
  const mastered = totals?.mastered ?? 0;
  const dueTodayCount = totals?.due ?? courseRows.reduce((sum, row) => sum + (Number(row.dueCount) || 0), 0);
  const weakCount = totals?.weak ?? courseRows.reduce((sum, row) => sum + (Number(row.weakCount) || 0), 0);
  const attempts = totals?.attempts ?? 0;
  const acc = totals?.recentRate ?? totals?.correctRate;
  const accStr = acc !== null && acc !== undefined ? `${acc}%` : '--';
  const activeDays = totals?.activeDays ?? 0;
  const streak = totals?.streak ?? 0;

  const lines: string[] = [
    `# ${t(lang, 'StudyHub 学习进度报告', 'StudyHub Study Progress Report')}`,
    '',
    `- ${t(lang, '生成日期', 'Date')}: ${reportDate}`,
  ];
  if (focusCourse) {
    lines.push(`- ${t(lang, '当前课程', 'Focus Course')}: ${escapeMdCell(focusCourse)}`);
  }
  if (dailyPlan && (dailyPlan.budgetMinutes !== undefined || dailyPlan.spentMinutes !== undefined)) {
    lines.push(
      `- ${t(lang, '今日学习时长', 'Daily Plan')}: ${Number(dailyPlan.spentMinutes) || 0} / ${Number(dailyPlan.budgetMinutes) || 0} ${t(lang, '分钟', 'min')}`,
    );
  }

  lines.push(
    '',
    `## ${t(lang, '核心指标 (KPI)', 'Key Metrics (KPI)')}`,
    '',
    `| ${t(lang, '指标', 'Metric')} | ${t(lang, '数值', 'Value')} |`,
    '| --- | ---: |',
    `| ${t(lang, '总题数 (Total Cards)', 'Total Cards')} | ${totalCards} |`,
    `| ${t(lang, '已掌握 (Mastered)', 'Mastered')} | ${mastered} |`,
    `| ${t(lang, '今日到期 (Due Today)', 'Due Today')} | ${dueTodayCount} |`,
    `| ${t(lang, '薄弱题 (Weak)', 'Weak')} | ${weakCount} |`,
    `| ${t(lang, '累计作答 (Attempts)', 'Attempts')} | ${attempts} |`,
    `| ${t(lang, '正确率 (Accuracy)', 'Accuracy')} | ${accStr} |`,
    `| ${t(lang, '活跃天数 (Active Days)', 'Active Days')} | ${activeDays} |`,
    `| ${t(lang, '连续学习 (Streak)', 'Streak')} | ${streak}${t(lang, ' 天', 'd')} |`,
  );

  const forecastDays = (stats?.forecast?.days ?? []).slice(0, 7);
  if (forecastDays.length > 0) {
    lines.push(
      '',
      `## ${t(lang, '未来 7 日复习预测', '7-Day Review Forecast')}`,
      '',
      `| ${t(lang, '日期', 'Date')} | ${t(lang, '待复习题数', 'Due Cards')} | ${t(lang, '逾期', 'Overdue')} |`,
      '| --- | ---: | ---: |',
    );
    for (let i = 0; i < forecastDays.length; i += 1) {
      const day = forecastDays[i];
      const dayLabel = `${escapeMdCell(day.date)} (${formatForecastLabel(day.date, i, lang)})`;
      lines.push(`| ${dayLabel} | ${Number(day.count) || 0} | ${Number(day.overdue) || 0} |`);
    }
  }

  const weakTopics = (stats?.weakTopics ?? []).slice(0, 15);
  lines.push('', `## ${t(lang, '薄弱知识点 (Top 15)', 'Weak Topics (Top 15)')}`, '');
  if (weakTopics.length > 0) {
    lines.push(
      `| # | ${t(lang, '课程', 'Course')} | ${t(lang, '题组', 'Deck')} | ${t(lang, '知识点', 'Topic')} | ${t(lang, '错题次数', 'Wrong')} | ${t(lang, '题目数', 'Cards')} |`,
      '| ---: | --- | --- | --- | ---: | ---: |',
    );
    weakTopics.forEach((wt, idx) => {
      lines.push(
        `| ${idx + 1} | ${escapeMdCell(wt.course || t(lang, '未分组', 'Uncategorized'))} | ${escapeMdCell(wt.deckTitle || wt.deckId)} | ${escapeMdCell(wt.topic)} | ${Number(wt.wrong) || 0} | ${wt.cards?.length ?? 0} |`,
      );
    });
  } else {
    lines.push(`_${t(lang, '暂无薄弱知识点记录。', 'No weak topics recorded.')}_`);
  }

  lines.push('', `## ${t(lang, '各课程掌握度', 'Per-Course Mastery')}`, '');
  if (courseRows.length > 0) {
    lines.push(
      `| ${t(lang, '课程', 'Course')} | ${t(lang, '掌握度', 'Mastery')} | ${t(lang, '总题数', 'Total Cards')} | ${t(lang, '今日到期', 'Due Today')} | ${t(lang, '薄弱题', 'Weak')} |`,
      '| --- | ---: | ---: | ---: | ---: |',
    );
    for (const row of courseRows) {
      lines.push(
        `| ${escapeMdCell(row.label)} | ${row.masteryPct}% | ${row.totalCards} | ${row.dueCount} | ${row.weakCount} |`,
      );
    }
  } else {
    lines.push(`_${t(lang, '暂无课程统计数据。', 'No course mastery data yet.')}_`);
  }

  const totalTokens = totalTokensOf(usage?.total);
  const totalCalls = Number(usage?.total?.calls ?? 0);
  const inputTokens = Number(usage?.total?.uncachedInputTokens ?? 0);
  const outputTokens = Number(usage?.total?.outputTokens ?? 0);
  const cacheRead = Number(usage?.total?.cacheReadTokens ?? 0);
  const cacheWrite = Number(usage?.total?.cacheWriteTokens ?? 0);

  lines.push(
    '',
    `## ${t(lang, `AI Token 用量汇总 (${usageDays}天)`, `AI Token Usage Summary (${usageDays}d)`)}`,
    '',
    `- ${t(lang, '统计窗口', 'Window')}: ${usageDays}${t(lang, ' 天', 'd')}`,
    `- ${t(lang, '调用次数', 'Calls')}: ${totalCalls}`,
    `- ${t(lang, '总 Token', 'Total Tokens')}: ${totalTokens} (${formatTokens(totalTokens)})`,
    `- ${t(lang, '明细 (输入 / 输出 / 缓存读 / 缓存写)', 'Breakdown (Input / Output / Cache Read / Cache Write)')}: ${inputTokens} / ${outputTokens} / ${cacheRead} / ${cacheWrite}`,
  );

  const featureEntries = Object.entries(usage?.byFeature ?? {});
  if (featureEntries.length > 0) {
    lines.push(
      '',
      `| ${t(lang, '功能模块', 'Feature')} | ${t(lang, '调用次数', 'Calls')} | ${t(lang, '总 Token', 'Tokens')} |`,
      '| --- | ---: | ---: |',
    );
    for (const [feature, totalsEntry] of featureEntries) {
      lines.push(
        `| ${escapeMdCell(feature)} | ${Number(totalsEntry?.calls ?? 0)} | ${totalTokensOf(totalsEntry)} |`,
      );
    }
  }

  lines.push('');
  return lines.join('\n');
}

interface KpiCardProps {
  label: string;
  value: string;
  sub?: string;
  tone?: 'primary' | 'success' | 'warning' | 'error' | 'accent' | 'info';
  width: number;
}

const KpiCard = memo(function KpiCard({ label, value, sub, tone = 'primary', width }: KpiCardProps) {
  const theme = useTheme();
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const color = theme[tone];
  const inner = Math.max(4, width - 4);
  const ell = asciiMode ? '...' : '…';
  return (
    <Box
      flexDirection="column"
      width={width}
      height={5}
      borderStyle={asciiMode ? 'classic' : 'round'}
      borderColor={theme.border}
      paddingX={1}
    >
      <Text color={theme.muted} wrap={asciiMode ? undefined : 'truncate'}>
        {truncateDisplay(label, inner, ell)}
      </Text>
      <Text color={color} bold wrap={asciiMode ? undefined : 'truncate'}>
        {truncateDisplay(value, inner, ell)}
      </Text>
      <Text color={theme.dim} wrap={asciiMode ? undefined : 'truncate'}>
        {truncateDisplay(sub ?? '', inner, ell)}
      </Text>
    </Box>
  );
});

export const DashboardView: React.FC<ViewProps> = ({ host, width, height, isActive }) => {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const snapshot = useTuiStore((s) => s.snapshot);
  const bindingRoot = useTuiStore((s) => s.binding?.root);
  const navigate = useTuiStore((s) => s.navigate);
  const notify = useTuiStore((s) => s.notify);
  const { refresh: refreshSnapshot } = useShellActions();

  const course = currentCourse(snapshot);
  const revision = snapshot?.revision ?? 0;

  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [usage, setUsage] = useState<UsageSummaryResponse | null>(null);
  const [usageDays, setUsageDays] = useState<UsageWindowDays>(30);
  const [dailyPlan, setDailyPlan] = useState<DailyPlanResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [filterQuery, setFilterQuery] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const [busyPractice, setBusyPractice] = useState(false);
  const [showForecast, setShowForecast] = useState(false);
  const [showMasteryTable, setShowMasteryTable] = useState(false);
  const [mapModalOpen, setMapModalOpen] = useState(false);

  const reqSeq = useRef(0);
  const usageSeq = useRef(0);
  const planSeq = useRef(0);
  const usageDaysRef = useRef<UsageWindowDays>(30);
  const busyRef = useRef(false);
  const exportBusyRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadDailyPlan = useCallback(async () => {
    const seq = ++planSeq.current;
    try {
      const planRes = await tryAction<DailyPlanResponse>(host, 'daily.plan.get', {
        date: todayLocalYmd(),
      });
      if (!mountedRef.current || planSeq.current !== seq) return;
      if (planRes.ok && planRes.value) setDailyPlan(planRes.value);
    } catch {
      // Non-blocking habit fetch: ignore if board/daily-plan is unavailable.
    }
  }, [host]);

  const loadData = useCallback(async () => {
    const seq = ++reqSeq.current;
    const uSeq = ++usageSeq.current;
    setLoading(true);
    setError(null);
    void loadDailyPlan();
    const [statsRes, usageRes] = await Promise.all([
      tryAction<StatsResponse>(host, 'stats', course ? { course } : {}),
      tryAction<UsageSummaryResponse>(host, 'usage.summary', { days: usageDaysRef.current }),
    ]);
    if (!mountedRef.current || reqSeq.current !== seq) return;
    if (statsRes.ok && statsRes.value) setStats(statsRes.value);
    else if (!statsRes.ok) setError(statsRes.error?.message || t(lang, '加载统计失败', 'Failed to load stats'));
    if (usageRes.ok && usageRes.value && usageSeq.current === uSeq) setUsage(usageRes.value);
    setLoading(false);
  }, [host, course, lang, loadDailyPlan]);

  useEffect(() => {
    void loadData();
  }, [loadData, revision]);

  const activeDecks = useMemo(() => {
    const decks = snapshot?.decks ?? [];
    return decks.filter((d) => !d.archived && (!course || d.course === course));
  }, [snapshot?.decks, course]);

  const fsrsBuckets = useMemo(() => {
    const progress = (snapshot?.progress ?? {}) as Record<string, DeckProgressEntry>;
    let newCount = 0;
    let learningCount = 0;
    let reviewCount = 0;
    let relearningCount = 0;
    let weightedSum = 0;
    let totalCards = 0;

    for (const deck of activeDecks) {
      const p = progress[deck.id];
      if (!p) continue;
      const c = p.counts ?? {};
      const nNew = Number(c.new) || 0;
      const nLearning = Number(c.learning) || 0;
      const nFamiliar = Number(c.familiar) || 0;
      const nMastered = Number(c.mastered) || 0;
      const nWeak = Number(c.weak) || 0;
      newCount += nNew;
      learningCount += nLearning;
      reviewCount += nFamiliar + nMastered;
      relearningCount += nWeak;
      const deckTotal = Number(p.total) || nNew + nLearning + nFamiliar + nMastered + nWeak;
      totalCards += deckTotal;
      weightedSum += (Number(p.mastery) || 0) * deckTotal;
    }

    const totalFromCounts = newCount + learningCount + reviewCount + relearningCount;
    const masteryPct =
      totalCards > 0
        ? Math.round(weightedSum / totalCards)
        : stats?.totals?.cards
          ? Math.round(((stats.totals.mastered ?? 0) / stats.totals.cards) * 100)
          : 0;

    return {
      newCount,
      learningCount,
      reviewCount,
      relearningCount,
      total: totalFromCounts,
      masteryPct,
    };
  }, [activeDecks, snapshot?.progress, stats?.totals]);

  const courseStats = useMemo(() => {
    const decks = (snapshot?.decks ?? []).filter((d) => !d.archived);
    const progress = (snapshot?.progress ?? {}) as Record<string, DeckProgressEntry>;
    const byCourse = new Map<
      string,
      { rawCourse: string; label: string; weighted: number; total: number; due: number; weak: number }
    >();

    for (const d of decks) {
      const p = progress[d.id];
      if (!p) continue;
      const rawCourse = d.course ?? '';
      const label = rawCourse || t(lang, '未分组', 'Uncategorized');
      const count = Number(p.total) || Number(d.cardCount) || 0;
      if (count <= 0) continue;
      const cur = byCourse.get(rawCourse) ?? { rawCourse, label, weighted: 0, total: 0, due: 0, weak: 0 };
      cur.weighted += (Number(p.mastery) || 0) * count;
      cur.total += count;
      cur.due += Number(p.due) || 0;
      cur.weak += Number(p.counts?.weak) || 0;
      byCourse.set(rawCourse, cur);
    }

    return [...byCourse.values()]
      .map((v) => ({
        rawCourse: v.rawCourse,
        label: v.label,
        masteryPct: v.total > 0 ? Math.round(v.weighted / v.total) : 0,
        totalCards: v.total,
        dueCount: v.due,
        weakCount: v.weak,
      }))
      .sort((a, b) => b.masteryPct - a.masteryPct);
  }, [snapshot?.decks, snapshot?.progress, lang]);

  const courseBars: BarChartItem[] = useMemo(
    () =>
      courseStats.slice(0, 6).map((c) => {
        const color = c.masteryPct >= 80 ? theme.success : c.masteryPct >= 50 ? theme.primary : theme.warning;
        return { label: `${c.label} (%)`, value: c.masteryPct, color };
      }),
    [courseStats, theme.success, theme.primary, theme.warning],
  );

  const weakTopics = useMemo(() => stats?.weakTopics ?? [], [stats?.weakTopics]);

  const drillItems: DrillItem[] = useMemo(() => {
    const items: DrillItem[] = weakTopics.map((wt, idx) => ({
      kind: 'weak',
      key: `weak:${wt.deckId}:${wt.topic}:${idx}`,
      course: wt.course,
      topic: wt.topic,
      wrong: wt.wrong,
      cardCount: wt.cards?.length ?? 0,
      cards: wt.cards ?? [],
    }));
    for (const c of courseStats) {
      items.push({
        kind: 'course',
        key: `course:${c.rawCourse || '__uncategorized__'}`,
        course: c.rawCourse,
        label: c.label,
        masteryPct: c.masteryPct,
        totalCards: c.totalCards,
        dueCount: c.dueCount,
        weakCount: c.weakCount,
      });
    }
    return items;
  }, [weakTopics, courseStats]);

  const filteredDrillItems = useMemo(
    () => filterDashboardDrillItems(drillItems, filterQuery),
    [drillItems, filterQuery],
  );

  useEffect(() => {
    if (selectedIdx >= filteredDrillItems.length) {
      setSelectedIdx(Math.max(0, filteredDrillItems.length - 1));
    }
  }, [filteredDrillItems.length, selectedIdx]);

  const startReviewWith = useCallback(
    async (args: Record<string, unknown>, failMsg: string) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusyPractice(true);
      const res = await tryAction<{ id?: string }>(host, 'review.start', args);
      busyRef.current = false;
      if (!mountedRef.current) return;
      setBusyPractice(false);
      if (!res.ok || !res.value?.id) {
        notify(res.error?.message || failMsg, 'error');
        return;
      }
      navigate('review', { runId: res.value.id });
    },
    [host, navigate, notify],
  );

  const startWeakPractice = useCallback(
    async (scope: Array<{ deckId: string; cardId: string }>, emptyMsg: string) => {
      if (!scope.length) {
        notify(emptyMsg, 'info');
        return;
      }
      await startReviewWith(
        { mode: 'path', scope, fresh: true },
        t(lang, '无法启动练习', 'Failed to start practice'),
      );
    },
    [lang, notify, startReviewWith],
  );

  const launchDrillItem = useCallback(
    (item: DrillItem | undefined) => {
      if (!item) return;
      if (item.kind === 'weak') {
        void startWeakPractice(
          item.cards,
          t(lang, '该薄弱点暂无可练题目', 'No cards in selected weak topic'),
        );
        return;
      }
      void startReviewWith(
        { mode: 'course', course: item.course, fresh: true },
        t(lang, '无法启动课程练习', 'Failed to start course practice'),
      );
    },
    [lang, startReviewWith, startWeakPractice],
  );

  const wide = width >= 96;
  const extraWide = width >= 110;

  const handleCycleUsageDays = useCallback(async () => {
    const nextDays: UsageWindowDays =
      usageDaysRef.current === 30 ? 90 : usageDaysRef.current === 90 ? 7 : 30;
    usageDaysRef.current = nextDays;
    setUsageDays(nextDays);
    const seq = ++usageSeq.current;
    const res = await tryAction<UsageSummaryResponse>(host, 'usage.summary', { days: nextDays });
    if (!mountedRef.current || usageSeq.current !== seq) return;
    if (res.ok && res.value) {
      setUsage(res.value);
      notify(
        t(lang, `AI 用量窗口: 最近 ${nextDays} 天`, `AI usage window: ${nextDays}d`),
        'info',
      );
    } else if (!res.ok) {
      notify(
        res.error?.message || t(lang, '加载 AI 用量失败', 'Failed to load AI usage'),
        'error',
      );
    }
  }, [host, lang, notify]);

  const handleExportReport = useCallback(async () => {
    if (exportBusyRef.current) return;
    exportBusyRef.current = true;
    try {
      const baseDir = bindingRoot || host.getLibraryRoot?.() || process.cwd();
      const defaultPath = defaultBackupFilePath(baseDir, 'studyhub-report', 'md', course || undefined);
      const markdown = formatDashboardMarkdownReport({
        stats,
        dailyPlan,
        usage,
        usageDays,
        courseRows: courseStats,
        focusCourse: course,
        lang,
        generatedAt: todayLocalYmd(),
      });
      const written = await atomicWriteExportText(defaultPath, markdown);
      if (!mountedRef.current) return;
      const arrow = asciiMode ? '->' : '→';
      notify(
        t(lang, `已导出报告 ${arrow} ${written.path}`, `Exported MD ${arrow} ${written.path}`),
        'success',
      );
    } catch (err) {
      if (!mountedRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      notify(t(lang, `导出报告失败: ${msg}`, `Failed to export report: ${msg}`), 'error');
    } finally {
      exportBusyRef.current = false;
    }
  }, [asciiMode, bindingRoot, course, courseStats, dailyPlan, host, lang, notify, stats, usage, usageDays]);

  const viewInputActive = isActive && !mapModalOpen;
  const claimedKeys = useMemo(() => ['j', 'k', 'p', 'w', 'f', 'm', 'd', 'x', '/', 'T'], []);
  useClaimKeys(claimedKeys, viewInputActive);
  useInputCapture(viewInputActive && filterOpen);

  const footerHints = useMemo(
    () => [
      { key: 'j/k', label: t(lang, '选择考点/课程', 'Select') },
      { key: 'Enter/p', label: t(lang, '立即练习', 'Practise') },
      { key: 'w', label: t(lang, '全部薄弱', 'All weak') },
      {
        key: 'f',
        label: extraWide
          ? t(lang, '切换预测', 'Forecast')
          : showForecast
            ? t(lang, '掌握度', 'Mastery')
            : t(lang, '7日预测', '7d Forecast'),
      },
      { key: 'm', label: t(lang, '知识地图', 'Map') },
      { key: 'd', label: t(lang, `用量:${usageDays}天`, `Usage:${usageDays}d`) },
      { key: 'x', label: t(lang, '导出报告', 'Export MD') },
      { key: 'Ctrl+R', label: t(lang, '刷新', 'Refresh') },
      { key: '/', label: t(lang, '筛选', 'Filter') },
    ],
    [lang, extraWide, showForecast, usageDays],
  );
  useFooterHints(footerHints, viewInputActive);

  useInput(
    (input, key) => {
      if (key.escape && filterQuery) {
        setFilterQuery('');
        setSelectedIdx(0);
        return true;
      }
      if (input === '/' && !key.ctrl && !key.meta) {
        setFilterOpen(true);
        setSelectedIdx(0);
        return;
      }
      if (input === 'm') {
        setMapModalOpen(true);
        return;
      }
      if (input === 'd') {
        void handleCycleUsageDays();
        return;
      }
      if (input === 'x') {
        void handleExportReport();
        return;
      }
      if (key.ctrl && input === 'r') {
        void refreshSnapshot().then(() => loadData());
        return;
      }
      if (input === 'f') {
        setShowForecast((prev) => !prev);
        return;
      }
      if (input === 'T') {
        setShowMasteryTable((prev) => !prev);
        return;
      }
      if (input === 'w') {
        const allWeak = stats?.weakScope ?? weakTopics.flatMap((wt) => wt.cards ?? []);
        void startWeakPractice(
          allWeak,
          t(lang, '暂无待强化薄弱题', 'No weak questions to practise'),
        );
        return;
      }
      if (input === 'p') {
        const idx = Math.min(selectedIdx, Math.max(0, filteredDrillItems.length - 1));
        launchDrillItem(filteredDrillItems[idx]);
      }
    },
    { isActive: viewInputActive && !filterOpen },
  );

  const totals = stats?.totals;
  const totalCards = totals?.cards ?? activeDecks.reduce((n, d) => n + (Number(d.cardCount) || 0), 0);
  const dueCount = totals?.due ?? dueToday(snapshot as StudySnapshot | null);
  const accuracy = totals?.recentRate ?? totals?.correctRate;
  const accuracyStr = accuracy !== null && accuracy !== undefined ? `${accuracy}%` : '--';
  const totalTokens = totalTokensOf(usage?.total);
  const totalCalls = Number(usage?.total?.calls ?? 0);

  const kpiGap = 1;
  const kpiW = Math.max(14, Math.floor((width - kpiGap * 4) / 5));

  const midH = wide ? 14 : 10;
  const forecastVisibleOnWide = extraWide && !showForecast;
  const forecastVisibleOnNarrow = !extraWide && showForecast;

  const leftW = forecastVisibleOnWide
    ? Math.max(34, Math.floor(width * 0.27))
    : wide
      ? Math.max(34, Math.floor(width * 0.44))
      : Math.min(28, Math.max(24, Math.floor(width * 0.42)));
  const forecastW = forecastVisibleOnWide ? Math.max(34, Math.floor(width * 0.30)) : 0;
  const rightW = forecastVisibleOnWide
    ? Math.max(28, width - leftW - forecastW - 2)
    : wide
      ? Math.max(30, width - leftW - 1)
      : Math.max(24, width - leftW - 1);

  const heatmapLines = useMemo(() => {
    const days = stats?.heatmap ?? [];
    return renderHeatmap(days, 12, theme, { locale: lang, showLabels: wide, ascii: asciiMode });
  }, [stats?.heatmap, theme, lang, wide, asciiMode]);

  const barChartLines = useMemo(() => {
    const innerW = Math.max(16, rightW - 4);
    return renderBarChart(courseBars, innerW, theme, { ascii: asciiMode });
  }, [courseBars, rightW, theme, asciiMode]);

  const forecastDays = useMemo(() => (stats?.forecast?.days ?? []).slice(0, 7), [stats?.forecast?.days]);
  const forecastSummary = useMemo(() => {
    const total7d = forecastDays.reduce((sum, d) => sum + (Number(d.count) || 0), 0);
    const overdue = Number(forecastDays[0]?.overdue) || 0;
    return { total7d, overdue };
  }, [forecastDays]);

  const forecastPanelWidth = forecastVisibleOnWide ? forecastW : rightW;
  const forecastLines = useMemo(() => {
    const innerW = Math.max(16, forecastPanelWidth - 4);
    const items: BarChartItem[] = forecastDays.map((d, i) => {
      const count = Number(d.count) || 0;
      const hasOverdue = i === 0 && (Number(d.overdue) || 0) > 0;
      const color = hasOverdue ? theme.error : count > 0 ? (i === 0 ? theme.warning : theme.primary) : theme.dim;
      return {
        label: formatForecastLabel(d.date, i, lang),
        value: count,
        color,
      };
    });
    return renderBarChart(items, innerW, theme, { ascii: asciiMode });
  }, [forecastDays, forecastPanelWidth, lang, theme, asciiMode]);

  const habitInfo = useMemo(() => {
    const p = dailyPlan?.profile;
    if (!p) return null;
    const hasObserved = p.observedWeekdayMinutes !== undefined || p.observedWeekendMinutes !== undefined;
    if (!hasObserved) return null;
    const wdStr = p.observedWeekdayMinutes !== undefined ? `${p.observedWeekdayMinutes}m` : '--';
    const weStr = p.observedWeekendMinutes !== undefined ? `${p.observedWeekendMinutes}m` : '--';
    return {
      full: t(lang, `习惯(实测): 工作日 ${wdStr} / 周末 ${weStr}`, `Habits (obs): Wkday ${wdStr} / Wkend ${weStr}`),
      compact: t(lang, `习惯 ${wdStr}/${weStr}`, `Habits ${wdStr}/${weStr}`),
    };
  }, [dailyPlan?.profile, lang]);

  const sep = asciiMode ? '  |  ' : '  │  ';
  const kpiCards = wide ? (
    <Box flexDirection="row" flexWrap="nowrap" gap={kpiGap} width={width} height={5} flexShrink={0}>
      <KpiCard
        label={t(lang, '总题数', 'Total Cards')}
        value={String(totalCards)}
        sub={t(lang, `${activeDecks.length} 个题组`, `${activeDecks.length} decks`)}
        tone="primary"
        width={kpiW}
      />
      <KpiCard
        label={t(lang, '平均掌握度', 'Mastery')}
        value={`${fsrsBuckets.masteryPct}%`}
        sub={t(lang, `已掌握 ${totals?.mastered ?? 0}`, `${totals?.mastered ?? 0} mastered`)}
        tone="success"
        width={kpiW}
      />
      <KpiCard
        label={t(lang, '今日到期', 'Due Today')}
        value={String(dueCount)}
        sub={t(lang, `薄弱 ${totals?.weak ?? 0} 题`, `${totals?.weak ?? 0} weak`)}
        tone={dueCount > 0 ? 'warning' : 'success'}
        width={kpiW}
      />
      <KpiCard
        label={t(lang, '正确率 (30天)', 'Accuracy (30d)')}
        value={accuracyStr}
        sub={t(lang, `连续 ${totals?.streak ?? 0} 天`, `${totals?.streak ?? 0}d streak`)}
        tone="accent"
        width={kpiW}
      />
      <KpiCard
        label={t(lang, 'Token / 调用', 'Tokens / Calls')}
        value={formatTokens(totalTokens)}
        sub={t(lang, `${totalCalls} 次 (${usageDays}天)`, `${totalCalls} calls (${usageDays}d)`)}
        tone="info"
        width={kpiW}
      />
    </Box>
  ) : (
    <Box
      flexDirection="column"
      width={width}
      height={4}
      flexShrink={0}
      borderStyle={asciiMode ? 'classic' : 'round'}
      borderColor={theme.border}
      paddingX={1}
      overflow="hidden"
    >
      <Text wrap="truncate">
        <Text color={theme.muted}>{t(lang, '总题数 ', 'Cards ')}</Text>
        <Text color={theme.primary} bold>{String(totalCards)}</Text>
        <Text color={theme.dim}>{` (${activeDecks.length}${t(lang, '组', 'd')})${sep}`}</Text>
        <Text color={theme.muted}>{t(lang, '掌握 ', 'Mastery ')}</Text>
        <Text color={theme.success} bold>{`${fsrsBuckets.masteryPct}%`}</Text>
        <Text color={theme.dim}>{sep}</Text>
        <Text color={theme.muted}>{t(lang, '到期 ', 'Due ')}</Text>
        <Text color={dueCount > 0 ? theme.warning : theme.success} bold>{String(dueCount)}</Text>
      </Text>
      <Text wrap="truncate">
        <Text color={theme.muted}>{t(lang, '正确率 ', 'Acc ')}</Text>
        <Text color={theme.accent} bold>{accuracyStr}</Text>
        <Text color={theme.dim}>{t(lang, ` (连续${totals?.streak ?? 0}天)${sep}`, ` (${totals?.streak ?? 0}d)${sep}`)}</Text>
        <Text color={theme.muted}>{t(lang, '用量 ', 'Usage ')}</Text>
        <Text color={theme.info} bold>{formatTokens(totalTokens)}</Text>
        <Text color={theme.dim}>{t(lang, ` (${totalCalls}次/${usageDays}天)`, ` (${totalCalls}/${usageDays}d)`)}</Text>
      </Text>
    </Box>
  );

  const fsrsRows = useMemo(() => {
    const total = Math.max(1, fsrsBuckets.total);
    const labelW = wide ? 14 : 11;
    const barW = Math.max(8, rightW - labelW - 12);
    const items = [
      { label: wide ? t(lang, '新题 New', 'New') : t(lang, '新题', 'New'), count: fsrsBuckets.newCount, color: theme.info },
      { label: wide ? t(lang, '学习 Learning', 'Learning') : t(lang, '学习', 'Learn'), count: fsrsBuckets.learningCount, color: theme.warning },
      { label: wide ? t(lang, '复习 Review', 'Review') : t(lang, '复习', 'Review'), count: fsrsBuckets.reviewCount, color: theme.success },
      { label: wide ? t(lang, '重学 Relearn', 'Relearn') : t(lang, '重学', 'Relearn'), count: fsrsBuckets.relearningCount, color: theme.error },
    ];
    return items.map((it) => ({
      ...it,
      labelW,
      bar: renderProgressBar(fsrsBuckets.total > 0 ? it.count / total : 0, barW, theme, {
        style: 'block',
        showPercent: true,
        color: it.color,
        ascii: asciiMode,
      }),
    }));
  }, [fsrsBuckets, lang, rightW, theme, wide, asciiMode]);

  const kpiRowsHeight = wide ? 5 : 4;
  const middleSectionH = midH;
  const drillListPanelH = Math.max(5, height - 1 - kpiRowsHeight - middleSectionH);
  const drillListRows = Math.max(1, drillListPanelH - 2 - (filterOpen ? 1 : 0));

  const renderDrillRow = useCallback(
    (item: DrillItem, ctx: VirtualListRenderContext) => {
      const marker = ctx.selected ? (asciiMode ? '>' : '❯') : ' ';
      const ell = asciiMode ? '...' : '…';
      const sepDot = asciiMode ? ' / ' : ' · ';

      if (item.kind === 'weak') {
        const tag = item.course ? `[${item.course}] ` : '';
        const badge = t(lang, '[薄弱]', '[WEAK]');
        const countLabel = t(
          lang,
          `错 ${item.wrong} 次${sepDot}${item.cardCount} 题`,
          `${item.wrong} wrong${sepDot}${item.cardCount} cards`,
        );
        const countW = displayWidth(countLabel);
        const titleW = Math.max(6, ctx.width - countW - 4);
        const left = truncateDisplay(`${marker} ${badge} ${tag}${item.topic}`, titleW, ell);
        return (
          <Box width={ctx.width} height={1}>
            <Text color={ctx.selected ? theme.selectionFg : theme.text} bold={ctx.selected}>
              {padDisplay(left, titleW + 2)}
            </Text>
            <Text color={ctx.selected ? theme.warning : theme.error}>
              {padDisplay(countLabel, countW + 2, 'right')}
            </Text>
          </Box>
        );
      }

      const badge = t(lang, '[课程]', '[COURSE]');
      const metaLabel =
        ctx.width >= 68
          ? t(
              lang,
              `掌握 ${item.masteryPct}%${sepDot}到期 ${item.dueCount}${sepDot}${item.totalCards} 题`,
              `${item.masteryPct}% mastery${sepDot}${item.dueCount} due${sepDot}${item.totalCards} cards`,
            )
          : `${item.masteryPct}%${sepDot}${item.dueCount}${t(lang, '到', 'd')}${sepDot}${item.totalCards}${t(lang, '题', 'c')}`;
      const metaW = displayWidth(metaLabel);
      const titleW = Math.max(6, ctx.width - metaW - 4);
      const left = truncateDisplay(`${marker} ${badge} ${item.label}`, titleW, ell);
      const toneColor = ctx.selected
        ? theme.warning
        : item.masteryPct >= 80
          ? theme.success
          : item.masteryPct >= 50
            ? theme.primary
            : theme.warning;
      return (
        <Box width={ctx.width} height={1}>
          <Text color={ctx.selected ? theme.selectionFg : theme.text} bold={ctx.selected}>
            {padDisplay(left, titleW + 2)}
          </Text>
          <Text color={toneColor}>
            {padDisplay(metaLabel, metaW + 2, 'right')}
          </Text>
        </Box>
      );
    },
    [asciiMode, lang, theme.error, theme.primary, theme.selectionFg, theme.success, theme.text, theme.warning],
  );

  const forecastSubtitle =
    forecastSummary.overdue > 0
      ? t(lang, `7天 ${forecastSummary.total7d}题 (逾期${forecastSummary.overdue})`, `7d: ${forecastSummary.total7d} (${forecastSummary.overdue} overdue)`)
      : t(lang, `7天共 ${forecastSummary.total7d} 题`, `7d: ${forecastSummary.total7d}`);

  const renderForecastBody = (panelW: number) => (
    <>
      {forecastLines.length > 0 ? (
        forecastLines.slice(0, 7).map((line, i) => (
          <Text key={`fc-${i}`} wrap="truncate">
            {line}
          </Text>
        ))
      ) : (
        <Text color={theme.muted} wrap="truncate">
          {t(lang, '暂无未来 7 天到期预测', 'No 7-day forecast data yet')}
        </Text>
      )}
      {habitInfo ? (
        <Box marginTop={wide ? 1 : 0} height={1} overflow="hidden">
          <Text color={theme.info} wrap="truncate">
            {truncateDisplay(panelW >= 40 ? habitInfo.full : habitInfo.compact, Math.max(10, panelW - 4), asciiMode ? '...' : '…')}
          </Text>
        </Box>
      ) : null}
    </>
  );

  const titleIcon = asciiMode ? '[=]' : '▥';
  const titleSep = asciiMode ? ' - ' : ' · ';
  const titleLeft = `${titleIcon} ${t(lang, '学习统计与掌握度', 'Study Analytics & Mastery')}`;
  const titleCourse = course ? `${titleSep}${course}` : t(lang, `${titleSep}全部课程`, `${titleSep}All Courses`);
  const habitHeaderWidth = Math.max(0, width - displayWidth(titleLeft) - displayWidth(titleCourse) - 2);

  const innerPanelW = Math.max(10, width - 4);
  const trimmedFilter = filterQuery.trim();
  const hasActiveFilter = trimmedFilter.length > 0;
  const drillSepDot = asciiMode ? ' / ' : ' · ';
  const ell = asciiMode ? '...' : '…';
  const drillPanelBadge = hasActiveFilter
    ? `${filteredDrillItems.length}/${drillItems.length}`
    : weakTopics.length > 0
      ? weakTopics.length
      : drillItems.length;
  const drillPanelBadgeTone = hasActiveFilter
    ? filteredDrillItems.length > 0
      ? 'info'
      : 'warning'
    : weakTopics.length > 0
      ? 'warning'
      : 'success';
  const drillPanelSubtitle = hasActiveFilter
    ? t(
        lang,
        `筛选: ${trimmedFilter} (${filteredDrillItems.length}/${drillItems.length})`,
        `Filter: ${trimmedFilter} (${filteredDrillItems.length}/${drillItems.length})`,
      )
    : weakTopics.length > 0
      ? t(
          lang,
          `薄弱 ${weakTopics.length}${drillSepDot}课程 ${courseStats.length}`,
          `${weakTopics.length} weak${drillSepDot}${courseStats.length} courses`,
        )
      : undefined;
  const filterBarBadge = `[${t(lang, '筛选', 'Filter')} ${filteredDrillItems.length}/${drillItems.length}] `;
  const filterBarHint =
    innerPanelW >= 62
      ? ` ${t(lang, 'Enter 确认 | Esc 清除', 'Enter apply | Esc clear')}`
      : innerPanelW >= 44
        ? ' Enter/Esc'
        : '';
  const filterInputW = Math.max(8, innerPanelW - displayWidth(filterBarBadge) - displayWidth(filterBarHint) - 3);

  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      <Box flexDirection="row" justifyContent="space-between" height={1} flexShrink={0}>
        <Text wrap="truncate">
          <Text color={theme.primary} bold>
            {titleLeft}
          </Text>
          <Text color={theme.muted}>
            {titleCourse}
          </Text>
        </Text>
        {loading || busyPractice ? (
          <Spinner label={busyPractice ? t(lang, '准备练习...', 'Starting...') : t(lang, '加载中...', 'Loading...')} active={isActive && !mapModalOpen} />
        ) : habitInfo && habitHeaderWidth >= 14 ? (
          <Text color={theme.info} wrap="truncate">
            {truncateDisplay(habitHeaderWidth >= 34 ? habitInfo.full : habitInfo.compact, habitHeaderWidth, asciiMode ? '...' : '…')}
          </Text>
        ) : null}
      </Box>

      {kpiCards}

      {error && !stats ? (
        <Panel tone="error" title={t(lang, '错误', 'Error')} width={width}>
          <Text color={theme.error}>{error}</Text>
        </Panel>
      ) : null}

      <Box flexDirection="row" gap={1} width={width} height={midH} flexShrink={0}>
        <Panel
          title={wide ? t(lang, '12 周学习热力图', '12-Week Activity') : t(lang, '12周热力', 'Activity')}
          subtitle={wide ? t(lang, `活跃 ${totals?.activeDays ?? 0} 天`, `${totals?.activeDays ?? 0} active days`) : undefined}
          width={leftW}
          height={midH}
        >
          {heatmapLines.map((line, idx) => (
            <Text key={idx} wrap="truncate">
              {line}
            </Text>
          ))}
        </Panel>

        {forecastVisibleOnNarrow ? (
          <Panel
            title={t(lang, '7 日到期预测', '7-Day Forecast')}
            subtitle={forecastSubtitle}
            width={rightW}
            height={midH}
          >
            {renderForecastBody(rightW)}
          </Panel>
        ) : (
          <Panel
            title={
              showMasteryTable
                ? wide
                  ? t(lang, '课程掌握度统计表 [T]图表', 'Course Mastery Table [T]Bars')
                  : t(lang, '掌握度表 [T]', 'Table [T]')
                : wide
                  ? t(lang, '课程掌握度与 FSRS 分布', 'Course Mastery & FSRS States')
                  : t(lang, '掌握度 & FSRS', 'Mastery & FSRS')
            }
            subtitle={!extraWide ? `[f] ${t(lang, '预测', 'Forecast')}` : `[T] ${showMasteryTable ? t(lang, '柱图', 'Bars') : t(lang, '表格', 'Table')}`}
            width={rightW}
            height={midH}
          >
            {showMasteryTable ? (
              courseStats.length > 0 ? (
                renderStatTable(
                  [
                    { key: 'course', label: t(lang, '课程', 'Course'), align: 'left' },
                    { key: 'total', label: t(lang, '题数', 'Cards'), align: 'right', minWidth: 4 },
                    { key: 'due', label: t(lang, '到期', 'Due'), align: 'right', minWidth: 4 },
                    { key: 'mastery', label: t(lang, '掌握', 'Mast'), align: 'right', minWidth: 5 },
                  ],
                  courseStats.slice(0, Math.max(2, midH - 4)).map((c) => ({
                    course: c.label,
                    total: c.totalCards,
                    due: c.dueCount,
                    mastery: `${c.masteryPct}%`,
                  })),
                  Math.max(18, rightW - 4),
                  theme,
                  { ascii: asciiMode },
                ).map((line, i) => (
                  <Text key={`tbl-${i}`} wrap="truncate">
                    {line}
                  </Text>
                ))
              ) : (
                <Text color={theme.muted} wrap="truncate">
                  {t(lang, '暂无课程掌握度数据', 'No course mastery data yet')}
                </Text>
              )
            ) : (
              <>
                {barChartLines.length > 0 ? (
                  barChartLines.slice(0, wide ? 6 : 3).map((line, i) => (
                    <Text key={`bar-${i}`} wrap="truncate">
                      {line}
                    </Text>
                  ))
                ) : (
                  <Text color={theme.muted} wrap="truncate">
                    {t(lang, '暂无课程掌握度数据', 'No course mastery data yet')}
                  </Text>
                )}
                <Box marginTop={wide ? 1 : 0} flexDirection="column">
                  {fsrsRows.map((row) => (
                    <Box key={row.label} flexDirection="row" height={1}>
                      <Text color={theme.muted}>{padDisplay(row.label, row.labelW)}</Text>
                      <Text>{row.bar}</Text>
                      <Text color={theme.dim}>{` (${row.count})`}</Text>
                    </Box>
                  ))}
                </Box>
              </>
            )}
          </Panel>
        )}

        {forecastVisibleOnWide ? (
          <Panel
            title={t(lang, '7 日到期预测', '7-Day Forecast')}
            subtitle={forecastSubtitle}
            width={forecastW}
            height={midH}
          >
            {renderForecastBody(forecastW)}
          </Panel>
        ) : null}
      </Box>

      <Panel
        title={t(lang, '薄弱点与课程钻取 (Enter/p 立即练习)', 'Weak Topics & Courses (Enter/p Practise)')}
        badge={drillPanelBadge}
        badgeTone={drillPanelBadgeTone}
        subtitle={drillPanelSubtitle}
        focused={viewInputActive}
        width={width}
        height={drillListPanelH}
      >
        {filterOpen ? (
          <Box height={1} width={innerPanelW} backgroundColor={theme.surface} overflow="hidden">
            <Text color={theme.primary} bold>
              {filterBarBadge}
            </Text>
            <Box flexGrow={1} overflow="hidden">
              <TextInput
                value={filterQuery}
                onChange={(next) => {
                  setFilterQuery(next);
                  setSelectedIdx(0);
                }}
                onSubmit={(val) => {
                  if (!val.trim()) setFilterQuery('');
                  setFilterOpen(false);
                }}
                onCancel={() => {
                  setFilterQuery('');
                  setFilterOpen(false);
                  setSelectedIdx(0);
                }}
                isActive={viewInputActive && filterOpen}
                width={filterInputW}
                prompt="/"
                placeholder={t(lang, `知识点/课程${ell}`, `topic/course${ell}`)}
                maxLength={120}
              />
            </Box>
            {filterBarHint ? (
              <Text color={theme.dim} wrap="truncate">
                {filterBarHint}
              </Text>
            ) : null}
          </Box>
        ) : null}
        {drillItems.length === 0 ? (
          <EmptyState
            icon={asciiMode ? '+' : '✓'}
            title={t(lang, '暂无薄弱点或课程题组', 'No weak topics or courses')}
            hint={t(lang, '继续保持每日 FSRS 间隔复习', 'Keep up your daily FSRS reviews')}
            height={drillListRows}
          />
        ) : filteredDrillItems.length === 0 ? (
          drillListRows >= 4 ? (
            <EmptyState
              icon={asciiMode ? '?' : '⌕'}
              title={t(lang, `没有匹配「${trimmedFilter}」的薄弱点或课程`, `No topics or courses matching "${trimmedFilter}"`)}
              hint={t(lang, '按 Esc 清除筛选条件', 'Press Esc to clear filter')}
              height={drillListRows}
            />
          ) : (
            <Box height={drillListRows} width={innerPanelW} alignItems="center" justifyContent="center" overflow="hidden">
              <Text color={theme.muted} wrap="truncate">
                {truncateDisplay(
                  t(
                    lang,
                    `没有匹配「${trimmedFilter}」的薄弱点或课程 (Esc 清除)`,
                    `No topics or courses matching "${trimmedFilter}" (Esc clear)`,
                  ),
                  innerPanelW,
                  ell,
                )}
              </Text>
            </Box>
          )
        ) : (
          <VirtualList
            items={filteredDrillItems}
            height={drillListRows}
            width={innerPanelW}
            selectedIndex={selectedIdx}
            onChange={(idx) => setSelectedIdx(idx)}
            onSelect={(item) => launchDrillItem(item)}
            renderItem={renderDrillRow}
            keyExtractor={(item) => item.key}
            isActive={viewInputActive && !filterOpen}
          />
        )}
      </Panel>

      <Suspense fallback={null}>
        {mapModalOpen ? (
          <StudyMapModal
            host={host}
            width={width}
            height={height}
            isActive={isActive && mapModalOpen}
            onClose={() => setMapModalOpen(false)}
          />
        ) : null}
      </Suspense>
    </Box>
  );
};
