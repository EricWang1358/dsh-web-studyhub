import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { leaveDelayMs } from '../appearance-prefs.js';
import { createNavigator } from './navigator.js';

/* Which page is showing, and the one way to change it (ui/app/navigator.js). The `show*` verbs are what a learning
   target does when it arrives: they set the page's own state and the page together, so nothing else does it by hand. */
export function useNavigation({ core, lib, motion, rootRef }) {
  const [page, setPage] = useState('library');
  const [pageTarget, setPageTarget] = useState(null);
  const { setError } = core;
  const { setContextTrail, setExamRunId, setExamKind, setBoardStudyRef, setNoteInitialId, setGraphScope, setSkeletonFocus, setManagedDeck,
    setFolderDraft, setWorkflowReturn, setTaskFocus } = lib.set;
  const motionRef = useRef(motion), pageRef = useRef(page), referenceRef = useRef(() => null);
  motionRef.current = motion;
  pageRef.current = page;
  const { refs } = core;
  const navigator = useMemo(() => createNavigator({
    getPage: () => pageRef.current,
    setPage, setPageTarget, setError,
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
        openBoardFresh: () => setBoardStudyRef(reference),
        clearNote: () => setNoteInitialId(''),
        clearGraphScope: () => setGraphScope(null),
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);
  useEffect(() => () => clearTimeout(refs.leaveTimer.current), [refs]);
  const navigate = navigator.navigate;
  const show = useMemo(() => ({
    note: (id) => { setNoteInitialId(id); setPage('notes'); },
    skeleton: (id) => { setSkeletonFocus(id); setPage('skeleton'); },
    deck: (deck) => { setManagedDeck(deck); setFolderDraft(deck.folder || ''); setPage('manage'); },
    managedDeck: (deck) => { setManagedDeck(deck); setPage('manage'); },
    task: (jobId) => { setTaskFocus({ jobId, nonce: Date.now() }); setPage('tasks'); },
    workflow: (sessionId) => { setWorkflowReturn({ sessionId, nonce: Date.now() }); setPage('workflows'); },
    exam: (kind, runId) => { setExamKind(kind); setExamRunId(runId); setPage('exam'); },
    library: () => setPage('library'),
    page: (id) => setPage(id),
  }), [setNoteInitialId, setSkeletonFocus, setManagedDeck, setFolderDraft, setWorkflowReturn, setTaskFocus, setExamKind, setExamRunId]);
  const resetPage = useCallback(() => { setPageTarget(null); setPage('library'); }, []);
  return { page, setPage, pageTarget, setPageTarget, navPage: pageTarget || page, navigate, show, resetPage, referenceRef };
}
