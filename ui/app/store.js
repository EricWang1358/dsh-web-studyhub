/* Fine-grained Zustand store backing the StudyHub workbench shell.
   Splits the monolithic AppContext into independently subscribable slices so
   leaf components using `useAppSelector` / `useAppSlice` re-render only when
   their own slice changes, while preserving the backward-compatible `useApp()`
   facade in `ui/app/app-context.js` for existing pages and tests. */

import React, { createContext, useContext } from 'react';
import { createStore, useStore } from 'zustand';

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

/** Stable React context carrying the Zustand store API (reference never changes across renders). */
export const AppStoreContext = createContext(null);

/** Provider convenience wrapper for tests and shell entry points. */
export function AppStoreProvider({ store, children }) {
  return React.createElement(AppStoreContext.Provider, { value: store }, children);
}

/**
 * Fine-grained Zustand selector hook: subscribes ONLY to `selector(state)` without
 * subscribing to the monolithic `AppContext`.
 */
export function useAppSelector(selector) {
  const store = useContext(AppStoreContext);
  if (!store) throw new Error('useAppSelector must be used inside <App> or <AppStoreProvider>');
  return useStore(store, selector);
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
