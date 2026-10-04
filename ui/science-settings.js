import { browserStorage } from './storage.js';

export const SCIENCE_KEY = 'study-science-settings';
export const FORMULA_SCALES = Object.freeze([75, 100, 125, 150, 175, 200]);
export const IMAGE_HEIGHTS = Object.freeze([180, 360, 540, 720]);
export const SCIENCE_DEFAULTS = Object.freeze({
  formulaScale: 100, formulaAlign: 'center', imageHeight: 360,
  imageCaptions: true, imageEnlarge: true, localImages: true, chemistry: true, symbolic: true,
});
export function normalizeScienceSettings(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const result = { ...SCIENCE_DEFAULTS };
  for (const [key, choices] of [['formulaScale', FORMULA_SCALES], ['imageHeight', IMAGE_HEIGHTS], ['formulaAlign', ['center', 'left']]])
    if (choices.includes(value[key])) result[key] = value[key];
  for (const key of ['imageCaptions', 'imageEnlarge', 'localImages', 'chemistry', 'symbolic'])
    if (typeof value[key] === 'boolean') result[key] = value[key];
  return result;
}
export function loadScienceSettings(storage = browserStorage()) {
  try { return normalizeScienceSettings(JSON.parse(storage?.getItem(SCIENCE_KEY) || 'null')); }
  catch { return { ...SCIENCE_DEFAULTS }; }
}
export function saveScienceSettings(value, storage = browserStorage()) {
  try { storage?.setItem(SCIENCE_KEY, JSON.stringify(normalizeScienceSettings(value))); } catch { /* Session choice still applies. */ }
}
export function scienceVars(value) {
  const prefs = normalizeScienceSettings(value);
  return { '--study-formula-scale': prefs.formulaScale / 100,
    '--study-formula-align': prefs.formulaAlign === 'left' ? 'flex-start' : 'center',
    '--study-image-height': prefs.imageHeight + 'px' };
}

