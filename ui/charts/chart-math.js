import { isoDay } from '../clock.js';
/* Pure helpers behind the dashboard charts (plain inline SVG, no chart
   library). Nothing here touches React or the DOM, so it is unit-tested. */

/** Linear map domain -> range. Extrapolates; a flat domain maps to the middle of the range. */
export function linearScale([d0, d1], [r0, r1]) {
  if (d1 === d0) return () => (r0 + r1) / 2;
  const k = (r1 - r0) / (d1 - d0);
  return (value) => r0 + (value - d0) * k;
}

const NICE_STEPS = [1, 2, 5, 10];
/** Round tick values 0..top (top >= max) with about `target` intervals. */
export function niceTicks(max, target = 5) {
  if (!(max > 0)) return [0, 1];
  const raw = max / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = NICE_STEPS.find((s) => raw / pow <= s) * pow;
  const ticks = [];
  for (let value = 0; value < max + step; value += step) {
    ticks.push(Math.round(value * 1e6) / 1e6);
    if (value >= max) break;
  }
  return ticks;
}

const keyOf = isoDay;
const parseKey = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
};

/** `n` local date keys ending at `todayKey`, oldest first. */
export function recentDays(todayKey, n) {
  const end = parseKey(todayKey);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(end);
    d.setDate(d.getDate() - (n - 1 - i));
    return keyOf(d);
  });
}

/** Stats trend rows (studied days only) on a continuous axis; missing days stay empty so lines break there. */
export function fillTrend(trend, todayKey, n) {
  const byDate = new Map((trend || []).map((row) => [row.date, row]));
  return recentDays(todayKey, n).map((date) => {
    const row = byDate.get(date);
    return {
      date,
      gradedAvg: row?.gradedAvg ?? null,
      gradedCount: row?.gradedCount ?? 0,
      selfAvg: row?.selfAvg ?? null,
      selfCount: row?.selfCount ?? 0,
    };
  });
}

/** Contiguous runs of points that have a y value. */
export function lineRuns(points) {
  const runs = [];
  let run = null;
  for (const point of points) {
    if (point.y == null) { run = null; continue; }
    if (!run) { run = []; runs.push(run); }
    run.push(point);
  }
  return runs;
}

const round = (n) => Math.round(n * 100) / 100;
/** SVG path for a series with gaps: one subpath per run of 2+ points (lone points are drawn as dots). */
export function linePath(points) {
  return lineRuns(points)
    .filter((run) => run.length > 1)
    .map((run) => run.map((p, i) => `${i ? 'L' : 'M'}${round(p.x)} ${round(p.y)}`).join(''))
    .join('');
}

/** About `count` evenly spaced indexes over `length` items, always starting at 0 and ending on the last. */
export function evenTicks(length, count) {
  if (length <= 0) return [];
  if (length <= count) return Array.from({ length }, (_, i) => i);
  return Array.from({ length: count }, (_, i) =>
    i === count - 1 ? length - 1 : Math.floor((i * (length - 1)) / (count - 1)));
}

/** "2026-10-02" -> "10/2" */
export function dateLabel(key) {
  const [, m, d] = key.split('-').map(Number);
  return `${m}/${d}`;
}

const SEPARATOR = /\s*[｜|]\s*/;
const COUNT_SEGMENT = /^\d+\s*(题|道|questions?|cards?)?$/i;
/** Deck titles like "Course｜期末综合卷04｜90题": drop the shared course prefix and the question count. */
export function shortDeckTitles(titles) {
  const parts = titles.map((title) => String(title ?? '').split(SEPARATOR).filter(Boolean));
  const trimmed = parts.map((segments) => {
    const last = segments.at(-1);
    return segments.length > 1 && COUNT_SEGMENT.test(last) ? segments.slice(0, -1) : segments;
  });
  const first = trimmed[0]?.[0];
  const shared = trimmed.length > 0 && trimmed.every((segments) => segments.length > 1 && segments[0] === first);
  return trimmed.map((segments, i) => {
    const kept = shared ? segments.slice(1) : segments;
    const unchanged = !shared && kept.length === parts[i].length;
    return unchanged ? titles[i] : kept.join('｜');
  });
}
