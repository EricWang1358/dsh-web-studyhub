import React, { useState } from 'react';
import { useLiveEffect } from '../use-async.js';
import { useAppearance } from '../use-appearance.js';

let cachedStrip = null;

/**
 * Dynamically imports `DeskPlayStrip.jsx` (OrigamiMark, Serendipity Slip, and its
 * stylesheet) after initial mount so the workspace static closure stays lean
 * without altering the `React.lazy` boundary count.
 */
export default function LazyDeskPlayStrip(props) {
  const [appearance] = useAppearance();
  const minimal = appearance.minimal === 'on';
  const [StripImpl, setStripImpl] = useState(() => cachedStrip);

  useLiveEffect((isLive) => {
    if (minimal || StripImpl) return;
    import('./DeskPlayStrip.jsx')
      .then((mod) => {
        cachedStrip = mod.default;
        if (isLive()) setStripImpl(() => mod.default);
      })
      .catch(() => { /* ignore transient chunk load failure */ });
  }, [minimal, StripImpl]);

  if (minimal) return null;
  return StripImpl ? <StripImpl {...props} /> : null;
}
