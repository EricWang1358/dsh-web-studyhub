/* Lightweight on-demand loader for WrongBookClearStamp.jsx so carved seal SVG,
   rough-notation ink mark, confetti, and postcard/album modals load ONLY when the
   WrongBook enters its cleared-ledger milestone state. */
import React from 'react';
import { useAppearance } from '../use-appearance.js';
import { useLiveEffect } from '../use-async.js';

let cachedStamp = null;

export default function LazyWrongBookClearStamp({ clearedCount = 0, course = '' }) {
  const [appearance] = useAppearance();
  const minimal = appearance.minimal === 'on';
  const [StampComp, setStampComp] = React.useState(() => cachedStamp);
  const active = !minimal && Number(clearedCount) > 0;

  useLiveEffect((isLive) => {
    if (!active || StampComp) return undefined;
    import('./WrongBookClearStamp.jsx')
      .then((mod) => {
        const Comp = mod?.default || null;
        if (!Comp) return;
        cachedStamp = Comp;
        if (isLive()) setStampComp(() => Comp);
      })
      .catch(() => { /* Keep the cleared EmptyState intact if chunk load fails. */ });
    return undefined;
  }, [active, StampComp]);

  if (!active || !StampComp) return null;
  return <StampComp clearedCount={clearedCount} course={course} />;
}
