import { useCallback, useEffect, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { joinMeta } from '../format.js';
import { readJSON, removeKey, writeJSON } from '../storage.js';
import { dayInTimeZone, localDate, recentLocalDays } from '../../lib/board-model.js';

export const DAILY_GOAL_PRESETS = Object.freeze([30, 60, 100]);
export const DAILY_GOAL_MIN = 1;
export const DAILY_GOAL_MAX = 999;

/** Per-card elapsed cap (3 min) to ignore AFK pauses when estimating pace. */
export const MAX_CARD_ELAPSED_MS = 180_000;
/** Floor (3 s) so accidental rapid clicks cannot inflate cards/pomodoro. */
export const MIN_CARD_ELAPSED_MS = 3_000;
/** Cold-start fallback: 50 s/card => ~30 cards per 25-min focus pomodoro. */
export const COLD_START_ELAPSED_MS = 50_000;
/** Minimum today samples before dropping the 7-day / cold-start blend. */
export const BLEND_MIN_TODAY_SAMPLES = 5;

const DAILY_GOAL_KEY_PREFIX = 'study-review-daily-goal';

export function dailyGoalStorageKey(root = '') {
  const clean = typeof root === 'string' ? root.trim() : '';
  return clean ? `${DAILY_GOAL_KEY_PREFIX}:${clean}` : DAILY_GOAL_KEY_PREFIX;
}

export function normalizeDailyGoal(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  if (!Number.isInteger(num) || num < DAILY_GOAL_MIN || num > DAILY_GOAL_MAX) return null;
  return num;
}

/** Read today's optional question goal from localStorage (automatically expires on a new local date). */
export function readDailyGoal({ today = localDate(), root = '', storage } = {}) {
  const saved = readJSON(dailyGoalStorageKey(root), null, storage);
  if (!saved || typeof saved !== 'object' || saved.date !== today) return null;
  return normalizeDailyGoal(saved.goal);
}

/** Persist (or clear when null/invalid) today's optional question goal for the current local date. */
export function writeDailyGoal(goal, { today = localDate(), root = '', storage } = {}) {
  const key = dailyGoalStorageKey(root);
  const normalized = normalizeDailyGoal(goal);
  if (normalized === null) {
    removeKey(key, storage);
    return null;
  }
  writeJSON(key, { date: today, goal: normalized }, storage);
  return normalized;
}

/** React state synced with today's localStorage daily question goal. */
export function useDailyGoal({ root = '', today = localDate() } = {}) {
  const [goal, setGoalState] = useState(() => readDailyGoal({ today, root }));
  useEffect(() => {
    setGoalState(readDailyGoal({ today, root }));
  }, [today, root]);
  const setGoal = useCallback((next) => {
    const saved = writeDailyGoal(next, { today, root });
    setGoalState(saved);
    return saved;
  }, [today, root]);
  return [goal, setGoal];
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function attemptTimestampMs(attempt) {
  const raw = attempt?.timestamp ?? attempt?.at;
  if (raw === null || raw === undefined || raw === '') return NaN;
  return typeof raw === 'number' ? raw : Date.parse(raw);
}

function clampElapsedMs(raw) {
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.min(MAX_CARD_ELAPSED_MS, Math.max(MIN_CARD_ELAPSED_MS, num));
}

/**
 * Pure calculator for today's completed questions, live pace (cards / pomodoro),
 * and remaining pomodoros + wall-clock time including breaks.
 */
export function computeTodayPace({
  attempts = [],
  summary = null,
  goal = null,
  focusMinutes: focusProp = 25,
  breakMinutes: breakProp = 5,
  now = Date.now(),
  today: todayProp,
  timeZone,
} = {}) {
  const today = todayProp || (timeZone ? dayInTimeZone(now, timeZone) : localDate(new Date(now)));
  const focusMinutes = Math.max(1, Math.round(Number(focusProp) || 25));
  const breakMinutes = Math.max(0, Math.round(Number(breakProp) || 5));

  let todayCount = 0;
  let todaySampleCount = 0;
  let todayMed = null;
  let weekSampleCount = 0;
  let weekMed = null;

  const useSummary = !timeZone && summary && typeof summary === 'object' && summary.date === today && Number.isFinite(Number(summary.todayCount));
  if (useSummary) {
    todayCount = Math.max(0, Math.round(Number(summary.todayCount) || 0));
    todaySampleCount = Math.max(0, Math.round(Number(summary.todaySampleCount) || 0));
    todayMed = Number.isFinite(Number(summary.todayMedianMs)) && Number(summary.todayMedianMs) > 0 ? Number(summary.todayMedianMs) : null;
    weekSampleCount = Math.max(0, Math.round(Number(summary.weekSampleCount) || 0));
    weekMed = Number.isFinite(Number(summary.weekMedianMs)) && Number(summary.weekMedianMs) > 0 ? Number(summary.weekMedianMs) : null;
  } else {
    const weekDays = new Set(recentLocalDays(today, 7));
    const todayElapsed = [];
    const priorWeekElapsed = [];

    for (const attempt of Array.isArray(attempts) ? attempts : []) {
      if (!attempt || attempt.voidedAt || attempt.implicit || attempt.imported) continue;
      const ts = attemptTimestampMs(attempt);
      if (!Number.isFinite(ts)) continue;
      const day = timeZone ? dayInTimeZone(ts, timeZone) : localDate(new Date(ts));
      if (!day) continue;
      const elapsed = clampElapsedMs(attempt.elapsed_ms);
      if (day === today) {
        todayCount += 1;
        if (elapsed !== null) todayElapsed.push(elapsed);
      } else if (weekDays.has(day) && elapsed !== null) {
        priorWeekElapsed.push(elapsed);
      }
    }
    todaySampleCount = todayElapsed.length;
    todayMed = median(todayElapsed);
    weekSampleCount = priorWeekElapsed.length;
    weekMed = median(priorWeekElapsed);
  }

  let medianElapsedMs = COLD_START_ELAPSED_MS;
  let paceSource = 'cold-start';
  let preliminary = true;

  if (todaySampleCount >= BLEND_MIN_TODAY_SAMPLES && todayMed !== null) {
    medianElapsedMs = todayMed;
    paceSource = 'today';
    preliminary = false;
  } else if (todaySampleCount > 0 && todayMed !== null) {
    const weight = todaySampleCount / BLEND_MIN_TODAY_SAMPLES;
    const baseMed = weekSampleCount > 0 && weekMed !== null ? weekMed : COLD_START_ELAPSED_MS;
    medianElapsedMs = weight * todayMed + (1 - weight) * baseMed;
    paceSource = 'blended';
    preliminary = todaySampleCount + weekSampleCount < BLEND_MIN_TODAY_SAMPLES;
  } else if (weekSampleCount > 0 && weekMed !== null) {
    if (weekSampleCount >= BLEND_MIN_TODAY_SAMPLES) {
      medianElapsedMs = weekMed;
      preliminary = false;
    } else {
      const weight = weekSampleCount / BLEND_MIN_TODAY_SAMPLES;
      medianElapsedMs = weight * weekMed + (1 - weight) * COLD_START_ELAPSED_MS;
      preliminary = true;
    }
    paceSource = 'week';
  }

  const medianElapsedMin = medianElapsedMs / 60_000;
  const cardsPerPomodoro = Math.max(1, Math.round(focusMinutes / medianElapsedMin));
  const normalizedGoal = normalizeDailyGoal(goal);

  let remainingCards = null;
  let remainingPomodoros = null;
  let wallClockMinutes = null;
  let goalMet = false;

  if (normalizedGoal !== null) {
    remainingCards = Math.max(0, normalizedGoal - todayCount);
    goalMet = remainingCards === 0;
    if (goalMet) {
      remainingPomodoros = 0;
      wallClockMinutes = 0;
    } else {
      const rawPomodoros = remainingCards / cardsPerPomodoro;
      remainingPomodoros = Math.max(0.5, Math.round(rawPomodoros * 2) / 2);
      wallClockMinutes = Math.round(remainingPomodoros * (focusMinutes + breakMinutes));
    }
  }

  return {
    today,
    todayCount,
    todaySampleCount,
    weekSampleCount,
    focusMinutes,
    breakMinutes,
    medianElapsedMs,
    medianElapsedMin,
    cardsPerPomodoro,
    paceSource,
    preliminary,
    goal: normalizedGoal,
    remainingCards,
    remainingPomodoros,
    wallClockMinutes,
    goalMet,
  };
}

/** Format pomodoro count cleanly: 2 -> "2", 2.5 -> "2.5", 0.5 -> "0.5". */
export function formatPomodoroCount(count) {
  if (!Number.isFinite(count) || count < 0) return '0';
  return Number.isInteger(count) ? String(count) : count.toFixed(1);
}

/** Format wall-clock minutes using existing calm StudyHub duration phrases. */
export function formatWallClockMinutes(minutes) {
  const total = Math.max(1, Math.round(Number(minutes) || 0));
  if (total < 60) return uiFormat('{0} 分钟', [total]);
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? uiFormat('{0} 小时 {1} 分', [hours, rest]) : uiFormat('{0} 小时', [hours]);
}

/** Plain, calm 1-line summary of today's progress, live speed, and remaining pomodoros. */
export function formatTodayPaceLine(pace) {
  if (!pace) return '';
  const speedPart = pace.preliminary
    ? uiFormat('当前约 {0} 题/番茄（初步）', [pace.cardsPerPomodoro])
    : uiFormat('当前约 {0} 题/番茄', [pace.cardsPerPomodoro]);

  if (pace.goal !== null) {
    const progressPart = uiFormat('今日 {0} / {1} 题', [pace.todayCount, pace.goal]);
    if (pace.goalMet) {
      return joinMeta([progressPart, ui('今日目标已达成')]);
    }
    const remainingPart = uiFormat('还需约 {0} 个番茄（含休息约 {1}）', [
      formatPomodoroCount(pace.remainingPomodoros),
      formatWallClockMinutes(pace.wallClockMinutes),
    ]);
    return joinMeta([progressPart, speedPart, remainingPart]);
  }

  if (pace.todayCount > 0) {
    return joinMeta([uiFormat('今日已刷 {0} 题', [pace.todayCount]), speedPart]);
  }
  return ui('设定今日题量目标，可实时估算还需几个番茄。');
}
