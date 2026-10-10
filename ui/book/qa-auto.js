/* 自动加入复习全书 (M3): which new Q&A the practice page adds to the book by itself. Pure. Only in 'auto', only where the course has a book, only Q&A that
   arrive while the page is open (`fresh`: the ids just seen for the first time, never those already there when it opened), each one once (`tried`),
   and not one the book already holds (`added`). So switching the setting changes only the next Q&A. */
/**
 * The Q&A of one question seen so far (`state`: { key, ids } or null): the first time the question shows its answer (`ready`), what it has is old; a
 * Q&A that appears after that is new. `key` names the question on screen (a run's entry). -> { state, fresh }. Pure.
 */
export function seeFollowups(state, key, ids, ready) {
  if (!ready) return { state, fresh: [] };
  if (state?.key !== key) return { state: { key, ids: new Set(ids) }, fresh: [] };
  const fresh = ids.filter(id => !state.ids.has(id));
  return { state: fresh.length ? { key, ids: new Set([...state.ids, ...fresh]) } : state, fresh };
}

export function autoAddPlan({ mode, withBook, fresh = [], tried = new Set(), added = new Set() }) {
  if (mode !== 'auto' || !withBook) return [];
  return [...new Set(fresh)].filter(id => !tried.has(id) && !added.has(id));
}
