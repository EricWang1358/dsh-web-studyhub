import { ui, uiFormat } from './i18n.js';
import { displayTitle } from '../lib/document-title.js';
import { offerRestore } from './undoable.js';

/* 归档 of the two valuable assets, a deck (题组) and a material (资料): what the learner sees once it has happened. Archive-first stays: permanent delete is
   reachable only for an archived one. The entries to 归档 are the Manage page, a deck row's ⋯ menu, and the Sources page (one row, or the checked ones); every
   one ends in the same notice: 撤销 (ui/undoable.js restoreWith) and, where permanent delete is allowed after archiving, 永久删除…, which opens the one
   permanent-delete dialog the app already has (RemoveDeckDialog, Sources' RemoveDialog). Plain JavaScript: the pages bring their own calls. */

/** How many open practice runs stand on a deck (the snapshot's runs, by deckId or deckIds): what archiving the deck ends. */
export const openRunsOn = (runs, deckId) => (runs || []).filter((run) => run.deckId === deckId || run.deckIds?.includes(deckId)).length;

/** The 归档 entry of a deck row's ⋯ menu, or null for a system deck (its archived row offers neither restore nor delete). `runs` is what archiving ends, said before the click. */
export function archiveMenuItem(deck, { busy = false, runs = 0 } = {}) {
  if (deck.systemKind) return null;
  return { id: 'archive', label: ui('归档'), disabled: busy, ...(runs > 0 ? { hint: uiFormat('会结束 {0} 轮练习', [runs]) } : {}) };
}

/**
 * The notice after a deck was archived (deck.archive answered `done`). The host also ends the open runs on the deck and says how many (`done.closedRuns`); a host without
 * the count falls back to the runs the snapshot lists. 撤销 brings the deck back (`restore()` resolves truthy when it worked; an ended run stays ended). 永久删除… is
 * offered for an ordinary deck only: `onRemove(id, { returnFocus })` opens the permanent-delete dialog, whose close puts the focus on `returnFocus`.
 */
export function offerDeckArchived({ toast, deck, done, runs, restore, focus, onRemove, returnFocus }) {
  const ended = Number.isInteger(done?.closedRuns) ? done.closedRuns : openRunsOn(runs, deck.id);
  return offerRestore(toast, {
    message: ended ? uiFormat('已归档「{0}」，结束了 {1} 轮进行中的练习；撤销只恢复题组，结束的练习不会重新打开。', [deck.title, ended]) : uiFormat('已归档「{0}」', [deck.title]),
    restored: ended ? uiFormat('已恢复「{0}」；结束的练习不会重新打开。', [deck.title]) : uiFormat('已恢复「{0}」', [deck.title]),
    restore, focus,
    ...(!deck.systemKind && onRemove ? { secondary: { label: ui('永久删除…'), onClick: () => onRemove(deck.id, { returnFocus }) } } : {}) });
}

/** The page ids of the chosen documents, each once: one list for one source.archive call. */
export const idsOfDocuments = (items) => [...new Set((items || []).flatMap((item) => item.sourceIds || []))];

/**
 * The notice after documents were archived. One document names itself and keeps the shortcut to its own permanent-delete dialog (`onRemove(item)`, the item marked
 * archived and as opened from the notice); several say how many, and permanent delete stays one document at a time, from 已归档.
 */
export function offerDocumentsArchived({ toast, items, restore, focus, onRemove }) {
  if (items.length === 1) {
    const [item] = items, name = displayTitle(item.title);
    return offerRestore(toast, { message: uiFormat('已归档「{0}」：在「已归档」里，可以恢复或永久删除。', [name]), restored: uiFormat('已恢复「{0}」', [name]), restore, focus,
      secondary: { label: ui('永久删除…'), onClick: () => onRemove({ ...item, archived: true, fromNotice: true }) } });
  }
  return offerRestore(toast, { message: uiFormat('已归档 {0} 份资料：在「已归档」里，可以恢复或永久删除。', [items.length]), restored: uiFormat('已恢复 {0} 份资料', [items.length]), restore, focus });
}
