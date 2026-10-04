import { useEffect, useState, useSyncExternalStore } from 'react';
import { useStudy } from './study-context.jsx';
import { entryFor, load } from './host-query-store.js';

export { fetchQuery, refreshQuery, peekQuery, invalidate, setQueryData, resetHostQueries, watchQuery } from './host-query-store.js';

/* Reading the host once for everyone (ui-consistency #117). A status that several parts of the screen show (is the search extension
   installed? is MinerU configured?) used to be asked for by each of them, and a change made in one (an install) was seen by the
   others only after their own poll or a reload. Here the answer is kept per `action + JSON(args)` in one module-level store
   (ui/host-query-store.js):
     useHostQuery(action, args, { call, enabled, initialData })  -> { data, error, loading, refresh }
         the first reader fetches, the others share the answer (and the request in flight); a mounted reader revalidates once when it
         mounts; `call` defaults to the study services' (useStudy().call); `initialData` stands in until the first answer.
     invalidate(action, args?)    a write succeeded: every mounted reader of that action asks again, the others ask when they mount
     setQueryData(action, args, value)    a write returned the new state: every reader has it at once
     fetchQuery(call, action, args)       the same store for code that is not a component (returns the answer)
     resetHostQueries()           the library switched: nothing cached belongs to the new one
   A failed fetch keeps the last good data and reports `error`. */
export function useHostQuery(action, args = {}, { call: given, enabled = true, initialData } = {}) {
  const study = useStudy();
  const call = given || study.call;
  const entry = entryFor(action, args);
  if (typeof call === 'function') entry.call = call;
  // A value handed in (previews, tests) is this reader's starting point: it replaces what the store held, without telling the others.
  useState(() => { if (initialData !== undefined) { entry.snapshot = { data: initialData, error: null, loading: false }; entry.stale = false; } return null; });
  const snapshot = useSyncExternalStore(entry.subscribe, entry.getSnapshot, entry.getSnapshot);
  useEffect(() => {
    if (enabled) void load(entry);
  }, [entry, enabled]);
  return { ...snapshot, refresh: () => load(entry) };
}
