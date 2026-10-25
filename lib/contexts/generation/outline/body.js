/* #462: the knowledge points a build made whose own text is shorter than the build's `minBodyChars` (default 200 characters; 0 turns the report off). A short
   point is where a review book shows an empty shell (lib/book-agent-read.js summaryOf): the build says so in its result — never silently — but it writes exactly
   the outline it would have written anyway. Pure. */

/** The most knowledge points a result lists (a large outline may have many); `count` says how many there really are. */
export const BODY_WARNINGS_KEPT = 50;

/** The characters of a knowledge point's own text: its introduction as the record holds it (the seed of the review book's text). */
export const bodyCharsOf = node => (typeof node?.intro === 'string' ? node.intro.length : 0);

const leavesOf = nodes => (Array.isArray(nodes) ? nodes : []).flatMap(node => (node?.children ? leavesOf(node.children) : node ? [node] : []));

/**
 * The knowledge points of an outline whose text is under `minBodyChars`, in reading order.
 * -> { minBodyChars, leaves, count, list: [{ nodeId, title, bodyChars }] }  `leaves`: the knowledge points the outline holds; `count`: how many are short;
 *    `list`: the first BODY_WARNINGS_KEPT of them. `minBodyChars` 0 (or less): nothing is reported.
 */
export function bodyWarningsOf(nodes, minBodyChars = 0) {
  const leaves = leavesOf(nodes);
  if (!(minBodyChars > 0)) return { minBodyChars: 0, leaves: leaves.length, count: 0, list: [] };
  const short = leaves.filter(leaf => bodyCharsOf(leaf) < minBodyChars);
  return { minBodyChars, leaves: leaves.length, count: short.length,
    list: short.slice(0, BODY_WARNINGS_KEPT).map(leaf => ({ nodeId: leaf.id, title: leaf.title, bodyChars: bodyCharsOf(leaf) })) };
}
