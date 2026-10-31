import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { usePolling } from '../use-polling.js';
import { createBoardStore } from './store.js';

/** One subscription serves both the navigation badge and the visible board. It lives apart from the board page so the shell can keep it
    running while the page itself loads on demand (ui/workspace-views.jsx). */
export function useBoard(call, visible) {
  const latest = useRef(call);
  latest.current = call;
  const store = useMemo(() => createBoardStore((action, args) => latest.current(action, args)), []);
  const snapshot = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  useEffect(() => {
    store.refresh();
    return () => store.invalidate();
  }, [store, visible]);
  usePolling(() => store.refresh(), { intervalMs: visible ? 5000 : 30000 });
  return useMemo(() => ({ ...snapshot, mutate: store.mutate, refresh: store.refresh, clearError: store.clearError }), [snapshot, store]);
}
