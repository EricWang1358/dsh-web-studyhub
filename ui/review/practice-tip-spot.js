import { computePlacement } from '../components/use-dismiss.js';

/*
 * Where a first-use tip of the practice page goes (ui/review/PracticeTip.jsx). Everything is in viewport pixels: `anchor` is the control the tip points at,
 * `size` the tip's own box, `bounds` the window, `avoid` the boxes of what the learner needs next (下一题, 上一题, 更多): the tip never lies on them when
 * either side of the control is free of them. Under the control first (the question stays in view); above it when there is no room below or when
 * something to avoid is below; when both sides cover something, the side that covers less. Pure.
 */
const GAP = 4, MARGIN = 8;

const overlapArea = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

/** { left, top, placement } of the tip. */
export function tipSpot({ anchor, size, bounds, avoid = [], gap = GAP, margin = MARGIN }) {
  const sides = ['bottom-start', 'top-start'].map(placement => {
    const spot = computePlacement({ anchor, size, bounds, placement, flip: false, gap, margin });
    const rect = { left: spot.left, top: spot.top, right: spot.left + size.width, bottom: spot.top + size.height };
    return { placement: spot.placement, left: spot.left, top: spot.top, room: spot.maxHeight >= size.height, covered: avoid.reduce((sum, box) => sum + overlapArea(rect, box), 0) };
  });
  const clear = sides.find(side => side.room && side.covered === 0);
  const chosen = clear ?? [...sides].sort((a, b) => (b.room - a.room) || (a.covered - b.covered))[0];
  return { placement: chosen.placement, left: chosen.left, top: chosen.top };
}
