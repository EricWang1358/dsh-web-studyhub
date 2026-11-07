import { OUTLINE_LIMITS } from '../../../course-outline-book.js';
import { createTextMeasure } from '../../../token-estimate.js';
import { GRANULARITY, INTRO_ASK, INTRO_ASK_LONG, OUTPUT_PER_CALL, cutOf } from './constants.js';

/* The estimate of one course outline build (#462): what a build would make of a course — its knowledge points, the nodes of its table of contents and the
   characters of the text they carry — read from the SAME plan the build runs (outline/plan.js): the materials as the inventory cuts them into page
   ranges, the ranges an earlier inventory read, the cut (`granularity`) and the record's `maxPoints`. No model call, no library write, no clock; the
   start (outline/start.js) answers it instead of starting a Job. Every number is an estimate, never a promise: the model decides the points, the chapters,
   the sections and the words. Pure. */

/** Characters of material one inventory item stands for: an item is a term, a definition, a formula, a step ... the material teaches, and a page
    of a lecture teaches a handful. Sizes the estimate only: nothing is cut at it. */
export const addTokens = (a, b) => ({ low: a.low + b.low, high: a.high + b.high });

export const CHARS_PER_ITEM = 400;
/** Knowledge points the characters of material make at a cut of `perPoint` items a point (at least one): the one rule of the estimate of a build and of a 定制方案's preview. */
export const pointsOfChars = (chars, perPoint = GRANULARITY.medium.perPoint) => Math.max(1, Math.round(chars / (CHARS_PER_ITEM * perPoint)));
/** The characters of material `points` knowledge points stand for at that cut: pointsOfChars the other way round, for a chapter the outline already has. */
export const charsOfPoints = (points, perPoint = GRANULARITY.medium.perPoint) => points * CHARS_PER_ITEM * perPoint;
/** Knowledge points one chapter typically holds: the order call is asked for chapters and, where a chapter has many points, sections. Sizes the estimate only. */
export const POINTS_PER_CHAPTER = 12;
/** Points a chapter holds before the order is expected to give it sections (prompts.js: 'sections where a chapter has many points'). Sizes the estimate only. */
export const POINTS_PER_SECTION = 6;

const leavesOf = nodes => (Array.isArray(nodes) ? nodes : []).flatMap(node => (node?.children ? leavesOf(node.children) : node ? [node] : []));
const countNodes = nodes => (Array.isArray(nodes) ? nodes : []).reduce((sum, node) => sum + 1 + countNodes(node.children), 0);
/** Characters of a knowledge point's own text: the introduction the record holds (what the review book's own text is built on). */
const textOf = node => (typeof node?.intro === 'string' ? node.intro.length : 0);

const ZERO_TOKENS = Object.freeze({ low: 0, high: 0 });
/** A passage of about `chars` characters in the course's language: what the model is asked to write, priced by its size (the words are its own, so a proxy
    is all an estimate has). The filler is built from a code point, not written as a glyph: it is a measuring probe, not a string that could ever be shown,
    and this layer holds no user-facing text (tests/unified-runtime-layout.test.mjs). */
const FILLER = String.fromCharCode(0x4e2d);
const passageOf = (chars, language) => (language === 'en' ? 'a '.repeat(Math.ceil(chars / 2)) : FILLER.repeat(chars));
/** The tokens of the writing a build asks for (`bodyChars`: the point, chapter and section introductions), measured as text: a range, like every other figure. The
    low end is that text; the high end also holds what each inventory call writes while it thinks (OUTPUT_PER_CALL), which is most of the output on a thinking model. */
export function writeTokensOf(chars, language, calls = 0) {
  const text = chars > 0 ? createTextMeasure().body(passageOf(chars, language)) : { ...ZERO_TOKENS };
  return { low: text.low, high: Math.max(text.high, calls * OUTPUT_PER_CALL) };
}
/** The tokens of the material the inventory calls would read (a range, as lib/token-estimate.js measures text; the prompt and what the model writes are not counted). */
function readTokensOf(inventory) {
  const measure = createTextMeasure();
  return (inventory?.calls ?? []).reduce((sum, call) => {
    const read = measure.body(call.ranges.flatMap(range => range.pieces.map(piece => piece.text)).join('\n'));
    return { low: sum.low + read.low, high: sum.high + read.high };
  }, { ...ZERO_TOKENS });
}

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
 * -> { basis: 'inventory' | 'descriptors' | 'current', materials, papers, ranges, calls, items, chars, points, nodes, bodyChars, readTokens ({ low, high }), cut }
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
    const bodyChars = leaves.reduce((sum, leaf) => sum + textOf(leaf), 0), readTokens = { ...ZERO_TOKENS }, writeTokens = { ...ZERO_TOKENS };
    return { basis: 'current', materials, papers, ranges: 0, calls: 0, items: null, chars, points: leaves.length, nodes: countNodes(nodes), bodyChars,
      readTokens, writeTokens, totalTokens: addTokens(readTokens, writeTokens), cut };
  }
  const cutSizes = cutOf(plan);
  // A knowledge point holds about `perPoint` items, an item about CHARS_PER_ITEM characters. No readable text at all: the quick outline makes a point of the
  // materials' own units, at most what one map call may name.
  const byContent = chars > 0 ? pointsOfChars(chars, cutSizes.perPoint) : 0;
  const byUnits = Math.max(1, Math.min(plan.described.units.length, plan.batches.length * cutSizes.perBatch));
  // More points than the record's `maxPoints`: the build merges neighbours until it holds (outline/fit.js), so the estimate holds too.
  const points = Math.min(OUTLINE_LIMITS.nodes, plan.maxPoints ? Math.min(plan.maxPoints, byContent || byUnits) : byContent || byUnits);
  const chapters = Math.max(1, Math.min(Math.max(1, materials), Math.ceil(points / POINTS_PER_CHAPTER)));
  const sections = points >= chapters * POINTS_PER_SECTION ? chapters : 0;
  const nodes = Math.min(OUTLINE_LIMITS.nodes, points + chapters + sections);
  // The introduction each knowledge point is asked for ('two or three sentences' from the inventory; 'one sentence' from the descriptors).
  const bodyChars = points * (inventory && inventory.ranges ? INTRO_ASK_LONG : INTRO_ASK);
  const readTokens = readTokensOf(plan.inventory), writeTokens = writeTokensOf(bodyChars, plan.language, inventory?.calls ?? 0);
  return { basis: inventory && inventory.ranges ? 'inventory' : 'descriptors', materials, papers, ranges: inventory?.ranges ?? 0, calls: inventory?.calls ?? 0,
    items: inventory?.items ?? null, chars, points, nodes, bodyChars, readTokens, writeTokens, totalTokens: addTokens(readTokens, writeTokens), cut };
}
