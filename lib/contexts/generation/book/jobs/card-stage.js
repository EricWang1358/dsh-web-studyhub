import { policyOf } from '../../inventory/policy.js';
import { cardBatches, cardEntries } from '../card-batches.js';
import { cardPassPrompt } from '../card-prompt.js';
import { readCardPass } from '../cards.js';

/* The card pass of a build (#710 S6), after the writing: every unit with a written text and no term cards (book/card-batches.js) gets its term cards from that text,
   one call per batch, in the attempt's one pool. Only `cards` of the unit is set: its text, cites, coverage and status stay as they were. A batch whose call
   failed leaves its units without cards (the next build asks them again) and counts as a part not done. Nothing missing: no call. */

/** The body with the cards of its unit `at` set; everything else as it was. */
export const withUnitCards = (body, at, cards) => ({ ...body, units: body.units.map((unit, k) => (k === at ? { ...unit, cards } : unit)) });

/** The batches of this build: the units of the points it may touch (one point when it fills one point's gaps). */
export const cardPassOf = (items, plan) => cardBatches(cardEntries(items, { point: plan.point }));

/** What a card pass costs, before it runs: the points it gives cards to and its calls (one a batch). */
export const cardPassSize = batches => ({ points: new Set(batches.flatMap(batch => batch.entries.map(entry => entry.item.id))).size, calls: batches.length });

export async function cardStage(ctx, work) {
  const { plan, state, show, parallel } = ctx, batches = cardPassOf(work.items, plan);
  Object.assign(state.cards, { done: 0, total: batches.length });
  if (!batches.length) return;
  state.stage = 'cards'; show();
  const policy = policyOf('cards', plan.efforts);
  await parallel.each(batches, async batch => {
    const answer = await parallel.ask(batch.key, { stage: 'cards', part: batch.number, parts: batches.length }, policy, cardPassPrompt(batch, plan),
      text => readCardPass(text, batch));
    if (answer) batch.entries.forEach((entry, k) => {
      if (!answer[k].length) return;
      entry.item.body = withUnitCards(entry.item.body, entry.at, answer[k]);
      state.cards.made += answer[k].length;
    });
    else state.missed++;
    state.cards.done++; show();
  }, 'cards');
}
