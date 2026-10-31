import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ui, getUiLanguage, errorMessage } from '../i18n.js';
import { mergeReviewPoll, reviewEntryKey } from '../async.js';
import { submitAssist } from '../assist-request.js';
import { readTeachingDraft, saveTeachingDraft } from '../teaching-draft.js';
import { reviewNoticeScope } from '../ActionFeedback.jsx';
import { usePersistentState } from '../storage.js';
import { usePolling } from '../use-polling.js';
import { EN_KEY, flag } from '../app/use-app-shell.js';
import { resolvePracticeSettings } from '../../lib/practice-settings.js';
import { practiceArgs } from '../learning-navigation.js';
import {
  AUTO_ADVANCE_MS, advanceKeyOf, autopilotPlan, continueDestination, createFlightSet, emptyEntry, entryForRun, isCurrentEntry, isPassed, reviewChoiceKind,
  shortcutAction, shortcutGate, shouldResetEntry,
} from './session-logic.js';
import { continueLabel, continueNote } from './continue-labels.js';
import { createDraftSaver, draftKey, draftPayloadOf, draftable, entrySignature, keepTyped, savedSignature } from './draft-persistence.js';

// These steps read the entry on the host (review.answer takes the help recorded there) or leave the question: what was typed goes first, and must arrive.
const SAVES_FIRST = new Set(['review.answer', 'review.move']);

/* The practice session (ui-consistency #112): the open run, what the learner has typed on its question, the teaching
   panel, the EN translation, the autopilot and the keyboard. It used to live in App, which re-rendered it on every
   library poll; Review now receives `session` (state + actions) and no setters. The rules are in session-logic.js.
   deps: core (call, act, notify, setError, refs), nav (page, setPage, show), modalOpen, host, rootRef, late
   (functions only App can build: resume).
   embeddedIn (optional): the name of another page that mounts <QuestionRun> (ui/review/QuestionRun.jsx) with this session. The question is
   then "on screen" while nav.page is that page, and enterRun leaves nav.page alone instead of going to 'review'. Without it, nothing changes. */
export function useReviewSession({ core, nav, modalOpen, host, rootRef, late, embeddedIn }) {
  const { call, act, notify, setError, busy, refs } = core;
  const [run, setRun] = useState(null);
  const [entry, setEntry] = useState(emptyEntry);
  const [showBack, setShowBack] = useState(false);
  const [showEn, setShowEn] = usePersistentState(EN_KEY, false, flag('1', '0'));
  const [enBusyKey, setEnBusyKey] = useState('');
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
  const [shortcutHelp, setShortcutHelp] = useState(false);
  const [teachingPending, setTeachingPending] = useState({});
  const { setPage } = nav;
  // The rules below (and session-logic.js) call the page that shows the question 'review', whichever page that is.
  const page = nav.page === (embeddedIn || 'review') ? 'review' : nav.page;
  const runRef = useRef(run), pageRef = useRef(page), entryRef = useRef(entry), busyRef = useRef(busy);
  runRef.current = run;
  pageRef.current = page;
  entryRef.current = entry;
  busyRef.current = busy;
  const patch = useCallback((change) => setEntry((current) => ({ ...current, ...(typeof change === 'function' ? change(current) : change) })), []);
  const kind = reviewChoiceKind(run);
  const { choice, isCloze, rubricCard } = kind;
  const dataRoot = () => refs.dataRef.current?.root;

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
  const syncDraftRef = useRef(syncDraft);
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
    const leave = () => { syncDraftRef.current(); draftSaver.current.flush(); };
    const hidden = () => { if (document.visibilityState === 'hidden') leave(); };
    window.addEventListener('pagehide', leave);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('pagehide', leave);
      document.removeEventListener('visibilitychange', hidden);
      leave();
    };
  }, []);

  /* ── entering and leaving a question ── */
  const enterRun = useCallback((next, input) => {
    if (!next) return;
    const root = refs.dataRef.current?.root;
    // The same open question handed back (a reveal's answer, the conversation opening it again): what is on screen is newer than what the library had when it answered.
    const same = !input && draftable(next) && draftKey(root, next) === draftKey(root, runRef.current);
    syncDraft();
    runRef.current = next;
    if (next.mode === 'exam') { nav.show.exam('exam', next.id); return; }
    setRun(next);
    if (!embeddedIn && nav.page !== 'guided') setPage('review');
    const opened = entryForRun(next, input, { draft: (teaching) => readTeachingDraft(refs.dataRef.current?.root, teaching) });
    setEntry(same ? keepTyped(opened, entryRef.current) : opened);
  }, [nav.show, setPage, refs, embeddedIn, nav.page, syncDraft]);
  const reset = useCallback(() => { draftSaver.current.discard(); draftBase.current = { key: '', signature: '' }; setRun(null); setEntry(emptyEntry()); }, []);
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
    priorQueue.current = { id: run?.id, version: queueVersion, index: run?.index, cardId: run?.card?.id };
    // A rebuilt queue that replaced the question on screen: what the library kept for the new one comes back. The same question keeps what is typed.
    if (shouldResetEntry(previous, run)) setEntry(entryForRun(run, null, { draft: (teaching) => readTeachingDraft(dataRoot(), teaching) }));
  }, [run?.id, queueVersion, run?.index, run?.card?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // After the rebuilt queue's reset above, so a new question's first pass sees its own entry.
  useEffect(() => { syncDraft(); }, [run, entry.selected, entry.response, entry.clozeValues, entry.assistance, syncDraft]);
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
  const stepWaiting = useRef(false);
  const reviewAct = useCallback((action, args = {}) => {
    const current = runRef.current;
    const step = () => act(action, { runId: current.id, cardId: current.card?.id, queueVersion: current.queueVersion || 0, ...args }, (result) => enterRun(result),
      // Practice steps return the run they changed; the snapshot catches up on the next poll.
      // Only a finished round reloads the library (its result page needs fresh counts).
      { refreshAfter: (result) => action === 'review.move' ? !!result.complete : action !== 'review.answer' && action !== 'review.reveal' });
    if (!SAVES_FIRST.has(action)) return step();
    syncDraft();
    if (!draftSaver.current.dirty()) return step();
    // Like act() itself: one step at a time, a second click while this one waits for its save is dropped.
    if (stepWaiting.current) return Promise.resolve();
    stepWaiting.current = true;
    const root = refs.dataRef.current?.root, key = draftKey(root, current);
    return flushDraft().then((saved) => (saved && draftKey(refs.dataRef.current?.root, runRef.current) === key ? step() : undefined))
      .finally(() => { stepWaiting.current = false; });
  }, [act, enterRun, flushDraft, refs, syncDraft]);
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
      if (isCurrentEntry(runRef.current, key)) setError(errorMessage(failure));
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
          if (action === 'teach.answer' && next.index > args.stepIndex && teachAnswer === args.answer) teachAnswer = '';
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
  const assistCard = useCallback(async (mode, text, helpChoices = [], derive = undefined) => {
    const current = runRef.current;
    if (!current?.card || (!text.trim() && !(mode === 'ask' && helpChoices.length) && !(mode === 'derive' && derive?.followupId))) return false;
    // Only asking helps with the answer: 修题 and 出题 change the bank, and 批改 is the answer itself, which reads what was recorded.
    if (mode === 'ask') noteAssistance('askedTutorBeforeAnswer');
    if (mode === 'grade' && !(await flushDraft())) return false;
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
      setError(failure.message || ui('这次没有提交成功，也没有拿到具体原因。可以再提交一次。'));
      return false;
    }
  }, [call, notify, setError, core, noteAssistance, flushDraft]);
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
  // The way back remembers what was typed or picked on the original question, so it is found as it was left.
  const returnInput = useRef(null);
  const studyPrerequisites = useCallback(async (list) => {
    if (!(await flushDraft())) return undefined;
    returnInput.current = { runId: runRef.current.id, input: { key: reviewEntryKey(runRef.current), ...entryRef.current } };
    return act('review.start', practiceArgs(list.map(({ deckId, cardId }) => ({ deckId, cardId })), { returnTo: runRef.current.id }), enterRun);
  }, [act, enterRun, flushDraft]);

  /* ── hint and explanation: the hint is help the answer got, once it is opened and has something to show (#542) ── */
  const toggleHint = useCallback(() => {
    if (!entryRef.current.hint && runRef.current?.card?.hint?.trim()) noteAssistance('hintUsed');
    patch((value) => ({ hint: !value.hint }));
  }, [noteAssistance, patch]);

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
    else if (action.type === 'autopilot') toggleAutopilot();
    else if (action.type === 'resume') late.current.resume?.();
    else if (action.type === 'answer') reviewAct('review.answer', action.args);
    else if (action.type === 'move') reviewAct('review.move', { direction: action.direction });
    else if (action.type === 'flip') flipCard();
    else if (action.type === 'hint') toggleHint();
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
  const coach = {
    call, autopilot, onStatus: () => core.refresh().catch(() => {}), onPractice: onCoachPractice,
    onContinue: () => continueTo(null).go(),
    onReviewWeak: () => act('review.weak.start', { runId: run.id }, enterRun),
    canShortcut, autoAdvance: autoAdvance && autoAdvance === advanceKey ? AUTO_ADVANCE_MS : 0, debrief: null,
  };
  const actions = useMemo(() => ({
    reviewAct, choose, flipCard, assistCard, slayCard, studyPrerequisites, teachingAct, cancelTeaching, retryTeaching, toggleEn,
    toggleHelp: () => { if (runRef.current?.revealed) patch((value) => ({ explain: !value.explain })); else toggleHint(); },
    noteAssistance,
    showExplanation: () => patch({ explain: true }),
    setResponse: (response) => patch({ response }),
    setClozeValue: (id, value) => patch((current) => ({ clozeValues: { ...current.clozeValues, [id]: value } })),
    setTeachAnswer: (teachAnswer) => patch({ teachAnswer }),
    closeShortcutHelp: () => setShortcutHelp(false),
    // The sidebar's 快捷键 entry opens the same sheet as the ? key (ui/ShortcutHelp.jsx): one sheet, two ways in.
    openShortcutHelp: () => setShortcutHelp(true),
    toggleAutopilot,
  }), [reviewAct, choose, flipCard, assistCard, slayCard, studyPrerequisites, teachingAct, cancelTeaching, retryTeaching, toggleEn, patch, toggleAutopilot, toggleHint, noteAssistance]);
  return { run, entry, showBack, showEn, enBusyKey, teachingBusy: !!teachingPending[reviewEntryKey(run)], teachingError: teachingFailure[reviewEntryKey(run)]?.message || '', autopilot, autoAdvance, advanceKey,
    shortcutHelp, ...kind, coach, continueTo, onCoachPractice, enterRun, reset, clearRun, patchRun, actions, flushDraft };
}
