/* Fine-grained Zustand store backing the StudyHub workbench shell.
   Splits the monolithic AppContext into independently subscribable slices so
   leaf components using `useAppSelector` / `useAppSlice` re-render only when
   their own slice changes, while preserving the backward-compatible `useApp()`
   facade in `ui/app/app-context.js` for existing pages and tests. */

import React, { createContext, use, useContext, useLayoutEffect, useState } from 'react';
import { createStore, useStore } from 'zustand';

const EMPTY_STORE = createStore(() => undefined);
const NOOP_SELECTOR = () => undefined;

export const APP_SLICE_KEYS = Object.freeze([
  'language',
  'host',
  'data',
  'canChat',
  'connection',
  'core',
  'shell',
  'nav',
  'lib',
  'set',
  'session',
  'learn',
  'intents',
  'drafts',
  'notebooks',
  'inbox',
  'sources',
  'tour',
  'finder',
  'settingsEntry',
  'dailyPlan',
  'board',
  'selectionNotices',
  'resetLibraryState',
]);

/** Create an isolated per-<App> Zustand store initialized with the provided slices. */
export function createAppStore(initial = {}) {
  const seed = {};
  for (const key of APP_SLICE_KEYS) {
    seed[key] = Object.hasOwn(initial, key) ? initial[key] : undefined;
  }
  return createStore(() => seed);
}

/**
 * Push only changed slice references into the Zustand store so subscribers to
 * unaffected slices never re-render. Returns true when at least one slice changed.
 */
export function syncAppStore(store, nextSlices) {
  if (!store || !nextSlices || typeof nextSlices !== 'object') return false;
  const current = store.getState();
  let patch = null;
  for (const key of APP_SLICE_KEYS) {
    if (!Object.hasOwn(nextSlices, key)) continue;
    const nextValue = nextSlices[key];
    if (!Object.is(current[key], nextValue)) {
      if (!patch) patch = {};
      patch[key] = nextValue;
    }
  }
  if (!patch) return false;
  store.setState(patch);
  return true;
}

/** Legacy monolithic AppContext retained for standalone test harnesses that do not mount <AppStoreProvider>. */
export const AppContext = createContext(null);

/** Stable React context carrying the Zustand store API (reference never changes across renders). */
export const AppStoreContext = createContext(null);

/** Create and keep one per-<App> Zustand store synced with changed slice references. */
export function useAppStore(slices) {
  const [store] = useState(() => createAppStore(slices));
  useLayoutEffect(() => {
    syncAppStore(store, slices);
  }, [store, slices]);
  return store;
}

/** Provider convenience wrapper for tests and shell entry points. */
export function AppStoreProvider({ store, children }) {
  return React.createElement(AppStoreContext.Provider, { value: store }, children);
}

/**
 * Fine-grained Zustand selector hook: subscribes ONLY to `selector(state)` without
 * subscribing to the monolithic `AppContext` when mounted inside `<App>` / `<AppStoreProvider>`.
 * Falls back cleanly to `AppContext` (via React 19 conditional `use()`) in standalone legacy tests.
 */
export function useAppSelector(selector) {
  const store = useContext(AppStoreContext);
  const selected = useStore(store ?? EMPTY_STORE, store ? selector : NOOP_SELECTOR);
  if (store) return selected;
  const legacy = use(AppContext);
  if (!legacy) throw new Error('useAppSelector must be used inside <App> or <AppStoreProvider>');
  return selector(legacy);
}

/**
 * Optional fine-grained Zustand selector hook for components that may also render
 * outside `<App>` (e.g. unit tests rendering a dialog or page directly).
 * Subscribes ONLY to `selector(state)` inside `<App>` with zero `AppContext` coupling.
 */
export function useOptionalAppSelector(selector) {
  const store = useContext(AppStoreContext);
  const selected = useStore(store ?? EMPTY_STORE, store ? selector : NOOP_SELECTOR);
  if (store) return selected;
  const legacy = use(AppContext);
  return legacy ? selector(legacy) : undefined;
}

/** Subscribe to a single top-level slice by key (e.g. `useAppSlice('nav')`, `useAppSlice('shell')`). */
export function useAppSlice(key) {
  return useAppSelector((state) => state[key]);
}

export const useAppData = () => useAppSelector((state) => state.data);
export const useAppNav = () => useAppSelector((state) => state.nav);
export const useAppShell = () => useAppSelector((state) => state.shell);
export const useAppBoard = () => useAppSelector((state) => state.board);
export const useAppSession = () => useAppSelector((state) => state.session);
export const useAppConnection = () => useAppSelector((state) => state.connection);
export const useAppCoreSlice = () => useAppSelector((state) => state.core);
