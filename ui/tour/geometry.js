/* Where the tour popover goes. Boxes are { left, top, width, height } in the
   tour layer's own coordinates. Beside the target when there is room (below,
   above, right, left — or the step's preferred side first), centred when
   there is no target, inside the target's corner when it fills the view, and
   docked along the bottom edge on narrow panels (the ~420 px DSH sidebar). */

export const NARROW_WIDTH = 560;

const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));

export function placePopover({ target, popover, bounds, prefer, gap = 14, margin = 16, narrowWidth = NARROW_WIDTH }) {
  const { width, height } = bounds;
  if (width <= narrowWidth)
    return { side: "dock", docked: true, left: 12, top: Math.max(12, height - popover.height - 12) };
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
  for (const side of [...new Set([prefer, "bottom", "top", "right", "left"].filter((name) => sides[name]))]) {
    const placed = sides[side]();
    if (placed) return { side, docked: false, ...placed };
  }
  // The target fills the view (a whole page area): sit in its lower right corner.
  return { side: "inside", docked: false,
    left: clamp(Math.min(right, width) - popover.width - margin, margin, width - popover.width - margin),
    top: clamp(Math.min(bottom, height) - popover.height - margin, margin, height - popover.height - margin) };
}

/** The spotlight box around a target, padded and kept inside the layer. */
export function spotlightBox(target, bounds, pad = 6) {
  if (!target) return null;
  const left = Math.max(2, target.left - pad), top = Math.max(2, target.top - pad);
  const right = Math.min(bounds.width - 2, target.left + target.width + pad);
  const bottom = Math.min(bounds.height - 2, target.top + target.height + pad);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}
