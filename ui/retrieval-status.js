import { useHostQuery } from './host-query.js';
import { fetchQuery, refreshQuery, invalidate, setQueryData } from './host-query-store.js';

/* What the host reports about search (retrieval.status: the chosen provider, whether the extension is installed and running, the
   endpoint) is read through the shared host-query store: every part of the screen that shows it reads the same answer, and an
   install, removal or setting change updates all of them (ui-consistency #117). */
const ACTION = 'retrieval.status';

/** { data, error, loading, refresh } of retrieval.status; `data` is undefined until the host answered (or `initialData`). */
export const useRetrievalStatus = (options) => useHostQuery(ACTION, {}, options);
/** Ask now (through the shared store, so a request in flight is joined); resolves the status, or the last good one on failure. */
export const loadRetrievalStatus = (call) => fetchQuery(call, ACTION, {});
/** After a write (install, removal, a setting): ask again, joining no request that began before it; resolves the fresh status. Every mounted reader gets it. */
export const refreshRetrievalStatus = (call) => refreshQuery(call, ACTION, {});
/** A write returned the new status: every reader has it at once. */
export const setRetrievalStatus = (value) => { if (value) setQueryData(ACTION, {}, value); };
/** Something changed that the status reflects (install, uninstall, a setting): every mounted reader asks again. */
export const invalidateRetrievalStatus = () => invalidate(ACTION);
