import React from 'react';

/* The component icon family matches the rail glyphs (ui/NavGlyph.jsx): a 24px
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
  'arrow-left': <path d="M19 12H5M11 6l-6 6 6 6" />,
  'arrow-right': <path d="M5 12h14M13 6l6 6-6 6" />,
  key: <><circle cx="8" cy="15.5" r="3.8" /><path d="m10.8 12.8 8.2-8.3M15.5 8l2.6 2.6M13.4 10.1l2 2" /></>,
  folder: <path d="M3.5 7.5a2 2 0 0 1 2-2h3.8l2.2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />,
  download: <><path d="M12 4.5v11M7.5 11 12 15.5 16.5 11" /><path d="M4.5 14.5v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3" /></>,
  help: <><circle cx="12" cy="12" r="8.5" /><path d="M9.6 9.6a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.4M12 16.6v.1" /></>,
  'thumb-up': <><path d="M7.5 10.5v9h-3v-9z" /><path d="M7.5 10.5 11 4.5a2 2 0 0 1 2.6 2.4l-.9 3.1H18a2 2 0 0 1 2 2.3l-1 5.5a2 2 0 0 1-2 1.7H7.5" /></>,
  'thumb-down': <><path d="M7.5 13.5v-9h-3v9z" /><path d="M7.5 13.5 11 19.5a2 2 0 0 0 2.6-2.4l-.9-3.1H18a2 2 0 0 0 2-2.3l-1-5.5a2 2 0 0 0-2-1.7H7.5" /></>,
  model: <><rect x="5" y="5" width="14" height="14" rx="3" /><path d="M9.5 9.5h5v5h-5zM9 2.5v2.5M15 2.5v2.5M9 19v2.5M15 19v2.5M2.5 9H5M2.5 15H5M19 9h2.5M19 15h2.5" /></>,
};

export const ICON_NAMES = Object.keys(PATHS);

/** Decorative icon; pair it with visible text or an aria-label on the control. */
export default function Icon({ name, size = 18, strokeWidth = 1.6, className }) {
  const paths = PATHS[name];
  if (!paths) return null;
  return (
    <svg className={className ? `sh-icon ${className}` : 'sh-icon'} viewBox="0 0 24 24" width={size} height={size} fill="none"
      stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {paths}
    </svg>
  );
}
