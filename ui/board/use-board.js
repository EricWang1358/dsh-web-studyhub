import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { usePolling } from '../use-polling.js';
import { createBoardStore } from './store.js';

/** One subscription serves both the navigation badge and the visible board. It lives apart from the board page so the shell can keep it
    running while the page itself loads on demand (ui/workspace-views.jsx). */
export function useBoard(call, visible, { initialBoard = null, onBoard } = {}) {
  const latest = useRef({ call, onBoard });
  latest.current = { call, onBoard };
  const initialRef = useRef(initialBoard);
  const store = useMemo(() => createBoardStore((action, args) => latest.current.call(action, args), {
    initialBoard: initialRef.current,
    onBoard: (next) => latest.current.onBoard?.(next),
  }), []);
  const snapshot = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  useEffect(() => {
    store.refresh();
    return () => store.invalidate();
  }, [store, visible]);
  usePolling(() => store.refresh(), { intervalMs: visible ? 5000 : 30000 });
  return useMemo(() => ({ ...snapshot, mutate: store.mutate, refresh: store.refresh, clearError: store.clearError }), [snapshot, store]);
}
