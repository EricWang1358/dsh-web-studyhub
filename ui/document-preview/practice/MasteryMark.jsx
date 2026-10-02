import React from 'react';
import { uiFormat } from '../../i18n.js';
import { useInjectCss } from '../../shared.js';
import { markLabel, masteryText } from './mastery-copy.js';
import css from './practice.css';

/* The mastery of some pages as a small mark. The state is carried by the SHAPE as well as the colour (dashed ring: no
   questions yet · ring: not started · quarter · half · filled with a tick), so it reads without colour; the words are in
   the accessible name and the tooltip. */
const RING = <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />;
const SHAPES = {
  none: <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 2.6" />,
  unlearned: RING,
  learning: <>{RING}<path d="M8 8V2.8A5.2 5.2 0 0 1 13.2 8z" fill="currentColor" /></>,
  familiar: <>{RING}<path d="M8 2.8A5.2 5.2 0 0 1 8 13.2z" fill="currentColor" /></>,
  mastered: <><circle cx="8" cy="8" r="6.6" fill="currentColor" /><path d="m5.1 8.2 2 2 3.8-4.1" fill="none" stroke="var(--mastery-ink)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></>,
};

/** `summary` from lib/material-summary.js (null: no questions); `title` names what it is the mastery of ("第 3 页"). */
export function MasteryMark({ summary, title = '', size = 14, className = '' }) {
  useInjectCss(css, 'study-reading-loop');
  const state = summary?.total ? summary.state : 'none', label = markLabel(title, summary);
  return <span className={`mastery-mark ${className}`.trim()} data-state={state} role="img" aria-label={label} title={label}>
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" focusable="false">{SHAPES[state] || SHAPES.none}</svg>
  </span>;
}

/** The mark with its words: "掌握 62% · 12 题", or "还没出题". */
export function MasteryLine({ summary, title = '', className = '' }) {
  useInjectCss(css, 'study-reading-loop');
  const state = summary?.total ? summary.state : 'none';
  return <span className={`mastery-line ${className}`.trim()} data-state={state}>
    <MasteryMark summary={summary} title={title} />
    <span className="mastery-line__text">{masteryText(summary)}{summary?.inactive > 0 && ` · ${uiFormat('含 {0} 道未激活课程的题', [summary.inactive])}`}</span>
  </span>;
}
