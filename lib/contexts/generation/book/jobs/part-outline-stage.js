import { courseOutlineMaterial, settledParts } from '../../../../course-outline-book.js';
import { inputFingerprint } from '../../../../exam-point-list.js';
import { outlineLeaves } from '../../../../course-book-inputs.js';
import { partLeaves } from '../../../../course-book-parts.js';
import { makeAsk } from '../../blueprint/jobs/ask.js';
import { inventoryOutlineStage } from '../../outline/jobs/inventory-stages.js';
import { paperStage } from '../../outline/jobs/stages.js';
import { freshState } from '../../outline/jobs/outline-view.js';
import { chapterPages } from '../pick-pages.js';
import { mergeParts, partNodes, takenIds } from '../part-outline.js';

/* Stage 1 of a build BY CHAPTERS (custom plan S2, book/part-plan.js), in place of the outline build: the points of the chapters it adds are made from the inventory
   of their pages (the outline build's own cluster and order calls, outline/jobs/inventory-stages.js, over their items only) and they join the outline
   (book/part-outline.js); a chapter made again (`redo`: its pages changed) leaves first, every other chapter stays exactly as it is (its nodes, so no grouping
   call is asked again). The sample papers are then placed over EVERY point of the outline: a question about a kept chapter belongs there, not on the nearest new
   point. Held for the book's one write, like a rebuilt outline. The points a pick writes (`only`): the added chapters' and the kept chapters it names; a build of
   the whole book writes every point (one already written keeps its body by its fingerprint: book/work.js). */

const allLeaves = nodes => outlineLeaves(nodes).map(({ node }) => node);

/** A place of an inventory item on the pages of a scope. */
const onPages = (scope, place) => scope.has(place.doc) && (scope.get(place.doc) === null || scope.get(place.doc).has(place.sourceId));

/** The parts and the fingerprint of the record: each chapter as the materials hold it now (lib/course-outline-book.js settledParts). */
function partsRecord(merged, documents) {
  const parts = settledParts(merged, documents);
  return { parts, fingerprint: inputFingerprint(parts.map(entry => `${entry.node}=${entry.print}`)) };
}

/** -> { record (the outline this build writes on), held ({ record, replaces } | null when nothing was added), only (Set of leaf ids | null) } */
export async function partOutlineStage(ctx) {
  const { context, plan, state, show, boundary, kept: store, input } = ctx, part = plan.part, own = plan.outline?.courseOutline ?? null;
  // The parts as the materials hold them now (a chapter numbered anew keeps its node; a lost one is kept, said lost), without the chapters made again.
  const again = new Set(part.redo), parts = own ? settledParts(own.parts || [], plan.documents) : [];
  const base = own ? { nodes: structuredClone(own.nodes.filter(node => !again.has(node.id))), parts: parts.filter(entry => !again.has(entry.node)), other: own.other.anchors }
    : { nodes: [], parts: [], other: [] };
  const keptLeaves = partLeaves(base.nodes, part.keep) ?? new Set();
  // The items of the added chapters' pages that no point of the outline holds yet.
  const held = new Set(allLeaves(base.nodes).flatMap(node => node.items || [])), scope = chapterPages(part.adds), whole = ctx.inventory.courseInventory;
  const items = new Set(whole.items.filter(item => !held.has(item.id) && item.places.some(place => onPages(scope, place))).map(item => item.id));
  if (!items.size && base.nodes.length) {
    // Nothing to group: the outline as it is; a chapter the materials lost is recorded lost (the page says so; it is no longer out of date), no call.
    if (!part.settle) return { record: plan.outline, held: null, only: part.picked ? keptLeaves : null };
    const record = courseOutlineMaterial({ ...own, title: plan.outline.title, ...partsRecord(own.parts, plan.documents), supersedes: plan.outline.id });
    return { record, held: { record, replaces: plan.outline.id }, only: part.picked ? keptLeaves : null };
  }
  const sub = freshState(plan.outlinePlan);
  state.outline = sub; state.stage = 'outline'; show();
  const inner = { context, input: { language: input.language }, plan: { ...plan.outlinePlan, pick: { items, pages: scope } }, state: sub, show, boundary, kept: store,
    parallel: ctx.parallel, inventory: ctx.inventory, inventoryRanges: plan.inventory.ranges, ask: makeAsk(context, store, sub), env: { saveInventory: ctx.env.saveInventory } };
  const made = await inventoryOutlineStage(inner);
  ctx.inventory = inner.inventory;
  const built = partNodes(made.nodes, part.adds, ctx.inventory.courseInventory, takenIds(base.nodes)), merged = mergeParts(base, built, part.order);
  // The papers over every point: the marks are made again from the whole outline (the same outline and papers ask the same calls).
  for (const { node } of outlineLeaves(merged.nodes)) delete node.exam;
  await paperStage(inner, merged);
  state.reused += sub.reused;
  const used = new Set(allLeaves(merged.nodes).flatMap(node => node.anchors || [])), outline = plan.outlinePlan;
  const record = courseOutlineMaterial({ title: outline.title, course: plan.course, language: plan.language, orderBasis: own ? own.orderBasis : made.orderBasis,
    nodes: merged.nodes, other: { anchors: [...new Set([...base.other, ...made.other.anchors])].filter(anchor => !used.has(anchor)) },
    ...(outline.papers.length ? { papers: outline.papers } : {}), ...(outline.papersBy ? { papersBy: outline.papersBy } : {}), from: 'inventory',
    ...(Object.keys(outline.shape || {}).length ? { shape: outline.shape } : {}), inventoryPrint: ctx.inventory.courseInventory.fingerprint,
    // Each chapter with its print (outlineStale compares them one by one); the record's fingerprint is theirs together.
    ...partsRecord(merged.parts, plan.documents),
    counts: { ...made.counts, invalid: sub.invalid + made.counts.invalid, items: ctx.inventory.courseInventory.items.length },
    ...(plan.outline ? { supersedes: plan.outline.id } : {}) });
  const added = new Set(built.flatMap(entry => allLeaves([entry.node]).map(node => node.id)));
  return { record, held: { record, replaces: plan.outline?.id ?? null }, only: part.picked ? new Set([...added, ...keptLeaves]) : null };
}
