import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ui, uiFormat, errorMessage } from '../i18n.js';
import { browserStorage } from '../storage.js';
import { backLabelOf, navLabelOf } from '../pages.js';
import { trailKindOf } from '../review/way-back.js';
import {
  ABORT, captureContext as captureOrigin, currentStudyReference as referenceOf, leavesTrail, loadLearningTarget, loadReturnTarget,
  openLearningTarget as openTarget, openReturnTarget, practiceArgs, returnTargetFor, withoutSelfReturn,
} from '../learning-navigation.js';
import {
  capturePracticeFrame, clearLastPracticePosition, originKindForDestination, peekPracticeFrame, popPracticeFrame, popToOriginalFrame,
  pushPracticeFrame, readLastPracticePosition, restorePracticeFrame, rootPracticeFrame, saveLastPracticePosition,
} from '../practice-context-stack.js';

const restoreFallbackText = () => ui('已回到原位置，但没能切回之前的课程。可以在学习库重新切换当前课程。');

async function restoreCourseFocus({ origin, currentCourse, call, live }) {
  if (!origin.courseSwitched) return null;
  if (typeof origin.course !== 'string' && origin.course !== null) return null;
  if (currentCourse === origin.course) return null;
  let restored;
  let failureMessage = null;
  try {
    restored = await call('focus.set', { course: origin.course });
    if (!live()) return { aborted: true };
    if (!restored) failureMessage = restoreFallbackText();
  } catch (error) {
    if (!live()) return { aborted: true };
    const reason = errorMessage(error);
    failureMessage = reason
      ? uiFormat('已回到原位置，但没能切回之前的课程：{0}。可以在学习库重新切换当前课程。', [reason])
      : restoreFallbackText();
  }
  return { aborted: false, restored: Boolean(restored), failureMessage };
}

/**
 * Restore any focus course switched when leaving for a cross-course page, reload the return destination,
 * refresh the library snapshot, and switch back without letting a course-restore failure strand the learner.
 */
export async function executeContextReturn({
  origin, currentCourse, getSources, call, refresh, verbs, setModal, setContextTrail, setFocusRequest, setError, live = () => true,
}) {
  let courseRestore = null;
  try {
    setError('');
    courseRestore = await restoreCourseFocus({ origin, currentCourse, call, live });
    if (courseRestore?.aborted || !live()) return false;

    const target = returnTargetFor(origin);
    const loaded = await loadReturnTarget(target, origin, call);
    if (!live()) return false;

    let refreshMessage = null;
    if (courseRestore?.restored && typeof refresh === 'function') {
      try {
        await refresh();
      } catch (error) {
        if (!live()) return false;
        refreshMessage = errorMessage(error);
      }
      if (!live()) return false;
    }

    // A page may ask to know it is being returned to (the review book puts the focus on the point the learner left); only a return does this, never a later visit.
    origin.arrive?.();
    openReturnTarget(target, loaded, origin, verbs);
    if (origin.modal) {
      const source = await call('source.get', { id: origin.modal.sourceId });
      if (!live()) return false;
      setModal({ type: 'source', source: getSources?.()?.find((item) => item.id === source.id) || source, quote: origin.modal.quote });
    } else setModal(null);
    setContextTrail((previous) => previous.slice(0, -1));
    setFocusRequest({ element: origin.invoker });
    const warning = courseRestore?.failureMessage || refreshMessage;
    if (warning) setError(warning);
    return true;
  } catch (error) {
    if (courseRestore?.restored && typeof refresh === 'function') {
      void Promise.resolve(refresh()).catch(() => {});
    }
    if (live()) setError(errorMessage(error));
    return false;
  }
}

/* Links between learning objects and the way back (ui-consistency #110): open a card, source, note, deck or exam from anywhere,
   remember where the learner was, and return there. What each kind loads and shows is the table in ui/learning-navigation.js;
   this hook owns the trail, the stale-request guard and the focus that follows an arrival. */
export function useLearningNavigation({ core, lib, nav, session, rootRef }) {
  const { call, setError, notify, refresh, refs } = core;
  const { setModal, setContextTrail, setPracticeStack, setPracticeEnded, setFocusRequest, setDetour } = lib.set;
  const latest = useRef(null);
  const liveEntryOf = () => session.getLive?.()?.entry ?? session.entry;
  latest.current = { page: nav.page, run: session.run, entry: liveEntryOf(), state: lib.state, flushDraft: session.flushDraft, getLive: session.getLive };
  const safeStorage = () => browserStorage();

  // The verbs a learning target is shown with: the page's own state and the page are set together.
  const verbs = useMemo(() => ({
    enterRun: session.enterRun,
    enterMovedRun: session.enterMovedRun,
    showSource: (source, quote) => setModal({ type: 'source', source, quote }),
    showNote: nav.show.note, showSkeleton: nav.show.skeleton, showDeck: nav.show.deck, showManagedDeck: nav.show.managedDeck,
    showWorkflow: nav.show.workflow, showExam: nav.show.exam, showLibrary: nav.show.library, showPage: nav.show.page,
  }), [session.enterRun, session.enterMovedRun, nav.show, setModal]);

  const [lastPracticeVersion, setLastPracticeVersion] = useState(0);
  const bumpLastPractice = useCallback(() => setLastPracticeVersion((v) => v + 1), []);

  const pushPracticeContext = useCallback((overrides = {}) => {
    const { run, state, getLive } = latest.current;
    const entry = getLive?.()?.entry ?? latest.current.entry;
    const root = refs.dataRef.current?.root || '';
    const frame = capturePracticeFrame({
      root,
      run,
      entry,
      course: refs.dataRef.current?.focus?.course ?? null,
      reading: state.modal?.type === 'source' ? { sourceId: state.modal.source?.id || '', quote: state.modal.quote || '' } : null,
      ...overrides,
    });
    if (!frame) return null;
    setPracticeStack((previous) => pushPracticeFrame(previous, frame));
    setPracticeEnded(null);
    saveLastPracticePosition(safeStorage(), root, frame);
    bumpLastPractice();
    return frame;
  }, [bumpLastPractice, refs, setPracticeEnded, setPracticeStack]);

  if (nav.leaveReviewRef) {
    nav.leaveReviewRef.current = (nextPage) => {
      const { run, state } = latest.current;
      if (run?.id && run?.card?.id && !run.complete) {
        pushPracticeContext({ originKind: originKindForDestination(nextPage, state.modal) });
      }
    };
  }

  // Persist last practice position on key transitions (run/index/card change) only — zero polling.
  const activeRunId = session.run?.id || '';
  const activeRunIndex = session.run?.index;
  const activeCardId = session.run?.card?.id || '';
  const activeRunComplete = Boolean(session.run?.complete || session.run?.closed);
  const currentRoot = refs.dataRef.current?.root || '';
  useEffect(() => {
    if (!currentRoot || !activeRunId || !activeCardId) return;
    if (activeRunComplete) {
      clearLastPracticePosition(safeStorage(), currentRoot);
      bumpLastPractice();
      return;
    }
    const { run: currentRun, getLive, entry: fallbackEntry } = latest.current;
    const frame = capturePracticeFrame({
      root: currentRoot,
      run: currentRun,
      entry: getLive?.()?.entry ?? fallbackEntry,
      originKind: 'other',
      course: refs.dataRef.current?.focus?.course ?? null,
    });
    if (frame) {
      saveLastPracticePosition(safeStorage(), currentRoot, frame);
      bumpLastPractice();
    }
  }, [currentRoot, activeRunId, activeRunIndex, activeCardId, activeRunComplete, bumpLastPractice, refs]);

  const captureContext = useCallback((overrides = {}) => {
    const { page, run, state, getLive } = latest.current;
    const entry = getLive?.()?.entry ?? latest.current.entry;
    return captureOrigin({ root: refs.dataRef.current?.root, page, run, entry, noteInitialId: state.noteInitialId, skeletonFocus: state.skeletonFocus,
      managedDeck: state.managedDeck, exam: refs.examLocation.current, workflowReturn: state.workflowReturn, modal: state.modal,
      invoker: rootRef.current?.contains(document.activeElement) ? document.activeElement : null }, overrides);
  }, [refs, rootRef]);
  const rememberContext = useCallback((origin = captureContext()) => {
    if (origin?.page === 'review' && latest.current.run?.card?.id) {
      pushPracticeContext({
        originKind: origin.originKind || 'other',
        course: origin.course ?? refs.dataRef.current?.focus?.course ?? null,
        courseSwitched: Boolean(origin.courseSwitched),
      });
    }
    setContextTrail((previous) => [...previous, origin]);
    setFocusRequest({});
  }, [captureContext, pushPracticeContext, refs, setContextTrail, setFocusRequest]);
  const contextLabel = useCallback((origin) => {
    if (origin?.modal) return ui('返回资料');
    if (origin?.page === 'review') return origin.runComplete ? ui('返回本轮学习结果') : uiFormat('回到之前的第 {0} 题', [(origin.index || 0) + 1]);
    if (origin?.page === 'exam') return origin.exam?.kind === 'oral' ? ui('返回口头模拟') : ui('返回笔试');
    if (backLabelOf(origin?.page)) return ui(backLabelOf(origin.page));
    return uiFormat('返回{0}', [ui(navLabelOf(origin?.page) || '原位置')]);
  }, []);

  // A request is live while the library and the navigation it started under are still the current ones.
  const guard = useCallback(() => {
    const epoch = refs.epoch.current, request = ++refs.navigation.current;
    return () => epoch === refs.epoch.current && request === refs.navigation.current;
  }, [refs]);
  const env = (live) => ({ live, data: () => refs.dataRef.current, refresh });

  // What was typed on the open question is in the library before a link leaves it (#537). False: it could not be saved, the session has said so, stay here.
  const draftSaved = useCallback(async () => (await latest.current.flushDraft?.()) !== false, []);

  /** Local links keep a small trail; ordinary sidebar navigation starts afresh. */
  const openTargetNow = useCallback(async (target, { remember = true, throwOnError = false } = {}) => {
    if (!(await draftSaved())) return;
    const origin = captureContext(), live = guard();
    setError('');
    try {
      const result = await loadLearningTarget(target, call, env(live));
      if (result === ABORT || !live()) return;
      if (remember && leavesTrail(target)) rememberContext(origin);
      setModal(null);
      openTarget(target, result, verbs, env(live));
      if (leavesTrail(target)) setFocusRequest({});
    } catch (error) {
      if (live()) { if (throwOnError) throw error; setError(errorMessage(error)); }
    }
  }, [call, captureContext, draftSaved, guard, rememberContext, setError, setModal, setFocusRequest, verbs]); // eslint-disable-line react-hooks/exhaustive-deps
  // A target that leaves the page asks before anything starts (a course target switches the course while it loads; a card starts a run). A learner who stays: nothing happened, nothing settles.
  const { leaving } = nav;
  const openLearningTarget = useCallback((target, options) => new Promise((resolve, reject) => {
    const go = () => openTargetNow(target, options).then(resolve, reject);
    if (leavesTrail(target)) leaving(go); else go();
  }), [leaving, openTargetNow]);

  const currentStudyReference = useCallback(() => {
    const { page, run, state } = latest.current;
    return referenceOf({ root: refs.dataRef.current?.root, page, run, noteInitialId: state.noteInitialId, skeletonFocus: state.skeletonFocus,
      managedDeck: state.managedDeck, workflowReturn: state.workflowReturn, exam: refs.examLocation.current, modal: state.modal,
      focus: refs.dataRef.current?.focus });
  }, [refs]);
  nav.referenceRef.current = currentStudyReference;

  const sameRoot = (value) => String(value || '').replaceAll('\\', '/').toLowerCase();
  const openBoardReference = useCallback(async (reference) => {
    if (sameRoot(reference.root) !== sameRoot(refs.dataRef.current?.root))
      throw new Error(ui('这条待办来自另一个学习库。请先在设置中切换到其学习库，再打开关联内容。'));
    if (reference?.kind === 'companion' && reference.id) {
      await refresh();
      setModal({
        type: 'companion',
        id: reference.id,
        ...(reference.course ? { course: reference.course } : {}),
        ...(reference.slide >= 1 ? { slide: reference.slide, initialSlide: reference.slide } : {}),
        ...(reference.title ? { title: reference.title } : {}),
      });
      return;
    }
    await openLearningTarget(reference, { throwOnError: true });
  }, [openLearningTarget, refresh, refs, setModal]);
  const openBoardWithContext = useCallback(() => {
    const reference = currentStudyReference();
    // 「加入待办」 is the learner asking for a card about this: the board opens its composer with the link attached.
    if (reference) { rememberContext(); lib.set.setBoardStudyRef(reference); lib.set.setBoardCompose(true); lib.set.setBoardView?.('all'); }
    nav.navigate('board');
  }, [currentStudyReference, rememberContext, lib.set, nav]);

  /* Arriving on the library with its own page as the way back (a first import remembers the library, the learner generates and lands here): the way back leads nowhere, so it goes. */
  const onPage = nav.page;
  useEffect(() => {
    if (onPage !== 'library') return;
    setContextTrail((trail) => withoutSelfReturn(trail, 'library'));
  }, [onPage, setContextTrail]);

  const returnFromContext = useCallback(async () => {
    if (!(await draftSaved())) return;
    const origin = latest.current.state.contextTrail.at(-1), live = guard();
    if (!origin || origin.root !== refs.dataRef.current?.root) { setContextTrail([]); return; }
    await executeContextReturn({
      origin,
      currentCourse: refs.dataRef.current?.focus?.course ?? null,
      getSources: () => refs.dataRef.current?.sources,
      call,
      refresh,
      verbs,
      setModal,
      setContextTrail,
      setFocusRequest,
      setError,
      live,
    });
  }, [call, draftSaved, guard, refresh, refs, setContextTrail, setError, setFocusRequest, setModal, verbs]);

  // Back to the question a letter took the learner away from.
  const returnFromDetour = useCallback(async () => {
    const back = latest.current.state.detour;
    if (!back || !(await draftSaved())) return;
    const live = guard();
    if (back.root !== refs.dataRef.current?.root) { setDetour(null); return; }
    try {
      const next = await call('review.move', { runId: back.runId, index: back.index });
      if (!live()) return;
      session.enterMovedRun(next, back.input);
      setDetour(null);
      setFocusRequest({ element: back.invoker });
    } catch (error) { if (live()) setError(error.message); }
  }, [call, draftSaved, guard, refs, session, setDetour, setError, setFocusRequest]);

  // Reopen the reader where the learner was: the section, the offset into it and the scroll position of the stored context.
  const returnToReading = useCallback((reading) => {
    const source = refs.dataRef.current?.sources.find((item) => item.id === reading?.sourceId);
    if (!source) { notify({ text: ui('这份资料已不在资料库里，无法回到阅读。'), tone: 'warning' }); return; }
    nav.navigate(navLabelOf(reading.origin?.page) ? reading.origin.page : 'sources');
    setModal({ type: 'source', source, resume: { ...reading, nonce: Date.now() } });
  }, [nav, notify, refs, setModal]);

  // Letters about a transcript or a conversion open the sources they produced; a letter about several opens the list.
  const openAudioSources = useCallback((sourceIds) => {
    const available = sourceIds.map((id) => (refs.dataRef.current?.sources || []).find((source) => source.id === id)).filter(Boolean);
    if (!available.length) { notify(ui('这份资料已被删除。')); return; }
    setModal(available.length === 1 ? { type: 'source', source: available[0] } : { type: 'sources', sourceIds });
  }, [notify, refs, setModal]);

  const restoreFromFrame = useCallback(async (frame, nextStack) => {
    const live = guard();
    setError('');
    setPracticeEnded(null);
    if (!frame || (frame.root && frame.root !== (refs.dataRef.current?.root || ''))) {
      setPracticeStack([]);
      return false;
    }
    let courseRestore = null;
    if (frame.courseSwitched) {
      courseRestore = await restoreCourseFocus({
        origin: frame,
        currentCourse: refs.dataRef.current?.focus?.course ?? null,
        call,
        live,
      });
      if (courseRestore?.aborted || !live()) return false;
    }
    const result = await restorePracticeFrame({
      frame,
      call,
      enterMovedRun: (loadedRun, draft) => {
        setModal(null);
        session.enterMovedRun(loadedRun, draft);
      },
      onEnded: (endedPayload) => {
        setPracticeEnded(endedPayload);
      },
    });
    if (!live()) return false;
    let refreshMessage = null;
    if (courseRestore?.restored && typeof refresh === 'function') {
      try {
        await refresh();
      } catch (error) {
        if (!live()) return false;
        refreshMessage = errorMessage(error);
      }
      if (!live()) return false;
    }
    const warning = courseRestore?.failureMessage || refreshMessage;
    if (warning) setError(warning);
    if (result.status === 'restored') {
      setPracticeStack(nextStack);
      setContextTrail((previous) => (previous.at(-1)?.page === 'review' ? previous.slice(0, -1) : previous));
      setFocusRequest({});
      return true;
    }
    if (result.status === 'ended') {
      setPracticeStack(nextStack);
      clearLastPracticePosition(safeStorage(), refs.dataRef.current?.root || '');
      bumpLastPractice();
      return false;
    }
    return false;
  }, [bumpLastPractice, call, guard, refresh, refs, session, setContextTrail, setError, setFocusRequest, setModal, setPracticeEnded, setPracticeStack]);

  const returnFromPracticeStack = useCallback(async () => {
    if (!(await draftSaved())) return false;
    let outcome = false;
    nav.leaving(() => {
      const { frame, stack: nextStack } = popPracticeFrame(latest.current.state.practiceStack);
      if (!frame) return;
      outcome = restoreFromFrame(frame, nextStack);
    });
    return outcome;
  }, [draftSaved, nav, restoreFromFrame]);

  const returnToOriginalPractice = useCallback(async () => {
    if (!(await draftSaved())) return false;
    let outcome = false;
    nav.leaving(() => {
      const { frame, stack: nextStack } = popToOriginalFrame(latest.current.state.practiceStack);
      if (!frame) return;
      outcome = restoreFromFrame(frame, nextStack);
    });
    return outcome;
  }, [draftSaved, nav, restoreFromFrame]);

  const resumeLastPractice = useCallback(async () => {
    let outcome = false;
    nav.leaving(() => {
      const root = refs.dataRef.current?.root || '';
      const saved = readLastPracticePosition(safeStorage(), root);
      if (!saved) return;
      outcome = restoreFromFrame(saved, []);
    });
    return outcome;
  }, [nav, refs, restoreFromFrame]);

  const dismissPracticeEnded = useCallback(() => setPracticeEnded(null), [setPracticeEnded]);

  const practiceEndedAgain = useCallback(async (scope) => {
    if (!Array.isArray(scope) || !scope.length) return;
    nav.leaving(async () => {
      setPracticeEnded(null);
      const live = guard();
      setError('');
      try {
        const next = await call('review.start', practiceArgs(scope, { fresh: true }));
        if (!live()) return;
        setModal(null);
        session.enterRun(next);
      } catch (error) {
        if (live()) setError(errorMessage(error));
      }
    });
  }, [call, guard, nav, session, setError, setModal, setPracticeEnded]);

  // A source opened where a place of its text is (a part of a question run, 在资料中查看): the reader is told the offset and finds the section it is in (the library's snapshot has no text to
  // do it here), the way the way back to a stored reading position hands it a section.
  const openSourceAt = useCallback((sourceId, offset) => {
    const source = (refs.dataRef.current?.sources || []).find((item) => item.id === sourceId);
    if (!source) { notify(ui('这份资料已被删除。')); return; }
    setModal({ type: 'source', source, resume: { at: Math.max(0, Number(offset) || 0), sectionOffset: 0, scrollTop: 0, progress: 0, nonce: Date.now() } });
  }, [notify, refs, setModal]);

  // After an arrival, the heading (or the control the learner came from) takes focus.
  const focusRequest = lib.state.focusRequest;
  useEffect(() => {
    if (!focusRequest) return undefined;
    const frame = requestAnimationFrame(() => {
      if (focusRequest.skipOpenDialog && rootRef.current?.querySelector('dialog[open]')) return;
      // A page that put the learner back at a place of its own (the review book: the point they left) names its heading; that one takes the focus, where it is.
      const placed = rootRef.current?.querySelector('[data-return-focus]');
      const target = focusRequest.element?.isConnected && focusRequest.element.getClientRects().length ? focusRequest.element
        : placed?.getClientRects().length ? placed
          : [...(rootRef.current?.querySelectorAll('dialog[open] h2, .question-card, .question[role="heading"], [data-context-heading], main .page h1, main .page h2') || [])]
            .find((element) => element.getClientRects().length);
      if (target) {
        if (target.contains(document.activeElement)) return;
        if (!target.matches('button,a,input,select,textarea,[tabindex]')) target.setAttribute('tabindex', '-1');
        target.focus(target === placed || focusRequest.preventScroll ? { preventScroll: true } : undefined);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequest, nav.page]); // eslint-disable-line react-hooks/exhaustive-deps

  const trail = lib.state.contextTrail;
  const practiceStack = lib.state.practiceStack || [];
  // Always read from storage (the one source of truth), never from a copy kept in state: another library or tab can change it while this root is not current.
  // The version says "storage was written, read it again"; a change of root or of the stack says the same.
  const lastPractice = useMemo(() => {
    void lastPracticeVersion;
    return practiceStack.length === 0 && currentRoot ? readLastPracticePosition(safeStorage(), currentRoot) : null;
  }, [currentRoot, practiceStack.length, lastPracticeVersion]);
  return { captureContext, rememberContext, contextLabel, openLearningTarget, currentStudyReference, openBoardReference, openBoardWithContext,
    returnFromContext, returnFromDetour, returnToReading, openAudioSources, openSourceAt, verbs,
    practiceStack, practiceTop: peekPracticeFrame(practiceStack), practiceOrigin: rootPracticeFrame(practiceStack),
    practiceEnded: lib.state.practiceEnded, lastPractice,
    pushPracticeContext, returnFromPracticeStack, returnToOriginalPractice, resumeLastPractice, dismissPracticeEnded, practiceEndedAgain,
    trailLabel: trail.length ? contextLabel(trail.at(-1)) : '', trailPage: trailKindOf(trail.at(-1)), trailPlace: trail.at(-1)?.place || '', hasTrail: trail.length > 0 };
}
