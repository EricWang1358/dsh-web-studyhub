import { useCallback, useEffect, useMemo, useRef } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { navLabelOf } from '../pages.js';
import {
  ABORT, captureContext as captureOrigin, currentStudyReference as referenceOf, leavesTrail, loadLearningTarget, loadReturnTarget,
  openLearningTarget as openTarget, openReturnTarget, returnTargetFor,
} from '../learning-navigation.js';

/* Links between learning objects and the way back (ui-consistency #110): open a card, source, note, deck or exam from anywhere,
   remember where the learner was, and return there. What each kind loads and shows is the table in ui/learning-navigation.js;
   this hook owns the trail, the stale-request guard and the focus that follows an arrival. */
export function useLearningNavigation({ core, lib, nav, session, rootRef }) {
  const { call, act, setError, notify, refresh, refs } = core;
  const { setModal, setContextTrail, setFocusRequest, setDetour } = lib.set;
  const latest = useRef(null);
  latest.current = { page: nav.page, run: session.run, entry: session.entry, state: lib.state };

  // The verbs a learning target is shown with: the page's own state and the page are set together.
  const verbs = useMemo(() => ({
    enterRun: session.enterRun,
    showSource: (source, quote) => setModal({ type: 'source', source, quote }),
    showNote: nav.show.note, showSkeleton: nav.show.skeleton, showDeck: nav.show.deck, showManagedDeck: nav.show.managedDeck,
    showWorkflow: nav.show.workflow, showExam: nav.show.exam, showLibrary: nav.show.library, showPage: nav.show.page,
  }), [session.enterRun, nav.show, setModal]);

  const captureContext = useCallback((overrides = {}) => {
    const { page, run, entry, state } = latest.current;
    return captureOrigin({ root: refs.dataRef.current?.root, page, run, entry, noteInitialId: state.noteInitialId, skeletonFocus: state.skeletonFocus,
      managedDeck: state.managedDeck, exam: refs.examLocation.current, workflowReturn: state.workflowReturn, modal: state.modal,
      invoker: rootRef.current?.contains(document.activeElement) ? document.activeElement : null }, overrides);
  }, [refs, rootRef]);
  const rememberContext = useCallback((origin = captureContext()) => {
    setContextTrail((previous) => [...previous, origin]);
    setFocusRequest({});
  }, [captureContext, setContextTrail, setFocusRequest]);
  const contextLabel = useCallback((origin) => {
    if (origin?.modal) return ui('返回资料');
    if (origin?.page === 'review') return origin.runComplete ? ui('返回本轮学习结果') : uiFormat('回到之前的第 {0} 题', [(origin.index || 0) + 1]);
    if (origin?.page === 'exam') return origin.exam?.kind === 'oral' ? ui('返回口头模拟') : ui('返回笔试');
    return uiFormat('返回{0}', [ui(navLabelOf(origin?.page) || '原位置')]);
  }, []);

  // A request is live while the library and the navigation it started under are still the current ones.
  const guard = useCallback(() => {
    const epoch = refs.epoch.current, request = ++refs.navigation.current;
    return () => epoch === refs.epoch.current && request === refs.navigation.current;
  }, [refs]);
  const env = (live) => ({ live, data: () => refs.dataRef.current, refresh });

  /** Local links keep a small trail; ordinary sidebar navigation starts afresh. */
  const openLearningTarget = useCallback(async (target, { remember = true, throwOnError = false } = {}) => {
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
      if (live()) { if (throwOnError) throw error; setError(error.message || String(error)); }
    }
  }, [call, captureContext, guard, rememberContext, setError, setModal, setFocusRequest, verbs]); // eslint-disable-line react-hooks/exhaustive-deps

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
    await openLearningTarget(reference, { throwOnError: true });
  }, [openLearningTarget, refs]);
  const openBoardWithContext = useCallback(() => {
    const reference = currentStudyReference();
    if (reference) { rememberContext(); lib.set.setBoardStudyRef(reference); }
    nav.navigate('board');
  }, [currentStudyReference, rememberContext, lib.set, nav]);

  const returnFromContext = useCallback(async () => {
    const origin = latest.current.state.contextTrail.at(-1), live = guard();
    if (!origin || origin.root !== refs.dataRef.current?.root) { setContextTrail([]); return; }
    try {
      const target = returnTargetFor(origin);
      const loaded = await loadReturnTarget(target, origin, call);
      if (!live()) return;
      openReturnTarget(target, loaded, origin, verbs);
      if (origin.modal) {
        const source = await call('source.get', { id: origin.modal.sourceId });
        if (!live()) return;
        setModal({ type: 'source', source: refs.dataRef.current.sources.find((item) => item.id === source.id) || source, quote: origin.modal.quote });
      } else setModal(null);
      setContextTrail((previous) => previous.slice(0, -1));
      setFocusRequest({ element: origin.invoker });
    } catch (error) { if (live()) setError(error.message || String(error)); }
  }, [call, guard, refs, setContextTrail, setError, setFocusRequest, setModal, verbs]);

  // Back to the question a letter took the learner away from.
  const returnFromDetour = useCallback(async () => {
    const back = latest.current.state.detour;
    if (!back) return;
    const live = guard();
    if (back.root !== refs.dataRef.current?.root) { setDetour(null); return; }
    try {
      const next = await call('review.move', { runId: back.runId, index: back.index });
      if (!live()) return;
      session.enterRun(next, back.input);
      setDetour(null);
      setFocusRequest({ element: back.invoker });
    } catch (error) { if (live()) setError(error.message); }
  }, [call, guard, refs, session, setDetour, setError, setFocusRequest]);

  // Reopen the reader where the learner was: the section, the offset into it and the scroll position of the stored context.
  const returnToReading = useCallback((reading) => {
    const source = refs.dataRef.current?.sources.find((item) => item.id === reading?.sourceId);
    if (!source) { notify({ text: ui('这份资料已不在资料库里，无法回到阅读。'), tone: 'warning' }); return; }
    nav.navigate(navLabelOf(reading.origin?.page) ? reading.origin.page : 'sources');
    setModal({ type: 'source', source, resume: { ...reading, nonce: Date.now() } });
  }, [nav, notify, refs, setModal]);

  // Letters about a transcript or a conversion open the sources they produced; a letter about several opens the list.
  const openAudioSources = useCallback((sourceIds) => {
    const available = sourceIds.map((id) => refs.dataRef.current.sources.find((source) => source.id === id)).filter(Boolean);
    if (!available.length) { notify(ui('逐字稿资料已被删除。')); return; }
    setModal(available.length === 1 ? { type: 'source', source: available[0] } : { type: 'sources', sourceIds });
  }, [notify, refs, setModal]);

  // After an arrival, the heading (or the control the learner came from) takes focus.
  const focusRequest = lib.state.focusRequest;
  useEffect(() => {
    if (!focusRequest) return undefined;
    const frame = requestAnimationFrame(() => {
      const target = focusRequest.element?.isConnected && focusRequest.element.getClientRects().length ? focusRequest.element
        : [...(rootRef.current?.querySelectorAll('dialog[open] h2, .question[role="heading"], [data-context-heading], main .page h1, main .page h2') || [])]
          .find((element) => element.getClientRects().length);
      if (target) {
        if (!target.matches('button,a,input,select,textarea,[tabindex]')) target.setAttribute('tabindex', '-1');
        target.focus();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequest, nav.page]); // eslint-disable-line react-hooks/exhaustive-deps

  const trail = lib.state.contextTrail;
  return { captureContext, rememberContext, contextLabel, openLearningTarget, currentStudyReference, openBoardReference, openBoardWithContext,
    returnFromContext, returnFromDetour, returnToReading, openAudioSources, verbs, trailLabel: trail.length ? contextLabel(trail.at(-1)) : '', hasTrail: trail.length > 0,
    act };
}
