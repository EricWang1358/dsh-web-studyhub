/* The store behind ui/host-query.js: what the host reported, kept per `action + JSON(args)` for the whole page (ui-consistency #117).
   No React in here: components read it through useHostQuery, other code through fetchQuery / setQueryData / invalidate. */

const entries = new Map();
const keyOf = (action, args) => `${action} ${JSON.stringify(args ?? {})}`;
const IDLE = Object.freeze({ data: undefined, error: null, loading: false });

/** The entry of one query (created idle): { snapshot, subscribe, getSnapshot, ... }. The snapshot is replaced, never mutated, when it changes. */
export function entryFor(action, args) {
  const key = keyOf(action, args);
  let entry = entries.get(key);
  if (!entry) {
    entry = { key, action, args: args ?? {}, snapshot: IDLE, listeners: new Set(), promise: null, call: null, stale: true };
    entry.subscribe = (listener) => { entry.listeners.add(listener); return () => { entry.listeners.delete(listener); }; };
    entry.getSnapshot = () => entry.snapshot;
    entries.set(key, entry);
  }
  return entry;
}
function publish(entry, snapshot) {
  entry.snapshot = snapshot;
  for (const listener of [...entry.listeners]) listener();
}

/** Ask the host through `call` unless an answer is already on its way; resolves with the new data (or the last good data on failure). */
export function load(entry, call) {
  entry.call = call || entry.call;
  if (!entry.call) return Promise.resolve(entry.snapshot.data);
  if (entry.promise) return entry.promise;
  entry.stale = false;
  publish(entry, { ...entry.snapshot, error: null, loading: true });
  const run = entry.call;
  let started;
  try { started = Promise.resolve(run(entry.action, entry.args)); } catch (error) { started = Promise.reject(error); }
  entry.promise = started.then(
    (data) => { entry.promise = null; publish(entry, { data, error: null, loading: false }); return data; },
    (error) => { entry.promise = null; publish(entry, { data: entry.snapshot.data, error, loading: false }); return entry.snapshot.data; },
  );
  return entry.promise;
}

export function fetchQuery(call, action, args = {}) { return load(entryFor(action, args), call); }
/** Ask again after a write, even if a request that began before it is still in flight; resolves the fresh data. Every mounted reader is updated. */
export function refreshQuery(call, action, args = {}) {
  const entry = entryFor(action, args);
  entry.stale = true;
  const earlier = entry.promise;
  return earlier ? earlier.then(() => load(entry, call)) : load(entry, call);
}
export function peekQuery(action, args = {}) { return entries.get(keyOf(action, args))?.snapshot.data; }

export function invalidate(action, args) {
  for (const entry of entries.values()) {
    if (entry.action !== action || (args !== undefined && entry.key !== keyOf(action, args))) continue;
    entry.stale = true;
    // A request already in flight started before the write: ask again once it lands.
    if (entry.listeners.size) { const pending = entry.promise; if (pending) pending.then(() => load(entry)); else load(entry); }
  }
}
export function setQueryData(action, args, value) {
  const entry = entryFor(action, args ?? {});
  entry.stale = false;
  publish(entry, { data: value, error: null, loading: false });
}
export function resetHostQueries() { entries.clear(); }
/** Listen to one query without a component (tests, non-React code): the listener runs on every change; returns the unsubscribe. */
export function watchQuery(action, args, listener) { return entryFor(action, args ?? {}).subscribe(listener); }
