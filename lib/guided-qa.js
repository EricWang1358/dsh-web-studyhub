import { id as defaultId } from './util.js';
import { assertScopeAllowed } from './study-session.js';

/**
 * Organizes and saves QA into target card and optionally links reference to a topic.
 * Enforces HB-3 (scope), HB-5 (idempotency via operationId), HB-6 (user note protection).
 */
export function saveGuidedQA(state, options = {}, now = Date.now()) {
  const {
    sessionId,
    operationId,
    target = {},
    question,
    answerMarkdown,
    citations = [],
    linkToTopic,
    allowOverwriteUser = false,
    expectedVersion,
    explicitUserCommand = false,
  } = options;

  if (!sessionId) throw new Error('sessionId is required');
  const session = state.studySessions?.find((s) => s.id === sessionId);
  if (!session) throw new Error(`StudySession not found: ${sessionId}`);

  // 1. Authorization & Settings guard (HB-3 & HB-6)
  if (!session.settings?.autoOrganizeQA && !explicitUserCommand) {
    const err = new Error('autoOrganizeQA setting is disabled and no explicit user command was provided');
    err.code = 'study-setting-disabled';
    throw err;
  }

  // 2. Locate target card
  const deckId = target.deckId;
  const cardId = target.cardId;
  assertScopeAllowed(session, { kind: 'card', deckId, cardId }, state);

  const deck = state.decks?.find((d) => d.id === deckId);
  const card = deck?.cards?.find((c) => c.id === cardId);
  if (!deck || !card) throw new Error(`Target card ${cardId} in deck ${deckId} not found`);

  card.followups ||= [];

  // 3. Idempotency check via operationId (HB-5)
  if (operationId) {
    const existing = card.followups.find((f) => f.operationId === operationId);
    if (existing) {
      if (existing.question === question && existing.answer === answerMarkdown) {
        return { ok: true, qaId: existing.id, operationId, deduplicated: true, warnings: [] };
      }
      const err = new Error(`Idempotency conflict: operationId '${operationId}' already exists with different content`);
      err.code = 'qa-idempotency-conflict';
      throw err;
    }
  }

  // 4. Citation check
  const warnings = [];
  const validCitations = [];
  for (const cite of citations || []) {
    const src = state.sources?.find((s) => s.id === cite.sourceId);
    if (!src) {
      warnings.push(`Source '${cite.sourceId}' not found; citation unverified`);
    } else if (cite.quote && !src.text.includes(cite.quote)) {
      warnings.push(`Quotation in citation from '${cite.sourceId}' did not match source text verbatim`);
    } else {
      validCitations.push(cite);
    }
  }

  // 5. User overwrite protection (HB-6)
  if (options.targetQaId) {
    const existingQa = card.followups.find((f) => f.id === options.targetQaId);
    if (existingQa) {
      if (existingQa.author === 'user' && !allowOverwriteUser) {
        const err = new Error('Cannot overwrite user-authored QA without explicit user authorization');
        err.code = 'study-user-content-protected';
        throw err;
      }
      if (allowOverwriteUser && !session.settings?.allowNoteEdits) {
        const err = new Error('Editing notes requires allowNoteEdits setting to be enabled');
        err.code = 'study-setting-disabled';
        throw err;
      }
      if (expectedVersion !== undefined && existingQa.revision !== expectedVersion) {
        const err = new Error(`Version conflict: expected ${expectedVersion}, got ${existingQa.revision}`);
        err.code = 'qa-version-conflict';
        throw err;
      }

      existingQa.history ||= [];
      existingQa.history.push({
        question: existingQa.question,
        answer: existingQa.answer,
        revision: existingQa.revision || 1,
        updatedAt: existingQa.updatedAt || existingQa.createdAt || now,
      });

      existingQa.question = String(question || '').trim();
      existingQa.answer = String(answerMarkdown || '').trim();
      existingQa.citations = validCitations;
      existingQa.revision = (existingQa.revision || 1) + 1;
      existingQa.updatedAt = now;

      return { ok: true, qaId: existingQa.id, operationId, deduplicated: false, warnings };
    }
  }

  // 6. Create new QA record
  const qaId = defaultId();
  const newQA = {
    id: qaId,
    operationId: operationId || null,
    author: 'ai-organized',
    sessionId,
    question: String(question || '').trim(),
    answer: String(answerMarkdown || '').trim(),
    citations: validCitations,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    history: [],
  };

  card.followups.push(newQA);

  // 7. Lightweight topic pointer link (no duplicate content copy)
  if (linkToTopic?.course && linkToTopic?.hid) {
    const refRecord = {
      kind: 'card-qa-ref',
      course: linkToTopic.course,
      hid: linkToTopic.hid,
      deckId,
      cardId,
      qaId,
      summary: (newQA.question || '').slice(0, 100),
      createdAt: now,
    };
    newQA.topicRef = { course: linkToTopic.course, hid: linkToTopic.hid };
    session.topicQARefs ||= [];
    session.topicQARefs.push(refRecord);
    state.topicQARefs ||= [];
    state.topicQARefs.push(refRecord);
  }

  return { ok: true, qaId, operationId, deduplicated: false, warnings };
}
