import React, { useMemo } from 'react';
import { ui } from '../i18n.js';
import { useInjectCss } from '../shared.js';
import css from './desk-atelier.css';

const DIAL_SIZE = 200;
const DIAL_CENTER = 100;
const DIAL_RADIUS = 80;
const DIAL_TICK_OUTER = 93;
const DIAL_TICK_MINOR_INNER = 90;
const DIAL_TICK_MAJOR_INNER = 86;

/** Pure SVG arc geometry helper for unit tests and FocusRitualDial rendering. */
export function dialArcMetrics(progress, radius = DIAL_RADIUS) {
  const safeRadius = Number.isFinite(radius) && radius > 0 ? radius : DIAL_RADIUS;
  const clamped = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
  const circumference = 2 * Math.PI * safeRadius;
  const dashOffset = circumference * (1 - clamped);
  const angleRad = clamped * 2 * Math.PI - Math.PI * 0.5;
  const tipX = DIAL_CENTER + safeRadius * Math.cos(angleRad);
  const tipY = DIAL_CENTER + safeRadius * Math.sin(angleRad);
  return {
    circumference,
    clamped,
    dashOffset,
    tipX,
    tipY,
  };
}

const DIAL_TICKS = Object.freeze(Array.from({ length: 60 }, (_, index) => {
  const major = index % 5 === 0;
  const angle = (index / 60) * 2 * Math.PI - Math.PI * 0.5;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const inner = major ? DIAL_TICK_MAJOR_INNER : DIAL_TICK_MINOR_INNER;
  return {
    index,
    major,
    x1: Number((DIAL_CENTER + inner * cos).toFixed(2)),
    y1: Number((DIAL_CENTER + inner * sin).toFixed(2)),
    x2: Number((DIAL_CENTER + DIAL_TICK_OUTER * cos).toFixed(2)),
    y2: Number((DIAL_CENTER + DIAL_TICK_OUTER * sin).toFixed(2)),
  };
}));

/** Analog SVG Ink-Dial inspired by Pomotroid: crisp tick bezel + stroke-dashoffset ink progress arc. */
export default function FocusRitualDial({
  remainingLabel,
  progress = 0,
  mode = 'work',
  state = 'idle',
  size = 'compact',
  clockClassName = 'desk-dial__clock',
  clockState,
  caption = '',
}) {
  useInjectCss(css, 'study-desk-atelier');
  const metrics = useMemo(() => dialArcMetrics(progress, DIAL_RADIUS), [progress]);
  const isIdle = state === 'idle';
  const showTip = !isIdle && metrics.clamped > 0.008 && metrics.clamped < 0.995;
  const tone = state === 'paused'
    ? 'paused'
    : (mode === 'break' || state === 'finished')
      ? 'success'
      : isIdle
        ? 'idle'
        : 'accent';

  const percent = Math.round(metrics.clamped * 100);

  return (
    <div
      className={`desk-dial desk-dial--${size}`}
      data-dial-tone={tone}
      data-dial-state={state}
      role={isIdle ? undefined : 'progressbar'}
      aria-label={isIdle ? undefined : ui('专注倒计时进度')}
      aria-valuemin={isIdle ? undefined : 0}
      aria-valuemax={isIdle ? undefined : 100}
      aria-valuenow={isIdle ? undefined : percent}
    >
      <svg
        className="desk-dial__svg"
        viewBox={`0 0 ${DIAL_SIZE} ${DIAL_SIZE}`}
        aria-hidden="true"
      >
        <g className="desk-dial__ticks">
          {DIAL_TICKS.map((tick) => (
            <line
              key={tick.index}
              className={tick.major ? 'desk-dial__tick desk-dial__tick--major' : 'desk-dial__tick'}
              x1={tick.x1}
              y1={tick.y1}
              x2={tick.x2}
              y2={tick.y2}
            />
          ))}
        </g>
        <circle
          className="desk-dial__track"
          cx={DIAL_CENTER}
          cy={DIAL_CENTER}
          r={DIAL_RADIUS}
        />
        {!isIdle && (
          <circle
            className="desk-dial__arc"
            cx={DIAL_CENTER}
            cy={DIAL_CENTER}
            r={DIAL_RADIUS}
            strokeDasharray={metrics.circumference.toFixed(2)}
            strokeDashoffset={metrics.dashOffset.toFixed(2)}
            transform={`rotate(-90 ${DIAL_CENTER} ${DIAL_CENTER})`}
          />
        )}
        {showTip && (
          <circle
            className="desk-dial__tip"
            cx={metrics.tipX.toFixed(2)}
            cy={metrics.tipY.toFixed(2)}
            r={size === 'stage' ? 4.2 : 3.6}
          />
        )}
      </svg>
      <div className="desk-dial__center">
        <div
          className={clockClassName}
          data-timer-state={clockState}
        >
          {remainingLabel}
        </div>
        {caption && <span className="desk-dial__caption">{caption}</span>}
      </div>
    </div>
  );
}
