import { useEffect, useRef, useState } from 'react';
import { useHostQuery, setQueryData, fetchQuery } from './host-query.js';
import { usePolling } from './use-polling.js';

/* The local MinerU's state, read through the shared host-query store: the PDF conversion form, the one-click card and the settings page show the
   same answer, and one of them changing it (an install, a start) updates the others without a reload (ui-consistency #117). A read that fails is
   said by the fallback below. The install's own progress is polled only while an install runs (useMineruInstall). */
const LOCAL = 'mineru.local.status';
const LOCAL_FAILED = Object.freeze({ state: 'unavailable' });

/** Ask the local MinerU's state again (after an action) and give every reader the answer; `fresh` skips the backend's short reuse. A failed ask throws, as the call does. */
export async function refreshMineruLocal(call, { fresh = false } = {}) {
  const next = await call(LOCAL, fresh ? { fresh: true } : {});
  setQueryData(LOCAL, {}, next);
  return next;
}
/** The local MinerU's state through the shared store (one request however many readers): what Settings' "needs setup" mark reads. */
export const loadMineruLocal = (call) => fetchQuery(call, LOCAL, {});

/**
 * { local, localFailed, setLocal(next) }. `local` is null until the host answered (or the initial value given for previews and tests), the fallback
 * when it could not. enabled: false reads nothing.
 */
export function useMineruState({ call, initialLocal = null, enabled = true } = {}) {
  const localQuery = useHostQuery(LOCAL, {}, { call, initialData: initialLocal ?? undefined, enabled: enabled && !initialLocal });
  return {
    local: localQuery.data ?? (localQuery.error ? LOCAL_FAILED : null),
    localFailed: localQuery.data === undefined && !!localQuery.error,
    setLocal: (next) => setQueryData(LOCAL, {}, next),
  };
}

/**
 * The install's progress while it runs: { install, setInstall }. `install` starts from what mineru.local.status carried (`fromStatus`) and is asked for
 * every 1.5 s while its status is 'running'; when it ends, `onEnded(install)` runs once (the card reads the state again and says how it ended).
 */
export function useMineruInstall(call, { fromStatus = null, onEnded } = {}) {
  const [install, setInstall] = useState(fromStatus);
  const ended = useRef(onEnded);
  useEffect(() => { ended.current = onEnded; });
  // A newer answer of the status (another reader, a refresh) is the install's latest state too.
  useEffect(() => { if (fromStatus && (!install || fromStatus.status !== 'running' || install.status !== 'running')) setInstall(fromStatus); }, [fromStatus]); // eslint-disable-line react-hooks/exhaustive-deps
  usePolling(async () => {
    const next = await call('mineru.install.status', {});
    setInstall(next);
    if (next.status !== 'running') await ended.current?.(next);
    return { running: next.status === 'running' };
  }, { intervalMs: 1500, enabled: install?.status === 'running' && typeof call === 'function' });
  return { install, setInstall };
}
