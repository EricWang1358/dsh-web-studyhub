/* Pure helpers for SegmentedControl, kept apart so they can be unit-tested
   without a DOM. */

const FORWARD = new Set(['ArrowDown']);
const BACKWARD = new Set(['ArrowUp']);

/**
 * Which segment should take focus after `key` was pressed on segment `from`?
 * Returns the index of an enabled segment, or -1 when the key does nothing
 * (other keys, or no other enabled segment to move to). Arrow keys wrap;
 * Home/End jump to the ends. In right-to-left layouts ArrowRight points at the
 * previous segment in reading order.
 */
export function nextSegmentIndex(options, from, key, { rtl = false } = {}) {
  const enabled = options.map((option, index) => (option?.disabled ? -1 : index)).filter(index => index >= 0);
  if (!enabled.length) return -1;
  if (key === 'Home') return enabled[0];
  if (key === 'End') return enabled[enabled.length - 1];
  let step = 0;
  if (FORWARD.has(key) || key === (rtl ? 'ArrowLeft' : 'ArrowRight')) step = 1;
  else if (BACKWARD.has(key) || key === (rtl ? 'ArrowRight' : 'ArrowLeft')) step = -1;
  if (!step) return -1;
  const others = enabled.filter(index => index !== from);
  if (!others.length) return -1;
  const total = options.length;
  for (let offset = 1; offset <= total; offset += 1) {
    const index = ((from + step * offset) % total + total) % total;
    if (enabled.includes(index) && index !== from) return index;
  }
  return -1;
}

/** The segment that holds the tab stop: the active one if it can be used, else the first enabled one. */
export function tabStopIndex(options, activeIndex, groupDisabled = false) {
  const usable = index => index >= 0 && !groupDisabled && !options[index]?.disabled;
  if (usable(activeIndex)) return activeIndex;
  const first = options.findIndex((_, index) => usable(index));
  return first >= 0 ? first : (activeIndex >= 0 ? activeIndex : 0);
}
