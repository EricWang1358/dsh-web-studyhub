/* The book's files after its outline was made again (lib/course-book-files.js openCourseBook): which new point each old point's files go to. An outline built
   from the inventory cuts a material into page spans, so anchors are compared by what they HOLD, not by their keys: the sources (pages) each anchor stands
   for (lib/course-book-inputs.js anchorSources), then the inventory items both leaves name, then the title. Pure.

   Each old point goes to the new point it shares most with, one to one, best pairs first; an old point whose best new point is already taken by a closer
   one is FOLDED into it (its own text is kept there under its old title, never lost); only an old point that shares nothing and has no namesake is lost
   (未归位).

   The check of the content (#461). An old point's candidates are ranked by the share of ITS pages (or items) each new point holds; the best one (ties: the
   first in order) is the closest. A new point of ANOTHER title takes the old point's text only when it holds at least MOVE_MIN_SHARE of those pages, or
   when it is the closest one and at least MOVE_MIN_SHARE of its own pages are inside the old point (a part of it: a material of 3.4 cut into sections,
   however many, follows into its biggest part, the first of equal ones, WHATEVER IT IS CALLED: a long note whose pages survive only as one part, or one
   sliver wholly inside it, follows into that part even when its title is about something else). Pairs are made one to one in descending order of that share, so a small part never
   takes the text before the main one is considered. A new point of the same title takes it when they share anything. Else the old point is HELD back
   (`held`: its text waits in 未归位 naming the closest new point), never put under a title it does not match; only an old point that shares nothing with
   any new point may still go to a new point of the same title (as before). Every move to another title records `share`. */

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
  const titled = (i, j) => sameTitle(older[i].node.title) === sameTitle(fresher[j].node.title);
  // Every pair that shares anything, with the share of the OLD point it holds; each old point's closest new point (the biggest share, the first of equals).
  const pairs = [], best = new Map();
  older.forEach((o, i) => fresher.forEach((n, j) => {
    if (!(overlap(o, n) > 0)) return;
    const share = holds(o, n);
    pairs.push({ i, j, share });
    if (!best.has(i) || share > best.get(i).share) best.set(i, { j, share });
  }));
  // `share` is compared unrounded (the threshold is exactly MOVE_MIN_SHARE); `shown` is what the book says (two decimals).
  const shareOf = new Map(pairs.map(pair => [`${pair.i}:${pair.j}`, pair.share])), share = (i, j) => shareOf.get(`${i}:${j}`) ?? 0, shown = (i, j) => rounded(share(i, j));
  const fits = (i, j) => titled(i, j) || share(i, j) >= MOVE_MIN_SHARE || (best.get(i)?.j === j && holds(fresher[j], older[i]) >= MOVE_MIN_SHARE);
  const ofNew = new Map(), ofOld = new Map(), folded = new Map(), shares = new Map(), doubt = new Map();
  // One to one, the biggest shares first (the same title first among equals, then the order of the points); then an old point left folds into its closest
  // point when that one fits; else it is held back.
  const ranked = pairs.filter(({ i, j }) => fits(i, j)).sort((a, b) => b.share - a.share || Number(titled(b.i, b.j)) - Number(titled(a.i, a.j)) || a.i - b.i || a.j - b.j);
  for (const { i, j } of ranked) if (!ofOld.has(i) && !ofNew.has(j)) { ofOld.set(i, j); ofNew.set(j, i); }
  for (const [i, { j }] of best) {
    if (ofOld.has(i)) continue;
    if (fits(i, j)) folded.set(older[i].node.id, fresher[j].node.id); else doubt.set(i, j);
  }
  // An old point that shares nothing with any new point may still go to a free one of the same title (as before #461); a held one may not.
  older.forEach((o, i) => {
    if (best.has(i)) return;
    const j = fresher.findIndex((n, k) => !ofNew.has(k) && sameTitle(n.node.title) === sameTitle(o.node.title));
    if (j >= 0) { ofOld.set(i, j); ofNew.set(j, i); }
  });
  for (const [i, j] of ofOld) if (!titled(i, j)) shares.set(older[i].node.id, shown(i, j));
  for (const [id, to] of folded) { const i = older.findIndex(o => o.node.id === id), j = fresher.findIndex(n => n.node.id === to); if (!titled(i, j)) shares.set(id, shown(i, j)); }
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
  const held = [...doubt].map(([i, j]) => ({ node: older[i].node, likely: fresher[j].node.id, share: shown(i, j) }));
  return { nodes, moved, folded, held, shares, lost, next: counter };
}
