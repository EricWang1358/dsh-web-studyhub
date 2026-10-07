import React from 'react';
import Tooltip from '../components/Tooltip.jsx';
import { cx } from '../components/css.js';
import { explain } from './words.js';

/**
 * A hover explanation (hidden until hover or keyboard focus) from the table in ./words.js: one plain sentence and at most one line of
 * consequence. `children` is one element; a control (a button) is its own anchor, anything else (a badge, a heading, an icon) is wrapped in a
 * span the keyboard can reach (`focusable`; `label` names an icon-only anchor). An unknown key explains nothing and leaves the child as it is.
 */
export default function Explain({ k, children, focusable = false, label, className, placement = 'bottom-start' }) {
  const lines = explain(k);
  if (!lines) return children;
  const anchor = focusable ? <span tabIndex={0} className={cx('exam-prep-explain', className)} aria-label={label}>{children}</span> : children;
  return (
    <Tooltip layer placement={placement} content={<><span className="exam-prep-explain__line">{lines[0]}</span>{lines[1] && <span className="exam-prep-explain__line exam-prep-explain__more">{lines[1]}</span>}</>}>
      {anchor}
    </Tooltip>
  );
}
