import { useState } from 'react';
import { useStudy } from '../study-context.jsx';
import { useLiveEffect } from '../use-async.js';

/* The last answer of `coverage.get` for each (request, library version): a page that is opened again, or the same draft on the home card and the draft page, shows it at once
   instead of a blank while the answer is asked for again. Bounded; a tiny memo, not a store. */
const remembered = new Map(), LIMIT = 60;
const keyOf = (args, version) => JSON.stringify([args || null, version]);
const remember = (key, view) => { remembered.delete(key); remembered.set(key, view); if (remembered.size > LIMIT) remembered.delete(remembered.keys().next().value); };

/** Put an answer in the memo (what a test, or a page that already has the answer, hands in). */
export const seedCoverage = (args, version, view) => remember(keyOf(args, version), view);
export const forgetCoverage = () => remembered.clear();

/**
 * The coverage of a draft (`{ draftId }`) or of a document (`{ documentId }` / `{ sourceId }`) from the `coverage.get` action: { status: 'loading' | 'ready' | 'missing' | 'error', view }.
 * `version` changes when the library does (the snapshot's revision, a draft's version), which asks again; the last answer stays on screen until the next one arrives, so
 * a number never blinks away. Nothing is asked while `enabled` is false or there is nothing to ask for. A page that is rendered outside the app (a static test) stays 'loading'.
 */
export function useCoverage(args, { version = '', enabled = true } = {}) {
  const { call } = useStudy();
  const key = keyOf(args, version);
  const [state, setState] = useState(() => (remembered.has(key) ? { status: 'ready', view: remembered.get(key) } : { status: 'loading', view: null }));
  useLiveEffect((live) => {
    if (!enabled || !args || typeof call !== 'function') return;
    Promise.resolve().then(() => call('coverage.get', args)).then(
      (view) => {
        const ok = view?.status === 'ok';
        if (ok) remember(key, view);
        if (live()) setState({ status: ok ? 'ready' : 'missing', view: ok ? view : null });
      },
      () => { if (live()) setState((before) => ({ status: 'error', view: before.view })); },
    );
  }, [key, enabled, call]);
  return state;
}
