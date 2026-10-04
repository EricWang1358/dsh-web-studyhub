import { useSyncExternalStore } from 'react';
import { INTERFACE_KEY, LIGHT_QUERY, REDUCED_MOTION_QUERY, THEME_KEY, appearanceAttrs, createAppearanceStore } from './appearance-prefs.js';

/* The one appearance of this browser as a store: the app, the empty page before a session and every panel subscribe, so a change is a
   change everywhere that is open; another tab's change arrives through the storage event. */
export const appearanceStore = createAppearanceStore();
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function')
  window.addEventListener('storage', event => { if (event.key === null || event.key === THEME_KEY || event.key === INTERFACE_KEY) appearanceStore.reload(); });

/** [prefs, update(patch), reset()]: the preferences of this browser. */
export function useAppearance() {
  const prefs = useSyncExternalStore(appearanceStore.subscribe, appearanceStore.get, appearanceStore.get);
  return [prefs, appearanceStore.update, appearanceStore.reset];
}

/* What the OS asks for right now, live: `auto` follows it. */
const watch = query => [
  listener => { const media = typeof matchMedia === 'function' ? matchMedia(query) : null; media?.addEventListener?.('change', listener); return () => media?.removeEventListener?.('change', listener); },
  () => typeof matchMedia === 'function' && matchMedia(query).matches,
];
const [subscribeLight, isLight] = watch(LIGHT_QUERY), [subscribeReduced, isReduced] = watch(REDUCED_MOTION_QUERY);

/** The data-* attributes for the root of anything wearing the study tokens, resolved against the live OS settings. */
export function useAppearanceAttrs(prefs) {
  const light = useSyncExternalStore(subscribeLight, isLight, () => false), reducedMotion = useSyncExternalStore(subscribeReduced, isReduced, () => false);
  return appearanceAttrs(prefs, { light, reducedMotion });
}
