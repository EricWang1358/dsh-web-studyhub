import { reviewEntryKey } from '../async.js';

/* The practice session's rules without React or the DOM (ui-consistency #112): what a fresh answer entry is, when
   the autopilot moves on, what a key press means, and which late answers are still wanted. useReviewSession wires these
   to state and the host; the unit tests drive them directly. */

/** Autopilot waits this long after a pass before opening the next question (a CSS bar of the same length runs meanwhile). */
export const AUTO_ADVANCE_MS = 1500;

/** What the learner has typed or picked on the open question. One object, so every reset is one assignment. */
export const emptyEntry = () => ({ selected: [], hint: false, explain: false, response: '', clozeValues: {}, teaching: null, teachAnswer: '' });

/**
 * The entry for a run that was just opened. `restored` is the input captured when the learner left this very question
 * (`input.key` names it); it is never put back into another question or into one that has been answered.
 * `reader.draft(teaching)` returns a saved teaching draft for the step, or ''.
 */
export function entryForRun(run, restored, reader) {
  const back = restored?.key === reviewEntryKey(run) && !run.feedback ? restored : null;
  return {
    selected: back?.selected || run.feedback?.selected || [],
    hint: back?.hint || false,
    explain: back?.explain || false,
    response: back?.response || '',
    clozeValues: back?.clozeValues || {},
    teaching: run.teaching || null,
    teachAnswer: reader.draft(run.teaching) || back?.teachAnswer || '',
  };
}

/** The queue of the same run was rebuilt (a question was replaced or skipped): what was typed belongs to the old queue. */
export function shouldResetEntry(previous, run) {
  return !!previous && previous.id === run?.id && previous.version !== (run?.queueVersion || 0);
}

/** A question counts as passed with a self-grade of 3 or more, or a correct choice. */
export const isPassed = (run) => !!run?.feedback && (run.feedback.grade !== undefined ? run.feedback.grade >= 3 : !!run.feedback.correct);

/** Names the question the autopilot countdown belongs to. */
export const advanceKeyOf = (run) => (run ? `${run.id}:${run.index}:${run.queueVersion || 0}` : '');

/** Should the autopilot count down to the next question now? `skippedKey` is the question the learner stopped it on. */
export function autopilotPlan({ autopilot, page, passed, complete, teaching, skippedKey, advanceKey }) {
  const idle = { schedule: false, key: '', ms: 0 };
  if (!autopilot || page !== 'review' || !passed || complete || teaching || skippedKey === advanceKey) return idle;
  return { schedule: true, key: advanceKey, ms: AUTO_ADVANCE_MS };
}

/** Which kind of answer the open question takes. A flashcard-mode round shows every card as a flashcard. */
export function reviewChoiceKind(run) {
  const flash = run?.mode === 'flashcard';
  return {
    choice: !flash && ['quiz', 'multi'].includes(run?.card?.kind),
    isCloze: !flash && run?.card?.kind === 'cloze',
    // An open question with rubric criteria is answered in writing and graded, never flipped.
    rubricCard: run?.card?.kind === 'open' && !!run.card.rubricCriteria?.length,
  };
}

/**
 * May a key press be a shortcut at all? ctx.inside: the focus (or the learner's last interaction) is in the panel;
 * event.inEditable: the target is a field or a dialog; ctx.modalOpen: one of the app's dialogs is open.
 */
export const shortcutGate = (event, ctx) => !!ctx.inside && !event.inEditable && !event.ctrlKey && !event.metaKey && !event.altKey && !ctx.modalOpen;

const BLANK = (value) => String(value).trim();

/**
 * What a key press means. Returns null when the press is not ours, otherwise { cancelAuto, preventDefault, action }
 * (action may be null: the key is consumed, nothing happens). Actions: help, help-close, autopilot, resume, answer{args},
 * move{direction}, flip, hint, explain, assist-plain, choose{id}.
 * event: { key, code, shiftKey, repeat, defaultPrevented, ctrlKey, metaKey, altKey, inEditable, onButton }.
 * ctx: { inside, modalOpen, page, run, busy, shortcutHelp, choice, isCloze, rubricCard, selected, clozeValues }.
 */
export function shortcutAction(event, ctx) {
  if (!shortcutGate(event, ctx) || event.defaultPrevented || event.repeat) return null;
  const result = (action, preventDefault = false) => ({ cancelAuto: true, preventDefault, action });
  const { run, busy, choice, isCloze, rubricCard } = ctx;
  if (event.key === '?' || (event.shiftKey && event.code === 'Slash')) return result({ type: 'help' }, true);
  if (event.key === 'Escape' && ctx.shortcutHelp) return result({ type: 'help-close' });
  if (event.shiftKey || (event.onButton && (event.key === 'Enter' || event.code === 'Space'))) return result(null);
  const letter = event.key.length === 1 ? event.key.toLowerCase() : '';
  if (letter === 'a') return result({ type: 'autopilot' }, true);
  // S from anywhere: resume the last round or start today's path.
  if (letter === 's' && !busy && (ctx.page !== 'review' || !run || run.complete)) return result({ type: 'resume' }, true);
  if (ctx.page !== 'review' || !run?.card || busy) return result(null);
  const flipsOnly = !choice && !isCloze && !rubricCard;
  if (!choice && !isCloze && run.revealed && !run.feedback && /^[0-5]$/.test(event.key)) return result({ type: 'answer', args: { grade: Number(event.key) } }, true);
  if (event.key === 'Enter') {
    if (run.feedback) return result({ type: 'move', direction: 1 }, true);
    if (choice && run.card.multiple && ctx.selected.length) return result({ type: 'answer', args: { selected: ctx.selected } }, true);
    if (isCloze && Object.values(ctx.clozeValues).some(BLANK)) return result({ type: 'answer', args: { answers: ctx.clozeValues } }, true);
    return result(flipsOnly ? { type: 'flip' } : null, true);
  }
  if (letter === 'h') return result({ type: run.revealed ? 'explain' : 'hint' }, true);
  // 通俗详解 in one key: the background assistant explains with an analogy.
  if (letter === 't' && run.mode !== 'exam') return result({ type: 'assist-plain' }, true);
  if (event.key === 'ArrowRight' && run.feedback) return result({ type: 'move', direction: 1 }, true);
  if (event.key === 'ArrowLeft' && run.index) return result({ type: 'move', direction: -1 }, true);
  if (event.code === 'Space' && flipsOnly) return result({ type: 'flip' }, true);
  if (choice && !run.feedback && /^[1-6]$/.test(event.key)) {
    const option = run.card.options[Number(event.key) - 1];
    return result(option ? { type: 'choose', id: option.id } : null);
  }
  return result(null);
}

/** Is `key` (from reviewEntryKey) still the open question? needPage: also require this page (teaching answers do). */
export const isCurrentEntry = (run, key, { page, needPage } = {}) => !!key && (!needPage || page === needPage) && reviewEntryKey(run) === key;

/** At most one request per question: begin() is false while one is in flight (a second click joins it). */
export function createFlightSet() {
  const flights = new Set();
  return {
    begin(key) { if (!key || flights.has(key)) return false; flights.add(key); return true; },
    end(key) { flights.delete(key); },
    has: (key) => flights.has(key),
  };
}

/* ── where 继续学习 goes after a round (#175, #177) ──────────────────────────────────────────────────────────────────────
   One decision, four answers, in this order: a prerequisite round goes back to the question it was started from; a scope
   with questions left carries on; a finished scope moves on to the next unfinished action of today's plan; otherwise the
   normal learning path (an empty scope). It never starts the same finished scope again: 再练此范围 is the one explicit repeat. */

/**
 * How many questions of a finished run's scope are still waiting: the questions of the round nobody answered (an early
 * end), plus, for deck and topic scopes, the new and due questions the snapshot's progress still shows. A scope of chosen
 * questions has none beyond the round. The whole path (no scope) never runs out.
 */
export function scopeRemaining(run, progress = {}) {
  const scope = run?.scope || [];
  if (!scope.length) return Infinity;
  let left = Math.max(0, (run.questions ?? run.total ?? 0) - (run.answered ?? 0));
  for (const item of scope) {
    if (item.cardId || item.cardIds) continue;
    const deck = progress?.[item.deckId];
    if (!deck) continue;
    const unit = item.topic ? (deck.topics || []).find((topic) => topic.name === item.topic) : deck;
    left += (unit?.counts?.new || 0) + (unit?.due || 0);
  }
  return left;
}

const planActionable = (task) => task.status !== 'done' && task.available !== false;

/**
 * The destination of 继续学习. run: the finished run (id, scope, returnTo, questions, answered); runs: the open runs of the
 * snapshot (undefined when unknown); progress: the snapshot's per-deck progress; tasks: today's plan tasks (the one linked to
 * this run, if any, is skipped: it is the work just done). Returns { kind: 'original', runId } | { kind: 'scope', scope } |
 * { kind: 'plan', taskId, title } | { kind: 'path', reason: 'continuing' | 'scope-done' | 'original-gone' }.
 */
export function continueDestination({ run, runs, progress = {}, tasks = [] } = {}) {
  if (!run) return { kind: 'path', reason: 'continuing' };
  if (run.returnTo) {
    const original = Array.isArray(runs) ? runs.find((item) => item.id === run.returnTo) : { id: run.returnTo };
    return original && !original.complete ? { kind: 'original', runId: original.id } : { kind: 'path', reason: 'original-gone' };
  }
  if (!run.scope?.length) return { kind: 'path', reason: 'continuing' };
  if (scopeRemaining(run, progress) > 0) return { kind: 'scope', scope: run.scope };
  const linked = tasks.find((task) => task.runId === run.id);
  const candidates = tasks.filter((task) => task !== linked && planActionable(task));
  const next = candidates.find((task) => task.status === 'doing') || candidates[0];
  return next ? { kind: 'plan', taskId: next.id, title: next.title } : { kind: 'path', reason: 'scope-done' };
}
