/* The bilingual reading of the reader (译): what is shown, what each paragraph's 译 says, and how the answers of
   materials.translation.* change that. Pure: no DOM, no React, no storage except the setting below, so it runs under node:test.

   One paragraph has one of five states on its inline 译 button:
   none (nothing yet), translating (a call is out), has (a translation is kept), stale (kept, but the glossary changed since:
   it may disagree with it), error (the last attempt did not work). The translation block under it can be shown, collapsed
   (only its bar) or, in 隐藏译文, hidden unless the learner asked for this one. */
import { paragraphKey } from '../../../lib/passage-translation.js';
import { isActiveJob } from '../../../lib/job-status.js';
import { browserStorage } from '../../storage.js';

/** 逐段对照 | 左右分栏 | 仅译文 | 隐藏译文. */
export const DISPLAY_MODES = Object.freeze(['pairs', 'side', 'only', 'hidden']);
/** Below this width of the reader, 左右分栏 falls back to 逐段对照 (the reader's own NARROW mirror). */
export const SIDE_MIN_WIDTH = 900;
/** ... and the reading column itself needs this much (outline and learning panel open leave less): two columns of at least 320px. */
export const SIDE_MIN_COLUMN = 640;
export const TRANSLATION_SETTINGS_KEY = 'study-reader-translation';
export const TRANSLATION_DEFAULTS = Object.freeze({ mode: 'pairs' });

export const normalizeTranslationSettings = raw => ({ mode: DISPLAY_MODES.includes(raw?.mode) ? raw.mode : TRANSLATION_DEFAULTS.mode });
export function loadTranslationSettings(storage = browserStorage()) {
  try { return normalizeTranslationSettings(JSON.parse(storage?.getItem(TRANSLATION_SETTINGS_KEY) || 'null')); } catch { return { ...TRANSLATION_DEFAULTS }; }
}
export function saveTranslationSettings(settings, storage = browserStorage()) {
  try { storage?.setItem(TRANSLATION_SETTINGS_KEY, JSON.stringify(normalizeTranslationSettings(settings))); } catch { /* blocked storage: the choice still applies for this session */ }
}
/** The mode that is drawn: 左右分栏 needs room. */
export const effectiveMode = (mode, width) => mode === 'side' && !(width >= SIDE_MIN_WIDTH) ? 'pairs' : mode;

/* ---------- paragraphs ---------- */

/** Paragraphs as the reader scanned them ([{ sourceId, text }] in reading order) with their ordinal and key. */
export function keyedParagraphs(list) {
  const seen = new Map();
  return list.map(item => {
    const probe = paragraphKey(item.sourceId, { text: item.text, ordinal: 0 }), ordinal = seen.get(probe) ?? 0;
    seen.set(probe, ordinal + 1);
    return { ...item, ordinal, key: paragraphKey(item.sourceId, { text: item.text, ordinal }) };
  });
}

/** What a request names for one paragraph. */
export const passageOf = paragraph => ({ sourceId: paragraph.sourceId, text: paragraph.text, ordinal: paragraph.ordinal });

/** The first words of a passage, for a chip or a list. */
export function shortQuote(text, size = 48) {
  const clean = String(text ?? '').replace(/\s+/gu, ' ').trim();
  return clean.length > size ? `${clean.slice(0, size - 1)}…` : clean;
}

/* ---------- state ---------- */

export const initialState = Object.freeze({
  loaded: false, target: 'zh', targetSource: 'default', glossary: [], modelAvailable: true, items: {}, stale: [], otherTarget: 0,
  pending: {}, errors: {}, shown: {}, undo: {},
});

const without = (record, keys) => { const next = { ...record }; for (const key of keys) delete next[key]; return next; };
const mark = (record, keys, value) => { const next = { ...record }; for (const key of keys) next[key] = value; return next; };

export function reducer(state, action) {
  switch (action.type) {
    case 'loaded': {
      const list = action.list;
      return { ...state, loaded: true, target: list.target, targetSource: list.targetSource, glossary: list.glossary, modelAvailable: list.modelAvailable, stale: list.stale || [],
        otherTarget: list.otherTarget || 0, items: Object.fromEntries(list.items.map(item => [item.key, item])) };
    }
    case 'pending': return { ...state, pending: mark(state.pending, action.keys, action.kind || 'translate'), errors: without(state.errors, action.keys) };
    case 'settled': {
      const items = { ...state.items }, errors = { ...state.errors }, shown = { ...state.shown };
      for (const result of action.results) {
        if (result.item && ['translated', 'cached', 'reused'].includes(result.status)) { items[result.key] = result.item; delete errors[result.key]; if (action.reveal && result.status === 'translated') shown[result.key] = true; }
        else if (result.status === 'skipped') errors[result.key] = { code: result.code || 'same-language' };
        else errors[result.key] = { code: result.code || result.status, message: result.message };
      }
      return { ...state, items, errors, shown, pending: without(state.pending, action.results.map(result => result.key).concat(action.keys || [])) };
    }
    case 'failed': return { ...state, pending: without(state.pending, action.keys), errors: { ...state.errors, ...Object.fromEntries(action.keys.map(key => [key, { code: action.code || 'error', message: action.message }])) } };
    case 'unavailable': return { ...state, modelAvailable: false, pending: without(state.pending, action.keys), errors: { ...state.errors, ...Object.fromEntries(action.keys.map(key => [key, { code: 'model' }])) } };
    case 'cancelled': return { ...state, pending: without(state.pending, action.keys) };
    case 'removed': return { ...state, items: without(state.items, action.keys), undo: { ...state.undo, ...Object.fromEntries(action.keys.map(key => [key, action.removed.filter(item => item.key === key)])) } };
    case 'undone': return { ...state, undo: without(state.undo, action.keys), items: { ...state.items, ...Object.fromEntries((action.items || []).map(item => [item.key, item])) } };
    case 'undo-expired': return { ...state, undo: without(state.undo, action.keys) };
    case 'show': return { ...state, shown: action.value === undefined ? without(state.shown, action.keys) : mark(state.shown, action.keys, action.value) };
    case 'show-reset': return { ...state, shown: {} };
    case 'reset': return initialState;
    case 'dismiss-error': return { ...state, errors: without(state.errors, action.keys) };
    case 'glossary': return { ...state, glossary: action.glossary, ...(action.target ? { target: action.target, targetSource: 'document' } : {}) };
    default: return state;
  }
}

/** none | translating | has | stale | error: what the inline 译 button of a paragraph shows. */
export function buttonState(state, key) {
  if (state.pending[key]) return 'translating';
  const item = state.items[key];
  if (item) return item.outdated ? 'stale' : 'has';
  return state.errors[key] && state.errors[key].code !== 'same-language' ? 'error' : 'none';
}

/**
 * 'open' (the translation is drawn), 'collapsed' (only the block's bar) or 'hidden' (not drawn at all, only the mark at the end of the paragraph).
 * The learner's own choice for a paragraph wins; without one, 隐藏译文 hides it and the other modes open it.
 */
export const blockState = (state, key, mode) => state.shown[key] === true ? 'open' : state.shown[key] === false ? 'collapsed' : mode === 'hidden' ? 'hidden' : 'open';
export const isShown = (state, key, mode) => blockState(state, key, mode) === 'open';
/** Whether the block's place in the page exists at all: a collapsed or hidden translation leaves no frame (the paragraph's own 译 brings it back); a paragraph with no translation yet keeps its place for the waiting, undo and error notes. */
export const hostShown = (state, key, mode) => state.items[key] && !state.pending[key] ? blockState(state, key, mode) === 'open' : true;

/** The keys that have a translation (or are being made), in the order given. */
export const translatedKeys = (state, keys) => keys.filter(key => state.items[key] || state.pending[key]);

/* ---------- words ---------- */

/** "v2 · 意见：…" parts of a version line, or null for the first version. */
export const versionOf = item => item && item.version > 1 ? { version: item.version, comment: item.comment || '' } : null;

/** The plain reason a passage did not get a translation, as a key of the messages the block shows. */
export function failureKind(code) {
  if (code === 'model') return 'model';
  if (['empty', 'refusal', 'length', 'untranslated', 'missing', 'format'].includes(code)) return 'answer';
  if (['unlocated', 'missing', 'source', 'ambiguous', 'too-long'].includes(code)) return 'place';
  return 'other';
}

/* ---------- the job ---------- */

export const jobActive = isActiveJob;

/** "1:05": how long the job has run, frozen at its end. */
export function jobClock(job, now = Date.now()) {
  if (!job || job.status === 'queued') return '';
  const start = Date.parse(job.runStartedAt || job.startedAt || '');
  if (!Number.isFinite(start)) return '';
  const end = job.finishedAt ? Date.parse(job.finishedAt) : now, seconds = Math.max(0, Math.floor((end - start) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** done / total as a fraction 0..1 for the progress bar. */
export const jobFraction = job => job?.total > 0 ? Math.min(1, Math.max(0, (job.done || 0) / job.total)) : 0;

/** The job of this document that is running, else the newest finished one (so the result can be read), else null. */
export function jobToShow(jobs) {
  const list = Array.isArray(jobs) ? jobs : [];
  return list.find(jobActive) || [...list].sort((a, b) => Date.parse(b.startedAt || 0) - Date.parse(a.startedAt || 0))[0] || null;
}

/** The number of kept translations that are in `keys` (a page): for the "N 段已译" line. */
export const countTranslated = (state, keys) => keys.filter(key => state.items[key]).length;
