import { useCallback, useMemo, useRef, useState } from 'react';
import { practiceArgs, readingPracticeArgs } from '../learning-navigation.js';
import { dailyPathArgs } from '../study-map/home-plan.js';
import { sameScope } from '../study-map/map-model.js';

/** If a poll brought an open round for this confirmation while it was on screen, return that run so confirm resumes it instead of starting another. */
export function resumableRunForStart(ask, data) {
  if (!ask || !data) return null;
  if (ask.kind === 'today') return data.lastRun || null;
  if ((ask.kind === 'deck' || ask.kind === 'topic') && Array.isArray(ask.scope) && Array.isArray(data.runs)) {
    return data.runs.find((item) => item?.mode === 'path' && sameScope(item.scope, ask.scope)) || null;
  }
  return null;
}

/* What the learner means, said once (ui-consistency #114): "go and make questions", "open this deck", "practise these".
   Every button that means one of these calls it here, so a change such as "always keep the way back" is made in one place. */
export function useIntents({ core, lib, nav, session, learn }) {
  const { act, setError, refs } = core;
  const { setSelectedSources, setGen, setCaseInitial, setModal, setStartConfirm, setFocusRequest } = lib.set;
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
  const startReview = useCallback((args, options) => act('review.start', args, session.enterRun, options), [act, session.enterRun]);
  // Opening an existing run reads it directly; holding the busy lock behind a full library refresh blocks the first shortcut press.
  const openRun = useCallback((runId) => act('review.get', { runId }, session.enterRun, { refreshAfter: false }), [act, session.enterRun]);

  /**
   * Ask before a start that one mis-click could make: the round would take over the home's card, 回到题目 and the deck row. `ask` is { kind: 'deck' |
   * 'topic', name, scope } or { kind: 'today' } (the dialog words it: ui/app/modals/StartConfirmDialog.jsx); `start` runs on the confirm only, and only
   * in the library it was asked in. Stacks above any open dialog (`startConfirm`) so cancelling leaves the underlying dialog mounted and intact.
   * The three places that ask: a deck row's ▶, a topic row's ▶ and resumeOrStart. A round that is resumed is never asked about.
   */
  const confirmStart = useCallback((ask, start, { keepModal = false } = {}) => {
    const root = refs.dataRef.current?.root;
    setStartConfirm({
      root,
      ask,
      start: () => {
        const live = refs.dataRef.current;
        if (live?.root !== root) return;
        if (!keepModal) {
          setModal(null);
          const existing = resumableRunForStart(ask, live);
          if (existing) { openRun(existing.id); return; }
        }
        start();
      },
    });
  }, [openRun, refs, setModal, setStartConfirm]);

  // 读 → 做这几页的题 → 回到阅读: the run keeps where the learner was reading (lib/reading-return.js), so the way back is on the
  // run itself and survives closing the app; nothing is held only in memory. `then` (the reader's 本节题目, #1013) keeps the round in the reader
  // instead of going to the practice page: the same request, only where it is answered differs (`takeUp`: see readingPracticeArgs).
  const practiceFromReading = useCallback(({ refs: pages, reading }, { then, takeUp = false } = {}) => {
    if (!pages?.length || !reading) return undefined;
    return act('review.start', readingPracticeArgs(pages, reading, latest.current.page, { takeUp }),
      then || ((started) => { setModal(null); session.enterRun(started); setFocusRequest({}); }));
  }, [act, session, setModal, setFocusRequest]);

  /** S from anywhere: resume the last round, start today's path (the one the home card starts, asked about first), or (with no decks) go and make some. */
  const resumeOrStart = useCallback(() => {
    setError('');
    const { page, run } = latest.current, data = refs.dataRef.current;
    if (page === 'review' && run && !run.complete) return;
    const expectedRoot = data?.root;
    const go = () => nav.leaving(() => {
      const live = refs.dataRef.current;
      if (expectedRoot !== undefined && live?.root !== expectedRoot) return;
      setModal(null);
      const existing = resumableRunForStart({ kind: 'today' }, live);
      if (existing) openRun(existing.id);
      else if (live?.decks?.length) startReview(dailyPathArgs(live.today));
      else goGenerate();
    });
    // nav.leaving (the unsaved-work gate) is asked before a run is opened or started, not when the run arrives; a start asks the learner first.
    if (!data?.lastRun && data?.decks.length) {
      confirmStart({ kind: 'today' }, go, { keepModal: true });
      return;
    }
    go();
  }, [confirmStart, goGenerate, nav, openRun, refs, setError, setModal, startReview]);

  return useMemo(() => ({ genSource, setGenSource, revealHome, setRevealHome, goGenerate, openDeck, practice, startReview, openRun, practiceFromReading, confirmStart, resumeOrStart }),
  [genSource, revealHome, goGenerate, openDeck, practice, startReview, openRun, practiceFromReading, confirmStart, resumeOrStart]);
}
