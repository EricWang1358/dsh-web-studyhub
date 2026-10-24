/* The book's files after its outline was made again (lib/course-book-files.js openCourseBook): which new point each old point's files go to. An outline built
   from the inventory cuts a material into page spans, so anchors are compared by what they HOLD, not by their keys: the sources (pages) each anchor stands
   for (lib/course-book-inputs.js anchorSources), then the inventory items both leaves name, then the title. Pure.

   Each old point goes to the new point it shares most with, one to one, best pairs first; an old point whose best new point is already taken by a closer
   one is FOLDED into it (its own text is kept there under its old title, never lost); only an old point that shares nothing and has no namesake is lost
   (未归位).

   The check of the content (#461): a point of ANOTHER title takes an old point's text only when the two are mostly the same pages: the new point holds at
   least MOVE_MIN_SHARE of the old one's pages (or items), or the new point is mostly a part of the old one (a material of 3.4 cut into its sections). Else
   the old point is HELD back (`held`: its text waits in 未归位 naming the closest new point), never put under a title it does not match. A move to a point
   of the same title needs no share. Every move to another title records `share`: how much of the old point's pages the new one holds. */

/** The least share of an old point's pages (or items) a new point of another title must hold to take its text. */
export const MOVE_MIN_SHARE = 0.5;

const sameTitle = title => String(title ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/** The characters two lists of ranges ([{ sourceId, start, end }]) share, as a share of the bigger list. */
function sharedText(x, y) {
  const size = list => list.reduce((sum, range) => sum + (range.end - range.start), 0), big = Math.max(size(x), size(y));
  if (!big) return 0;
  let common = 0;
  for (const a of x) for (const b of y) if (a.sourceId === b.sourceId) common += Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  return common / big;
}
/** How much of the leaf `o` the leaf `n` holds: the share of its characters, or of its items, whichever is more (0..1). */
function holds(o, n) {
  const size = o.sources.reduce((sum, range) => sum + (range.end - range.start), 0);
  let common = 0;
  for (const a of o.sources) for (const b of n.sources) if (a.sourceId === b.sourceId) common += Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  const items = o.items.size ? [...o.items].filter(item => n.items.has(item)).length / o.items.size : 0;
  return Math.max(size ? Math.min(1, common / size) : 0, items);
}
const rounded = value => Math.round(value * 100) / 100;

/** How much two leaves share: the characters of their anchors and their items, as a share of the bigger side; 0 when nothing. */
function overlap(a, b) {
  const shared = (x, y) => { if (!x.size || !y.size) return 0; let n = 0; for (const value of x) if (y.has(value)) n++; return n / Math.max(x.size, y.size); };
  return sharedText(a.sources, b.sources) + shared(a.items, b.items);
}

/**
 * @param old the old manifest ({ nodes }); `outlineNodes` the new outline's nodes; `sourcesOf(anchor)` -> the characters it stands for, [{ sourceId, start, end }]
 *        (omitted: the anchor itself).
 * @returns { nodes (the new manifest), moved: Map<old id, new id>, folded: Map<old id, new id>, held: [{ node: old leaf, likely: new id, share }],
 *            shares: Map<old id, share> (of a move or a fold to another title), lost: [old leaf], next }
 */
export function remapManifest(old, outlineNodes, next = 1, { sourcesOf = anchor => [{ sourceId: anchor, start: 0, end: 1 }] } = {}) {
  const oldLeaves = [], oldParents = [];
  const collect = list => (list || []).forEach(node => { (node.leaf ? oldLeaves : oldParents).push(node); collect(node.children); });
  collect(old?.nodes);
  const used = new Set([...oldLeaves, ...oldParents].map(node => node.hid));
  let counter = next;
  const fresh = () => { while (used.has(`h${counter}`)) counter += 1; used.add(`h${counter}`); return `h${counter++}`; };
  // A source given only by its id (an older caller) counts as one unit of text.
  const range = value => (typeof value === 'string' ? { sourceId: value, start: 0, end: 1 } : value);
  const shape = node => ({ node, sources: (node.anchors || []).flatMap(sourcesOf).map(range), items: new Set(node.items || []) });
  const newLeaves = [], walk = list => (list || []).forEach(node => (node.children?.length ? walk(node.children) : newLeaves.push(node)));
  walk(outlineNodes);
  const fresher = newLeaves.map(shape), older = oldLeaves.map(shape);
  // Best pairs first, one to one; then the old points left fold into their best new point; then titles.
  const pairs = [];
  older.forEach((o, i) => fresher.forEach((n, j) => { const score = overlap(o, n); if (score > 0) pairs.push({ i, j, score: score + (sameTitle(o.node.title) === sameTitle(n.node.title) ? 0.001 : 0) }); }));
  pairs.sort((a, b) => b.score - a.score || a.i - b.i || a.j - b.j);
  const ofNew = new Map(), ofOld = new Map(), folded = new Map(), shares = new Map(), doubt = new Map(), rejected = new Set();
  const titled = (i, j) => sameTitle(older[i].node.title) === sameTitle(fresher[j].node.title);
  const share = (i, j) => rounded(holds(older[i], fresher[j]));
  const fits = (i, j) => titled(i, j) || share(i, j) >= MOVE_MIN_SHARE || holds(fresher[j], older[i]) >= MOVE_MIN_SHARE;
  // One to one, best pairs first; a pair whose new point (of another title) holds too little of the old one is set aside and the pairing made again.
  for (;;) {
    ofOld.clear(); ofNew.clear();
    for (const { i, j } of pairs) if (!rejected.has(`${i}:${j}`) && !ofOld.has(i) && !ofNew.has(j)) { ofOld.set(i, j); ofNew.set(j, i); }
    const weak = [...ofOld].filter(([i, j]) => !fits(i, j));
    if (!weak.length) break;
    weak.forEach(([i, j]) => rejected.add(`${i}:${j}`));
  }
  for (const { i, j } of pairs) {
    if (ofOld.has(i) || folded.has(older[i].node.id)) continue;
    if (fits(i, j)) { folded.set(older[i].node.id, fresher[j].node.id); doubt.delete(i); }
    else if (!doubt.has(i)) doubt.set(i, j);
  }
  older.forEach((o, i) => {
    if (ofOld.has(i) || folded.has(o.node.id)) return;
    const j = fresher.findIndex((n, k) => !ofNew.has(k) && sameTitle(n.node.title) === sameTitle(o.node.title));
    if (j >= 0) { ofOld.set(i, j); ofNew.set(j, i); doubt.delete(i); }
  });
  for (const [i, j] of ofOld) if (!titled(i, j)) shares.set(older[i].node.id, share(i, j));
  for (const [id, to] of folded) { const i = older.findIndex(o => o.node.id === id), j = fresher.findIndex(n => n.node.id === to); if (!titled(i, j)) shares.set(id, share(i, j)); }
  const moved = new Map([...ofOld].map(([i, j]) => [older[i].node.id, fresher[j].node.id]));
  const takenParents = new Set();
  const build = list => (list || []).map(node => {
    const leaf = !node.children?.length;
    if (leaf) {
      const j = newLeaves.indexOf(node), i = ofNew.get(j), match = i === undefined ? null : older[i].node;
      // Where the files came from when the old point had another name (the book says it once, and the point keeps a quiet line).
      const from = match && sameTitle(match.title) !== sameTitle(node.title) ? { movedFrom: match.title, ...(shares.has(match.id) ? { moveShare: shares.get(match.id) } : {}) }
        : match?.movedFrom && sameTitle(match.title) === sameTitle(node.title) ? { movedFrom: match.movedFrom, ...(match.moveShare !== undefined ? { moveShare: match.moveShare } : {}) } : {};
      return { id: node.id, hid: match?.hid ?? fresh(), title: node.title, leaf, anchors: [...(node.anchors || [])], ...(node.items?.length ? { items: [...node.items] } : {}), ...from, children: [] };
    }
    const match = oldParents.find(candidate => !takenParents.has(candidate.hid) && sameTitle(candidate.title) === sameTitle(node.title));
    if (match) takenParents.add(match.hid);
    return { id: node.id, hid: match?.hid ?? fresh(), title: node.title, leaf, anchors: [], children: build(node.children) };
  });
  const nodes = build(outlineNodes);
  const lost = older.filter((o, i) => !ofOld.has(i) && !folded.has(o.node.id) && !doubt.has(i)).map(o => o.node);
  const held = [...doubt].map(([i, j]) => ({ node: older[i].node, likely: fresher[j].node.id, share: share(i, j) }));
  return { nodes, moved, folded, held, shares, lost, next: counter };
}
