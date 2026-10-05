/* A kept outline as a document's chapters: the shared, pure side of the re-segmentation (materials.outline.*).

   A kept outline lives on its document revision (lib/contexts/materials/operations.js): on the version of a stored
   document, or, for a document with no record (an audio transcript, an early import, a pasted text), on the first source
   of the document the 资料 page shows. When the learner applies it as the document's chapters (a level, 1 to 3), every
   consumer reads them through the one accessor, groupSourcesByDocument (lib/source-groups.js). The accessor takes the
   chapters from a `segmentation` view stamped on the first source of the document; this module makes those views from
   the library state, for the snapshot the panel is drawn from. It only ever reads: no text, source id, page number,
   selection or card link is touched. */
import { createHash } from 'node:crypto';
import { groupSourcesByDocument } from './source-groups.js';
import { chaptersOfOutline } from './sections.js';

const sha = text => createHash('sha256').update(Buffer.from(String(text), 'utf8')).digest('hex');

/**
 * The revision of a group of sources shown as one document with no record of its own: the same value materials.document
 * gives a single source (the hash of its text) or a PDF's pages (the hash of [id, text] pairs, in reading order).
 */
export const groupRevision = members => members.length === 1 ? sha(members[0].text) : sha(JSON.stringify(members.map(source => [source.id, source.text])));

/* The chapters a kept outline defines at `level` (its entries down to that level, numbered in order, each with its place) are defined where the
   rest of a source's sections are, lib/sections.js (pure, so the reader's bundle shares it); this is the same function. */
export { chaptersOfOutline };

const viewOf = (documentId, outline, sourceIds) => {
  const chapters = chaptersOfOutline(outline, outline.segmentation.level);
  return chapters.length ? { documentId, revision: outline.revision, sourceIds: [...sourceIds], level: outline.segmentation.level, chapters, savedAt: outline.savedAt } : null;
};

/**
 * The segmentations in force in a library state: [{ documentId, revision, sourceIds, level, chapters, savedAt }].
 * Stored documents count at their current revision; a document with no record counts while the sources of its group still
 * make the revision the outline was kept for. Anything else (an older revision, a changed group) is stale and left out.
 */
export function segmentationViews(state) {
  const views = [];
  for (const document of Array.isArray(state?.documents) ? state.documents : []) {
    const version = document.versions?.find(item => item.revision === document.currentRevision), outline = version?.outline;
    if (!outline?.segmentation || outline.revision !== version.revision) continue;
    const view = viewOf(document.id, outline, version.sourceIds || []);
    if (view) views.push(view);
  }
  const sources = Array.isArray(state?.sources) ? state.sources : [], holders = sources.filter(source => source?.outline?.segmentation);
  if (holders.length) {
    const items = groupSourcesByDocument(sources), byId = new Map(sources.map(source => [source.id, source]));
    for (const holder of holders) {
      const item = items.find(group => group.sourceIds.includes(holder.id));
      if (!item || item.sourceIds[0] !== holder.id || groupRevision(item.sourceIds.map(id => byId.get(id))) !== holder.outline.revision) continue;
      const view = viewOf(item.documentId || `source-${holder.id}`, holder.outline, item.sourceIds);
      if (view) views.push(view);
    }
  }
  return views;
}

/**
 * `sources` with each view stamped on the first source of its document, which is where the accessor looks for it. The kept
 * outline a document with no record holds on its first source is left out (materials.document.get returns it); every
 * other record is the same object. The input is not changed.
 */
export function stampSegmentations(sources, views) {
  const stamps = new Map((views || []).map(view => [view.sourceIds[0], { revision: view.revision, sourceIds: view.sourceIds, level: view.level, chapters: view.chapters, savedAt: view.savedAt }]));
  if (!stamps.size && !sources.some(source => source?.outline !== undefined || source?.translations !== undefined)) return sources;
  return sources.map(source => {
    if (!stamps.has(source.id) && source?.outline === undefined && source?.translations === undefined) return source;
    const { outline: _outline, translations: _translations, ...rest } = source;
    return stamps.has(source.id) ? { ...rest, segmentation: stamps.get(source.id) } : rest;
  });
}
