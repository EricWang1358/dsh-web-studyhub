import React from 'react';

/* The few small icons the bilingual reading needs that the shared Icon set does not have. Drawn like it: 24px grid, 1.7 stroke. */
const PATHS = {
  more: <path d="M6 12h.01M12 12h.01M18 12h.01" strokeWidth="2.6" />,
  copy: <><rect x="8.5" y="8.5" width="10.5" height="10.5" rx="2" /><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" /></>,
  trash: <><path d="M5 7h14M10 7V5.2c0-.4.3-.7.7-.7h2.6c.4 0 .7.3.7.7V7M7 7l.8 11.2c.1.8.7 1.3 1.5 1.3h5.4c.8 0 1.4-.5 1.5-1.3L17 7M10.2 10.5v5.5M13.8 10.5v5.5" /></>,
  book: <><path d="M5 5.5A2 2 0 0 1 7 3.5h11.5v14.5H7a2 2 0 0 0-2 2z" /><path d="M5 19.5a2 2 0 0 0 2 2h11.5M9 8h6M9 11.5h4" /></>,
  down: <path d="m6 9.5 6 6 6-6" />,
  edit: <><path d="m5 19 .9-3.6L16.2 5.1a1.8 1.8 0 0 1 2.5 0l.2.2a1.8 1.8 0 0 1 0 2.5L8.6 18.1z" /><path d="m14.5 6.8 2.7 2.7" /></>,
};

/** A 16px stroke icon from the set above; decorative (its button carries the label). */
export default function Glyph({ name, size = 16 }) {
  return <svg className="tr-glyph" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{PATHS[name]}</svg>;
}
