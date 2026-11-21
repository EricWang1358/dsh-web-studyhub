/* Independent persistence & reactive store for Desk Soundscape & Atmosphere Atelier.
   Stored solely under `study-desk-atelier` (never touches `study-interface`).
   Audio playback ALWAYS defaults to OFF on boot so zero AudioContext is created until the learner opts in. */
import { useSyncExternalStore } from 'react';
import { browserStorage, readJSON, writeJSON } from '../storage.js';
import {
  ATELIER_PRESETS,
  ATMOSPHERE_MODE_IDS,
  DEFAULT_PRESET_ID,
  clampLevel,
  detectActivePreset,
  getPresetById,
  hasActiveChannel,
  normalizeChannels,
} from './atelier-presets.js';

export const DESK_ATELIER_KEY = 'study-desk-atelier';

export const DESK_ATELIER_DEFAULTS = Object.freeze({
  preset: DEFAULT_PRESET_ID,
  master: 0.58,
  channels: ATELIER_PRESETS[0].channels,
  atmosphere: 'none',
});

export function normalizeAtelierPrefs(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const fallbackPreset = getPresetById(input.preset) || ATELIER_PRESETS[0];
  const channels = input.channels && typeof input.channels === 'object'
    ? normalizeChannels(input.channels, fallbackPreset.channels)
    : { ...fallbackPreset.channels };
  const detected = detectActivePreset(channels);
  const preset = detected === 'custom' ? 'custom' : detected;
  const atmosphere = ATMOSPHERE_MODE_IDS.includes(input.atmosphere) ? input.atmosphere : 'none';
  const master = clampLevel(input.master, DESK_ATELIER_DEFAULTS.master);
  return {
    preset,
    master,
    channels,
    atmosphere,
  };
}

export function loadAtelierPrefs(storage = browserStorage()) {
  return normalizeAtelierPrefs(readJSON(DESK_ATELIER_KEY, null, storage));
}

export function saveAtelierPrefs(prefs, storage = browserStorage()) {
  const normalized = normalizeAtelierPrefs(prefs);
  writeJSON(DESK_ATELIER_KEY, normalized, storage);
  return normalized;
}

/** Shared runtime store binding persisted prefs + ephemeral session playback state (`playing`, `captureMuted`). */
export function createAtelierStore({ storage } = {}) {
  const resolveStorage = () => storage ?? browserStorage();
  let prefs = null;
  let playing = false;
  let captureMuted = false;
  let snapshot = null;
  const listeners = new Set();

  const buildSnapshot = () => {
    const base = prefs ?? (prefs = loadAtelierPrefs(resolveStorage()));
    return {
      ...base,
      channels: { ...base.channels },
      playing,
      captureMuted,
    };
  };

  const get = () => (snapshot ?? (snapshot = buildSnapshot()));

  const emit = () => {
    snapshot = buildSnapshot();
    for (const listener of listeners) {
      try { listener(snapshot); } catch { /* ignore listener errors */ }
    }
  };

  const updatePrefs = (updater) => {
    const current = prefs ?? (prefs = loadAtelierPrefs(resolveStorage()));
    const rawNext = typeof updater === 'function' ? updater(current) : { ...current, ...updater };
    prefs = saveAtelierPrefs(rawNext, resolveStorage());
    emit();
    return get();
  };

  return {
    get,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setPlaying(nextPlaying) {
      const flag = Boolean(nextPlaying);
      if (flag === playing) return get();
      playing = flag;
      if (!flag) captureMuted = false;
      emit();
      return get();
    },
    setCaptureMuted(nextMuted) {
      const flag = Boolean(nextMuted);
      if (flag === captureMuted) return get();
      captureMuted = flag;
      emit();
      return get();
    },
    setMaster(master) {
      return updatePrefs((current) => ({ ...current, master: clampLevel(master, current.master) }));
    },
    setChannel(channelId, level) {
      return updatePrefs((current) => {
        const channels = { ...current.channels, [channelId]: clampLevel(level, 0) };
        return {
          ...current,
          channels,
          preset: detectActivePreset(channels),
        };
      });
    },
    applyPreset(presetId) {
      const preset = getPresetById(presetId);
      if (!preset) return get();
      return updatePrefs((current) => ({
        ...current,
        preset: preset.id,
        channels: { ...preset.channels },
      }));
    },
    setAtmosphere(mode) {
      if (!ATMOSPHERE_MODE_IDS.includes(mode)) return get();
      return updatePrefs((current) => ({ ...current, atmosphere: mode }));
    },
    ensureAudibleMix() {
      const current = get();
      if (hasActiveChannel(current.channels)) return current;
      const preset = getPresetById(current.preset) || ATELIER_PRESETS[0];
      return updatePrefs((prev) => ({
        ...prev,
        preset: preset.id,
        channels: { ...preset.channels },
      }));
    },
    resetMix() {
      return updatePrefs((current) => ({
        ...current,
        preset: DESK_ATELIER_DEFAULTS.preset,
        master: DESK_ATELIER_DEFAULTS.master,
        channels: { ...DESK_ATELIER_DEFAULTS.channels },
      }));
    },
    resetAllForTests() {
      prefs = null;
      playing = false;
      captureMuted = false;
      snapshot = null;
      emit();
    },
  };
}

export const sharedAtelierStore = createAtelierStore();

export function useAtelierState(store = sharedAtelierStore) {
  return useSyncExternalStore(
    store.subscribe,
    store.get,
    store.get,
  );
}
