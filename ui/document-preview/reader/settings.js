/* Reading preferences of the source reader (资料预览): size, measure, typeface and
   paper tone, plus whether the outline and the learning panel are open. Kept
   per browser; a blocked or corrupt store falls back to the defaults. Pure
   helpers only, so they run under node:test. */

export const SIZES = [15, 16, 17, 18, 20, 22, 24];
/** The measure (line length) in em, as the reader's three width choices. */
export const WIDTHS = { narrow: 36, standard: 44, wide: 56 };
export const FACES = ['sans', 'serif'];
export const TONES = ['auto', 'paper'];
/** Underlines on passages that have a question, a Q&A card or a note (2.3.2). 'hide' paints nothing; the links stay reachable. */
export const UNDERLINES = ['show', 'hide'];

export const READER_DEFAULTS = Object.freeze({ size: 16, width: 'standard', face: 'sans', tone: 'auto', underline: 'show', outline: true, tools: true });
export const READER_STORAGE_KEY = 'study-reader-settings';

const choice = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

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
  const { size, width } = normalizeReaderSettings(settings);
  return { '--reader-size': `${size}px`, '--reader-measure': `${WIDTHS[width]}em`, '--reader-leading': size <= 18 ? '1.8' : '1.7' };
}

const storageOf = () => { try { return globalThis.localStorage || null; } catch { return null; } };

export function loadReaderSettings(storage = storageOf()) {
  try { return normalizeReaderSettings(JSON.parse(storage?.getItem(READER_STORAGE_KEY) || 'null')); }
  catch { return { ...READER_DEFAULTS }; }
}

export function saveReaderSettings(settings, storage = storageOf()) {
  try { storage?.setItem(READER_STORAGE_KEY, JSON.stringify(normalizeReaderSettings(settings))); }
  catch { /* storage is blocked: the choice still applies for this session */ }
}
