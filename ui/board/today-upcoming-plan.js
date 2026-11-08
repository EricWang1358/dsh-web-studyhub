import { ui, uiFormat } from '../i18n.js';
import { joinMeta } from '../format.js';
import { dayKind, weekText } from '../book/crunch-words.js';
import { shortDate } from '../book/plan-model.js';
import { activePlanCourse } from './today-header.js';

export const UPCOMING_PLAN_LIMIT = 3;

const pointTitle = (point) => [point?.code, point?.title].filter(Boolean).join(' ').trim();

/**
 * Picks the course whose study plan entry should be linked on Today:
 * 1) The active planned course (`activePlanCourse`), if any.
 * 2) Otherwise the focused active course, or first active course, or uncategorized `""` when materials/decks exist.
 */
export function candidatePlanCourse(library) {
  const planned = activePlanCourse(library);
  if (planned) return planned;
  const activeCourses = (library?.courses || []).filter((course) => course && course.active !== false);
  if (activeCourses.length > 0) {
    return activeCourses.find((course) => course.name === library?.focus?.course) || activeCourses[0];
  }
  const hasContent = (Array.isArray(library?.decks) && library.decks.length > 0)
    || (Array.isArray(library?.sources) && library.sources.length > 0);
  if (hasContent) {
    return { name: typeof library?.focus?.course === 'string' ? library.focus.course : '' };
  }
  return null;
}

/** Formats one scheduled future day from `periodPlan` (`lib/plan-schedule.js`) without re-computing the schedule. */
export function formatUpcomingDay(day, pointsById = new Map()) {
  const date = String(day?.date || '');
  const dateLabel = shortDate(date);
  const mode = day?.mode || 'learn';
  const kindLabel = dayKind(day);
  const points = (day?.points || []).map((id) => pointsById.get(id)).filter(Boolean);
  const practiceCount = points.reduce(
    (sum, point) => sum + Math.min(5, Math.max(0, Math.floor(Number(point?.questions) || 0))),
    0,
  );
  const minutes = Math.max(0, Math.round(Number(day?.minutes) || 0));

  let summary = '';
  if (mode === 'off') {
    summary = ui('休息');
  } else if (mode === 'mock') {
    summary = joinMeta([ui('模拟考'), ui('整套模拟卷')]);
  } else if (mode === 'flip') {
    if (points.length > 0) {
      const flipText = uiFormat('翻看 {0} 节', [points.length]);
      summary = day?.mock ? joinMeta([flipText, ui('模拟卷')]) : flipText;
    } else {
      summary = kindLabel;
    }
  } else if (mode === 'review') {
    if (points.length === 0) {
      summary = joinMeta([ui('复习日'), ui('复习到期和薄弱的题')]);
    } else {
      const first = pointTitle(points[0]) || uiFormat('{0} 节', [points.length]);
      if (points.length === 1) {
        summary = practiceCount > 0
          ? uiFormat('复习 {0} · 练 {1} 题', [first, practiceCount])
          : uiFormat('复习 {0}', [first]);
      } else {
        summary = practiceCount > 0
          ? uiFormat('复习 {0} 等 {1} 节 · 练 {2} 题', [first, points.length, practiceCount])
          : uiFormat('复习 {0} 等 {1} 节', [first, points.length]);
      }
    }
  } else if (points.length === 0) {
    summary = joinMeta([ui('学习日'), ui('复习到期和薄弱的题')]);
  } else {
    const first = pointTitle(points[0]) || uiFormat('{0} 节', [points.length]);
    if (points.length === 1) {
      summary = practiceCount > 0
        ? uiFormat('读 {0} · 练 {1} 题', [first, practiceCount])
        : minutes > 0
          ? uiFormat('读 {0} · 约 {1} 分钟', [first, minutes])
          : uiFormat('读 {0}', [first]);
    } else {
      summary = practiceCount > 0
        ? uiFormat('读 {0} 等 {1} 节 · 练 {2} 题', [first, points.length, practiceCount])
        : minutes > 0
          ? uiFormat('读 {0} 等 {1} 节 · 约 {2} 分钟', [first, points.length, minutes])
          : uiFormat('读 {0} 等 {1} 节', [first, points.length]);
    }
  }

  return {
    date,
    offset: Number(day?.offset) || 0,
    dateLabel,
    mode,
    kindLabel,
    pointCount: points.length,
    practiceCount,
    minutes,
    summary,
  };
}

/**
 * Pure read-only model for 「备考计划 · 接下来」 (#861):
 * - Reads `planAnswer.schedule.days` (`offset > 0`) produced by `periodPlan` / `plan-weekly.js`, up to `limit` days.
 * - Preserves rest days (`mode: 'off'`) and returns `days: []` on/after exam day or past the last weekly day.
 * - Falls back to a single quiet `建一个备考计划` entry when no active plan exists.
 */
export function selectTodayUpcomingPlan({ library = null, planAnswer = null, limit = UPCOMING_PLAN_LIMIT } = {}) {
  const maxDays = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : UPCOMING_PLAN_LIMIT;
  const plannedCourse = activePlanCourse(library);

  if (planAnswer && planAnswer.status === 'ok' && planAnswer.schedule && (planAnswer.plan?.status ?? 'active') === 'active') {
    const { schedule } = planAnswer;
    const byId = new Map((planAnswer.points || []).map((point) => [point.id, point]));
    const days = (schedule.days || [])
      .filter((item) => item && Number(item.offset) > 0)
      .slice(0, maxDays)
      .map((item) => formatUpcomingDay(item, byId));
    const weeklyLine = schedule.weekly ? weekText(schedule.weekly) : '';
    const course = planAnswer.course ?? plannedCourse?.name ?? '';
    const courseLabel = course === '' ? ui('未分类课程') : String(course);
    let emptyNote = '';
    if (days.length === 0) {
      emptyNote = !schedule.weekly && schedule.daysLeft === 0
        ? ui('今天考试，之后没有新的排期。')
        : ui('接下来没有排新的日程。');
    }
    return {
      visible: true,
      kind: 'plan',
      course,
      courseLabel,
      weeklyLine,
      days,
      emptyNote,
    };
  }

  if (planAnswer && planAnswer.status === 'past') {
    const course = planAnswer.course ?? plannedCourse?.name ?? '';
    return {
      visible: true,
      kind: 'plan',
      course,
      courseLabel: course === '' ? ui('未分类课程') : String(course),
      weeklyLine: '',
      days: [],
      emptyNote: ui('考试日期已过，备考计划不再排日子。'),
    };
  }

  // While the active planned course's RPC answer is still in flight, wait quietly rather than flashing "还没有备考计划".
  if (plannedCourse && planAnswer === null) {
    return {
      visible: false,
      kind: 'loading',
      course: plannedCourse.name,
      courseLabel: plannedCourse.name === '' ? ui('未分类课程') : String(plannedCourse.name),
      weeklyLine: '',
      days: [],
      emptyNote: '',
    };
  }

  const candidate = candidatePlanCourse(library)
    || (planAnswer && planAnswer.course !== undefined && planAnswer.course !== null
      ? { name: planAnswer.course, exam: planAnswer.examDate ? { date: planAnswer.examDate } : null }
      : null);

  if (!candidate) {
    return {
      visible: false,
      kind: 'none',
      course: null,
      courseLabel: '',
      weeklyLine: '',
      days: [],
      emptyNote: '',
    };
  }

  const course = candidate.name ?? '';
  return {
    visible: true,
    kind: 'empty',
    course,
    courseLabel: course === '' ? ui('未分类课程') : String(course),
    weeklyLine: '',
    days: [],
    emptyNote: '',
  };
}
