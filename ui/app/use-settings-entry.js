import { useCallback, useState } from 'react';

/* The ways into Settings: the page itself, one of its sections (the search extension, the model, the daily recap) and the
   course panel that opens over any page. */
export function useSettingsEntry({ nav, host }) {
  // A Settings section another page points at; Settings opens its group and scrolls to it.
  const [settingsFocus, setSettingsFocus] = useState('');
  // The open course panel: a course id, or { id, mergeFrom } when 合并到这里 opens the merge confirmation.
  const [courseSettings, setCourseSettings] = useState(null);
  // The legacy-import text Settings keeps while another page is showing.
  const [legacy, setLegacy] = useState('');
  const { navigate } = nav;
  const openSettings = useCallback((section) => { setSettingsFocus(section || ''); navigate('settings'); }, [navigate]);
  // DSH's own model settings when the host offers them, else Study Settings.
  const openModelSettings = useCallback(() => (host.openModelSettings ? host.openModelSettings() : openSettings('settings-model')), [host, openSettings]);
  return { settingsFocus, setSettingsFocus, courseSettings, setCourseSettings, legacy, setLegacy, openSettings, openModelSettings };
}
