import React, { useState } from 'react';
import { getCachedAppearance } from '../appearance-prefs.js';
import { useInjectCss } from '../shared.js';
import { useAppearance } from '../use-appearance.js';
import { useLiveEffect } from '../use-async.js';
import css from './letterpress.css';

let cachedRuntime = null;

/** Format a plain static counter string for SSR, first paint, non-finite inputs, or reduced/off motion. */
export function formatPlainNumber(value, { prefix = '', suffix = '', fallback = '—' } = {}) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? `${prefix}${value}${suffix}` : fallback;
  }
  if (value === null || value === undefined || value === '') return fallback;
  return `${prefix}${String(value)}${suffix}`;
}

/** True only in a browser whose active study surface runs `data-motion="full"` without OS reduced motion or Minimal Mode. */
export function isFullMotionBrowser(doc = globalThis.document, win = globalThis.window) {
  if (!doc || !win) return false;
  if (win.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return false;
  const root = doc.querySelector?.('.study-app, .study-seat');
  if (root?.getAttribute?.('data-minimal') === 'on') return false;
  try {
    if (getCachedAppearance().minimal === 'on') return false;
  } catch { /* ignore */ }
  return root?.getAttribute?.('data-motion') === 'full';
}

/**
 * SSR- and closure-safe mechanical letterpress counter (< 1 KB static footprint).
 * Renders plain text on SSR, first paint, non-finite values, Minimal Mode, and reduced/off motion;
 * lazily loads `@number-flow/react` via `letterpress-runtime.jsx` only when live
 * full motion is active in the browser.
 */
export default function LetterpressNumber({
  value,
  prefix = '',
  suffix = '',
  fallback = '—',
  animateOnMount = false,
  mountKey = '',
  className = '',
}) {
  useInjectCss(css, 'study-letterpress');
  const [appearance] = useAppearance();
  const minimal = appearance.minimal === 'on';
  const numeric = typeof value === 'number' && Number.isFinite(value);
  const [Runtime, setRuntime] = useState(null);
  const [motionFull, setMotionFull] = useState(false);

  useLiveEffect((isLive) => {
    if (!numeric || minimal) {
      setMotionFull(false);
      return undefined;
    }
    const sync = () => {
      const full = isFullMotionBrowser();
      setMotionFull(full);
      if (!full) return;
      if (cachedRuntime) {
        setRuntime(() => cachedRuntime);
        return;
      }
      import('./letterpress-runtime.jsx')
        .then((mod) => {
          cachedRuntime = mod.default;
          if (isLive()) setRuntime(() => mod.default);
        })
        .catch(() => { /* stay on plain static text if chunk fails */ });
    };

    sync();

    const root = globalThis.document?.querySelector?.('.study-app, .study-seat');
    const observer = root && typeof MutationObserver === 'function'
      ? new MutationObserver(sync)
      : null;
    observer?.observe(root, { attributes: true, attributeFilter: ['data-motion', 'data-minimal'] });

    const media = globalThis.window?.matchMedia?.('(prefers-reduced-motion: reduce)');
    media?.addEventListener?.('change', sync);

    return () => {
      observer?.disconnect();
      media?.removeEventListener?.('change', sync);
    };
  }, [numeric, minimal]);

  if (numeric && !minimal && motionFull && Runtime) {
    return (
      <Runtime
        value={value}
        prefix={prefix}
        suffix={suffix}
        animateOnMount={animateOnMount}
        mountKey={mountKey}
        className={className}
      />
    );
  }

  const text = formatPlainNumber(value, { prefix, suffix, fallback });
  return className ? <span className={className}>{text}</span> : text;
}
