/* Proactive offers on the question page (#1191, #1193). Pure selector first; browser/storage wrappers sit at the bottom.

   Eight-point checklist required by ui/DESIGN.md ("Proactive elements on the question page") before adding any offer here:
   1. Appears only immediately after a completed learner action, never mid-thought.
   2. Never appears in mock exams (`exam`) or while the feature tour (`tourRunning`) is running.
   3. At most one item shows at a time; the three first-use tips (`practice-tips.js`) always take priority.
   4. Appears below the question as a quiet in-flow block, never a modal or popover covering the question or answer buttons.
   5. Dismissible, with an explicit "stop showing this kind of tip" (`这类不再提示`) control.
   6. Advisory only — never stops the round, moves cards, changes scheduling or intervals, or disables buttons.
   7. Has an opt-out switch in `Settings › 引导` and an entry in `找功能`.
   8. Never uses a filled primary button (`variant="primary"`). */

import { browserSession } from '../storage.js';
import { guidanceAllows } from './budget.js';
import { clearCount } from './cleared.js';

export const PRACTICE_OFFER = Object.freeze({
  chapterBasics: 'practice.chapter-basics',
});

export const PRACTICE_OFFER_ORDER = Object.freeze([
  PRACTICE_OFFER.chapterBasics,
]);

export const CHAPTER_HINT_KEY = 'study-chapter-basics-seen';

const has = (items, value) => (items instanceof Set ? items.has(value) : Array.isArray(items) && items.includes(value));

/** Pick at most one proactive offer on the question page. Pure.
    First-use tips (`practice-tips.js`), mock exams (`exam`), and the tour (`tourRunning`) all suppress offers. */
export function practiceOfferFor({ tip = null, exam = false, tourRunning = false, allowed = [], moments = {}, order = PRACTICE_OFFER_ORDER } = {}) {
  if (tip || exam || tourRunning) return null;
  for (const id of order) {
    if (has(allowed, id) && moments[id] === true) return id;
  }
  return null;
}

/** Decide whether the chapter-basics hint (#1193) should appear for the current question. Pure.
    Triggers on (a) latest terms-ladder reply still needing `deeper` prerequisites, or (b) a second "补齐" fill on the same card. */
export function chapterHintFor({ deeper, refill = false, exam = false, tourRunning = false, allowed = false, seenChapters, chapterKey } = {}) {
  if (exam || tourRunning || !allowed) return false;
  if (chapterKey && has(seenChapters, chapterKey)) return false;
  return Boolean((Array.isArray(deeper) && deeper.length > 0) || refill === true);
}

/** Return `latestTerms.deeper` only when that `kind: 'terms'` followup completed at or after `enteredAt` (#1216). Pure. */
export function freshTermsDeeper(latestTerms, enteredAt) {
  if (!latestTerms || !Array.isArray(latestTerms.deeper) || !latestTerms.deeper.length) return [];
  if (!Number.isFinite(enteredAt) || enteredAt <= 0) return [];
  const rawAt = latestTerms.at;
  const atMs = typeof rawAt === 'number'
    ? (Number.isFinite(rawAt) ? rawAt : NaN)
    : (typeof rawAt === 'string' && rawAt.trim() ? Date.parse(rawAt) : NaN);
  return Number.isFinite(atMs) && atMs >= enteredAt ? latestTerms.deeper : [];
}

/* ---- Browser session memory + Settings › 引导 wiring ---- */

const sessionSeen = new Map();

export function chapterHintSeen(storage = browserSession()) {
  const localClear = clearCount(PRACTICE_OFFER.chapterBasics);
  if (sessionSeen.get(CHAPTER_HINT_KEY) === localClear) return true;
  try { return storage?.getItem(CHAPTER_HINT_KEY) === '1'; } catch { return false; }
}

export function markChapterHintSeen(storage = browserSession()) {
  sessionSeen.set(CHAPTER_HINT_KEY, clearCount(PRACTICE_OFFER.chapterBasics));
  try { storage?.setItem(CHAPTER_HINT_KEY, '1'); return true; } catch { return false; }
}

export function forgetChapterHintVisit() {
  sessionSeen.clear();
}

/** Allowed right now according to Settings › 引导 (master switch and item mute). */
export function practiceOfferAllowed(id) {
  return guidanceAllows(id);
}
