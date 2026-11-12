/* materials.marks.*: the learner's own marks on a material (下划线 / 加粗 / 荧光笔) and the passages put aside for one question run (待出题).

   Kept the way the 批注 are (annotation-operations.js): per document REVISION beside the document's own records, on the version of a stored
   document or, for a document with no record, on its first source (`marks: { revision, updatedAt, items }`, an optional field an older release
   leaves alone). A new revision never inherits them: the old ones are counted as stale and can be cleared. The passage of a mark is resolved and
   checked against the stored text by the same resolver the 批注 use, so only a passage the document holds is ever kept. Nothing here writes a
   text, a source id, a selection, a citation or a card link; the pure rules are lib/reader-marks.js. */
import { MARK_LIMITS, markId, markStyle, markView, passageKey, readingOrder, textHash } from './mark-model.js';
import { holderOf, unitOf } from './outline-operations.js';

const iso = () => new Date().toISOString();
const text = value => (typeof value === 'string' ? value : '');
const clip = (value, size) => text(value).slice(0, size);
const WHY = { stale: 'The document changed since this passage was selected; select it again.', ambiguous: 'The passage appears more than once; select a little more around it.',
  missing: 'The passage is not in this document.' };

export function createMarkHandlers({ read, update, findDocument, versionOf, empty, resolveSelection }) {
  const targetOf = (state, args) => {
    const document = findDocument(state, args), version = versionOf(document, document.legacy ? undefined : args.revision), unit = unitOf(state, document, version);
    if (document.legacy && args.revision && ![unit.revision, version.revision].includes(args.revision)) throw new Error('Material document revision not found');
    return { document, version, unit };
  };
  const identityOf = args => ({ ...args, documentId: args.documentId || args.selection?.documentId, revision: args.revision || args.selection?.revision, sourceId: args.sourceId || args.selection?.sourceId });
  const recordsOf = (state, unit) => unit.sourceIds.map(id => state.sources.find(source => source.id === id)).filter(Boolean);
  const currentOf = (state, unit) => { const kept = holderOf(state, unit)?.marks; return kept?.revision === unit.revision ? kept : null; };
  const recordFor = (state, unit) => {
    const holder = holderOf(state, unit);
    if (!holder) throw new Error('Material document revision not found');
    return holder.marks?.revision === unit.revision ? holder.marks : (holder.marks = { revision: unit.revision, items: [] });
  };
  /** What other revisions of the same document kept, counted. */
  const staleOf = (state, document, unit) => {
    if (!document.legacy) return (state.documents.find(item => item.id === document.id)?.versions || [])
      .filter(version => version.revision !== unit.revision && version.marks?.items?.length).map(version => ({ revision: version.revision, count: version.marks.items.length, savedAt: version.marks.updatedAt }));
    const held = holderOf(state, unit)?.marks;
    return held && held.revision !== unit.revision && held.items?.length ? [{ revision: held.revision, count: held.items.length, savedAt: held.updatedAt }] : [];
  };
  const limits = { items: MARK_LIMITS.items, queue: MARK_LIMITS.queue };

  return {
    'materials.marks.list': async args => {
      const state = empty(await read()), { document, unit } = targetOf(state, identityOf(args)), records = recordsOf(state, unit);
      const byId = new Map(records.map(record => [record.id, record.text])), order = new Map(records.map((record, index) => [record.id, index]));
      const items = readingOrder(currentOf(state, unit)?.items || [], order)
        .map(item => { const source = byId.get(item.sourceId); return markView(item, source !== undefined && textHash(source.slice(item.start, item.end)) === item.hash); });
      return { documentId: unit.id, revision: unit.revision, items, count: items.length, queued: items.filter(item => item.style === 'queue').length,
        stale: staleOf(state, document, unit).slice(0, MARK_LIMITS.stale), limits };
    },

    /** Mark a passage in one style. The same passage and style again changes nothing (`status: 'unchanged'`). */
    'materials.marks.save': async args => {
      const style = markStyle(args.style);
      if (!args.selection || typeof args.selection !== 'object') throw new Error('A selection is required');
      return update(state => {
        const own = empty(state), { unit } = targetOf(own, identityOf(args)), resolved = resolveSelection(own, args.selection);
        if (resolved.status !== 'resolved') return { status: resolved.status, saved: 0, message: resolved.message || WHY[resolved.status] || WHY.missing };
        const selection = resolved.selection, source = own.sources.find(item => item.id === selection.sourceId);
        if (!source || !unit.sourceIds.includes(selection.sourceId) || (!unit.legacy && selection.revision !== unit.revision)) return { status: 'stale', saved: 0, message: WHY.stale };
        const key = passageKey(selection), id = markId(key, style), kept = currentOf(own, unit)?.items || [];
        const existing = kept.find(item => item.id === id);
        if (existing) return { status: 'unchanged', saved: 0, documentId: unit.id, revision: unit.revision, item: markView(existing, true) };
        if (kept.length >= MARK_LIMITS.items) return { status: 'full', saved: 0, limit: MARK_LIMITS.items, message: `This document revision already keeps ${MARK_LIMITS.items} marks. Remove some to add more.` };
        if (style === 'queue' && kept.filter(item => item.style === 'queue').length >= MARK_LIMITS.queue)
          return { status: 'queue-full', saved: 0, limit: MARK_LIMITS.queue, message: `At most ${MARK_LIMITS.queue} passages wait for questions at a time. Start the questions or remove some first.` };
        const item = { id, key, style, sourceId: selection.sourceId, start: selection.start, end: selection.end, hash: textHash(source.text.slice(selection.start, selection.end)),
          quote: clip(source.text.slice(selection.start, selection.end), MARK_LIMITS.quote), prefix: clip(selection.prefix, MARK_LIMITS.context), suffix: clip(selection.suffix, MARK_LIMITS.context),
          ...(selection.page ? { page: selection.page } : {}), at: iso() };
        const record = recordFor(own, unit);
        record.items.push(item); record.updatedAt = item.at;
        return { status: 'saved', saved: 1, documentId: unit.id, revision: unit.revision, item: markView(item, true) };
      });
    },

    /** 已重读 (今日 「重读 N 段」): the time the learner re-read a mark, kept on the mark. Only this click writes it; opening the reader does not. */
    'materials.marks.seen': async args => {
      if (typeof args.id !== 'string' || !args.id) throw new Error('id is required');
      return update(state => {
        const own = empty(state), { unit } = targetOf(own, identityOf(args)), item = currentOf(own, unit)?.items.find(entry => entry.id === args.id);
        if (!item) return { status: 'missing', documentId: unit.id, revision: unit.revision };
        item.rereadAt = iso();
        return { status: 'saved', documentId: unit.id, revision: unit.revision, item: markView(item, true) };
      });
    },

    /** Remove marks: by id, every style of a passage (key or selection, narrowed by `style`), every mark of a style (`style` alone, e.g. the whole 待出题 list), all, or what older revisions kept (stale). */
    'materials.marks.delete': async args => {
      const ids = Array.isArray(args.ids) ? new Set(args.ids.filter(id => typeof id === 'string')) : null;
      const key = typeof args.key === 'string' && args.key ? args.key : args.selection && Number.isInteger(args.selection.start) && args.selection.sourceId ? passageKey(args.selection) : '';
      const style = args.style === undefined ? '' : markStyle(args.style);
      if (!ids && !key && !style && args.all !== true && args.stale !== true) throw new Error('Name the marks to delete, or pass all:true');
      return update(state => {
        const own = empty(state), { document, unit } = targetOf(own, identityOf(args));
        if (args.stale === true) {
          let deleted = 0;
          const holders = document.legacy ? [holderOf(own, unit)] : (own.documents.find(item => item.id === document.id)?.versions || []);
          for (const holder of holders) if (holder?.marks && holder.marks.revision !== unit.revision) { deleted += holder.marks.items?.length || 0; delete holder.marks; }
          return { deleted, removed: [], stale: true, documentId: unit.id, revision: unit.revision };
        }
        const record = currentOf(own, unit);
        if (!record) return { deleted: 0, removed: [], documentId: unit.id, revision: unit.revision };
        const doomed = item => args.all === true || ids?.has(item.id) || (key ? item.key === key && (!style || item.style === style) : !ids && style && item.style === style);
        const removed = record.items.filter(doomed).map(item => markView(item, true));
        record.items = record.items.filter(item => !doomed(item));
        if (record.items.length) record.updatedAt = iso(); else delete holderOf(own, unit).marks;
        return { deleted: removed.length, removed, documentId: unit.id, revision: unit.revision };
      });
    },
  };
}
