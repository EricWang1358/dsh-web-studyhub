import { reviewEntryKey } from './async.js';

export const MAX_PRACTICE_STACK_DEPTH = 20;
const STORAGE_PREFIX = 'studyhub:last-practice:';

const ORIGIN_BY_PAGE = Object.freeze({
  sources: 'source',
  wrongbook: 'wrongbook',
  examcoach: 'coach',
  examprep: 'coach',
  exam: 'coach',
  dashboard: 'stats',
  search: 'search',
});

/** Classify the destination of a jump away from a question. */
export function originKindForDestination(page, modal = null) {
  if (modal?.type === 'source' || modal?.type === 'sources') return 'source';
  if (typeof page === 'string' && Object.hasOwn(ORIGIN_BY_PAGE, page)) return ORIGIN_BY_PAGE[page];
  return 'other';
}

function normalizeClozeValues(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function cloneDraft(entry, run) {
  if (!entry || typeof entry !== 'object') return null;
  const key = reviewEntryKey(run);
  return {
    key,
    selected: Array.isArray(entry.selected) ? [...entry.selected] : [],
    response: typeof entry.response === 'string' ? entry.response : '',
    clozeValues: normalizeClozeValues(entry.clozeValues),
    hint: Boolean(entry.hint),
    explain: Boolean(entry.explain),
    teachAnswer: typeof entry.teachAnswer === 'string' ? entry.teachAnswer : '',
  };
}

function shortPrompt(card) {
  const raw = String(card?.prompt ?? card?.front ?? '').replace(/\{\{[^{}]+\}\}/g, '＿＿').replace(/\s+/g, ' ').trim();
  return raw.length > 96 ? `${raw.slice(0, 95)}…` : raw;
}

/**
 * Capture the learner's current practice question and uncommitted draft into a serialisable stack frame.
 * Returns null if no active practice question is on screen.
 */
export function capturePracticeFrame({
  root = '',
  run = null,
  entry = null,
  reading = null,
  originKind = 'other',
  course = null,
  courseSwitched = false,
  now = Date.now(),
} = {}) {
  if (!run?.id || !run?.card?.id) return null;
  const deckId = run.deckId || run.card.deckId || '';
  const index = Number.isInteger(run.index) && run.index >= 0 ? run.index : 0;
  const total = Number.isInteger(run.total) && run.total > 0 ? run.total : index + 1;
  return {
    id: `${run.id}:${run.card.id}:${index}:${now}`,
    root: String(root || ''),
    runId: run.id,
    deckId,
    cardId: run.card.id,
    index,
    total,
    prompt: shortPrompt(run.card),
    topic: String(run.card.topic || ''),
    runComplete: Boolean(run.complete || run.closed),
    draft: run.feedback ? null : cloneDraft(entry, run),
    reading: reading && typeof reading === 'object' ? { ...reading } : null,
    originKind: typeof originKind === 'string' && originKind ? originKind : 'other',
    course: typeof course === 'string' ? course : null,
    courseSwitched: Boolean(courseSwitched),
    pushedAt: now,
  };
}

/** True when `run` is currently showing the exact same question position as `frame`. */
export function isSamePracticeLocation(frame, run) {
  if (!frame || !run?.id) return false;
  return frame.runId === run.id
    && frame.index === run.index
    && (!frame.cardId || !run.card?.id || frame.cardId === run.card.id);
}

/** Push a frame onto the LIFO stack (deduplicating adjacent updates to the same runId+cardId+index). */
export function pushPracticeFrame(stack = [], frame = null) {
  const list = Array.isArray(stack) ? stack : [];
  if (!frame || !frame.runId || !frame.cardId) return list;
  const top = list.at(-1);
  if (top && top.root === frame.root && top.runId === frame.runId && top.cardId === frame.cardId && top.index === frame.index) {
    return [
      ...list.slice(0, -1),
      {
        ...top,
        ...frame,
        id: top.id,
        courseSwitched: Boolean(top.courseSwitched || frame.courseSwitched),
        course: top.courseSwitched ? top.course : frame.course,
      },
    ];
  }
  const next = [...list, frame];
  return next.length > MAX_PRACTICE_STACK_DEPTH ? next.slice(-MAX_PRACTICE_STACK_DEPTH) : next;
}

/** Pop the top frame from the stack. */
export function popPracticeFrame(stack = []) {
  const list = Array.isArray(stack) ? stack : [];
  if (!list.length) return { frame: null, stack: [] };
  return { frame: list.at(-1), stack: list.slice(0, -1) };
}

/** Read the top frame without popping. */
export const peekPracticeFrame = (stack = []) => (Array.isArray(stack) && stack.length ? stack.at(-1) : null);

/** Read the original (bottom-most) frame of the stack. */
export const rootPracticeFrame = (stack = []) => (Array.isArray(stack) && stack.length ? stack[0] : null);

/** Pop directly back to the original question frame (bottom of stack). */
export function popToOriginalFrame(stack = []) {
  const list = Array.isArray(stack) ? stack : [];
  if (!list.length) return { frame: null, stack: [] };
  return { frame: list[0], stack: [] };
}

/**
 * Only restore uncommitted draft when the loaded question is still unanswered and matches the captured card.
 * Already-graded results are NEVER overwritten or re-submitted.
 */
export function isDraftRestorable(frame, loadedRun) {
  if (!frame?.draft || !loadedRun?.card?.id) return false;
  if (loadedRun.complete || loadedRun.closed || loadedRun.feedback) return false;
  return loadedRun.card.id === frame.cardId;
}

/**
 * Restore a practice frame without re-grading or billing:
 * - Reads `review.get({ runId })` first (read-only).
 * - If the run is ended/closed/missing, does NOT silently jump away: returns `{ status: 'ended', frame, message, practiceAgainScope }`.
 * - Otherwise moves to `frame.index` (only if needed) and restores the uncommitted draft via `enterMovedRun`.
 */
export async function restorePracticeFrame({ frame, call, enterMovedRun, onEnded } = {}) {
  if (!frame?.runId || typeof call !== 'function') return { status: 'missing', frame: frame || null };
  const practiceAgainScope = frame.deckId && frame.cardId ? [{ deckId: frame.deckId, cardId: frame.cardId }] : null;
  const endedResult = () => {
    const payload = {
      status: 'ended',
      frame,
      message: `原来的第 ${(frame.index || 0) + 1} 题所在练习已结束。`,
      practiceAgainScope,
    };
    onEnded?.(payload);
    return payload;
  };

  let current;
  try {
    current = await call('review.get', { runId: frame.runId });
  } catch {
    return endedResult();
  }
  if (!current || !current.id) return endedResult();
  if ((current.closed || current.complete) && !frame.runComplete) {
    return endedResult();
  }

  let target = current;
  if (!frame.runComplete && Number.isInteger(frame.index) && current.index !== frame.index) {
    try {
      target = await call('review.move', { runId: frame.runId, index: frame.index });
    } catch {
      return endedResult();
    }
    if (!target || target.closed || (target.complete && !frame.runComplete)) {
      return endedResult();
    }
  }

  const draftRestored = isDraftRestorable(frame, target);
  enterMovedRun?.(target, draftRestored ? frame.draft : undefined);
  return { status: 'restored', frame, run: target, draftRestored };
}

function storageKey(root) {
  return `${STORAGE_PREFIX}${String(root || 'default')}`;
}

/** Persist the last practice position to localStorage on key transitions only (never polled). */
export function saveLastPracticePosition(storage, root, frame) {
  if (!storage || !root || !frame?.runId || !frame?.cardId) return false;
  try {
    const compact = {
      root: String(root),
      runId: frame.runId,
      deckId: frame.deckId || '',
      cardId: frame.cardId,
      index: Number.isInteger(frame.index) ? frame.index : 0,
      total: Number.isInteger(frame.total) ? frame.total : 1,
      prompt: String(frame.prompt || ''),
      runComplete: Boolean(frame.runComplete),
      draft: frame.draft || null,
      savedAt: Date.now(),
    };
    storage.setItem(storageKey(root), JSON.stringify(compact));
    return true;
  } catch {
    return false;
  }
}

/** Read the last saved practice position from localStorage (null if absent or malformed). */
export function readLastPracticePosition(storage, root) {
  if (!storage || !root) return null;
  try {
    const raw = storage.getItem(storageKey(root));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.runId !== 'string' || !parsed.runId || typeof parsed.cardId !== 'string' || !parsed.cardId) {
      return null;
    }
    if (parsed.draft && typeof parsed.draft === 'object') {
      parsed.draft = {
        ...parsed.draft,
        clozeValues: normalizeClozeValues(parsed.draft.clozeValues),
      };
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Clear the persisted last practice position for a library root. */
export function clearLastPracticePosition(storage, root) {
  if (!storage || !root) return;
  try { storage.removeItem(storageKey(root)); } catch { /* ignore storage errors */ }
}
