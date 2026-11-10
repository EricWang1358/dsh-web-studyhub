/*
 * Where a first-use tip of the practice page goes (ui/review/PracticeTip.jsx). Everything is in viewport pixels. The tip lies over EMPTY space only: the page hands
 * over `keepClear`, the boxes of what the learner reads or presses at that moment (every line of text, every button and field, the page's own message, the divider
 * above the explanation), and the first slot that is inside the window and touches none of them wins. Nothing free: null, and the tip waits for a later moment
 * (a scroll, a message that goes away) instead of covering anything.
 *   anchor  the control the tip points at (its left edge is the tip's);   row  the tools it belongs to (their union);   block  what the control is part of
 *   (the whole toolbar, nav row included: "under" starts below it).
 *   size    the tip's own box; `sizes`: several boxes in order of preference (a narrower card passes a button at the side where the wide one cannot).
 * Slots, in order: 'under' the block (the empty band above the divider), 'over' the row (the empty padding of the card above), 'beside' the row (right of the
 * tools, level with them). Pure.
 */
export const SLOTS = Object.freeze(['under', 'over', 'beside']);
const GAP = 4, MARGIN = 8, PAD = 2;

const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

function slotAt(slot, { anchor, row, block, size, bounds, gap, margin }) {
  if (slot === 'beside') return { left: row.right + gap, top: row.top + (row.bottom - row.top - size.height) / 2 };
  const left = Math.min(Math.max(anchor.left, bounds.left + margin), bounds.right - margin - size.width);
  return { left, top: slot === 'under' ? block.bottom + gap : row.top - gap - size.height };
}

/** { placement, left, top, size } of the tip, or null when no slot is free. */
export function tipSpot({ anchor, row = anchor, block = row, size, sizes = [size], bounds, keepClear = [], gap = GAP, margin = MARGIN, pad = PAD }) {
  for (const slot of SLOTS) {
    for (const box of sizes) {
      const at = slotAt(slot, { anchor, row, block, size: box, bounds, gap, margin });
      const rect = { left: at.left, top: at.top, right: at.left + box.width, bottom: at.top + box.height };
      const free = rect.left >= bounds.left + margin && rect.right <= bounds.right - margin && rect.top >= bounds.top && rect.bottom <= bounds.bottom;
      const padded = { left: rect.left - pad, top: rect.top - pad, right: rect.right + pad, bottom: rect.bottom + pad };
      if (free && !keepClear.some(other => overlaps(padded, other))) return { placement: slot, left: at.left, top: at.top, size: box };
    }
  }
  return null;
}
