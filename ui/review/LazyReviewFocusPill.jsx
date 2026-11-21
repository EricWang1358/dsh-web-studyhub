/* Lightweight on-demand loader for ReviewFocusPill.jsx so the full popover,
   timer controls, and custom preset inputs stay out of the workspace static
   first-load closure until the review page mounts. */
import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button } from '../components/index.js';
import { resolveTimerPrefs } from '../../lib/board-model.js';

let cachedPill = null;

export default function LazyReviewFocusPill(props) {
  const [Pill, setPill] = React.useState(() => cachedPill);
  const [pendingOpen, setPendingOpen] = React.useState(false);

  React.useEffect(() => {
    if (Pill) return undefined;
    let cancelled = false;
    import('./ReviewFocusPill.jsx')
      .then((mod) => {
        const Comp = mod?.default || null;
        if (!Comp) return;
        cachedPill = Comp;
        if (!cancelled) setPill(() => Comp);
      })
      .catch(() => { /* Keep Review header clean if optional chunk fails to load. */ });
    return () => { cancelled = true; };
  }, [Pill]);

  if (Pill) return <Pill {...props} initialOpen={props.initialOpen || pendingOpen} />;
  const prefs = resolveTimerPrefs(props.boardState?.board);
  const togglePending = () => setPendingOpen(true);
  return (
    <Button
      size="sm"
      variant="quiet"
      icon="clock"
      className="review-focus-pill"
      data-testid="review-focus-pill"
      aria-label={ui('专注番茄钟与今日目标')}
      onClick={togglePending}
    >
      {uiFormat('番茄 {0}+{1}', [prefs.workMinutes, prefs.breakMinutes])}
    </Button>
  );
}
