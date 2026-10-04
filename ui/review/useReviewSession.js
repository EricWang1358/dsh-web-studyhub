import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ui, getUiLanguage } from '../i18n.js';
import { mergeReviewPoll, reviewEntryKey } from '../async.js';
import { submitAssist } from '../assist-request.js';
import { readTeachingDraft, saveTeachingDraft } from '../teaching-draft.js';
import { reviewNoticeScope } from '../ActionFeedback.jsx';
import { usePersistentState } from '../storage.js';
import { usePolling } from '../use-polling.js';
import { AUTOPILOT_KEY, EN_KEY, flag } from '../app/use-app-shell.js';
import { askAboutCardPrompt, improveCardPrompt } from '../agent-prompts/card.js';
import { practiceArgs } from '../learning-navigation.js';
import {
  AUTO_ADVANCE_MS, advanceKeyOf, autopilotPlan, createFlightSet, emptyEntry, entryForRun, isCurrentEntry, isPassed, reviewChoiceKind,
  shortcutAction, shortcutGate, shouldResetEntry,
} from './session-logic.js';

/* The practice session (ui-consistency #112): the open run, what the learner has typed on its question, the teaching
   panel, the EN translation, the autopilot and the keyboard. It used to live in App, which re-rendered it on every
   library poll; Review now receives `session` (state + actions) and no setters. The rules are in session-logic.js.
   deps: core (call, act, notify, setError, refs), nav (page, setPage, show), modalOpen, host, rootRef, late
   (functions only App can build: resume). */
export function useReviewSession({ core, nav, modalOpen, host, rootRef, late }) {
  const { call, act, notify, setError, busy, refs } = core;
  const [run, setRun] = useState(null);
  const [entry, setEntry] = useState(emptyEntry);
  const [showBack, setShowBack] = useState(false);
  const [showEn, setShowEn] = usePersistentState(EN_KEY, false, flag('1', '0'));
  const [enBusyKey, setEnBusyKey] = useState('');
  const [autopilot, setAutopilot] = usePersistentState(AUTOPILOT_KEY, false, flag('on', 'off'));
  const [autoAdvance, setAutoAdvance] = useState('');
  const [shortcutHelp, setShortcutHelp] = useState(false);
  const [teachingPending, setTeachingPending] = useState({});
  const { page, setPage } = nav;
  const runRef = useRef(run), pageRef = useRef(page), entryRef = useRef(entry), busyRef = useRef(busy);
  runRef.current = run;
  pageRef.current = page;
  entryRef.current = entry;
  busyRef.current = busy;
  const patch = useCallback((change) => setEntry((current) => ({ ...current, ...(typeof change === 'function' ? change(current) : change) })), []);
  const kind = reviewChoiceKind(run);
  const { choice, isCloze, rubricCard } = kind;
  const dataRoot = () => refs.dataRef.current?.root;

  /* ── entering and leaving a question ── */
  const enterRun = useCallback((next, input) => {
    if (!next) return;
    runRef.current = next;
    if (next.mode === 'exam') { nav.show.exam('exam', next.id); return; }
    setRun(next);
    setPage('review');
    setEntry(entryForRun(next, input, { draft: (teaching) => readTeachingDraft(refs.dataRef.current?.root, teaching) }));
  }, [nav.show, setPage, refs]);
  const reset = useCallback(() => { setRun(null); setEntry(emptyEntry()); }, []);
  const clearRun = useCallback(() => setRun(null), []);
  const patchRun = useCallback((change) => setRun(change), []);

  const onReviewState = host.onReviewState;
  useEffect(() => {
    onReviewState?.(page === 'review' ? run : null);
    return () => onReviewState?.(null);
  }, [onReviewState, page, run]);
  const queueVersion = run?.queueVersion || 0;
  const priorQueue = useRef(null);
  useEffect(() => {
    const previous = priorQueue.current;
    priorQueue.current = { id: run?.id, version: queueVersion };
    if (shouldResetEntry(previous, run)) setEntry(emptyEntry());
  }, [run?.id, queueVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { saveTeachingDraft(dataRoot(), entry.teaching, entry.teachAnswer); }, [entry.teaching, entry.teachAnswer]); // eslint-disable-line react-hooks/exhaustive-deps
  // Each card mounts on the side matching its state; flipping after that is local.
  useEffect(() => { setShowBack(!!run?.revealed); }, [run?.id, run?.card?.id, run?.index, run?.queueVersion, run?.revealed]);

  /* Links and fixes made in the conversation reach the open question without a reload. */
  usePolling(async () => {
    const current = runRef.current;
    if (!current?.id) return;
    const next = await call('review.get', { runId: current.id });
    setRun((existing) => mergeReviewPoll(existing, next));
  }, { intervalMs: 4000, enabled: page === 'review' && !!run?.card?.id });

  /* ── one step of the round ── */
  const reviewAct = useCallback((action, args = {}) => {
    const current = runRef.current;
    return act(action, { runId: current.id, cardId: current.card?.id, queueVersion: current.queueVersion || 0, ...args }, (result) => enterRun(result),
      // Practice steps return the run they changed; the snapshot catches up on the next poll.
      // Only a finished round reloads the library (its result page needs fresh counts).
      { refreshAfter: (result) => action === 'review.move' ? !!result.complete : action !== 'review.answer' && action !== 'review.reveal' });
  }, [act, enterRun]);
  const reviewActRef = useRef(reviewAct);
  reviewActRef.current = reviewAct;

  const flipCard = useCallback(async () => {
    const current = runRef.current;
    if (!current?.card) return;
    if (current.revealed) { setShowBack((value) => !value); return; }
    if (busyRef.current) return;
    setShowBack(true);
    if (!(await reviewActRef.current('review.reveal'))) setShowBack(false);
  }, []);
  const choose = useCallback((id) => {
    const current = runRef.current;
    if (busyRef.current || current.feedback) return;
    if (current.card.kind === 'multi') patch((value) => ({ selected: value.selected.includes(id) ? value.selected.filter((item) => item !== id) : [...value.selected, id] }));
    else reviewActRef.current('review.answer', { selected: [id] });
  }, [patch]);

  /* ── autopilot: after a pass, move on by itself unless the learner touches anything during the short countdown ── */
  const autoTimer = useRef(null), autoSkipped = useRef('');
  const cancelAutoAdvance = useCallback(() => {
    if (!autoTimer.current) return;
    clearTimeout(autoTimer.current);
    autoTimer.current = null;
    setAutoAdvance((key) => { autoSkipped.current = key; return ''; });
  }, []);
  const cancelRef = useRef(cancelAutoAdvance);
  cancelRef.current = cancelAutoAdvance;
  const passed = isPassed(run), advanceKey = advanceKeyOf(run);
  useEffect(() => {
    clearTimeout(autoTimer.current);
    autoTimer.current = null;
    const plan = autopilotPlan({ autopilot, page, passed, complete: run?.complete, teaching: !!entry.teaching, skippedKey: autoSkipped.current, advanceKey });
    if (!plan.schedule) { setAutoAdvance(''); return undefined; }
    setAutoAdvance(plan.key);
    autoTimer.current = setTimeout(() => {
      autoTimer.current = null;
      setAutoAdvance('');
      reviewActRef.current('review.move', { direction: 1 });
    }, plan.ms);
    return () => clearTimeout(autoTimer.current);
  }, [autopilot, page, passed, advanceKey, run?.complete, !!entry.teaching]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── EN: one translate per card entry, a second click joins the in-flight call ── */
  const enFlights = useRef(createFlightSet());
  const translateEn = useCallback(async (target) => {
    if (!target?.card || target.complete || target.mode === 'exam') return;
    const key = reviewEntryKey(target);
    if (!enFlights.current.begin(key)) return;
    setEnBusyKey(key);
    try {
      await call('card.translate', { deckId: target.deckId, cardId: target.card.id });
      const next = await call('review.get', { runId: target.id });
      setRun((current) => (reviewEntryKey(current) === key ? mergeReviewPoll(current, next) : current));
    } catch (failure) {
      if (isCurrentEntry(runRef.current, key)) setError(failure.message || String(failure));
    } finally {
      enFlights.current.end(key);
      setEnBusyKey((current) => (current === key ? '' : current));
    }
  }, [call, setError]);
  // With EN on, each newly opened card gets translated once (server caches it).
  useEffect(() => {
    if (page !== 'review' || !showEn || !run?.card || run.complete || run.mode === 'exam') return;
    if (run.card.translation) return;
    translateEn(run);
    // The listed run fields identify the open entry; the full object is not a dep.
  }, [page, showEn, run?.id, run?.index, run?.card?.id, run?.card?.translation, translateEn]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleEn = useCallback(() => {
    const next = !showEn;
    setShowEn(next);
    if (next && runRef.current && !runRef.current.card?.translation) translateEn(runRef.current);
  }, [showEn, setShowEn, translateEn]);

  /* ── the step-by-step teaching panel ── */
  const teachingFlights = useRef(createFlightSet());
  const teachingAct = useCallback(async (action, args = {}) => {
    const origin = runRef.current, key = reviewEntryKey(origin), draftAtStart = entryRef.current.teachAnswer;
    if (!teachingFlights.current.begin(key)) return;
    setTeachingPending((all) => ({ ...all, [key]: true }));
    const isCurrent = () => isCurrentEntry(runRef.current, key, { page: pageRef.current, needPage: 'review' });
    try {
      const next = await call(action, { runId: origin.id, cardId: origin.card.id, index: origin.index, queueVersion: origin.queueVersion || 0, ...args });
      if (isCurrent()) {
        patch((current) => {
          let teachAnswer = current.teachAnswer;
          if (action === 'teach.start' && teachAnswer === draftAtStart) teachAnswer = readTeachingDraft(dataRoot(), next);
          if (action === 'teach.answer' && next.index > args.stepIndex && teachAnswer === args.answer) teachAnswer = '';
          return { teaching: next, teachAnswer };
        });
      }
    } catch (failure) {
      if (isCurrent()) setError(failure.message || String(failure));
    } finally {
      teachingFlights.current.end(key);
      setTeachingPending((all) => { const rest = { ...all }; delete rest[key]; return rest; });
    }
  }, [call, patch, setError]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── helping the learner: the background assistant, slaying, prerequisites ── */
  const assistCard = useCallback(async (mode, text, helpChoices = [], derive = undefined) => {
    const current = runRef.current;
    if (!current?.card || (!text.trim() && !(mode === 'ask' && helpChoices.length) && !(mode === 'derive' && derive?.followupId))) return false;
    try {
      await submitAssist(call, { deckId: current.deckId, cardId: current.card.id, runId: current.id,
        mode, text: text.trim(), helpChoices, ...(derive ? { derive } : {}), uiLanguage: getUiLanguage() });
      notify(mode === 'ask' ? ui('后台助教正在解答，完成后会出现在这道题的问答里，并进信箱。')
        : mode === 'derive' ? ui('后台助教正在出题，完成后新题会放进同一题组，并进信箱。')
          : mode === 'grade' ? { text: ui('已提交批改：后台按评分标准逐项打分，结果会显示在这道题下，也会进信箱。'), tone: 'success' }
            : ui('后台助教正在改这道题，改完会进信箱，可一步撤销。'));
      core.refresh().catch(() => {});
      return true;
    } catch (failure) {
      setError(failure.message || ui('后台帮助暂不可用，请稍后再试。'));
      return false;
    }
  }, [call, notify, setError, core]);
  // Slaying is one click next to other tools; offer an immediate undo instead of sending the learner to the slay deck in 管理题组.
  const slayCard = useCallback(async () => {
    const current = runRef.current, ref = { deckId: current.deckId, cardId: current.card.id };
    const next = await reviewActRef.current('card.slay', { deckId: ref.deckId });
    if (!next) return;
    const scope = reviewNoticeScope(refs.bindingRoot.current, 'review', next);
    notify({ text: ui('已斩这道题：移入斩题组，不再复习。'), scope, action: { label: ui('撤销'), run: () => act('card.restore', ref, () =>
      notify({ text: ui('已恢复到原题组，复习进度不变；本轮练习不再出现这道题。'), scope })) } });
  }, [act, notify, refs]);
  // Practise the given prerequisites (learned ones included), then offer a way back to this question.
  const studyPrerequisites = useCallback((list) => act('review.start',
    practiceArgs(list.map(({ deckId, cardId }) => ({ deckId, cardId })), { returnTo: runRef.current.id }), enterRun), [act, enterRun]);
  const deckTitle = () => refs.dataRef.current?.decks.find((deck) => deck.id === runRef.current.deckId)?.title || '';
  const askAboutCard = useCallback((extra = '') => core.askInChat(askAboutCardPrompt({ run: runRef.current, deckTitle: deckTitle(), extra })), [core]); // eslint-disable-line react-hooks/exhaustive-deps
  const improveCard = useCallback((extra = '') => core.askInChat(improveCardPrompt({ run: runRef.current, deckTitle: deckTitle(), extra })), [core]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── the keyboard ── */
  const engaged = useRef(false), keyHandler = useRef(null);
  // Clicking an option or grade disables it, which drops focus to <body>. Keep shortcuts alive when the learner's last interaction was in the panel.
  const gateContext = () => {
    const active = document.activeElement;
    return { inside: !!(rootRef.current?.contains(active) || ((!active || active === document.body) && engaged.current)), modalOpen };
  };
  const eventShape = (event) => ({ key: event.key, code: event.code, shiftKey: event.shiftKey, repeat: event.repeat, defaultPrevented: event.defaultPrevented,
    ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey,
    inEditable: !!event.target.closest?.('input,textarea,select,[contenteditable],dialog'), onButton: !!event.target.closest?.('button') });
  const canShortcut = (event) => shortcutGate(eventShape(event), gateContext()) && !event.defaultPrevented && !event.repeat && !event.shiftKey && page === 'review' && !!run?.card;
  keyHandler.current = (event) => {
    const outcome = shortcutAction(eventShape(event), { ...gateContext(), page, run, busy, shortcutHelp, choice, isCloze, rubricCard, selected: entry.selected, clozeValues: entry.clozeValues });
    if (!outcome) return;
    cancelAutoAdvance();
    if (outcome.preventDefault) event.preventDefault();
    const action = outcome.action;
    if (!action) return;
    if (action.type === 'help') setShortcutHelp((value) => !value);
    else if (action.type === 'help-close') setShortcutHelp(false);
    else if (action.type === 'autopilot') setAutopilot((value) => !value);
    else if (action.type === 'resume') late.current.resume?.();
    else if (action.type === 'answer') reviewAct('review.answer', action.args);
    else if (action.type === 'move') reviewAct('review.move', { direction: action.direction });
    else if (action.type === 'flip') flipCard();
    else if (action.type === 'hint') patch((value) => ({ hint: !value.hint }));
    else if (action.type === 'explain') patch((value) => ({ explain: !value.explain }));
    else if (action.type === 'assist-plain') assistCard('ask', '', ['plain']);
    else if (action.type === 'choose') choose(action.id);
  };
  useEffect(() => {
    const handler = (event) => keyHandler.current?.(event);
    const engage = (event) => {
      engaged.current = !!rootRef.current?.contains(event.target);
      if (event.type === 'pointerdown') cancelRef.current?.();
    };
    window.addEventListener('keydown', handler);
    document.addEventListener('pointerdown', engage, true);
    document.addEventListener('focusin', engage, true);
    return () => {
      window.removeEventListener('keydown', handler);
      document.removeEventListener('pointerdown', engage, true);
      document.removeEventListener('focusin', engage, true);
    };
  }, [rootRef]);

  /* ── what Review and the result page's coach strip are handed ── */
  const onCoachPractice = useCallback(() => act('coach.practice', {}, enterRun), [act, enterRun]);
  const coach = {
    call, autopilot, onStatus: () => core.refresh().catch(() => {}), onPractice: onCoachPractice,
    onContinue: () => act('review.start', practiceArgs(run?.returnTo ? [] : run?.scope || []), enterRun),
    onReviewWeak: () => act('review.weak.start', { runId: run.id }, enterRun),
    canShortcut, autoAdvance: autoAdvance && autoAdvance === advanceKey ? AUTO_ADVANCE_MS : 0, debrief: null,
  };
  const actions = useMemo(() => ({
    reviewAct, choose, flipCard, assistCard, slayCard, studyPrerequisites, teachingAct, toggleEn, askAboutCard, improveCard,
    toggleHelp: () => patch((value) => (runRef.current?.revealed ? { explain: !value.explain } : { hint: !value.hint })),
    showExplanation: () => patch({ explain: true }),
    setResponse: (response) => patch({ response }),
    setClozeValue: (id, value) => patch((current) => ({ clozeValues: { ...current.clozeValues, [id]: value } })),
    setTeachAnswer: (teachAnswer) => patch({ teachAnswer }),
    closeShortcutHelp: () => setShortcutHelp(false),
  }), [reviewAct, choose, flipCard, assistCard, slayCard, studyPrerequisites, teachingAct, toggleEn, askAboutCard, improveCard, patch]);
  return { run, entry, showBack, showEn, enBusyKey, teachingBusy: !!teachingPending[reviewEntryKey(run)], autopilot, autoAdvance, advanceKey,
    shortcutHelp, ...kind, coach, onCoachPractice, enterRun, reset, clearRun, patchRun, actions };
}
