import { OUTLINE_LIMITS, clip, nodeId } from '../../../course-outline-book.js';
import { outlineLeaves } from '../../../course-book-inputs.js';

/* An outline built BY CHAPTERS (custom plan S2, book/part-plan.js): the points the inventory outline made of the chapters a build adds (outline/inventory-tree.js,
   anchored on their pages only) are grouped under ONE top-level node per chapter of the material, titled as the material titles it; the order's chapters become
   its sections (a leaf keeps its id, title, anchors and items). They join the chapters the outline held in the course's order, and those stay exactly as they were
   (the same nodes and ids), so no written point changes. `parts` ([{ key, doc, node }], lib/course-outline-book.js) says which chapter of the materials each
   top-level node is. Pure. */

const idsOf = nodes => nodes.flatMap(node => [node.id, ...(node.children ? idsOf(node.children) : [])]);

/** The chapter (an index of `rows`) a leaf belongs to: the one holding most of its items' places, else the first. */
function homeOf(leaf, rows, byItem) {
  const votes = new Map();
  for (const id of leaf.items || []) for (const place of byItem.get(id)?.places || []) {
    const at = rows.findIndex(row => row.doc === place.doc && (!row.sourceIds || row.sourceIds.includes(place.sourceId)));
    if (at >= 0) votes.set(at, (votes.get(at) || 0) + 1);
  }
  return [...votes].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 0;
}

/**
 * The added chapters as top-level nodes. `nodes`: the inventory outline of their items; `adds`: their rows (book/pick-pages.js materialChapters) in the course's
 * order; `taken`: every node id the outline holds (new ids are told apart from them). -> [{ node, keys, doc }] for the chapters that got a point.
 */
export function partNodes(nodes, adds, inventory, taken) {
  const groups = [];
  // The chapters inside one text are one material read whole: one node.
  for (const row of adds) {
    const same = !row.sourceIds && groups.find(group => !group.row.sourceIds && group.row.doc === row.doc);
    if (same) same.keys.push(row.id); else groups.push({ row, keys: [row.id], sections: new Map() });
  }
  const byItem = new Map(inventory.items.map(item => [item.id, item])), rows = groups.map(group => group.row);
  for (const top of nodes) for (const { node } of outlineLeaves([top])) {
    const group = groups[homeOf(node, rows, byItem)];
    if (!group.sections.has(top)) group.sections.set(top, []);
    // A leaf id the outline already holds (the same content twice) gets a new one.
    group.sections.get(top).push(taken.has(node.id) ? { ...node, id: nodeId(taken, ['leaf', node.id]) } : (taken.add(node.id), node));
  }
  return groups.filter(group => group.sections.size).map(group => {
    const sections = [...group.sections];
    const children = sections.length === 1 ? sections[0][1] : sections.map(([top, leaves]) => ({ id: nodeId(taken, ['part-section', group.row.id, top.title]), title: top.title,
      ...(top.intro ? { intro: top.intro } : {}), children: leaves }));
    return { node: { id: nodeId(taken, ['part', group.row.id]), title: clip(group.row.title, OUTLINE_LIMITS.titleChars) || group.row.id, children }, keys: group.keys,
      doc: group.row.doc };
  });
}

/** Every id of `nodes`, as `taken` for partNodes. */
export const takenIds = nodes => new Set(['other', ...idsOf(nodes)]);

/**
 * The outline's chapters with the added ones, in the course's order (`order`: every taught chapter id; a chapter the parts do not name keeps its place at the end).
 * `base`: { nodes, parts } of the outline kept (none when it is made again). -> { nodes, parts }
 */
export function mergeParts(base, built, order) {
  const at = new Map(order.map((id, index) => [id, index])), keyOf = new Map(base.parts.map(part => [part.node, part.key]));
  const entries = [...base.nodes.map(node => ({ node, at: at.get(keyOf.get(node.id)) ?? Infinity })),
    ...built.map(entry => ({ node: entry.node, at: at.get(entry.keys[0]) ?? Infinity }))];
  const nodes = entries.map((entry, index) => ({ ...entry, index })).sort((a, b) => a.at - b.at || a.index - b.index).map(entry => entry.node);
  return { nodes, parts: [...base.parts, ...built.flatMap(entry => entry.keys.map(key => ({ key, doc: entry.doc, node: entry.node.id })))] };
}
