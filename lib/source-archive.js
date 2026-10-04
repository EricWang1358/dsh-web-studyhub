import { groupSourcesByDocument } from './source-groups.js';

/** Expand a page selection to whole documents, including retained revisions. */
export function archiveSources(state, args) {
  if (typeof args.archived !== 'boolean') throw new Error('archived must be true or false');
  const requested = args.sourceIds || [args.id];
  if (!Array.isArray(requested) || !requested.length || requested.some(id => typeof id !== 'string' || !state.sources.some(source => source.id === id)))
    throw new Error('Select existing sources to archive or restore');
  const ids = new Set(requested);
  for (const group of groupSourcesByDocument(state.sources, { documents: state.documents }))
    if (group.sourceIds.some(id => ids.has(id))) for (const id of group.sourceIds) ids.add(id);
  for (const document of state.documents || []) {
    const members = document.versions.flatMap(version => version.sourceIds);
    if (!members.some(id => ids.has(id))) continue;
    for (const id of members) ids.add(id);
    document.archived = args.archived;
  }
  for (const source of state.sources) if (ids.has(source.id)) source.archived = args.archived;
  return { sourceIds: [...ids], archived: args.archived };
}
