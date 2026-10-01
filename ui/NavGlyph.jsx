import React from "react";

/* One drawn icon family for the rail: 24px grid, 1.6 stroke, round joins.
   Every destination gets its own mark so the collapsed rail stays legible. */
const PATHS = {
  audio: <><path d="M14 3H6v18h12V7zM14 3v5h4M9 12v4M12 10v8M15 12v4" /></>,
  live: <><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" /></>,
  workflows: <><rect x="3" y="3" width="6" height="5" rx="1" /><rect x="15" y="16" width="6" height="5" rx="1" /><path d="M6 8v6h12v2M18 5v7M15 8l3 4 3-4" /></>,
  coach: <><path d="M11 3.5 13 9l5.5 2-5.5 2-2 5.5L9 13l-5.5-2L9 9z" /><path d="M18.5 3.5v3M17 5h3M18.5 16.5v3M17 18h3" /></>,
  resume: <><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></>,
  library: <><rect x="4" y="8" width="12" height="12" rx="2" /><path d="M8 4h10a2 2 0 0 1 2 2v10" /></>,
  sources: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></>,
  generate: <><path d="M12 5v14M5 12h14" /></>,
  skeleton: <><circle cx="6" cy="6" r="2.2" /><circle cx="18" cy="8" r="2.2" /><circle cx="11" cy="18" r="2.2" /><path d="M8.1 6.4 15.8 7.6M7 8l3 8M16.8 10l-4.6 6.3" /></>,
  dashboard: <><path d="M4 20h16" /><path d="M7 16v-4M12 16V6M17 16v-7" /></>,
  exam: <><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 3.5h6M9 13l2 2 4-4.5" /></>,
  wrongbook: <><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" /><path d="M20 4v4.5h-4.5" /></>,
  notes: <><path d="M6 3h11a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6z" /><path d="M6 3v18M10 8h5M10 12h5" /></>,
  board: <><rect x="3.5" y="4" width="17" height="16" rx="2" /><path d="M9.5 4v16M14.5 4v16" /></>,
  settings: <><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></>,
  auto: <><circle cx="12" cy="12" r="7.5" /><path d="M12 4.5a7.5 7.5 0 0 1 0 15z" fill="currentColor" stroke="none" /></>,
  dark: <><path d="M19.5 14.2A7.8 7.8 0 1 1 9.8 4.5a6.2 6.2 0 0 0 9.7 9.7z" /></>,
  language: <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5c-2.3-2.4-3.4-5.2-3.4-8.5S9.7 5.9 12 3.5z" /></>,
  light: <><circle cx="12" cy="12" r="3.8" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" /></>,
};

export default function NavGlyph({ name }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name] || null}
    </svg>
  );
}

/* Brand mark: a ring-bound exercise book with the teacher's red tick. */
export function BrandMark() {
  return (
    <svg viewBox="0 0 32 32" width="30" height="30" fill="none" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false">
      <rect x="7" y="4" width="20" height="24" rx="2.5" stroke="currentColor" strokeWidth="1.7" />
      <path d="M11.5 4v24" stroke="currentColor" strokeWidth="1.2" opacity="0.55" />
      <path d="M4.5 9h4.5M4.5 16h4.5M4.5 23h4.5" stroke="currentColor" strokeWidth="1.7" />
      <path d="M15.5 10h7.5M15.5 14h5" stroke="currentColor" strokeWidth="1.4" opacity="0.7" />
      <path d="m15.5 20.5 2.4 2.4 4.9-5.4" style={{ stroke: "var(--accent-soft)" }} strokeWidth="2" />
    </svg>
  );
}
