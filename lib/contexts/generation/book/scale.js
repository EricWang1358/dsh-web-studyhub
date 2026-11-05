import { createTextMeasure } from '../../../token-estimate.js';
import { REPAIR_ROUNDS, SAMPLE_FROM } from './constants.js';
import { planConfusables } from './confusables/plan.js';
import { planKit } from './kit/plan.js';

/* The scale of a review book build before it starts (#708): the points it would write (of the picked chapters, else the whole book; a point kept as it is
   costs nothing), its calls and the material those calls read, from the same plan of the points the build makes (book/work.js). Every unit of a point is
   written once and reviewed; one that fails is repaired and reviewed again, at most REPAIR_ROUNDS times: the low end is a write and a review a unit, the high
   end every repair. The inventory still to read, the exam notes, the answer kit's calls (kit/plan.js) and the comparisons of the confusable pairs the cards the book
   holds now still lack (confusables/plan.js; a point still to be written brings its cards, and pairs, only once written) are counted as planned. The prompts and what the
   model writes (and thinks) are not counted: a big build measures those with its sample (book/estimate.js). Tokens as the repo prices text
   (lib/token-estimate.js); no prices anywhere. Pure. */

/** The calls of one unit's chain: a write and a review at the low end, every repair round (a repair and a review again) at the high end. */
export const CHAIN_LOW = 2;
const CHAIN_HIGH = CHAIN_LOW + 2 * REPAIR_ROUNDS;
const unitText = unit => unit.segments.map(segment => segment.text).join('\n');
const callText = call => call.ranges.flatMap(range => range.pieces.map(piece => piece.text)).join('\n');

/**
 * @param plan the build's plan (book/plan.js planBook); `work` its points as bookWork plans them on the outline as it is.
 * @returns { points, chapters (picked, or null for the whole book), sample (it starts with a sample of two), calls: { low, high }, readTokens: { low, high } }
 */
export function bookScale(plan, work) {
  const measure = createTextMeasure(), items = work.items.filter(item => item.mode !== 'keep'), units = items.flatMap(item => item.units);
  const pairs = planConfusables(work.items, { language: plan.language, previous: plan.previous?.courseNotes.confusables }).batches.length;
  const fixed = plan.inventory.calls.length + work.examBatches.length + (planKit(work, plan)?.batches.length ?? 0) + pairs;
  const read = plan.inventory.calls.map(call => measure.body(callText(call))), each = units.map(unit => measure.body(unitText(unit)));
  const sum = (list, side, times = 1) => list.reduce((total, one) => total + one[side] * times, 0);
  return { points: items.length, chapters: plan.chapters?.length ?? null, sample: !!plan.sample && items.length >= SAMPLE_FROM,
    calls: { low: fixed + CHAIN_LOW * units.length, high: fixed + CHAIN_HIGH * units.length },
    readTokens: { low: sum(read, 'low') + sum(each, 'low', CHAIN_LOW), high: sum(read, 'high') + sum(each, 'high', CHAIN_HIGH) } };
}
