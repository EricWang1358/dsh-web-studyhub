import { useEffect, useRef, useState } from 'react';
import { useWindowSize } from 'ink';

export interface WindowDimensions {
  columns: number;
  rows: number;
}

export const DEFAULT_RESIZE_DEBOUNCE_MS = 48;
export const MIN_TERMINAL_COLS = 20;
export const MIN_TERMINAL_ROWS = 6;

export const clampDimensions = (c: number, r: number): WindowDimensions => ({
  columns: Number.isFinite(c) && c > 0 ? Math.max(MIN_TERMINAL_COLS, Math.floor(c)) : 80,
  rows: Number.isFinite(r) && r > 0 ? Math.max(MIN_TERMINAL_ROWS, Math.floor(r)) : 24,
});

export function resolveResizeDebounceMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(String(env.STUDYHUB_TUI_RESIZE_DEBOUNCE_MS ?? '').trim(), 10);
  return Number.isFinite(n) && n >= 0 ? Math.min(500, n) : DEFAULT_RESIZE_DEBOUNCE_MS;
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
  let cur = clampDimensions(initial.columns, initial.rows);
  let pend: WindowDimensions | null = null;
  let tmr: ReturnType<typeof setTimeout> | null = null;
  let last = 0;
  const d = Math.max(0, Math.floor(debounceMs));
  const clr = () => { if (tmr !== null) { clearTimeout(tmr); tmr = null; } };
  const go = (x: WindowDimensions) => {
    if (x.columns === cur.columns && x.rows === cur.rows) return;
    cur = x;
    last = Date.now();
    onCommit(cur);
  };
  const flush = () => { clr(); if (pend) { const n = pend; pend = null; go(n); } };
  return {
    push(c: number, r: number) {
      const n = clampDimensions(c, r);
      if (n.columns === cur.columns && n.rows === cur.rows) { pend = null; clr(); return; }
      const p = pend ?? cur;
      if (d === 0 || Math.abs(n.columns - p.columns) >= 10 || Math.abs(n.rows - p.rows) >= 4 || (tmr === null && Date.now() - last >= d)) {
        pend = null; clr(); go(n); return;
      }
      pend = n; clr(); tmr = setTimeout(flush, d);
    },
    flush,
    dispose: () => { clr(); pend = null; },
    current: () => cur,
  };
}

export function useStableWindowSize(ms = resolveResizeDebounceMs()): WindowDimensions {
  const raw = useWindowSize();
  const next = clampDimensions(raw.columns, raw.rows);
  const [, bump] = useState(0);
  const st = useRef<{ cur: WindowDimensions; pend: WindowDimensions | null; tmr: ReturnType<typeof setTimeout> | null; last: number }>({
    cur: next,
    pend: null,
    tmr: null,
    last: 0,
  });
  const s = st.current;
  const d = Math.max(0, Math.floor(ms));
  if (next.columns !== s.cur.columns || next.rows !== s.cur.rows) {
    const p = s.pend ?? s.cur;
    const immediate = d === 0 || Math.abs(next.columns - p.columns) >= 10 || Math.abs(next.rows - p.rows) >= 4 || (s.tmr === null && Date.now() - s.last >= d);
    if (immediate) {
      if (s.tmr !== null) { clearTimeout(s.tmr); s.tmr = null; }
      s.pend = null;
      s.cur = next;
      s.last = Date.now();
    } else {
      s.pend = next;
    }
  } else if (s.tmr !== null) {
    clearTimeout(s.tmr);
    s.tmr = null;
    s.pend = null;
  }
  useEffect(() => {
    const x = st.current;
    if (!x.pend || d <= 0) return undefined;
    if (x.tmr !== null) clearTimeout(x.tmr);
    x.tmr = setTimeout(() => {
      x.tmr = null;
      if (!x.pend) return;
      x.cur = x.pend;
      x.pend = null;
      x.last = Date.now();
      bump((v) => v + 1);
    }, d);
    return undefined;
  }, [raw.columns, raw.rows, d]);
  useEffect(() => () => { if (st.current.tmr !== null) clearTimeout(st.current.tmr); }, []);
  return s.cur;
}
