import React from 'react';
import { ICON_PATHS } from './icon-paths.js';

/* The one icon registry: the component icons, the sidebar rail's (nav-*), the board's and the bilingual reader's. The glyphs are Phosphor Light
   (MIT), on a 256 grid, filled in currentColor; icon-paths.js is made from the name map in scripts/icons/build-icons.mjs. Only the StudyHub
   marks below are our own: strokes on a 32 grid. */
const BRAND = {
  // The StudyHub mark: a ring-bound exercise book with the teacher's red tick. The tick falls back to the brand red where the study tokens are absent (DSH's own sidebar).
  brand: <>
    <rect x="7" y="4" width="20" height="24" rx="2.5" strokeWidth="1.7" />
    <path d="M11.5 4v24" strokeWidth="1.2" opacity="0.55" />
    <path d="M4.5 9h4.5M4.5 16h4.5M4.5 23h4.5" strokeWidth="1.7" />
    <path d="M15.5 10h7.5M15.5 14h5" strokeWidth="1.4" opacity="0.7" />
    <path d="m15.5 20.5 2.4 2.4 4.9-5.4" strokeWidth="2" style={{ stroke: 'var(--accent-soft, #c93d22)' }} />
  </>,
  'brand-compact': <>
    <rect x="7" y="4" width="20" height="24" rx="2.5" strokeWidth="2" />
    <path d="M4.5 9h4.5M4.5 16h4.5M4.5 23h4.5" strokeWidth="2" />
    <path d="M15.5 10h7.5M15.5 14h5" strokeWidth="1.6" opacity="0.7" />
    <path d="m15.5 20.5 2.4 2.4 4.9-5.4" strokeWidth="2.2" style={{ stroke: 'var(--accent-soft, #c93d22)' }} />
  </>,
};

export const ICON_NAMES = [...Object.keys(ICON_PATHS), ...Object.keys(BRAND)];

/* strokeWidth was the old stroked set's weight (1.6 on the 24 grid). Light is its own weight, so the default draws the glyph as is; a heavier
   value (a checked box's tick asks for 2.4) widens the glyph by the difference, in the 256 grid's units. */
const DEFAULT_STROKE = 1.6;
const GRID_PER_PX = 256 / 24;

/** Decorative icon; pair it with visible text or an aria-label on the control. */
export default function Icon({ name, size = 18, strokeWidth = DEFAULT_STROKE, className }) {
  const cls = className ? `sh-icon ${className}` : 'sh-icon';
  const brand = BRAND[name];
  if (brand) {
    return (
      <svg className={cls} viewBox="0 0 32 32" width={size} height={size} fill="none"
        stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        {brand}
      </svg>
    );
  }
  const paths = ICON_PATHS[name];
  if (!paths) return null;
  const extra = Math.max(0, strokeWidth - DEFAULT_STROKE) * GRID_PER_PX;
  const bold = extra > 0 ? { stroke: 'currentColor', strokeWidth: Math.round(extra * 100) / 100, strokeLinejoin: 'round', strokeLinecap: 'round' } : null;
  return (
    <svg className={cls} viewBox="0 0 256 256" width={size} height={size} fill="currentColor" aria-hidden="true" focusable="false">
      {[].concat(paths).map((d, at) => <path key={at} d={d} {...bold} />)}
    </svg>
  );
}

/** The box a navigation row or a language switch puts its icon in: the span the rail's CSS (.icon) sizes and colours. */
export function IconBox({ children, className }) {
  return <span className={'icon' + (className ? ' ' + className : '')} aria-hidden="true">{children}</span>;
}
