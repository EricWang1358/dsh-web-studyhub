import { useCallback, useEffect, useState } from 'react';
import { loadReaderSettings, normalizeReaderSettings, resetReaderSettings, saveReaderSettings } from './settings.js';

/** [settings, update(patch), reset()]: the reader's preferences, kept in the browser. */
export function useReaderSettings() {
  const [settings, setSettings] = useState(loadReaderSettings);
  useEffect(() => { saveReaderSettings(settings); }, [settings]);
  const update = useCallback(patch => setSettings(current => normalizeReaderSettings({ ...current, ...patch })), []);
  const reset = useCallback(() => setSettings(resetReaderSettings), []);
  return [settings, update, reset];
}
