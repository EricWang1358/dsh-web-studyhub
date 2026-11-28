/* Lightweight on-demand loader for FlowSealCue.jsx so carved seal SVG generation
   and seal-press.css stay out of the workspace first-load closure until a learner
   actually hits a 3+ flow streak or conquers a stubborn/leech card. */
import React from 'react';
import { useAppearance } from '../use-appearance.js';
import { computeFlowStreak, isLeechConquered } from './flow-logic.js';

let cachedCue = null;

export default function LazyFlowSealCue({ run, variant = 'header' }) {
  const [appearance] = useAppearance();
  const minimal = appearance.minimal === 'on';
  const [Cue, setCue] = React.useState(() => cachedCue);
  const active = !minimal && Boolean(run && run.mode !== 'exam' && !run.complete && (isLeechConquered(run) || computeFlowStreak(run)));

  React.useEffect(() => {
    if (!active || Cue) return undefined;
    let cancelled = false;
    import('./seal-press-runtime.js')
      .then((mod) => {
        const Comp = mod?.FlowSealCue || null;
        if (!Comp) return;
        cachedCue = Comp;
        if (!cancelled) setCue(() => Comp);
      })
      .catch(() => { /* Keep QuestionRun uninterrupted if chunk load fails. */ });
    return () => { cancelled = true; };
  }, [active, Cue]);

  if (!active || !Cue) return null;
  return <Cue run={run} variant={variant} />;
}
