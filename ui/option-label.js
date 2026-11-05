import { ui } from './i18n.js';
import { fixedOptionsOf } from '../lib/card-kinds.js';

/* The words an option is shown with. A kind with fixed options (判断题: 对 / 错) shows them in the page's language, whatever text the deck stored;
   every other option shows its own text (null here). The practice card, its answer line and the exam paper read the same words. */
export function fixedOptionLabel(card, option) {
  const fixed = fixedOptionsOf(card?.kind)?.find((item) => item.id === option?.id);
  return fixed ? ui(fixed.label) : null;
}

/** The mark before an option: its letter (A, B, …), or the fixed option's own mark (✓ / ✕ for 对 / 错). */
export function optionMark(card, option, index) {
  return fixedOptionsOf(card?.kind)?.find((item) => item.id === option?.id)?.mark ?? String.fromCharCode(65 + index);
}
