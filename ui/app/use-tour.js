import { useMemo, useRef, useState } from 'react';
import { ui, uiFormat, getUiLanguage, errorMessage } from '../i18n.js';
import { hasContext, pageAvailable } from '../capabilities.js';
import { TOUR_STEPS, availableTourSteps, tourNeighbour } from '../tour/steps.js';
import { readTourProgress, writeTourProgress, welcomeDismissed, dismissWelcome } from '../tour/progress.js';
import { practiceArgs } from '../learning-navigation.js';

/* ── Onboarding (plan §5 WP5) ───────────────────────────────────────────────
   The welcome page of an empty library, the sample course (sample.* host actions, C6) and the feature tour that switches to
   each key page. Hosts without sample support send no `sample` in the snapshot; then the tour still runs and the steps that
   need sample data are left out. */
export function useTour({ core, lib, nav, session, drafts, intents, data, rootRef }) {
  const { call, act, setError, notify, refresh, refs } = core;
  const { setModal, setDraft, setSelectedSources, setSkeletonFocus } = lib.set;
  const [tourStep, setTourStep] = useState(null), [sampleBusy, setSampleBusy] = useState(false);
  // Which tour is running: the short one (the core chain) or, when the learner asked for it, the full one.
  const [fullTour, setFullTour] = useState(false);
  const [removingSample, setRemovingSample] = useState(false), [hiddenWelcome, setHiddenWelcome] = useState('');
  const tourOrigin = useRef(null), tourRound = useRef(null);
  const latest = useRef(null);
  latest.current = { page: nav.page, run: session.run };
  const page = nav.page;

  const modelState = data ? data.model || { ready: !!data.modelReady } : null;
  /** The steps of the short tour or of the full one, for what this library and host can show. */
  const stepsFor = (full) => data ? availableTourSteps(TOUR_STEPS, { sample: data.sample, full,
    pageAvailable: (id) => pageAvailable(data, id), hasContext: (id) => hasContext(data, id) }) : [];
  const savedTour = data?.root && !tourStep ? readTourProgress(data.root) : null;
  // While paused, the tour on offer is the one that was paused (the sidebar says "继续 3/8" for it).
  const shownFull = tourStep ? fullTour : !!savedTour?.full;
  const tourSteps = useMemo(() => stepsFor(shownFull), [data, shownFull]); // eslint-disable-line react-hooks/exhaustive-deps
  const resumeAt = savedTour && !savedTour.done ? tourSteps.findIndex((step) => step.id === savedTour.stepId) : -1;
  const tourResume = resumeAt > 0 ? { index: resumeAt, total: tourSteps.length } : null;
  const ownLibraryEmpty = !!data && !data.sources.some((source) => !source.sample) && !data.drafts.some((item) => !item.sample) &&
    !data.decks.some((deck) => !deck.systemKind && !deck.sample);
  const showWelcome = !!data?.sample && page === 'library' && !tourStep && hiddenWelcome !== data.root &&
    !welcomeDismissed(data.root) && (ownLibraryEmpty || !!data.sample.loaded);
  function hideWelcome() {
    if (!data?.root) return;
    dismissWelcome(data.root);
    setHiddenWelcome(data.root);
  }
  const openFirstImport = () => setModal({ type: 'add' });
  /** The tour switches pages at once: no leave animation, no stale context trail, each step starts at the top of its page. */
  const showPage = (id) => nav.navigate(id, { keepTrail: false, enter: 'tour', scroll: true });

  /** Start (or resume) a tour. It is the short one unless `full` says so; a paused tour comes back as the kind it was. */
  function startTour({ restart = false, full } = {}) {
    if (!data) return;
    const saved = readTourProgress(data.root);
    const paused = saved && !saved.done ? saved : null;
    const wantFull = full ?? !!paused?.full;
    const steps = stepsFor(wantFull);
    if (!steps.length) return;
    // The full tour offered from the end of the short one carries on past the welcome step, unless the sample still has to be chosen there.
    const skipWelcome = full === true && (!data.sample || data.sample.loaded) && steps[0].id === 'welcome' && steps.length > 1;
    const first = !restart && paused && !!paused.full === wantFull && steps.some((step) => step.id === paused.stepId) ? paused.stepId : steps[skipWelcome ? 1 : 0].id;
    if (!tourStep) tourOrigin.current = { page, runId: page === 'review' ? session.run?.id : null,
      opener: rootRef.current?.contains(document.activeElement) ? document.activeElement : null };
    hideWelcome();
    setError('');
    setFullTour(wantFull);
    setTourStep(first);
    writeTourProgress(data.root, { stepId: first, full: wantFull });
  }
  /** 看完整导览: the explicit extra, from the end of the short tour or from Settings. */
  const startFullTour = () => startTour({ restart: true, full: true });
  function moveTour(direction) {
    const next = tourNeighbour(tourSteps, tourStep, direction);
    if (!next) {
      if (direction > 0) finishTour();
      return;
    }
    setTourStep(next);
    if (data?.root) writeTourProgress(data.root, { stepId: next, full: fullTour });
  }
  /** Leave the tour: close what it opened, go back to where it started, return focus. */
  function endTour({ then } = {}) {
    const origin = tourOrigin.current;
    tourOrigin.current = null;
    setTourStep(null);
    // A practice round the tour opened and nobody answered should not become "pick up where you left off".
    const round = tourRound.current;
    tourRound.current = null;
    if (round) void call('review.get', { runId: round }).then((value) => !value.complete && !value.answered && !value.feedback
      ? call('review.end', { runId: round }).then(() => refresh()) : null).catch(() => {});
    setModal((current) => (current?.tour ? null : current));
    if (origin?.page === 'review' && origin.runId) void act('review.get', { runId: origin.runId }, session.enterRun);
    else showPage(origin?.page && origin.page !== 'draft' && origin.page !== 'review' ? origin.page : 'library');
    then?.();
    requestAnimationFrame(() => {
      const target = origin?.opener?.isConnected ? origin.opener : rootRef.current?.querySelector('[data-tour="tour-reopen"]');
      target?.focus?.({ preventScroll: true });
    });
  }
  function closeTour(reason) {
    if (data?.root) writeTourProgress(data.root, { stepId: tourStep, done: reason === 'skip', full: fullTour });
    endTour();
    if (reason !== 'skip') notify({ text: ui('导览已暂停，可以从侧栏「功能导览」接着看。'), tone: 'info' });
  }
  function finishTour() {
    if (data?.root) writeTourProgress(data.root, { stepId: tourStep, done: true, full: fullTour });
    endTour();
    notify({ text: ui('导览完成。想再看一遍，点侧栏的「功能导览」。'), tone: 'success' });
  }
  /** The tour's practice round on the sample deck: the open one if there is one, otherwise a fresh round. */
  async function openSamplePractice(sample) {
    if (!sample?.deckId) return;
    const { page: here, run: current } = latest.current;
    if (here === 'review' && current && !current.complete && current.deckId === sample.deckId) return;
    const scope = sample.practice?.length ? sample.practice : [{ deckId: sample.deckId }];
    const sameScope = (item) => JSON.stringify(item.scope || []) === JSON.stringify(scope);
    const open = (refs.dataRef.current?.runs || []).find((item) => item.deckIds?.length === 1 && item.deckIds[0] === sample.deckId &&
      item.index < item.total && !item.purpose && sameScope(item));
    try {
      let next = open ? await call('review.get', { runId: open.id }) : null;
      if (!next || next.complete) {
        next = await call('review.start', practiceArgs(scope));
        tourRound.current = next.id;
      }
      session.enterRun(next);
    } catch (failure) {
      showPage('library');
      setError(errorMessage(failure));
    }
  }
  /** Each step's page, prepared with sample content where the step shows it. */
  async function enterTourStep(step) {
    const sample = refs.dataRef.current?.sample;
    if (step.prepare !== 'openSampleDocument') setModal((current) => (current?.tour ? null : current));
    if (step.prepare === 'openSampleDocument') {
      const source = refs.dataRef.current?.sources.find((item) => item.id === sample?.sourceId);
      showPage(step.page);
      if (source) setModal({ type: 'source', source, tour: true });
      return;
    }
    if (step.prepare === 'prepareGenerate') {
      intents.setGenSource('files');
      if (sample?.sourceId) setSelectedSources([sample.sourceId]);
    }
    if (step.prepare === 'openSampleDraft') {
      const sampleDraft = refs.dataRef.current?.drafts.find((item) => item.id === sample?.draftId);
      if (sampleDraft) {
        drafts.openDraft(sampleDraft);
        return;
      }
    }
    if (step.prepare === 'openSampleSkeleton' && sample?.skeletonId) setSkeletonFocus(sample.skeletonId);
    if (step.prepare === 'startSamplePractice') {
      await openSamplePractice(sample);
      return;
    }
    if (step.page) showPage(step.page);
  }

  async function loadSample() {
    setSampleBusy(true);
    setError('');
    try {
      const status = await call('sample.load', { language: getUiLanguage() });
      await refresh();
      return status;
    } catch (failure) {
      setError(uiFormat('示例数据没能载入：{0}', [errorMessage(failure)]));
      return null;
    } finally {
      setSampleBusy(false);
    }
  }
  async function loadSampleAndTour() { if (await loadSample()) startTour({ restart: true }); }
  async function loadSampleInTour() { if (await loadSample()) moveTour(1); }
  async function loadSampleOnly() { if (await loadSample()) notify({ text: ui('示例课程已载入，在学习库里就能看到。'), tone: 'success' }); }
  async function removeSampleData() {
    setSampleBusy(true);
    setError('');
    try {
      const deckId = refs.dataRef.current?.sample?.deckId;
      const sampleSources = new Set((refs.dataRef.current?.sources || []).filter((source) => source.sample).map((source) => source.id));
      await call('sample.remove', {});
      if (deckId && latest.current.run?.deckId === deckId) session.clearRun();
      setDraft((current) => (current?.sample ? null : current));
      setModal((current) => (current?.source && sampleSources.has(current.source.id) ? null : current));
      setSelectedSources((ids) => ids.filter((id) => !sampleSources.has(id)));
      if (['review', 'draft'].includes(latest.current.page)) showPage('library');
      if (data?.root) writeTourProgress(data.root, null);
      await refresh();
      setRemovingSample(false);
      notify({ text: ui('示例数据已移除，你自己的资料和记录都还在。'), tone: 'success' });
    } catch (failure) {
      setError(uiFormat('示例数据没能移除：{0}', [errorMessage(failure)]));
    } finally {
      setSampleBusy(false);
    }
  }

  return { tourStep, fullTour, sampleBusy, removingSample, setRemovingSample, modelState, tourSteps, tourResume, showWelcome, hideWelcome, openFirstImport, startTour,
    startFullTour, moveTour, endTour, closeTour, finishTour, enterTourStep, loadSampleAndTour, loadSampleInTour, loadSampleOnly, removeSampleData };
}
