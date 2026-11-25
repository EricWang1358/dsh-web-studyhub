/**
 * Parks the real terminal cursor on the caret of the focused text field (#1413 / #1428).
 *
 * Terminals draw the IME candidate window (Chinese / Japanese / Korean input) next to the real
 * cursor. Ink normally leaves that cursor at the end of its output — the bottom-left corner — so the
 * candidates opened far away from the field being typed in. Mount this only inside the ACTIVE field:
 * an unmounted anchor never touches the cursor, so inactive fields cannot hide it.
 *
 * #1428 follow-up: Ink's `useBoxMetrics` only tracks a node's *relative* box metrics (width, height,
 * left/top inside its direct parent). When an ancestor or sibling above the field shifts layout
 * (streaming output, sidebar toggle, dock open, toast/banner), the field's own relative left/top can
 * stay 0 while its absolute origin changes. Subscribing to Ink's root layout listener lets us
 * recompute `absoluteOrigin` on every Yoga layout commit and immediately re-park the cursor without
 * waiting for the next keystroke.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useBoxMetrics, useCursor, type DOMElement } from 'ink';

export interface CaretOffset {
  /** Columns from the left edge of the field's root box to the caret cell. */
  dx: number;
  /** Rows from the top edge of the field's root box to the caret row. */
  dy: number;
}

export interface ImeCursorPosition {
  x: number;
  y: number;
}

interface InkRootLike extends DOMElement {
  internal_layoutListeners?: Set<() => void>;
}

/** Absolute position of `node` inside the Ink output, or null before the first layout pass. */
export function absoluteOrigin(node: DOMElement | null | undefined): ImeCursorPosition | null {
  if (!node?.yogaNode) return null;
  let x = 0;
  let y = 0;
  for (let cur: DOMElement | undefined = node; cur; cur = cur.parentNode) {
    if (!cur.yogaNode) return null;
    x += cur.yogaNode.getComputedLeft();
    y += cur.yogaNode.getComputedTop();
  }
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/** Pure cursor coordinate helper: combines measured root-relative origin with caret offset. */
export function resolveImeCursorPosition(
  node: DOMElement | null | undefined,
  dx: number,
  dy: number,
): ImeCursorPosition | undefined {
  const origin = absoluteOrigin(node);
  return origin ? { x: origin.x + Math.max(0, dx), y: origin.y + Math.max(0, dy) } : undefined;
}

/**
 * Subscribe to Ink's root Yoga layout pass from any descendant DOMElement so ancestor/sibling shifts
 * trigger immediate cursor recomputation with zero timers or polling.
 */
export function subscribeRootLayout(
  node: DOMElement | null | undefined,
  listener: () => void,
): () => void {
  if (!node) return () => {};
  let root: DOMElement = node;
  while (root.parentNode) root = root.parentNode;
  if (root.nodeName !== 'ink-root') return () => {};
  const inkRoot = root as InkRootLike;
  if (!inkRoot.internal_layoutListeners) {
    inkRoot.internal_layoutListeners = new Set();
  }
  inkRoot.internal_layoutListeners.add(listener);
  return () => {
    inkRoot.internal_layoutListeners?.delete(listener);
  };
}

export function ImeCursorAnchor({
  anchorRef,
  dx,
  dy,
  onPositionChange,
}: CaretOffset & {
  anchorRef: RefObject<DOMElement | null>;
  /** Optional observer invoked whenever the resolved cursor position changes (useful for tests). */
  onPositionChange?: (pos: ImeCursorPosition | undefined) => void;
}): null {
  const { setCursorPosition } = useCursor();
  const [, setOrigin] = useState<ImeCursorPosition | null>(null);
  const lastReportedRef = useRef<ImeCursorPosition | undefined>(undefined);

  const syncOrigin = useCallback(() => {
    const next = absoluteOrigin(anchorRef.current);
    setOrigin((prev) => {
      if (prev === next) return prev;
      if (prev && next && prev.x === next.x && prev.y === next.y) return prev;
      return next;
    });
  }, [anchorRef]);

  // Runs after every commit of this subtree to pick up initial measurement & local shifts.
  useEffect(syncOrigin);

  // Subscribe to root Yoga layout commits so ancestor/sibling shifts immediately re-park the cursor
  // even when this field's own relative box metrics did not change.
  useEffect(() => {
    syncOrigin();
    let disposed = false;
    const unsub = subscribeRootLayout(anchorRef.current, () => {
      queueMicrotask(() => {
        if (!disposed) syncOrigin();
      });
    });
    return () => {
      disposed = true;
      unsub();
    };
  }, [anchorRef, syncOrigin]);

  // Keep Ink's own direct-box metrics subscription for field resize / direct re-flow.
  useBoxMetrics(anchorRef as RefObject<DOMElement>);

  const pos = resolveImeCursorPosition(anchorRef.current, dx, dy);
  setCursorPosition(pos);

  useEffect(() => {
    const prev = lastReportedRef.current;
    if (prev?.x === pos?.x && prev?.y === pos?.y) return;
    lastReportedRef.current = pos;
    onPositionChange?.(pos);
  }, [pos, onPositionChange]);

  return null;
}
