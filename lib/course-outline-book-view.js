/* 课程总纲 step 2: the AI outline (lib/course-outline-book.js) laid over the outline engine's rows (lib/course-outline.js). Pure, no I/O.

   A leaf of the outline names rows of the engine (`anchors`: a document key or a chapter key); its questions are the questions of those rows, computed now,
   so a question added, answered or deleted after the outline was made counts at once. The library may have changed since: an anchor that is no longer a
   row is passed over (the outline then says it is out of date), and every row of the course that no leaf holds is in 其他, never hidden. The questions a
   document has outside its chapters (its `rest` row) go with the leaf that holds its first chapter, else to 其他. */

export const BOOK_PREFIX = 'bk:';
export const OTHER_KEY = `${BOOK_PREFIX}other`;
export const bookKey = id => `${BOOK_PREFIX}${id}`;

/** The document rows of the layout, and for each chapter row the document it belongs to. */
function documentsOf(layout) {
  const docs = [], parent = new Map();
  for (const row of layout.values()) if (row.kind === 'document') { docs.push(row); for (const chapter of row.chapters) parent.set(chapter.key, row); }
  return { docs, parent };
}

/**
 * The outline as rows of the engine: `rows` (Map key -> { key, kind: 'book', nodes, anchors?, leaf }) for every node and 其他, `tree` ([{ key, node, depth,
 * children }] in reading order), and `other` ({ key, anchors }) with what no leaf holds. `layout` is lib/course-outline.js's map of rows.
 */
export function bookLayout(layout, outline) {
  const { docs, parent } = documentsOf(layout), claimed = new Set(), rows = new Map(), firstLeaf = new Map();
  const unitsOf = key => { const row = layout.get(key); return row?.kind === 'document' ? (row.chapters.length ? row.chapters.map(chapter => chapter.key) : [key]) : row?.kind === 'chapter' ? [key] : []; };
  const leafAnchors = (node, key) => {
    const kept = [];
    for (const anchor of node.anchors || []) {
      const units = unitsOf(anchor).filter(unit => !claimed.has(unit));
      if (!units.length) continue;
      const whole = layout.get(anchor).kind === 'document' && units.length === unitsOf(anchor).length;
      units.forEach(unit => claimed.add(unit));
      kept.push(...(whole ? [anchor] : units));
      for (const unit of units) { const doc = parent.get(unit); if (doc && !firstLeaf.has(doc.key)) firstLeaf.set(doc.key, key); }
    }
    return kept;
  };
  const build = (node, depth) => {
    const key = bookKey(node.id);
    const children = (node.children || []).map(child => build(child, depth + 1));
    const entry = { key, node, depth, children, leaf: !node.children?.length, anchors: node.children?.length ? [] : leafAnchors(node, key) };
    rows.set(key, entry);
    return entry;
  };
  const tree = (outline.nodes || []).map(node => build(node, 1));
  // A document's questions outside its chapters follow its first claimed chapter.
  for (const doc of docs) for (const chapter of doc.chapters) {
    if (chapter.kind !== 'rest' || claimed.has(chapter.key) || !firstLeaf.has(doc.key)) continue;
    claimed.add(chapter.key);
    rows.get(firstLeaf.get(doc.key)).anchors.push(chapter.key);
  }
  const other = [];
  for (const anchor of outline.other?.anchors || []) { const units = unitsOf(anchor).filter(unit => !claimed.has(unit)); units.forEach(unit => claimed.add(unit)); other.push(...units); }
  for (const doc of docs) {
    const left = unitsOf(doc.key).filter(unit => !claimed.has(unit));
    left.forEach(unit => claimed.add(unit));
    if (left.length && left.length === unitsOf(doc.key).length) other.push(doc.key); else other.push(...left);
  }
  // Every row's questions: the engine nodes its anchors stand for (a parent: those of its children).
  const nodesOf = entry => entry.leaf ? entry.anchors.flatMap(anchor => layout.get(anchor)?.nodes || []) : entry.children.flatMap(nodesOf);
  rows.set(OTHER_KEY, { key: OTHER_KEY, node: { id: 'other' }, depth: 1, children: [], leaf: true, anchors: other });
  // A leaf of one row without chapters opens to its questions; any other leaf opens to its rows (a document, a chapter) first.
  const opensRows = anchors => anchors.length > 1 || (anchors.length === 1 && layout.get(anchors[0]).kind === 'document' && layout.get(anchors[0]).chapters.length > 0);
  for (const entry of rows.values()) Object.assign(entry, { kind: 'book', nodes: [...new Set(nodesOf(entry))], ...(entry.leaf ? { opensRows: opensRows(entry.anchors) } : {}) });
  return { rows, tree, other: rows.get(OTHER_KEY) };
}
