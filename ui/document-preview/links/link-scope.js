/* 本章 / 全书 of the reader's linked questions (#1014): the passages of the chapter on screen, or of the whole material, in the order they come in
   the text. Pure: `groups` are buildLinkModel's, `order` maps a source id to its place in reading order (the reader's sections), `sourceIds` the sources
   of the chapter drawn (null: no chapters, the whole material is on screen). */

/** The passages in reading order: by their source's place, then where they start in it, then their number. */
export function inReadingOrder(groups, order) {
  const at = group => order?.get(group.selection?.sourceId) ?? Number.MAX_SAFE_INTEGER;
  const start = group => (Number.isFinite(group.selection?.start) ? group.selection.start : Number.MAX_SAFE_INTEGER);
  return [...groups].sort((a, b) => at(a) - at(b) || start(a) - start(b) || a.number - b.number);
}

/** The passages of the chapter (all of them without chapters), in reading order. */
export function chapterGroups(groups, { sourceIds = null, order = null } = {}) {
  const kept = sourceIds ? groups.filter(group => sourceIds.has(group.selection?.sourceId)) : groups;
  return inReadingOrder(kept, order);
}
