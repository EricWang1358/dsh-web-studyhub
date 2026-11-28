import React, { useId, useMemo, useRef, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { useInjectCss } from '../shared.js';
import { useAppearance } from '../use-appearance.js';
import { useLiveEffect } from '../use-async.js';
import { useStudyBusy } from '../study-context.jsx';
import { dateLabel } from './chart-math.js';
import { clamp, hashString, round1, useInkPalette } from '../graph-sketch/ink-palette.js';
import tideCss from './forecast-tide.css';

/* FSRS «墨潮 · Ink Tide» Horizon for ForecastPanel.
   Pure Fritsch-Carlson monotone cubic Hermite spline (curveMonotoneX, ISC math)
   so the ink tide never overshoots or dips below zero on calm 0-due days, layered
   with warm ink-wash gradients and lazy-loaded roughjs calligraphic peak hatching. */

let roughPromise = null;
function loadRoughGenerator() {
  if (!roughPromise) {
    roughPromise = import('roughjs')
      .then((mod) => {
        const rough = mod?.default || mod;
        return typeof rough?.generator === 'function' ? rough.generator() : null;
      })
      .catch(() => null);
  }
  return roughPromise;
}

/**
 * Fritsch-Carlson / Steffen monotone cubic Hermite spline (curveMonotoneX).
 * Preserves monotonicity between consecutive samples so 0-due troughs stay flat
 * on the horizon baseline without dipping below zero.
 */
export function monotoneSplinePath(points, bounds = null) {
  if (!Array.isArray(points) || !points.length) return '';
  if (points.length === 1) return `M${round1(points[0].x)} ${round1(points[0].y)}`;
  const n = points.length;
  const h = new Array(n - 1);
  const m = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    h[i] = points[i + 1].x - points[i].x;
    m[i] = h[i] !== 0 ? (points[i + 1].y - points[i].y) / h[i] : 0;
  }
  const t = new Array(n).fill(0);
  t[0] = m[0];
  t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (m[i - 1] * m[i] <= 0) {
      t[i] = 0;
    } else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      t[i] = (w1 + w2) / (w1 / m[i - 1] + w2 / m[i]);
    }
  }
  const minY = bounds?.minY ?? -Infinity;
  const maxY = bounds?.maxY ?? Infinity;
  const parts = [`M${round1(points[0].x)} ${round1(points[0].y)}`];
  for (let i = 0; i < n - 1; i++) {
    const dx = h[i] / 3;
    const x1 = round1(points[i].x + dx);
    const y1 = round1(clamp(points[i].y + t[i] * dx, minY, maxY));
    const x2 = round1(points[i + 1].x - dx);
    const y2 = round1(clamp(points[i + 1].y - t[i + 1] * dx, minY, maxY));
    parts.push(`C${x1} ${y1}, ${x2} ${y2}, ${round1(points[i + 1].x)} ${round1(points[i + 1].y)}`);
  }
  return parts.join(' ');
}

/** Closed ink-wash area path beneath a monotone spline down to `baselineY`. */
export function monotoneAreaPath(points, baselineY, bounds = null) {
  if (!Array.isArray(points) || !points.length) return '';
  const top = monotoneSplinePath(points, bounds);
  const first = points[0];
  const last = points[points.length - 1];
  const base = round1(baselineY);
  return `${top} L${round1(last.x)} ${base} L${round1(first.x)} ${base} Z`;
}

/** Identify the peak surge day and longest calm 0-due window in the 14-day horizon. */
export function summarizeTideRhythm(days = []) {
  let peakIndex = -1;
  let peakCount = 0;
  let calmLength = 0;
  let calmStartIndex = -1;
  let curStart = -1;
  let curLen = 0;

  for (let i = 0; i < days.length; i++) {
    const count = Number(days[i]?.count) || 0;
    if (count > peakCount) {
      peakCount = count;
      peakIndex = i;
    }
    if (count === 0) {
      if (curStart < 0) curStart = i;
      curLen++;
      if (curLen > calmLength) {
        calmLength = curLen;
        calmStartIndex = curStart;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }

  return {
    peakIndex,
    peakCount,
    peakDate: peakIndex >= 0 ? (days[peakIndex]?.date || '') : '',
    calmLength,
    calmStartIndex,
    calmStartDate: calmStartIndex >= 0 ? (days[calmStartIndex]?.date || '') : '',
  };
}

/** Build calligraphic roughjs hachure crest halo and surge lines at the highest peak day. */
export function buildPeakHatchStrokes(peakPoint, baselineY, palette, roughGen, seed) {
  if (!peakPoint || !Number.isFinite(peakPoint.x) || !Number.isFinite(peakPoint.y)) return [];
  const { x, y } = peakPoint;
  const drop = Math.max(12, Math.min(34, (baselineY - y) * 0.45));
  const strokes = [];

  if (roughGen) {
    const crest = roughGen.ellipse(round1(x), round1(y + 4), 34, 15, {
      stroke: palette.accent,
      strokeWidth: 0.95,
      fill: palette.accent,
      fillStyle: 'hachure',
      hachureAngle: -42,
      hachureGap: 4.2,
      roughness: 1.1,
      disableMultiStroke: true,
      fixedDecimalPlaceDigits: 1,
      seed,
    });
    for (const p of roughGen.toPaths(crest)) {
      strokes.push({ d: p.d, stroke: p.stroke || palette.accent, strokeWidth: p.strokeWidth ?? 0.9, fill: p.fill || 'none', opacity: 0.56 });
    }
    for (let k = -1; k <= 1; k++) {
      const lx = round1(x + k * 7);
      const line = roughGen.line(lx, round1(y + 6), round1(lx + k * 3), round1(y + 6 + drop * (k === 0 ? 1 : 0.72)), {
        stroke: palette.inkMuted,
        strokeWidth: 0.85,
        roughness: 1.0,
        disableMultiStroke: true,
        fixedDecimalPlaceDigits: 1,
        seed: seed + (k + 2) * 19,
      });
      for (const p of roughGen.toPaths(line)) {
        strokes.push({ d: p.d, stroke: p.stroke || palette.inkMuted, strokeWidth: p.strokeWidth ?? 0.85, fill: 'none', opacity: 0.36 });
      }
    }
    return strokes;
  }

  // Deterministic vector fallback before roughjs resolves (and during SSR)
  strokes.push({
    d: `M${round1(x - 14)} ${round1(y + 4)} Q${round1(x)} ${round1(y - 5)} ${round1(x + 14)} ${round1(y + 4)}`,
    stroke: palette.accent,
    strokeWidth: 1.1,
    fill: 'none',
    opacity: 0.62,
  });
  return strokes;
}

export default function ForecastInkTide({
  days = [],
  total = 0,
  width = 640,
  height = 220,
  margins,
  ticks = [],
  yScale,
  band = 40,
  labelAt,
  active,
  onActiveChange,
  onStart,
  roughGenerator = null,
}) {
  useInjectCss(tideCss, 'study-forecast-tide');
  const [appearance] = useAppearance();
  const minimal = appearance.minimal === 'on';
  const busy = useStudyBusy();
  const plotRef = useRef(null);
  const titleId = useId();
  const gradId = useId();
  const [loadedRough, setLoadedRough] = useState(null);
  const palette = useInkPalette(plotRef);

  useLiveEffect((isLive) => {
    if (minimal || roughGenerator) return;
    loadRoughGenerator().then((gen) => {
      if (isLive() && gen) setLoadedRough(gen);
    });
  }, [minimal, roughGenerator]);

  const activeRough = minimal ? null : (roughGenerator || loadedRough);
  const L = margins?.L ?? 34;
  const R = margins?.R ?? 8;
  const T = margins?.T ?? 22;
  const B = margins?.B ?? 28;
  const baselineY = height - B;

  const points = useMemo(
    () => days.map((d, i) => ({
      x: round1(L + band * (i + 0.5)),
      y: round1(d.count ? yScale(d.count) : baselineY),
      day: d,
      index: i,
    })),
    [days, L, band, yScale, baselineY],
  );

  const echoPoints = useMemo(
    () => points.map((pt) => ({
      x: pt.x,
      y: round1(baselineY - (baselineY - pt.y) * 0.62),
    })),
    [points, baselineY],
  );

  const bounds = useMemo(() => ({ minY: T, maxY: baselineY }), [T, baselineY]);
  const areaD = useMemo(() => monotoneAreaPath(points, baselineY, bounds), [points, baselineY, bounds]);
  const echoAreaD = useMemo(() => monotoneAreaPath(echoPoints, baselineY, bounds), [echoPoints, baselineY, bounds]);
  const crestD = useMemo(() => monotoneSplinePath(points, bounds), [points, bounds]);

  const rhythm = useMemo(() => summarizeTideRhythm(days), [days]);
  const peakPoint = rhythm.peakIndex >= 0 ? points[rhythm.peakIndex] : null;
  const peakSeed = hashString(`${rhythm.peakDate}:${rhythm.peakCount}:${total}`);
  const peakHatch = useMemo(
    () => (!minimal && rhythm.peakCount > 0 ? buildPeakHatchStrokes(peakPoint, baselineY, palette, activeRough, peakSeed) : []),
    [minimal, rhythm.peakCount, peakPoint, baselineY, palette, activeRough, peakSeed],
  );

  const dayName = (d, i) => (i === 0 ? ui('今天') : dateLabel(d.date));
  const peakDayLabel = rhythm.peakIndex === 0 ? ui('今天') : dateLabel(rhythm.peakDate);
  const calmDayLabel = rhythm.calmStartIndex === 0 ? ui('今天') : dateLabel(rhythm.calmStartDate);

  return (
    <div ref={plotRef} className="forecast-tide" data-testid="forecast-ink-tide">
      <svg
        className="forecast-tide__svg"
        role="img"
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        aria-labelledby={titleId}
        onMouseLeave={() => onActiveChange?.(null)}
      >
        <title id={titleId}>{uiFormat('未来 14 天到期复习墨潮曲线，共 {0} 题', [total])}</title>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={palette.accent} stopOpacity={palette.isLight ? '0.26' : '0.32'} />
            <stop offset="48%" stopColor={palette.info} stopOpacity={palette.isLight ? '0.18' : '0.22'} />
            <stop offset="100%" stopColor={palette.info} stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {ticks.map((t) => (
          <g key={t}>
            <line className="forecast-tide__grid" x1={L} x2={width - R} y1={yScale(t)} y2={yScale(t)} />
            <text className="forecast-tide__axis" x={L - 8} y={yScale(t) + 4} textAnchor="end">{t}</text>
          </g>
        ))}

        <line className="forecast-tide__horizon" x1={L} x2={width - R} y1={baselineY} y2={baselineY} />

        {!minimal && echoAreaD && <path className="forecast-tide__echo" d={echoAreaD} />}
        {areaD && <path className="forecast-tide__area" d={areaD} fill={`url(#${gradId})`} stroke="none" />}
        {crestD && <path className="forecast-tide__crest" d={crestD} />}

        {peakHatch.length > 0 && (
          <g className="forecast-tide__hatch" aria-hidden="true">
            {peakHatch.map((stroke, idx) => (
              <path
                key={`hatch-${idx}`}
                d={stroke.d}
                stroke={stroke.stroke}
                strokeWidth={stroke.strokeWidth}
                fill={stroke.fill}
                strokeLinecap="round"
                opacity={stroke.opacity}
              />
            ))}
          </g>
        )}

        {active != null && points[active] && (
          <line
            className="forecast-tide__peak-guide"
            x1={points[active].x}
            x2={points[active].x}
            y1={T}
            y2={baselineY}
          />
        )}

        {points.map((pt) => {
          const { day: d, index: i, x: cx, y: cy } = pt;
          const action = Boolean(onStart && !busy && d.cards?.length > 0);
          const label = uiFormat('{0} · {1} 题', [i === 0 ? ui('今天（含逾期）') : dateLabel(d.date), d.count]);
          const isToday = i === 0;
          const isPeak = i === rhythm.peakIndex && d.count > 0;
          const dropClass = `forecast-tide__drop${isToday ? ' forecast-tide__drop--today' : d.count === 0 ? ' forecast-tide__drop--zero' : ''}`;
          return (
            <g
              key={d.date}
              className="forecast-tide__day"
              data-tide-day={d.date}
              {...(action ? { role: 'button', tabIndex: 0, 'aria-label': `${label} · ${isToday ? ui('开始复习') : ui('提前复习')}` } : {})}
              onMouseEnter={() => onActiveChange?.(i)}
              onFocus={() => onActiveChange?.(i)}
              onBlur={() => onActiveChange?.(null)}
              onClick={action ? () => onStart(d) : undefined}
              onKeyDown={action ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onStart(d);
                }
              } : undefined}
            >
              <rect className="forecast-tide__hit" x={cx - band / 2} y={T} width={band} height={baselineY - T} />
              <circle className={dropClass} cx={cx} cy={cy} r={isToday || isPeak ? 5 : d.count > 0 ? 3.8 : 2.6} />
              {d.count > 0 && (isPeak || isToday || active === i) && (
                <text className="forecast-tide__val" x={cx} y={cy - 9} textAnchor="middle">{d.count}</text>
              )}
            </g>
          );
        })}

        {days.map((d, i) => labelAt?.has(i) && (
          <text
            key={`l${d.date}`}
            className={`forecast-tide__axis${i === 0 ? ' forecast-tide__axis--today' : ''}`}
            x={L + band * (i + 0.5)}
            y={height - 8}
            textAnchor="middle"
          >
            {dayName(d, i)}
          </text>
        ))}
      </svg>

      {rhythm.peakCount > 0 && (
        <p className="forecast-tide__insight" data-testid="forecast-tide-insight">
          <span className="forecast-tide__insight-peak">
            {uiFormat('峰期：{0}（{1} 题）', [peakDayLabel, rhythm.peakCount])}
          </span>
          <span>
            {rhythm.calmLength >= 2
              ? uiFormat('留白窗口：{0} 起连歇 {1} 天，适合补新或休整', [calmDayLabel, rhythm.calmLength])
              : ui('未来 14 天节奏平稳，每天都有少量回顾。')}
          </span>
        </p>
      )}
    </div>
  );
}
