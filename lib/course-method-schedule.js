

import { courseMethod } from './course-method.js';
import { methodProgress } from './course-method-progress.js';
import { stageGate } from './course-method-gate.js';

/* 阶段排期 (#777): connects a course's custom 学法 stages (`own === true`) with its `course.plan` (phase deadlines, `studyWeekdays`, `restDates`, `mockDates`,
   or weekly plan) and `course.exam?.date` / `method.targetDate` so each stage shows a calm suggested completion date and a single quiet line when behind.
   Pure; no model call, no I/O, never creates popups or mutates state. Default `课堂跟学` (`own === false`) returns `null`. */

const DAY = 86400000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const time = date => (typeof date === 'string' && DATE.test(date) ? Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) : NaN);
const isDate = date => Number.isFinite(time(date)) && new Date(time(date)).toISOString().slice(0, 10) === date;
const addDays = (date, n) => new Date(time(date) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (from, to) => Math.round((time(to) - time(from)) / DAY);
const two = n => (n < 10 ? `0${n}` : String(n));
const localDate = (date = new Date()) => `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
const MAX_HORIZON_DAYS = 731;
const weekdayOf = date => new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)))).getUTCDay();
const datePrefix = value => (typeof value === 'string' && isDate(value.slice(0, 10)) ? value.slice(0, 10) : null);

function resolvePhases(plan, start, endDate) {
  const list = (Array.isArray(plan?.phases) ? plan.phases : []).filter(phase => phase && typeof phase.name === 'string' && phase.name.trim());
  if (!list.length) return [];
  const out = [];
  let from = null;
  for (const phase of list) {
    const raw = isDate(phase.until) ? phase.until : endDate;
    if (!isDate(raw)) break;
    const bounded = endDate && raw > endDate ? endDate : raw;
    const phaseFrom = from ?? (isDate(start) && start <= bounded ? start : bounded);
    const until = bounded < phaseFrom ? phaseFrom : bounded;
    if (endDate && phaseFrom > endDate) break;
    out.push({ name: phase.name.trim(), from: phaseFrom, until });
    from = addDays(until, 1);
  }
  return out;
}

function studyDaysBetween(start, endDate, plan) {
  if (!isDate(start) || !isDate(endDate) || start > endDate) return isDate(endDate) ? [endDate] : [];
  const span = daysBetween(start, endDate);
  if (span > MAX_HORIZON_DAYS) return null;
  const rest = new Set((Array.isArray(plan?.restDates) ? plan.restDates : []).filter(isDate));
  const mocks = new Set((Array.isArray(plan?.mockDates) ? plan.mockDates : []).filter(isDate));
  const weekdays = Array.isArray(plan?.studyWeekdays) && plan.studyWeekdays.length ? new Set(plan.studyWeekdays) : null;
  const all = [];
  const active = [];
  for (let date = start, step = 0; date <= endDate && step <= MAX_HORIZON_DAYS; date = addDays(date, 1), step += 1) {
    all.push(date);
    const off = rest.has(date) || mocks.has(date) || (weekdays && !weekdays.has(weekdayOf(date)));
    if (!off) active.push(date);
  }
  return active.length ? active : all;
}

function distributeAcrossWindow(count, start, endDate, plan) {
  if (count <= 0) return [];
  if (count === 1 || !isDate(start) || start >= endDate) return Array.from({ length: count }, () => endDate);
  const days = studyDaysBetween(start, endDate, plan);
  if (!days) {
    const total = Math.max(1, daysBetween(start, endDate));
    return Array.from({ length: count }, (_, idx) => (idx === count - 1 ? endDate : addDays(start, Math.round(((idx + 1) / count) * total))));
  }
  return Array.from({ length: count }, (_, idx) => {
    if (idx === count - 1) return endDate;
    const at = Math.min(days.length - 1, Math.max(0, Math.ceil(((idx + 1) / count) * days.length) - 1));
    return days[at];
  });
}

function currentStageDone(progress, gate) {
  if (!progress?.stage) return false;
  if (progress.stage.activity === 'publish') return (progress.counts?.materials ?? 0) > 0;
  if (!gate) return false;
  return gate.last ? Boolean(gate.checkPassed) : Boolean(gate.ready);
}

/**
 * Compute per-stage suggested completion dates and behind-schedule status for `course` (`own === true` only).
 * Returns `null` when the course uses the default method or has no plan/exam/target date to anchor on.
 */
export function methodStageSchedule(state, course, { today = localDate(), progress = null, gate = null } = {}) {
  if (!isDate(today)) return null;
  const courseName = typeof course === 'string' ? course : course?.name;
  const fromState = courseName ? (state?.courses || []).find(item => item && item.name === courseName) ?? null : null;
  const record = typeof course === 'object' && course ? (fromState ? { ...fromState, ...course } : course) : fromState;
  if (!record?.method) return null;

  const method = courseMethod(record);
  const stageCount = method.stages.length;
  if (!stageCount) return null;

  const plan = record.plan && typeof record.plan === 'object' && (record.plan.version === undefined || record.plan.version === 1) && record.plan.status !== 'paused' && record.plan.status !== 'done'
    ? record.plan
    : null;
  const examDate = isDate(record.exam?.date) ? record.exam.date : null;
  const targetDate = isDate(method.targetDate) ? method.targetDate : null;
  const lastPhaseUntil = Array.isArray(plan?.phases)
    ? [...plan.phases].reverse().map(phase => phase?.until).find(isDate) ?? null
    : null;

  const rawStart = (isDate(plan?.startDate) ? plan.startDate : null)
    || datePrefix(method.updatedAt)
    || datePrefix(record.createdAt)
    || today;

  let endDate = examDate || targetDate || lastPhaseUntil;
  if (!endDate && plan?.by === 'weekly') {
    endDate = addDays(rawStart, Math.max(1, stageCount) * 7 - 1);
  }
  if (!isDate(endDate)) return null;

  const start = rawStart <= endDate ? rawStart : endDate;
  const resolvedPhases = plan ? resolvePhases(plan, start, endDate) : [];
  let stages;

  if (resolvedPhases.length === stageCount) {
    stages = resolvedPhases.map((phase, index) => ({
      index,
      suggestedUntil: phase.until,
      phaseName: phase.name,
    }));
  } else if (resolvedPhases.length > stageCount) {
    stages = method.stages.map((_, index) => {
      const phaseIdx = index === stageCount - 1
        ? resolvedPhases.length - 1
        : Math.min(resolvedPhases.length - 1, Math.max(0, Math.round(((index + 1) / stageCount) * resolvedPhases.length) - 1));
      const phase = resolvedPhases[phaseIdx];
      return { index, suggestedUntil: phase.until, phaseName: phase.name };
    });
  } else if (resolvedPhases.length > 0) {
    // Fewer plan phases than method stages: allocate stages proportionally across phases and distribute study days within each phase.
    const buckets = resolvedPhases.map(() => []);
    method.stages.forEach((_, idx) => {
      const pIdx = Math.min(resolvedPhases.length - 1, Math.floor((idx * resolvedPhases.length) / stageCount));
      buckets[pIdx].push(idx);
    });
    stages = new Array(stageCount);
    resolvedPhases.forEach((phase, pIdx) => {
      const indices = buckets[pIdx];
      if (!indices.length) return;
      const dates = distributeAcrossWindow(indices.length, phase.from, phase.until, plan);
      indices.forEach((stageIdx, localIdx) => {
        stages[stageIdx] = { index: stageIdx, suggestedUntil: dates[localIdx], phaseName: phase.name };
      });
    });
  } else {
    const dates = distributeAcrossWindow(stageCount, start, endDate, plan);
    stages = dates.map((suggestedUntil, index) => ({ index, suggestedUntil }));
  }

  const resolvedProgress = progress || methodProgress(state, record.name);
  const resolvedGate = gate || stageGate(state, record.name, resolvedProgress);
  const currentSuggestedUntil = stages[resolvedProgress.index]?.suggestedUntil ?? null;
  const done = currentStageDone(resolvedProgress, resolvedGate);
  const behind = Boolean(!done && isDate(currentSuggestedUntil) && today > currentSuggestedUntil);
  const daysBehind = behind ? Math.max(1, daysBetween(currentSuggestedUntil, today)) : 0;
  const basis = plan ? 'plan' : examDate ? 'exam' : 'targetDate';

  return {
    today,
    basis,
    startDate: start,
    endDate,
    currentSuggestedUntil,
    behind,
    daysBehind,
    stages,
  };
}
