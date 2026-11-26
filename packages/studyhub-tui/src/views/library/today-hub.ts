/**
 * Home "Today" Quick-Launch Hub selector (Round 87 Track B5).
 *
 * Aggregates the 4 daily entrypoints (Resume, Due Review, Weak/Wrong, Board Todos)
 * into concise one-key + Alt+click launch tiles on the Library home view.
 */
import type { LastPracticeContext, StudySnapshot, UiLanguage } from '../../types/contracts.js';
import { selectStudySummary } from '../../selectors/study-metrics.js';

export interface TodayHubMetrics {
  hasResume: boolean;
  due: number;
  wrong: number;
  todo: number;
}

export interface TodayHubItem {
  id: 'resume' | 'due' | 'wrong' | 'todo';
  key: string;
  label: string;
  count?: number;
  tone: 'primary' | 'warning' | 'error' | 'accent';
}

export function buildTodayHubMetrics(opts: {
  snapshot: StudySnapshot | null | undefined;
  course: string | null;
  activeRunId: string | null;
  lastPracticeContext?: LastPracticeContext;
}): TodayHubMetrics {
  const snap = opts.snapshot;
  const summary = selectStudySummary(snap, opts.course);
  const due = summary.due;
  const wrong = summary.weak;
  const rawBoard = Array.isArray((snap as Record<string, unknown> | null | undefined)?.boardTasks)
    ? ((snap as Record<string, unknown>).boardTasks as Array<{ status?: unknown; column?: unknown }>)
    : Array.isArray((snap as Record<string, unknown> | null | undefined)?.board)
      ? ((snap as Record<string, unknown>).board as Array<{ status?: unknown; column?: unknown }>)
      : [];
  const todo = rawBoard.filter((t) => {
    const st = String(t?.status ?? t?.column ?? 'todo').toLowerCase();
    return st !== 'done' && st !== 'completed' && st !== 'archived';
  }).length;

  const hasResume = Boolean(opts.activeRunId || opts.lastPracticeContext?.runId || snap?.lastRun);
  return { hasResume, due, wrong, todo };
}

export function buildTodayHubItems(metrics: TodayHubMetrics, lang: UiLanguage): TodayHubItem[] {
  const zh = lang !== 'en';
  return [
    {
      id: 'resume',
      key: 'r',
      label: zh ? (metrics.hasResume ? '继续练习' : '快速开始') : metrics.hasResume ? 'Resume' : 'Start',
      tone: 'primary',
    },
    {
      id: 'due',
      key: 'Enter',
      label: zh ? `到期复习(${metrics.due})` : `Due(${metrics.due})`,
      count: metrics.due,
      tone: metrics.due > 0 ? 'warning' : 'primary',
    },
    {
      id: 'wrong',
      key: '4',
      label: zh ? `错题巩固(${metrics.wrong})` : `Wrong(${metrics.wrong})`,
      count: metrics.wrong,
      tone: metrics.wrong > 0 ? 'error' : 'accent',
    },
    {
      id: 'todo',
      key: 'b',
      label: zh ? `今日待办(${metrics.todo})` : `Todo(${metrics.todo})`,
      count: metrics.todo,
      tone: 'accent',
    },
  ];
}
