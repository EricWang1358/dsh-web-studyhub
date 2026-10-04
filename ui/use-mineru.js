import { useHostQuery, setQueryData, fetchQuery } from './host-query.js';

/* The MinerU settings (token set? acknowledged?) and the local converter's state, read through the shared host-query store: the PDF
   conversion form and the settings page show the same answer, and one of them changing it (saving a token, installing the local
   model) updates the other without a reload (ui-consistency #117). A read that fails is said by the fallbacks below, as before. */
const SETTINGS = 'mineru.settings.get', LOCAL = 'mineru.local.status';
const SETTINGS_FAILED = Object.freeze({ token: { set: false }, acknowledged: false, unavailable: true });
const LOCAL_FAILED = Object.freeze({ state: 'unavailable' });

/** Ask the local converter's state again (after a setup step) and give every reader the answer; a failed ask throws, as the call does. */
export async function refreshMineruLocal(call) {
  const next = await call(LOCAL, {});
  setQueryData(LOCAL, {}, next);
  return next;
}
/** Ask for the MinerU settings through the shared store (one request however many readers). */
export const loadMineruSettings = (call) => fetchQuery(call, SETTINGS, {});

/**
 * { settings, local, settingsFailed, localFailed, setSettings(next), setLocal(next) }. `settings` / `local` are null until the host answered (or the
 * initial value given for previews and tests), the fallback when it could not. enabled: false reads nothing.
 */
export function useMineruState({ call, initialSettings = null, initialLocal = null, enabled = true } = {}) {
  const settingsQuery = useHostQuery(SETTINGS, {}, { call, initialData: initialSettings ?? undefined, enabled: enabled && !initialSettings });
  const localQuery = useHostQuery(LOCAL, {}, { call, initialData: initialLocal ?? undefined, enabled: enabled && !initialLocal });
  return {
    settings: settingsQuery.data ?? (settingsQuery.error ? SETTINGS_FAILED : null),
    local: localQuery.data ?? (localQuery.error ? LOCAL_FAILED : null),
    settingsFailed: settingsQuery.data === undefined && !!settingsQuery.error,
    localFailed: localQuery.data === undefined && !!localQuery.error,
    setSettings: (next) => setQueryData(SETTINGS, {}, next),
    setLocal: (next) => setQueryData(LOCAL, {}, next),
  };
}
