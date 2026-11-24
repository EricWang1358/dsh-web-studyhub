import { useEffect, useRef } from 'react';
import type { KeyHint } from '../types/contracts.js';
import { useTuiStore } from '../state/store.js';

/**
 * Publish page-specific key hints to the global footer while `active`.
 * Pass a stable array (module constant or useMemo) to avoid needless updates.
 */
export function useFooterHints(hints: readonly KeyHint[], active = true): void {
  const hintsRef = useRef(hints);
  hintsRef.current = hints;
  const sig = hints.map((h) => `${h.key}\u0001${h.label}`).join('\u0002');
  useEffect(() => {
    if (!active) return undefined;
    useTuiStore.getState().setFooterHints([...hintsRef.current]);
    return () => {
      // Only clear if nobody replaced them in the meantime.
      const cur = useTuiStore.getState().footerHints;
      if (cur.map((h) => `${h.key}\u0001${h.label}`).join('\u0002') === sig) useTuiStore.getState().setFooterHints([]);
    };
  }, [sig, active]);
}
