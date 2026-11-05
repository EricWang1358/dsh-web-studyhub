import { inventoryMaterial } from '../../../../course-book-inventory.js';
import { keepInventory } from '../../inventory/stage.js';
import { policyOf } from '../../inventory/policy.js';
import { clusterBatches, clusterPrompt, readCluster } from '../cluster.js';
import { clustersOf, inventoryOutline } from '../inventory-tree.js';
import { expandOrder, orderKey, orderPoints, orderPrompt } from '../order.js';
import { readReduce } from '../read.js';
import { FAILURES, UNPLACED_WORDS } from './messages.js';

/* The outline built from the inventory (the inventory the build read first): the cluster calls in parallel (a batch of items each), ONE order call, and the program's
   assembly (outline/inventory-tree.js). A batch or the order answered before (the inventory's cache: same items, same syllabus) asks nothing; a cluster call
   that fails leaves its items to Other / unplaced; an order that fails keeps the points in the order of their materials, one chapter per material. */

const coded = (code, message) => Object.assign(new Error(message), { code });

/** Chapters of the fallback order before they become sections of bigger chapters (the outline is then fitted to the record's size, outline/fit.js). */
const MATERIAL_CHAPTERS = 40;
/** The order the model did not give: one chapter per first material, its points in order; with many materials, consecutive ones as sections of a chapter. */
export function materialOrder(clusters) {
  const byMaterial = new Map();
  for (const cluster of clusters) {
    const title = cluster.materials[0] || cluster.title;
    if (!byMaterial.has(title)) byMaterial.set(title, { title, intro: '', leaves: [], sections: [] });
    byMaterial.get(title).leaves.push({ ids: [cluster.id] });
  }
  const list = [...byMaterial.values()];
  if (list.length <= MATERIAL_CHAPTERS) return { basis: [], chapters: list };
  const size = Math.ceil(list.length / MATERIAL_CHAPTERS), chapters = [];
  for (let at = 0; at < list.length; at += size) {
    const part = list.slice(at, at + size);
    chapters.push({ title: part[0].title, intro: '', leaves: [], sections: part.map(({ title, intro, leaves }) => ({ title, intro, leaves })) });
  }
  return { basis: [], chapters };
}

/** The inventory record with the grouping answers of this build in its cache (only those still used: an unused one is dropped). */
const withCache = (record, cache) => inventoryMaterial({ title: record.title, notice: record.text, ...record.courseInventory, cache });

/** The grouping answers kept: this build's; a build by chapters (`plan.pick`) also keeps the ones of the chapters built before (still used, when the outline
    is made again). */
function cacheOf(plan, inventory, batches, answers, order, key) {
  const clusters = batches.map((batch, at) => (answers[at] ? { key: batch.key, answer: answers[at] } : null)).filter(Boolean), own = new Set(clusters.map(entry => entry.key));
  const earlier = plan.pick ? (inventory.cache?.clusters || []).filter(entry => !own.has(entry.key)) : [];
  return { clusters: [...clusters, ...earlier], order: order ? { key, answer: order } : plan.pick ? inventory.cache?.order ?? null : null };
}

/** Cluster and order -> the outline (nodes, other, counts, orderBasis, from: 'inventory', inventoryPrint). A build by chapters (custom plan S2, `plan.pick`:
    { items: Set of item ids, pages: book/pick-pages.js scope }) groups only the items of the chapters it adds and anchors them on their pages only. */
export async function inventoryOutlineStage(ctx) {
  const { plan, state, show, parallel, input } = ctx, record = ctx.inventory, whole = record.courseInventory;
  const inventory = plan.pick ? { ...whole, items: whole.items.filter(item => plan.pick.items.has(item.id)) } : whole;
  const cached = new Map((inventory.cache?.clusters || []).map(entry => [entry.key, entry.answer]));
  const batches = clusterBatches(inventory, plan.language, plan.granularity), policy = policyOf('outline', plan.efforts);
  Object.assign(state, { cluster: { done: 0, total: batches.length }, order: { done: 0, total: 1 }, map: { done: 0, total: 0 }, reduce: { done: 0, total: 0 }, stage: 'cluster' });
  show();
  const answers = await parallel.each(batches, async batch => {
    const own = cached.get(batch.key) ?? await parallel.ask(batch.key, { stage: 'cluster', part: batch.number, parts: batches.length, file: batch.items[0].material.slice(0, 120) },
      policy, clusterPrompt(batch, plan), text => readCluster(text, batch));
    if (cached.has(batch.key)) state.reused++; else if (!own) state.clusterFailed = (state.clusterFailed ?? 0) + 1;
    state.cluster.done++; show();
    return own;
  }, 'cluster');
  const grouped = clustersOf(batches, answers, inventory);
  if (!grouped.clusters.length && !grouped.loose.length) throw coded('course-outline-empty', FAILURES.empty(input.language));
  ctx.boundary('order');
  state.stage = 'order'; show();
  const { points, members } = orderPoints(grouped.clusters), key = orderKey(points, plan);
  const cachedOrder = inventory.cache?.order?.key === key ? inventory.cache.order.answer : null;
  const order = !grouped.clusters.length ? null : cachedOrder ?? await parallel.ask(key, { stage: 'order' }, policy, orderPrompt(points, plan), readReduce);
  if (cachedOrder) state.reused++;
  state.order.done++; show();
  const ranges = ctx.inventoryRanges || plan.inventory?.ranges || [];
  const outline = inventoryOutline(plan, inventory, grouped, order ? expandOrder(order, members) : materialOrder(grouped.clusters), ranges, UNPLACED_WORDS(plan.language));
  if (!outline.nodes.length) throw coded('course-outline-empty', FAILURES.empty(input.language));
  // The answers are kept in the inventory's cache, so an unchanged course asks none of them again.
  const cache = cacheOf(plan, whole, batches, answers, order, key);
  ctx.inventory = await keepInventory(ctx, withCache(record, cache), record);
  return { ...outline, from: 'inventory', inventoryPrint: whole.fingerprint };
}
