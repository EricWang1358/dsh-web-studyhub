/* The chapters the reader shows one at a time (owner decision 2026-11-06: a 513-page book drawn whole blocked the page for 9 s).
   A paged document (PDF pages, slides) reads by the chapters the rest of the app already uses: groupSourcesByDocument's `chapters`
   (lib/source-groups.js; a converted book's stamped chapters, or the learner's applied outline), the very list 「查看 N 章」 opens on the
   资料 row. Without them a long document reads in blocks of CHAPTER_BLOCK_PAGES pages. A text (Markdown, TXT, a transcript) and a
   document of one chapter are shown whole: the result is then []. Pure, no DOM. */

/** Pages in a block when a document has no chapters of its own. */
export const CHAPTER_BLOCK_PAGES = 20;

/** A chapter of `members` (sections in reading order): where it lies and what it holds. */
const chapterOf = (members, id) => ({ id, index: 0, title: '', front: false, block: false, startPage: Math.min(...members.map(section => section.page)),
  endPage: Math.max(...members.map(section => section.page)), sectionIds: members.map(section => section.id), sourceIds: members.map(section => section.sourceId) });

/** The document's own chapters over the reader's sections: a page belongs to the chapter that names its source, else to the one before it. */
function ownChapters(sections, chapters) {
  const kept = chapters.filter(chapter => chapter.sourceIds?.length).map(chapter => ({ chapter, sources: new Set(chapter.sourceIds), members: [] }));
  let last = null;
  for (const section of sections) {
    const home = kept.find(entry => entry.sources.has(section.sourceId)) || last || kept[0];
    if (!home) continue;
    home.members.push(section);
    last = home;
  }
  return kept.filter(entry => entry.members.length).map(({ chapter, members }) => ({ ...chapterOf(members, chapter.front ? 'chapter-front' : `chapter-${chapter.index}`),
    index: chapter.index, title: String(chapter.title ?? ''), front: !!chapter.front }));
}

function blocks(sections, size) {
  const out = [];
  for (let at = 0; at < sections.length; at += size) out.push({ ...chapterOf(sections.slice(at, at + size), `block-${out.length}`), index: out.length, block: true });
  return out;
}

/**
 * The reader's chapters: [{ id, index, title, front, block, startPage, endPage, sectionIds, sourceIds }] in reading order, every page section in exactly
 * one; [] when the document is shown whole. `sections` are text-sections.js readingSections (id, page, sourceId); `chapters` groupSourcesByDocument's.
 */
export function readerChapters({ paged = false, sections = [], chapters = [], blockPages = CHAPTER_BLOCK_PAGES } = {}) {
  if (!paged || sections.length < 2) return [];
  const own = Array.isArray(chapters) && chapters.length ? ownChapters(sections, chapters) : [];
  if (own.length > 1) return own;
  return sections.length > blockPages ? blocks(sections, blockPages) : [];
}

/** The index of the chapter that holds a section id, else a source id, else a page; -1 when none does. */
export function chapterAt(chapters, { sectionId, sourceId, page } = {}) {
  if (!chapters?.length) return -1;
  const at = sectionId != null ? chapters.findIndex(chapter => chapter.sectionIds.includes(sectionId)) : -1;
  if (at >= 0) return at;
  const of = sourceId != null ? chapters.findIndex(chapter => chapter.sourceIds.includes(sourceId)) : -1;
  if (of >= 0) return of;
  return Number.isInteger(page) ? chapters.findIndex(chapter => page >= chapter.startPage && page <= chapter.endPage) : -1;
}

/** The 目录 of a chaptered document: each chapter an entry (kind 'chapter', level 1) with its pages one level below it (kind 'page'). */
export function chapterOutline(chapters, entries) {
  const byId = new Map(entries.map(entry => [entry.id, entry])), out = [];
  for (const chapter of chapters) {
    out.push({ id: chapter.id, level: 1, kind: 'chapter', title: chapter.title, chapter: { front: chapter.front, block: chapter.block, startPage: chapter.startPage, endPage: chapter.endPage } });
    for (const id of chapter.sectionIds) {
      const entry = byId.get(id);
      if (entry) out.push({ ...entry, level: (entry.level || 1) + 1, kind: 'page' });
    }
  }
  return out;
}

/** The chapters before and after the one at `index`. */
export const adjacentChapters = (chapters, index) => ({ previous: index > 0 ? chapters[index - 1] : null, next: index >= 0 && index + 1 < chapters.length ? chapters[index + 1] : null });

/**
 * The entries of a kept AI outline (materials.outline.*) when one chapter is drawn: the ones placed in it (ai-outline.js applyOutline: `placed`), and, in the
 * outline's order, those whose anchor is a source of the document (`known`) that is not drawn (`drawn`): `elsewhere`, with the `sourceId` to open. An entry of the
 * drawn chapter that could not be placed is left out, as before.
 */
export function withElsewhere(entries, placed, { drawn, known }) {
  const byId = new Map(placed.map(item => [item.id, item]));
  return (entries || []).map((entry, index) => {
    const id = `ai-${index}`, sourceId = entry.anchor?.sourceId;
    // Every entry keeps the page it is on, so the questions of a chapter not drawn are placed under the entries by page (practice-range.js sourcePlacer).
    if (byId.has(id)) return sourceId ? { ...byId.get(id), sourceId } : byId.get(id);
    return sourceId && known.has(sourceId) && !drawn.has(sourceId) ? { id, level: entry.level, title: entry.title, kind: entry.kind, sourceId, elsewhere: true } : null;
  }).filter(Boolean);
}

/** What find reads in each chapter (find.js textHits): `textOf(section)` of its pages, in order, keyed by the chapter's id. Keep the result while the text is the same: it is folded once. */
export function chapterFindGroups(chapters, sections, textOf) {
  const byId = new Map(sections.map(section => [section.id, section]));
  return chapters.map(chapter => ({ key: chapter.id, parts: chapter.sectionIds.map(id => byId.get(id)).filter(Boolean)
    .map(section => ({ page: section.page, sourceId: section.sourceId, text: textOf(section) })) }));
}

/**
 * Where Enter (delta 1) or Shift+Enter (-1) goes in find: the next match of the chapter shown (`total` matches, at `match`), else the next chapter (by
 * index, among `hits`, the chapters with a match) at its first match, or the one before at its last, round the book; within the chapter when no other has
 * one. -> { match } | { chapter, landing: 'first' | 'last' } | null.
 */
export function findStop({ hits, current, total, match, delta }) {
  if (total && match + delta >= 0 && match + delta < total) return { match: match + delta };
  const others = hits.filter(at => at !== current);
  if (!others.length) return total ? { match: (match + delta + total) % total } : null;
  const chapter = delta > 0 ? others.find(at => at > current) ?? others[0] : others.findLast(at => at < current) ?? others[others.length - 1];
  return { chapter, landing: delta > 0 ? 'first' : 'last' };
}
