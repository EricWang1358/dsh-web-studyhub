import { createTextMeasure } from '../../../token-estimate.js';
import { REPAIR_ROUNDS, SAMPLE_FROM } from './constants.js';
import { planConfusables } from './confusables/plan.js';
import { planKit } from './kit/plan.js';
import { bookSteps } from './plan-parts.js';
import { CHARS_PER_ITEM, pointsOfChars } from '../outline/estimate.js';
import { CLUSTER_ITEMS } from '../outline/constants.js';

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
const sum = (list, side, times = 1) => list.reduce((total, one) => total + one[side] * times, 0);

/**
 * @param plan the build's plan (book/plan.js planBook); `work` its points as bookWork plans them on the outline as it is.
 * @returns { points, chapters (picked, or null for the whole book), sample (it starts with a sample of two), calls: { low, high }, readTokens: { low, high } }
 */
export function bookScale(plan, work) {
  const measure = createTextMeasure(), steps = bookSteps(plan.parts), items = steps.write ? work.items.filter(item => item.mode !== 'keep') : [];
  const units = items.flatMap(item => item.units);
  const pairs = steps.confusables ? planConfusables(work.items, { language: plan.language, previous: plan.previous?.courseNotes.confusables }).batches.length : 0;
  const fixed = plan.inventory.calls.length + (steps.exam ? work.examBatches.length : 0) + (steps.kit ? planKit(work, plan)?.batches.length ?? 0 : 0) + pairs;
  const read = plan.inventory.calls.map(call => measure.body(callText(call))), each = units.map(unit => measure.body(unitText(unit)));
  return { points: items.length, chapters: plan.chapters?.length ?? null, sample: !!plan.sample && items.length >= SAMPLE_FROM, inventory: plan.inventory.calls.length,
    calls: { low: fixed + CHAIN_LOW * units.length, high: fixed + CHAIN_HIGH * units.length },
    readTokens: { low: sum(read, 'low') + sum(each, 'low', CHAIN_LOW), high: sum(read, 'high') + sum(each, 'high', CHAIN_HIGH) } };
}

/**
 * The scale of a build BY CHAPTERS that adds chapters (custom plan S2, mode 'part') before it starts: their points are not known until their outline is made, so they
 * are counted from the chapters' characters (outline/estimate.js pointsOfChars, `rough`); the inventory of their pages exactly (the calls the plan makes), and the
 * grouping (a cluster call per CLUSTER_ITEMS items, one order call). A point is a write and a review at the low end, every repair at the high end.
 */
export function partScale(plan) {
  const measure = createTextMeasure(), steps = bookSteps(plan.parts), byId = new Map((plan.state.sources || []).map(source => [source.id, source]));
  const docs = new Map(plan.documents.map(doc => [doc.key, doc])), adds = plan.part.adds;
  const chars = adds.reduce((total, row) => total + (row.chars || 0), 0), points = steps.write ? adds.reduce((total, row) => total + pointsOfChars(row.chars || 0), 0) : 0;
  const text = adds.flatMap(row => row.sourceIds ?? docs.get(row.doc)?.sourceIds ?? []).map(id => byId.get(id)?.text ?? '').join('\n');
  const outline = Math.ceil(chars / CHARS_PER_ITEM / CLUSTER_ITEMS) + 1, fixed = plan.inventory.calls.length + outline, own = measure.body(text);
  const read = plan.inventory.calls.map(call => measure.body(callText(call)));
  return { points, chapters: plan.chapters?.length ?? adds.length, sample: !!plan.sample && points >= SAMPLE_FROM, inventory: plan.inventory.calls.length, rough: true,
    calls: { low: fixed + CHAIN_LOW * points, high: fixed + CHAIN_HIGH * points },
    readTokens: { low: sum(read, 'low') + (points ? own.low * CHAIN_LOW : 0), high: sum(read, 'high') + (points ? own.high * CHAIN_HIGH : 0) } };
}
