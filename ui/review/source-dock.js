import { sourceItemKey } from '../../lib/source-groups.js';
import { readText, writeText } from '../storage.js';

/* 对照栏 (#1012): a material opened from a question sits beside it on a wide practice page, instead of a full-size dialog over it. The rules, away from the
   DOM. Glossary:
   - place: the source (one page of a PDF, or a whole note) a question points at, without its answer: run.cardSource, what the page badge opens.
   - material: what the reader loads once (a PDF and all its pages, a recording's volumes, a note); sourceItemKey says which one a source belongs to.
   - dock: what the column shows. `modal` is how the material on screen was opened (the reader dialog's own modal: source, quote, peekPage, pickPages,
     resume); `key` changes only when another material comes (the reader is then mounted anew); `seek` is a one-shot request to show a place of the
     material on screen (DocumentViewer `seek`, its seekSource), which never mounts or loads anything again. */

/** The column never gets narrower than this, and always leaves the question at least QUESTION_MIN (the same limits are in ui/review/session.css). */
export const COLUMN_MIN = 360;
export const QUESTION_MIN = 480;
/** From this much room (px) for the question and the column together (questionRoom), where both fit, a source opened from a question docks beside it;
    below it, the reader is the full-size dialog. With the sidebar open and the column of ticks drawn, that is a window of about 1170 px. */
export const SPLIT_MIN = COLUMN_MIN + QUESTION_MIN;

/** The room the question and the column share on the practice page: its width less its padding, and less the column of ticks with the gap after it and
    the gap before the column when the ticks are drawn (ui/review/session.css: .has-rail, --rail-room). Measured values in px. */
export function questionRoom({ width = 0, paddingLeft = 0, paddingRight = 0, rail = 0, gap = 0 }) {
  return Math.max(0, width - paddingLeft - paddingRight - (rail ? rail + 2 * gap : 0));
}
const WIDTH_KEY = 'study-source-column-width';

/** Where a source opened from the practice page is shown: 'column' beside the question, else 'dialog' (the full-size reader, as before). The one decision.
    Only a source opened from a question (`back`) docks, on a wide page, while a question is on it; never in an exam (its own rules), never for 重读 (its own walk). */
export function sourcePlacement({ modal, wide, run }) {
  if (modal?.type !== 'source' || !modal.source || !modal.back || modal.reread) return 'dialog';
  if (!wide || !run?.card || run.complete || run.mode === 'exam') return 'dialog';
  return 'column';
}

/** The answer-safe place of a question: the source of its page (run.cardSource), as the page badge opens it; null without one (an exam, a question with no
    page, a material that is gone). */
export function questionPlace(run, sources) {
  if (run?.mode === 'exam' || !Number.isInteger(run?.cardSource?.page)) return null;
  const list = Array.isArray(sources) ? sources : [];
  return list.find(item => item.id === run.cardSource.sourceId) || list.find(item => item.id === run.cardSource.documentSourceId) || null;
}

/** Whether two sources are of the same material (the reader on screen can show both without loading anything). */
export const sameMaterial = (a, b) => !!a && !!b && (a.id === b.id || sourceItemKey(a) === sourceItemKey(b));

/** The dock of a first opening. */
export const openDock = modal => ({ modal, key: 1, seek: null, at: modal.source.id, collapsed: false, pending: null, nonce: 0 });

/* A place within the material on screen is a seek (its opening quote, now another place's, goes); another material is a swap (a new key). */
function show(state, { source, quote = '', peekPage }, opening) {
  const at = source.id;
  if (sameMaterial(state.modal.source, source)) {
    const nonce = state.nonce + 1;
    return { ...state, modal: state.modal.quote ? { ...state.modal, quote: '' } : state.modal, seek: { source, quote, ...(Number.isInteger(peekPage) ? { peekPage } : {}), nonce },
      nonce, at, collapsed: false, pending: null };
  }
  return { ...state, modal: opening || { type: 'source', source, back: true }, key: state.key + 1, seek: null, at, collapsed: false, pending: null };
}

/* A quote on screen came from a link of the question before (看原文 of a wrong answer is the answer's passage): when the question changes it goes, the
   opening quote from the modal and a seek's mark by a seek with no place (DocumentViewer takes its marks down at every seek). */
function unquote(state) {
  if (!state.modal.quote && !state.seek?.quote) return state;
  const nonce = state.nonce + 1;
  return { ...state, modal: state.modal.quote ? { ...state.modal, quote: '' } : state.modal, seek: { nonce }, nonce };
}

/**
 * The column's state. Actions:
 *   open { modal }    a source link of the question (看原页, the page badge, a citation, a figure's page): shown, the column unfolded;
 *   follow { place }  the question changed (another card, or the same one asked again): any quote of the question before goes (it may be its answer's
 *                     passage), and the column goes to the new place unless it is already there (or the question has none); folded, the place waits;
 *   collapse / expand folded to the rail and back (a place that waited is shown then);
 *   missed { seek }   the reader on screen does not hold the place it was asked to seek: the place's material is mounted instead.
 */
export function dockReducer(state, action) {
  switch (action.type) {
    case 'open': return show(state, action.modal, action.modal);
    case 'follow': {
      const place = action.place;
      if (!place || place.id === state.at) return unquote(state);
      if (state.collapsed) return { ...unquote(state), pending: place, at: place.id };
      return show(state, { source: place });
    }
    case 'collapse': return state.collapsed ? state : { ...state, collapsed: true };
    case 'expand': return state.pending ? show({ ...state, collapsed: false }, { source: state.pending }) : state.collapsed ? { ...state, collapsed: false } : state;
    case 'missed': return action.seek?.nonce === state.seek?.nonce
      ? { ...state, modal: { type: 'source', source: action.seek.source, back: true, ...(action.seek.quote ? { quote: action.seek.quote } : {}) }, key: state.key + 1, seek: null }
      : state;
    default: return state;
  }
}

/** The column's width in a `room` (questionRoom) of px: the kept one, else 45% of it, within COLUMN_MIN and what leaves the question QUESTION_MIN. */
export function columnWidth(kept, room) {
  const wanted = Number.isFinite(kept) && kept > 0 ? kept : Math.round(room * 0.45);
  return Math.max(COLUMN_MIN, Math.min(wanted, room - QUESTION_MIN));
}

/** The reader modal that shows what the column shows (the page turned narrow: the reader is the dialog now): the place it is at, with the quote of the
    link that brought it there (a link of this question: the quotes of questions before are gone, dockReducer 'follow'); a place that waited while folded. */
export function dockedPlace(state) {
  const seek = state.seek?.source?.id === state.at ? state.seek : null;
  const source = state.pending || seek?.source || state.modal.source;
  const quote = state.pending ? '' : seek ? seek.quote : state.modal.quote;
  return { type: 'source', source, back: true, ...(quote ? { quote } : {}) };
}

/** The width the learner last dragged the column to (a per-viewer convenience: null when none was kept or the storage is blocked). */
export function readColumnWidth(storage) {
  const value = Number.parseInt(readText(WIDTH_KEY, '', storage), 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export const saveColumnWidth = (width, storage) => writeText(WIDTH_KEY, String(Math.round(width)), storage);
