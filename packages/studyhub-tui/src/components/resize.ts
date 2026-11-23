import { useEffect, useRef, useState } from 'react';
import { useWindowSize } from 'ink';

export interface WindowDimensions {
  columns: number;
  rows: number;
}

export const DEFAULT_RESIZE_DEBOUNCE_MS = 48;
export const MIN_TERMINAL_COLS = 20;
export const MIN_TERMINAL_ROWS = 6;

export function clampDimensions(columns: number, rows: number): WindowDimensions {
  return {
    columns: Number.isFinite(columns) && columns > 0 ? Math.max(MIN_TERMINAL_COLS, Math.floor(columns)) : 80,
    rows: Number.isFinite(rows) && rows > 0 ? Math.max(MIN_TERMINAL_ROWS, Math.floor(rows)) : 24,
  };
}

export function resolveResizeDebounceMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = String(env.STUDYHUB_TUI_RESIZE_DEBOUNCE_MS ?? '').trim();
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(500, parsed) : DEFAULT_RESIZE_DEBOUNCE_MS;
}

export interface ResizeCoalescer {
  push: (columns: number, rows: number) => void;
  flush: () => void;
  dispose: () => void;
  current: () => WindowDimensions;
}

export function createResizeCoalescer(
  initial: WindowDimensions,
  onCommit: (next: WindowDimensions) => void,
  debounceMs = DEFAULT_RESIZE_DEBOUNCE_MS,
): ResizeCoalescer {
  let committed = clampDimensions(initial.columns, initial.rows);
  let pending: WindowDimensions | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const delay = Math.max(0, Math.floor(debounceMs));

  const cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const commit = (dims: WindowDimensions) => {
    if (dims.columns === committed.columns && dims.rows === committed.rows) return;
    committed = dims;
    onCommit(committed);
  };
  const flush = () => {
    cancel();
    if (!pending) return;
    const next = pending;
    pending = null;
    commit(next);
  };

  return {
    push(columns: number, rows: number) {
      const next = clampDimensions(columns, rows);
      if (delay === 0) {
        pending = null;
        cancel();
        commit(next);
        return;
      }
      if (next.columns === committed.columns && next.rows === committed.rows) {
        pending = null;
        cancel();
        return;
      }
      pending = next;
      cancel();
      timer = setTimeout(flush, delay);
    },
    flush,
    dispose() {
      cancel();
      pending = null;
    },
    current: () => committed,
  };
}

export function useStableWindowSize(debounceMs = resolveResizeDebounceMs()): WindowDimensions {
  const raw = useWindowSize();
  const [size, setSize] = useState<WindowDimensions>(() => clampDimensions(raw.columns, raw.rows));
  const ref = useRef<ResizeCoalescer | null>(null);
  if (!ref.current) {
    ref.current = createResizeCoalescer(
      size,
      (next) => setSize((p) => (p.columns === next.columns && p.rows === next.rows ? p : next)),
      debounceMs,
    );
  }
  useEffect(() => {
    ref.current?.push(raw.columns, raw.rows);
  }, [raw.columns, raw.rows]);
  useEffect(() => () => ref.current?.dispose(), []);
  return size;
}
