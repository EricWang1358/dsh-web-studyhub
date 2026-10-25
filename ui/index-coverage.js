/* Whether a material's search index is built: the state of one document from the coverage the backend reports (retrieval.index.coverage: the source ids
   that are indexed, stale (edited since) or missing, the missing ones that were indexed before the index was reset, whether the library has an index at
   all, whether the extension can build one, and a running build).
   Pure; the words are in IndexBadge.jsx. */

/**
 * The index state of a document ({ sourceIds }): { state: 'indexed' | 'partial' | 'stale' | 'missing' | 'reset' | 'building', indexed, stale, total }, or null
 * when there is nothing to say: coverage not loaded yet, an empty document, or a small note that simply has no index (normal: only big books need one;
 * a loud "not indexed" on every row of a library whose big book is indexed would be noise). `big` documents always say where they stand.
 */
export function documentIndexState(item, coverage, { big = false } = {}) {
  const ids = item?.sourceIds ?? [];
  if (!coverage || !ids.length) return null;
  const indexed = new Set(coverage.indexed), stale = new Set(coverage.stale), reset = new Set(coverage.reset || []);
  const counts = { indexed: ids.filter(id => indexed.has(id)).length, stale: ids.filter(id => stale.has(id)).length, total: ids.length };
  let state;
  if (counts.indexed === counts.total) state = 'indexed';
  else if (coverage.building) state = 'building';
  // Pages that were in the index before it was reset: the row must not look like it was never built, nor like it still is.
  else if (ids.some(id => reset.has(id))) state = 'reset';
  else if (counts.indexed + counts.stale === 0) state = 'missing';
  else if (counts.indexed + counts.stale === counts.total && counts.stale > 0) state = 'stale';
  else state = 'partial';
  if (state === 'missing' && !big && !coverage.building) return null;
  return { state, ...counts };
}
