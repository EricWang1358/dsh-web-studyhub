/* The appearance of this browser (设置 › 界面): theme, interface size, typeface and motion, in one pure module that the app, the empty
   page before a session is open, the settings page and the tests all share.

   Storage is the two keys earlier versions already wrote, so nobody loses a choice and an older version can still read what a newer
   one saved: the theme alone in `study-theme` (a plain string), everything else as one small JSON object in `study-interface`.
   To add a setting (accent colour, density...): give it a default and its allowed values below, and its labels; nothing else changes.
   The allowed values are also the whitelist for what an import may set. */
export const THEME_KEY = 'study-theme';
export const INTERFACE_KEY = 'study-interface';
/** oled and paper are chosen in Settings; they sit on a base mode (oled on dark, paper on light), so everything that only knows dark/light keeps working. */
export const THEMES = Object.freeze(['auto', 'dark', 'light', 'oled', 'paper']);
/** What the sidebar's one-tap toggle cycles through; the extra themes are picked in Settings so the toggle stays three steps. */
export const THEME_CYCLE = Object.freeze(['auto', 'dark', 'light']);
const BASE_MODE = Object.freeze({ oled: 'dark', paper: 'light' });
/** Contrast, interface density and corner style (#66): data-* on the root, the values live in appearance-themes.css; 'standard' has no rule. */
export const CONTRASTS = Object.freeze(['auto', 'standard', 'high']);
export const DENSITIES = Object.freeze(['compact', 'standard', 'comfortable']);
export const RADII = Object.freeze(['sharp', 'standard', 'soft']);
export const MOTIONS = Object.freeze(['auto', 'full', 'reduced', 'off']);
/** The sizes of the whole interface, in percent (CSS zoom on the app: text, controls and spacing scale together), and the typefaces of its text. */
export const SCALES = Object.freeze([90, 100, 110, 125, 150, 175, 200]);
export const FONTS = Object.freeze(['system', 'serif', 'mono']);
/** The accent colours (强调色, ui/accent.css): cinnabar is the default and needs no override; there is no free colour picker, so contrast stays verifiable. */
export const ACCENTS = Object.freeze(['cinnabar', 'jade', 'ochre', 'graphite', 'plum']);
export const APPEARANCE_DEFAULTS = Object.freeze({ theme: 'auto', motion: 'auto', scale: 100, font: 'system', accent: 'cinnabar', contrast: 'auto', density: 'standard', radius: 'standard' });
/** Per setting, its allowed values (in display order): the whitelist and the option list of the settings page. */
export const APPEARANCE_OPTIONS = Object.freeze({ theme: THEMES, motion: MOTIONS, scale: SCALES, font: FONTS, accent: ACCENTS, contrast: CONTRASTS, density: DENSITIES, radius: RADII });
/** The zh label of each value, passed through ui() where shown; a scale shows as its percent, a value with no label as itself. */
export const APPEARANCE_LABELS = Object.freeze({
  theme: { auto: '跟随系统', dark: '深色', light: '浅色', oled: '纯黑 OLED', paper: '护眼纸色' },
  motion: { auto: '跟随系统', full: '标准', reduced: '减弱', off: '无动画' },
  accent: { cinnabar: '朱砂', jade: '青玉', ochre: '赭石', graphite: '墨灰', plum: '梅紫' },
  font: { system: '系统默认', serif: '衬线', mono: '等宽' },
  contrast: { auto: '跟随系统', standard: '标准', high: '高对比' },
  density: { compact: '紧凑', standard: '标准', comfortable: '宽松' },
  radius: { sharp: '利落', standard: '标准', soft: '圆润' },
});

const KEYS = Object.keys(APPEARANCE_DEFAULTS);
const same = (a, b) => KEYS.every(key => a[key] === b[key]);

/** Anything in, a complete and valid set out: unknown values and unknown settings are dropped, a number stored as text still counts. */
export function normalizeAppearance(value) {
  const stored = value && typeof value === 'object' ? value : {};
  const out = {};
  for (const key of KEYS) {
    const choice = APPEARANCE_OPTIONS[key].find(option => typeof option === 'number' ? option === Number(stored[key]) : option === stored[key]);
    out[key] = choice ?? APPEARANCE_DEFAULTS[key];
  }
  return out;
}

const storageOf = () => { try { return globalThis.localStorage || null; } catch { return null; } };
const read = (storage, key) => { try { return storage?.getItem(key) ?? null; } catch { return null; } };
const write = (storage, key, text) => { try { storage?.setItem(key, text); } catch { /* storage is blocked: the choice still applies for this session */ } };

export function loadAppearance(storage = storageOf()) {
  let rest = null;
  try { rest = JSON.parse(read(storage, INTERFACE_KEY) || 'null'); } catch { /* corrupt: defaults */ }
  return normalizeAppearance({ ...(rest && typeof rest === 'object' ? rest : null), theme: read(storage, THEME_KEY) });
}

export function saveAppearance(value, storage = storageOf()) {
  const { theme, ...rest } = normalizeAppearance(value);
  write(storage, THEME_KEY, theme);
  write(storage, INTERFACE_KEY, JSON.stringify(rest));
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
    'data-ui-scale': prefs.scale,
    'data-ui-font': prefs.font,
    'data-contrast': prefs.contrast === 'auto' ? (system.contrast ? 'high' : 'standard') : prefs.contrast,
    'data-density': prefs.density,
    'data-radius': prefs.radius,
    'data-accent': prefs.accent,
  };
}

export const LIGHT_QUERY = '(prefers-color-scheme: light)';
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
export const CONTRAST_QUERY = '(prefers-contrast: more)';
const matches = query => typeof matchMedia === 'function' && matchMedia(query).matches;
export const systemNow = () => ({ light: matches(LIGHT_QUERY), reducedMotion: matches(REDUCED_MOTION_QUERY), contrast: matches(CONTRAST_QUERY) });

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
    reset: () => update(APPEARANCE_DEFAULTS),
    /** Read the stored value again (another tab changed it): nothing is written back. */
    reload: () => { set(loadAppearance(storage)); },
  };
}
