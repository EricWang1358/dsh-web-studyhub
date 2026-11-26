/**
 * Single Source of Truth for Kanban Board derived metrics (#1354 D10).
 *
 * Pure TypeScript (zero React, Ink, or Node I/O imports) unifying board column grouping,
 * active queue depth (`todo + doing`), due-date status classification (`overdue`/`today`/`upcoming`/
 * `done`/`none` on local calendar date), priority ordering, and Pomodoro focus totals across
 * `BoardView.tsx`, `board-store.ts`, `PomodoroBar.tsx`, and CLI `--board`.
 */

export type BoardColumnKey = 'todo' | 'doing' | 'done';
export type BoardDueStatus = 'none' | 'done' | 'overdue' | 'today' | 'upcoming';

export interface BoardCardLike {
  id: string;
  title: string;
  column: BoardColumnKey;
  course?: string;
  dueDate?: string;
}

export interface BoardFocusStatsLike {
  date: string;
  completedPomodoros: number;
  focusedMinutes: number;
}

export interface BoardColumnBuckets<T extends BoardCardLike> {
  todo: T[];
  doing: T[];
  done: T[];
}

export interface ClassifiedBoardCard<T extends BoardCardLike> {
  card: T;
  status: BoardDueStatus;
}

export interface BoardQueueMetrics<T extends BoardCardLike> {
  total: number;
  todo: number;
  doing: number;
  done: number;
  /** Active unfinished queue depth (`todo + doing`). */
  activeQueueDepth: number;
  overdue: number;
  dueToday: number;
  classified: ClassifiedBoardCard<T>[];
}

const COLUMN_RANK: Record<BoardColumnKey, number> = {
  doing: 0,
  todo: 1,
  done: 2,
};

function statusUrgencyRank(status: BoardDueStatus): number {
  if (status === 'overdue') return 0;
  if (status === 'today') return 1;
  return 2;
}

/** Local YYYY-MM-DD calendar date key (shared baseline for BoardView, PomodoroBar, and CLI `--board`). */
export function selectLocalYmd(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Classify a board card's due date against local `todayYmd` (defaults to `selectLocalYmd()`). */
export function selectBoardDueStatus(
  dueDate: string | undefined,
  column: BoardColumnKey,
  todayYmd: string = selectLocalYmd(),
): BoardDueStatus {
  const norm = typeof dueDate === 'string' ? dueDate.trim() : '';
  if (!norm) return 'none';
  if (column === 'done') return 'done';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(norm)) return 'upcoming';
  if (norm < todayYmd) return 'overdue';
  if (norm === todayYmd) return 'today';
  return 'upcoming';
}

/** Daily focus stats for `todayYmd`: retains counts when `stats.date === todayYmd`, resets to 0 otherwise. */
export function selectTodayFocusStats(
  stats?: BoardFocusStatsLike | null,
  todayYmd: string = selectLocalYmd(),
): BoardFocusStatsLike {
  if (stats && stats.date === todayYmd) {
    return {
      date: todayYmd,
      completedPomodoros: Math.max(0, Math.floor(Number(stats.completedPomodoros) || 0)),
      focusedMinutes: Math.max(0, Math.floor(Number(stats.focusedMinutes) || 0)),
    };
  }
  return { date: todayYmd, completedPomodoros: 0, focusedMinutes: 0 };
}

/** Raw clamped focus totals for archival snapshot exports (preserves counts regardless of date). */
export function selectRawFocusTotals(
  stats?: Pick<BoardFocusStatsLike, 'completedPomodoros' | 'focusedMinutes'> | null,
): { completedPomodoros: number; focusedMinutes: number } {
  return {
    completedPomodoros: Math.max(0, Math.floor(Number(stats?.completedPomodoros) || 0)),
    focusedMinutes: Math.max(0, Math.floor(Number(stats?.focusedMinutes) || 0)),
  };
}

/** Group board cards into `todo`, `doing`, and `done` buckets preserving input order. */
export function selectBoardColumnBuckets<T extends BoardCardLike>(
  cards: readonly T[],
): BoardColumnBuckets<T> {
  const todo: T[] = [];
  const doing: T[] = [];
  const done: T[] = [];
  for (const card of cards) {
    if (card.column === 'doing') doing.push(card);
    else if (card.column === 'done') done.push(card);
    else todo.push(card);
  }
  return { todo, doing, done };
}

/**
 * Compute board column counts, active queue depth (`todo + doing`), overdue/today tallies,
 * and deterministic priority-sorted card rows (shared by BoardView and CLI `--board`).
 */
export function selectBoardQueueMetrics<T extends BoardCardLike>(
  cards: readonly T[],
  opts?: { todayYmd?: string; courseFilter?: string },
): BoardQueueMetrics<T> {
  const today = opts?.todayYmd ?? selectLocalYmd();
  const courseNeedle = (opts?.courseFilter ?? '').trim().toLowerCase();

  let todo = 0;
  let doing = 0;
  let done = 0;
  let overdue = 0;
  let dueToday = 0;
  const classified: ClassifiedBoardCard<T>[] = [];

  for (const card of cards) {
    const courseText = typeof card.course === 'string' ? card.course.replace(/\r?\n+/g, ' ').trim() : '';
    if (courseNeedle && !courseText.toLowerCase().includes(courseNeedle)) continue;

    const status = selectBoardDueStatus(card.dueDate, card.column, today);
    if (card.column === 'todo') todo += 1;
    else if (card.column === 'doing') doing += 1;
    else done += 1;

    if (status === 'overdue') overdue += 1;
    if (status === 'today') dueToday += 1;

    classified.push({ card, status });
  }

  classified.sort(
    (a, b) =>
      COLUMN_RANK[a.card.column] - COLUMN_RANK[b.card.column] ||
      statusUrgencyRank(a.status) - statusUrgencyRank(b.status) ||
      (a.card.title || a.card.id).localeCompare(b.card.title || b.card.id),
  );

  return {
    total: classified.length,
    todo,
    doing,
    done,
    activeQueueDepth: todo + doing,
    overdue,
    dueToday,
    classified,
  };
}
