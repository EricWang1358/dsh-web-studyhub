/* Spine reading of a knowledge skeleton: top-level concepts become stations
   on one horizontal learning axis (in the order the skeleton lists them),
   their children hang below as a vertical branch, and deeper nodes branch
   again from those. Pure data, no React, so the shape can be tested. */

const cardKey = (ref) => `${ref.deckId}:${ref.cardId}`;

function uniqueCards(refs) {
  const seen = new Map();
  for (const ref of refs) if (ref?.cardId && !seen.has(cardKey(ref))) seen.set(cardKey(ref), ref);
  return [...seen.values()];
}

export function skeletonSpine(skeleton) {
  const nodes = Array.isArray(skeleton?.nodes) ? skeleton.nodes : [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map();
  for (const n of nodes) {
    const parent = n.parent && byId.has(n.parent) && n.parent !== n.id ? n.parent : "";
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(n);
  }
  const contrasts = new Map();
  for (const r of skeleton?.relations || []) {
    if (r.type !== "contrasts" || !byId.has(r.from) || !byId.has(r.to)) continue;
    for (const [a, b] of [[r.from, r.to], [r.to, r.from]]) {
      if (!contrasts.has(a)) contrasts.set(a, []);
      contrasts.get(a).push(byId.get(b).term);
    }
  }
  const visited = new Set();
  const branch = (node, depth) => {
    visited.add(node.id);
    const kids = (children.get(node.id) || []).filter((k) => !visited.has(k.id)).map((k) => branch(k, depth + 1));
    return {
      id: node.id,
      term: node.term,
      meaning: node.meaning || "",
      attributes: node.attributes || [],
      contrasts: [...new Set(contrasts.get(node.id) || [])],
      depth,
      cards: node.cards || [],
      children: kids,
      subtreeCards: uniqueCards([...(node.cards || []), ...kids.flatMap((k) => k.subtreeCards)]),
    };
  };
  const stations = (children.get("") || []).map((root) => branch(root, 0));
  // Parent cycles leave nodes no root reaches; they still get a station.
  for (const n of nodes) if (!visited.has(n.id)) stations.push(branch(n, 0));
  return stations.map((s, i) => ({ ...s, step: i + 1 }));
}
