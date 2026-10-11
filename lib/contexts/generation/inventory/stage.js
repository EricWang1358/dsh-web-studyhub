import { inventoryMaterial, sameInventory } from '../../../course-book-inventory.js';
import { mergeItems } from './merge.js';
import { inventoryNotice, inventoryTitle } from './messages.js';
import { policyOf } from './policy.js';
import { inventoryPrompt } from './prompt.js';
import { readInventory, settleRange } from './read.js';

/* The inventory stage, shared by the outline build and the review book build (each runs it first): the calls of the plan in parallel (inventory/parallel.js), every range
   settled (its anchors checked word for word), the items merged, and the record written at once through the Job's `env.saveInventory(record, replaces)`
   when it changed, so what was read is kept even if a later stage fails. A call that failed leaves its ranges `failed` (not read: the next build asks them). */

/** The documents' figures: ranges read, pages read (a paged material counts its pages, any other material is one). */
function documentsOf(docs, ranges, read) {
  return docs.map(doc => {
    const own = ranges.filter(range => range.doc === doc.key), done = own.filter(range => read.has(range.key));
    const pages = doc.paged ? new Set(done.flatMap(range => range.pieces.map(piece => piece.sourceId))).size : done.length === own.length && own.length ? 1 : 0;
    return { key: doc.key, title: doc.title, pages: doc.pages, ranges: own.length, read: done.length, pagesRead: pages, ...(doc.reason ? { reason: doc.reason } : {}) };
  });
}

/** The inventory as a record (not written): `found` maps a print to its items as the model listed them. `cache` the 总纲's grouping answers to keep. */
export function inventoryRecord(plan, inv, found, cache) {
  const settled = [], ranges = [], read = new Set();
  for (const range of inv.ranges) {
    const raws = found.get(range.print);
    if (raws) read.add(range.key);
    ranges.push({ key: range.key, doc: range.doc, print: range.print, status: raws ? 'read' : 'failed', chars: range.chars,
      ...(Number.isInteger(range.from) ? { from: range.from, to: range.to } : {}) });
    settled.push(raws ? settleRange(range, raws) : []);
  }
  const items = mergeItems(settled), documents = documentsOf(inv.documents, inv.ranges, read);
  return inventoryMaterial({ title: inventoryTitle(plan.language, plan.course), notice: inventoryNotice(plan.language, items.length, documents.filter(doc => doc.read).length),
    course: plan.course, language: plan.language, ranges, items, documents, cache: cache ?? inv.previous?.courseInventory.cache ?? null });
}

/** The calls between two writes of what was read so far: a stop or a failure later keeps all but the last few. */
export const SAVE_EVERY = 10;

/** Writes the record when it is not the saved one; returns the record the course now has. `force`: also while the Job is being stopped (what was read is kept). */
export async function keepInventory(ctx, record, previous, { force = false } = {}) {
  if (previous && sameInventory(record.courseInventory, previous.courseInventory)) return previous;
  if (!force) ctx.context.signal.throwIfAborted();
  await ctx.env.saveInventory(record, previous?.id ?? null);
  return record;
}

/** Stage 1: -> { record (as saved), found (print -> items) }. What was read is written every SAVE_EVERY calls and when the stage is stopped or paused. */
export async function inventoryStage(ctx, parallel) {
  const { plan, state, show } = ctx, inv = plan.inventory, found = new Map(inv.reused);
  state.inventory = { done: 0, total: inv.calls.length, failed: 0, reused: inv.ranges.filter(range => inv.reused.has(range.print)).length };
  state.stage = 'inventory'; show();
  const policy = policyOf('inventory', plan.efforts);
  let saved = inv.previous, writing = Promise.resolve(), since = 0;
  const save = force => { writing = writing.then(async () => { saved = await keepInventory(ctx, inventoryRecord(plan, inv, found), saved, { force }); }); return writing; };
  try {
    await parallel.each(inv.calls, async call => {
      const labels = { stage: 'inventory', part: call.number, parts: inv.calls.length, file: call.ranges[0].material.slice(0, 120) };
      const answer = await parallel.ask(call.key, labels, policy, inventoryPrompt(call, plan), text => readInventory(text, call));
      if (answer) call.ranges.forEach((range, at) => found.set(range.print, answer.found.get(at) ?? []));
      else state.inventory.failed++;
      state.inventory.done++; show();
      if (++since >= SAVE_EVERY) { since = 0; await save(false); }
    }, 'inventory');
  } catch (error) {
    // Stopped, paused or failed: what was read so far is kept for the next build (the ranges not read yet stay unread).
    await save(true).catch(() => {});
    throw error;
  }
  await writing;
  const record = await keepInventory(ctx, inventoryRecord(plan, inv, found), saved);
  state.inventory.items = record.courseInventory.items.length; show();
  return { record, found };
}
