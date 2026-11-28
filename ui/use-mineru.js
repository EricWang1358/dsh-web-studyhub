import { useContext, useEffect, useRef, useState } from 'react';
import { AppContext } from './app/app-context.js';
import { hasContext } from './capabilities.js';
import { useHostQuery, setQueryData, fetchQuery } from './host-query.js';
import { usePolling } from './use-polling.js';

/* MinerU state (local engine status + parsing mode / optional cloud endpoint & Key metadata), read through the shared host-query store:
   the PDF conversion form, the one-click card and the settings page show the same answer, and one of them changing it updates the others
   without a reload (ui-consistency #117). The install's own progress is polled only while an install runs (useMineruInstall). */
const LOCAL = 'mineru.local.status';
const SETTINGS = 'mineru.settings.get';
const LOCAL_FAILED = Object.freeze({ state: 'unavailable' });
const SETTINGS_FAILED = Object.freeze({
  mode: 'local',
  baseUrl: '',
  effectiveBaseUrl: 'https://mineru.net/api/v4',
  defaultBaseUrl: 'https://mineru.net/api/v4',
  token: Object.freeze({ set: false, hint: '', source: '' }),
  acknowledged: false,
  acknowledgedAt: '',
  unavailable: true,
});

/** Ask the local MinerU's state again (after an action) and give every reader the answer; `fresh` skips the backend's short reuse. */
export async function refreshMineruLocal(call, { fresh = false } = {}) {
  const next = await call(LOCAL, fresh ? { fresh: true } : {});
  setQueryData(LOCAL, {}, next);
  return next;
}
/** The local MinerU's state through the shared store (one request however many readers): what Settings' "needs setup" mark reads. */
export const loadMineruLocal = (call) => fetchQuery(call, LOCAL, {});
/** The MinerU settings (mode, baseUrl, masked Key hint, upload acknowledgement) through the shared store. */
export const loadMineruSettings = (call) => fetchQuery(call, SETTINGS, {});

/**
 * { local, settings, localFailed, settingsFailed, setLocal(next), setSettings(next) }.
 * Values are null until the host answered (or the initial value given for previews and tests), or the fallback when a read fails.
 */
export function useMineruState({ call, initialLocal = null, initialSettings = null, enabled = true, withSettings = true } = {}) {
  const app = useContext(AppContext);
  const active = enabled && hasContext(app?.data, 'audio');
  const localQuery = useHostQuery(LOCAL, {}, { call, initialData: initialLocal ?? undefined, enabled: active && !initialLocal });
  const settingsQuery = useHostQuery(SETTINGS, {}, { call, initialData: initialSettings ?? undefined, enabled: active && withSettings && !initialSettings });
  return {
    local: localQuery.data ?? (localQuery.error ? LOCAL_FAILED : null),
    settings: settingsQuery.data ?? (settingsQuery.error ? SETTINGS_FAILED : null),
    localFailed: localQuery.data === undefined && !!localQuery.error,
    settingsFailed: settingsQuery.data === undefined && !!settingsQuery.error,
    setLocal: (next) => setQueryData(LOCAL, {}, next),
    setSettings: (next) => setQueryData(SETTINGS, {}, next),
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
  useEffect(() => { if (fromStatus && (!install || fromStatus.status !== 'running' || install.status !== 'running')) setInstall(fromStatus); }, [fromStatus]); // eslint-disable-line react-hooks/exhaustive-deps
  usePolling(async () => {
    const next = await call('mineru.install.status', {});
    setInstall(next);
    if (next.status !== 'running') await ended.current?.(next);
    return { running: next.status === 'running' };
  }, { intervalMs: 1500, enabled: install?.status === 'running' && typeof call === 'function' });
  return { install, setInstall };
}
