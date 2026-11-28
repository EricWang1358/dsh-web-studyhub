/* Where the tour popover goes. Boxes are { left, top, width, height } in the
   tour layer's own coordinates. Beside the target when there is room (below,
   above, right, left — or the step's preferred side first), centred when
   there is no target, and docked along the bottom edge on narrow panels (the
   ~420 px DSH sidebar).

   Two things stay uncovered. `avoid` is what introduces the page on screen
   (#1712: its title, and for a step that came from the sidebar its first
   block, most important first): a side that would cover one is slid along the
   target, or the card goes to a free corner. And the card never lies on the
   lit area: a target with no room around it is lit only as far as the card
   (the placement then says what is lit, `spot`). */

import { drawnScale } from "../drawn-scale.js";

export const NARROW_WIDTH = 560;
/** How much of a tall target stays lit at the least (px): less than this is not recognised as the thing the step talks about. */
const MIN_LIT = 96;
const MIN_LIT_WIDE = 160;
/** The docked card's inset from the edges, and the air between it and the lit area. */
const DOCK_EDGE = 12, DOCK_AIR = 8;

const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));
const shared = (a, b) => Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left)) *
  Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top));

/* The narrow panel's sheet. It stays at the bottom, and a target that reaches under it is lit down to its edge. A bar pinned to the bottom of the view
   (`pinned`) cannot be scrolled above it: the sheet moves to the top instead. */
function dock(target, popover, bounds, pinned) {
  const bottom = { side: "dock", docked: true, left: DOCK_EDGE, top: Math.max(DOCK_EDGE, bounds.height - popover.height - DOCK_EDGE) };
  const floor = bottom.top - DOCK_AIR;
  if (!target || target.top + target.height <= floor) return bottom;
  if (floor - target.top >= Math.min(MIN_LIT, target.height)) return { ...bottom, spot: { ...target, height: floor - target.top } };
  if (pinned && target.top >= DOCK_EDGE + popover.height + DOCK_AIR) return { ...bottom, side: "dock-top", top: DOCK_EDGE };
  return bottom;
}

export function placePopover({ target, popover, bounds, prefer, avoid = [], pinned = false, gap = 14, margin = 16, narrowWidth = NARROW_WIDTH }) {
  const { width, height } = bounds;
  if (width <= narrowWidth) return dock(target, popover, bounds, pinned);
  const centred = { side: "center", docked: false,
    left: clamp((width - popover.width) / 2, margin, width - popover.width - margin),
    top: clamp((height - popover.height) / 2, margin, height - popover.height - margin) };
  if (!target) return centred;
  const right = target.left + target.width, bottom = target.top + target.height;
  // A target taller than the view: centre on the part that is visible.
  const middleY = (Math.max(target.top, 0) + Math.min(bottom, height)) / 2;
  const middleX = (Math.max(target.left, 0) + Math.min(right, width)) / 2;
  const across = clamp(middleX - popover.width / 2, margin, width - popover.width - margin);
  const along = clamp(middleY - popover.height / 2, margin, height - popover.height - margin);
  const sides = {
    bottom: () => height - bottom >= popover.height + gap + margin && { left: across, top: bottom + gap },
    top: () => target.top >= popover.height + gap + margin && { left: across, top: target.top - gap - popover.height },
    right: () => width - right >= popover.width + gap + margin && { left: right + gap, top: along },
    left: () => target.left >= popover.width + gap + margin && { left: target.left - gap - popover.width, top: along },
  };
  const beside = [...new Set([prefer, "bottom", "top", "right", "left"].filter((name) => sides[name]))]
    .flatMap((side) => { const placed = sides[side](); return placed ? [{ side, docked: false, ...placed }] : []; });
  const card = (placed) => ({ left: placed.left, top: placed.top, width: popover.width, height: popover.height });
  const clear = (placed) => avoid.every((box) => !shared(card(placed), box));
  const open = beside.find(clear);
  if (open) return open;
  // The target fills the view (a whole page area): its lower right corner.
  const within = { side: "inside", docked: false,
    left: clamp(Math.min(right, width) - popover.width - margin, margin, width - popover.width - margin),
    top: clamp(Math.min(bottom, height) - popover.height - margin, margin, height - popover.height - margin) };
  // The same side, moved along the target until it is past what must stay clear; it keeps its caret only while it still faces the target.
  const slid = beside.flatMap((placed) => {
    const vertical = placed.side === "right" || placed.side === "left";
    const spots = avoid.map((box) => vertical
      ? { ...placed, top: clamp(box.top + box.height + gap, margin, height - popover.height - margin) }
      : { ...placed, left: clamp(box.left + box.width + gap, margin, width - popover.width - margin) });
    return spots.map((spot) => {
      const faces = vertical ? Math.min(spot.top + popover.height, bottom) - Math.max(spot.top, target.top)
        : Math.min(spot.left + popover.width, right) - Math.max(spot.left, target.left);
      return faces >= Math.min(44, vertical ? target.height : target.width) ? spot : { ...spot, side: "free" };
    });
  });
  // Free corners of the view, the lower ones first: the top of a page is what introduces it.
  const corners = [[1, 1], [0, 1], [1, 0], [0, 0]].map(([x, y]) => ({ side: "free", docked: false,
    left: x ? width - popover.width - margin : margin, top: y ? height - popover.height - margin : margin }));
  const away = (placed) => !shared(card(placed), target) && clear(placed);
  const free = slid.find(away) || corners.find(away);
  if (free) return free;
  // No room around the target: light its top and put the card under that.
  const floor = height - margin - popover.height - gap;
  const cut = floor - target.top >= MIN_LIT_WIDE && floor < bottom
    ? { side: "bottom", docked: false, left: across, top: floor + gap, spot: { ...target, height: floor - target.top } } : null;
  if (cut && clear(cut)) return cut;
  if (!avoid.length) return cut || within;
  // Something has to give: the lit area stays uncovered first, then the boxes in the order they matter.
  const cost = (placed) => [placed.spot ? 0 : shared(card(placed), target), ...avoid.map((box) => shared(card(placed), box))];
  const worse = (a, b) => { for (let at = 0; at < a.length; at += 1) if (a[at] !== b[at]) return a[at] - b[at]; return 0; };
  return [...beside, ...slid, ...corners, ...(cut ? [cut] : []), within].map((placed) => ({ placed, cost: cost(placed) }))
    .sort((a, b) => worse(a.cost, b.cost))[0].placed;
}

/** The zoom between screen pixels and the layer's own CSS pixels (ui/drawn-scale.js); 1 while there is no layer or rectangle. */
export const layerScale = (view, layer) => (view ? drawnScale(layer, view) : 1);

/** A screen rectangle in the layer's own coordinates, where the spotlight and the popover are placed. */
export const inLayer = (box, view, scale = 1) => ({ left: (box.left - view.left) / scale, top: (box.top - view.top) / scale,
  width: box.width / scale, height: box.height / scale });

/** The spotlight box around a target, padded and kept inside the layer. */
export function spotlightBox(target, bounds, pad = 6) {
  if (!target) return null;
  const left = Math.max(2, target.left - pad), top = Math.max(2, target.top - pad);
  const right = Math.min(bounds.width - 2, target.left + target.width + pad);
  const bottom = Math.min(bounds.height - 2, target.top + target.height + pad);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}
