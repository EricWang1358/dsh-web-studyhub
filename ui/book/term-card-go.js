/* global document, CSS, requestAnimationFrame */
import { flash } from './ai-anchors.js';

/* Going to a 术语卡 (#710) from a relation link or the 速查页: the point that holds it is opened first when the card is not drawn (逐节读 shows one point),
   then, once the page has drawn it, its fold opens and the card is scrolled to the middle and flashed (the same short highlight as an AI block's). */

/** The frames a card is waited for after its point was opened. */
const WAIT_FRAMES = 30;
const cardOf = code => document.querySelector(`[data-term-card="${CSS.escape(code)}"]`);

/** Is the card on the page now (its point drawn)? */
export const cardShown = code => !!cardOf(code);

/** Scroll to the card once it is drawn: its fold opened, in the middle of the window, flashed. */
export function showCard(code) {
  let left = WAIT_FRAMES;
  const look = () => {
    const card = cardOf(code);
    if (!card) { if (--left > 0) requestAnimationFrame(look); return; }
    for (let fold = card.closest('details'); fold; fold = fold.parentElement?.closest('details')) fold.open = true;
    requestAnimationFrame(() => { card.scrollIntoView({ block: 'center' }); flash([card]); });
  };
  requestAnimationFrame(look);
}
