/* Interface preferences (设置 › 界面), kept per browser in localStorage: how much the interface moves. The module is pure so the app, the settings page and the
   tests share one definition. 'auto' follows the system's "reduce motion" setting; an explicit choice wins over it. */

export const INTERFACE_KEY = 'study-interface';
export const MOTIONS = Object.freeze(['auto', 'full', 'reduced', 'off']);
/** The sizes of the whole interface, in percent (CSS zoom on the app: text, controls and spacing scale together), and the typefaces of its text. */
export const SCALES = Object.freeze([90, 100, 110, 125, 150, 175, 200]);
export const FONTS = Object.freeze(['system', 'serif', 'mono']);
export const INTERFACE_DEFAULTS = Object.freeze({ motion: 'auto', scale: 100, font: 'system' });

export function normalizeInterface(value) {
  const stored = value && typeof value === 'object' ? value : {};
  const scale = Number(stored.scale);
  return {
    motion: MOTIONS.includes(stored.motion) ? stored.motion : INTERFACE_DEFAULTS.motion,
    scale: SCALES.includes(scale) ? scale : INTERFACE_DEFAULTS.scale,
    font: FONTS.includes(stored.font) ? stored.font : INTERFACE_DEFAULTS.font,
  };
}

const storageOf = () => { try { return globalThis.localStorage || null; } catch { return null; } };

export function loadInterface(storage = storageOf()) {
  try { return normalizeInterface(JSON.parse(storage?.getItem(INTERFACE_KEY) || 'null')); }
  catch { return { ...INTERFACE_DEFAULTS }; }
}

export function saveInterface(value, storage = storageOf()) {
  try { storage?.setItem(INTERFACE_KEY, JSON.stringify(normalizeInterface(value))); }
  catch { /* storage is blocked: the choice still applies for this session */ }
}

/** What actually runs: 'full' | 'reduced' | 'off'. */
export function effectiveMotion(motion, systemReduces) {
  if (motion === 'reduced' || motion === 'off' || motion === 'full') return motion;
  return systemReduces ? 'reduced' : 'full';
}

/** How long a page switch waits for the current page to lift away: only 'full' has that animation, and it is short. */
export const leaveDelayMs = (effective) => (effective === 'full' ? 90 : 0);
