import { ui } from './i18n.js';
import { fixedOptionsOf } from '../lib/card-kinds.js';

/* The words an option is shown with. A kind with fixed options (判断题: 对 / 错) shows them in the page's language, whatever text the deck stored;
   every other option shows its own text (null here). The practice card, its answer line and the exam paper read the same words. */
export function fixedOptionLabel(card, option) {
  const fixed = fixedOptionsOf(card?.kind)?.find((item) => item.id === option?.id);
  return fixed ? ui(fixed.label) : null;
}

/** The letter before an option (A, B, …). */
export const optionMark = (card, option, index) => String.fromCharCode(65 + index);

/** The registry icon a fixed option shows in place of a letter (check / close for 对 / 错), or null. */
export const optionIcon = (card, option) => fixedOptionsOf(card?.kind)?.find((item) => item.id === option?.id)?.icon ?? null;
