import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { leaveDelayMs } from '../appearance-prefs.js';
import { createLeaveGate, createNavigator } from './navigator.js';
import { markPageSwitch } from '../use-session-performance.js';
import { deckCourseOf } from '../deck-course.js';

/* Which page is showing, and the one way to change it (ui/app/navigator.js). The `show*` verbs are what a learning
   target does when it arrives: they set the page's own state and the page together, so nothing else does it by hand.
   Every way out handed out here passes the leave gate (createLeaveGate, #489): a page with unsaved work holds it (`holdLeave`) and is asked first. The one exception is
   `forcePage`, for a library that is already gone: there is nothing left to stay on. */
export function useNavigation({ core, lib, motion, rootRef, initialPage = 'library' }) {
  const [page, setPageState] = useState(initialPage);
  // The one setter of the page: the session's performance log (ui/session-performance.js) starts the clock of a page switch here, whichever way it came.
  const rawSetPage = useCallback((id) => { markPageSwitch(id); setPageState(id); }, []);
  const [pageTarget, setPageTarget] = useState(null);
  const { setError } = core;
  const { setContextTrail, setExamRunId, setExamKind, setBoardStudyRef, setBoardCompose, setNoteInitialId, setGraphScope, setGraphMode, setSkeletonFocus, setManagedDeck,
    setFolderDraft, setWorkflowReturn, setTaskFocus, setStartConfirm } = lib.set;
  const motionRef = useRef(motion), pageRef = useRef(page), referenceRef = useRef(() => null), leaveReviewRef = useRef(null);
  motionRef.current = motion;
  pageRef.current = page;
  const { refs } = core;
  const gate = useMemo(() => createLeaveGate(() => pageRef.current), []);
  const navigator = useMemo(() => createNavigator({
    getPage: () => pageRef.current,
    setPage: rawSetPage, setPageTarget, setError,
    bumpNavigation: () => { refs.navigation.current++; },
    leaveTimer: refs.leaveTimer,
    clearTimer: (timer) => clearTimeout(timer),
    setTimer: (work, ms) => setTimeout(work, ms),
    leaveDelay: () => leaveDelayMs(motionRef.current),
    clearTrail: () => setContextTrail([]),
    // Each step of the tour starts at the top of its page; the tour then scrolls to the step's anchor.
    scrollTop: () => rootRef.current?.scrollTo?.({ top: 0 }),
    enterContext: (id) => {
      const reference = id === 'board' ? referenceRef.current() : null;
      return {
        resetExam: () => { setExamRunId(null); setExamKind('exam'); },
        // The sidebar keeps where the learner was for a card they choose to add, but opens nothing by itself (#576).
        openBoardFresh: () => { setBoardStudyRef(reference); setBoardCompose(false); },
        clearNote: () => setNoteInitialId(''),
        clearGraphScope: () => { setGraphScope(null); setGraphMode('structure'); },
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);
  useEffect(() => () => clearTimeout(refs.leaveTimer.current), [refs]);
  const navigate = useCallback((id, options) => gate.leave(id, () => {
    setStartConfirm?.(null);
    if (pageRef.current === 'review' && id !== 'review') leaveReviewRef.current?.(id, options);
    navigator.navigate(id, options);
  }), [gate, navigator, setStartConfirm]);
  const show = useMemo(() => {
    // The page's own state is set only once the learner has agreed to leave.
    const to = (id, before) => gate.leave(id, () => { setStartConfirm?.(null); before?.(); rawSetPage(id); });
    // Both ways onto the deck page start its course box from the deck on screen: a box left over from another deck would save that course onto this one.
    const manage = (deck) => to('manage', () => { setManagedDeck(deck); setFolderDraft(deckCourseOf(deck)); });
    return {
      note: (id) => to('notes', () => setNoteInitialId(id)),
      skeleton: (id) => to('skeleton', () => setSkeletonFocus(id)),
      deck: manage,
      managedDeck: manage,
      task: (jobId) => to('tasks', () => setTaskFocus({ jobId, nonce: Date.now() })),
      workflow: (sessionId) => to('workflows', () => setWorkflowReturn({ sessionId, nonce: Date.now() })),
      exam: (kind, runId) => to('exam', () => { setExamKind(kind); setExamRunId(runId); }),
      library: () => to('library'),
      page: (id) => to(id),
    };
  }, [gate, setNoteInitialId, setSkeletonFocus, setManagedDeck, setFolderDraft, setWorkflowReturn, setTaskFocus, setExamKind, setExamRunId, setStartConfirm, rawSetPage]);
  const setPage = show.page;
  const forcePage = useCallback((id) => rawSetPage(id), [rawSetPage]);
  // A change that is no page but replaces the one on screen (a link that first switches the course) asks before it starts.
  const leaving = useCallback((go) => gate.leave(null, go), [gate]);
  return { page, setPage, forcePage, pageTarget, setPageTarget, navPage: pageTarget || page, navigate, show, leaving, holdLeave: gate.hold, referenceRef, leaveReviewRef };
}
