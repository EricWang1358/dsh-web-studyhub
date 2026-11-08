import { cleanLearnerPreferences } from './learner.js';
import { normalizeNotation } from './notation.js';
import { focusProgress } from './focus-progress.js';
import { weakTopicsFor } from './contexts/generation/suggest.js';
import { EXAM_FORMATS, courseIndex } from './courses.js';
import { currentCourse } from './focus.js';
import { isDate, addDays, daysBetween } from './crunch-plan.js';
import { localDate } from './board-model.js';

/* 全局学习者档案事实 (#690 S3): pure, zero-model readout of the learner's stated goals/preferences and derived course facts
   (explicit formula notation, weak topics, focus × mastery counts, exam countdown). Computed fresh from the workspace state
   each time so nothing goes stale; returns `null` when every field is empty so a brand-new library emits no empty blocks. */

export const LEARNER_FACT_GOALS = Object.freeze({
  exam: '应付考试',
  interview: '面试求职',
  work: '工作中落地',
  explore: '兴趣拓展',
});

export const LEARNER_FACT_LIMITS = Object.freeze({
  summaryChars: 300,
  weakTopics: 5,
  focusTopics: 5,
});

const clip = (value, limit) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
};

function resolvePlanPhase(plan, today, examDate, daysLeft) {
  if (daysLeft < 0) return 'past';
  const list = (Array.isArray(plan?.phases) ? plan.phases : [])
    .filter(phase => phase && typeof phase.name === 'string' && phase.name.trim());
  if (list.length) {
    let from = isDate(plan?.startDate) ? plan.startDate : today;
    let chosen = list[0].name.trim();
    for (const phase of list) {
      if (from > examDate) break;
      const raw = isDate(phase.until) ? phase.until : examDate;
      const until = raw > examDate ? examDate : (raw < from ? from : raw);
      if (from <= today) chosen = phase.name.trim();
      from = addDays(until, 1);
    }
    return chosen;
  }
  if (daysLeft === 0) return 'exam-day';
  return daysLeft <= 7 ? 'crunch' : 'study';
}

function resolveExamFacts(courseRecord, today) {
  const exam = courseRecord?.exam;
  if (!exam || typeof exam !== 'object') return null;
  const date = isDate(exam.date) ? exam.date : '';
  const format = typeof exam.format === 'string' && EXAM_FORMATS.includes(exam.format) ? exam.format : '';
  const hasSections = Array.isArray(exam.sections) && exam.sections.length > 0;
  if (!date && (!format || (format === 'other' && !hasSections))) return null;
  const daysLeft = date ? daysBetween(today, date) : null;
  const phase = date ? resolvePlanPhase(courseRecord?.plan, today, date, daysLeft) : '';
  return {
    ...(date ? { date, daysLeft } : {}),
    ...(format ? { format } : {}),
    ...(phase ? { phase } : {}),
  };
}

/**
 * Pure learner profile + derived course facts, or `null` when nothing is set or recorded yet.
 * `course === undefined` reads `currentCourse(state)`; `course === ''` scopes to unassigned records (no course focus/exam).
 */
export function learnerFacts(state, course, { now = Date.now(), today } = {}) {
  if (!state || typeof state !== 'object') return null;
  const rawCourse = course === undefined ? currentCourse(state) : typeof course === 'string' ? course.trim() : '';
  const namedCourse = rawCourse && rawCourse !== '*' ? (courseIndex(state).resolve(rawCourse)?.name ?? rawCourse) : '';

  const rawGoal = typeof state.learner?.goal === 'string' ? state.learner.goal.trim() : '';
  const goal = rawGoal ? (LEARNER_FACT_GOALS[rawGoal] || rawGoal) : '';
  const rawSummary = typeof state.learner?.summary === 'string' ? state.learner.summary.replace(/\s+/g, ' ').trim() : '';
  const summary = rawSummary ? clip(rawSummary, LEARNER_FACT_LIMITS.summaryChars) : '';
  const preferences = cleanLearnerPreferences(state.learner?.preferences);

  const rawNotation = normalizeNotation(state.settings?.generation?.notation);
  const notation = rawNotation === 'text' || rawNotation === 'latex' ? rawNotation : '';

  const weakScope = course === undefined ? (namedCourse || '*') : (rawCourse === '*' ? '*' : namedCourse);
  const weakTopics = Array.isArray(state.attempts) && state.attempts.length
    ? weakTopicsFor(state, weakScope, LEARNER_FACT_LIMITS.weakTopics)
    : [];

  let focus = null;
  let exam = null;
  if (namedCourse) {
    const progress = focusProgress(state, namedCourse, { now });
    if (progress.total > 0) {
      focus = {
        total: progress.total,
        done: progress.done,
        weak: progress.weak,
        none: progress.none,
        weakTopics: progress.topics.filter(item => item.status === 'weak').slice(0, LEARNER_FACT_LIMITS.focusTopics).map(item => item.topic),
        emptyTopics: progress.topics.filter(item => item.status === 'none').slice(0, LEARNER_FACT_LIMITS.focusTopics).map(item => item.topic),
      };
    }
    const day = isDate(today) ? today : localDate(new Date(now));
    exam = resolveExamFacts(courseIndex(state).resolve(namedCourse), day);
  }

  const out = {
    ...(goal ? { goal } : {}),
    ...(summary ? { summary } : {}),
    ...(preferences.length ? { preferences } : {}),
    ...(notation ? { notation } : {}),
    ...(weakTopics.length ? { weakTopics } : {}),
    ...(focus ? { focus } : {}),
    ...(exam ? { exam } : {}),
  };
  return Object.keys(out).length ? out : null;
}
