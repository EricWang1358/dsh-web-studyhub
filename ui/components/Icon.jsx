import React from 'react';

/* The one icon registry: the component icons, the sidebar rail's (nav-*), the board's and the bilingual reader's, and the StudyHub mark: a 24px
   grid, 1.6 stroke, round caps and joins, drawn in currentColor. */
const PATHS = {
  check: <path d="m5 12.5 4.3 4.3L19 7" />,
  close: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  plus: <path d="M12 5v14M5 12h14" />,
  upload: <><path d="M12 15.5V4.5M7.5 9 12 4.5 16.5 9" /><path d="M4.5 14.5v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3" /></>,
  file: <><path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z" /><path d="M14 3.5V8h4.5M9 13h6M9 16.5h4" /></>,
  audio: <><path d="M9 17.5V6l10-2v11.5" /><circle cx="6.5" cy="17.5" r="2.5" /><circle cx="16.5" cy="15.5" r="2.5" /></>,
  sparkle: <><path d="M11 4.5 12.8 9.7 18 11.5l-5.2 1.8L11 18.5l-1.8-5.2L4 11.5l5.2-1.8z" /><path d="M18.5 3.5v3M17 5h3" /></>,
  info: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5.2M12 7.8v.1" /></>,
  success: <><circle cx="12" cy="12" r="8.5" /><path d="m8.4 12.3 2.5 2.5 4.8-5.2" /></>,
  warning: <><path d="M10.4 4.6 3.4 17a1.8 1.8 0 0 0 1.6 2.7h14a1.8 1.8 0 0 0 1.6-2.7l-7-12.4a1.8 1.8 0 0 0-3.2 0z" /><path d="M12 9.5v4.2M12 16.6v.1" /></>,
  error: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.6v5.2M12 15.9v.1" /></>,
  external: <><path d="M13.5 4.5h6v6M19.5 4.5l-8 8" /><path d="M17.5 13.5v4a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h4" /></>,
  chevron: <path d="m9.5 6 6 6-6 6" />,
  'chevron-left': <path d="m14.5 6-6 6 6 6" />,
  caret: <path d="M9.2 7v10l6.3-5z" />,
  minus: <path d="M5 12h14" />,
  fit: <path d="M9 4.5H4.5V9M15 4.5h4.5V9M9 19.5H4.5V15M15 19.5h4.5V15" />,
  play: <path d="M8 5.5v13l10.5-6.5z" />,
  'arrow-left': <path d="M19 12H5M11 6l-6 6 6 6" />,
  'arrow-right': <path d="M5 12h14M13 6l6 6-6 6" />,
  'arrow-up': <path d="M12 19V5M6 11l6-6 6 6" />,
  'arrow-down': <path d="M12 5v14M6 13l6 6 6-6" />,
  key: <><circle cx="8" cy="15.5" r="3.8" /><path d="m10.8 12.8 8.2-8.3M15.5 8l2.6 2.6M13.4 10.1l2 2" /></>,
  refresh: <><path d="M19.5 12a7.5 7.5 0 1 1-2.3-5.4" /><path d="M19.5 4.5v4h-4" /></>,
  folder: <path d="M3.5 7.5a2 2 0 0 1 2-2h3.8l2.2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />,
  download: <><path d="M12 4.5v11M7.5 11 12 15.5 16.5 11" /><path d="M4.5 14.5v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3" /></>,
  help: <><circle cx="12" cy="12" r="8.5" /><path d="M9.6 9.6a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.4M12 16.6v.1" /></>,
  'thumb-up': <><path d="M7.5 10.5v9h-3v-9z" /><path d="M7.5 10.5 11 4.5a2 2 0 0 1 2.6 2.4l-.9 3.1H18a2 2 0 0 1 2 2.3l-1 5.5a2 2 0 0 1-2 1.7H7.5" /></>,
  'thumb-down': <><path d="M7.5 13.5v-9h-3v9z" /><path d="M7.5 13.5 11 19.5a2 2 0 0 0 2.6-2.4l-.9-3.1H18a2 2 0 0 0 2-2.3l-1-5.5a2 2 0 0 0-2-1.7H7.5" /></>,
  list: <><path d="M8.5 7h11M8.5 12h11M8.5 17h11" /><path d="M4.5 7h.01M4.5 12h.01M4.5 17h.01" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></>,
  type: <><path d="M3.5 18 8.5 6l5 12M5.4 14h6.2" /><circle cx="17.2" cy="15.2" r="2.8" /><path d="M20 12.4V18" /></>,
  panel: <><rect x="4" y="5" width="16" height="14" rx="2.5" /><path d="M14.5 5v14" /></>,
  model: <><rect x="5" y="5" width="14" height="14" rx="3" /><path d="M9.5 9.5h5v5h-5zM9 2.5v2.5M15 2.5v2.5M9 19v2.5M15 19v2.5M2.5 9H5M2.5 15H5M19 9h2.5M19 15h2.5" /></>,
  mail: <><path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h12a2.5 2.5 0 0 1 2.5 2.5v9A2.5 2.5 0 0 1 18 19H6a2.5 2.5 0 0 1-2.5-2.5v-9Z" /><path d="m4 7.5 8 6 8-6" /></>,
  // Board, notes and the bilingual reader (they used to carry private sets).
  more: <><circle cx="6" cy="12" r="1.5" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" /><circle cx="18" cy="12" r="1.5" fill="currentColor" stroke="none" /></>,
  calendar: <><rect x="4" y="5.5" width="16" height="14.5" rx="2.5" /><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" /></>,
  filter: <path d="M4 6h16M7 12h10M10.5 18h3" />,
  edit: <><path d="M5 19l1-4L16.5 4.5a2 2 0 0 1 2.8 0l.2.2a2 2 0 0 1 0 2.8L9 18z" /><path d="m14.5 6.5 3 3" /></>,
  trash: <><path d="M4.5 7h15M9.5 7V4.8h5V7" /><path d="M6.5 7l.8 12a1.6 1.6 0 0 0 1.6 1.5h6.2a1.6 1.6 0 0 0 1.6-1.5l.8-12M10 11v6M14 11v6" /></>,
  archive: <><rect x="3.5" y="4.5" width="17" height="4.5" rx="1.2" /><path d="M5.5 9v8.5a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V9M10 13h4" /></>,
  link: <><path d="M10 14a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-.8.8" /><path d="M14 10a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l.8-.8" /></>,
  checklist: <><path d="m4.5 6.5 1.6 1.6 2.9-3M4.5 14l1.6 1.6 2.9-3" /><path d="M12.5 7h7M12.5 14.5h7M4.5 19.5h4M12.5 19.5h7" /></>,
  move: <><path d="M4 12h13M13 7l5 5-5 5" /><path d="M20 5v14" /></>,
  sync: <><path d="M19.5 12a7.5 7.5 0 0 1-13 5.1M4.5 12a7.5 7.5 0 0 1 13-5.1" /><path d="M17.5 3.5v4h-4M6.5 20.5v-4h4" /></>,
  undo: <><path d="M9 6 4.5 10.5 9 15" /><path d="M5 10.5h8.5a5 5 0 0 1 0 10H11" /></>,
  'chevron-down': <path d="M5 9l7 7 7-7" />,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  copy: <><rect x="8.5" y="8.5" width="10.5" height="10.5" rx="2" /><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" /></>,
  book: <><path d="M5 5.5A2 2 0 0 1 7 3.5h11.5v14.5H7a2 2 0 0 0-2 2z" /><path d="M5 19.5a2 2 0 0 0 2 2h11.5M9 8h6M9 11.5h4" /></>,
  // The sidebar rail: one mark per destination, so the collapsed rail stays legible.
  'nav-audio': <path d="M14 3H6v18h12V7zM14 3v5h4M9 12v4M12 10v8M15 12v4" />,
  'nav-live': <><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" /></>,
  'nav-workflows': <><rect x="3" y="3" width="6" height="5" rx="1" /><rect x="15" y="16" width="6" height="5" rx="1" /><path d="M6 8v6h12v2M18 5v7M15 8l3 4 3-4" /></>,
  'nav-coach': <><path d="M11 3.5 13 9l5.5 2-5.5 2-2 5.5L9 13l-5.5-2L9 9z" /><path d="M18.5 3.5v3M17 5h3M18.5 16.5v3M17 18h3" /></>,
  'nav-resume': <><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></>,
  'nav-library': <><rect x="4" y="8" width="12" height="12" rx="2" /><path d="M8 4h10a2 2 0 0 1 2 2v10" /></>,
  'nav-sources': <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></>,
  'nav-generate': <path d="M12 5v14M5 12h14" />,
  'nav-tasks': <path d="M4 6h3M4 12h3M4 18h3M10 6h10M10 12h10M10 18h10" />,
  'nav-skeleton': <><circle cx="6" cy="6" r="2.2" /><circle cx="18" cy="8" r="2.2" /><circle cx="11" cy="18" r="2.2" /><path d="M8.1 6.4 15.8 7.6M7 8l3 8M16.8 10l-4.6 6.3" /></>,
  'nav-dashboard': <><path d="M4 20h16" /><path d="M7 16v-4M12 16V6M17 16v-7" /></>,
  'nav-exam': <><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 3.5h6M9 13l2 2 4-4.5" /></>,
  'nav-wrongbook': <><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" /><path d="M20 4v4.5h-4.5" /></>,
  'nav-notes': <><path d="M6 3h11a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6z" /><path d="M6 3v18M10 8h5M10 12h5" /></>,
  'nav-board': <><rect x="3.5" y="4" width="17" height="16" rx="2" /><path d="M9.5 4v16M14.5 4v16" /></>,
  'nav-settings': <><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></>,
  'nav-auto': <><circle cx="12" cy="12" r="7.5" /><path d="M12 4.5a7.5 7.5 0 0 1 0 15z" fill="currentColor" stroke="none" /></>,
  'nav-dark': <path d="M19.5 14.2A7.8 7.8 0 1 1 9.8 4.5a6.2 6.2 0 0 0 9.7 9.7z" />,
  'nav-language': <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5c-2.3-2.4-3.4-5.2-3.4-8.5S9.7 5.9 12 3.5z" /></>,
  'nav-light': <><circle cx="12" cy="12" r="3.8" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" /></>,
  'nav-tour': <><circle cx="12" cy="12" r="8.5" /><path d="m15.2 8.8-1.9 4.5-4.5 1.9 1.9-4.5z" /></>,
  // The StudyHub mark (32px grid): a ring-bound exercise book with the teacher's red tick. The tick falls back to the brand red where the study tokens are absent (DSH's own sidebar).
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

/* Icons drawn on a different grid than 24. */
const GRID = { brand: 32, 'brand-compact': 32 };

export const ICON_NAMES = Object.keys(PATHS);

/** Decorative icon; pair it with visible text or an aria-label on the control. */
export default function Icon({ name, size = 18, strokeWidth = 1.6, className }) {
  const paths = PATHS[name];
  if (!paths) return null;
  const grid = GRID[name] || 24;
  return (
    <svg className={className ? `sh-icon ${className}` : 'sh-icon'} viewBox={`0 0 ${grid} ${grid}`} width={size} height={size} fill="none"
      stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {paths}
    </svg>
  );
}

/** The box a navigation row or a language switch puts its icon in: the span the rail's CSS (.icon) sizes and colours. */
export function IconBox({ children, className }) {
  return <span className={'icon' + (className ? ' ' + className : '')} aria-hidden="true">{children}</span>;
}
