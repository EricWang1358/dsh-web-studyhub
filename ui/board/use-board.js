import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { usePolling } from '../use-polling.js';
import { createBoardStore } from './store.js';

const BOARD_LIVE_PAGES = new Set(['board', 'dashboard', 'review']);

/** Pages where board state (including the shared 25+5 focus timer) polls at the active 5s cadence. */
export const boardSyncsOnPage = (page) => BOARD_LIVE_PAGES.has(page);

/** One subscription serves both the navigation badge and the visible board. It lives apart from the board page so the shell can keep it
    running while the page itself loads on demand (ui/workspace-views.jsx). Also keeps active 5s sync while a focus timer is running. */
export function useBoard(call, visible, { initialBoard = null, onBoard } = {}) {
  const latest = useRef({ call, onBoard });
  latest.current = { call, onBoard };
  const initialRef = useRef(initialBoard);
  const store = useMemo(() => createBoardStore((action, args) => latest.current.call(action, args), {
    initialBoard: initialRef.current,
    onBoard: (next) => latest.current.onBoard?.(next),
  }), []);
  const snapshot = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const active = Boolean(visible || snapshot.board?.timer);
  useEffect(() => {
    store.refresh();
    return () => store.invalidate();
  }, [store, active]);
  usePolling(() => store.refresh(), { intervalMs: active ? 5000 : 30000 });
  return useMemo(() => ({ ...snapshot, mutate: store.mutate, refresh: store.refresh, clearError: store.clearError }), [snapshot, store]);
}
