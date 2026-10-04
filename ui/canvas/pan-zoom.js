/* The arithmetic of a pan/zoom canvas, apart from React so it can be tested.
   A view is { k, x, y }: the drawing is scaled by k and translated by (x, y)
   inside an element of `box` pixels. */

export const ZOOM_LIMITS = { min: 0.02, max: 2.5 };

export const clampZoom = (k, { min, max } = ZOOM_LIMITS) => Math.min(max, Math.max(min, k));

/**
 * The view that shows `bounds` ({ w, h }) in `box` ({ width, height }).
 * initial: the first view of a drawing; it never shrinks below `minInitial`
 * (a big drawing opens readable and anchored on (anchorX, anchorY) instead of
 * as a speck). insetRight keeps the drawing clear of an overlay panel on the
 * right of a wide canvas. maxFit stops a small drawing being blown up.
 */
export function fitTransform({ box, bounds, initial = false, maxFit = 1.2, insetRight = 0, minInitial = 0.9, anchorX = 0, anchorY = 0,
  vertical = false, zoomMin, zoomMax }) {
  const inset = box.width < 600 ? 0 : Math.min(insetRight, box.width * 0.6);
  const room = box.width - inset;
  const fitK = Math.min(maxFit, (room - 32) / bounds.w, (box.height - 32) / bounds.h);
  const k = clampZoom(Math.max(initial ? minInitial : 0, fitK), { min: zoomMin ?? ZOOM_LIMITS.min, max: zoomMax ?? ZOOM_LIMITS.max });
  const cropped = initial && k > fitK;
  return {
    k,
    x: cropped ? (vertical || room < 600 ? room / 2 : Math.min(room / 4, 160)) - anchorX * k : (room - bounds.w * k) / 2,
    y: cropped ? (vertical ? Math.min(80, box.height / 4) : box.height / 2) - anchorY * k : (box.height - bounds.h * k) / 2,
  };
}

/** Scale the view by `factor` around the point (cx, cy) of the box, which stays where it is. */
export function zoomAround(view, factor, cx, cy, limits = ZOOM_LIMITS) {
  const k = clampZoom(view.k * factor, limits);
  return { k, x: cx - ((cx - view.x) * k) / view.k, y: cy - ((cy - view.y) * k) / view.k };
}

/** Back to 1:1 around the middle of the box. */
export function readableView(view, box) {
  const cx = box.width / 2, cy = box.height / 2;
  return { k: 1, x: cx - (cx - view.x) / view.k, y: cy - (cy - view.y) / view.k };
}

/** Put the drawing point (x, y) in the middle of the box. */
export const centerOn = (view, box, x, y) => ({ ...view, x: box.width / 2 - x * view.k, y: box.height / 2 - y * view.k });

/** How a canvas key moves the view: arrows pan, + and - zoom, 0 fits. */
export function keyAction(key) {
  const pan = { ArrowLeft: [60, 0], ArrowRight: [-60, 0], ArrowUp: [0, 60], ArrowDown: [0, -60] }[key];
  if (pan) return { type: 'pan', dx: pan[0], dy: pan[1] };
  if (key === '+' || key === '=') return { type: 'zoom', factor: 1.2 };
  if (key === '-' || key === '_') return { type: 'zoom', factor: 1 / 1.2 };
  if (key === '0') return { type: 'fit' };
  return null;
}

/** A press that moves less than this stays a click (a node is opened, not dragged). */
export const PAN_SLOP = 4;
