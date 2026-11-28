import { useSyncExternalStore } from 'react';
import { AUTO_SCALE_STEPS, CONTRAST_QUERY, INTERFACE_KEY, LIGHT_QUERY, REDUCED_MOTION_QUERY, THEME_KEY, appearanceAttrs, autoScaleNow, autoScaleQuery, createAppearanceStore, seatAttrs } from './appearance-prefs.js';

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

/** Whether Minimal Mode (极简模式) is active in this browser. */
export function useMinimalMode() {
  return useAppearance()[0].minimal === 'on';
}

/* What the OS asks for right now, live: `auto` follows it. */
const watch = query => [
  listener => { const media = typeof matchMedia === 'function' ? matchMedia(query) : null; media?.addEventListener?.('change', listener); return () => media?.removeEventListener?.('change', listener); },
  () => typeof matchMedia === 'function' && matchMedia(query).matches,
];
const [subscribeLight, isLight] = watch(LIGHT_QUERY), [subscribeReduced, isReduced] = watch(REDUCED_MOTION_QUERY), [subscribeContrast, isContrast] = watch(CONTRAST_QUERY);
/* 跟随窗口: the window crossing one of the widths of AUTO_SCALE_STEPS (maximising, a wider screen) changes the size; nothing runs while it is only dragged in between. */
const widthWatches = AUTO_SCALE_STEPS.map(([min]) => watch(autoScaleQuery(min))[0]);
const subscribeAutoScale = listener => { const stops = widthWatches.map(subscribe => subscribe(listener)); return () => stops.forEach(stop => stop()); };

/** The data-* attributes for the root of anything wearing the study tokens, resolved against the live OS settings and the window's width. */
export function useAppearanceAttrs(prefs) {
  const light = useSyncExternalStore(subscribeLight, isLight, () => false), reducedMotion = useSyncExternalStore(subscribeReduced, isReduced, () => false);
  const contrast = useSyncExternalStore(subscribeContrast, isContrast, () => false), autoScale = useSyncExternalStore(subscribeAutoScale, autoScaleNow, () => 100);
  return appearanceAttrs(prefs, { light, reducedMotion, contrast, autoScale });
}

/** The DSH seat's own appearance attributes (motion, contrast), live like the app's. */
export function useSeatAppearance() {
  return seatAttrs(useAppearanceAttrs(useAppearance()[0]));
}
