import { inventoryMaterial } from '../../../../course-book-inventory.js';
import { keepInventory } from '../../inventory/stage.js';
import { policyOf } from '../../inventory/policy.js';
import { clusterBatches, clusterPrompt, readCluster } from '../cluster.js';
import { clustersOf, inventoryOutline } from '../inventory-tree.js';
import { orderKey, orderPoints, orderPrompt } from '../order.js';
import { readReduce } from '../read.js';
import { FAILURES, UNPLACED_WORDS } from './messages.js';

/* The outline built from the inventory (the inventory the build read first): the cluster calls in parallel (a batch of items each), ONE order call, and the program's
   assembly (outline/inventory-tree.js). A batch or the order answered before (the inventory's cache: same items, same syllabus) asks nothing; a cluster call
   that fails leaves its items to Other / unplaced; an order that fails keeps the points in the order of their materials, one chapter per material. */

const coded = (code, message) => Object.assign(new Error(message), { code });

/** The order the model did not give: one chapter per first material, its points in order. */
function materialOrder(clusters) {
  const chapters = new Map();
  for (const cluster of clusters) {
    const title = cluster.materials[0] || cluster.title;
    if (!chapters.has(title)) chapters.set(title, { title, intro: '', leaves: [], sections: [] });
    chapters.get(title).leaves.push({ ids: [cluster.id] });
  }
  return { basis: [], chapters: [...chapters.values()] };
}

/** The inventory record with the grouping answers of this build in its cache (only those still used: an unused one is dropped). */
const withCache = (record, cache) => inventoryMaterial({ title: record.title, notice: record.text, ...record.courseInventory, cache });

/** Cluster and order -> the outline (nodes, other, counts, orderBasis, from: 'inventory', inventoryPrint). */
export async function inventoryOutlineStage(ctx) {
  const { plan, state, show, parallel, input } = ctx, record = ctx.inventory, inventory = record.courseInventory;
  const cached = new Map((inventory.cache?.clusters || []).map(entry => [entry.key, entry.answer]));
  const batches = clusterBatches(inventory, plan.language), policy = policyOf('outline', plan.efforts);
  Object.assign(state, { cluster: { done: 0, total: batches.length }, order: { done: 0, total: 1 }, map: { done: 0, total: 0 }, reduce: { done: 0, total: 0 }, stage: 'cluster' });
  show();
  const answers = await parallel.each(batches, async batch => {
    const own = cached.get(batch.key) ?? await parallel.ask(batch.key, { stage: 'cluster', part: batch.number, parts: batches.length, file: batch.items[0].material.slice(0, 120) },
      policy, clusterPrompt(batch, plan), text => readCluster(text, batch));
    if (cached.has(batch.key)) state.reused++;
    state.cluster.done++; show();
    return own;
  }, 'cluster');
  const grouped = clustersOf(batches, answers, inventory);
  if (!grouped.clusters.length && !grouped.loose.length) throw coded('course-outline-empty', FAILURES.empty(input.language));
  ctx.boundary('order');
  state.stage = 'order'; show();
  const points = orderPoints(grouped.clusters), key = orderKey(points, plan);
  const cachedOrder = inventory.cache?.order?.key === key ? inventory.cache.order.answer : null;
  const order = !grouped.clusters.length ? null : cachedOrder ?? await parallel.ask(key, { stage: 'order' }, policy, orderPrompt(points, plan), readReduce);
  if (cachedOrder) state.reused++;
  state.order.done++; show();
  const ranges = ctx.inventoryRanges || plan.inventory?.ranges || [];
  const outline = inventoryOutline(plan, inventory, grouped, order ?? materialOrder(grouped.clusters), ranges, UNPLACED_WORDS(plan.language));
  if (!outline.nodes.length) throw coded('course-outline-empty', FAILURES.empty(input.language));
  // The answers are kept in the inventory's cache, so an unchanged course asks none of them again.
  const cache = { clusters: batches.map((batch, at) => (answers[at] ? { key: batch.key, answer: answers[at] } : null)).filter(Boolean),
    order: order ? { key, answer: order } : null };
  ctx.inventory = await keepInventory(ctx, withCache(record, cache), record);
  return { ...outline, from: 'inventory', inventoryPrint: inventory.fingerprint };
}
