/* Interface preferences (设置 › 界面): how much the interface moves, its size and its typeface. They now live in appearance-prefs.js with the
   theme; this module keeps the names earlier code and tests import, over the same storage key, without the theme. */
import { APPEARANCE_DEFAULTS, normalizeAppearance, loadAppearance, saveAppearance } from './appearance-prefs.js';

export { INTERFACE_KEY, MOTIONS, SCALES, FONTS, effectiveMotion, leaveDelayMs } from './appearance-prefs.js';

const withoutTheme = ({ theme, ...rest }) => rest;

export const INTERFACE_DEFAULTS = Object.freeze(withoutTheme(APPEARANCE_DEFAULTS));
export const normalizeInterface = value => withoutTheme(normalizeAppearance(value));
export const loadInterface = storage => withoutTheme(storage === undefined ? loadAppearance() : loadAppearance(storage));
export const saveInterface = (value, storage) => saveAppearance({ ...(storage === undefined ? loadAppearance() : loadAppearance(storage)), ...value }, storage);
