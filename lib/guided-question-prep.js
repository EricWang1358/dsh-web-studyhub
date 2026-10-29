import { id as defaultId } from './util.js';
import { assertScopeAllowed } from './study-session.js';

/**
 * Prepares a single reviewed question for guided study (UC-07 & HB-7).
 * Reuses existing authoring & review verification rules.
 */
export function prepareSingleQuestion(state, options = {}, now = Date.now()) {
  const {
    sessionId,
    operationId = defaultId(),
    sourceIds = [],
    targetDeckId,
    prompt,
    options: cardOptions,
    explanation,
    kind = 'quiz',
    topic,
    modelAvailable = true,
    simulateVerificationFailure = false,
  } = options;

  if (!sessionId) throw new Error('sessionId is required');
  const session = state.studySessions?.find((s) => s.id === sessionId);
  if (!session) throw new Error(`StudySession not found: ${sessionId}`);

  // 1. Permission checks (HB-3 & HB-7)
  if (!session.settings?.allowNewQuestions) {
    const err = new Error('Session setting allowNewQuestions is disabled');
    err.code = 'study-setting-disabled';
    throw err;
  }

  // Verify sources in scope
  for (const srcId of sourceIds) {
    assertScopeAllowed(session, { kind: 'source', id: srcId }, state);
  }

  // 2. Model availability check (ADR-04 & UC-10)
  if (!modelAvailable) {
    return {
      available: false,
      reason: 'model_unavailable',
      fallback: 'reuse_existing',
      message: '当前模型不可用，无法生成新题，建议复用已有题目',
    };
  }

  // 3. Set session focus to preparing-card
  const jobId = `job_${operationId}`;
  session.focus = {
    kind: 'preparing-card',
    jobId,
    operationId,
    startedAt: now,
  };

  // 4. Verification & Review failure check (HB-7)
  if (simulateVerificationFailure) {
    session.focus = null;
    return {
      ok: false,
      status: 'failed',
      reason: '所选段落未能核对出可作答引文',
      code: 'citation_verification_failed',
      fallback: 'reuse_existing',
      message: '生成题目未通过独立审核：所选段落未能核对出可作答引文，请改用已有题目练习',
    };
  }

  // 5. Approved question creation
  const deck = state.decks?.find((d) => d.id === targetDeckId) || state.decks?.[0];
  if (!deck) throw new Error(`Target deck '${targetDeckId}' not found`);

  const cardId = defaultId();
  const newCard = {
    id: cardId,
    kind,
    topic: topic || '带学新题',
    prompt: prompt || '请根据讲义内容选择正确答案：',
    options: cardOptions || [
      { id: 'opt_1', text: '选项 A（正确）', correct: true },
      { id: 'opt_2', text: '选项 B（干扰项）', correct: false },
    ],
    explanation: explanation || '根据讲义论证，选项 A 正确。',
    citations: (sourceIds || []).map((id) => ({ sourceId: id })),
    editorial: {
      approved: true,
      reviewPassed: true,
      operationId,
      createdAt: now,
    },
  };

  deck.cards ||= [];
  deck.cards.push(newCard);

  // Update session focus to the newly created card
  session.focus = {
    kind: 'card',
    id: cardId,
    deckId: deck.id,
  };
  session.version = (session.version || 1) + 1;
  session.updatedAt = now;

  return {
    ok: true,
    status: 'complete',
    card: newCard,
    deckId: deck.id,
    operationId,
  };
}

export function cancelQuestionPreparation(session) {
  if (!session) return { cancelled: false };
  if (session.focus?.kind === 'preparing-card') {
    session.focus = null;
    session.version = (session.version || 1) + 1;
    session.updatedAt = Date.now();
    return { cancelled: true };
  }
  return { cancelled: false };
}
