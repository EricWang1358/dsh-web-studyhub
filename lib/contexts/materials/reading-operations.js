/* materials.reading.*: which chapters of a material the learner has read through (已读, #1014).

   Kept in the study library, not in the browser, so another device or browser shows the same ✓: per document REVISION beside the document's own
   records, where the marks and the 批注 are (mark-operations.js): on the version of a stored document or, for a document with no record, on its first
   source (`reading: { revision, updatedAt, chapters: [{ id, title, startPage, endPage, at }] }`, an optional field an older release leaves alone and the
   document views strip). A revision with no record of its own reads the newest record of another revision; only the chapters that still match count
   (reading-model.js), and the first save in the new revision keeps exactly those and drops the other revisions' records. Within one revision a save
   keeps every entry, also those that do not match the caller's chapters (another window may show another chapter list; get filters, the limits
   bound the size). The reader writes on a change of chapter or when it closes, never while scrolling. The material is named like materials.document.get names it: by a source of it (or its document id) and the revision. */
import { READING_LIMITS, chapterRef, nextEntries, readChapterIds } from './reading-model.js';
import { holderOf, unitOf } from './outline-operations.js';

const iso = () => new Date().toISOString();

/** The chapters the reader shows now (the match is made against them), or null when the call does not say. */
const chaptersOf = value => (Array.isArray(value) ? value.slice(0, READING_LIMITS.chapters * 2).map(chapterRef).filter(Boolean) : null);
function listOf(value, name, parse) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be a list`);
  return value.map(parse).filter(Boolean);
}

export function createReadingHandlers({ read, update, findDocument, versionOf, empty }) {
  const targetOf = (state, args) => {
    const document = findDocument(state, { documentId: args.documentId, sourceId: args.sourceId });
    const version = versionOf(document, document.legacy ? undefined : args.revision), unit = unitOf(state, document, version);
    if (document.legacy && args.revision && ![unit.revision, version.revision].includes(args.revision)) throw new Error('Material document revision not found');
    return { document, unit };
  };
  /** The entries this revision reads: its own record, else the newest record another revision kept. */
  const entriesOf = (state, document, unit) => {
    const holder = holderOf(state, unit);
    if (holder?.reading?.revision === unit.revision) return holder.reading.chapters || [];
    const kept = document.legacy ? [holder?.reading] : (state.documents.find(item => item.id === document.id)?.versions || []).map(version => version.reading);
    const newest = kept.filter(record => record && record.revision !== unit.revision && Array.isArray(record.chapters))
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];
    return newest?.chapters || [];
  };
  const view = (unit, entries, chapters) => { const ids = readChapterIds(entries, chapters); return { documentId: unit.id, revision: unit.revision, read: ids, count: ids.length }; };

  return {
    'materials.reading.get': async args => {
      const state = empty(await read()), { document, unit } = targetOf(state, args);
      return view(unit, entriesOf(state, document, unit), chaptersOf(args.chapters));
    },

    /** Mark chapters read (`read`: chapters as the reader names them) or unread (`unread`: their ids). Moving to a new revision, kept entries that no
     *  longer match `chapters` go; within a revision nothing else is pruned. */
    'materials.reading.save': async args => {
      const chapters = chaptersOf(args.chapters);
      const readList = listOf(args.read, 'read', chapterRef), unread = listOf(args.unread, 'unread', id => (typeof id === 'string' && id ? id : null));
      return update(state => {
        const own = empty(state), { document, unit } = targetOf(own, args), holder = holderOf(own, unit);
        if (!holder) throw new Error('Material document revision not found');
        const moving = holder.reading?.revision !== unit.revision;
        const at = iso(), entries = nextEntries(entriesOf(own, document, unit), { chapters: moving ? chapters : null, read: readList, unread, now: at });
        if (moving && !document.legacy) {
          for (const version of own.documents.find(item => item.id === document.id)?.versions || []) if (version !== holder) delete version.reading;
        }
        holder.reading = { revision: unit.revision, updatedAt: at, chapters: entries };
        return { ...view(unit, entries, chapters), saved: true };
      });
    },
  };
}
