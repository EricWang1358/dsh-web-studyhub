/* materials.annotation.*: the questions and answers a learner kept about a passage (the reader's 批注).

   Kept the way a translation is: per document REVISION, beside the document's own records, on the version of a stored document
   or, for a document with no record, on the first source of the document the 资料 page shows (`annotations: { revision, updatedAt,
   items }`, an optional field an older release leaves alone). A new revision never inherits them: the old ones are listed as stale
   (their passages and first questions are shown, they are not applied) and can be cleared. Nothing here writes a text, a source id,
   a page number, a selection, a citation or a card link; the pure rules (limits, nodes, threads) are lib/annotation.js.

   An item is one answered node, anchored to the passage it is about by source and stored offsets, and checked against the stored
   text: only a passage the document holds is ever kept. The question and the answer are untrusted data, kept as text. */
import { ANNOTATION_LIMITS, checkThread, normalizeNode, passageKey, sameNode, textHash, viewOf } from '../../annotation.js';
import { holderOf, unitOf } from './outline-operations.js';

const clone = value => structuredClone(value);
const iso = () => new Date().toISOString();
const text = value => typeof value === 'string' ? value : '';
const WHY = { stale: 'The document changed since this passage was selected; select it again.', ambiguous: 'The passage appears more than once; select a little more around it.',
  missing: 'The passage is not in this document.' };

export function createAnnotationHandlers({ read, update, findDocument, versionOf, empty, resolveSelection }) {
  const targetOf = (state, args) => {
    const document = findDocument(state, args), version = versionOf(document, document.legacy ? undefined : args.revision), unit = unitOf(state, document, version);
    if (document.legacy && args.revision && ![unit.revision, version.revision].includes(args.revision)) throw new Error('Material document revision not found');
    return { document, version, unit };
  };
  /** The document, revision and source a call is about: given outright, or the ones of its selection. */
  const identityOf = args => ({ ...args, documentId: args.documentId || args.selection?.documentId, revision: args.revision || args.selection?.revision, sourceId: args.sourceId || args.selection?.sourceId });
  const recordsOf = (state, unit) => unit.sourceIds.map(id => state.sources.find(source => source.id === id)).filter(Boolean);
  const currentOf = (state, unit) => { const kept = holderOf(state, unit)?.annotations; return kept?.revision === unit.revision ? kept : null; };
  /** What other revisions of the same document kept (stored documents keep one record per version). */
  const otherRecords = (state, document, unit) => {
    if (!document.legacy) return (state.documents.find(item => item.id === document.id)?.versions || [])
      .filter(version => version.revision !== unit.revision && version.annotations?.items?.length).map(version => ({ revision: version.revision, items: version.annotations.items, savedAt: version.annotations.updatedAt }));
    const held = holderOf(state, unit)?.annotations;
    return held && held.revision !== unit.revision && held.items?.length ? [{ revision: held.revision, items: held.items, savedAt: held.updatedAt }] : [];
  };
  const threadsOf = items => {
    const threads = new Map();
    for (const item of items) {
      const thread = threads.get(item.key) || threads.set(item.key, { key: item.key, quote: item.quote.slice(0, 200), question: '', nodes: 0 }).get(item.key);
      thread.nodes += 1;
      if (!item.parentId) thread.question = item.label || item.question;
    }
    return [...threads.values()];
  };
  const limits = { items: ANNOTATION_LIMITS.items, thread: ANNOTATION_LIMITS.thread, depth: ANNOTATION_LIMITS.depth };
  const clip = (value, size) => text(value).slice(0, size);

  /** A node kept as an item: where it is anchored (the resolved passage) and what was asked and answered. */
  const itemOf = (node, anchor, prior) => {
    const now = iso();
    return { id: node.id, key: anchor.key, sourceId: anchor.sourceId, start: anchor.start, end: anchor.end, hash: anchor.hash, quote: anchor.quote, prefix: anchor.prefix, suffix: anchor.suffix,
      ...(anchor.page ? { page: anchor.page } : {}), parentId: node.parentId, question: node.question, ...(node.term ? { term: node.term } : {}), ...(node.label ? { label: node.label } : {}),
      answer: node.answer, ...(node.language ? { language: node.language } : {}), at: prior?.at ?? now, updatedAt: now };
  };
  const recordFor = (state, unit) => {
    const holder = holderOf(state, unit);
    if (!holder) throw new Error('Material document revision not found');
    return holder.annotations?.revision === unit.revision ? holder.annotations : (holder.annotations = { revision: unit.revision, items: [] });
  };
  const fullMessage = () => `This document revision already keeps ${ANNOTATION_LIMITS.items} questions and answers. Delete some annotations to keep more.`;

  return {
    'materials.annotation.list': async args => {
      const state = empty(await read()), { document, unit } = targetOf(state, identityOf(args)), records = recordsOf(state, unit);
      const byId = new Map(records.map(record => [record.id, record.text])), order = new Map(records.map((record, index) => [record.id, index]));
      const wanted = args.selection && Number.isInteger(args.selection.start) && Number.isInteger(args.selection.end) && args.selection.sourceId ? passageKey(args.selection) : '';
      const kept = currentOf(state, unit)?.items || [];
      const items = kept.filter(item => !wanted || item.key === wanted)
        .sort((a, b) => (order.get(a.sourceId) ?? 0) - (order.get(b.sourceId) ?? 0) || a.start - b.start || a.end - b.end || String(a.at).localeCompare(String(b.at)))
        .map(item => { const source = byId.get(item.sourceId); return viewOf(item, source !== undefined && textHash(source.slice(item.start, item.end)) === item.hash); });
      const stale = otherRecords(state, document, unit).map(record => ({ revision: record.revision, count: record.items.length, savedAt: record.savedAt,
        threads: threadsOf(record.items).slice(0, ANNOTATION_LIMITS.stale) }));
      return { documentId: unit.id, revision: unit.revision, items, count: kept.length, stale, limits };
    },

    'materials.annotation.save': async args => {
      if (Array.isArray(args.restore)) {
        return update(state => {
          const own = empty(state), { unit } = targetOf(own, identityOf(args)), byId = new Map(recordsOf(own, unit).map(record => [record.id, record.text]));
          const record = recordFor(own, unit), added = [], groups = new Map();
          for (const raw of args.restore) {
            const source = byId.get(raw?.sourceId);
            if (source === undefined || !Number.isInteger(raw.start) || !Number.isInteger(raw.end) || textHash(source.slice(raw.start, raw.end)) !== raw.hash)
              throw new Error('A restored annotation does not match the text of this document');
            if (record.items.some(item => item.id === raw.id)) continue;
            const key = passageKey(raw), group = groups.get(key) || groups.set(key, { raws: new Map(), nodes: [] }).get(key);
            group.raws.set(raw.id, raw); group.nodes.push(normalizeNode(raw));
          }
          // A thread comes back whole: its answers are checked together, parents first.
          for (const [key, group] of groups) {
            const checked = checkThread(record.items.filter(item => item.key === key), group.nodes);
            if (!checked.ok) throw new Error('A restored annotation does not fit its thread');
            for (const node of checked.nodes) {
              const raw = group.raws.get(node.id);
              added.push(itemOf(node, { key, sourceId: raw.sourceId, start: raw.start, end: raw.end, hash: raw.hash, quote: clip(raw.quote, ANNOTATION_LIMITS.quote), prefix: clip(raw.prefix, ANNOTATION_LIMITS.context),
                suffix: clip(raw.suffix, ANNOTATION_LIMITS.context), page: raw.page }, raw));
            }
          }
          if (record.items.length + added.length > ANNOTATION_LIMITS.items) return { status: 'full', saved: 0, count: record.items.length, limit: ANNOTATION_LIMITS.items, message: fullMessage() };
          record.items.push(...added); if (added.length) record.updatedAt = iso();
          return { status: 'saved', saved: added.length, documentId: unit.id, revision: unit.revision };
        });
      }
      if (!Array.isArray(args.nodes) || !args.nodes.length) throw new Error('Nodes are required');
      if (args.nodes.length > ANNOTATION_LIMITS.thread) throw new Error(`Keep at most ${ANNOTATION_LIMITS.thread} nodes at a time`);
      if (!args.selection || typeof args.selection !== 'object') throw new Error('A selection is required');
      const nodes = args.nodes.map(normalizeNode);
      if (new Set(nodes.map(node => node.id)).size !== nodes.length) throw new Error('Annotation node ids must be different');
      return update(state => {
        const own = empty(state), { unit } = targetOf(own, identityOf(args)), resolved = resolveSelection(own, args.selection);
        if (resolved.status !== 'resolved') return { status: resolved.status, saved: 0, message: resolved.message || WHY[resolved.status] || WHY.missing };
        const selection = resolved.selection, source = own.sources.find(item => item.id === selection.sourceId);
        if (!source || !unit.sourceIds.includes(selection.sourceId) || (!unit.legacy && selection.revision !== unit.revision)) return { status: 'stale', saved: 0, message: WHY.stale };
        const key = passageKey(selection), anchor = { key, sourceId: selection.sourceId, start: selection.start, end: selection.end, hash: textHash(source.text.slice(selection.start, selection.end)),
          quote: clip(source.text.slice(selection.start, selection.end), ANNOTATION_LIMITS.quote), prefix: clip(selection.prefix, ANNOTATION_LIMITS.context), suffix: clip(selection.suffix, ANNOTATION_LIMITS.context), page: selection.page };
        const kept = currentOf(own, unit)?.items || [], mine = kept.filter(item => item.key === key);
        if (nodes.some(node => kept.some(item => item.id === node.id && item.key !== key))) throw new Error('This id is already kept for another passage');
        const checked = checkThread(mine, nodes);
        if (!checked.ok) return { status: checked.code, saved: 0, message: checked.message };
        const changes = checked.nodes.filter(node => { const old = mine.find(item => item.id === node.id); return !old || !sameNode(old, node); });
        const added = changes.filter(node => !mine.some(item => item.id === node.id)).length;
        if (kept.length + added > ANNOTATION_LIMITS.items) return { status: 'full', saved: 0, count: kept.length, limit: ANNOTATION_LIMITS.items, message: fullMessage() };
        if (changes.length) {
          const record = recordFor(own, unit);
          for (const node of changes) {
            const at = record.items.findIndex(item => item.id === node.id), item = itemOf(node, anchor, record.items[at]);
            if (at >= 0) record.items[at] = item; else record.items.push(item);
          }
          record.updatedAt = iso();
        }
        const items = (currentOf(own, unit)?.items || []).filter(item => item.key === key).map(item => viewOf(item, true));
        return { status: 'saved', saved: changes.length, unchanged: nodes.length - changes.length, documentId: unit.id, revision: unit.revision, key, items };
      });
    },

    'materials.annotation.delete': async args => {
      const ids = Array.isArray(args.ids) ? new Set(args.ids.filter(id => typeof id === 'string')) : null;
      const key = typeof args.key === 'string' && args.key ? args.key : args.selection && Number.isInteger(args.selection.start) && args.selection.sourceId ? passageKey(args.selection) : '';
      if (!ids && !key && args.all !== true && args.stale !== true) throw new Error('Name the annotations to delete, or pass all:true');
      return update(state => {
        const own = empty(state), { document, unit } = targetOf(own, identityOf(args));
        if (args.stale === true) {
          let deleted = 0;
          const holders = document.legacy ? [holderOf(own, unit)] : (own.documents.find(item => item.id === document.id)?.versions || []);
          for (const holder of holders) {
            if (holder?.annotations && holder.annotations.revision !== unit.revision) { deleted += holder.annotations.items?.length || 0; delete holder.annotations; }
          }
          return { deleted, removed: [], stale: true, documentId: unit.id, revision: unit.revision };
        }
        const record = currentOf(own, unit);
        if (!record) return { deleted: 0, removed: [], documentId: unit.id, revision: unit.revision };
        const doomed = new Set(record.items.filter(item => args.all === true || (key && item.key === key) || ids?.has(item.id)).map(item => item.id));
        // The answers asked inside a deleted answer go with it.
        for (let grew = true; grew;) { grew = false; for (const item of record.items) if (!doomed.has(item.id) && item.parentId && doomed.has(item.parentId)) { doomed.add(item.id); grew = true; } }
        const removed = record.items.filter(item => doomed.has(item.id)).map(item => clone(item));
        record.items = record.items.filter(item => !doomed.has(item.id));
        if (record.items.length) record.updatedAt = iso(); else delete holderOf(own, unit).annotations;
        return { deleted: removed.length, removed, documentId: unit.id, revision: unit.revision };
      });
    },
  };
}
