/* Reading preferences, shared by the source reader (资料预览) and every long-form reading surface of the study content (review
   explanations and Q&A, results, notes, lessons, the skeleton detail pane, the exam report): size, measure, typeface and paper
   tone, plus whether the reader's outline and learning panel are open. ONE value per browser under the reader's own storage key,
   so a choice made before the settings were shared still applies; a blocked or corrupt store falls back to the defaults. Pure
   helpers only, so they run under node:test. */

import { READER_FACES } from '../font-presets.js';
import { browserStorage } from '../storage.js';

export const SIZES = [15, 16, 17, 18, 20, 22, 24];
/** The measure (line length) in em, as the reader's three width choices. */
export const WIDTHS = { narrow: 36, standard: 44, wide: 56 };
/** The typefaces are the registry's (ui/font-presets.js); `sans` follows the interface typeface. */
export const FACES = [...READER_FACES];
export const TONES = ['auto', 'paper'];
/** Three light steps each, written only as CSS variables, and only when not standard (so the defaults add nothing): the weight of the
    text, its leading as a shift of the size-based line height, and the gap after a paragraph. */
export const WEIGHTS = { normal: null, medium: '500', bold: '600' };
export const LEADINGS = { tight: -0.15, standard: 0, loose: 0.2 };
export const GAPS = { tight: '0.45em', standard: null, loose: '1.5em' };
/** Underlines on passages that have a question, a Q&A card or a note (2.3.2). 'hide' paints nothing; the links stay reachable. */
export const UNDERLINES = ['show', 'hide'];

export const READER_DEFAULTS = Object.freeze({ size: 16, width: 'standard', face: 'sans', tone: 'auto', underline: 'show', outline: true, tools: true, weight: 'normal', leading: 'standard', gap: 'standard' });
export const READER_STORAGE_KEY = 'study-reader-settings';

const choice = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
const step = (value, steps, fallback) => (typeof value === 'string' && Object.hasOwn(steps, value) ? value : fallback);

/** Anything stored or passed in becomes a complete, valid settings object. */
export function normalizeReaderSettings(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const size = Number(value.size);
  return {
    size: SIZES.includes(size) ? size : READER_DEFAULTS.size,
    width: Object.hasOwn(WIDTHS, value.width) ? value.width : READER_DEFAULTS.width,
    face: choice(value.face, FACES, READER_DEFAULTS.face),
    tone: choice(value.tone, TONES, READER_DEFAULTS.tone),
    underline: choice(value.underline, UNDERLINES, READER_DEFAULTS.underline),
    outline: typeof value.outline === 'boolean' ? value.outline : READER_DEFAULTS.outline,
    tools: typeof value.tools === 'boolean' ? value.tools : READER_DEFAULTS.tools,
    weight: step(value.weight, WEIGHTS, READER_DEFAULTS.weight),
    leading: step(value.leading, LEADINGS, READER_DEFAULTS.leading),
    gap: step(value.gap, GAPS, READER_DEFAULTS.gap),
  };
}

/** Whether linked passages are underlined; anything but an explicit 'hide' shows them. */
export const underlineShown = settings => settings?.underline !== 'hide';

/** The defaults, except what is open: restoring the display never closes a panel. */
export const resetReaderSettings = current => ({ ...READER_DEFAULTS, outline: current.outline, tools: current.tools });

/** The next size up (+1) or down (-1), stopping at the ends of the scale. */
export function stepSize(size, direction) {
  const index = Math.max(0, SIZES.indexOf(size));
  return SIZES[Math.min(SIZES.length - 1, Math.max(0, index + Math.sign(direction)))];
}

/** CSS custom properties for the reading column; the typeface and tone are data attributes. */
export function readerVars(settings) {
  const { size, width, weight, leading, gap } = normalizeReaderSettings(settings);
  return {
    '--reader-size': `${size}px`, '--reader-measure': `${WIDTHS[width]}em`, '--reader-leading': lines(size <= 18 ? 1.8 : 1.7, leading),
    ...(WEIGHTS[weight] && { '--reader-weight': WEIGHTS[weight] }), ...(GAPS[gap] && { '--reader-gap': GAPS[gap] }),
  };
}
const lines = (base, leading) => String(+(base + LEADINGS[leading]).toFixed(2));

/**
 * CSS custom properties for a reading block that is not the reader's column: the reader's three plus the measure in pixels (a block
 * whose own font size is not the reading size cannot use the reader's em measure).
 */
export function readingVars(settings) {
  const { size, width, leading } = normalizeReaderSettings(settings);
  // Study text sits among controls and cards, so its leading is a little tighter than the reader's column.
  return { ...readerVars(settings), '--reading-measure': `${WIDTHS[width] * size}px`, '--reading-leading': lines(size <= 18 ? 1.65 : 1.55, leading) };
}

/** What a long-form block carries: the typeface and tone as data attributes, the sizes as variables. */
export function readingProps(settings) {
  const { face, tone } = normalizeReaderSettings(settings);
  return { 'data-face': face, 'data-tone': tone, style: readingVars(settings) };
}


export function loadReaderSettings(storage = browserStorage()) {
  try { return normalizeReaderSettings(JSON.parse(storage?.getItem(READER_STORAGE_KEY) || 'null')); }
  catch { return { ...READER_DEFAULTS }; }
}

export function saveReaderSettings(settings, storage = browserStorage()) {
  try { storage?.setItem(READER_STORAGE_KEY, JSON.stringify(normalizeReaderSettings(settings))); }
  catch { /* storage is blocked: the choice still applies for this session */ }
}
