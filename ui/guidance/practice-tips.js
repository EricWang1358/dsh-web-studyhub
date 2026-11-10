import { browserStorage, readJSON, writeJSON } from '../storage.js';
import { guidanceAllows } from './budget.js';
import { clearCount } from './cleared.js';

/*
 * The three first-use tips under a practice question (#948): the learner who has just acted is told, once, where the help for that moment is.
 *   practice.help-first   the first time an answer is wrong (a flashcard: rated not mastered) → the 帮我弄懂 button
 *   practice.fix-first    the first time 「这题有问题」 is marked                                  → the 修题 button
 *   practice.prereq-first the first time an answer of 帮我弄懂 or a 追问 is shown under the question → the 「出成前置题」 link under it
 * The rule is ONE pure function (practiceTipFor); the page only reports which moments hold. A tip never shows while the learner is still thinking about
 * an unanswered question (every moment is something the learner did), never in an exam run, never while the tour is running, at most one at a time
 * (the earlier row of the list above wins; the others wait), once each.
 *
 * These are proactive entries of 设置 › 引导 (the master switch and their own switch apply: guidanceAllows), but they are NOT the daily budget's: they do
 * not go through claimProactiveTip (one tip a local day, never in practice) because the practice page after an answer is exactly where they belong, and
 * they spend nothing of the day. Memory: one list in this browser under PRACTICE_TIPS_KEY (ui/storage.js), like the reader's hints
 * (ui/document-preview/reader/hints.js), held for the visit when the storage is blocked or cleared by another tab.
 */
export const PRACTICE_TIPS_KEY = 'study-practice-tips';
export const PRACTICE_TIP = Object.freeze({ help: 'practice.help-first', fix: 'practice.fix-first', prereq: 'practice.prereq-first' });
/** The rows of the table, in the order they win. */
export const PRACTICE_TIP_ORDER = Object.freeze([PRACTICE_TIP.help, PRACTICE_TIP.fix, PRACTICE_TIP.prereq]);

const has = (list, id) => (list instanceof Set ? list.has(id) : Array.isArray(list) && list.includes(id));

/**
 * The tip to show now, or null. `feedbackWrong`: the answer under the question is wrong (feedback is showing; a flashcard rated not mastered);
 * `votedDown`: 「这题有问题」 was marked; `answerShown`: an answer of 帮我弄懂 or 追问 is shown under the question; `exam`: the run is a mock exam;
 * `tourRunning`: the feature tour is on; `seen` / `allowed`: ids (an array or a Set) of the tips already seen and of those the switches allow. Pure.
 */
export function practiceTipFor({ feedbackWrong = false, votedDown = false, answerShown = false, exam = false, tourRunning = false, seen = [], allowed = [] } = {}) {
  if (exam || tourRunning) return null;
  const moments = { [PRACTICE_TIP.help]: feedbackWrong, [PRACTICE_TIP.fix]: votedDown, [PRACTICE_TIP.prereq]: answerShown };
  return PRACTICE_TIP_ORDER.find(id => moments[id] === true && has(allowed, id) && !has(seen, id)) ?? null;
}

/* The id inside the stored list ('practice.help-first' → 'help-first'): the registry entry's memory.item. */
const itemOf = id => id.slice('practice.'.length);

/** Seen during this visit even when the browser has no storage (or another tab cleared it); each keeps the clear count of its entry
    (ui/guidance/cleared.js): 再显示一次 in this tab undoes it, a reset in another tab does not. */
const seenThisVisit = new Map();

const storedIds = storage => { const stored = readJSON(PRACTICE_TIPS_KEY, [], storage); return Array.isArray(stored) ? stored.filter(id => typeof id === 'string') : []; };

/** Has the learner seen tip `id` in this browser, or during this visit? */
export const practiceTipSeen = (id, storage = browserStorage()) =>
  (seenThisVisit.has(id) && seenThisVisit.get(id) === clearCount(id)) || storedIds(storage).includes(itemOf(id));

/** Remember that tip `id` was seen; true when it was stored (this visit remembers it either way). */
export function markPracticeTipSeen(id, storage = browserStorage()) {
  seenThisVisit.set(id, clearCount(id));
  return writeJSON(PRACTICE_TIPS_KEY, [...new Set([...storedIds(storage), itemOf(id)])], storage);
}

/** Start a new visit (tests): what this visit remembers is forgotten, the stored list stays. */
export const forgetPracticeTipsVisit = () => seenThisVisit.clear();

/** What practiceTipFor needs from the browser: { seen, allowed }, the tips seen and the tips the master switch and their own switch allow. */
export function practiceTipState(storage = browserStorage()) {
  return { seen: PRACTICE_TIP_ORDER.filter(id => practiceTipSeen(id, storage)), allowed: PRACTICE_TIP_ORDER.filter(id => guidanceAllows(id, storage)) };
}
