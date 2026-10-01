import { resolveCourse } from "./source-courses.js";
import { currentCourse } from "./focus.js";
import { get } from "./util.js";
import { cleanFolder } from './bank-import.js';

const MISTAKES = ["auto", "all", "none"];

function ingestView(s) {
  const m = s.ingest;
  if (!m?.active) return null;
  const deck = m.deckId && s.decks.find((d) => d.id === m.deckId);
  return {
    active: true,
    deckId: deck?.id || null,
    deckTitle: deck?.title || m.deckTitle,
    folder: deck ? deck.folder || "" : m.folder,
    course: m.course ?? (deck ? deck.course ?? deck.folder : '') ?? '',
    kind: m.kind,
    mistakes: m.mistakes,
    added: m.added || 0,
    startedAt: m.startedAt,
  };
}

function recordingDestination(state, args, mode = {}) {
  const useMode = !args.deckId && !args.deckTitle;
  const deckId = args.deckId || (useMode ? mode.deckId : null);
  const target = deckId ? get(state.decks, deckId, 'Deck') : null;
  if (target && (target.archived || target.systemKind)) throw new Error('请选择未归档的普通题组');
  const preferred = currentCourse(state);
  const course = target ? (useMode ? mode.course : undefined) ?? target.course ?? target.folder ?? ''
    : resolveCourse(state, args, { course: useMode ? mode.course : undefined, preferred: preferred ?? '' });
  const deckTitle = target?.title || String(args.deckTitle || (useMode ? mode.deckTitle : '') || '对话录题').trim().slice(0, 120);
  const folder = target ? target.folder || '' : cleanFolder(args.folder ?? (useMode ? mode.folder : undefined));
  const existing = target || state.decks.find(deck => !deck.archived && !deck.systemKind &&
    deck.title === deckTitle && (deck.folder || '') === folder && (deck.course ?? deck.folder ?? '') === course);
  return { deckId: existing?.id || null, deckTitle, folder, course };
}

export { MISTAKES, ingestView, recordingDestination };
