/* materials.reading.*: which chapters of a material the learner has read through (已读, #1014).

   Kept in the study library, not in the browser, so another device or browser shows the same ✓: per document REVISION beside the document's own
   records, where the marks and the 批注 are (mark-operations.js): on the version of a stored document or, for a document with no record, on its first
   source (`reading: { revision, updatedAt, chapters: [{ id, title, startPage, endPage, at }] }`, an optional field an older release leaves alone and the
   document views strip). A revision with no record of its own reads the newest record of another revision; only the chapters that still match count
   (reading-model.js), and the first save in the new revision keeps exactly those. A save writes only its own revision's record: another revision's
   record is never changed by it (a citation can open an older revision, an old window can stay open), and at most READING_LIMITS.revisions records
   are kept, the oldest writes going first but never the current revision's. Within one revision a save keeps every entry, also those that do not
   match the caller's chapters (another window may show another chapter list; get filters, the limits bound the size). The reader writes on a change
   of chapter or when it closes, never while scrolling. The material is named like materials.document.get names it: by a source of it (or its document id) and the revision. */
import { READING_LIMITS, chapterRef, nextEntries, readChapterIds } from './reading-model.js';
import { holderOf, unitOf } from './outline-operations.js';

const iso = () => new Date().toISOString();

/** The chapters the reader shows now (the match is made against them), or null when the call does not say. */
const chaptersOf = value => (Array.isArray(value) ? value.slice(0, READING_LIMITS.chapters * 2).map(chapterRef).filter(Boolean) : null);
/** A chapter of `unread`: as the reader shows it (an id alone could take back another chapter of that id). */
const unreadRef = value => { if (!value || typeof value !== 'object') throw new Error('unread must list chapters'); return chapterRef(value); };

/** Keeps at most READING_LIMITS.revisions revision records of a stored document: the current revision's, the one just written, then the newest. */
function boundRecords(stored, written) {
  const records = (stored?.versions || []).filter(version => version.reading);
  if (records.length <= READING_LIMITS.revisions) return;
  const fixed = new Set([stored.currentRevision, written]);
  const others = records.filter(version => !fixed.has(version.revision)).sort((a, b) => String(b.reading.updatedAt || '').localeCompare(String(a.reading.updatedAt || '')));
  const room = READING_LIMITS.revisions - records.filter(version => fixed.has(version.revision)).length;
  for (const version of others.slice(Math.max(0, room))) delete version.reading;
}
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

    /** Mark chapters read or unread (`read`, `unread`: chapters as the reader names them). The first save in a revision keeps only the entries of
     *  the record it starts from that match `chapters`; within a revision nothing else is pruned. Writes this revision's record only. */
    'materials.reading.save': async args => {
      const chapters = chaptersOf(args.chapters);
      const readList = listOf(args.read, 'read', chapterRef), unread = listOf(args.unread, 'unread', unreadRef);
      return update(state => {
        const own = empty(state), { document, unit } = targetOf(own, args), holder = holderOf(own, unit);
        if (!holder) throw new Error('Material document revision not found');
        const moving = holder.reading?.revision !== unit.revision;
        const at = iso(), entries = nextEntries(entriesOf(own, document, unit), { chapters: moving ? chapters : null, read: readList, unread, now: at });
        holder.reading = { revision: unit.revision, updatedAt: at, chapters: entries };
        if (!document.legacy) boundRecords(own.documents.find(item => item.id === document.id), unit.revision);
        return { ...view(unit, entries, chapters), saved: true };
      });
    },
  };
}
