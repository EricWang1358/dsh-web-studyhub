/* React hook tracking live StudyHub theme palette tokens and motion preferences. */
import React from 'react';
import { findStudyRoot, prefersReducedMotion, resolveThemePalette } from './palette.js';

const WATCHED_ATTRS = ['data-theme', 'data-palette', 'data-accent', 'data-motion', 'data-contrast'];

/** Subscribe to computed theme palette tokens + reduced-motion state on the StudyHub root. */
export function useSealPalette(anchorRef = null) {
  const [state, setState] = React.useState(() => ({
    palette: resolveThemePalette(null),
    reducedMotion: prefersReducedMotion(null),
  }));

  React.useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const sync = () => {
      const el = anchorRef?.current || null;
      setState({
        palette: resolveThemePalette(el),
        reducedMotion: prefersReducedMotion(el),
      });
    };
    sync();

    const root = findStudyRoot(anchorRef?.current || null);
    let observer = null;
    if (root && typeof MutationObserver === 'function') {
      observer = new MutationObserver(sync);
      observer.observe(root, { attributes: true, attributeFilter: WATCHED_ATTRS });
    }
    const mq = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;
    mq?.addEventListener?.('change', sync);
    return () => {
      observer?.disconnect();
      mq?.removeEventListener?.('change', sync);
    };
  }, [anchorRef]);

  return state;
}
