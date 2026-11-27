/* The appearance of this browser (设置 › 界面): theme, interface size, typeface and motion, in one pure module that the app, the empty
   page before a session is open, the settings page and the tests all share.

   Storage is the two keys earlier versions already wrote, so nobody loses a choice and an older version can still read what a newer
   one saved: the theme alone in `study-theme` (a plain string), everything else as one small JSON object in `study-interface`.
   To add a setting (accent colour, density...): give it a default and its allowed values below, and its labels; nothing else changes.
   The allowed values are also the whitelist for what an import may set. */
import { FONT_IDS, FONT_PRESETS, TITLE_MODES, cleanFontName, customFontStack } from './font-presets.js';
import { browserStorage } from './storage.js';
import { hostPart } from './host-parts.js';

export const THEME_KEY = 'study-theme';
export const INTERFACE_KEY = 'study-interface';
/** oled and paper are chosen in Settings; they sit on a base mode (oled on dark, paper on light), so everything that only knows dark/light keeps working. */
export const THEMES = Object.freeze(['auto', 'dark', 'light', 'oled', 'paper']);
const BASE_MODE = Object.freeze({ oled: 'dark', paper: 'light' });
/** Contrast, interface density and corner style (#66): data-* on the root, the values live in appearance-themes.css; 'standard' has no rule. */
export const CONTRASTS = Object.freeze(['auto', 'standard', 'high']);
export const DENSITIES = Object.freeze(['compact', 'standard', 'comfortable']);
export const RADII = Object.freeze(['sharp', 'standard', 'soft']);
export const CRAFTS = Object.freeze(['standard', 'refined']);
export const MOTIONS = Object.freeze(['auto', 'full', 'reduced', 'off']);
/** Tactile acoustic feedback levels in 设置 › 界面: off by default so quiet rooms stay silent unless opted in. */
export const SOUNDS = Object.freeze(['off', 'subtle', 'standard']);
/** The sizes of the whole interface, in percent (CSS zoom on the app: text, controls and spacing scale together), and the typefaces of its text.
    `auto` (跟随窗口) takes the percent of the widest AUTO_SCALE_STEPS entry the window reaches: a wider window shows a slightly larger interface. */
export const SCALES = Object.freeze(['auto', 50, 70, 90, 100, 110, 125, 150, 175, 200]);
/** [window width in CSS px, percent], widest first; below the last one the interface stays at 100%. */
export const AUTO_SCALE_STEPS = Object.freeze([[3000, 150], [2000, 125], [1600, 110]]);
export const autoScaleQuery = (width) => `(min-width: ${width}px)`;
/** The percent 跟随窗口 gives a window this wide. */
export const autoScaleFor = (width) => AUTO_SCALE_STEPS.find(([min]) => width >= min)?.[1] ?? 100;
/** The presets of ui/font-presets.js, then `custom`: the name of an installed font typed in `fontCustom` (gated by cleanFontName). */
export const FONTS = Object.freeze([...FONT_IDS, 'custom']);
/** The accent colours (强调色, ui/accent.css): cinnabar is the default and needs no override; there is no free colour picker, so contrast stays verifiable. */
export const ACCENTS = Object.freeze(['cinnabar', 'jade', 'ochre', 'graphite', 'plum']);
export const APPEARANCE_DEFAULTS = Object.freeze({ theme: 'auto', motion: 'auto', sound: 'off', scale: 100, font: 'system', fontTitle: 'follow', fontCustom: '', accent: 'cinnabar', contrast: 'auto', density: 'standard', radius: 'standard', craft: 'standard' });
/** Per setting, its allowed values (in display order): the whitelist and the option list of the settings page. */
export const APPEARANCE_OPTIONS = Object.freeze({ theme: THEMES, motion: MOTIONS, sound: SOUNDS, scale: SCALES, font: FONTS, fontTitle: TITLE_MODES, accent: ACCENTS, contrast: CONTRASTS, density: DENSITIES, radius: RADII, craft: CRAFTS });
/** A setting that is typed, not picked: its own gate instead of a list of values. */
const GATES = Object.freeze({ fontCustom: cleanFontName });
/** The zh label of each value, passed through ui() where shown; a scale shows as its percent, a value with no label as itself. */
export const APPEARANCE_LABELS = Object.freeze({
  theme: { auto: '跟随系统', dark: '深色', light: '浅色', oled: '纯黑 OLED', paper: '护眼纸色' },
  motion: { auto: '跟随系统', full: '标准', reduced: '减弱', off: '无动画' },
  sound: { off: '无音效', subtle: '轻柔', standard: '标准' },
  scale: { auto: '跟随窗口' },
  font: { ...Object.fromEntries(FONT_IDS.map(id => [id, FONT_PRESETS[id].label])), custom: '本机字体' },
  fontTitle: { follow: '跟随正文', system: '保持系统' },
  accent: { cinnabar: '朱砂', jade: '青玉', ochre: '赭石', graphite: '墨灰', plum: '梅紫' },
  contrast: { auto: '跟随系统', standard: '标准', high: '高对比' },
  density: { compact: '紧凑', standard: '标准', comfortable: '宽松' },
  radius: { sharp: '利落', standard: '标准', soft: '圆润' },
  craft: { standard: '标准', refined: '精致紧凑' },
});

const KEYS = Object.keys(APPEARANCE_DEFAULTS);
const same = (a, b) => KEYS.every(key => a[key] === b[key]);
const choiceOf = (key, value) => APPEARANCE_OPTIONS[key]?.find(option => typeof option === 'number' ? option === Number(value) : option === value);

/** The defaults of this host: APPEARANCE_DEFAULTS, with what the host registered (hostPart('appearanceDefaults'), e.g. the desktop's 跟随窗口) where
    that is one of the allowed values. DSH registers none. */
export function appearanceDefaults() {
  const own = hostPart('appearanceDefaults'), out = { ...APPEARANCE_DEFAULTS };
  if (own && typeof own === 'object') for (const key of KEYS) { const choice = GATES[key] ? undefined : choiceOf(key, own[key]); if (choice !== undefined) out[key] = choice; }
  return out;
}

/** Anything in, a complete and valid set out: unknown values and unknown settings are dropped, a number stored as text still counts. */
export function normalizeAppearance(value) {
  const stored = value && typeof value === 'object' ? value : {}, defaults = appearanceDefaults();
  const out = {};
  for (const key of KEYS) {
    if (GATES[key]) { out[key] = GATES[key](stored[key]); continue; }
    out[key] = choiceOf(key, stored[key]) ?? defaults[key];
  }
  return out;
}

const read = (storage, key) => { try { return storage?.getItem(key) ?? null; } catch { return null; } };
const write = (storage, key, text) => { try { storage?.setItem(key, text); } catch { /* storage is blocked: the choice still applies for this session */ } };

let cachedStorage = null;
let cachedAppearance = null;
let storageListenerInstalled = false;
const cacheListeners = new Set();

function notifyCache(next) {
  for (const listener of cacheListeners) {
    try { listener(next); } catch { /* ignore */ }
  }
}

function ensureStorageListener() {
  if (storageListenerInstalled || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  storageListenerInstalled = true;
  window.addEventListener('storage', (event) => {
    if (event.key === null || event.key === THEME_KEY || event.key === INTERFACE_KEY) {
      cachedAppearance = null;
      cachedStorage = null;
      if (cacheListeners.size) notifyCache(getCachedAppearance());
    }
  });
}

export function loadAppearance(storage = browserStorage()) {
  let rest = null;
  try { rest = JSON.parse(read(storage, INTERFACE_KEY) || 'null'); } catch { /* corrupt: defaults */ }
  return normalizeAppearance({ ...(rest && typeof rest === 'object' ? rest : null), theme: read(storage, THEME_KEY) });
}

/** Memory-cached read of appearance prefs for hot paths (e.g. playSound), kept fresh on saveAppearance() and cross-tab storage events. */
export function getCachedAppearance(storage = browserStorage()) {
  ensureStorageListener();
  if (cachedAppearance && cachedStorage === storage) return cachedAppearance;
  cachedStorage = storage;
  cachedAppearance = loadAppearance(storage);
  return cachedAppearance;
}

/** O(1) sound preference lookup without repeated localStorage + JSON.parse on every click. */
export function getAppearanceSound(storage = browserStorage()) {
  return getCachedAppearance(storage).sound;
}

/** Subscribe to cached appearance updates (e.g. sound mode turned on/off). */
export function onAppearanceCacheChange(listener) {
  ensureStorageListener();
  cacheListeners.add(listener);
  return () => cacheListeners.delete(listener);
}

/** Reset the in-memory appearance cache (for unit tests that swap localStorage directly). */
export function invalidateAppearanceCache() {
  cachedAppearance = null;
  cachedStorage = null;
}

export function saveAppearance(value, storage = browserStorage()) {
  const normalized = normalizeAppearance(value);
  const { theme, ...rest } = normalized;
  write(storage, THEME_KEY, theme);
  write(storage, INTERFACE_KEY, JSON.stringify(rest));
  const defaultStorage = browserStorage();
  if (storage === defaultStorage) {
    const prev = cachedAppearance;
    cachedStorage = storage;
    cachedAppearance = normalized;
    if (!prev || !same(prev, normalized)) notifyCache(normalized);
  }
}

/** What actually runs: 'full' | 'reduced' | 'off'. 'auto' follows the system's "reduce motion" setting; an explicit choice wins over it. */
export function effectiveMotion(motion, systemReduces) {
  if (motion === 'reduced' || motion === 'off' || motion === 'full') return motion;
  return systemReduces ? 'reduced' : 'full';
}

/** How long a page switch waits for the current page to lift away: only 'full' has that animation, and it is short. */
export const leaveDelayMs = (effective) => (effective === 'full' ? 90 : 0);

/** The data-* attributes of the app root, so every surface that wears the study tokens (the app, the empty page) looks the same.
    `system` is what the OS asks for right now; without it the browser is asked. */
export function appearanceAttrs(value, system = systemNow()) {
  const prefs = normalizeAppearance(value);
  return {
    'data-theme': prefs.theme === 'auto' ? (system.light ? 'light' : 'dark') : BASE_MODE[prefs.theme] ?? prefs.theme,
    'data-palette': BASE_MODE[prefs.theme] ? prefs.theme : 'standard',
    'data-motion': effectiveMotion(prefs.motion, system.reducedMotion),
    'data-ui-scale': prefs.scale === 'auto' ? system.autoScale ?? 100 : prefs.scale,
    // `custom` with no valid name is the system typeface, so the DOM never names a typeface it cannot show.
    'data-ui-font': prefs.font === 'custom' && !prefs.fontCustom ? 'system' : prefs.font,
    'data-ui-title': prefs.fontTitle,
    'data-contrast': prefs.contrast === 'auto' ? (system.contrast ? 'high' : 'standard') : prefs.contrast,
    'data-density': prefs.density,
    'data-radius': prefs.radius,
    'data-craft': prefs.craft,
    'data-accent': prefs.accent,
  };
}

/** What the DSH seat (ui/host/workspace.jsx) wears beside the app inside it: the choices that rules apply to everything under a root
    (ui/motion.css, the high-contrast focus ring, 控件与字阶 in ui/appearance-craft.css). A `.seat:has(> .study-app[...]) <target>` rule would ask the same, but Chrome then restyles the
    whole app on every element added anywhere (tests/page-switch-jank.test.mjs). */
export const seatAttrs = (attrs) => ({ 'data-motion': attrs['data-motion'], 'data-contrast': attrs['data-contrast'], 'data-craft': attrs['data-craft'] });

/** The one inline CSS variable of the app root: the typed font name as `"Name", <system stack>` (only while the typeface is custom). */
export function appearanceStyle(value) {
  const prefs = normalizeAppearance(value), stack = prefs.font === 'custom' ? customFontStack(prefs.fontCustom) : '';
  return stack ? { '--font-custom': stack } : {};
}

export const LIGHT_QUERY = '(prefers-color-scheme: light)';
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
export const CONTRAST_QUERY = '(prefers-contrast: more)';
const matches = query => typeof matchMedia === 'function' && matchMedia(query).matches;
/** The percent 跟随窗口 gives the window right now, asked the same way the live hook listens (media queries), so both always agree. */
export const autoScaleNow = () => AUTO_SCALE_STEPS.find(([min]) => matches(autoScaleQuery(min)))?.[1] ?? 100;
export const systemNow = () => ({ light: matches(LIGHT_QUERY), reducedMotion: matches(REDUCED_MOTION_QUERY), contrast: matches(CONTRAST_QUERY), autoScale: autoScaleNow() });

/** A small JSON text for moving the look to another computer or sharing it. */
export const exportAppearance = value => JSON.stringify({ studyhubAppearance: 1, ...normalizeAppearance(value) });

/** The prefs in an exported text, through the same whitelist; null when it is not an appearance export. */
export function importAppearance(text) {
  try {
    const data = typeof text === 'string' && text.length <= 2000 ? JSON.parse(text) : null;
    return data && typeof data === 'object' && data.studyhubAppearance === 1 ? normalizeAppearance(data) : null;
  } catch { return null; }
}

/** The tiny store behind useAppearance(); `storage` is injectable for tests. A change is only a change when a value differs. */
export function createAppearanceStore({ storage } = {}) {
  let current = null;
  const listeners = new Set();
  const get = () => (current ??= loadAppearance(storage));
  const emit = () => listeners.forEach(listener => listener());
  const set = next => { if (same(next, get())) return false; current = next; emit(); return true; };
  /** Merge a patch, keep it for the next visit and tell every open panel. */
  const update = patch => {
    const next = normalizeAppearance({ ...get(), ...patch });
    if (set(next)) saveAppearance(next, storage);
  };
  return {
    get,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    update,
    /** 恢复默认外观. */
    reset: () => update(appearanceDefaults()),
    /** Read the stored value again (another tab changed it): nothing is written back. */
    reload: () => {
      const next = loadAppearance(storage);
      if (!storage || storage === browserStorage()) {
        cachedStorage = storage ?? browserStorage();
        cachedAppearance = next;
      }
      set(next);
    },
  };
}
