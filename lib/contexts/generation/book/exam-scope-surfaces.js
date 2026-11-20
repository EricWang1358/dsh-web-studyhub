import { currentInventory, nameForms } from '../../../course-book-inventory.js';
import { currentCourseOutline } from '../../../course-outline-book.js';
import { chapterKey, courseDocuments, parseSpan } from '../../../course-outline-index.js';
import { documentIndex, outlineLeaves } from '../../../course-book-inputs.js';
import { compactKey, meaningfulTokens, normLower, normSpace, titleChapterNum } from './exam-scope-text.js';

const CHAPTER_TEXT_CAP = 16_000;

/** Collect markdown headings and a bounded excerpt from a list of sourceIds. */
function readSourcesSurface(bySourceId, sourceIds) {
  const ids = [...new Set((sourceIds || []).filter(id => bySourceId.has(id)))];
  if (!ids.length) return { headings: [], text: '' };
  const headings = [], chunks = [];
  const perSource = Math.max(400, Math.floor(CHAPTER_TEXT_CAP / Math.max(1, ids.length)));
  let total = 0;
  for (const id of ids) {
    const raw = bySourceId.get(id)?.text;
    if (typeof raw !== 'string' || !raw) continue;
    for (const match of raw.matchAll(/^#{1,6}\s+(.+)$/gm)) {
      const heading = normSpace(match[1]);
      if (heading) headings.push(heading);
    }
    if (total < CHAPTER_TEXT_CAP) {
      const take = raw.slice(0, Math.min(perSource, CHAPTER_TEXT_CAP - total));
      chunks.push(take);
      total += take.length;
    }
  }
  return { headings, text: chunks.join('\n') };
}

function buildOutlineSurfaces(state, course, skeleton, { bySourceId, invById, candidates, docsByKey }) {
  const outline = currentCourseOutline(state.sources, course)?.courseOutline ?? null;
  const topById = new Map((outline?.nodes || []).map(node => [node.id, node]));
  const docIdx = documentIndex(candidates);
  return (skeleton.outline?.chapters || []).map((chapter, at) => {
    const top = topById.get(chapter.id);
    const leaves = top ? outlineLeaves([top]) : [];
    const headingTexts = [chapter.title, ...leaves.map(({ node, path }) => [node.title, ...path].join(' ')).filter(Boolean)];
    const invTerms = [], invGists = [], sourceIds = new Set();
    for (const { node } of leaves) {
      for (const itemId of node.items || []) {
        const item = invById.get(itemId);
        if (!item) continue;
        invTerms.push(item.name, ...nameForms(item.name));
        if (item.gist) invGists.push(item.gist);
        for (const place of item.places || []) if (place.sourceId) sourceIds.add(place.sourceId);
      }
      for (const anchor of node.anchors || []) {
        const found = docIdx.get(anchor);
        if (found) {
          for (const id of (found.chapter?.sourceIds?.length ? found.chapter.sourceIds : found.item.sourceIds) || []) sourceIds.add(id);
        } else {
          const span = parseSpan(anchor), doc = span ? docsByKey.get(span.doc) : null;
          if (doc) {
            for (const id of (span.unit === 's' ? doc.sourceIds.slice(span.from, span.to + 1) : doc.sourceIds) || []) sourceIds.add(id);
          }
        }
      }
    }
    const surface = readSourcesSurface(bySourceId, [...sourceIds]);
    const allHeadings = [...headingTexts, ...surface.headings];
    return {
      id: chapter.id, title: chapter.title, points: chapter.points, order: at,
      chapterNum: titleChapterNum(chapter.title), fallbackNum: at + 1,
      headingLower: normLower(allHeadings.join(' \n ')), headingCompact: compactKey(allHeadings.join(' ')),
      invLower: normLower([...invTerms, ...invGists].join(' \n ')), invCompact: compactKey(invTerms.join(' ')),
      contentLower: normLower(surface.text), tokenBag: new Set(meaningfulTokens([...allHeadings, ...invTerms].join(' '))),
    };
  });
}

/** Build searchable chapter surfaces in skeleton reading order (0-token). */
export function buildChapterSurfaces(state, course, skeleton, guidanceIdSet = new Set()) {
  const bySourceId = new Map((Array.isArray(state.sources) ? state.sources : []).map(source => [source.id, source]));
  const inventory = currentInventory(state.sources, course)?.courseInventory ?? null;
  const invById = new Map((inventory?.items || []).map(item => [item.id, item]));
  const { candidates } = courseDocuments(state, course);
  const docsByKey = new Map(candidates.map(doc => [doc.key, doc]));

  if (skeleton.basis === 'outline') {
    return buildOutlineSurfaces(state, course, skeleton, { bySourceId, invById, candidates, docsByKey });
  }

  // Basis: 'documents' (exclude sample papers, copies, and pure exam-guidance docs so syllabus notes never self-match).
  const taughtDocs = skeleton.documents.filter(doc => {
    if (doc.paper || doc.copyOf) return false;
    const fullDoc = docsByKey.get(doc.key);
    if (guidanceIdSet.size && fullDoc?.sourceIds?.length && fullDoc.sourceIds.every(id => guidanceIdSet.has(id))) return false;
    return true;
  });
  const singleMainDoc = taughtDocs.filter(doc => doc.chapters.length > 1).length === 1;
  const surfaces = [];
  for (const skDoc of taughtDocs) {
    const fullDoc = docsByKey.get(skDoc.key);
    const fullChapters = (fullDoc?.chapters || []).filter(ch => !ch.front);
    const byChapterId = new Map(fullChapters.map(ch => [chapterKey(skDoc.key, ch.index), ch]));
    const docInvItems = (inventory?.items || []).filter(item => (item.places || []).some(place => place.doc === skDoc.key));
    const docOutlineEntries = Array.isArray(fullDoc?.outline?.entries) ? fullDoc.outline.entries : [];

    for (let at = 0; at < skDoc.chapters.length; at++) {
      const ch = skDoc.chapters[at], fullCh = byChapterId.get(ch.id) ?? null;
      const sourceIds = fullCh?.sourceIds?.length ? fullCh.sourceIds : (fullDoc?.sourceIds || []);
      const sourceIdSet = new Set(sourceIds);
      const [fromPage, toPage] = Array.isArray(ch.pages) ? ch.pages : [1, skDoc.pages || 1];
      const subheadings = docOutlineEntries
        .filter(entry => entry?.title && (!sourceIdSet.size || !entry.anchor?.sourceId || sourceIdSet.has(entry.anchor.sourceId)))
        .map(entry => entry.title);
      const invTerms = [], invGists = [];
      for (const item of docInvItems) {
        const hits = (item.places || []).some(place => place.doc === skDoc.key && (
          (place.sourceId && sourceIdSet.has(place.sourceId))
          || (Number.isInteger(place.page) && place.page >= fromPage && place.page <= toPage)
        ));
        if (!hits) continue;
        invTerms.push(item.name, ...nameForms(item.name));
        if (item.gist) invGists.push(item.gist);
      }
      const surface = readSourcesSurface(bySourceId, sourceIds);
      const allHeadings = [...(fullCh ? [ch.title] : [ch.title, skDoc.title]), ...subheadings, ...surface.headings];
      surfaces.push({
        id: ch.id, title: ch.title, doc: skDoc.key, pages: ch.pages, chars: ch.chars, order: surfaces.length,
        chapterNum: titleChapterNum(ch.title), fallbackNum: singleMainDoc && skDoc.chapters.length > 1 ? at + 1 : null,
        headingLower: normLower(allHeadings.join(' \n ')), headingCompact: compactKey(allHeadings.join(' ')),
        invLower: normLower([...invTerms, ...invGists].join(' \n ')), invCompact: compactKey(invTerms.join(' ')),
        contentLower: normLower(surface.text), tokenBag: new Set(meaningfulTokens([...allHeadings, ...invTerms].join(' '))),
      });
    }
  }
  return surfaces;
}
