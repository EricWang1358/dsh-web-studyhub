/**
 * Display of the saved 备考计划 — the backend `course.plan` answer (lib/course-plan.js, built on lib/plan-schedule.js).
 *
 * The schedule is the backend's: minutes per day, study weekdays, rest and mock dates, phases and the day-by-day
 * placement all come from the response. Nothing here counts cards, estimates minutes or splits phases; it only turns the
 * answer into text rows for the countdown bar, the `[T]` table, the Markdown export and the 备考计划 modal.
 */
import type { UiLanguage } from '../../types/contracts.js';
import type { ThemeTokens } from '../../theme/tokens.js';
import { t } from '../../state/store.js';
import { renderStatTable } from '../../render/charts.js';

export interface CoursePlanPhase {
  name: string;
  from: string;
  until: string;
  goal?: string;
}

export interface CoursePlanReason {
  code: string;
  count?: number;
  tested?: number;
  weak?: number;
  minutes?: number;
  capacity?: number;
  week?: number;
  chapters?: number[];
  carried?: number;
}

export interface CoursePlanDay {
  date: string;
  offset: number;
  phase: string | null;
  mode: 'learn' | 'review' | 'mock' | 'off' | string;
  mock?: boolean;
  week?: number | null;
  points: string[];
  done: string[];
  minutes: number;
  reason?: CoursePlanReason;
}

export interface CoursePlanPoint {
  id: string;
  number?: string;
  code?: string;
  title: string;
  done?: string | null;
  seen?: string | null;
  weak?: number;
  questions?: number;
  pitfalls?: number;
}

export interface CoursePlanResponse {
  status: 'ok' | 'no-plan' | 'no-book' | 'no-exam' | 'past' | 'no-course' | string;
  course: string | null;
  examDate?: string | null;
  daysLeft?: number | null;
  today?: string;
  plan?: {
    version?: number;
    status?: 'active' | 'paused' | 'done' | string;
    startDate?: string;
    minutesPerDay?: number;
    by?: 'exam' | 'weekly' | string;
    chaptersPerWeek?: number;
    reviewCycleDays?: number;
    phases?: Array<{ name: string; until?: string; goal?: string }>;
    notes?: string;
  } | null;
  schedule?: {
    status: string;
    examDate?: string | null;
    /** Today's entry of the schedule (null when today is not scheduled). */
    today?: CoursePlanDay | null;
    daysLeft?: number | null;
    start?: string | null;
    capacity?: number;
    reviewCycleDays?: number;
    phases?: CoursePlanPhase[];
    days?: CoursePlanDay[];
    coverage?: {
      total: number;
      scheduled: number;
      unplaced: string[];
    };
    progress?: {
      learnt: number;
      total: number;
      elapsedDays: number;
      totalDays: number;
    };
    merged?: Array<{ date: string; ids: string[]; minutes: number; capacity: number }>;
    weekly?: {
      chaptersPerWeek?: number;
      thisWeek?: number | null;
      position?: string;
      behind?: number;
    };
    truncated?: boolean;
  };
  points?: CoursePlanPoint[];
}

export function dayModeMeta(day: CoursePlanDay, lang: 'zh' | 'en'): { label: string; tone: 'primary' | 'accent' | 'warning' | 'muted' } {
  switch (day.mode) {
    case 'learn':
      return { label: t(lang, '精学', 'Learn'), tone: 'primary' };
    case 'review':
      return { label: t(lang, '复习', 'Review'), tone: 'accent' };
    case 'mock':
      return { label: t(lang, '模考', 'Mock'), tone: 'warning' };
    case 'off':
    default:
      return { label: t(lang, '休息', 'Off'), tone: 'muted' };
  }
}

export function formatPlanDayReason(day: CoursePlanDay, lang: 'zh' | 'en'): string {
  const r = day.reason;
  if (!r) return day.points.length > 0 ? `${day.points.length} ${t(lang, '节', 'pts')}` : '';
  switch (r.code) {
    case 'exam-today':
      return t(lang, `今日考试 · 总览 ${r.count ?? day.points.length} 节`, `Exam today · review ${r.count ?? day.points.length}`);
    case 'exam-day':
      return t(lang, `考日总览 ${r.count ?? day.points.length} 节`, `Exam day review ${r.count ?? day.points.length}`);
    case 'mock':
      return t(lang, '全真模拟测试', 'Mock exam');
    case 'rest':
      return t(lang, '计划休息日', 'Planned rest day');
    case 'weekday':
      return t(lang, '非学习日', 'Non-study weekday');
    case 'done':
      return t(lang, `已完成 ${r.count ?? day.done.length} 节`, `Completed ${r.count ?? day.done.length}`);
    case 'looked':
      return t(lang, `已翻看 ${r.count ?? day.points.length} 节`, `Skimmed ${r.count ?? day.points.length}`);
    case 'review':
      return t(
        lang,
        `复习 ${r.count ?? day.points.length} 节 (薄弱 ${r.weak ?? 0})`,
        `Review ${r.count ?? day.points.length} pts (${r.weak ?? 0} weak)`,
      );
    case 'review-learn':
      return t(lang, `优先预学 ${r.count ?? day.points.length} 节`, `Priority ${r.count ?? day.points.length} pts`);
    case 'learn-free':
      return t(lang, '待学内容已排完', 'All pending scheduled');
    case 'learn-over':
      return t(
        lang,
        `超负荷 ${r.count ?? day.points.length} 节 (${r.minutes ?? day.minutes}/${r.capacity ?? 0}m)`,
        `Over ${r.count ?? day.points.length} pts (${r.minutes ?? day.minutes}/${r.capacity ?? 0}m)`,
      );
    case 'week':
      return t(
        lang,
        `第${r.week ?? '?'}周 第${(r.chapters ?? []).join('/')}章 · ${r.count ?? day.points.length} 节${r.carried ? ` (+欠${r.carried})` : ''}`,
        `Wk${r.week ?? '?'} Ch${(r.chapters ?? []).join('/')} · ${r.count ?? day.points.length} pts${r.carried ? ` (+${r.carried})` : ''}`,
      );
    case 'learn':
      return t(
        lang,
        `精学 ${r.count ?? day.points.length} 节 (考过 ${r.tested ?? 0} · 薄弱 ${r.weak ?? 0})`,
        `Learn ${r.count ?? day.points.length} pts (T:${r.tested ?? 0} W:${r.weak ?? 0})`,
      );
    case 'learn-size':
      return t(
        lang,
        `精学 ${r.count ?? day.points.length} 节 (薄弱 ${r.weak ?? 0})`,
        `Learn ${r.count ?? day.points.length} pts (W:${r.weak ?? 0})`,
      );
    default:
      return `${day.points.length} ${t(lang, '节', 'pts')}`;
  }
}

/** Today and later days of the saved schedule (all of them when none is left, as the 备考计划 modal lists them). */
export function planScheduleDays(resp: CoursePlanResponse | null | undefined): CoursePlanDay[] {
  const all = resp?.schedule?.days ?? [];
  const future = all.filter((d) => d.offset >= 0);
  return future.length > 0 ? future : all;
}

/** Why a saved plan shows no schedule, in one phrase; '' when the answer needs no note (ok, past, unknown, no course). */
function planUnavailableNote(status: string | undefined, lang: UiLanguage): string {
  switch (status) {
    case 'no-plan':
      return t(lang, '还没有备考计划', 'No study plan yet');
    case 'no-exam':
      return t(lang, '备考计划还没有考试日期，暂无排程', 'The study plan has no exam date yet, nothing scheduled');
    case 'no-book':
      return t(lang, '备考计划已保存，但还没有复习全书，暂无排程', 'The study plan is saved but there is no review book yet, nothing scheduled');
    default:
      return '';
  }
}

function planTitleParts(resp: CoursePlanResponse, lang: UiLanguage): string[] {
  const parts: string[] = [];
  const daysLeft = resp.daysLeft ?? resp.schedule?.daysLeft;
  if (typeof daysLeft === 'number' && daysLeft >= 0) parts.push(t(lang, `距考 ${daysLeft} 天`, `${daysLeft}d left`));
  const capacity = resp.schedule?.capacity;
  if (typeof capacity === 'number' && capacity > 0) parts.push(t(lang, `每日 ${capacity} 分钟`, `${capacity} min/day`));
  return parts;
}

/**
 * The one-line countdown bar for ExamPrepView: the saved plan's exam date, days left, today's phase and today's work —
 * or one line saying there is no plan and which key opens the plan modal. '' when there is nothing honest to say.
 */
export function formatExamCountdownSummary(resp: CoursePlanResponse | null | undefined, lang: UiLanguage, asciiMode: boolean): string {
  if (!resp) return '';
  const sep = asciiMode ? ' | ' : ' · ';
  const icon = asciiMode ? '*' : '✦';
  if (resp.status === 'ok') {
    const parts = [t(lang, '备考计划', 'Study plan')];
    const daysLeft = resp.daysLeft ?? resp.schedule?.daysLeft;
    if (resp.examDate) {
      const left = typeof daysLeft === 'number' ? t(lang, ` (距考 ${daysLeft} 天)`, ` (${daysLeft}d left)`) : '';
      parts.push(`${t(lang, '考试', 'exam')} ${resp.examDate}${left}`);
    }
    const today = resp.schedule?.today ?? null;
    if (today?.phase) parts.push(today.phase);
    if (today) {
      const work = formatPlanDayReason(today, lang) || dayModeMeta(today, lang).label;
      const minutes = today.minutes > 0 ? ` ${today.minutes}${t(lang, ' 分钟', 'm')}` : '';
      parts.push(`${t(lang, '今日', 'today')} ${work}${minutes}`);
    }
    return `${icon} ${parts.join(sep)}`;
  }
  const note = planUnavailableNote(resp.status, lang);
  if (!note) return '';
  const key = resp.status === 'no-plan' ? t(lang, '按 [P] 设置', 'press [P] to set one up') : t(lang, '按 [P] 查看', 'press [P] to open it');
  return `${icon} ${note}${asciiMode ? ' - ' : ' — '}${key}`;
}

/** The saved schedule as a borderless CJK-aligned table (the `[T]` view); [] when the answer has no days. */
export function renderExamScheduleTable(
  resp: CoursePlanResponse | null | undefined,
  width: number,
  theme: Pick<ThemeTokens, 'primary' | 'track' | 'muted' | 'dim' | 'heat' | 'text'>,
  opts: { lang: UiLanguage; ascii?: boolean },
): string[] {
  const days = planScheduleDays(resp);
  if (resp?.status !== 'ok' || days.length === 0) return [];
  const lang = opts.lang === 'en' ? 'en' : 'zh';
  return renderStatTable(
    [
      { key: 'date', label: t(lang, '日期', 'Date'), align: 'left', width: 10 },
      { key: 'phase', label: t(lang, '阶段', 'Phase'), align: 'left', minWidth: 8 },
      { key: 'plan', label: t(lang, '安排', 'Plan'), align: 'left', minWidth: 8 },
      { key: 'minutes', label: t(lang, '分钟', 'Min'), align: 'right', width: 4 },
    ],
    days.map((d) => ({
      date: d.date,
      phase: d.phase ?? '-',
      plan: [dayModeMeta(d, lang).label, formatPlanDayReason(d, lang)].filter(Boolean).join(' '),
      minutes: d.minutes > 0 ? d.minutes : '-',
    })),
    width,
    theme,
    { ascii: opts.ascii },
  );
}

/** One Markdown table cell: pipes escaped, line breaks flattened. */
export function escapeMdCell(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

/**
 * The saved 备考计划 as a Markdown section for the export: phases and the day-by-day schedule from the answer.
 * '' when the answer is unknown or the exam is past; one line when there is no plan or it cannot be scheduled.
 */
export function formatExamScheduleMarkdown(resp: CoursePlanResponse | null | undefined, lang: UiLanguage = 'zh'): string {
  if (!resp) return '';
  const heading = t(lang, '备考计划', 'Study Plan');
  if (resp.status !== 'ok') {
    const note = planUnavailableNote(resp.status, lang);
    return note ? `## ${heading}\n\n_${note}${t(lang, '。', '.')}_` : '';
  }
  const parts = planTitleParts(resp, lang);
  const lines: string[] = [`## ${heading}${parts.length > 0 ? t(lang, `（${parts.join(' · ')}）`, ` (${parts.join(' · ')})`) : ''}`, ''];
  const phases = resp.schedule?.phases ?? [];
  if (phases.length > 0) {
    const summary = phases.map((p) => `${escapeMdCell(p.name)} ${p.from}~${p.until}`).join(' → ');
    lines.push(`- **${t(lang, '阶段', 'Phases')}**: ${summary}`);
  }
  const days = planScheduleDays(resp);
  if (days.length > 0) {
    const titleOf = new Map((resp.points ?? []).map((p) => [p.id, p.title] as const));
    lines.push(
      '',
      t(lang, '| 日期 | 阶段 | 模式 | 安排 | 分钟 | 重点 |', '| Date | Phase | Mode | Plan | Min | Focus |'),
      '| --- | --- | --- | --- | ---: | --- |',
    );
    for (const d of days) {
      const focus = d.points.map((id) => titleOf.get(id) ?? id).map(escapeMdCell).join(t(lang, '、', ', '));
      lines.push(
        `| ${escapeMdCell(d.date)} | ${escapeMdCell(d.phase ?? '-') || '-'} | ${escapeMdCell(dayModeMeta(d, lang).label)} | ${escapeMdCell(formatPlanDayReason(d, lang)) || '-'} | ${d.minutes} | ${focus || '-'} |`,
      );
    }
  }
  return lines.join('\n');
}
