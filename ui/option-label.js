import { ui } from './i18n.js';
import { fixedOptionsOf } from '../lib/card-kinds.js';

/* The words an option is shown with. A kind with fixed options (判断题: 对 / 错) shows them in the page's language, whatever text the deck stored;
   every other option shows its own text (null here). The practice card, its answer line and the exam paper read the same words. */
export function fixedOptionLabel(card, option) {
  const fixed = fixedOptionsOf(card?.kind)?.find((item) => item.id === option?.id);
  return fixed ? ui(fixed.label) : null;
}

/** What stands in the round before an option: its letter (A, B, …); for a fixed option (判断题: 对 / 错) its number, the key that picks it. Never a tick or a cross:
    those are the verdict's (ui/review/AnswerState.jsx) and would say "right" / "wrong" about an option that is only "对". */
export const optionMark = (card, option, index) => (fixedOptionsOf(card?.kind) ? String(index + 1) : String.fromCharCode(65 + index));
