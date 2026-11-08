import { ui, uiLocale } from '../i18n.js';
import { joinMeta } from '../format.js';
import { countdownText } from '../book/crunch-words.js';
import { courseMethod } from '../../lib/course-method.js';

const dayNumber = (value) => {
  const [y, m, d] = String(value || '').split('-').map(Number);
  return Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d)
    ? Math.round(Date.UTC(y, m - 1, d) / 86400000)
    : NaN;
};

/** Local date and weekday heading for the Today board view (e.g. "11月8日 · 星期日" / "November 8 · Sunday"). */
export function formatTodayHeading(today) {
  const [y, m, d] = String(today || '').split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return '';
  const date = new Date(y, m - 1, d, 12, 0, 0);
  const locale = uiLocale();
  return joinMeta([
    date.toLocaleDateString(locale, { month: 'long', day: 'numeric' }),
    date.toLocaleDateString(locale, { weekday: 'long' }),
  ]);
}

function activePlanCourse(library) {
  const active = (library?.courses || []).filter(
    (course) => course && course.active !== false && course.plan && (course.plan.status ?? 'active') === 'active',
  );
  if (!active.length) return null;
  return active.find((course) => course.name === library?.focus?.course) || active[0];
}

/**
 * When an active course has a saved 备考计划 (`course.plan`), builds the read-only context line:
 * `当前课程 · 学法阶段 · 距考试 N 天` (omitting exam countdown when the course has no future/current exam date).
 */
export function todayPlanLine(library, today) {
  const course = activePlanCourse(library);
  if (!course) return '';
  const courseLabel = course.name === '' ? ui('未分类课程') : course.name;
  let stageLabel = '';
  if (library?.focus?.method?.course === course.name && library.focus.method.stage?.name) {
    stageLabel = library.focus.method.own ? library.focus.method.stage.name : ui(library.focus.method.stage.name);
  } else {
    const method = courseMethod(course);
    const index = Number.isInteger(method.stageIndex)
      ? Math.min(Math.max(0, method.stageIndex), method.stages.length - 1)
      : 0;
    const rawStage = method.stages[index]?.name || '';
    stageLabel = rawStage ? (course.method ? rawStage : ui(rawStage)) : '';
  }
  let examLabel = '';
  if (course.exam?.date) {
    const daysLeft = dayNumber(course.exam.date) - dayNumber(today);
    if (Number.isFinite(daysLeft) && daysLeft >= 0) examLabel = countdownText(daysLeft);
  }
  return joinMeta([courseLabel, stageLabel, examLabel]);
}
