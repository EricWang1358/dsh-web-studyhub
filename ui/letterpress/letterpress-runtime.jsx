import React, { useEffect, useState } from 'react';
import NumberFlow from '@number-flow/react';

const NumberFlowView = NumberFlow?.default || NumberFlow;

const MAX_SEEN_KEYS = 64;
const seenMountKeys = new Set();

function markSeenKey(key) {
  if (!key) return;
  if (seenMountKeys.size >= MAX_SEEN_KEYS) {
    const oldest = seenMountKeys.values().next().value;
    if (oldest !== undefined) seenMountKeys.delete(oldest);
  }
  seenMountKeys.add(key);
}

/** Reset remembered one-shot mount keys (used by unit tests). */
export function resetLetterpressSeenKeys() {
  seenMountKeys.clear();
}

const TRANSFORM_TIMING = Object.freeze({ duration: 420, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
const SPIN_TIMING = Object.freeze({ duration: 420, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
const OPACITY_TIMING = Object.freeze({ duration: 240, easing: 'ease-out' });

/**
 * Dynamically loaded mechanical letterpress counter wrapping `@number-flow/react`.
 * Inherited typography stays tabular and crisp; `animateOnMount` triggers a single
 * subtle `0 -> value` roll per `mountKey` (e.g. a review result `run.id`).
 */
export default function LetterpressRuntime({
  value,
  prefix = '',
  suffix = '',
  animateOnMount = false,
  mountKey = '',
  className = '',
}) {
  const shouldRoll = Boolean(animateOnMount && mountKey && value > 0 && !seenMountKeys.has(mountKey));
  const [shown, setShown] = useState(() => (shouldRoll ? 0 : value));

  useEffect(() => {
    if (!animateOnMount || !mountKey || value <= 0 || seenMountKeys.has(mountKey)) {
      setShown(value);
      return undefined;
    }
    setShown(0);
    if (typeof requestAnimationFrame !== 'function') {
      markSeenKey(mountKey);
      setShown(value);
      return undefined;
    }
    const rafId = requestAnimationFrame(() => {
      markSeenKey(mountKey);
      setShown(value);
    });
    return () => {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
    };
  }, [value, animateOnMount, mountKey]);

  return (
    <NumberFlowView
      value={shown}
      prefix={prefix || undefined}
      suffix={suffix || undefined}
      className={className ? `sh-letterpress ${className}` : 'sh-letterpress'}
      respectMotionPreference
      transformTiming={TRANSFORM_TIMING}
      spinTiming={SPIN_TIMING}
      opacityTiming={OPACITY_TIMING}
    />
  );
}
