import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNow } from '../components/use-now.js';
import { useInjectCss } from '../shared.js';
import { resolveAtmosphereLighting } from './atelier-presets.js';
import { useAtelierState } from './atelier-storage.js';
import triggerCss from './desk-atelier-trigger.css';

const SOLAR_REFRESH_MS = 15 * 60 * 1000;

/** Subtle opt-in desk atmosphere lighting overlay (default: 'none').
    Pointer-events: none, opacity <= 0.06, auto-disabled in high contrast and forced-colors. */
export default function AtmosphereLayer({ anchorRef }) {
  useInjectCss(triggerCss, 'study-desk-atelier-trigger');
  const { atmosphere } = useAtelierState();
  const nowMs = useNow(SOLAR_REFRESH_MS, { enabled: atmosphere === 'solar' });
  const [portalTarget, setPortalTarget] = useState(null);

  useEffect(() => {
    if (atmosphere === 'none' || typeof document === 'undefined') {
      setPortalTarget(null);
      return;
    }
    const host = anchorRef?.current?.closest?.('.study-app')
      || document.querySelector?.('.study-app')
      || null;
    setPortalTarget(host);
  }, [atmosphere, anchorRef]);

  const hour = new Date(nowMs).getHours();
  const resolved = resolveAtmosphereLighting(atmosphere, hour);
  if (resolved === 'none') return null;

  const overlay = (
    <div
      className="desk-atelier-atmosphere"
      data-atmosphere={resolved}
      data-atmosphere-mode={atmosphere}
      aria-hidden="true"
    />
  );

  if (portalTarget && typeof createPortal === 'function') {
    return createPortal(overlay, portalTarget);
  }
  return overlay;
}
