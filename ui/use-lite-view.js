import { useSyncExternalStore } from 'react';
import { LITE_VIEW_KEY, createLiteViewStore, liteViewOn } from './lite-view.js';
import { useOptionalAppSelector } from './app/app-context.js';

/* The one 简洁版 choice of this browser as a store, like the appearance (ui/use-appearance.js): every open panel subscribes, and another tab's change
   arrives through the storage event. The rule itself is ui/lite-view.js. */
export const liteViewStore = createLiteViewStore();
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function')
  window.addEventListener('storage', (event) => { if (event.key === null || event.key === LITE_VIEW_KEY) liteViewStore.reload(); });

/** [saved, set(on)]: the learner's own choice, as the switch shows it. */
export function useLiteViewSetting() {
  return [useSyncExternalStore(liteViewStore.subscribe, liteViewStore.get, liteViewStore.get), liteViewStore.set];
}

/** Whether the lite view is what to draw now (never while the guided tour runs; outside the app there is no tour). */
export function useLiteView() {
  const [saved] = useLiteViewSetting();
  const touring = useOptionalAppSelector((state) => !!state.tour?.tourStep);
  return liteViewOn({ saved, touring });
}
