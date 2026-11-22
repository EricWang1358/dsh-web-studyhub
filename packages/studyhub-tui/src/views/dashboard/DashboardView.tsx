import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { StudySnapshot, ViewProps } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { tryAction } from '../../host/index.js';
import { currentCourse, dueToday, useShellActions } from '../../shell/index.js';
import {
  EmptyState,
  Panel,
  Spinner,
  VirtualList,
  useClaimKeys,
  useFooterHints,
  useTheme,
  type VirtualListRenderContext,
} from '../../components/index.js';
import {
  displayWidth,
  padDisplay,
  renderBarChart,
  renderHeatmap,
  renderProgressBar,
  truncateDisplay,
  type BarChartItem,
  type HeatmapDay,
} from '../../render/index.js';

interface WeakTopicRow {
  deckId: string;
  deckTitle: string;
  course: string;
  topic: string;
  wrong: number;
  lastAt: string;
  cards: Array<{ deckId: string; cardId: string }>;
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
  counts?: {
    new?: number;
    weak?: number;
    learning?: number;
    familiar?: number;
    mastered?: number;
  };
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
  return (
    <Box
      flexDirection="column"
      width={width}
      height={5}
      borderStyle={asciiMode ? 'classic' : 'round'}
      borderColor={theme.border}
      paddingX={1}
    >
      <Text color={theme.muted} wrap="truncate">
        {truncateDisplay(label, inner)}
      </Text>
      <Text color={color} bold wrap="truncate">
        {truncateDisplay(value, inner)}
      </Text>
      <Text color={theme.dim} wrap="truncate">
        {truncateDisplay(sub ?? '', inner)}
      </Text>
    </Box>
  );
});

export const DashboardView: React.FC<ViewProps> = ({ host, width, height, isActive }) => {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const snapshot = useTuiStore((s) => s.snapshot);
  const navigate = useTuiStore((s) => s.navigate);
  const notify = useTuiStore((s) => s.notify);
  const { refresh: refreshSnapshot } = useShellActions();

  const course = currentCourse(snapshot);
  const revision = snapshot?.revision ?? 0;

  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [usage, setUsage] = useState<UsageSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedWeakIdx, setSelectedWeakIdx] = useState(0);
  const [busyPractice, setBusyPractice] = useState(false);

  const reqSeq = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadData = useCallback(async () => {
    const seq = ++reqSeq.current;
    setLoading(true);
    setError(null);
    const [statsRes, usageRes] = await Promise.all([
      tryAction<StatsResponse>(host, 'stats', course ? { course } : {}),
      tryAction<UsageSummaryResponse>(host, 'usage.summary', { days: 30 }),
    ]);
    if (!mountedRef.current || reqSeq.current !== seq) return;
    if (statsRes.ok && statsRes.value) setStats(statsRes.value);
    else if (!statsRes.ok) setError(statsRes.error?.message || t(lang, '加载统计失败', 'Failed to load stats'));
    if (usageRes.ok && usageRes.value) setUsage(usageRes.value);
    setLoading(false);
  }, [host, course, lang]);

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

  const courseBars: BarChartItem[] = useMemo(() => {
    const decks = (snapshot?.decks ?? []).filter((d) => !d.archived);
    const progress = (snapshot?.progress ?? {}) as Record<string, DeckProgressEntry>;
    const byCourse = new Map<string, { weighted: number; total: number }>();

    for (const d of decks) {
      const p = progress[d.id];
      if (!p) continue;
      const label = d.course || t(lang, '未分组', 'Uncategorized');
      const count = Number(p.total) || Number(d.cardCount) || 0;
      if (count <= 0) continue;
      const cur = byCourse.get(label) ?? { weighted: 0, total: 0 };
      cur.weighted += (Number(p.mastery) || 0) * count;
      cur.total += count;
      byCourse.set(label, cur);
    }

    return [...byCourse.entries()]
      .map(([label, v]) => {
        const pct = v.total > 0 ? Math.round(v.weighted / v.total) : 0;
        const color = pct >= 80 ? theme.success : pct >= 50 ? theme.primary : theme.warning;
        return { label: `${label} (%)`, value: pct, color };
      })
      .sort((a, b) => b.value - a.value)
      .slice(0, 6);
  }, [snapshot?.decks, snapshot?.progress, lang, theme.success, theme.primary, theme.warning]);

  const weakTopics = useMemo(() => stats?.weakTopics ?? [], [stats?.weakTopics]);

  useEffect(() => {
    if (selectedWeakIdx >= weakTopics.length) {
      setSelectedWeakIdx(Math.max(0, weakTopics.length - 1));
    }
  }, [weakTopics.length, selectedWeakIdx]);

  const startWeakPractice = useCallback(
    async (scope: Array<{ deckId: string; cardId: string }>, emptyMsg: string) => {
      if (busyPractice) return;
      if (!scope.length) {
        notify(emptyMsg, 'info');
        return;
      }
      setBusyPractice(true);
      const res = await tryAction<{ id?: string }>(host, 'review.start', {
        mode: 'path',
        scope,
        fresh: true,
      });
      if (!mountedRef.current) return;
      setBusyPractice(false);
      if (!res.ok || !res.value?.id) {
        notify(res.error?.message || t(lang, '无法启动练习', 'Failed to start practice'), 'error');
        return;
      }
      navigate('review', { runId: res.value.id });
    },
    [busyPractice, host, lang, navigate, notify],
  );

  const claimedKeys = useMemo(() => ['j', 'k', 'r', 'p', 'w'], []);
  useClaimKeys(claimedKeys, isActive);

  const footerHints = useMemo(
    () => [
      { key: 'j/k', label: t(lang, '选择薄弱点', 'Select topic') },
      { key: 'Enter/p', label: t(lang, '练习该考点', 'Practise topic') },
      { key: 'w', label: t(lang, '练全部薄弱题', 'Practise all weak') },
      { key: 'r', label: t(lang, '刷新', 'Refresh') },
    ],
    [lang],
  );
  useFooterHints(footerHints, isActive);

  useInput(
    (input, key) => {
      if (input === 'r') {
        void refreshSnapshot().then(() => loadData());
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
      if (key.return || input === 'p') {
        const row = weakTopics[selectedWeakIdx];
        if (!row) return;
        void startWeakPractice(
          row.cards ?? [],
          t(lang, '该薄弱点暂无可练题目', 'No cards in selected weak topic'),
        );
      }
    },
    { isActive },
  );

  const totals = stats?.totals;
  const totalCards = totals?.cards ?? activeDecks.reduce((n, d) => n + (Number(d.cardCount) || 0), 0);
  const dueCount = totals?.due ?? dueToday(snapshot as StudySnapshot | null);
  const accuracy = totals?.recentRate ?? totals?.correctRate;
  const accuracyStr = accuracy !== null && accuracy !== undefined ? `${accuracy}%` : '--';
  const totalTokens = totalTokensOf(usage?.total);
  const totalCalls = Number(usage?.total?.calls ?? 0);

  const wide = width >= 96;
  const kpiGap = 1;
  const kpiW = Math.max(14, Math.floor((width - kpiGap * 4) / 5));

  const midH = wide ? 14 : 10;
  const leftW = wide ? Math.max(34, Math.floor(width * 0.44)) : Math.min(28, Math.max(24, Math.floor(width * 0.42)));
  const rightW = wide ? Math.max(30, width - leftW - 1) : Math.max(24, width - leftW - 1);

  const heatmapLines = useMemo(() => {
    const days = stats?.heatmap ?? [];
    return renderHeatmap(days, 12, theme, { locale: lang, showLabels: wide, ascii: asciiMode });
  }, [stats?.heatmap, theme, lang, wide, asciiMode]);

  const barChartLines = useMemo(() => {
    const innerW = Math.max(16, rightW - 4);
    return renderBarChart(courseBars, innerW, theme, { ascii: asciiMode });
  }, [courseBars, rightW, theme, asciiMode]);

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
        sub={t(lang, `${totalCalls} 次 (30天)`, `${totalCalls} calls (30d)`)}
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
        <Text color={theme.dim}>{` (${activeDecks.length}组)${sep}`}</Text>
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
        <Text color={theme.dim}>{t(lang, ` (${totalCalls}次)`, ` (${totalCalls})`)}</Text>
      </Text>
    </Box>
  );

  const fsrsRows = useMemo(() => {
    const total = Math.max(1, fsrsBuckets.total);
    const labelW = wide ? 14 : 11;
    const barW = Math.max(8, rightW - labelW - 10);
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
  const weakListPanelH = Math.max(5, height - 1 - kpiRowsHeight - middleSectionH);
  const weakListRows = Math.max(1, weakListPanelH - 2);

  const renderWeakRow = useCallback(
    (item: WeakTopicRow, ctx: VirtualListRenderContext) => {
      const tag = item.course ? `[${item.course}] ` : '';
      const countLabel = t(lang, `错 ${item.wrong} 次 · ${item.cards?.length ?? 0} 题`, `${item.wrong} wrong · ${item.cards?.length ?? 0} cards`);
      const countW = displayWidth(countLabel);
      const titleW = Math.max(6, ctx.width - countW - 4);
      const left = truncateDisplay(`${ctx.selected ? '❯' : ' '} ${tag}${item.topic}`, titleW);
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
    },
    [lang, theme.error, theme.selectionFg, theme.text, theme.warning],
  );

  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      <Box flexDirection="row" justifyContent="space-between" height={1} flexShrink={0}>
        <Text wrap="truncate">
          <Text color={theme.primary} bold>
            {t(lang, '▥ 学习统计与掌握度', '▥ Study Analytics & Mastery')}
          </Text>
          <Text color={theme.muted}>
            {course ? ` · ${course}` : t(lang, ' · 全部课程', ' · All Courses')}
          </Text>
        </Text>
        {loading || busyPractice ? <Spinner label={busyPractice ? t(lang, '准备练习…', 'Starting…') : t(lang, '加载中…', 'Loading…')} active={isActive} /> : null}
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

        <Panel
          title={wide ? t(lang, '课程掌握度与 FSRS 分布', 'Course Mastery & FSRS States') : t(lang, '掌握度 & FSRS', 'Mastery & FSRS')}
          width={rightW}
          height={midH}
        >
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
        </Panel>
      </Box>

      <Panel
        title={t(lang, '薄弱知识点 (Enter 立即针对练习)', 'Weak Topics (Enter to Practise)')}
        badge={weakTopics.length}
        badgeTone={weakTopics.length > 0 ? 'warning' : 'success'}
        focused={isActive}
        width={width}
        height={weakListPanelH}
      >
        {weakTopics.length === 0 ? (
          <EmptyState
            icon="✓"
            title={t(lang, '暂无明显薄弱知识点', 'No weak topics detected')}
            hint={t(lang, '继续保持每日 FSRS 间隔复习', 'Keep up your daily FSRS reviews')}
            height={weakListRows}
          />
        ) : (
          <VirtualList
            items={weakTopics}
            height={weakListRows}
            width={Math.max(10, width - 4)}
            selectedIndex={selectedWeakIdx}
            onChange={(idx) => setSelectedWeakIdx(idx)}
            onSelect={(item) => {
              void startWeakPractice(
                item.cards ?? [],
                t(lang, '该薄弱点暂无可练题目', 'No cards in selected weak topic'),
              );
            }}
            renderItem={renderWeakRow}
            keyExtractor={(item, idx) => `${item.deckId}:${item.topic}:${idx}`}
            isActive={isActive}
          />
        )}
      </Panel>
    </Box>
  );
};
