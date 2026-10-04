import { useEffect, useRef, useState } from 'react';
import { uiMessage } from './i18n.js';

/* The busy / error / unmounted bookkeeping every action button used to write by hand.
   `run(kind, fn)` marks `kind` as working while `fn` runs, keeps one run per kind in flight, turns a failure into a
   readable message (uiMessage) and never reports to a component that has gone away. */

const messageOf = (failure) => uiMessage(String(failure?.message || failure || ''));

/** The state machine behind useAsyncAction: no React, so it runs (and is tested) on its own. */
export function createAsyncRunner({ onChange = () => {}, toMessage = messageOf, exclusive = false } = {}) {
  const inflight = new Map();
  let error = '', attached = true;
  const latest = () => [...inflight.keys()].pop() ?? null;
  const state = () => ({ working: latest(), error });
  const emit = () => { if (attached) onChange(state()); };
  return {
    state,
    run(kind, fn) {
      if (inflight.has(kind)) return inflight.get(kind);
      if (exclusive && inflight.size) return [...inflight.values()][0];
      let settled = false;
      error = '';
      const promise = (async () => {
        try { return await fn(); }
        catch (failure) { error = toMessage(failure); }
        finally { settled = true; inflight.delete(kind); emit(); }
        return undefined;
      })();
      // A function that throws before its first await has already settled above.
      if (!settled) { inflight.set(kind, promise); emit(); }
      return promise;
    },
    clearError() { if (error) { error = ''; emit(); } },
    /** The owner unmounted: settled runs no longer report. */
    detach() { attached = false; },
    attach() { attached = true; },
  };
}

/**
 * `{ run(kind, fn), working, error, clearError }`: `working` is the kind that is running, or null. `exclusive: true` also
 * turns away a run of another kind while one is in flight (a form whose buttons must not overlap).
 */
export function useAsyncAction({ exclusive = false } = {}) {
  const [view, setView] = useState({ working: null, error: '' });
  const runner = useRef(null);
  if (!runner.current) runner.current = createAsyncRunner({ onChange: setView, exclusive });
  useEffect(() => {
    runner.current.attach();
    return () => runner.current.detach();
  }, []);
  const { run, clearError } = runner.current; // closures, not methods: their identity is stable for the life of the component
  return { run, working: view.working, error: view.error, clearError };
}
