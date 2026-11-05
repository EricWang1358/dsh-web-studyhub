import { TEXT_CONCURRENCY, clampCount } from '../../../../audio-pool.js';
import { outlineLeaves } from '../../../../course-book-inputs.js';
import { scaleEstimate } from '../estimate.js';
import { expectedConfusableCalls } from '../confusables/plan.js';
import { planKit } from '../kit/plan.js';
import { candidateOf, pickSample, sampleRecord } from '../sample.js';
import { bookWork } from '../work.js';

/* The sample (#710) inside a review book build: once the points to write are known, a build that makes a sample writes only its two points (the whole way:
   write, review, repair, exam notes) and keeps every other point as it is; it saves them in the book with the scale of the rest and ends, waiting for the learner.
   The next build ('confirm') finds them kept by their fingerprint and writes the rest like them (book/sample.js). */

const SAMPLE_SIZE = 2;

/** The points this build would write (and the sample's own points while they are kept: made again at the same settings, they are the sample again). */
const writingOf = (work, previous) => work.items.filter(item => item.mode !== 'keep' || previous?.leaves?.includes(item.id));

/**
 * After the plan of the points: `planned` ({ work, outline, held }) with the work narrowed to the sample's two points and what the rest will be
 * (`sample`: { pick, total, rest: { points, tested, inventory, kit } }), or `planned` as it is when the build makes no sample or has too few points to write.
 */
export function sampleWork(ctx, planned, args) {
  const { plan, state } = ctx;
  if (!plan.sample) return planned;
  const previous = plan.previous?.courseNotes.sample ?? null, writing = writingOf(planned.work, previous);
  const nodes = new Map(outlineLeaves(planned.outline.courseOutline.nodes).map(({ node }) => [node.id, node]));
  const pick = plan.sample.pick ?? pickSample(writing.map(item => candidateOf(nodes.get(item.id) ?? { id: item.id })), previous);
  if (!pick) return planned;
  const ids = new Set([pick.typical, pick.heavy]), rest = writing.filter(item => !ids.has(item.id));
  state.sample = { points: SAMPLE_SIZE, rest: rest.length, total: writing.length, ready: false };
  const work = bookWork({ ...args, outline: planned.outline, only: ids });
  // The answer kit is the whole papers', not a point's: the sample makes none (its calls are in the scale of the rest) and keeps the one the book had, so
  // the rest's build asks only the types that changed.
  const savedKit = plan.previous?.courseNotes.examKit;
  if (savedKit) work.examKit = savedKit;
  const savedPairs = plan.previous?.courseNotes.confusables;
  if (savedPairs) work.confusables = savedPairs;
  const kit = planKit(work, plan)?.batches.length ?? 0;
  return { ...planned, work, sample: { pick, total: writing.length,
    rest: { points: rest.length, tested: rest.filter(item => item.needsExam).length, inventory: plan.sample.inventoryLeft, kit } } };
}

/**
 * The sample the book saves: waiting, its words and band, and the scale of the rest from this Job's own calls (`env.calls()`, what the task console shows). A
 * sample made again from its kept points asks nothing, so it keeps the scale it had.
 */
export function sampleToSave(ctx, work, sample) {
  const { plan, env } = ctx, previous = plan.previous?.courseNotes.sample ?? null;
  const rest = { ...sample.rest, confusables: expectedConfusableCalls(work.items, sample.rest.points) };
  const measured = scaleEstimate({ calls: env.calls?.() ?? [], rest, total: sample.total, sample: SAMPLE_SIZE,
    concurrency: clampCount(plan.concurrency, TEXT_CONCURRENCY) });
  const same = previous?.leaves?.[0] === sample.pick.typical && previous?.leaves?.[1] === sample.pick.heavy && previous.level === plan.coverage;
  return sampleRecord({ pick: sample.pick, items: work.items, level: plan.coverage, language: plan.language, estimate: measured ?? (same ? previous.estimate : null) });
}

/** The sample a build that makes none leaves in the book: approved by this build ('confirm'), else the one the book had. */
export const sampleKept = plan => {
  const own = plan.previous?.courseNotes.sample ?? null;
  return own && plan.confirm ? { ...own, status: 'confirmed' } : own;
};
