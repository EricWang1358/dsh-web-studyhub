/* The book's files after its outline was made again (lib/course-book-files.js openCourseBook): which new point each old point's files go to. An outline built
   from the inventory cuts a material into page spans, so anchors are compared by what they HOLD, not by their keys: the sources (pages) each anchor stands
   for (lib/course-book-inputs.js anchorSources), then the inventory items both leaves name, then the title. Pure.

   Each old point goes to the new point it shares most with, one to one, best pairs first; an old point whose best new point is already taken by a closer
   one is FOLDED into it (its own text is kept there under its old title, never lost); only an old point that shares nothing and has no namesake is lost
   (未归位). */

const sameTitle = title => String(title ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/** How much two leaves share: their sources (pages) and their items, as a share of the bigger side; 0 when nothing. */
function overlap(a, b) {
  const shared = (x, y) => { if (!x.size || !y.size) return 0; let n = 0; for (const value of x) if (y.has(value)) n++; return n / Math.max(x.size, y.size); };
  return shared(a.sources, b.sources) + shared(a.items, b.items);
}

/**
 * @param old the old manifest ({ nodes }); `outlineNodes` the new outline's nodes; `sourcesOf(anchor)` -> the source ids it stands for (omitted: the anchor itself).
 * @returns { nodes (the new manifest), moved: Map<old id, new id>, folded: Map<old id, new id>, lost: [old leaf], next }
 */
export function remapManifest(old, outlineNodes, next = 1, { sourcesOf = anchor => [anchor] } = {}) {
  const oldLeaves = [], oldParents = [];
  const collect = list => (list || []).forEach(node => { (node.leaf ? oldLeaves : oldParents).push(node); collect(node.children); });
  collect(old?.nodes);
  const used = new Set([...oldLeaves, ...oldParents].map(node => node.hid));
  let counter = next;
  const fresh = () => { while (used.has(`h${counter}`)) counter += 1; used.add(`h${counter}`); return `h${counter++}`; };
  const shape = node => ({ node, sources: new Set((node.anchors || []).flatMap(sourcesOf)), items: new Set(node.items || []) });
  const newLeaves = [], walk = list => (list || []).forEach(node => (node.children?.length ? walk(node.children) : newLeaves.push(node)));
  walk(outlineNodes);
  const fresher = newLeaves.map(shape), older = oldLeaves.map(shape);
  // Best pairs first, one to one; then the old points left fold into their best new point; then titles.
  const pairs = [];
  older.forEach((o, i) => fresher.forEach((n, j) => { const score = overlap(o, n); if (score > 0) pairs.push({ i, j, score: score + (sameTitle(o.node.title) === sameTitle(n.node.title) ? 0.001 : 0) }); }));
  pairs.sort((a, b) => b.score - a.score || a.i - b.i || a.j - b.j);
  const ofNew = new Map(), ofOld = new Map(), folded = new Map();
  for (const { i, j } of pairs) if (!ofOld.has(i) && !ofNew.has(j)) { ofOld.set(i, j); ofNew.set(j, i); }
  for (const { i, j } of pairs) if (!ofOld.has(i) && !folded.has(older[i].node.id)) folded.set(older[i].node.id, fresher[j].node.id);
  older.forEach((o, i) => {
    if (ofOld.has(i) || folded.has(o.node.id)) return;
    const j = fresher.findIndex((n, k) => !ofNew.has(k) && sameTitle(n.node.title) === sameTitle(o.node.title));
    if (j >= 0) { ofOld.set(i, j); ofNew.set(j, i); }
  });
  const moved = new Map([...ofOld].map(([i, j]) => [older[i].node.id, fresher[j].node.id]));
  const takenParents = new Set();
  const build = list => (list || []).map(node => {
    const leaf = !node.children?.length;
    if (leaf) {
      const j = newLeaves.indexOf(node), i = ofNew.get(j), match = i === undefined ? null : older[i].node;
      return { id: node.id, hid: match?.hid ?? fresh(), title: node.title, leaf, anchors: [...(node.anchors || [])], ...(node.items?.length ? { items: [...node.items] } : {}), children: [] };
    }
    const match = oldParents.find(candidate => !takenParents.has(candidate.hid) && sameTitle(candidate.title) === sameTitle(node.title));
    if (match) takenParents.add(match.hid);
    return { id: node.id, hid: match?.hid ?? fresh(), title: node.title, leaf, anchors: [], children: build(node.children) };
  });
  const nodes = build(outlineNodes);
  const lost = older.filter((o, i) => !ofOld.has(i) && !folded.has(o.node.id)).map(o => o.node);
  return { nodes, moved, folded, lost, next: counter };
}
