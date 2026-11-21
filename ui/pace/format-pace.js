/* Plain-language mastery ETA formatting for Slice / Deck / Course surfaces.
   Browser-safe, zero Node or ts-fsrs dependencies — works directly from the compact
   `paceForecast` projection cached in the library snapshot (or a full `forecastScope()` result). */

import { ui, uiFormat, uiIsEnglish } from '../i18n.js';

const MONTH_EN = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
const DEFAULT_CARD_SEC = 50;
const DEFAULT_FOCUS_MIN = 25;
const DEFAULT_REWORK = 1.25;
const DEFAULT_FLOOR = 17;

/** Format a pomodoro count without trailing `.0` (e.g. `1.5`, `6`, `25`). */
export function formatNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
}

/** Round pomodoro count cleanly (matches lib/pace-forecast.js roundPomodoros). */
function roundPomodoros(raw) {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  if (raw < 0.5) return 0.5;
  if (raw < 10) return Math.round(raw * 2) / 2;
  return Math.round(raw);
}

/** Add `days` to a local `YYYY-MM-DD` string and return `YYYY-MM-DD`, or null. */
export function addDaysIso(baseIso, days) {
  if (typeof baseIso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(baseIso)) return null;
  if (!Number.isFinite(Number(days))) return null;
  const [y, m, d] = baseIso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + Math.round(Number(days)));
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

/** Plain-language relative span (e.g. `约 2 周` / `~2 weeks`, `约 1 个月` / `~1 month`). */
export function formatPlainSpan(days) {
  const n = Math.max(0, Math.round(Number(days) || 0));
  if (n <= 1) return ui('约 1 天');
  if (n <= 6) return uiFormat('约 {0} 天', [n]);
  if (n <= 10) return ui('约 1 周');
  if (n <= 17) return ui('约 2 周');
  if (n <= 24) return ui('约 3 周');
  if (n <= 34) return ui('约 1 个月');
  if (n <= 52) return ui('约 1 个半月');
  if (n <= 75) return ui('约 2 个月');
  return uiFormat('约 {0} 个月', [Math.round(n / 30)]);
}

/** Plain-language ten-day calendar bucket (e.g. `12 月中旬` / `mid-Dec`). */
export function formatPlainDate(isoDate) {
  if (typeof isoDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return '';
  const [, month, day] = isoDate.split('-').map(Number);
  if (!month || month < 1 || month > 12 || !day) return '';
  const monthLabel = uiIsEnglish() ? MONTH_EN[month - 1] : String(month);
  if (day <= 10) return uiFormat('{0} 月上旬', [monthLabel]);
  if (day <= 20) return uiFormat('{0} 月中旬', [monthLabel]);
  return uiFormat('{0} 月下旬', [monthLabel]);
}

/**
 * Normalize a compact snapshot entry or full `forecastScope()` result, applying optional
 * `overrideDailyCards` (so UI can preview e.g. "按每天 100 题算") and `uncoveredPoints`.
 */
export function resolveForecastView(entry, pace = null, { asOf = null, overrideDailyCards = null, uncoveredPoints = null } = {}) {
  if (!entry || typeof entry !== 'object') return null;
  const status = entry.status || 'empty';
  const total = Number(entry.total ?? entry.totalCards ?? 0);
  const remaining = Number(entry.remaining ?? entry.remainingCards ?? 0);
  const passes = Number(entry.passes ?? entry.remainingRawPasses ?? 0);
  const pomodoros = Number(entry.pomodoros ?? entry.remainingPomodoros ?? 0);
  const hours = Number(entry.hours ?? entry.remainingHours ?? 0);
  const floor = Number(entry.floor ?? entry.spacingFloorDays ?? 0);
  const uncovered = uncoveredPoints != null
    ? Math.max(0, Math.floor(Number(uncoveredPoints) || 0))
    : Math.max(0, Math.floor(Number(entry.uncoveredPoints) || 0));

  const rework = Number(pace?.reworkFactor) || DEFAULT_REWORK;
  const cardSec = Number(pace?.medianCardSec) || DEFAULT_CARD_SEC;
  const focusMin = Number(pace?.focusMinutes) || DEFAULT_FOCUS_MIN;

  const override = Number(overrideDailyCards);
  const hasOverride = Number.isFinite(override) && override > 0 && remaining > 0;

  let days = entry.days ?? entry.calendarDays ?? null;
  let effectiveStatus = status;
  let etaDate = entry.etaStartDate || (asOf && days != null ? addDaysIso(asOf, days) : null);
  const effectiveDailyCards = hasOverride ? override : Number(entry.effectiveDailyCards ?? pace?.dailyAttempts ?? 0);
  const paceBasis = hasOverride
    ? 'target'
    : (entry.paceBasis || (status === 'cold-start' ? 'cold-start' : pace?.lowSample ? 'low-sample' : 'recent'));
  let exam = entry.exam || null;

  if (hasOverride) {
    const effectiveAttempts = Number(entry.effectiveAttempts) || Math.ceil(Math.max(1, passes || remaining * 2) * rework);
    const paceDays = effectiveAttempts / override;
    days = Math.max(Math.ceil(paceDays), floor);
    effectiveStatus = 'active';
    etaDate = asOf ? addDaysIso(asOf, days) : null;
    if (exam && exam.daysLeft > 0) {
      exam = { ...exam, behind: days > exam.daysLeft };
    }
  }

  return {
    status: effectiveStatus,
    total,
    remaining,
    pomodoros,
    hours,
    days,
    floor,
    etaDate,
    effectiveDailyCards,
    paceBasis,
    cardSec,
    focusMin,
    exam,
    uncoveredPoints: uncovered,
    isSlice: Boolean(entry.isSlice),
  };
}

/**
 * Lightweight slice mastery estimate from compact `paceForecast` (used by RoundSetup & Review summary).
 * Never scans raw cards or constructs FSRS engines on the client.
 */
export function buildSliceForecast({
  count = 0,
  range = 'mixed',
  passedCount = null,
  paceForecast = null,
  deckId = null,
  course = null,
} = {}) {
  const n = Math.max(0, Math.round(Number(count) || 0));
  if (n <= 0) return null;
  const pace = paceForecast?.pace || null;
  const cardSec = Number(pace?.medianCardSec) || DEFAULT_CARD_SEC;
  const focusMin = Number(pace?.focusMinutes) || DEFAULT_FOCUS_MIN;
  const rework = Number(pace?.reworkFactor) || DEFAULT_REWORK;
  const normalFloor = Number(paceForecast?.spacing?.normal) || DEFAULT_FLOOR;
  const focusFloor = Number(paceForecast?.spacing?.focus) || 10;

  let avgPassesLeft = 2.0;
  let floor = normalFloor;
  if (passedCount != null && Number.isFinite(Number(passedCount))) {
    // Round-complete summary: passed cards need ~2 more cross-day passes (~14d), missed cards need 3 (~17d).
    const passed = Math.max(0, Math.min(n, Math.round(Number(passedCount))));
    const missed = n - passed;
    avgPassesLeft = (passed * 2 + missed * 3) / n;
    floor = missed > 0 ? normalFloor : Math.max(focusFloor, Math.round(normalFloor * 0.8));
  } else if (range === 'new' || range === 'wrong') {
    avgPassesLeft = 3.0;
    floor = normalFloor;
  } else if (range === 'due') {
    avgPassesLeft = 1.5;
    floor = Math.max(focusFloor, Math.round(normalFloor * 0.75));
  } else {
    // Mixed round: scale by the scoped deck or course remaining-passes ratio when available.
    const scoped = (deckId && paceForecast?.decks?.[deckId])
      || (course && paceForecast?.courses?.[course])
      || paceForecast?.library;
    if (scoped?.remaining > 0 && scoped?.passes > 0) {
      avgPassesLeft = Math.min(3, Math.max(1, scoped.passes / scoped.remaining));
      if (scoped.floor > 0) floor = scoped.floor;
    }
  }

  const rawPasses = Math.round(n * avgPassesLeft);
  const effectiveAttempts = Math.ceil(rawPasses * rework);
  const remainingMinutes = (effectiveAttempts * cardSec) / 60;
  const pomodoros = roundPomodoros(remainingMinutes / focusMin);
  const hours = Math.max(0.1, Math.round((remainingMinutes / 60) * 10) / 10);
  const daily = Number(pace?.dailyAttempts) || 0;
  const days = daily > 0 ? Math.max(Math.ceil(effectiveAttempts / daily), floor) : floor;

  return {
    status: daily > 0 ? 'active' : 'cold-start',
    total: n,
    remaining: n,
    passes: rawPasses,
    pomodoros,
    hours,
    days,
    floor,
    isSlice: true,
  };
}

/** Build the hover Tooltip breakdown lines for a resolved forecast. */
export function formatPaceTooltip(view) {
  if (!view || view.status === 'empty') return '';
  if (view.status === 'mastered') {
    return uiFormat('每题在不同天稳过 3 次算学稳；当前 {0} 题均已达标。', [view.total]);
  }
  const lines = [];
  if (view.isSlice) {
    lines.push(uiFormat('本批约 {0} 题 · 预计约 {1} 小时（{2} 分钟/番茄）', [view.remaining, formatNumber(view.hours), view.focusMin]));
  } else {
    lines.push(uiFormat('剩余 {0}/{1} 题未学稳 · 预计约 {2} 小时（{3} 分钟/番茄）', [view.remaining, view.total, formatNumber(view.hours), view.focusMin]));
  }

  if (view.paceBasis === 'target' && view.effectiveDailyCards > 0) {
    lines.push(uiFormat('按目标每天 {0} 题预览 · 单题中位约 {1} 秒', [Math.round(view.effectiveDailyCards), view.cardSec]));
  } else if (view.effectiveDailyCards > 0) {
    const template = view.paceBasis === 'low-sample'
      ? '近 7 天初步节奏：日均约 {0} 题 · 单题中位约 {1} 秒'
      : '近 7 天节奏：日均约 {0} 题 · 单题中位约 {1} 秒';
    lines.push(uiFormat(template, [Math.max(1, Math.round(view.effectiveDailyCards)), view.cardSec]));
  } else {
    lines.push(uiFormat('尚无近 7 天作答记录，暂按单题约 {0} 秒估算。', [view.cardSec]));
  }

  if (view.floor > 0) {
    lines.push(uiFormat('每题在不同天稳过 3 次算学稳；含间隔复习至少 {0} 天。', [view.floor]));
  }

  if (view.exam && view.exam.daysLeft > 0) {
    if (view.exam.behind) {
      lines.push(uiFormat('距考试日 {0} 还有 {1} 天，每天约 {2} 个番茄可考前学稳。', [
        view.exam.date,
        view.exam.daysLeft,
        formatNumber(view.exam.requiredDailyPomodoros),
      ]));
    } else {
      lines.push(uiFormat('距考试日 {0} 还有 {1} 天，按当前节奏可从容学稳。', [
        view.exam.date,
        view.exam.daysLeft,
      ]));
    }
  }

  return lines.join('\n');
}

/**
 * Format 1 calm, plain-language mastery ETA line + hover breakdown for `slice | deck | course`.
 * Returns `null` when nothing should be displayed (e.g. empty scope or hidden mastered deck).
 */
export function formatPaceLine(variant, entry, pace = null, opts = {}) {
  const view = resolveForecastView(entry, pace, opts);
  if (!view || view.status === 'empty') return null;
  if (view.status === 'mastered' && opts.hideMastered) return null;

  const pomoStr = formatNumber(view.pomodoros);
  const span = formatPlainSpan(view.days ?? view.floor);
  let main = '';

  if (variant === 'slice') {
    main = view.status === 'mastered'
      ? ui('这批题目已基本学稳')
      : uiFormat('这批还需约 {0} 个番茄，间隔复习完{1}后稳固', [pomoStr, span]);
  } else if (variant === 'deck') {
    if (view.status === 'mastered') {
      main = ui('已学稳');
    } else if (view.status === 'cold-start') {
      main = uiFormat('约 {0} 个番茄 · 间隔复习至少{1}', [pomoStr, span]);
    } else {
      main = uiFormat('按最近进度{0}学稳 · 约 {1} 个番茄', [span, pomoStr]);
    }
  } else {
    // Course / library surface
    if (view.status === 'mastered') {
      main = ui('当前有题部分已基本学稳');
    } else if (view.status === 'cold-start') {
      main = uiFormat('还需约 {0} 个番茄 · 间隔复习至少{1}（多练几天后按进度估算日期）', [pomoStr, span]);
    } else {
      const plainDate = view.days >= 15 ? formatPlainDate(view.etaDate) : '';
      if (view.paceBasis === 'target') {
        const daily = Math.round(view.effectiveDailyCards);
        main = plainDate
          ? uiFormat('按每天 {0} 题算，大概 {1}学稳（约 {2} 个番茄）', [daily, plainDate, pomoStr])
          : uiFormat('按每天 {0} 题算，{1}后学稳（约 {2} 个番茄）', [daily, span, pomoStr]);
      } else {
        main = plainDate
          ? uiFormat('按近 7 天节奏，大概 {0}学稳（约 {1} 个番茄）', [plainDate, pomoStr])
          : uiFormat('按近 7 天节奏，{0}后学稳（约 {1} 个番茄）', [span, pomoStr]);
      }
    }
  }

  const extras = [];
  if (variant === 'course' && view.uncoveredPoints > 0) {
    extras.push(uiFormat('不含 {0} 个尚无题目的知识点', [view.uncoveredPoints]));
  }
  if (variant === 'course' && view.exam?.behind && view.status !== 'mastered') {
    extras.push(uiFormat('每天加到约 {0} 个番茄可考前学稳', [formatNumber(view.exam.requiredDailyPomodoros)]));
  }

  const text = extras.length ? [main, ...extras].join(' · ') : main;
  return {
    text,
    main,
    extras,
    tooltip: formatPaceTooltip(view),
    behindExam: Boolean(view.exam?.behind && view.status !== 'mastered'),
    isMastered: view.status === 'mastered',
    isColdStart: view.status === 'cold-start',
    view,
  };
}
