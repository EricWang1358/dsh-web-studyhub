import { OUTLINE_LIMITS } from '../../../course-outline-book.js';
import { INTRO_ASK, INTRO_ASK_LONG, cutOf } from './constants.js';

/* The estimate of one course outline build (#462): what a build would make of a course — its knowledge points, the nodes of its table of contents and the
   characters of the text they carry — read from the SAME plan the build runs (outline/plan.js): the materials as the inventory cuts them into page
   ranges, the ranges an earlier inventory read, the cut (`granularity`) and the record's `maxPoints`. No model call, no library write, no clock; the
   start (outline/start.js) answers it instead of starting a Job. Every number is an estimate, never a promise: the model decides the points, the chapters,
   the sections and the words. Pure. */

/** Characters of material one inventory item stands for: an item is a term, a definition, a formula, a step ... the material teaches, and a page
    of a lecture teaches a handful. Sizes the estimate only: nothing is cut at it. */
export const CHARS_PER_ITEM = 400;
/** Knowledge points one chapter typically holds: the order call is asked for chapters and, where a chapter has many points, sections. Sizes the estimate only. */
export const POINTS_PER_CHAPTER = 12;
/** Points a chapter holds before the order is expected to give it sections (prompts.js: 'sections where a chapter has many points'). Sizes the estimate only. */
export const POINTS_PER_SECTION = 6;

const leavesOf = nodes => (Array.isArray(nodes) ? nodes : []).flatMap(node => (node?.children ? leavesOf(node.children) : node ? [node] : []));
const countNodes = nodes => (Array.isArray(nodes) ? nodes : []).reduce((sum, node) => sum + 1 + countNodes(node.children), 0);
/** Characters of a knowledge point's own text: the introduction the record holds (what the review book's own text is built on). */
const textOf = node => (typeof node?.intro === 'string' ? node.intro.length : 0);

/** The inventory side of a plan: its page ranges, the calls that read the rest, the items they are expected to name (the items an earlier inventory read of an
    unchanged range are counted as they are) and the characters of material they cover. null items: no range, nothing to estimate. */
function inventoryOf(inventory) {
  const ranges = Array.isArray(inventory?.ranges) ? inventory.ranges : [];
  let chars = 0, items = 0;
  for (const range of ranges) {
    chars += range.chars || 0;
    const read = inventory.reused?.get(range.print);
    items += read ? read.length : Math.max(1, Math.round((range.chars || 0) / CHARS_PER_ITEM));
  }
  return { ranges: ranges.length, calls: Array.isArray(inventory?.calls) ? inventory.calls.length : 0, items: items || null, chars };
}

/**
 * The estimate of a planned build (outline/plan.js: planOutline or planPapersOnly).
 * -> { basis: 'inventory' | 'descriptors' | 'current', materials, papers, ranges, calls, items, chars, points, nodes, bodyChars, cut }
 *   basis: what the numbers rest on — the inventory of the materials, their descriptors (no readable text), or (a papers-only build) the outline it starts from, whose
 *   points and text it keeps as they are.
 */
export function estimateOutline(plan) {
  const materials = plan.described.documents.length, papers = plan.papers.length, cut = { ...(plan.shape || {}) };
  const paperKeys = new Set(plan.papers.map(paper => paper.key)), inventory = plan.inventory ? inventoryOf(plan.inventory) : null;
  // The material the knowledge points are made of: what the inventory reads (the sample papers are read on their own, not taught), else the documents themselves.
  const chars = inventory && inventory.ranges ? inventory.chars
    : plan.described.documents.reduce((sum, doc) => sum + (paperKeys.has(doc.key) ? 0 : (doc.chars || 0)), 0);
  // A papers-only build keeps the chapters and knowledge points of the current outline (the same ids): its figures are what the record holds, not a guess.
  if (plan.base) {
    const nodes = plan.base.nodes || [], leaves = leavesOf(nodes);
    return { basis: 'current', materials, papers, ranges: 0, calls: 0, items: null, chars, points: leaves.length, nodes: countNodes(nodes),
      bodyChars: leaves.reduce((sum, leaf) => sum + textOf(leaf), 0), cut };
  }
  const cutSizes = cutOf(plan);
  // A knowledge point holds about `perPoint` items, an item about CHARS_PER_ITEM characters. No readable text at all: the quick outline makes a point of the
  // materials' own units, at most what one map call may name.
  const byContent = chars > 0 ? Math.max(1, Math.round(chars / (CHARS_PER_ITEM * cutSizes.perPoint))) : 0;
  const byUnits = Math.max(1, Math.min(plan.described.units.length, plan.batches.length * cutSizes.perBatch));
  // More points than the record's `maxPoints`: the build merges neighbours until it holds (outline/fit.js), so the estimate holds too.
  const points = Math.min(OUTLINE_LIMITS.nodes, plan.maxPoints ? Math.min(plan.maxPoints, byContent || byUnits) : byContent || byUnits);
  const chapters = Math.max(1, Math.min(Math.max(1, materials), Math.ceil(points / POINTS_PER_CHAPTER)));
  const sections = points >= chapters * POINTS_PER_SECTION ? chapters : 0;
  const nodes = Math.min(OUTLINE_LIMITS.nodes, points + chapters + sections);
  // The introduction each knowledge point is asked for ('two or three sentences' from the inventory; 'one sentence' from the descriptors).
  const bodyChars = points * (inventory && inventory.ranges ? INTRO_ASK_LONG : INTRO_ASK);
  return { basis: inventory && inventory.ranges ? 'inventory' : 'descriptors', materials, papers, ranges: inventory?.ranges ?? 0, calls: inventory?.calls ?? 0,
    items: inventory?.items ?? null, chars, points, nodes, bodyChars, cut };
}
