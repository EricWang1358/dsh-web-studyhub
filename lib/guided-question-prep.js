import { assertScopeAllowed, recordActivity } from './study-session.js';

/* 带学的「现场出一道新题」(UC-07, #547). A new question is never written here: it is asked of the ordinary supplement job (plan → answer blueprint → author →
   citation check → independent review → publication into one existing deck), the one path every practice question takes (HB-7). This file only decides
   whether the request may start, remembers which job the session is waiting for, and, once the job has ended, which question it published. Pure: the
   handlers in lib/contexts/study/operations.js do the calls. */

const KINDS = new Set(['quiz', 'multi', 'flashcard', 'cloze', 'open']);
const FOCUS_CHARS = 300;

const fail = (message, code) => Object.assign(new Error(message), { code });

/** Whether `args` may start a question for its session: { session, deck, sourceIds, kind, focus, knownCardIds }. Throws a coded error otherwise. */
export function checkQuestionRequest(state, args = {}) {
  const sessionId = args.sessionId || args.id;
  if (!sessionId) throw fail('sessionId is required', 'study-session-required');
  const session = state.studySessions?.find((item) => item.id === sessionId);
  if (!session) throw fail(`StudySession not found: ${sessionId}`, 'study-session-not-found');
  if (session.status !== 'active') throw fail('This guided session is not active; resume it before preparing a question', 'study-session-inactive');
  if (!session.settings?.allowNewQuestions)
    throw fail('Session setting allowNewQuestions is disabled: ask the learner before turning it on with study.session.update', 'study-setting-disabled');
  if (session.focus?.kind === 'preparing-card') throw fail('A question is already being prepared for this session; wait for study.question.result', 'study-question-busy');
  // The question goes into a deck the learner already has, in this session's course: a wrong id is refused, never replaced by another deck.
  const deckId = args.deckId ?? args.targetDeckId;
  if (typeof deckId !== 'string' || !deckId) throw fail('deckId is required: the existing deck of this course the new question is published into', 'study-question-deck');
  const deck = state.decks?.find((item) => item.id === deckId);
  if (!deck) throw fail(`Deck not found: ${deckId}`, 'study-question-deck');
  if (deck.archived || deck.systemKind) throw fail('Choose an active ordinary deck for the new question', 'study-question-deck');
  assertScopeAllowed(session, { kind: 'deck', id: deck.id }, state);
  // The evidence: the sources asked for, else the session's own sources. Each must be in the library and in the session's scope.
  const asked = Array.isArray(args.sourceIds) ? args.sourceIds : session.scope?.filter((item) => item.kind === 'source').map((item) => item.id) || [];
  const sourceIds = [...new Set(asked.filter((item) => typeof item === 'string' && item))];
  if (!sourceIds.length) throw fail('sourceIds is required: the material the question is written from', 'study-question-sources');
  for (const sourceId of sourceIds) {
    if (!state.sources?.some((source) => source.id === sourceId)) throw fail(`Source not found: ${sourceId}`, 'study-question-sources');
    assertScopeAllowed(session, { kind: 'source', id: sourceId }, state);
  }
  const kind = args.kind ?? 'quiz';
  if (!KINDS.has(kind)) throw fail(`kind must be one of ${[...KINDS].join(', ')}`, 'study-question-kind');
  const focus = typeof args.focus === 'string' ? args.focus.trim().slice(0, FOCUS_CHARS) : '';
  return { session, deck, sourceIds, kind, focus, knownCardIds: (deck.cards || []).map((card) => card.id) };
}

/** The session waits for `jobId`: what the panel shows as 正在准备 and what study.question.result reads back. */
export function markPreparing(session, { jobId, deckId, knownCardIds, now = Date.now() }) {
  session.focus = { kind: 'preparing-card', jobId, deckId, knownCardIds, startedAt: new Date(now).toISOString() };
  session.version = (session.version || 1) + 1;
  session.updatedAt = now;
  return session.focus;
}

const RUNNING = new Set(['queued', 'running', 'cancelling']);

/**
 * What the job the session waits for came to, against the deck it publishes into: { status: 'running' | 'ready' | 'failed', ... }.
 * `ready` names the ONE question that job published (the deck's cards it did not have before the job). A finished job that published nothing,
 * or more than one, or anything but a complete job, is `failed` with the reason in words: nothing is shown as a new question then.
 */
export function questionOutcome(state, preparing, job) {
  if (!job || RUNNING.has(job.status)) return { status: 'running', jobId: preparing.jobId, stage: job?.stage || '' };
  const deck = state.decks?.find((item) => item.id === preparing.deckId);
  const known = new Set(preparing.knownCardIds || []);
  const added = (deck?.cards || []).filter((card) => !known.has(card.id));
  if (job.status === 'complete' && added.length === 1)
    return { status: 'ready', jobId: preparing.jobId, deckId: deck.id, card: added[0] };
  const reason = job.status === 'cancelled' ? '出题已取消'
    : job.status !== 'complete' ? `出题没有完成：${job.error || job.stage || job.status}`
      : !added.length ? '这道题没有通过独立审核，没有加入题组'
        : '这次出题加入了不止一道题，请在题组里查看';
  return { status: 'failed', jobId: preparing.jobId, reason, fallback: 'reuse_existing' };
}

/** The session stops waiting: its focus becomes the new question (with its run), or nothing. */
export function settlePreparing(session, outcome, { runId = null, now = Date.now() } = {}) {
  session.focus = outcome.status === 'ready' ? { kind: 'card', id: outcome.card.id, deckId: outcome.deckId, ...(runId ? { runId } : {}) } : null;
  session.version = (session.version || 1) + 1;
  session.updatedAt = now;
  return session.focus;
}

/** 取消准备: the session stops waiting. The job itself is cancelled by the caller (job.control). */
export function cancelQuestionPreparation(session) {
  if (!session) return { cancelled: false };
  if (session.focus?.kind === 'preparing-card') {
    const { jobId, startedAt } = session.focus;
    recordActivity(session, 'generation_wait', Date.now() - Date.parse(startedAt));
    session.focus = null;
    session.version = (session.version || 1) + 1;
    session.updatedAt = Date.now();
    return { cancelled: true, jobId };
  }
  return { cancelled: false };
}
