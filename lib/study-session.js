import { id as defaultId } from './util.js';
import { totalTokens } from './token-usage.js';
import { studySessionReadout } from './study-resume.js';
import { shouldRecordPrediction } from './study-time-estimate.js';

export const MAX_RETURN_DEPTH = 5;
export const MAX_ARTIFACT_REFS = 20;
export const MAX_ARTIFACT_CHARS = 12000;
export const MAX_PREDICTIONS = 10;
/** Waiting and pausing the session logs for the record; the estimate leaves them out, so the oldest may go. */
export const MAX_ACTIVITY = 200;
export const MAX_RECEIPTS = 32;

/**
 * Strips script tags, inline on* handlers and javascript: protocols.
 */
export function sanitizeTeachingMarkdown(markdown) {
  if (typeof markdown !== 'string') return '';
  let clean = markdown;
  // Strip <script>...</script>
  clean = clean.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  // Strip inline on* handlers e.g. onerror=, onclick=
  clean = clean.replace(/\son\w+\s*=\s*(['"]).*?\1/gi, '');
  clean = clean.replace(/\son\w+\s*=\s*[^>\s]+/gi, '');
  // Strip javascript: links
  clean = clean.replace(/javascript\s*:/gi, 'about:blank#blocked-');
  return clean;
}

/**
 * Asserts that a target resource is within the session scope.
 */
export function assertScopeAllowed(session, targetRef, state) {
  if (!session || !targetRef) {
    const err = new Error('Invalid session or target reference');
    err.code = 'study-scope-denied';
    throw err;
  }
  const scope = session.scope || [];
  const courseId = session.courseId;

  if (targetRef.kind === 'source') {
    const inScope = scope.some(s => s.kind === 'source' && s.id === targetRef.id);
    if (inScope) return true;
    if (state?.sources) {
      const src = state.sources.find(s => s.id === targetRef.id);
      if (src && (!src.courses || !src.courses.length || (courseId && src.courses.includes(courseId)))) {
        return true;
      }
    }
  } else if (targetRef.kind === 'deck') {
    const inScope = scope.some(s => s.kind === 'deck' && s.id === targetRef.id);
    if (inScope) return true;
    if (state?.decks) {
      const deck = state.decks.find(d => d.id === targetRef.id);
      if (deck && (!deck.course || deck.course === courseId)) return true;
    }
  } else if (targetRef.kind === 'card') {
    const inScope = scope.some(s => s.kind === 'deck' && s.id === targetRef.deckId) ||
                    scope.some(s => s.kind === 'card' && s.id === targetRef.cardId);
    if (inScope) return true;
    if (state?.decks) {
      const deck = state.decks.find(d => d.id === targetRef.deckId);
      if (deck && (!deck.course || deck.course === courseId)) {
        if (!targetRef.cardId || deck.cards?.some(c => c.id === targetRef.cardId)) return true;
      }
    }
  } else if (targetRef.kind === 'topic') {
    if (!targetRef.course || targetRef.course === courseId) return true;
  }

  const err = new Error(`Target ${targetRef.kind}:${targetRef.id || targetRef.cardId || targetRef.hid} is outside the allowed session scope`);
  err.code = 'study-scope-denied';
  throw err;
}

/**
 * Creates a new StudySession domain record.
 */
export function createStudySession(state, input = {}, now = Date.now()) {
  const courseId = typeof input.courseId === 'string' ? input.courseId.trim() : '';
  if (!courseId) {
    const err = new Error('courseId is required to start a StudySession');
    err.code = 'study-scope-denied';
    throw err;
  }
  if (state?.courses && state.courses.length > 0) {
    const exists = state.courses.some(c => c.name === courseId || c.id === courseId);
    if (!exists) {
      const err = new Error(`Course ${courseId} is not in user's authorized courses`);
      err.code = 'study-scope-denied';
      throw err;
    }
  }
  const scope = Array.isArray(input.scope) ? input.scope : [];
  for (const item of scope) {
    assertScopeAllowed({ courseId, scope: [{ ...item }] }, item, state);
  }

  const checkItems = Array.isArray(input.goal?.checkItems)
    ? input.goal.checkItems.map(item => ({
        id: item.id || defaultId(),
        title: String(item.title || '').trim(),
        weight: Number.isFinite(item.weight) && item.weight > 0 ? item.weight : 1,
        targetCardIds: Array.isArray(item.targetCardIds) ? item.targetCardIds : [],
        ...(item.topic ? { topic: String(item.topic) } : {}),
      }))
    : [];

  const goal = input.goal
    ? {
        title: String(input.goal.title || '').trim(),
        checkItems,
        scopeNote: typeof input.goal.scopeNote === 'string' ? input.goal.scopeNote : '',
      }
    : null;

  const settings = {
    allowNewQuestions: !!input.settings?.allowNewQuestions,
    autoOrganizeQA: !!input.settings?.autoOrganizeQA,
    allowNoteEdits: !!input.settings?.allowNoteEdits,
  };

  return {
    id: input.id || defaultId(),
    courseId,
    scope,
    goal,
    settings,
    focus: input.focus || null,
    returnPath: [],
    artifactRefs: [],
    predictions: [],
    activityLog: [],
    usage: [],
    receipts: [],
    status: 'active',
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Pure domain update for StudySession.
 */
export function updateStudySession(session, input = {}, state = null, now = Date.now()) {
  if (!session) throw new Error('Session is required');
  if (input.expectedVersion !== undefined && input.expectedVersion !== session.version) {
    const err = new Error(`Version conflict: expected ${input.expectedVersion}, got ${session.version}`);
    err.code = 'study-session-version-conflict';
    throw err;
  }

  const updated = structuredClone(session);

  if (input.settings) {
    const curSettings = updated.settings || {};
    const newSettings = { ...curSettings };
    for (const [k, v] of Object.entries(input.settings)) {
      if (v === true && !curSettings[k]) {
        if (!input.explicitUserAuthorization) {
          const err = new Error(`Widening setting '${k}' requires explicit user authorization`);
          err.code = 'study-setting-disabled';
          throw err;
        }
      }
      newSettings[k] = !!v;
    }
    updated.settings = newSettings;
  }

  if (input.goal) {
    const prevItemsCount = updated.goal?.checkItems?.length || 0;
    const checkItems = Array.isArray(input.goal.checkItems)
      ? input.goal.checkItems.map(item => ({
          id: item.id || defaultId(),
          title: String(item.title || '').trim(),
          weight: Number.isFinite(item.weight) && item.weight > 0 ? item.weight : 1,
          targetCardIds: Array.isArray(item.targetCardIds) ? item.targetCardIds : [],
          ...(item.topic ? { topic: String(item.topic) } : {}),
        }))
      : (updated.goal?.checkItems || []);

    if (checkItems.length !== prevItemsCount && !input.goal.scopeNote && !updated.goal?.scopeNote) {
      const err = new Error('Changing checkItems denominator requires a scopeNote');
      err.code = 'study-goal-scope-note-required';
      throw err;
    }

    updated.goal = {
      title: input.goal.title ? String(input.goal.title).trim() : (updated.goal?.title || ''),
      checkItems,
      scopeNote: input.goal.scopeNote ?? (updated.goal?.scopeNote || ''),
    };
  }

  if (input.focus !== undefined) {
    updated.focus = input.focus;
  }
  if (input.status && ['active', 'paused', 'ended'].includes(input.status)) {
    updated.status = input.status;
    if (input.status === 'paused') markPaused(updated, now);
    else settlePause(updated, now);
  }

  updated.version = (session.version || 1) + 1;
  updated.updatedAt = now;
  return updated;
}

/**
 * Upserts a teaching artifact into session with idempotency via operationId.
 */
export function upsertTeachingArtifact(session, artifactInput = {}, now = Date.now()) {
  if (!session) throw new Error('Session is required');
  const operationId = artifactInput.operationId || null;

  if (!session.receipts) session.receipts = [];
  if (operationId) {
    const existing = session.receipts.find(r => r.operationId === operationId);
    if (existing) {
      const found = session.artifactRefs?.find(a => a.id === existing.artifactId);
      return { artifact: found, artifactId: existing.artifactId, operationId, deduplicated: true };
    }
  }

  if (!session.artifactRefs) session.artifactRefs = [];
  if (session.artifactRefs.length >= MAX_ARTIFACT_REFS && !artifactInput.id) {
    const err = new Error(`Teaching artifacts exceeded maximum limit of ${MAX_ARTIFACT_REFS}`);
    err.code = 'study-artifact-limit-exceeded';
    throw err;
  }

  const rawMarkdown = String(artifactInput.markdown || '').slice(0, MAX_ARTIFACT_CHARS);
  const cleanMarkdown = sanitizeTeachingMarkdown(rawMarkdown);

  const artifactId = artifactInput.id || defaultId();
  const artifact = {
    id: artifactId,
    kind: artifactInput.kind || 'explanation',
    title: String(artifactInput.title || '讲解').trim(),
    topic: artifactInput.topic ? String(artifactInput.topic) : undefined,
    sourceAnchors: Array.isArray(artifactInput.sourceAnchors) ? artifactInput.sourceAnchors : [],
    markdown: cleanMarkdown,
    updatedAt: now,
  };

  const existingIdx = session.artifactRefs.findIndex(a => a.id === artifactId);
  if (existingIdx >= 0) {
    session.artifactRefs[existingIdx] = artifact;
  } else {
    session.artifactRefs.push(artifact);
  }

  if (operationId) {
    session.receipts.push({ operationId, artifactId, at: now });
    if (session.receipts.length > MAX_RECEIPTS) {
      session.receipts.splice(0, session.receipts.length - MAX_RECEIPTS);
    }
  }

  session.version = (session.version || 1) + 1;
  session.updatedAt = now;
  return { artifact, artifactId, operationId, deduplicated: false };
}

/**
 * Logs how long the session spent on something the estimate leaves out (a question being written, a pause). Returns the entry, or null for a
 * duration that is not a positive number.
 */
export function recordActivity(session, kind, durationMs, now = Date.now()) {
  const ms = typeof durationMs === 'number' ? Math.round(durationMs) : NaN;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const entry = { kind, at: now, durationMs: ms };
  (session.activityLog ||= []).push(entry);
  if (session.activityLog.length > MAX_ACTIVITY) session.activityLog.splice(0, session.activityLog.length - MAX_ACTIVITY);
  return entry;
}

/** The session is paused from `now` (a second pause does not restart the clock). */
export function markPaused(session, now = Date.now()) {
  if (!session.pausedAt) session.pausedAt = now;
}

/** The pause is over (resumed or ended): its length goes to the log. */
export function settlePause(session, now = Date.now()) {
  if (!session.pausedAt) return;
  recordActivity(session, 'paused', now - session.pausedAt, now);
  delete session.pausedAt;
}

const BUCKETS = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];

/**
 * Keeps what the job that wrote a question for the session used, as DSH's four token buckets (never a price). A job that reported nothing usable is
 * still recorded, without tokens, so the cost says "not measured" instead of 0. One record per job.
 */
export function recordGenerationUsage(session, { jobId, cardId, tokenUsage } = {}, now = Date.now()) {
  if (!jobId || (session.usage || []).some((record) => record.kind === 'generation' && record.jobId === jobId)) return null;
  const usage = tokenUsage && typeof tokenUsage === 'object'
    ? Object.fromEntries(BUCKETS.map((field) => [field, Number.isSafeInteger(tokenUsage[field]) && tokenUsage[field] >= 0 ? tokenUsage[field] : 0]))
    : null;
  const tokens = usage ? totalTokens(usage) : 0;
  const record = { kind: 'generation', at: now, jobId, ...(cardId ? { cardId } : {}), ...(tokens > 0 ? { tokens, usage } : {}) };
  (session.usage ||= []).push(record);
  return record;
}

/**
 * Adds a line to the session's predictions when the remaining-time range moved enough (or `reason` names a change of scope). Called when
 * something changed the range, never when the panel reads it, so polling writes nothing.
 */
export function recordPredictionChange(state, session, reason = '', now = Date.now()) {
  const { estimate } = studySessionReadout(state, session);
  const next = shouldRecordPrediction(session.predictions?.at(-1), estimate, reason, now);
  if (!next) return null;
  (session.predictions ||= []).push(next);
  if (session.predictions.length > MAX_PREDICTIONS) session.predictions.splice(0, session.predictions.length - MAX_PREDICTIONS);
  return next;
}

/** An answer was recorded: the active sessions whose check items it backs may have a new range. */
export function recordPredictionsAfterAnswer(state, attempt) {
  if (!attempt) return;
  for (const session of state.studySessions || []) {
    if (session.status !== 'active') continue;
    const backs = (session.goal?.checkItems || []).some((item) => (item.targetCardIds || []).includes(attempt.quiz_id) || (item.topic && item.topic === attempt.topic));
    if (backs) recordPredictionChange(state, session);
  }
}
