// @ts-check
import { mergeReviewPoll, reviewEntryKey } from '../async.js';
import { mergeAssistance, restoredDraft } from './draft-persistence.js';
import { hasOptions } from '../../lib/card-kinds.js';

/** @typedef {import('../../lib/types.js').DeckProgress} DeckProgress */

/* The practice session's rules without React or the DOM (ui-consistency #112): what a fresh answer entry is, when
   the autopilot moves on, what a key press means, and which late answers are still wanted. useReviewSession wires these
   to state and the host; the unit tests drive them directly. */

/** Autopilot waits this long after a pass before opening the next question (a CSS bar of the same length runs meanwhile). */
export const AUTO_ADVANCE_MS = 1500;
/** On the result page the autopilot waits this many seconds before it takes the suggested next step (the 点评 card counts them down). */
export const RESULT_COUNTDOWN_SECONDS = 5;

/** What the learner has typed or picked on the open question. One object, so every reset is one assignment. */
export const emptyEntry = () => ({ selected: [], hint: false, explain: false, response: '', clozeValues: {}, teaching: null, teachAnswer: '', assistance: null });

/**
 * The entry for a run that was just opened. `restored` is the input captured when the learner left this very question
 * (`input.key` names it); it is never put back into another question or into one that has been answered.
 * Without it, the draft the library saved for this entry comes back (`run.draft`, #537): the answer, the options, the blanks and the help recorded,
 * not whether the hint or the explanation was open, which nothing saves. An answered question has neither.
 * `reader.draft(teaching)` returns a saved teaching draft for the step, or ''.
 */
export function entryForRun(run, restored, reader) {
  const back = restored?.key === reviewEntryKey(run) && !run.feedback ? restored : null;
  const saved = back || run.feedback ? null : restoredDraft(run);
  return {
    selected: back?.selected || run.feedback?.selected || saved?.selected || [],
    hint: back?.hint || false,
    explain: back?.explain || false,
    response: back?.response || saved?.text || '',
    clozeValues: back?.clozeValues || saved?.stepInputs || {},
    teaching: run.teaching || null,
    teachAnswer: reader.draft(run.teaching) || back?.teachAnswer || '',
    assistance: run.feedback ? null : mergeAssistance(run.assistance, back?.assistance),
  };
}

/** The queue of the same run was rebuilt (a question was replaced or skipped): what was typed belongs to the old queue. */
export function shouldResetEntry(previous, run) {
  return !!previous && previous.id === run?.id && previous.version !== (run?.queueVersion || 0)
    && (previous.index !== run?.index || previous.cardId !== run?.card?.id);
}

/** A question counts as passed with a self-grade of 3 or more, or a correct choice. */
export const isPassed = (run) => !!run?.feedback && (run.feedback.grade !== undefined ? run.feedback.grade >= 3 : !!run.feedback.correct);
/** The grade a shortcut answer names (a 0-5 press), or null when the key answered something else (a choice, a cloze). 0 is a grade, so a falsy
    check here would lose 完全忘记: the practice page flashes the button this names (#745). */
export const pressedGradeOf = (action) => (action?.type === 'answer' && Number.isInteger(action.args?.grade) ? action.args.grade : null);

/** Names the question the autopilot countdown belongs to. */
export const advanceKeyOf = (run) => (run ? `${run.id}:${run.index}:${run.queueVersion || 0}` : '');

/** Should the autopilot count down to the next question now? `skippedKey` is the question the learner stopped it on; `holdKey` the question they were taken to read (see keepAutopilotHold). */
export function autopilotPlan({ autopilot, page, passed, complete, teaching, skippedKey, advanceKey, holdKey = '' }) {
  const idle = { schedule: false, key: '', ms: 0 };
  if (!autopilot || page !== 'review' || !passed || complete || teaching || skippedKey === advanceKey || (holdKey && holdKey === advanceKey)) return idle;
  return { schedule: true, key: advanceKey, ms: AUTO_ADVANCE_MS };
}

/* A learner taken to one question to read its Q&A or explanation (a letter of the 信箱, any jump that opens a question with its explanation) must not be moved on by
   the autopilot before reading it. The hold is that question's key (advanceKeyOf of the run when the jump opened it); the switch stays on and nothing about the setting
   changes. The hold ends when any other question is on screen: 回到第 N 题 and every other move go through there, so the autopilot is as before. */
export const keepAutopilotHold = (holdKey, advanceKey) => (holdKey && holdKey === advanceKey ? holdKey : '');

/* ── the poll of the open question ── */

export function mergeReviewPollWithFollowups(current, next) {
  const merged = mergeReviewPoll(current, next);
  if (!current || !next || current.id !== next.id || (current.queueVersion || 0) !== (next.queueVersion || 0)
    || current.index !== next.index || current.revealed !== next.revealed || !!current.feedback !== !!next.feedback) return merged;
  if (JSON.stringify(merged.followups) === JSON.stringify(next.followups)) return merged;
  return { ...merged, followups: next.followups };
}

/** What one poll of the open question tells the poll loop (#1011): `unchanged` when the answer changes nothing on screen (the loop slows down), `running` while a
    helper task works on this question (the loop keeps 4 s). */
export const reviewPollResult = (current, next, running = false) =>
  (mergeReviewPollWithFollowups(current, next) === current ? { unchanged: true, running } : { running });

/** A helper task (帮我弄懂, 修题, 出前置题, 批改) is running on this question: the library's list of background tasks says so. Its result reaches the page
    through this poll (a 批改 too), so the poll keeps the quick rhythm while it runs. */
export const assistRunningOn = (tasks, cardId) => !!cardId && (tasks || []).some((task) => task.cardId === cardId && task.status === 'running');

/** The task on this question the page watches (`watch`: the running one, any mode) and whether the one it watched has just ended with a result
    (`done`): then the page asks for the question at once instead of waiting out a slowed-down poll. */
export function finishedTask(watched, tasks, cardId) {
  const own = (tasks || []).filter((task) => task.cardId === cardId);
  const running = own.find((task) => task.status === 'running');
  if (running) return { watch: running.id, done: false };
  const ended = watched ? own.find((task) => task.id === watched) : null;
  return { watch: '', done: ended?.status === 'done' };
}

/* ── 先跳过 and the questions still waiting (#1008) ── */

/** How many questions of the round have no answer yet (the one on screen included): the 「N 题待答」 of a narrow window and the 到此为止 question. A re-ask
    (再练) queued by a wrong answer is not a question of the round, so this is what the result page's 未答 will say. 0 in an exam. */
export const pendingCount = (run) => (run?.mode === 'exam' ? 0 : (run?.navigation || []).filter((item) => !item.answered && !item.retry).length);
/** The re-asks (再练) still waiting, counted on their own. */
export const retriesWaiting = (run) => (run?.mode === 'exam' ? 0 : (run?.navigation || []).filter((item) => !item.answered && item.retry).length);

/**
 * Where 先跳过 goes: the index of the next unanswered question after the one on screen, wrapping round to the start; null when it cannot set this one aside
 * (an exam, an answered question that goes on with 下一题, a question that cannot be graded and has its own 跳过, or no other question waiting). It is a plain
 * review.move {index}: nothing is recorded for the question left, and its clock starts again when it comes back.
 * @param {Record<string, any> | null | undefined} run
 * @returns {number | null}
 */
export function skipTarget(run) {
  if (!run?.card || run.mode === 'exam' || run.feedback || run.card.publicationUngrable) return null;
  const list = run.navigation || [];
  const waiting = (item) => !item.answered && item.index !== run.index;
  const next = list.find((item) => item.index > run.index && waiting(item)) || list.find(waiting);
  return next ? next.index : null;
}

/** Which kind of answer the open question takes. A flashcard-mode round shows every card as a flashcard. */
export function reviewChoiceKind(run) {
  const flash = run?.mode === 'flashcard';
  return {
    choice: !flash && hasOptions(run?.card?.kind),
    isCloze: !flash && run?.card?.kind === 'cloze',
    // An open question with rubric criteria is answered in writing and graded, never flipped.
    rubricCard: run?.card?.kind === 'open' && !!run.card.rubricCriteria?.length,
  };
}

/** Is a key press on `target` someone else's: in a dialog over the page, or in a region that owns its keys ([data-own-keys]: the 对照栏's reader beside the
    question, #1012), unless the question itself (`root`) is inside it (the reader's 本节题目, #1013)? */
export function keysElsewhere(target, root) {
  const owner = target?.closest?.('dialog, [data-own-keys]');
  return !!owner && !owner.contains(root);
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
 * move{direction}, flip, hint, explain, assist-plain, choose{id}, skip, note, focus, source.
 * event: { key, code, shiftKey, repeat, defaultPrevented, ctrlKey, metaKey, altKey, inEditable, onButton }.
 * ctx: { inside, modalOpen, page, run, busy, shortcutHelp, choice, isCloze, rubricCard, selected, clozeValues }.
 */
export function shortcutAction(event, ctx) {
  if (!shortcutGate(event, ctx) || event.defaultPrevented || event.repeat) return null;
  const result = (action, preventDefault = false) => ({ cancelAuto: true, preventDefault, action });
  const { run, busy, choice, isCloze, rubricCard } = ctx;
  if (event.key === '?' || (event.shiftKey && event.code === 'Slash')) return result({ type: 'help' }, true);
  if (event.key === 'Escape' && ctx.shortcutHelp) return result({ type: 'help-close' });
  if (event.shiftKey && event.key?.toLowerCase() === 'v' && ctx.page === 'review' && run?.card && !busy && run.mode !== 'exam')
    return result({ type: 'voice-ask' }, true);
  if (event.shiftKey || (event.onButton && (event.key === 'Enter' || event.code === 'Space'))) return result(null);
  const letter = event.key.length === 1 ? event.key.toLowerCase() : '';
  if (letter === 'a') return result({ type: 'autopilot' }, true);
  // S from anywhere: resume the last round or start today's path.
  if (letter === 's' && !busy && (ctx.page !== 'review' || !run || run.complete)) return result({ type: 'resume' }, true);
  if (ctx.page !== 'review' || !run?.card || busy) return result(null);
  const taskCard = run.mode !== 'flashcard' && run.card.kind === 'task';
  const flipsOnly = !choice && !isCloze && !rubricCard && !taskCard;
  if (!choice && !isCloze && !taskCard && run.revealed && !run.feedback && /^[0-5]$/.test(event.key)) return result({ type: 'answer', args: { grade: Number(event.key) } }, true);
  if (event.key === 'Enter') {
    if (run.feedback) return result({ type: 'move', direction: 1 }, true);
    if (choice && run.card.multiple && ctx.selected.length) return result({ type: 'answer', args: { selected: ctx.selected } }, true);
    if (isCloze && Object.values(ctx.clozeValues).some(BLANK)) return result({ type: 'answer', args: { answers: ctx.clozeValues } }, true);
    return result(flipsOnly ? { type: 'flip' } : null, true);
  }
  if (letter === 'h') return result({ type: run.revealed ? 'explain' : 'hint' }, true);
  // 通俗详解 in one key: the background assistant explains with an analogy.
  if (letter === 't' && run.mode !== 'exam') return result({ type: 'assist-plain' }, true);
  // 语音作答 (#1031): flashcard, open and cloze only; choice cards stay click/number-key only.
  if (letter === 'v' && !choice && !taskCard && !run.feedback && run.mode !== 'exam') return result({ type: 'voice-answer' }, true);
  // The actions of 更多 that have a key of their own (#1008): 先跳过, 写笔记, 标为重点, and the question's own page. An exam has none of them.
  const moreKey = { k: 'skip', n: 'note', f: 'focus', o: 'source' }[letter];
  if (moreKey) return run.mode === 'exam' ? result(null) : result({ type: moreKey }, true);
  if (event.key === 'ArrowRight' && run.feedback) return result({ type: 'move', direction: 1 }, true);
  if (event.key === 'ArrowLeft' && run.index) return result({ type: 'move', direction: -1 }, true);
  if (event.code === 'Space' && flipsOnly) return result({ type: 'flip' }, true);
  if (choice && !run.feedback && /^[1-6]$/.test(event.key)) {
    const option = run.card.options[Number(event.key) - 1];
    return result(option ? { type: 'choose', id: option.id } : null);
  }
  return result(null);
}

/**
 * Is `key` (from reviewEntryKey) still the open question? needPage: also require this page (teaching answers do).
 * @param {Record<string, any> | null | undefined} run
 * @param {string} key
 * @param {{ page?: string, needPage?: string }} [options]
 * @returns {boolean}
 */
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
 * @param {Record<string, any>} run
 * @param {Record<string, DeckProgress>} [progress] the snapshot's per-deck progress
 * @returns {number}
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
 * { kind: 'plan', taskId, title } | { kind: 'path', reason: 'continuing' | 'scope-done' | 'original-gone', course? (the course whose next daily round it is) }.
 * @param {{ run?: Record<string, any>, runs?: any[], progress?: Record<string, DeckProgress>,
 *   tasks?: { id: string, title: string, status: string, available?: boolean, runId?: string }[] }} [options]
 * @returns {{ kind: 'original', runId: string } | { kind: 'scope', scope: Record<string, any>[] }
 *   | { kind: 'plan', taskId: string, title: string } | { kind: 'path', reason: 'continuing' | 'scope-done' | 'original-gone', course?: string }}
 */
export function continueDestination({ run, runs, progress = {}, tasks = [] } = {}) {
  if (!run) return { kind: 'path', reason: 'continuing' };
  if (run.returnTo) {
    const original = Array.isArray(runs) ? runs.find((item) => item.id === run.returnTo) : { id: run.returnTo };
    return original && !original.complete ? { kind: 'original', runId: original.id } : { kind: 'path', reason: 'original-gone' };
  }
  // A course's daily round (lib/daily-path.js) is a round of that course, not a scope the learner chose: the next one is the same course's next round.
  if (run.dailyCourse !== undefined) return { kind: 'path', reason: 'continuing', course: run.dailyCourse };
  if (!run.scope?.length) return { kind: 'path', reason: 'continuing' };
  if (scopeRemaining(run, progress) > 0) return { kind: 'scope', scope: run.scope };
  const linked = tasks.find((task) => task.runId === run.id);
  const candidates = tasks.filter((task) => task !== linked && planActionable(task));
  const next = candidates.find((task) => task.status === 'doing') || candidates[0];
  return next ? { kind: 'plan', taskId: next.id, title: next.title } : { kind: 'path', reason: 'scope-done' };
}
