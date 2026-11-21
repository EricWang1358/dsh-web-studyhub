/* Desk Soundscape & Atmosphere Atelier presets, channel metadata and lighting helpers.
   Pure data module with zero DOM or Web Audio dependencies so UI, engine and tests share one truth. */

export const ATELIER_CHANNELS = Object.freeze([
  Object.freeze({
    id: 'rain',
    label: '窗外细雨',
    hint: '粉红噪雨幕与轻柔窗檐雨滴',
  }),
  Object.freeze({
    id: 'vinyl',
    label: '黑胶书房',
    hint: '低噪温润模拟底噪与细微沙沙声',
  }),
  Object.freeze({
    id: 'hearth',
    label: '壁炉微火',
    hint: '低频暖意火床与稀疏木炭轻爆',
  }),
  Object.freeze({
    id: 'bamboo',
    label: '风动竹铃',
    hint: '微风穿林与 D 大调五声泛音轻叩',
  }),
  Object.freeze({
    id: 'hum',
    label: '深思粉噪',
    hint: '天鹅绒般柔和的低通专注噪声床',
  }),
]);

export const ATELIER_CHANNEL_IDS = Object.freeze(ATELIER_CHANNELS.map((channel) => channel.id));

export const ATELIER_PRESETS = Object.freeze([
  Object.freeze({
    id: 'rainy-desk',
    label: '雨夜书桌',
    hint: '细雨伴读，微火暖案',
    channels: Object.freeze({
      rain: 0.62,
      vinyl: 0.24,
      hearth: 0.18,
      bamboo: 0,
      hum: 0.22,
    }),
  }),
  Object.freeze({
    id: 'quiet-reading',
    label: '古籍阅览室',
    hint: '黑胶空气感与沉静粉噪',
    channels: Object.freeze({
      rain: 0.16,
      vinyl: 0.44,
      hearth: 0,
      bamboo: 0,
      hum: 0.46,
    }),
  }),
  Object.freeze({
    id: 'morning-bamboo',
    label: '清晨竹窗',
    hint: '清风竹铃，淡雨润晨光',
    channels: Object.freeze({
      rain: 0.14,
      vinyl: 0,
      hearth: 0,
      bamboo: 0.56,
      hum: 0.2,
    }),
  }),
  Object.freeze({
    id: 'winter-hearth',
    label: '壁炉冬夜',
    hint: '暖炉柴火与黑胶微韵',
    channels: Object.freeze({
      rain: 0.2,
      vinyl: 0.28,
      hearth: 0.64,
      bamboo: 0,
      hum: 0.18,
    }),
  }),
]);

export const ATMOSPHERE_MODES = Object.freeze([
  Object.freeze({ id: 'none', label: '无' }),
  Object.freeze({ id: 'lamp', label: '暖灯书案' }),
  Object.freeze({ id: 'rain-mist', label: '烟雨窗光' }),
  Object.freeze({ id: 'morning-paper', label: '晨光纸韵' }),
  Object.freeze({ id: 'solar', label: '随昼夜流转' }),
]);

export const ATMOSPHERE_MODE_IDS = Object.freeze(ATMOSPHERE_MODES.map((mode) => mode.id));

export const DEFAULT_PRESET_ID = 'rainy-desk';

export function clampLevel(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const clamped = Math.max(0, Math.min(1, num));
  return Math.round(clamped * 100) / 100;
}

export function getPresetById(id) {
  return ATELIER_PRESETS.find((preset) => preset.id === id) || null;
}

export function getChannelById(id) {
  return ATELIER_CHANNELS.find((channel) => channel.id === id) || null;
}

export function getAtmosphereById(id) {
  return ATMOSPHERE_MODES.find((mode) => mode.id === id) || ATMOSPHERE_MODES[0];
}

export function normalizeChannels(raw, fallback = ATELIER_PRESETS[0].channels) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const next = {};
  for (const id of ATELIER_CHANNEL_IDS) {
    const base = fallback && typeof fallback[id] === 'number' ? fallback[id] : 0;
    next[id] = clampLevel(input[id], base);
  }
  return next;
}

export function detectActivePreset(channels) {
  const normalized = normalizeChannels(channels);
  for (const preset of ATELIER_PRESETS) {
    const matches = ATELIER_CHANNEL_IDS.every((id) => Math.abs(normalized[id] - preset.channels[id]) < 0.015);
    if (matches) return preset.id;
  }
  return 'custom';
}

export function hasActiveChannel(channels) {
  if (!channels || typeof channels !== 'object') return false;
  return ATELIER_CHANNEL_IDS.some((id) => Number(channels[id]) > 0.005);
}

/** Resolve the active visual lighting mood for a mode and local hour (0-23). */
export function resolveAtmosphereLighting(mode, dateOrHour = new Date()) {
  if (mode === 'lamp' || mode === 'rain-mist' || mode === 'morning-paper') return mode;
  if (mode !== 'solar') return 'none';
  const hour = typeof dateOrHour === 'number' && Number.isFinite(dateOrHour)
    ? ((Math.floor(dateOrHour) % 24) + 24) % 24
    : (dateOrHour instanceof Date ? dateOrHour.getHours() : new Date().getHours());
  if (hour >= 6 && hour < 12) return 'morning-paper';
  if (hour >= 12 && hour < 18) return 'rain-mist';
  return 'lamp';
}
