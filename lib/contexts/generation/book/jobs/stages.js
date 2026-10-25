import { courseNotesMaterial, sameNotes } from '../../../../course-book.js';
import { inventoryCoverage } from '../../../../course-book-inventory.js';
import { courseOutlineMaterial } from '../../../../course-outline-book.js';
import { makeAsk } from '../../blueprint/jobs/ask.js';
import { policyOf } from '../../inventory/policy.js';
import { organiseOutline } from '../../outline/jobs/course-outline-build.js';
import { UNPLACED_WORDS } from '../../outline/jobs/messages.js';
import { freshState } from '../../outline/jobs/outline-view.js';
import { buildGlossary } from '../glossary.js';
import { extendNodes } from '../extend.js';
import { examPrompt, placePrompt } from '../prompts.js';
import { readExam, readPlace } from '../read.js';
import { bookWork } from '../work.js';
import { FAILURES } from './messages.js';

/* The stages of one review book attempt around the writing (jobs/leaf-stage.js): the outline when it is needed (the outline build's own stages, built from
   the inventory), the plan of the points (checklists; items no point holds placed by one call, else in the unplaced point), the exam notes in parallel, and
   ONE write of the notes (and the outline it made or extended). The inventory was written as soon as it was read. */

const coded = (code, message, cause) => Object.assign(new Error(message, cause ? { cause } : undefined), { code });

/** Stage 1 (only when the outline is missing, out of date, not built from the inventory, or its papers changed): the outline build's stages; held for the last write. */
export async function outlineStage(ctx) {
  const { context, plan, state, show, boundary, kept: store, input } = ctx;
  if (!plan.outlinePlan) return { record: plan.outline, held: null };
  let held = null;
  const sub = freshState(plan.outlinePlan);
  state.outline = sub; state.stage = 'outline'; show();
  const inner = { context, input: { language: input.language }, plan: plan.outlinePlan, state: sub, show, boundary, kept: store, parallel: ctx.parallel, inventory: ctx.inventory,
    inventoryRanges: plan.inventory.ranges, ask: makeAsk(context, store, sub),
    env: { ingest: async (record, replaces) => { held = { record, replaces }; }, saveInventory: ctx.env.saveInventory } };
  await organiseOutline(inner);
  ctx.inventory = inner.inventory;
  state.reused += sub.reused;
  return { record: held.record, held };
}

/** Stage 2: the work of the points. Items no point holds are placed by ONE call; what it cannot place goes to the unplaced point; the outline is extended. */
export async function planStage(ctx, outline, held) {
  const { plan, state, show, parallel } = ctx, inventory = ctx.inventory?.courseInventory ?? null;
  const args = { state: plan.state, documents: plan.documents, previous: plan.previous, language: plan.language, level: plan.coverage, point: plan.point, inventory,
    ranges: plan.inventory.ranges };
  let work = bookWork({ ...args, outline });
  if (work.unplaced.length) {
    state.stage = 'place'; show();
    const byId = new Map(inventory.items.map(item => [item.id, item])), items = work.unplaced.map(id => byId.get(id)), leaves = work.items;
    const answer = await parallel.ask(`cb:place:${outline.id.slice(-12)}:${work.unplaced.length}:${work.unplaced.slice(0, 8).join('')}`, { stage: 'place' },
      policyOf('plan', plan.efforts), placePrompt(items, leaves, plan), text => readPlace(text, items, leaves));
    const placed = new Map([...(answer?.places || [])].map(([item, leaf]) => [items[item].id, leaves[leaf].id]));
    work = bookWork({ ...args, outline, placed });
  }
  if (!work.unplaced.length && !work.extend.length) return { work, outline, held };
  // The outline is extended: the points that now hold more items, and what no point holds in the unplaced point. It is written with the notes.
  const nodes = extendNodes(outline.courseOutline.nodes, work.extend, work.unplaced, UNPLACED_WORDS(plan.language));
  const replaces = held?.replaces ?? outline.id, record = extendedOutline(outline, nodes, replaces);
  return { work: bookWork({ ...args, outline: record }), outline: record, held: { record, replaces } };
}

/** The outline record a book build writes when it extends the outline: the same outline (its papers, origin, cut `shape`, counts) with the new nodes. */
export function extendedOutline(outline, nodes, replaces) {
  const own = outline.courseOutline;
  return courseOutlineMaterial({ title: outline.title, course: own.course, language: own.language, orderBasis: own.orderBasis, nodes, other: own.other,
    ...(own.papers ? { papers: own.papers } : {}), ...(own.papersBy ? { papersBy: own.papersBy } : {}), ...(own.from ? { from: own.from } : {}),
    ...(own.shape ? { shape: own.shape } : {}), ...(own.inventoryPrint ? { inventoryPrint: own.inventoryPrint } : {}), fingerprint: own.fingerprint, counts: own.counts,
    ...(replaces ? { supersedes: replaces } : {}) });
}

/** Stage 4 (only with sample papers): exam notes of the leaves whose paper places changed, a call per batch, in parallel. */
export async function examStage(ctx, work) {
  const { plan, state, show, parallel } = ctx, policy = policyOf('exam', plan.efforts);
  state.exam.total = work.examBatches.length;
  if (work.examBatches.length) { state.stage = 'exam'; show(); }
  await parallel.each(work.examBatches, async batch => {
    const answer = await parallel.ask(batch.key, { stage: 'exam', part: batch.number, parts: work.examBatches.length }, policy, examPrompt(batch, plan),
      text => readExam(text, batch));
    if (answer) batch.items.forEach((item, at) => {
      const note = answer.notes.get(at);
      item.exam = { fingerprint: item.examFingerprint, tested: true, ...(note ? { note } : {}), ...(item.examReplaces ? { replaces: item.examReplaces } : {}) };
      state.examWritten++;
    });
    else state.missed++;
    state.exam.done++; show();
  }, 'exam');
}

/** The book's coverage at three levels: materials and pages (the inventory), knowledge points complete, must items covered. */
function coverageOf(inventory, items) {
  const read = inventoryCoverage(inventory), bodies = items.filter(item => item.body && !item.body.empty && item.body.coverage);
  const must = bodies.reduce((sum, item) => sum + item.body.coverage.must, 0), missing = bodies.reduce((sum, item) => sum + item.body.coverage.missing.length, 0);
  return { documents: read.documents, pages: read.pages,
    leaves: { ok: bodies.filter(item => item.body.status === 'ok').length, total: items.filter(item => !item.body?.empty).length },
    items: { covered: Math.max(0, must - missing), total: must } };
}

/** Stage 5: the outline (when this build made or extended it) and the notes in ONE write; what they replace is archived in the same write. */
export async function saveStage(ctx, work, outline, held) {
  const { context, plan, state, show, env, input } = ctx, inventory = ctx.inventory?.courseInventory ?? null;
  state.stage = 'saving'; show();
  context.signal.throwIfAborted();
  const leaves = work.items.map(item => ({ id: item.id, title: item.title, anchors: item.anchors, ...(item.body ? { body: item.body } : {}),
    ...(item.exam ? { exam: item.exam } : {}) }));
  const titles = new Map((inventory?.documents || []).map(doc => [doc.key, doc.title]));
  Object.assign(state, { saved: leaves.filter(leaf => leaf.body && !leaf.body.empty).length, kept: work.items.filter(item => item.mode === 'keep' && item.body).length,
    empty: work.items.filter(item => item.body?.empty).length });
  const counts = { written: work.items.filter(item => item.written).length, reused: state.kept, examWritten: state.examWritten, dropped: state.dropped, missed: state.missed,
    examReused: work.items.filter(item => item.exam && !item.needsExam).length, empty: state.empty, short: work.items.filter(item => item.body?.status === 'short').length,
    repaired: state.repaired };
  let record;
  try {
    record = courseNotesMaterial({ title: plan.title, course: plan.course, language: plan.language, outlineId: outline.id, leaves, counts,
      ...(work.papers.length ? { papers: work.papers.map(paper => ({ key: paper.key, ...(paper.fingerprint ? { fingerprint: paper.fingerprint } : {}) })) } : {}),
      glossary: buildGlossary(leaves, inventory, titles, plan.language), coverage: coverageOf(inventory, work.items),
      ...(inventory ? { inventoryPrint: inventory.fingerprint } : {}),
      ...(plan.previous ? { supersedes: plan.previous.id } : {}) });
  } catch (cause) { throw coded('course-book-save-invalid', FAILURES.saveInvalid(input.language), cause); }
  // Partial: a point short or not written, a range not read, an exam call failed. Only those are asked again by the next build.
  state.short = counts.short;
  const completeness = state.missed > 0 || counts.short > 0 || (state.inventory?.failed ?? 0) > 0 ? 'partial' : 'complete';
  if (!held && sameNotes(record.courseNotes, plan.previous?.courseNotes)) {
    Object.assign(state, { unchanged: true, targetId: plan.previous.id, stage: 'complete' }); show();
    return { refs: [{ kind: 'course-book', id: plan.previous.id, course: plan.course }], completeness };
  }
  const archive = [held?.replaces, plan.previous?.id].filter(id => id && id !== record.id && id !== held?.record.id);
  try { await env.ingest([...(held ? [held.record] : []), record], archive); } catch (cause) {
    throw context.signal.aborted ? cause : coded('course-book-save-failed', FAILURES.saveFailed(input.language), cause);
  }
  state.targetId = record.id; state.stage = 'complete'; show();
  return { refs: [{ kind: 'course-book', id: record.id, course: plan.course, ...(held ? { outlineId: held.record.id } : {}) }], completeness };
}
