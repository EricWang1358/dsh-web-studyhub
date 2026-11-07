import { OUTLINE_LIMITS, clip, courseOutlineMaterial, settledParts } from '../../../../course-outline-book.js';
import { inputFingerprint } from '../../../../exam-point-list.js';
import { outlineLeaves } from '../../../../course-book-inputs.js';
import { partLeaves } from '../../../../course-book-parts.js';
import { makeAsk } from '../../blueprint/jobs/ask.js';
import { inventoryOutlineStage } from '../../outline/jobs/inventory-stages.js';
import { freshState } from '../../outline/jobs/outline-view.js';
import { chapterPages } from '../pick-pages.js';
import { mergeParts, partNodes, takenIds } from '../part-outline.js';
import { partPaperStage } from './part-paper-stage.js';

/* Stage 1 of a build BY CHAPTERS (custom plan S2, book/part-plan.js), in place of the outline build: the points of the chapters it adds are made from the inventory
   of their pages (the outline build's own cluster and order calls, outline/jobs/inventory-stages.js, over their items only) and they join the outline
   (book/part-outline.js); a chapter made again (`redo`: its pages changed) leaves first when it has unheld items of its own, while every other chapter stays as it
   is (its nodes, so no grouping call is asked again). Sample papers keep their marks on kept chapters when unchanged and match unplaced questions incrementally
   (jobs/part-paper-stage.js). Held for the book's one write, like a rebuilt outline. */

const allLeaves = nodes => outlineLeaves(nodes).map(({ node }) => node);

/** A place of an inventory item on the pages of a scope. */
const onPages = (scope, place) => scope.has(place.doc) && (scope.get(place.doc) === null || scope.get(place.doc).has(place.sourceId));

/** Sync top-level kept chapter node titles when a single non-lost chapter part was renamed in the material. */
function syncPartTitles(nodes, oldParts, settled) {
  const oldByNode = new Map();
  for (const part of oldParts || []) if (!part.lost) oldByNode.set(part.node, oldByNode.has(part.node) ? null : part);
  const nextByNode = new Map();
  for (const part of settled || []) if (!part.lost) nextByNode.set(part.node, nextByNode.has(part.node) ? null : part);
  return nodes.map(node => {
    const prev = oldByNode.get(node.id), next = nextByNode.get(node.id);
    if (!prev?.title || !next?.title || next.title === prev.title || node.title !== prev.title) return node;
    return { ...node, title: clip(next.title, OUTLINE_LIMITS.titleChars) || node.title };
  });
}

/** Prune anchors and items already claimed by `built` from a fallback redo node; null when no anchored leaf survives. */
function pruneRedoNode(rawNode, usedAnchors, usedItems) {
  const walk = node => {
    if (Array.isArray(node.children) && node.children.length) {
      const children = node.children.map(walk).filter(Boolean);
      return children.length ? { ...node, children } : null;
    }
    const anchors = (node.anchors || []).filter(anchor => !usedAnchors.has(anchor));
    if (!anchors.length) return null;
    const items = (node.items || []).filter(item => !usedItems.has(item));
    return { ...node, anchors, ...(items.length ? { items } : {}) };
  };
  return walk(structuredClone(rawNode));
}

/** The parts and the fingerprint of the record: each chapter as the materials hold it now (lib/course-outline-book.js settledParts). */
function partsRecord(merged, documents) {
  const parts = settledParts(merged, documents);
  return { parts, fingerprint: inputFingerprint(parts.map(entry => `${entry.node}=${entry.print}`)) };
}

/** -> { record (the outline this build writes on), held ({ record, replaces } | null when nothing was added), only (Set of leaf ids | null) } */
export async function partOutlineStage(ctx) {
  const { context, plan, state, show, boundary, kept: store, input } = ctx, part = plan.part, own = plan.outline?.courseOutline ?? null;
  const whole = ctx.inventory.courseInventory, rawAgain = new Set(part.redo);
  const settled = own ? settledParts(own.parts || [], plan.documents) : [];
  // Keep any redo chapter whose items all sit in kept chapters: dropping it would either leave its print stale or hand its 0-item pages to another chapter.
  const prelimKept = own ? own.nodes.filter(node => !rawAgain.has(node.id)) : [];
  const heldByKept = new Set(allLeaves(prelimKept).flatMap(node => node.items || []));
  const addById = new Map(part.adds.map(row => [row.id, row]));
  const activeAgain = new Set([...rawAgain].filter(nodeId => {
    const rows = settled.filter(entry => !entry.lost && entry.node === nodeId).map(entry => addById.get(entry.key)).filter(Boolean);
    if (!rows.length) return false;
    const nodeScope = chapterPages(rows);
    return whole.items.some(item => !heldByKept.has(item.id) && item.places.some(place => onPages(nodeScope, place)));
  }));
  const skippedKeys = new Set(settled.filter(entry => !entry.lost && rawAgain.has(entry.node) && !activeAgain.has(entry.node)).map(entry => entry.key));
  const activeAdds = part.adds.filter(row => !skippedKeys.has(row.id));
  const base = own
    ? { nodes: syncPartTitles(structuredClone(own.nodes.filter(node => !activeAgain.has(node.id))), own.parts, settled),
      parts: settled.filter(entry => !activeAgain.has(entry.node)), other: own.other.anchors }
    : { nodes: [], parts: [], other: [] };
  const keptLeaves = partLeaves(base.nodes, part.keep) ?? new Set();
  // The items of the added chapters' pages that no point of the outline holds yet.
  const held = new Set(allLeaves(base.nodes).flatMap(node => node.items || [])), scope = chapterPages(activeAdds);
  const items = new Set(whole.items.filter(item => !held.has(item.id) && item.places.some(place => onPages(scope, place))).map(item => item.id));
  if (!items.size && base.nodes.length) {
    // Nothing to group: settle when a chapter was lost, became untaught, or changed with all its items already held in other chapters.
    if (!part.settle && !part.redo.length) return { record: plan.outline, held: null, only: part.picked ? keptLeaves : null };
    const syncedNodes = syncPartTitles(structuredClone(own.nodes), own.parts, settled);
    const record = courseOutlineMaterial({ ...own, title: plan.outline.title, nodes: syncedNodes, inventoryPrint: whole.fingerprint,
      ...partsRecord(settled, plan.documents), supersedes: plan.outline.id });
    const settleOnly = part.picked ? (partLeaves(record.courseOutline.nodes, [...new Set([...part.keep, ...part.redo])]) ?? keptLeaves) : null;
    return { record, held: { record, replaces: plan.outline.id }, only: settleOnly };
  }
  const sub = freshState(plan.outlinePlan);
  state.outline = sub; state.stage = 'outline'; show();
  const inner = { context, input: { language: input.language }, plan: { ...plan.outlinePlan, pick: { items, pages: scope } }, state: sub, show, boundary, kept: store,
    parallel: ctx.parallel, inventory: ctx.inventory, inventoryRanges: plan.inventory.ranges,
    ask: makeAsk(context, store, sub, { feature: 'book' }), env: { saveInventory: ctx.env.saveInventory } };
  const made = await inventoryOutlineStage(inner);
  ctx.inventory = inner.inventory;
  const built = partNodes(made.nodes, activeAdds, ctx.inventory.courseInventory, takenIds(base.nodes));
  const builtKeys = new Set(built.flatMap(entry => entry.parts.map(p => p.key)));
  const usedAnchors = new Set([...allLeaves(base.nodes), ...built.flatMap(entry => allLeaves([entry.node]))].flatMap(node => node.anchors || []));
  const usedItems = new Set([...allLeaves(base.nodes), ...built.flatMap(entry => allLeaves([entry.node]))].flatMap(node => node.items || []));
  for (const row of activeAdds) {
    if (builtKeys.has(row.id)) continue;
    const prevPart = settled.find(entry => !entry.lost && entry.key === row.id);
    const oldNode = prevPart && own ? own.nodes.find(node => node.id === prevPart.node) : null;
    const pruned = oldNode && !base.nodes.some(node => node.id === oldNode.id) ? pruneRedoNode(oldNode, usedAnchors, usedItems) : null;
    if (pruned) {
      base.nodes.push(pruned);
      base.parts.push({ ...prevPart, key: row.id, doc: row.doc, node: pruned.id });
      for (const leaf of allLeaves([pruned])) {
        for (const anchor of leaf.anchors || []) usedAnchors.add(anchor);
        for (const item of leaf.items || []) usedItems.add(item);
      }
    } else if (built.length) {
      const target = built.find(entry => entry.parts[0]?.doc === row.doc) ?? built[0];
      target.parts.push({ key: row.id, doc: row.doc });
      target.keys.push(row.id);
    }
    builtKeys.add(row.id);
  }
  const merged = mergeParts(base, built, part.order);
  await partPaperStage(inner, { baseNodes: base.nodes, builtNodes: built.map(entry => entry.node), merged, previousPapers: own?.papers ?? [] });
  ctx.inventory = inner.inventory;
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
  const skippedLeaves = partLeaves(base.nodes, [...rawAgain].filter(id => !activeAgain.has(id))) ?? new Set();
  const added = new Set([...built.flatMap(entry => allLeaves([entry.node]).map(node => node.id)), ...skippedLeaves]);
  return { record, held: { record, replaces: plan.outline?.id ?? null }, only: part.picked ? new Set([...added, ...keptLeaves]) : null };
}
