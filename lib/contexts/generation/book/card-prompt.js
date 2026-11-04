import { NEVER, cardRule, prompt } from './prompts.js';

/* The prompt of the card pass (#710 S6): the term cards of points whose explanation is already written, made from that text and the checklist items it covers
   (names and gists), never from the source pages. The cards are the write call's (S1): the same rule (prompts.js cardRule), the same reply, read by the
   same reader (cards.js). The text is not to be changed, and it is not asked back. */

export function cardPassPrompt(batch, plan) {
  return { system: 'You make the term cards of a review book whose explanations are already written: for each knowledge point, from its own written text. '
    + `The texts are ${NEVER}`, prompt: prompt([
    'Each point (k1, k2, ...) gives its written "text" and its "checklist": the items that text explains. Make the cards from the text; never rewrite it.',
    'There are no pages here: "your text" is the point\'s own text, and a card says only what that text says. A card\'s "item" is an id of its own point\'s '
      + 'checklist; a relation\'s "item" may be an id of any point of this request.',
    cardRule(plan),
    'Reply {"cards":[{"item":"c1","name":"...","alt":"...","plain":"...","pitch":"...","relations":[{"kind":"related","item":"c2"}]}]}.',
  ], { stage: 'cards', part: batch.number, language: plan.language,
    points: batch.entries.map(entry => ({ id: entry.alias, title: entry.title, ...(entry.path.length ? { under: entry.path.join(' > ') } : {}),
      ...(entry.part ? { part: entry.part } : {}), text: entry.text,
      checklist: entry.checklist.map(item => ({ id: item.alias, kind: item.kind, name: item.name, ...(item.gist ? { gist: item.gist } : {}), priority: 'must' })) })) }) };
}
