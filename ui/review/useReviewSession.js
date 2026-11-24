import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ui, uiFormat, getUiLanguage, errorMessage } from '../i18n.js';
import { reviewEntryKey } from '../async.js';
import { submitAssist } from '../assist-request.js';
import { readTeachingDraft, saveTeachingDraft } from '../teaching-draft.js';
import { reviewNoticeScope } from '../ActionFeedback.jsx';
import { usePersistentState } from '../storage.js';
import { usePolling } from '../use-polling.js';
import { reviewPollDelay } from '../poll-schedule.js';
import { CANDIDATE_TERMS_KEY, EN_KEY, flag } from '../app/use-app-shell.js';
import { resolvePracticeSettings } from '../../lib/practice-settings.js';
import { describeModelError, modelReadiness } from '../generation-status.js';
import { practiceArgs } from '../learning-navigation.js';
import {
  AUTO_ADVANCE_MS, SELF_GRADE_ADVANCE_KEY, advanceKeyOf, assistRunningOn, autopilotPlan, gradeRunning, gradesOutstanding, isSelfGradedRun, keepAutopilotHold, continueDestination, createFlightSet, emptyEntry, entryForRun, isCurrentEntry, isPassed, pressedGradeOf, reviewChoiceKind,
  keysElsewhere, mergeReviewPollWithFollowups, shouldAdvanceOnSelfGrade, shortcutAction, shortcutGate, shouldResetEntry, skipTarget,
} from './session-logic.js';
import { continueLabel, continueNote } from './continue-labels.js';
import { createDraftSaver, draftKey, draftPayloadOf, draftable, entrySignature, keepTyped, savedSignature } from './draft-persistence.js';
import { hiddenMsOf, noteVisibility, openClock } from './hidden-time.js';
import { playSound } from '../sound-effects.js';
import { isEarnedLevelClimb, nextDueGap } from '../NextDue.jsx';

// Leaving an unanswered question flushes any pending draft first; `review.answer` carries assistance/draft inline and discards pending draft timers to avoid a serial RPC waterfall.
const SAVES_FIRST = new Set(['review.move']);
// How long a number key's grade button wears its press (#745): long enough to be seen, short enough never to look stuck.
const KEY_PRESS_MS = 220;
// Debounce for teaching scratchpad persistence so typing does not synchronously write sessionStorage per keystroke.
const TEACH_DRAFT_DEBOUNCE_MS = 300;
// The practice page asks for the open question every 4 s, slower while nothing changes (#1011). Right after a helper task is sent it keeps the quick rhythm this long, until the library lists the task as running.
const REVIEW_POLL_MS = 4000;
const ASSIST_SENT_FAST_MS = 20000;

export { mergeReviewPollWithFollowups } from './session-logic.js';

function createLiveSessionStore() {
  let state = {
    entry: emptyEntry(),
    keyGrade: null,
    autoAdvancePaused: false,
    explainHidden: false,
    pendingAnswer: null,
  };
  const listeners = new Set();
  return {
    get: () => state,
    set(patch) {
      const next = { ...state, ...patch };
      if (
        next.entry === state.entry
        && next.keyGrade === state.keyGrade
        && next.autoAdvancePaused === state.autoAdvancePaused
        && next.explainHidden === state.explainHidden
        && next.pendingAnswer === state.pendingAnswer
      ) return;
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const NOOP_SUBSCRIBE = () => () => {};
const RETURN_NULL = () => null;

/** Subscribe to high-frequency review input & transient state inside QuestionRun without re-rendering App on keystrokes. */
export function useLiveSession(session) {
  const subscribe = session?.subscribeLive || NOOP_SUBSCRIBE;
  const get = session?.getLive || RETURN_NULL;
  const live = useSyncExternalStore(subscribe, get, get);
  return useMemo(() => (live ? { ...session, ...live } : session), [session, live]);
}

/* The practice session (ui-consistency #112): the open run, what the learner has typed on its question, the teaching
   panel, the EN translation, the autopilot and the keyboard. It used to live in App, which re-rendered it on every
   library poll; Review now receives `session` (state + actions) and no setters. The rules are in session-logic.js.
   deps: core (call, act, notify, setError, refs), nav (page, setPage, show), modalOpen, host, rootRef, late
   (functions only App can build: resume).
   embeddedIn (optional): the name of another page that mounts <QuestionRun> (ui/review/QuestionRun.jsx) with this session. The question is
   then "on screen" while nav.page is that page, and enterRun leaves nav.page alone instead of going to 'review'. Without it, nothing changes. */
export function useReviewSession({ core, nav, modalOpen, host, rootRef, late, embeddedIn }) {
  const { call, act, notify, setError, refs } = core;
  const isBusy = useCallback(() => (core.busyStore ? core.busyStore.get() : !!core.busy), [core]);
  const [run, setRun] = useState(null);
  const liveStoreRef = useRef(null);
  liveStoreRef.current ||= createLiveSessionStore();
  const liveStore = liveStoreRef.current;
  // Rare boolean flags derived from `entry` that App-level hooks (`useInbox`, autopilot) actually observe; typing never flips these.
  const [entrySignal, setEntrySignal] = useState({ explain: false, askedTutor: false, hasTeaching: false });
  const [showBack, setShowBack] = useState(false);
  const showBackRef = useRef(showBack);
  showBackRef.current = showBack;
  const [showEn, setShowEn] = usePersistentState(EN_KEY, false, flag('1', '0'));
  const [autoTerms, setAutoTerms] = usePersistentState(CANDIDATE_TERMS_KEY, false, flag('1', '0'));
  const autoTermsRef = useRef(autoTerms);
  autoTermsRef.current = autoTerms;
  const [selfGradeAdvance, setSelfGradeAdvance] = usePersistentState(SELF_GRADE_ADVANCE_KEY, true, flag('1', '0'));
  const selfGradeAdvanceRef = useRef(selfGradeAdvance);
  selfGradeAdvanceRef.current = selfGradeAdvance;
  const toggleSelfGradeAdvance = useCallback(() => setSelfGradeAdvance((value) => !value), [setSelfGradeAdvance]);
  const [enBusyKey, setEnBusyKey] = useState('');
  const [autoTermsBusyKey, setAutoTermsBusyKey] = useState('');
  /* 自动驾驶 is the library's setting (设置 › 练习), not a browser flag: the toolbar switch and the A key write it, and what was just chosen shows at
     once, until the library says the same. */
  const savedAutopilot = resolvePracticeSettings(refs.dataRef.current?.settings?.practice).autopilot;
  const [autopilotChoice, setAutopilotChoice] = useState(null);
  useEffect(() => { if (autopilotChoice !== null && autopilotChoice === savedAutopilot) setAutopilotChoice(null); }, [savedAutopilot, autopilotChoice]);
  const autopilot = autopilotChoice ?? savedAutopilot;
  const autopilotRef = useRef(autopilot);
  autopilotRef.current = autopilot;
  const toggleAutopilot = useCallback(() => {
    const next = !autopilotRef.current;
    setAutopilotChoice(next);
    // `call`, not `act`: a step that is saving must not swallow this, and it only flips a setting.
    call('settings.practice.set', { patch: { autopilot: next } })
      .then(() => core.refresh().catch(() => {}))
      .catch((failure) => { setAutopilotChoice(null); setError(errorMessage(failure)); });
  }, [call, core, setError]);
  const [autoAdvance, setAutoAdvance] = useState('');
  const setAutoAdvancePausedState = useCallback((paused) => liveStore.set({ autoAdvancePaused: !!paused }), [liveStore]);
  const setExplainHidden = useCallback((next) => {
    const cur = liveStore.get().explainHidden;
    const value = typeof next === 'function' ? !!next(cur) : !!next;
    liveStore.set({ explainHidden: value });
  }, [liveStore]);
  const [skippedIndices, setSkippedIndices] = useState(() => new Set());
  const [shortcutHelp, setShortcutHelp] = useState(false);
  const [markingTerms, setMarkingTerms] = useState(false);
  /* A number key answers straight from here, so no <button> is ever seen going down (#745): the grade button the key names wears the same press for a
     moment. The one key handler below is the only writer; the view only reads it. */
  const keyGradeTimer = useRef(null);
  const markKeyGrade = useCallback((grade) => {
    if (grade === null || grade === undefined) return;
    clearTimeout(keyGradeTimer.current);
    liveStore.set({ keyGrade: grade });
    keyGradeTimer.current = setTimeout(() => { keyGradeTimer.current = null; liveStore.set({ keyGrade: null }); }, KEY_PRESS_MS);
  }, [liveStore]);
  useEffect(() => () => clearTimeout(keyGradeTimer.current), []);
  const [teachingPending, setTeachingPending] = useState({});
  const { setPage } = nav;
  // The rules below (and session-logic.js) call the page that shows the question 'review', whichever page that is.
  const page = nav.page === (embeddedIn || 'review') ? 'review' : nav.page;
  const runRef = useRef(run), pageRef = useRef(page), entryRef = useRef(liveStore.get().entry);
  runRef.current = run;
  pageRef.current = page;
  entryRef.current = liveStore.get().entry;
  const dataRoot = useCallback(() => refs.dataRef.current?.root, [refs]);
  const teachDraftTimer = useRef(null);
  const flushTeachingDraft = useCallback(() => {
    if (teachDraftTimer.current) {
      clearTimeout(teachDraftTimer.current);
      teachDraftTimer.current = null;
    }
    const cur = entryRef.current;
    if (cur?.teaching) saveTeachingDraft(dataRoot(), cur.teaching, cur.teachAnswer);
  }, [dataRoot]);
  const syncDraftRef = useRef(() => {});
  const setEntry = useCallback((nextOrFn) => {
    const prev = liveStore.get().entry;
    const next = typeof nextOrFn === 'function' ? nextOrFn(prev) : nextOrFn;
    if (next === prev) return;
    entryRef.current = next;
    liveStore.set({ entry: next });
    if (next.selected !== prev.selected || next.response !== prev.response || next.clozeValues !== prev.clozeValues || next.assistance !== prev.assistance) {
      syncDraftRef.current();
    }
    if (next.teaching !== prev.teaching || next.teachAnswer !== prev.teachAnswer) {
      if (next.teaching !== prev.teaching) {
        flushTeachingDraft();
        if (next.teaching) saveTeachingDraft(dataRoot(), next.teaching, next.teachAnswer);
      } else if (next.teaching) {
        clearTimeout(teachDraftTimer.current);
        teachDraftTimer.current = setTimeout(() => {
          teachDraftTimer.current = null;
          saveTeachingDraft(dataRoot(), entryRef.current.teaching, entryRef.current.teachAnswer);
        }, TEACH_DRAFT_DEBOUNCE_MS);
      }
    }
    const nextExplain = !!next.explain;
    const nextAsked = !!next.assistance?.askedTutorBeforeAnswer;
    const nextTeaching = !!next.teaching;
    setEntrySignal((cur) => (
      cur.explain === nextExplain && cur.askedTutor === nextAsked && cur.hasTeaching === nextTeaching
        ? cur
        : { explain: nextExplain, askedTutor: nextAsked, hasTeaching: nextTeaching }
    ));
  }, [liveStore, dataRoot, flushTeachingDraft]);
  const patch = useCallback((change) => setEntry((current) => {
    const delta = typeof change === 'function' ? change(current) : change;
    if (!delta || typeof delta !== 'object' || Object.keys(delta).length === 0) return current;
    return { ...current, ...delta };
  }), [setEntry]);
  const kind = reviewChoiceKind(run);
  const { choice, isCloze, rubricCard } = kind;

  /* ── the unsubmitted answer, saved on the run (#537): plain call()s that never touch `busy`, whose results change no state, so typing is never in their way ── */
  const callRef = useRef(call);
  callRef.current = call;
  const draftSaver = useRef(null);
  draftSaver.current ||= createDraftSaver({ call: (action, args) => callRef.current(action, args), currentRoot: () => refs.dataRef.current?.root });
  // What the library is known or about to hold for the question on screen.
  const draftBase = useRef({ key: '', signature: '' });
  const syncDraft = useCallback(() => {
    const current = runRef.current, root = refs.dataRef.current?.root, key = draftKey(root, current);
    if (draftBase.current.key !== key) {
      // Another question: the library's copy is the base. The entry may still be the last question's (a rebuilt queue resets it a moment later), so nothing is written from it.
      draftBase.current = { key, signature: current ? savedSignature(current) : '' };
      return;
    }
    if (!draftable(current)) { draftSaver.current.discard(key); return; }
    const signature = entrySignature(entryRef.current);
    if (signature === draftBase.current.signature) return;
    draftBase.current.signature = signature;
    draftSaver.current.schedule({ key, root, args: { runId: current.id, cardId: current.card.id, index: current.index, queueVersion: current.queueVersion || 0, ...draftPayloadOf(entryRef.current) } });
  }, [refs]);
  syncDraftRef.current = syncDraft;
  /** Sends what is waiting and waits for it. False: it could not be saved, and the learner has been told. */
  const flushDraft = useCallback(async () => {
    syncDraft();
    if (!draftSaver.current.dirty()) return true;
    const saved = await draftSaver.current.flush();
    if (!saved) setError(ui('没能保存你写的内容，这一步先没有继续。内容还在，检查连接后再点一次。'));
    return saved;
  }, [syncDraft, setError]);
  const noteAssistance = useCallback((flag) => {
    if (!draftable(runRef.current)) return;
    patch((value) => (value.assistance?.[flag] ? {} : { assistance: { ...value.assistance, [flag]: true } }));
  }, [patch]);
  useEffect(() => {
    // The page may be closing: best effort, nobody can wait for it. Steps and links wait in flushDraft.
    const leave = () => { syncDraftRef.current(); draftSaver.current.flush(); flushTeachingDraft(); };
    const hidden = () => { if (document.visibilityState === 'hidden') leave(); };
    window.addEventListener('pagehide', leave);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('pagehide', leave);
      document.removeEventListener('visibilitychange', hidden);
      leave();
    };
  }, [flushTeachingDraft]);

  /* ── time away (#883): how long the page was hidden while this question was open, sent with its answer so the recorded time leaves it out ── */
  const questionKey = draftKey(refs.dataRef.current?.root, run);
  const awayClock = useRef(null);
  // Each question (a tail retry is another) opens its own clock; a reload opens a new one, so a restored draft brings no time with it.
  useEffect(() => { awayClock.current = openClock(questionKey, Date.now(), document.hidden === true); }, [questionKey]);
  useEffect(() => {
    const seen = () => { awayClock.current = noteVisibility(awayClock.current, document.hidden === true, Date.now()); };
    document.addEventListener('visibilitychange', seen);
    return () => document.removeEventListener('visibilitychange', seen);
  }, []);
  const awayArgs = useCallback((action, current) => {
    const hiddenMs = action === 'review.answer' ? hiddenMsOf(awayClock.current, draftKey(refs.dataRef.current?.root, current), Date.now()) : 0;
    return hiddenMs > 0 ? { hiddenMs } : {};
  }, [refs]);

  /* ── entering and leaving a question ── */
  // `moved`: the host restarted the question's timer (a move, or the way back to it), so the hidden time counted so far no longer belongs to it.
  const enterRun = useCallback((next, input, moved = false, { stayOnGuided = false } = {}) => {
    if (!next) return;
    const root = refs.dataRef.current?.root;
    // The same open question handed back (a reveal's answer, the conversation opening it again): what is on screen is newer than what the library had when it answered.
    const same = !input && draftable(next) && draftKey(root, next) === draftKey(root, runRef.current);
    syncDraft();
    runRef.current = next;
    if (next.mode === 'exam') { nav.show.exam('exam', next.id); return; }
    if (moved && draftable(next)) awayClock.current = openClock(draftKey(root, next), Date.now(), document.hidden === true);
    setRun(next);
    if (!same) setShowBack(!!next.revealed);
    if (!embeddedIn && !(stayOnGuided && nav.page === 'guided')) setPage('review');
    const opened = entryForRun(next, input, { draft: (teaching) => readTeachingDraft(refs.dataRef.current?.root, teaching) });
    setEntry(same ? keepTyped(opened, entryRef.current) : opened);
  }, [nav.show, setPage, refs, embeddedIn, nav.page, syncDraft, setEntry]);
  const enterMovedRun = useCallback((next, input, options) => enterRun(next, input, true, options), [enterRun]);
  const revealFlights = useRef(new Map());
  const revealKeyOf = (r) => (r?.card?.id ? `${r.id}:${r.index}:${r.card.id}:${r.queueVersion || 0}` : '');
  const toggleMarkTerms = useCallback(() => {
    const current = runRef.current;
    if (pageRef.current !== 'review' || !current?.card || current.complete || current.mode === 'exam') return;
    setMarkingTerms((value) => !value);
  }, []);
  const exitMarkTerms = useCallback(() => setMarkingTerms(false), []);
  const reset = useCallback(() => { revealFlights.current.clear(); draftSaver.current.discard(); draftBase.current = { key: '', signature: '' }; liveStore.set({ pendingAnswer: null, keyGrade: null, autoAdvancePaused: false, explainHidden: false }); setRun(null); setShowBack(false); setMarkingTerms(false); setEntry(emptyEntry()); }, [liveStore, setEntry]);
  const clearRun = useCallback(() => { setMarkingTerms(false); setRun(null); }, []);
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
    priorQueue.current = { id: run?.id, version: queueVersion, index: run?.index, cardId: run?.card?.id };
    // A rebuilt queue that replaced the question on screen: what the library kept for the new one comes back. The same question keeps what is typed.
    if (shouldResetEntry(previous, run)) setEntry(entryForRun(run, null, { draft: (teaching) => readTeachingDraft(dataRoot(), teaching) }));
    setMarkingTerms(false);
  }, [run?.id, queueVersion, run?.index, run?.card?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (page !== 'review' || !run?.card || run?.complete || run?.mode === 'exam') setMarkingTerms(false);
  }, [page, run?.card, run?.complete, run?.mode]);
  // Re-anchor draft base when the active run/card changes; per-keystroke syncing runs directly in setEntry without App re-renders.
  useEffect(() => { syncDraft(); }, [run, syncDraft]);
  // Each card mounts on the side matching its state; flipping after that is local.
  useEffect(() => { setShowBack(!!run?.revealed); }, [run?.id, run?.card?.id, run?.index, run?.queueVersion, run?.revealed]);

  /* Links and fixes made in the conversation reach the open question without a reload. While nothing changes the poll slows down to every 30 s; a helper task on
     the question (or one just sent) keeps it at 4 s, so its answer shows within one interval (#1011). */
  const assistSentAt = useRef(0);
  const pollRun = useCallback(async () => {
    const current = runRef.current;
    if (!current?.id) return undefined;
    const next = await call('review.get', { runId: current.id });
    const active = runRef.current;
    if (!active || active.id !== current.id) return undefined;
    const inFlightReveal = revealFlights.current.has(revealKeyOf(active));
    const reconciled = inFlightReveal && next && !next.revealed ? { ...next, revealed: true } : next;
    const running = assistRunningOn(refs.dataRef.current?.assist, active?.card?.id) || Date.now() - assistSentAt.current < ASSIST_SENT_FAST_MS;
    const merged = mergeReviewPollWithFollowups(active, reconciled);
    if (merged === active) return { unchanged: true, running };
    setRun((existing) => (existing === active ? merged : mergeReviewPollWithFollowups(existing, reconciled)));
    return { running };
  }, [call, refs]);
  // A finished round keeps asking while a grade is on its way (#1031): it lands on the result page, not on the next visit. Corrections waiting to be
  // read change only when the learner reads them (here, or in another window: the round is read again when this window comes back).
  const polling = usePolling(pollRun, { intervalMs: REVIEW_POLL_MS, backoff: reviewPollDelay, enabled: page === 'review' && (!!run?.card?.id || (!!run?.complete && gradeRunning(run))) });
  const waitingCorrections = page === 'review' && !!run?.complete && gradesOutstanding(run) && !gradeRunning(run);
  useEffect(() => {
    if (!waitingCorrections) return undefined;
    const back = () => { void pollRun().catch(() => {}); };
    window.addEventListener('focus', back);
    return () => window.removeEventListener('focus', back);
  }, [waitingCorrections, pollRun]);
  const pollingRef = useRef(polling);
  pollingRef.current = polling;
  // A new question on screen: the rhythm starts again at 4 s, without an extra request. A task that ends on the question asks at once (QuestionRun).
  useEffect(() => { pollingRef.current.restart(); }, [run?.id, run?.index, run?.card?.id]);
  const pollNow = useCallback(() => pollingRef.current.refresh(), []);
  // A dialog over the question closes (the reader, whose 本节题目 panel may have answered this very round, #1013): ask for the round once, at once, rather
  // than show a stale question until the slowed-down poll comes round (a different option would then be refused as already answered).
  const modalWas = useRef(modalOpen);
  useEffect(() => {
    if (modalWas.current && !modalOpen && page === 'review' && runRef.current?.card?.id) pollingRef.current.refresh();
    modalWas.current = modalOpen;
  }, [modalOpen, page]);

  /* ── one step of the round ── */
  const stepWaiting = useRef(false);
  const pendingTokenRef = useRef(null);
  const reviewAct = useCallback((action, args = {}) => {
    const current = runRef.current;
    if (!current?.id) return Promise.resolve();
    const isAnswer = action === 'review.answer';
    // Passing self-grades (3–5) may auto-advance; low grades (0–2) always stay on the current card so the learner can close the error loop.
    let resolvedArgs = isAnswer && isSelfGradedRun(current) && Number.isInteger(args.grade) && args.advanceOnSelfGrade === undefined
      ? {
          ...args,
          advanceOnSelfGrade: args.grade >= 3 && shouldAdvanceOnSelfGrade({
            selfGradeAdvance: selfGradeAdvanceRef.current,
            autoTerms: autoTermsRef.current,
            grade: args.grade,
          }),
        }
      : args;
    // Piggyback local assistance & dirty draft directly on `review.answer` and cancel pending debounced `review.draft.save` to eliminate the serial RPC waterfall.
    if (isAnswer && current.mode !== 'exam') {
      const localEntry = entryRef.current;
      const inline = {};
      if (localEntry.assistance && resolvedArgs.assistance === undefined) inline.assistance = localEntry.assistance;
      if (resolvedArgs.draft === undefined && (draftSaver.current.dirty() || (localEntry.response && localEntry.response.trim()))) {
        inline.draft = draftPayloadOf(localEntry).draft;
      }
      if (Object.keys(inline).length) resolvedArgs = { ...inline, ...resolvedArgs };
      draftSaver.current.discard(draftKey(refs.dataRef.current?.root, current));
    }
    const optimisticToken = isAnswer ? {} : null;
    if (isAnswer) {
      pendingTokenRef.current = optimisticToken;
      const entryKey = reviewEntryKey(current);
      const pending = Array.isArray(resolvedArgs.selected)
        ? { key: entryKey, kind: 'choice', selected: resolvedArgs.selected }
        : Number.isInteger(resolvedArgs.grade)
          ? { key: entryKey, kind: 'grade', grade: resolvedArgs.grade }
          : resolvedArgs.answers
            ? { key: entryKey, kind: 'cloze' }
            : { key: entryKey, kind: 'other' };
      liveStore.set({ pendingAnswer: pending });
    }
    const clearPending = () => {
      if (optimisticToken && pendingTokenRef.current === optimisticToken) {
        pendingTokenRef.current = null;
        liveStore.set({ pendingAnswer: null });
      }
    };
    const step = () => {
      const latest = runRef.current || current;
      return Promise.resolve(act(action, { runId: latest.id, cardId: latest.card?.id, queueVersion: latest.queueVersion || 0, ...resolvedArgs, ...awayArgs(action, latest) }, (result) => {
        const fb = result?.feedback || result?.gradedFeedback;
        if (latest?.mode !== 'exam' && result?.mode !== 'exam' && !latest?.complete && result?.complete && (result.answered || 0) > 0) {
          playSound('complete');
        } else if ((action === 'review.answer' || (action === 'review.grade.adjust' && resolvedArgs.clozeEquivalent)) && fb && latest?.mode !== 'exam') {
          if (fb.selfReported || fb.assessment === 'self-report') playSound('correct');
          else if (fb.correct) playSound(isEarnedLevelClimb(fb, result.feedbackTelemetry) ? 'levelUp' : 'correct');
          else playSound('miss');
        } else if (action === 'review.reveal' && !latest?.revealed && result?.revealed) {
          playSound('flip');
        }
        clearPending();
        enterRun(result, undefined, action === 'review.move' || !!result?.selfGradeAdvanced || action === 'review.undo', { stayOnGuided: pageRef.current === 'guided' });
        if (action === 'review.answer' && result?.selfGradeAdvanced && result?.gradedFeedback && latest?.mode !== 'exam') {
          const gap = nextDueGap(result.gradedFeedback);
          const scope = reviewNoticeScope(refs.bindingRoot.current, 'review', result);
          notify({
            text: gap
              ? uiFormat('已记 {0} 分 · {1}后再见', [result.gradedFeedback.grade, gap])
              : uiFormat('已记 {0} 分 · 今天内再见', [result.gradedFeedback.grade]),
            scope,
            tone: 'info',
            timeout: 2600,
          });
        }
      },
        // Practice steps return the run they changed; the snapshot catches up on the next poll.
        // Only a finished round (including self-grade advance on the final card) reloads the library.
        { refreshAfter: (result) => !!result?.complete || action === 'review.undo' || (action !== 'review.move' && action !== 'review.answer' && action !== 'review.reveal') }))
        .finally(clearPending);
    };
    const pendingReveal = isAnswer ? revealFlights.current.get(revealKeyOf(current)) : null;
    const needsDraftFlush = SAVES_FIRST.has(action) && (syncDraft(), draftSaver.current.dirty());
    if (!pendingReveal && !needsDraftFlush) return step();
    // Like act() itself: one step at a time, a second click while this one waits for its reveal/save is dropped.
    if (stepWaiting.current) { clearPending(); return Promise.resolve(); }
    stepWaiting.current = true;
    const rKey = revealKeyOf(current);
    return Promise.all([
      pendingReveal ? pendingReveal.then((res) => res !== null) : true,
      needsDraftFlush ? flushDraft() : true,
    ]).then(([revealedOk, savedOk]) => (revealedOk && savedOk && revealKeyOf(runRef.current) === rKey ? step() : undefined))
      .finally(() => { stepWaiting.current = false; clearPending(); });
  }, [act, awayArgs, enterRun, flushDraft, liveStore, notify, refs, syncDraft]);
  const reviewActRef = useRef(reviewAct);
  reviewActRef.current = reviewAct;

  /* ── 先跳过 and 到此为止 (#1008): the round's own steps, review.move {index} and review.end, nothing new on the host ── */
  useEffect(() => { setSkippedIndices(new Set()); }, [run?.id]);
  useEffect(() => {
    const nav = run?.navigation;
    const answeredFeedbackIndex = run?.feedback && typeof run?.index === 'number' ? run.index : null;
    if (!nav?.length && answeredFeedbackIndex === null) return;
    setSkippedIndices((prev) => {
      if (!prev.size) return prev;
      const done = new Set((nav || []).filter((item) => item.answered).map((item) => item.index));
      if (answeredFeedbackIndex !== null) done.add(answeredFeedbackIndex);
      let changed = false;
      for (const idx of prev) if (done.has(idx)) { changed = true; break; }
      if (!changed) return prev;
      const next = new Set(prev);
      for (const idx of done) next.delete(idx);
      return next;
    });
  }, [run?.navigation, run?.feedback, run?.index]);
  // 先跳过: the next question nobody answered yet; this one stays in the round and comes back at its end, its clock started again.
  const skipQuestion = useCallback(() => {
    const current = runRef.current;
    const target = skipTarget(current);
    if (target === null) return undefined;
    const skippedIndex = current.index;
    setSkippedIndices((prev) => {
      if (prev.has(skippedIndex)) return prev;
      const next = new Set(prev);
      next.add(skippedIndex);
      return next;
    });
    return reviewActRef.current('review.move', { index: target });
  }, []);
  // 到此为止 asks first (the one InlineConfirm under the question, whoever asked: 更多, the rail or the list of questions), then ends the round: the answered
  // questions keep their grades, the rest record nothing, and the result page opens like a finished round's (reviewAct reloads the library after it).
  const [endAsked, setEndAsked] = useState(false);
  const hasFeedback = !!run?.feedback;
  useEffect(() => { setEndAsked(false); }, [run?.id, run?.complete]);
  useEffect(() => { setExplainHidden(false); }, [run?.id, run?.index, run?.card?.id, hasFeedback, setExplainHidden]);
  const endRound = useCallback(async () => {
    if (!runRef.current?.id || runRef.current.complete || runRef.current.mode === 'exam') return;
    // A dropped call (another step holds act(), or it failed) resolves with nothing: the question stays asked, so the press is not lost.
    if (await reviewActRef.current('review.end')) setEndAsked(false);
  }, []);
  /* The question's own actions that live in QuestionRun (写笔记, 标为重点, its page): it puts them here, and the keys N / F / O run them. */
  const questionKeys = useRef({});

  const flipCard = useCallback(() => {
    const current = runRef.current;
    if (!current?.card) return undefined;
    const rKey = revealKeyOf(current);
    if (current.revealed || revealFlights.current.has(rKey)) {
      setShowBack((value) => !value);
      playSound('flip');
      return revealFlights.current.get(rKey);
    }
    if (current.grading) return undefined;
    // Zero-wait local flip: turn the card immediately without locking `busy`, reconciling `solution` when `review.reveal` settles.
    setShowBack(true);
    playSound('flip');
    const optimistic = { ...current, revealed: true };
    runRef.current = optimistic;
    setRun((prev) => (revealKeyOf(prev) === rKey ? { ...prev, revealed: true } : prev));
    const promise = callRef.current('review.reveal', {
      runId: current.id,
      cardId: current.card.id,
      queueVersion: current.queueVersion || 0,
    }).then((result) => {
      if (result && revealKeyOf(runRef.current) === rKey && !runRef.current?.feedback) {
        const merged = { ...result, revealed: true };
        runRef.current = merged;
        setRun((prev) => (revealKeyOf(prev) === rKey && !prev?.feedback ? merged : prev));
      }
      return result;
    }).catch((failure) => {
      if (revealKeyOf(runRef.current) === rKey && !runRef.current?.feedback) {
        setShowBack(false);
        const reverted = { ...runRef.current, revealed: false };
        runRef.current = reverted;
        setRun((prev) => (revealKeyOf(prev) === rKey ? { ...prev, revealed: false } : prev));
        setError(errorMessage(failure));
      }
      return null;
    }).finally(() => {
      if (revealFlights.current.get(rKey) === promise) revealFlights.current.delete(rKey);
    });
    revealFlights.current.set(rKey, promise);
    return promise;
  }, [setError]);
  const choose = useCallback((id) => {
    const current = runRef.current;
    if (isBusy() || !current || current.feedback) return;
    if (current.card.kind === 'multi') {
      playSound('tap');
      patch((value) => ({ selected: value.selected.includes(id) ? value.selected.filter((item) => item !== id) : [...value.selected, id] }));
    } else reviewActRef.current('review.answer', { selected: [id] });
  }, [isBusy, patch]);

  /* ── autopilot: after a pass, move on by itself unless the learner touches anything during the short countdown ── */
  const autoTimer = useRef(null), autoSkipped = useRef('');
  const autoPausedRef = useRef(false), autoRemainingRef = useRef(AUTO_ADVANCE_MS), autoStartedAtRef = useRef(0), autoKeyRef = useRef('');
  const autoHold = useRef(''), [holdTick, setHoldTick] = useState(0);
  const scheduleAutoTimer = useCallback((ms) => {
    clearTimeout(autoTimer.current);
    autoStartedAtRef.current = Date.now();
    autoRemainingRef.current = ms;
    autoTimer.current = setTimeout(() => {
      autoTimer.current = null;
      autoKeyRef.current = '';
      autoPausedRef.current = false;
      setAutoAdvancePausedState(false);
      setAutoAdvance('');
      reviewActRef.current('review.move', { direction: 1 });
    }, ms);
  }, [setAutoAdvancePausedState]);
  const setAutoAdvancePaused = useCallback((paused) => {
    const next = !!paused;
    if (!autoKeyRef.current) return;
    if (next === autoPausedRef.current) return;
    autoPausedRef.current = next;
    setAutoAdvancePausedState(next);
    if (next) {
      if (autoTimer.current) {
        clearTimeout(autoTimer.current);
        autoTimer.current = null;
        const elapsed = Math.max(0, Date.now() - autoStartedAtRef.current);
        autoRemainingRef.current = Math.max(0, autoRemainingRef.current - elapsed);
      }
    } else if (autopilotRef.current && autoKeyRef.current && autoSkipped.current !== autoKeyRef.current && autoHold.current !== autoKeyRef.current) {
      scheduleAutoTimer(Math.max(autoRemainingRef.current, 450));
    }
  }, [scheduleAutoTimer, setAutoAdvancePausedState]);
  const cancelAutoAdvance = useCallback(() => {
    if (!autoTimer.current && !autoKeyRef.current) return;
    clearTimeout(autoTimer.current);
    autoTimer.current = null;
    autoKeyRef.current = '';
    autoPausedRef.current = false;
    autoRemainingRef.current = 0;
    setAutoAdvancePausedState(false);
    setAutoAdvance((key) => { autoSkipped.current = key; return ''; });
  }, [setAutoAdvancePausedState]);
  const cancelRef = useRef(cancelAutoAdvance);
  cancelRef.current = cancelAutoAdvance;
  /* The question the learner was taken to read (showExplanation, below): the autopilot leaves it alone until another question is on screen (keepAutopilotHold). */
  const passed = isPassed(run), advanceKey = advanceKeyOf(run);
  useEffect(() => {
    clearTimeout(autoTimer.current);
    autoTimer.current = null;
    autoHold.current = keepAutopilotHold(autoHold.current, advanceKey);
    const plan = autopilotPlan({ autopilot, page, passed, grading: !!run?.grading, complete: run?.complete, teaching: entrySignal.hasTeaching, skippedKey: autoSkipped.current, advanceKey, holdKey: autoHold.current });
    if (!plan.schedule) {
      autoKeyRef.current = '';
      autoPausedRef.current = false;
      autoRemainingRef.current = 0;
      setAutoAdvancePausedState(false);
      setAutoAdvance('');
      return undefined;
    }
    autoKeyRef.current = plan.key;
    autoPausedRef.current = false;
    autoRemainingRef.current = plan.ms;
    setAutoAdvancePausedState(false);
    setAutoAdvance(plan.key);
    scheduleAutoTimer(plan.ms);
    return () => { clearTimeout(autoTimer.current); autoTimer.current = null; };
  }, [autopilot, page, passed, !!run?.grading, advanceKey, run?.complete, entrySignal.hasTeaching, holdTick, scheduleAutoTimer, setAutoAdvancePausedState]); // eslint-disable-line react-hooks/exhaustive-deps

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
      setRun((current) => (reviewEntryKey(current) === key ? mergeReviewPollWithFollowups(current, next) : current));
    } catch (failure) {
      const msg = errorMessage(failure);
      if (!modelReadiness(refs.dataRef.current).ready || describeModelError(msg).action === 'settings' || /没有可用的.*模型|未配置|密钥/.test(String(failure?.message || failure))) {
        setShowEn(false);
      }
      if (isCurrentEntry(runRef.current, key)) setError(msg);
    } finally {
      enFlights.current.end(key);
      setEnBusyKey((current) => (current === key ? '' : current));
    }
  }, [call, refs, setError, setShowEn]);
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

  /* ── Candidate unfamiliar terms: one lightweight extraction per wrong revealed entry ── */
  const candidateFlights = useRef(createFlightSet());
  const fetchCardTerms = useCallback(async (target) => {
    if (!target?.card || target.complete || target.mode === 'exam') return;
    if (!target.revealed || !target.feedback || target.feedback.selfReported || isPassed(target)) return;
    const key = reviewEntryKey(target);
    if (!candidateFlights.current.begin(key)) return;
    setAutoTermsBusyKey(key);
    try {
      await call('card.terms', { deckId: target.deckId, cardId: target.card.id });
      const next = await call('review.get', { runId: target.id });
      setRun((current) => (reviewEntryKey(current) === key ? mergeReviewPollWithFollowups(current, next) : current));
    } catch (failure) {
      const msg = errorMessage(failure);
      if (
        !modelReadiness(refs.dataRef.current).ready ||
        describeModelError(msg).action === 'settings' ||
        /没有可用的.*模型|未配置|密钥/.test(String(failure?.message || failure))
      ) {
        setAutoTerms(false);
      }
      if (isCurrentEntry(runRef.current, key)) setError(msg);
    } finally {
      candidateFlights.current.end(key);
      setAutoTermsBusyKey((current) => (current === key ? '' : current));
    }
  }, [call, refs, setError, setAutoTerms]);
  const cardTermsMissing = run?.solution?.terms === undefined;
  useEffect(() => {
    // The run is read through its ref (set in every render), so the effect depends on the fields below and not on the object a poll replaces.
    const current = runRef.current;
    if (page !== 'review' || !autoTerms || !current?.card || current.complete || current.mode === 'exam') return;
    if (!current.revealed || !current.feedback || current.feedback.selfReported || isPassed(current)) return;
    if (current.solution?.terms !== undefined) return;
    fetchCardTerms(current);
    // Primitive feedback fields avoid polling churn while reacting to reveal, answer grade, or card edits.
  }, [page, autoTerms, run?.id, run?.index, run?.card?.id, run?.revealed, run?.feedback?.correct, run?.feedback?.grade, run?.feedback?.selfReported, cardTermsMissing, fetchCardTerms]);
  const toggleAutoTerms = useCallback(() => {
    const next = !autoTerms;
    setAutoTerms(next);
    if (next && runRef.current?.solution?.terms === undefined) fetchCardTerms(runRef.current);
  }, [autoTerms, setAutoTerms, fetchCardTerms]);

  /* ── the step-by-step teaching panel ── */
  const teachingFlights = useRef(createFlightSet());
  // Each request holds a token; cancelling (or a newer request) drops the token, and a late answer carrying an old one is ignored.
  const teachingTokens = useRef(new Map());
  const [teachingFailure, setTeachingFailure] = useState({});
  const endTeaching = useCallback((key) => {
    teachingTokens.current.delete(key);
    teachingFlights.current.end(key);
    setTeachingPending((all) => { const rest = { ...all }; delete rest[key]; return rest; });
  }, []);
  const teachingAct = useCallback(async (action, args = {}) => {
    const origin = runRef.current, key = reviewEntryKey(origin), draftAtStart = entryRef.current.teachAnswer;
    if (!teachingFlights.current.begin(key)) return;
    const token = {};
    teachingTokens.current.set(key, token);
    setTeachingPending((all) => ({ ...all, [key]: true }));
    setTeachingFailure((all) => { const rest = { ...all }; delete rest[key]; return rest; });
    const isCurrent = () => teachingTokens.current.get(key) === token && isCurrentEntry(runRef.current, key, { page: pageRef.current, needPage: 'review' });
    try {
      const next = await call(action, { runId: origin.id, cardId: origin.card.id, index: origin.index, queueVersion: origin.queueVersion || 0, ...args });
      if (isCurrent()) {
        patch((current) => {
          let teachAnswer = current.teachAnswer;
          if (action === 'teach.start' && teachAnswer === draftAtStart) teachAnswer = readTeachingDraft(dataRoot(), next);
          if (action === 'teach.skip' || (action === 'teach.answer' && next.index > args.stepIndex && teachAnswer === args.answer)) teachAnswer = '';
          return { teaching: next, teachAnswer };
        });
      }
    } catch (failure) {
      // Shown beside the chips (TeachingStatus), where the learner is looking, not in the page's global error.
      if (isCurrent()) setTeachingFailure((all) => ({ ...all, [key]: { message: errorMessage(failure), action, args } }));
    } finally {
      if (teachingTokens.current.get(key) === token) endTeaching(key);
    }
  }, [call, patch, endTeaching]); // eslint-disable-line react-hooks/exhaustive-deps
  const cancelTeaching = useCallback(() => endTeaching(reviewEntryKey(runRef.current)), [endTeaching]);
  const retryTeaching = useCallback(() => {
    const failed = teachingFailure[reviewEntryKey(runRef.current)];
    if (failed) teachingAct(failed.action, failed.args);
  }, [teachingFailure, teachingAct]);

  /* ── helping the learner: the background assistant, slaying, prerequisites ── */
  // `quiet`: the caller shows the state itself (a spoken answer's 正在批改 under the question, #1031), so no toast covers the page.
  const assistCard = useCallback(async (mode, text, helpChoices = [], extra = undefined, { quiet = false } = {}) => {
    const current = runRef.current;
    const originKey = reviewEntryKey(current);
    const rawNote = mode === 'ask' && typeof extra?.thinkingNote === 'string' ? extra.thinkingNote.trim().slice(0, 200) : '';
    const trimmedText = String(text || '').trim();
    if (!current?.card || !originKey || (!trimmedText && !(mode === 'ask' && (helpChoices.length || rawNote)) && !(mode === 'derive' && extra?.followupId) && !(mode === 'terms' && Array.isArray(extra?.terms) && extra.terms.length))) return false;
    // Asking or filling marked terms helps understand before answering; 修题 and 出成题 change the bank, and 批改 grades the written answer.
    if (mode === 'ask' || mode === 'terms') { noteAssistance('askedTutorBeforeAnswer'); patch({ explain: true }); }
    if (mode === 'grade') {
      if (!(await flushDraft())) return false;
      if (!isCurrentEntry(runRef.current, originKey)) return false;
    }
    // Persist optional 1-sentence thinkingNote onto the underlying attempt (narrow `attempts` lock; ignores missing attempt cleanly).
    if (rawNote) {
      Promise.resolve(call('attempt.errorReason.set', {
        deckId: current.deckId,
        cardId: current.card.id,
        runId: current.id,
        thinkingNote: rawNote,
      })).catch(() => {});
    }
    const mergedAskText = mode === 'ask' && rawNote
      ? (trimmedText ? `${trimmedText}\n\n${uiFormat('刚才卡住的思路：{0}', [rawNote])}` : rawNote)
      : trimmedText;
    try {
      await submitAssist(call, { deckId: current.deckId, cardId: current.card.id, runId: current.id,
        mode, text: mergedAskText.slice(0, 1000), helpChoices,
        ...(mode === 'derive' && extra ? { derive: extra } : {}),
        ...(mode === 'terms' && extra?.terms ? { terms: extra.terms } : {}),
        uiLanguage: getUiLanguage() });
      // Back to the quick rhythm at once: the answer must not wait out a slowed-down poll.
      assistSentAt.current = Date.now();
      pollingRef.current.refresh();
      if (!quiet) notify(mode === 'ask' ? ui('后台助教正在解答。讲解会出现在这道题下面的问答里，完成时信箱会提醒你。')
        : mode === 'derive' ? ui('后台助教正在出题。新题会放进同一题组，完成时信箱会提醒你。')
          : mode === 'terms' ? ui('后台助教正在补词。台阶讲解和前置检查题会出现在这道题下面，完成时信箱会提醒你。')
            : mode === 'grade' ? { text: ui('已提交批改：后台按评分标准逐项打分，结果会显示在这道题下，完成时信箱也会提醒你。'), tone: 'success' }
              : ui('后台助教正在改这道题，会直接改这张卡。完成时信箱会提醒你，在信箱里可以一步撤销。'));
      core.refresh().catch(() => {});
      return true;
    } catch (failure) {
      if (isCurrentEntry(runRef.current, originKey)) {
        setError(failure.message || ui('这次没有提交成功，也没有拿到具体原因。可以再提交一次。'));
      }
      return false;
    }
  }, [call, notify, setError, core, noteAssistance, patch, flushDraft]);
  // Slaying is one click next to other tools; offer an immediate undo instead of sending the learner to the slay deck in 管理题组.
  const slayCard = useCallback(async () => {
    const current = runRef.current;
    if (!current?.card) return;
    const ref = { deckId: current.deckId, cardId: current.card.id };
    const next = await reviewActRef.current('card.slay', { deckId: ref.deckId });
    if (!next) return;
    const scope = reviewNoticeScope(refs.bindingRoot.current, 'review', next);
    notify({ text: ui('已斩这道题：移入斩题组，不再复习。'), scope, action: { label: ui('撤销'), run: () => act('card.restore', ref, () =>
      notify({ text: ui('已恢复到原题组，复习进度不变；本轮练习不再出现这道题。'), scope })) } });
  }, [act, notify, refs]);
  // Practise the given prerequisites (learned ones included), then offer a way back to this question.
  // The way back remembers what was typed or picked on the original question, so it is found as it was left.
  const returnInput = useRef(null);
  // `extra`: more of review.start, e.g. similarFor (试一道同类题, #1015: which question the detour is for).
  const studyPrerequisites = useCallback(async (list, extra = {}) => {
    const origin = runRef.current;
    const originKey = reviewEntryKey(origin);
    if (!origin?.id || !originKey) return undefined;
    if (!(await flushDraft())) return undefined;
    if (!isCurrentEntry(runRef.current, originKey)) return undefined;
    returnInput.current = { runId: origin.id, input: { key: originKey, ...entryRef.current } };
    return act('review.start', practiceArgs(list.map(({ deckId, cardId }) => ({ deckId, cardId })), { returnTo: origin.id, ...extra }), enterRun);
  }, [act, enterRun, flushDraft]);

  /* ── hint and explanation: the hint is help the answer got, once it is opened and has something to show (#542) ── */
  const toggleHint = useCallback(() => {
    if (!entryRef.current.hint && runRef.current?.card?.hint?.trim()) noteAssistance('hintUsed');
    patch((value) => ({ hint: !value.hint }));
  }, [noteAssistance, patch]);

  const undoAnswer = useCallback(() => {
    const current = runRef.current;
    if (!current?.id || !current.undoable || current.mode === 'exam' || current.closed) return undefined;
    cancelRef.current?.();
    return act('review.undo', { runId: current.id, attemptId: current.undoable.attemptId }, (result) => {
      playSound('flip');
      autoHold.current = advanceKeyOf(result);
      setHoldTick((tick) => tick + 1);
      enterRun(result, undefined, true);
      setShowBack(true);
    }, { refreshAfter: true });
  }, [act, enterRun]);

  /* ── the keyboard ── */
  const engaged = useRef(false), keyHandler = useRef(null);
  // Clicking an option or grade disables it, which drops focus to <body>. Keep shortcuts alive when the learner's last interaction was in the panel.
  const gateContext = () => {
    const active = document.activeElement;
    return { inside: !!(rootRef.current?.contains(active) || ((!active || active === document.body) && engaged.current)), modalOpen };
  };
  // A dialog over the page, or the 对照栏 beside the question (#1012), takes the keys; the dialog the question itself sits in (the reader's 本节题目, #1013) does not.
  const eventShape = (event) => ({ key: event.key, code: event.code, shiftKey: event.shiftKey, repeat: event.repeat, defaultPrevented: event.defaultPrevented,
    ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey,
    inEditable: !!event.target.closest?.('input,textarea,select,[contenteditable]') || keysElsewhere(event.target, rootRef.current), onButton: !!event.target.closest?.('button') });
  const canShortcut = useCallback((event) => shortcutGate(eventShape(event), gateContext()) && !event.defaultPrevented && !event.repeat && !event.shiftKey && pageRef.current === 'review' && !!runRef.current?.card, [modalOpen, rootRef]); // eslint-disable-line react-hooks/exhaustive-deps
  keyHandler.current = (event) => {
    const shape = eventShape(event);
    const k = shape.key?.toLowerCase();
    if ((k === 'g' || k === 'b') && !shape.repeat && !shape.shiftKey && page === 'review' && run?.card && shortcutGate(shape, gateContext())) cancelAutoAdvance();
    const liveEntry = entryRef.current;
    const outcome = shortcutAction(shape, { ...gateContext(), page, run, busy: isBusy(), showBack: showBackRef.current, shortcutHelp, endAsked, markingTerms, choice, isCloze, rubricCard, selected: liveEntry.selected, clozeValues: liveEntry.clozeValues });
    if (!outcome) return;
    cancelAutoAdvance();
    if (outcome.preventDefault) event.preventDefault();
    const action = outcome.action;
    if (!action) return;
    if (action.type === 'help') setShortcutHelp((value) => !value);
    else if (action.type === 'help-close') { event.preventDefault(); setShortcutHelp(false); }
    else if (action.type === 'end-cancel') { setEndAsked(false); rootRef.current?.querySelector?.('.question-card')?.focus?.({ preventScroll: true }); }
    else if (action.type === 'mark-terms') toggleMarkTerms();
    else if (action.type === 'mark-terms-exit') exitMarkTerms();
    else if (action.type === 'autopilot') toggleAutopilot();
    else if (action.type === 'undo') undoAnswer();
    else if (action.type === 'resume') late.current.resume?.();
    else if (action.type === 'answer') { markKeyGrade(pressedGradeOf(action)); reviewAct('review.answer', action.args); }
    else if (action.type === 'move') reviewAct('review.move', { direction: action.direction });
    else if (action.type === 'flip') flipCard();
    else if (action.type === 'hint') toggleHint();
    else if (action.type === 'explain') { if (runRef.current?.feedback) setExplainHidden((value) => !value); else patch((value) => ({ explain: !value.explain })); }
    else if (action.type === 'assist-plain') assistCard('ask', '', ['plain']);
    else if (action.type === 'choose') choose(action.id);
    else if (action.type === 'clear-choice') patch({ selected: [] });
    else if (action.type === 'skip') skipQuestion();
    else if (['note', 'focus', 'source', 'voice', 'voice-ask', 'focus-cloze', 'socratic-toggle'].includes(action.type)) questionKeys.current[action.type]?.();
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
  // A question mounted elsewhere (embeddedIn) that leaves the screen is not where the learner last was: its keys wait for a new press or focus in it.
  // Conversely, arriving on the standalone Review page from Home (whose button unmounts on navigation) arms shortcuts without forcing an extra click.
  const hasCard = !!run?.card;
  useEffect(() => {
    if (embeddedIn && page !== 'review') engaged.current = false;
    else if (!embeddedIn && page === 'review' && hasCard) engaged.current = true;
  }, [embeddedIn, page, run?.id, hasCard]);

  /* ── what Review and the result page's coach strip are handed ── */
  const onCoachPractice = useCallback(() => act('coach.practice', {}, enterRun), [act, enterRun]);
  /* Where 继续学习 goes (ui/review/session-logic.js continueDestination): the original question after a prerequisite round, the scope while it has
     questions left, else the next unfinished action of today's plan (`plan` is the daily plan controller, when the page has one), else the path.
     Returns the decision with its label, a note for the learner and `go()`; the results page and the coach card's autopilot take the same one. */
  const continueTo = useCallback((plan) => {
    const data = refs.dataRef.current;
    const destination = continueDestination({ run, runs: data?.runs, progress: data?.progress, tasks: plan?.state?.tasks });
    const go = () => {
      if (destination.kind === 'original') {
        return act('review.get', { runId: destination.runId },
          (result) => enterRun(result, returnInput.current?.runId === destination.runId ? returnInput.current.input : undefined));
      }
      if (destination.kind === 'plan' && plan?.start) return plan.start(destination.taskId);
      // The next round of the course the finished round was a round of: the same arguments the home card starts it with.
      if (destination.course !== undefined) return act('review.start', practiceArgs(undefined, { course: destination.course, daily: true }), enterRun);
      return act('review.start', practiceArgs(destination.kind === 'scope' ? destination.scope : []), enterRun);
    };
    return { ...destination, label: continueLabel(destination), note: continueNote(destination), go };
  }, [run, act, enterRun, refs]);
  const activeAutoAdvance = Boolean(autoAdvance && autoAdvance === advanceKey);
  const coach = useMemo(() => ({
    autopilot,
    onStatus: () => core.refresh().catch(() => {}),
    onPractice: onCoachPractice,
    onContinue: () => continueTo(null).go(),
    onReviewWeak: () => act('review.weak.start', { runId: runRef.current?.id }, enterRun),
    canShortcut,
    cancelAutoAdvance,
    autoAdvance: activeAutoAdvance ? AUTO_ADVANCE_MS : 0,
    autoAdvanceActive: activeAutoAdvance,
    get autoAdvancePaused() { return liveStore.get().autoAdvancePaused; },
    setAutoAdvancePaused,
    debrief: null,
  }), [autopilot, core, onCoachPractice, continueTo, act, enterRun, canShortcut, cancelAutoAdvance, activeAutoAdvance, liveStore, setAutoAdvancePaused]);
  const actions = useMemo(() => ({
    reviewAct, choose, clearChoice: () => patch({ selected: [] }), flipCard, assistCard, slayCard, studyPrerequisites, teachingAct, cancelTeaching, retryTeaching, toggleEn, toggleAutoTerms,
    toggleHelp: () => { if (runRef.current?.feedback) setExplainHidden((value) => !value); else if (runRef.current?.revealed) patch((value) => ({ explain: !value.explain })); else toggleHint(); },
    noteAssistance,
    // Opening a question to read its Q&A (a 信箱 letter): the explanation shows and the autopilot is held on this question, whatever the answer was.
    showExplanation: () => { setExplainHidden(false); patch({ explain: true }); autoHold.current = advanceKeyOf(runRef.current); setHoldTick((tick) => tick + 1); },
    setResponse: (response) => patch({ response }),
    setClozeValue: (id, value) => patch((current) => ({ clozeValues: { ...current.clozeValues, [id]: value } })),
    setTeachAnswer: (teachAnswer) => patch({ teachAnswer }),
    closeShortcutHelp: () => setShortcutHelp(false),
    // The sidebar's 快捷键 entry opens the same sheet as the ? key (ui/ShortcutHelp.jsx): one sheet, two ways in.
    openShortcutHelp: () => setShortcutHelp(true),
    toggleAutopilot,
    toggleSelfGradeAdvance,
    undoAnswer,
    setAutoAdvancePaused,
    skipQuestion,
    askEnd: () => setEndAsked(true),
    cancelEnd: () => setEndAsked(false),
    toggleMarkTerms,
    exitMarkTerms,
    endRound,
  }), [reviewAct, choose, flipCard, assistCard, slayCard, studyPrerequisites, teachingAct, cancelTeaching, retryTeaching, toggleEn, toggleAutoTerms, patch, setExplainHidden, toggleAutopilot, toggleSelfGradeAdvance, undoAnswer, setAutoAdvancePaused, toggleHint, noteAssistance, skipQuestion, toggleMarkTerms, exitMarkTerms, endRound]);
  const currentEntryKey = reviewEntryKey(run);
  const teachingBusy = !!teachingPending[currentEntryKey];
  const teachingError = teachingFailure[currentEntryKey]?.message || '';
  return useMemo(() => ({
    run,
    subscribeLive: liveStore.subscribe,
    getLive: liveStore.get,
    get entry() { return liveStore.get().entry; },
    get keyGrade() { return liveStore.get().keyGrade; },
    get autoAdvancePaused() { return liveStore.get().autoAdvancePaused; },
    get explainHidden() { return liveStore.get().explainHidden; },
    get pendingAnswer() { return liveStore.get().pendingAnswer; },
    showBack, showEn, autoTerms, selfGradeAdvance, enBusyKey, autoTermsBusyKey, teachingBusy, teachingError,
    autopilot, autoAdvance, autoAdvanceActive: activeAutoAdvance, setAutoAdvancePaused, advanceKey,
    skippedIndices, shortcutHelp, markingTerms, endAsked, questionKeys, choice, isCloze, rubricCard,
    coach, continueTo, onCoachPractice, enterRun, enterMovedRun, reset, clearRun, patchRun, pollRun, pollNow, actions, flushDraft,
  }), [
    run, liveStore, showBack, showEn, autoTerms, selfGradeAdvance, enBusyKey, autoTermsBusyKey, teachingBusy, teachingError,
    autopilot, autoAdvance, activeAutoAdvance, setAutoAdvancePaused, advanceKey,
    skippedIndices, shortcutHelp, markingTerms, endAsked, choice, isCloze, rubricCard,
    coach, continueTo, onCoachPractice, enterRun, enterMovedRun, reset, clearRun, patchRun, pollRun, pollNow, actions, flushDraft,
  ]);
}
