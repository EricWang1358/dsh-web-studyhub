import { ui, uiFormat } from '../i18n.js';

/* The way back of a practice round that was started in the 复习全书 or on the 总纲 (ui/Review.jsx): there it is the main button of the result page and
   the label of the return button in the header, in the words of the page it leads to. Every other trail (the home, a note, the reader, a workflow ...)
   keeps the page's own next step as its main button and its own words. A round started from the reader that was open over the book is the reader's:
   its trail leads back to the reader (trailKindOf), never to the page behind it.
   context: the page's `context` ({ kind: the page the trail leads to, place: the point the learner left from (the book's only), onReturn }).
   Returns null when the trail is not one of these two, else { label, place, go }: place is the quiet second line ('' when the page does not know it). */
export function wayBackOf(context) {
  const { kind, place, onReturn } = context || {};
  if (!onReturn || (kind !== 'book' && kind !== 'outline')) return null;
  return { label: kind === 'book' ? ui('回到复习全书') : ui('回到总纲'), place: kind === 'book' && place ? uiFormat('回到 {0}', [place]) : '', go: onReturn };
}

/** The page a trail entry leads back to. An entry captured with the reader open over a page (a footnote or a 出处 opens the reader as a dialog) leads back to the
    reader, so it is not the page behind it: '' (the book's way back is only for a round started from the book page itself). */
export const trailKindOf = (origin) => (origin?.modal ? '' : origin?.page || '');

/** Is this next step only another place to go back to (回到学习路径)? A round that has its own way back (the book's) does not offer one: its second button may only be a
    forward step of the round (the next batch, the rest of the scope, the next task). `destination` is the page's decision (ui/review/session-logic.js continueDestination). */
export const isBackDestination = (destination) => destination?.kind === 'path' && !!destination.reason && destination.reason !== 'continuing';
