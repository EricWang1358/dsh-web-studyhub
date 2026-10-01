import React from 'react';

/* Board-only glyphs in the same family as ui/components/Icon.jsx (24px grid,
   1.6 stroke, round caps, currentColor). Kept here so the shared icon set is
   not edited by every work package. */
const PATHS = {
  calendar: <><rect x="4" y="5.5" width="16" height="14.5" rx="2.5" /><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" /></>,
  more: <><circle cx="6" cy="12" r="1.15" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.15" fill="currentColor" stroke="none" /><circle cx="18" cy="12" r="1.15" fill="currentColor" stroke="none" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6" /><path d="m15 15 5 5" /></>,
  filter: <path d="M4 6h16M7 12h10M10.5 18h3" />,
  edit: <><path d="M5 19l1-4L16.5 4.5a2 2 0 0 1 2.8 0l.2.2a2 2 0 0 1 0 2.8L9 18z" /><path d="m14.5 6.5 3 3" /></>,
  trash: <><path d="M4.5 7h15M9.5 7V4.8h5V7" /><path d="M6.5 7l.8 12a1.6 1.6 0 0 0 1.6 1.5h6.2a1.6 1.6 0 0 0 1.6-1.5l.8-12M10 11v6M14 11v6" /></>,
  archive: <><rect x="3.5" y="4.5" width="17" height="4.5" rx="1.2" /><path d="M5.5 9v8.5a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V9M10 13h4" /></>,
  link: <><path d="M10 14a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-.8.8" /><path d="M14 10a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l.8-.8" /></>,
  checklist: <><path d="m4.5 6.5 1.6 1.6 2.9-3M4.5 14l1.6 1.6 2.9-3" /><path d="M12.5 7h7M12.5 14.5h7M4.5 19.5h4M12.5 19.5h7" /></>,
  up: <path d="M12 19V5M6 11l6-6 6 6" />,
  down: <path d="M12 5v14M6 13l6 6 6-6" />,
  move: <><path d="M4 12h13M13 7l5 5-5 5" /><path d="M20 5v14" /></>,
  refresh: <><path d="M19.5 12a7.5 7.5 0 0 1-13 5.1M4.5 12a7.5 7.5 0 0 1 13-5.1" /><path d="M17.5 3.5v4h-4M6.5 20.5v-4h4" /></>,
  undo: <><path d="M9 6 4.5 10.5 9 15" /><path d="M5 10.5h8.5a5 5 0 0 1 0 10H11" /></>,
  fold: <path d="M5 9l7 7 7-7" />,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  rename: <path d="M5 19l1-4L16.5 4.5a2 2 0 0 1 2.8 0l.2.2a2 2 0 0 1 0 2.8L9 18z" />,
};

/** Decorative glyph; the control that holds it carries the accessible name. */
export default function BIcon({ name, size = 16, className, strokeWidth = 1.6 }) {
  const paths = PATHS[name];
  if (!paths) return null;
  return (
    <svg className={className ? `sh-icon ${className}` : 'sh-icon'} viewBox="0 0 24 24" width={size} height={size} fill="none"
      stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {paths}
    </svg>
  );
}
