/**
 * Parks the real terminal cursor on the caret of the focused text field (#1413).
 *
 * Terminals draw the IME candidate window (Chinese / Japanese / Korean input) next to the real
 * cursor. Ink normally leaves that cursor at the end of its output — the bottom-left corner — so the
 * candidates opened far away from the field being typed in. Mount this only inside the ACTIVE field:
 * an unmounted anchor never touches the cursor, so inactive fields cannot hide it.
 */
import { useEffect, useState, type RefObject } from 'react';
import { useBoxMetrics, useCursor, type DOMElement } from 'ink';

export interface CaretOffset {
  /** Columns from the left edge of the field's root box to the caret cell. */
  dx: number;
  /** Rows from the top edge of the field's root box to the caret row. */
  dy: number;
}

/** Absolute position of `node` inside the Ink output, or null before the first layout pass. */
export function absoluteOrigin(node: DOMElement | null | undefined): { x: number; y: number } | null {
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

export function ImeCursorAnchor({ anchorRef, dx, dy }: CaretOffset & { anchorRef: RefObject<DOMElement | null> }): null {
  const { setCursorPosition } = useCursor();
  const [, setLayoutTick] = useState(0);
  // Layout exists only after the first commit; render once more so the caret lands on the field.
  useEffect(() => {
    setLayoutTick((n) => n + 1);
  }, []);
  // Re-render when the field itself moves or resizes (terminal resize, panel re-flow).
  useBoxMetrics(anchorRef as RefObject<DOMElement>);
  const origin = absoluteOrigin(anchorRef.current);
  setCursorPosition(origin ? { x: origin.x + Math.max(0, dx), y: origin.y + Math.max(0, dy) } : undefined);
  return null;
}
