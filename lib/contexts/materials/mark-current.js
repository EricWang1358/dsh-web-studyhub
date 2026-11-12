/* The marks of the library that still stand: for every document, the marks kept for its CURRENT revision whose words are still where they were.
   Read by 今日 「重读 N 段」 (lib/contexts/library/mark-reread.js, through contracts.js), which also needs the review state and so lives in the
   library context. The holder and revision rules are the ones materials.marks.* keep marks by (outline-operations.js unitOf / holderOf). Pure. */
import { textHash } from './mark-model.js';
import { holderOf, unitOf } from './outline-operations.js';
import { groupSourcesByDocument } from '../../source-groups.js';

const sourcesOf = state => (Array.isArray(state?.sources) ? state.sources : []);
const hasMarks = holder => Array.isArray(holder?.marks?.items) && holder.marks.items.length > 0;

/**
 * [{ documentId, revision, legacy, sourceIds, items }] for each document that keeps marks for its current revision; `items` are the stored marks
 * whose words still hash the same (a stale one is never listed). A library with no marks anywhere returns [] without grouping anything.
 * `groupsOf`: the library's documents (groupSourcesByDocument) when the caller has them; asked once, and only when there are marks.
 */
export function currentMarks(state, { groupsOf = () => groupSourcesByDocument(sourcesOf(state)) } = {}) {
  const sources = sourcesOf(state), documents = Array.isArray(state?.documents) ? state.documents : [];
  const stored = documents.filter(document => document.versions?.some(hasMarks)), loose = sources.filter(hasMarks);
  if (!stored.length && !loose.length) return [];
  const own = { sources, documents }, units = [], groups = groupsOf();
  for (const document of stored) {
    const version = document.versions.find(item => item.revision === document.currentRevision);
    if (hasMarks(version)) units.push(unitOf(own, { id: document.id, legacy: false }, version, groups));
  }
  // A document with no record keeps its marks on its first source.
  const recorded = new Set(documents.flatMap(document => (document.versions || []).flatMap(version => version.sourceIds || [])));
  for (const source of loose) if (!recorded.has(source.id)) {
    const unit = unitOf(own, { id: '', legacy: true }, { sourceIds: [source.id] }, groups);
    if (unit.sourceIds[0] === source.id) units.push(unit);
  }
  const text = new Map(sources.map(source => [source.id, source.text]));
  const result = [];
  for (const unit of units) {
    const kept = holderOf(own, unit)?.marks;
    if (kept?.revision !== unit.revision) continue;
    const items = kept.items.filter(item => unit.sourceIds.includes(item.sourceId) && typeof text.get(item.sourceId) === 'string'
      && textHash(text.get(item.sourceId).slice(item.start, item.end)) === item.hash);
    if (items.length) result.push({ documentId: unit.id, revision: unit.revision, legacy: unit.legacy, sourceIds: unit.sourceIds, items });
  }
  return result;
}
