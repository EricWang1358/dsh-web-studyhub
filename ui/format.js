import { ui, uiFormat, uiLocale } from './i18n.js';

/* How the panel writes dates, times, lengths, sizes and numbers. Everything follows the interface language (uiLocale);
   nothing here reads the browser's own locale, so one screen never mixes two. Missing or invalid input gives ''
   (or 0:00 / 0 B for the clock and the size), never "NaN" or "Invalid Date". */

const DATE_SHAPES = {
  // Oct 4, 2026, 08:05 AM  /  2026年10月4日 08:05
  short: { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' },
  // Oct 4, 2026  /  2026年10月4日
  day: { year: 'numeric', month: 'short', day: 'numeric' },
  // 10/4, 08:05 AM  /  10/4 08:05: a moment inside the current year, for logs and histories
  stamp: { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' },
  // 2026/10/4  /  10/4/2026: the plain numeric date
  date: { year: 'numeric', month: 'numeric', day: 'numeric' },
  // Sun, Oct 4  /  10月4日周日: a day heading inside the current year; weekdayYear adds the year
  weekday: { weekday: 'short', month: 'short', day: 'numeric' },
  weekdayYear: { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' },
  // October 4 Sun  /  10月4日周日: today's date as a heading
  longDay: { month: 'long', day: 'numeric', weekday: 'short' },
};

const timeOf = (value) => {
  if (value === null || value === undefined || value === '') return NaN;
  return value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
};

/** A date or moment (ISO text, timestamp or Date) in one of the shapes above; 'short' by default. */
export function formatDateTime(value, shape = 'short') {
  const time = timeOf(value);
  if (!Number.isFinite(time)) return '';
  return new Date(time).toLocaleString(uiLocale(), DATE_SHAPES[shape] || DATE_SHAPES.short);
}

/** A day heading: weekday, month and day, with the year only when it is not the current one. `now` is injectable for tests. */
export const formatDay = (value, now = new Date()) => {
  const time = timeOf(value);
  return Number.isFinite(time) ? formatDateTime(time, new Date(time).getFullYear() === now.getFullYear() ? 'weekday' : 'weekdayYear') : '';
};

export { formatClock, formatIndex, isoDay } from './clock.js';

/** A length in the words a person would say: "4 分 20 秒", "45 秒", "1 小时 5 分". Rounded to the second; '' when missing. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 1) return ui('不到 1 秒');
  if (seconds < 60) return uiFormat('{0} 秒', [seconds]);
  const minutes = Math.floor(seconds / 60), rest = seconds % 60;
  if (minutes < 60) return rest ? uiFormat('{0} 分 {1} 秒', [minutes, rest]) : uiFormat('{0} 分钟', [minutes]);
  const hours = Math.floor(minutes / 60), left = minutes % 60;
  return left ? uiFormat('{0} 小时 {1} 分', [hours, left]) : uiFormat('{0} 小时', [hours]);
}

/** Time spent so far, for something still running: "45 秒", "2 分 5 秒", "1 小时 2 分". Rounded down, like the clock. */
export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000)), minutes = Math.floor(total / 60);
  if (!minutes) return uiFormat('{0} 秒', [total]);
  if (minutes < 60) return uiFormat('{0} 分 {1} 秒', [minutes, total % 60]);
  return uiFormat('{0} 小时 {1} 分', [Math.floor(minutes / 60), minutes % 60]);
}

/** "刚刚", "3 分钟前", "2 小时前" within a day; a date and time after that. `now` is injectable for tests and shared clocks. */
export function formatAgo(value, now = Date.now()) {
  const time = timeOf(value);
  if (!Number.isFinite(time)) return '';
  const minutes = Math.floor((now - time) / 60_000);
  if (minutes < 1) return ui('刚刚');
  if (minutes < 60) return minutes === 1 ? ui('1 分钟前') : uiFormat('{0} 分钟前', [minutes]);
  if (minutes < 24 * 60) return minutes < 120 ? ui('1 小时前') : uiFormat('{0} 小时前', [Math.floor(minutes / 60)]);
  return formatDateTime(time, 'stamp');
}

/** The parts of one meta line ("录音时长 3 分钟 · 已校对"), the empty ones left out, joined by the middle dot every line of that kind uses. Each part is its own translated sentence. */
export const joinMeta = (parts) => parts.filter(part => part !== undefined && part !== null && part !== false && part !== '').join(META_DOT);
/** The separator itself, for a part that is appended on its own (a <small> after a label). It is punctuation, not a sentence: not translated. */
export const META_DOT = ' · ';
/** Short items in one line: "第 1 步、第 2 步" / "Step 1, Step 2". */
export const formatList = (items) => items.join(ui('、'));
/** Clauses of one sentence: "原因甲；原因乙" / "reason a; reason b". */
export const formatClauses = (items) => items.join(ui('；'));

const formatters = new Map();
/** A number in the interface language; `options` are Intl.NumberFormat's. '' for anything that is not a finite number. */
export function formatNumber(value, options) {
  const number = value === null || value === '' ? NaN : Number(value);
  if (!Number.isFinite(number)) return '';
  const key = `${uiLocale()}|${options ? JSON.stringify(options) : ''}`;
  if (!formatters.has(key)) formatters.set(key, new Intl.NumberFormat(uiLocale(), options));
  return formatters.get(key).format(number);
}

const UNITS = ['B', 'KB', 'MB', 'GB'];
/** A size: 1024-based, one decimal below 100 (a trailing .0 is dropped), none from 100 up ("900 B", "1.5 KB", "23.5 MB", "820 MB", "1.3 GB"). The one style for every file size. */
export function formatBytes(bytes) {
  let value = Math.max(0, Number(bytes) || 0), unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) { value /= 1024; unit += 1; }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${formatNumber(value, { maximumFractionDigits: digits, useGrouping: false })} ${UNITS[unit]}`;
}

/** The learner's own IANA time zone (their calendar days decide "today"); undefined when the browser cannot say. */
export function ownTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; }
}
