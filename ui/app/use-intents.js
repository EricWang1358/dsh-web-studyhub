import { useCallback, useMemo, useRef, useState } from 'react';
import { practiceArgs } from '../learning-navigation.js';
import { dailyPathArgs } from '../study-map/home-plan.js';

/* What the learner means, said once (ui-consistency #114): "go and make questions", "open this deck", "practise these".
   Every button that means one of these calls it here, so a change such as "always keep the way back" is made in one place. */
export function useIntents({ core, lib, nav, session, learn }) {
  const { act, setError, refs } = core;
  const { setSelectedSources, setGen, setCaseInitial, setModal, setFocusRequest } = lib.set;
  // 创建题组 opens on generating from materials; JSON import is the second tab, a case paper the third.
  const [genSource, setGenSource] = useState('files');
  // A generation just started: the library home scrolls its progress card into view once.
  const [revealHome, setRevealHome] = useState(0);
  const latest = useRef(null);
  latest.current = { page: nav.page, run: session.run };

  /**
   * Open 创建题组. sourceIds ticks those materials (and, unless genPatch says otherwise, forgets the course); genPatch fills
   * the form ({ course } / { kind, count }); source is 'files' | 'json' | 'case'; remember keeps a way back to where the learner was.
   */
  const goGenerate = useCallback(({ source = 'files', sourceIds, genPatch, caseInitial, remember = false, closeModal = false } = {}) => {
    if (remember) learn.rememberContext();
    if (sourceIds) setSelectedSources(sourceIds);
    const patch = genPatch ?? (sourceIds ? { course: undefined } : null);
    if (patch) setGen((current) => ({ ...current, ...(typeof patch === 'function' ? patch(current) : patch) }));
    if (caseInitial) setCaseInitial(caseInitial);
    setGenSource(source);
    if (closeModal) setModal(null);
    nav.navigate('generate');
  }, [learn, nav, setSelectedSources, setGen, setCaseInitial, setModal]);

  /** Open a deck on 维护题组. */
  const openDeck = useCallback((id) => act('deck.get', { id }, nav.show.deck), [act, nav.show]);

  /**
   * Start a practice round on a scope of cards. fresh (default) starts a new run instead of resuming the open run of the same scope;
   * returnTo offers a way back to that run; extra goes to the host as is; then (default: open the run) says what happens with the started run.
   */
  const practice = useCallback((scope, { fresh = true, returnTo, extra, then } = {}) =>
    act('review.start', practiceArgs(scope, { fresh, returnTo, ...extra }), then || session.enterRun), [act, session.enterRun]);

  /** Any other review.start (the library map picks its own mode and scope), a resume, a run by id. */
  const startReview = useCallback((args) => act('review.start', args, session.enterRun), [act, session.enterRun]);
  const openRun = useCallback((runId) => act('review.get', { runId }, session.enterRun), [act, session.enterRun]);

  // 读 → 做这几页的题 → 回到阅读: the run keeps where the learner was reading (lib/reading-return.js), so the way back is on the
  // run itself and survives closing the app; nothing is held only in memory.
  const practiceFromReading = useCallback(({ refs: pages, reading }) => {
    if (!pages?.length || !reading) return undefined;
    return practice(pages, { extra: { reading: { ...reading, origin: { page: latest.current.page } } },
      then: (started) => { setModal(null); session.enterRun(started); setFocusRequest({}); } });
  }, [practice, session, setModal, setFocusRequest]);

  /** 先讲后练: a guided learning flow on the course route's next batch. */
  const startCourseFlow = useCallback((extra = {}) => act('workflow.quickstart', { course: true, requestId: crypto.randomUUID(), ...extra },
    (result) => nav.show.workflow(result.session.id)), [act, nav.show]);

  /** S from anywhere: resume the last round, start today's path (the one the home card starts), or (with no decks) go and make some. */
  const resumeOrStart = useCallback(() => {
    setError('');
    const { page, run } = latest.current, data = refs.dataRef.current;
    if (page === 'review' && run && !run.complete) return;
    if (data?.lastRun) openRun(data.lastRun.id);
    else if (data?.decks.length) act('review.start', dailyPathArgs(data.today), session.enterRun);
    else goGenerate();
  }, [act, goGenerate, openRun, refs, session.enterRun, setError]);

  return useMemo(() => ({ genSource, setGenSource, revealHome, setRevealHome, goGenerate, openDeck, practice, startReview, openRun, practiceFromReading,
    startCourseFlow, resumeOrStart }),
  [genSource, revealHome, goGenerate, openDeck, practice, startReview, openRun, practiceFromReading, startCourseFlow, resumeOrStart]);
}
