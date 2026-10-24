/* The book's own titles and its structure version (#470, lib/course-book-structure.js), the part a rebuilt outline needs (lib/course-book-files.js
   openCourseBook). Pure, no imports.

   `doc.ownTitles`: { [hid]: { title, outline } } the title the learner gave a chapter or a point of the book (`title`) and the outline's title it
   replaces (`outline`); the outline itself is never changed. `doc.structureVersion` (1 when absent): moved by every change of the book's tree. */

/** The book's structure version: 1 for a book that never had one. */
export const structureVersionOf = doc => (Number.isInteger(doc?.structureVersion) && doc.structureVersion > 0 ? doc.structureVersion : 1);

/** The manifest as the outline titled it (the learner's titles back to the outline's), so a rebuilt outline is matched against the outline's own words. */
export function outlineTitled(manifest, ownTitles) {
  const own = ownTitles || {};
  if (!Object.keys(own).length) return manifest;
  const walk = list => (list || []).map(node => ({ ...node, ...(own[node.hid] ? { title: own[node.hid].outline } : {}), children: walk(node.children) }));
  return { ...manifest, nodes: walk(manifest?.nodes) };
}

/** After a rebuild (`remapped` from remapManifest): a node that kept its id keeps the learner's title (its `movedFrom`, the outline's old title, is
    not said: the learner named it), the titles of ids gone are forgotten, and the structure version moves. Mutates `doc`; -> `remapped`. */
export function keepOwnTitles(doc, remapped) {
  const own = doc.ownTitles || {}, kept = {};
  const walk = list => (list || []).forEach(node => {
    const mine = own[node.hid];
    if (mine && mine.title !== node.title) {
      kept[node.hid] = { title: mine.title, outline: node.title };
      node.title = mine.title;
      delete node.movedFrom;
    }
    walk(node.children);
  });
  walk(remapped.nodes);
  doc.ownTitles = kept;
  doc.structureVersion = structureVersionOf(doc) + 1;
  return remapped;
}
