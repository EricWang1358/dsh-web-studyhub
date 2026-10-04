import { useMemo, useReducer } from 'react';

/* Everything the app remembers about ONE library: the page it was on, the draft it was editing, the materials it ticked,
   the generate form, an open dialog. Switching the library, restoring a backup and moving the binding all have to forget
   all of it, so it lives in one reducer with one reset (ui-consistency #111) instead of three hand-kept lists of setters.
   Add a key here and every one of those paths clears it. Review answers are the review session's own entry (ui/review). */

const FRESH = {
  contextTrail: () => [], focusRequest: () => null, boardStudyRef: () => null, legacyAudioJobId: () => '', detour: () => null,
  workflowReturn: () => null, skeletonFocus: () => null, noteInitialId: () => '',
  draft: () => null, draftLoaded: () => '', draftText: () => '', jsonMode: () => false, recovery: () => null,
  managedDeck: () => null, folderDraft: () => '', removingDeck: () => null,
  graphScope: () => null, graphCanvas: () => false,
  selectedSources: () => [], modal: () => null, notebooks: () => null, notebookError: () => '',
  examRunId: () => null, examKind: () => 'exam', caseInitial: () => null, sourceHighlight: () => null,
};
export const LIBRARY_KEYS = Object.freeze([...Object.keys(FRESH), 'gen', 'settings']);

/** A library's state before anything happened. `gen` is the generate form's defaults, `settings` the Settings page's working copy. */
export function initialLibraryState({ gen, settings } = {}) {
  return { ...Object.fromEntries(Object.entries(FRESH).map(([key, make]) => [key, make()])), gen, settings: settings ?? {} };
}

/** actions: { type: 'set', key, value | (current) => next } or { type: 'reset', initial }. */
export function libraryReducer(state, action) {
  if (action.type === 'reset') return initialLibraryState(action.initial);
  if (action.type !== 'set' || !LIBRARY_KEYS.includes(action.key)) return state;
  const next = typeof action.value === 'function' ? action.value(state[action.key]) : action.value;
  return Object.is(next, state[action.key]) ? state : { ...state, [action.key]: next };
}

const setterName = (key) => `set${key[0].toUpperCase()}${key.slice(1)}`;

/** { setNoteInitialId, setGen, ... }: one stable setter per key, shaped like useState's. */
export function libraryActions(dispatch) {
  return Object.fromEntries(LIBRARY_KEYS.map((key) => [setterName(key), (value) => dispatch({ type: 'set', key, value })]));
}

/** The state, its setters and reset(initial); the setters never change identity. */
export function useLibraryState(initial) {
  const [state, dispatch] = useReducer(libraryReducer, initial, initialLibraryState);
  const api = useMemo(() => ({ ...libraryActions(dispatch), reset: (next) => dispatch({ type: 'reset', initial: next }) }), []);
  return [state, api];
}

/**
 * The one reset entry. reason is 'switch' (another library arrived), 'restore' (a backup replaced this one) or 'binding'
 * (the learner moved the binding); all three do the same, because anything less leaves old-library references on new data.
 * deps: { refs: { epoch, navigation, leaveTimer, examLocation, actRunner }, quick, resetLibrary(initial), session, clearTimer,
 *   setPageTarget, setBusy, setNotice, setError, setPage }. options: { gen, settings }.
 */
export function createLibraryReset(deps) {
  return function resetLibraryState(reason, { gen, settings } = {}) {
    const { refs } = deps;
    refs.epoch.current++;
    deps.quick.reset();
    refs.navigation.current++;
    refs.actRunner.current?.reset();
    deps.clearTimer(refs.leaveTimer.current);
    deps.setPageTarget(null);
    deps.setBusy(false);
    deps.setNotice('');
    deps.setError('');
    deps.session.reset();
    refs.examLocation.current = null;
    deps.resetLibrary({ gen, settings: settings ?? {} });
    deps.setPage('library');
    return reason;
  };
}
