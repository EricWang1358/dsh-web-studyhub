import { ui, uiFormat } from '../i18n.js';

/* The way back of a practice round that was started in the 复习全书 or on the 总纲 (ui/Review.jsx): there it is the main button of the result page and
   the label of the return button in the header, in the words of the page it leads to. Every other trail (the home, a note, the reader, a workflow ...)
   keeps the page's own next step as its main button and its own words.
   context: the page's `context` ({ kind: the page the trail leads to, place: the point the learner left from (the book's only), onReturn }).
   Returns null when the trail is not one of these two, else { label, place, go }: place is the quiet second line ('' when the page does not know it). */
export function wayBackOf(context) {
  const { kind, place, onReturn } = context || {};
  if (!onReturn || (kind !== 'book' && kind !== 'outline')) return null;
  return { label: kind === 'book' ? ui('回到复习全书') : ui('回到总纲'), place: kind === 'book' && place ? uiFormat('回到 {0}', [place]) : '', go: onReturn };
}
