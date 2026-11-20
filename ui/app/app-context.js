import { use, useContext } from 'react';
import { createStore, useStore } from 'zustand';
import { AppContext, AppStoreContext } from './store.js';

export {
  APP_SLICE_KEYS,
  AppContext,
  AppStoreContext,
  AppStoreProvider,
  createAppStore,
  syncAppStore,
  useAppBoard,
  useAppConnection,
  useAppCoreSlice,
  useAppData,
  useAppNav,
  useAppSelector,
  useAppSession,
  useAppShell,
  useAppSlice,
  useAppStore,
  useOptionalAppSelector,
} from './store.js';

const EMPTY_STORE = createStore(() => null);
const IDENTITY = (state) => state;

/** Is the reader (a material full-size) the open dialog of `modal` (lib.modal)? The daily plan listens while it is; the 对照栏 of the practice page gives way to it (one reader at a time, #1012). */
export const readerOpen = (modal) => modal?.type === 'source';

/**
 * Backward-compatible facade returning the full app controller (or a selected slice when
 * passed a `selector` function). Reads from the Zustand `AppStoreContext` when mounted inside
 * `<App>` without subscribing to `AppContext`, and falls back seamlessly to `AppContext` for
 * standalone component tests.
 */
export function useApp(selector) {
  const store = useContext(AppStoreContext);
  const pick = typeof selector === 'function' ? selector : IDENTITY;
  const fromStore = useStore(store ?? EMPTY_STORE, store ? pick : IDENTITY);
  if (store) return fromStore;
  const legacy = use(AppContext);
  if (!legacy) throw new Error('useApp must be used inside <App>');
  return pick(legacy);
}
