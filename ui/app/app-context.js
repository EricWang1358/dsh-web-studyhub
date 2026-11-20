import { createContext, useContext } from 'react';
import { createStore, useStore } from 'zustand';
import { AppStoreContext } from './store.js';

export {
  APP_SLICE_KEYS,
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
} from './store.js';

/* The controller App builds from its hooks and hands to the shell's own parts (sidebar, top bar, dialogs, page adapters).
   It is the app's internal wiring, so it is not for pages: a page reads the public services with useStudy()
   (ui/study-context.jsx). Fields: language, host, data, connection, core, shell, nav, lib (state), set (setters), session, learn,
   intents, drafts, notebooks, tour, inbox, sources, settingsEntry, dailyPlan, board. */
export const AppContext = createContext(null);

const EMPTY_STORE = createStore(() => null);
const IDENTITY = (state) => state;

/** Is the reader (a material full-size) the open dialog of `modal` (lib.modal)? The daily plan listens while it is; the 对照栏 of the practice page gives way to it (one reader at a time, #1012). */
export const readerOpen = (modal) => modal?.type === 'source';

/**
 * Backward-compatible facade returning the full app controller (or a selected slice when
 * passed a `selector` function). Reads from the Zustand `AppStoreContext` when mounted inside
 * `<App>`, and falls back seamlessly to `AppContext` for standalone component tests.
 */
export function useApp(selector) {
  const store = useContext(AppStoreContext);
  const legacy = useContext(AppContext);
  const pick = typeof selector === 'function' ? selector : IDENTITY;
  const fromStore = useStore(store ?? EMPTY_STORE, store ? pick : IDENTITY);
  if (store) return fromStore;
  if (!legacy) throw new Error('useApp must be used inside <App>');
  return pick(legacy);
}
