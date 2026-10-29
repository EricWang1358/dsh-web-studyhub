import { id as defaultId } from './util.js';
import { MAX_RETURN_DEPTH } from './study-session.js';

/**
 * Opens a branch question (prerequisite, contrast, or variation) with isolated run and return path.
 */
export function openBranchCard(state, { sessionId, targetDeckId, targetCardId, reason = '', branchKind = 'prerequisite' }, now = Date.now()) {
  const session = state.studySessions?.find((s) => s.id === sessionId);
  if (!session) throw new Error(`StudySession not found: ${sessionId}`);

  session.returnPath ||= [];
  if (session.returnPath.length >= MAX_RETURN_DEPTH) {
    const err = new Error(`Branch return path exceeded maximum depth of ${MAX_RETURN_DEPTH}`);
    err.code = 'study-return-path-overflow';
    throw err;
  }

  // Find target deck and card
  const deck = state.decks?.find((d) => d.id === targetDeckId);
  const card = deck?.cards?.find((c) => c.id === targetCardId);
  if (!deck || !card) throw new Error(`Target card ${targetCardId} in deck ${targetDeckId} not found`);

  // Record current focus onto returnPath
  if (session.focus) {
    const parentRun = state.runs?.find((r) => r.id === session.focus.runId);
    const parentDeck = state.decks?.find((d) => d.id === session.focus.deckId);
    const parentCard = parentDeck?.cards?.find((c) => c.id === session.focus.id) ||
      state.decks?.flatMap((d) => d.cards || []).find((c) => c.id === session.focus.id);
    session.returnPath.push({
      kind: 'card',
      runId: session.focus.runId || null,
      deckId: session.focus.deckId || null,
      cardId: session.focus.id,
      digest: session.focus.digest || parentCard?.digest || null,
      revision: session.focus.revision || parentCard?.revision || (parentCard?.revisions?.length ?? null),
      index: parentRun?.index ?? 0,
      reason: String(reason || '').slice(0, 200),
      branchKind,
    });
  }

  // Create isolated branch run
  const branchRun = {
    id: defaultId(),
    mode: 'path',
    deckId: targetDeckId,
    branchOf: {
      sessionId: session.id,
      parentRunId: session.focus?.runId || null,
      parentCardId: session.focus?.id || null,
      branchKind,
    },
    startedAt: now,
    index: 0,
    entries: [
      {
        deckId: targetDeckId,
        card: structuredClone(card),
        startedAt: now,
        feedback: null,
        revealed: false,
        selected: null,
      },
    ],
  };

  state.runs ||= [];
  state.runs.push(branchRun);

  // Update session focus
  session.focus = {
    kind: 'card',
    id: targetCardId,
    deckId: targetDeckId,
    runId: branchRun.id,
    digest: card.digest || null,
    revision: card.revision || (card.revisions?.length ?? null),
  };
  session.version = (session.version || 1) + 1;
  session.updatedAt = now;

  return { session, branchRun };
}

/**
 * Pops from returnPath and restores focus to parent question.
 */
export function returnFromBranch(state, { sessionId, targetStepIndex = null } = {}, now = Date.now()) {
  const session = state.studySessions?.find((s) => s.id === sessionId);
  if (!session) throw new Error(`StudySession not found: ${sessionId}`);

  session.returnPath ||= [];
  if (session.returnPath.length === 0) {
    const err = new Error('No return path available');
    err.code = 'study-return-path-empty';
    throw err;
  }

  let popped;
  if (typeof targetStepIndex === 'number' && targetStepIndex >= 0 && targetStepIndex < session.returnPath.length) {
    popped = session.returnPath[targetStepIndex];
    session.returnPath = session.returnPath.slice(0, targetStepIndex);
  } else {
    popped = session.returnPath.pop();
  }

  session.focus = {
    kind: 'card',
    id: popped.cardId,
    deckId: popped.deckId,
    runId: popped.runId,
    ...(popped.digest !== undefined ? { digest: popped.digest } : {}),
    ...(popped.revision !== undefined ? { revision: popped.revision } : {}),
  };
  session.version = (session.version || 1) + 1;
  session.updatedAt = now;

  return { session, returnedTo: popped };
}
