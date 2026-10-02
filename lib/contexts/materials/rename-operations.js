import { groupSourcesByDocument } from '../../source-groups.js';
import { checkTitle, titleMessage, pushLimited, retitleSources } from '../../document-title.js';

/* materials.document.rename: change what a document is CALLED, and nothing else (lib/document-title.js says which titles
   follow). Text, ids, revisions, selections, citations and card links are never written; a card cites a source by id and
   quote and its title is looked up when it is shown. A document with no record of its own (a legacy import, a recording of
   several files, a pasted text) gets one with exactly the identity it already had, as materials.original.attach does. The
   caller wires `read`, `update` and `locate` (document + revision + its sources). Idempotent: naming a document what it is
   called already writes nothing. */

const RENAME = 'materials.document.rename';

export function createRenameOperations({ read, update, locate }) {
  /** What a request would do to this state: read-only; the same plan is applied inside the library transaction. */
  function plan(state, args) {
    const found = locate(state, { ...(args.documentId !== undefined ? { documentId: args.documentId } : {}), ...(args.id !== undefined ? { id: args.id } : {}),
      ...(args.sourceId !== undefined ? { sourceId: args.sourceId } : {}) });
    if (args.revision !== undefined && args.revision !== found.document.currentRevision)
      throw new Error('Material document revision is stale; reload the document and try again');
    const record = state.documents?.find(item => item.id === found.document.id) || null;
    const first = found.sources[0] || state.sources.find(source => found.version.sourceIds.includes(source.id));
    const group = first ? groupSourcesByDocument(state.sources).find(item => item.sourceIds.includes(first.id)) : null;
    const memberIds = new Set([...(group?.sourceIds || []), ...(record || found.document).versions.flatMap(version => version.sourceIds || [])]);
    const from = group?.title ?? (record || found.document).title ?? '';
    const original = group?.renamedFrom ?? null;
    if (args.expectedTitle !== undefined && args.expectedTitle !== from)
      throw new Error(`The document title has changed since it was read (expected "${args.expectedTitle}", it is "${from}"); reload and try again`);
    const history = Array.isArray(record?.titleHistory) ? record.titleHistory : [];
    let to;
    if (args.restore === true) to = original;
    else if (args.undo === true) to = history.at(-1) ?? null;
    else {
      const checked = checkTitle(args.title);
      if (!checked.ok) throw new Error(titleMessage(checked.code));
      to = checked.title;
    }
    const base = { documentId: found.document.id, revision: found.document.currentRevision, previousTitle: from, originalTitle: original };
    if (to === null || to === undefined || to === from) return { unchanged: { status: 'unchanged', ...base, title: from, ...(to === null || to === undefined ? { reason: 'nothing-to-restore' } : {}) } };
    return { found, memberIds, from, to, base, undo: args.undo === true };
  }

  return {
    [RENAME]: async args => {
      const early = plan(await read(), args);
      if (early.unchanged) return early.unchanged;
      let outcome;
      await update(state => {
        state.documents ||= [];
        const work = plan(state, args);
        if (work.unchanged) { outcome = work.unchanged; return; }
        let record = state.documents.find(item => item.id === work.found.document.id);
        if (!record) record = state.documents[state.documents.push(structuredClone(work.found.document)) - 1];
        const members = state.sources.filter(source => work.memberIds.has(source.id));
        const { changed, original } = retitleSources(members, { from: work.from, to: work.to, filename: members.find(source => source.document?.filename)?.document.filename });
        record.title = work.to;
        const history = work.undo ? (record.titleHistory || []).slice(0, -1) : pushLimited(record.titleHistory, work.from);
        if (history.length) record.titleHistory = history; else delete record.titleHistory;
        outcome = { status: 'renamed', ...work.base, title: work.to, originalTitle: original === work.to ? null : original, titleHistory: [...history], changedSources: changed.length };
      });
      return outcome;
    },
  };
}
