/**
 * Single Source of Truth for Dashboard derived metrics (#1354 D10).
 *
 * Pure TypeScript (zero React, Ink, or Node I/O imports) extracting streak, daily active/attempt
 * counts, 7-day forecast queue depth, token usage totals, and daily study habit metrics from
 * `DashboardView.tsx` so live KPIs, panels, and Markdown exports always read the exact same values.
 */

import { todayLocalYmd } from './primitives.js';

export interface DashboardHeatmapEntry {
  date: string;
  count: number;
}

export interface DashboardForecastDay {
  date: string;
  count: number;
  overdue?: number;
}

export interface DashboardTotalsLike {
  attempts?: number;
  activeDays?: number;
  streak?: number;
  correctRate?: number | null;
  recentRate?: number | null;
  cards?: number;
  due?: number;
  mastered?: number;
  weak?: number;
}

export interface DashboardStatsLike {
  today?: string;
  totals?: DashboardTotalsLike;
  heatmap?: ReadonlyArray<DashboardHeatmapEntry>;
  forecast?: {
    days?: ReadonlyArray<DashboardForecastDay>;
  };
}

/**
 * Study counts that stand in for backend `stats.totals` when it is missing: the focus course's (or the whole
 * library's) `selectStudySummary` result, which already leaves out parked sub-courses, system decks and suspended cards.
 */
export interface DashboardKpiFallback {
  totalCards: number;
  due: number;
  weak: number;
  mastered: number;
}

export interface DashboardKpis {
  totalCards: number;
  mastered: number;
  due: number;
  weak: number;
  attempts: number;
  accuracyLabel: string;
  activeDays: number;
  streak: number;
}

export interface ForecastQueueDepth {
  days: DashboardForecastDay[];
  total7d: number;
  overdue: number;
  hasOverdue: boolean;
}

export interface UsageTotalsLike {
  calls?: number;
  uncachedInputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface UsageSummaryLike {
  total?: UsageTotalsLike | null;
}

export interface UsageMetrics {
  totalTokens: number;
  totalCalls: number;
  uncachedInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface DailyPlanLike {
  budgetMinutes?: number;
  spentMinutes?: number;
  profile?: {
    observedWeekdayMinutes?: number;
    observedWeekendMinutes?: number;
  };
}

export interface DailyHabitMetrics {
  hasDailyBudget: boolean;
  budgetMinutes: number;
  spentMinutes: number;
  hasObservedHabits: boolean;
  observedWeekdayMinutes: number | null;
  observedWeekendMinutes: number | null;
}

function finiteNonNeg(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function shiftYmd(ymd: string, deltaDays: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!m) return '';
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + deltaDays));
  const y = dt.getUTCFullYear();
  const mo = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

/**
 * Derive consecutive-day study streak from heatmap entries, matching `lib/insights.js` 1:1:
 * today may not have started yet (`i === 0` with count 0 continues to yesterday).
 */
export function selectStreakFromHeatmap(
  heatmap: ReadonlyArray<DashboardHeatmapEntry> | null | undefined,
  todayYmd?: string,
): number {
  if (!Array.isArray(heatmap) || heatmap.length === 0) return 0;
  const activeDates = new Set<string>();
  for (const entry of heatmap) {
    if (!entry || typeof entry.date !== 'string') continue;
    if ((Number(entry.count) || 0) > 0) activeDates.add(entry.date.trim());
  }
  if (activeDates.size === 0) return 0;

  const anchor = todayYmd && /^\d{4}-\d{2}-\d{2}$/.test(todayYmd.trim()) ? todayYmd.trim() : todayLocalYmd();
  let streak = 0;
  for (let i = 0; i <= 3650; i += 1) {
    const key = i === 0 ? anchor : shiftYmd(anchor, -i);
    if (!key) break;
    if (!activeDates.has(key)) {
      if (i === 0) continue;
      break;
    }
    streak += 1;
  }
  return streak;
}

/** Count distinct active days (`count > 0`) in a heatmap. */
export function selectActiveDaysFromHeatmap(
  heatmap: ReadonlyArray<DashboardHeatmapEntry> | null | undefined,
): number {
  if (!Array.isArray(heatmap) || heatmap.length === 0) return 0;
  const activeDates = new Set<string>();
  for (const entry of heatmap) {
    if (!entry || typeof entry.date !== 'string') continue;
    if ((Number(entry.count) || 0) > 0) activeDates.add(entry.date.trim());
  }
  return activeDates.size;
}

/** Single-source KPI extraction shared by DashboardView live KPIs and Markdown report export. */
export function selectDashboardKpis(
  stats: DashboardStatsLike | null | undefined,
  fallback?: DashboardKpiFallback | null,
): DashboardKpis {
  const totals = stats?.totals;

  const totalCards = finiteNonNeg(totals?.cards) ?? fallback?.totalCards ?? 0;
  const mastered = finiteNonNeg(totals?.mastered) ?? fallback?.mastered ?? 0;
  const due = finiteNonNeg(totals?.due) ?? fallback?.due ?? 0;
  const weak = finiteNonNeg(totals?.weak) ?? fallback?.weak ?? 0;
  const attempts = finiteNonNeg(totals?.attempts) ?? 0;

  const rawAcc = totals?.recentRate ?? totals?.correctRate;
  const accuracyLabel = typeof rawAcc === 'number' && Number.isFinite(rawAcc) ? `${rawAcc}%` : '--';

  const activeDays = finiteNonNeg(totals?.activeDays) ?? selectActiveDaysFromHeatmap(stats?.heatmap);
  const streak = finiteNonNeg(totals?.streak) ?? selectStreakFromHeatmap(stats?.heatmap, stats?.today);

  return {
    totalCards,
    mastered,
    due,
    weak,
    attempts,
    accuracyLabel,
    activeDays,
    streak,
  };
}

/** Single-source 7-day forecast queue depth (`total7d`, `overdue`, `hasOverdue`). */
export function selectForecastQueueDepth(
  forecastDays: ReadonlyArray<DashboardForecastDay> | null | undefined,
): ForecastQueueDepth {
  const days = Array.isArray(forecastDays) ? forecastDays.slice(0, 7) : [];
  let total7d = 0;
  for (const d of days) {
    total7d += Number(d?.count) || 0;
  }
  const overdue = Number(days[0]?.overdue) || 0;
  return {
    days,
    total7d,
    overdue,
    hasOverdue: overdue > 0,
  };
}

/** Single-source AI token total for any `UsageTotalsLike` bucket. */
export function selectBucketTotalTokens(u?: UsageTotalsLike | null): number {
  if (!u) return 0;
  return (
    (Number(u.uncachedInputTokens) || 0) +
    (Number(u.outputTokens) || 0) +
    (Number(u.cacheReadTokens) || 0) +
    (Number(u.cacheWriteTokens) || 0)
  );
}

/** Single-source AI usage rollup shared by DashboardView KPIs and Markdown report export. */
export function selectUsageTotals(usage?: UsageSummaryLike | null): UsageMetrics {
  const total = usage?.total;
  const uncachedInputTokens = Number(total?.uncachedInputTokens ?? 0) || 0;
  const outputTokens = Number(total?.outputTokens ?? 0) || 0;
  const cacheReadTokens = Number(total?.cacheReadTokens ?? 0) || 0;
  const cacheWriteTokens = Number(total?.cacheWriteTokens ?? 0) || 0;
  return {
    totalTokens: uncachedInputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    totalCalls: Number(total?.calls ?? 0) || 0,
    uncachedInputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

/** Single-source daily study plan budget & observed weekday/weekend habit metrics. */
export function selectDailyHabitMetrics(dailyPlan?: DailyPlanLike | null): DailyHabitMetrics {
  const hasDailyBudget = Boolean(
    dailyPlan && (dailyPlan.budgetMinutes !== undefined || dailyPlan.spentMinutes !== undefined),
  );
  const budgetMinutes = Number(dailyPlan?.budgetMinutes) || 0;
  const spentMinutes = Number(dailyPlan?.spentMinutes) || 0;

  const p = dailyPlan?.profile;
  const observedWeekdayMinutes =
    typeof p?.observedWeekdayMinutes === 'number' && Number.isFinite(p.observedWeekdayMinutes)
      ? p.observedWeekdayMinutes
      : null;
  const observedWeekendMinutes =
    typeof p?.observedWeekendMinutes === 'number' && Number.isFinite(p.observedWeekendMinutes)
      ? p.observedWeekendMinutes
      : null;

  return {
    hasDailyBudget,
    budgetMinutes,
    spentMinutes,
    hasObservedHabits: observedWeekdayMinutes !== null || observedWeekendMinutes !== null,
    observedWeekdayMinutes,
    observedWeekendMinutes,
  };
}
