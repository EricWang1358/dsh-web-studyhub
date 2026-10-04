/* StudyMap (ui/StudyMap.jsx) used to take ~48 props. It now takes the snapshot, one `actions` bag, the setup handlers, the notebook controller
   and the reveal pair; the services come from useStudy(). Tests that wrote the old flat props keep their fixtures through this adapter:
     h(StudyMap, mapProps({ data, start: noop, resume: noop, notebooks: state, ... }))
   Props that are services now (busy, call, askInChat, endRun, cancelJob, dismissJob, onFocus...) are dropped: the page reads the standalone
   services unless the test provides a StudyServicesContext. */
const ACTIONS = ['start', 'resume', 'manage', 'removeDeck', 'openDraft', 'continueDraft', 'retryGeneration', 'addSource', 'createManual', 'importLibrary',
  'generateFromSources', 'startCourseFlow', 'onCoachPractice', 'onWeakPoints', 'onShowGraph', 'onCourseSettings'];

export function mapProps(old = {}) {
  const actions = Object.fromEntries(ACTIONS.filter(key => old[key] !== undefined).map(key => [key, old[key]]));
  const hasNotebooks = old.notebooks !== undefined || old.onNotebookPublish || old.onNotebookOpen;
  return {
    data: old.data, actions, setupHandlers: old.setupHandlers, reveal: old.reveal, onRevealed: old.onRevealed, children: old.children,
    ...(hasNotebooks ? { notebooks: { notebooks: old.notebooks, notebookError: old.notebookError, publish: old.onNotebookPublish, unpublish: old.onNotebookUnpublish,
      open: old.onNotebookOpen, loadNotebooks: old.refreshNotebooks, search: old.onNotebookSearch } } : {}),
  };
}
