import { createHash } from 'node:crypto';
import { chapterKey } from './course-outline-index.js';
import { displayTitle } from './document-title.js';
import { isLibraryListSource } from './exam-point-list.js';

/* 复习全书: what a knowledge point is explained FROM, and when an explanation is still current. Pure, no I/O; shared by the build
   (lib/contexts/generation/book) and the page's read (lib/course-book-view.js), so both agree on what "changed" means.

   A leaf of the outline holds anchors: a document key, or a chapter key of a document (lib/course-outline-index.js). Its texts are the passages those stand for:
   a document's sources whole; a chapter's pages, cut where the learner's chapters start inside a page (the reader's rule, lib/contexts/materials/translation-operations.js).
   Copies with the same text are one passage. The body's fingerprint is these passages (which source, where, what text) and the language; 考情's fingerprint is the
   leaf's paper places (and the papers' own fingerprints) and the language. Questions are no input of either. */

const sha = value => createHash('sha1').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const short = value => sha(value).slice(0, 16);

/** The course's documents (buildOutlineIndex's allDocuments) by key, and each chapter key with its document and chapter. */
export function documentIndex(documents) {
  const byKey = new Map();
  for (const item of Array.isArray(documents) ? documents : []) {
    byKey.set(item.key, { item });
    (item.chapters || []).forEach((chapter, at) => byKey.set(chapterKey(item.key, chapter.index), { item, chapter, next: item.chapters[at + 1] }));
  }
  return byKey;
}

/** The ranges of the sources a row stands for: a document's sources whole; a chapter's pages, from where it starts to where the next chapter starts. */
function rangesOf(found) {
  const ranges = new Map();
  if (!found.chapter) { for (const id of found.item.sourceIds) ranges.set(id, [0, Infinity]); return ranges; }
  const { chapter, next } = found;
  const clip = (id, from, to) => { const old = ranges.get(id) || [0, Infinity]; ranges.set(id, [Math.max(old[0], from), Math.min(old[1], to)]); };
  for (const id of chapter.sourceIds || []) clip(id, 0, Infinity);
  if (chapter.startSourceId) clip(chapter.startSourceId, chapter.startOffset || 0, Infinity);
  if (next?.startSourceId && ranges.has(next.startSourceId)) clip(next.startSourceId, 0, next.startOffset || 0);
  return ranges;
}

/**
 * The passages of a leaf, in the order of its anchors: [{ sourceId, start, end, text, material }]. A source that is gone, empty or one of the library's own lists
 * gives nothing; a passage whose text another passage of the leaf already has (a copy) is left out.
 */
export function leafSegments(byId, docs, anchors) {
  const segments = [], seen = new Set();
  for (const anchor of Array.isArray(anchors) ? anchors : []) {
    const found = docs.get(anchor);
    if (!found) continue;
    const ranges = rangesOf(found), ordered = found.item.sourceIds.filter(id => ranges.has(id));
    for (const id of ordered) {
      const source = byId.get(id);
      if (!source || isLibraryListSource(source) || typeof source.text !== 'string') continue;
      const [from, to] = ranges.get(id), start = Math.max(0, from), end = Math.min(source.text.length, to), text = source.text.slice(start, end);
      if (!text.trim()) continue;
      const key = sha(text.trim());
      if (seen.has(key)) continue;
      seen.add(key);
      segments.push({ sourceId: id, start, end, text, material: displayTitle(found.item.title) });
    }
  }
  return segments;
}

/** The fingerprint of a leaf's explanation: its passages and the language. */
export const bodyFingerprint = (language, segments) => short(['body', language === 'en' ? 'en' : 'zh', segments.map(item => [item.sourceId, item.start, item.end, sha(item.text)])]);

/** The fingerprint of a leaf's 考情: the paper places the outline marks on it (with the fingerprints of those papers) and the language. */
export function examFingerprint(language, node, papers) {
  const known = new Map((papers || []).map(paper => [paper.key, paper.fingerprint ?? '']));
  const places = (node?.exam?.evidence || []).map(place => [place.paper, known.get(place.paper) ?? '', place.sourceId, place.quote]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return short(['exam', language === 'en' ? 'en' : 'zh', places]);
}

/** The leaves of an outline in reading order, with the titles above each one. */
export function outlineLeaves(nodes) {
  const leaves = [];
  const walk = (node, path) => (node.children ? node.children.forEach(child => walk(child, [...path, node.title])) : leaves.push({ node, path }));
  (nodes || []).forEach(node => walk(node, []));
  return leaves;
}

const norm = title => String(title ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
/**
 * The earlier explanation a leaf continues (after an outline rebuild its node ids are new): the leaf of the same id, else the one whose anchors overlap most
 * (at least half of the larger set; the same title breaks a tie), else the one of the same title when only one has it. null when none.
 */
export function previousLeaf(previous, node) {
  const leaves = Array.isArray(previous) ? previous : [];
  const same = leaves.find(leaf => leaf.id === node.id);
  if (same) return same;
  const mine = new Set(node.anchors || []);
  let best = null, score = 0;
  for (const leaf of leaves) {
    const shared = (leaf.anchors || []).filter(anchor => mine.has(anchor)).length, size = Math.max(mine.size, (leaf.anchors || []).length);
    const value = size ? shared / size + (norm(leaf.title) === norm(node.title) ? 0.01 : 0) : 0;
    if (value >= 0.5 && value > score) { best = leaf; score = value; }
  }
  if (best) return best;
  const titled = leaves.filter(leaf => norm(leaf.title) === norm(node.title));
  return titled.length === 1 ? titled[0] : null;
}

/**
 * Is a course's 复习全书 current? Compared with the outline as it is and the library's texts: `stale` when it explains another outline, when a leaf has no
 * explanation or one made from texts that changed, or when a leaf's 考情 rests on other paper places. `missing` counts the leaves without an explanation.
 */
export function notesStatus(state, documents, outlineRecord, notesRecord) {
  const outline = outlineRecord.courseOutline, notes = notesRecord.courseNotes, language = notes.language;
  const byId = new Map((state.sources || []).map(source => [source.id, source])), docs = documentIndex(documents);
  const saved = new Map(notes.leaves.map(leaf => [leaf.id, leaf])), papers = outline.papers || [];
  let missing = 0, changed = 0;
  for (const { node } of outlineLeaves(outline.nodes)) {
    const leaf = saved.get(node.id);
    if (!leaf?.body) { missing++; continue; }
    if (leaf.body.fingerprint !== bodyFingerprint(language, leafSegments(byId, docs, node.anchors))) changed++;
    else if (papers.length ? leaf.exam?.fingerprint !== examFingerprint(language, node, papers) : !!leaf.exam) changed++;
  }
  return { stale: notes.outlineId !== outlineRecord.id || missing > 0 || changed > 0, missing, changed };
}
