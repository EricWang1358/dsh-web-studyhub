import React from 'react';
import { Tooltip } from '../components/index.js';
import { cx } from '../components/css.js';
import { useOptionalAppSelector } from '../app/app-context.js';
import { useInjectCss } from '../shared.js';
import { formatPaceLine } from './format-pace.js';
import css from './pace-meta.css';

/**
 * Calm, single-line plain-language mastery ETA ("按近几天进度，大概啥时候能学会").
 * Renders as a subtle typographic line with a brief breakdown on hover/focus via `<Tooltip layer>`.
 * When `inline` is true (e.g. inside a button row like `DeckRow`), renders a non-focusable `<span>`
 * so interactive elements are never nested.
 */
export function PaceMeta({
  variant = 'course',
  forecast = null,
  pace = null,
  asOf = null,
  overrideDailyCards = null,
  uncoveredPoints = null,
  focusMinutes = null,
  hideMastered = false,
  inline = false,
  className = '',
}) {
  useInjectCss(css, 'study-pace-meta');
  const customWorkMinutes = useOptionalAppSelector((state) => {
    const work = state.board?.state?.board?.timerPrefs?.workMinutes;
    return Number.isFinite(Number(work)) && Number(work) > 0 ? Number(work) : null;
  });
  const formatted = formatPaceLine(variant, forecast, pace, {
    asOf,
    overrideDailyCards,
    uncoveredPoints,
    focusMinutes: focusMinutes ?? customWorkMinutes,
    hideMastered,
  });
  if (!formatted) return null;

  const classes = cx(
    'pace-meta',
    inline && 'pace-meta--inline',
    formatted.isMastered && 'pace-meta--mastered',
    formatted.behindExam && 'pace-meta--exam',
    className,
  );

  if (inline) {
    const inner = <span className={classes} data-pace-meta={variant}>{formatted.text}</span>;
    return formatted.tooltip ? <Tooltip layer content={formatted.tooltip}>{inner}</Tooltip> : inner;
  }

  return (
    <p className={classes} data-pace-meta={variant}>
      {formatted.tooltip ? (
        <Tooltip layer content={formatted.tooltip}>
          <span className="pace-meta__text" tabIndex={0}>{formatted.text}</span>
        </Tooltip>
      ) : (
        <span className="pace-meta__text">{formatted.text}</span>
      )}
    </p>
  );
}

export default PaceMeta;
