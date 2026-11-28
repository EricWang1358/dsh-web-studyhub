/* Lightweight on-demand loader for RoundSealSection.jsx so round-completion seal
   carving, confetti, and studio triggers stay out of the workspace first-load closure
   until a non-exam review round actually completes. */
import React from 'react';
import { useAppearance } from '../use-appearance.js';

let cachedSection = null;

export default function LazyRoundSealSection(props) {
  const [appearance] = useAppearance();
  const minimal = appearance.minimal === 'on';
  const [Section, setSection] = React.useState(() => cachedSection);
  const active = !minimal && Boolean(props.run?.complete && props.run?.mode !== 'exam');

  React.useEffect(() => {
    if (!active || Section) return undefined;
    let cancelled = false;
    import('./seal-press-runtime.js')
      .then((mod) => {
        const Comp = mod?.RoundSealSection || null;
        if (!Comp) return;
        cachedSection = Comp;
        if (!cancelled) setSection(() => Comp);
      })
      .catch(() => { /* Keep the Review result page clean if chunk load fails. */ });
    return () => { cancelled = true; };
  }, [active, Section]);

  if (!active || !Section) return null;
  return <Section {...props} />;
}
