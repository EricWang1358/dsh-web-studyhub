import { createHash } from 'node:crypto';
import { resolve, win32 } from 'node:path';
import { courseActivityRules } from '../course-active.js';
import { cardRef, isActiveAttempt, isSocraticAttempt } from '../mastery.js';
import { sourcesWithCourses } from '../source-courses.js';
import { stampSourceVersions } from '../material-source-versions.js';

export function check(condition, message) {
  if (!condition) throw new Error(message);
}
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
const windowsRoot = root => process.platform === 'win32' || /^[a-z]:[\\/]|^\\\\/i.test(root);
export const rootKey = root => hash(windowsRoot(root) ? win32.normalize(root).toLowerCase() : resolve(root));
const activityCache = new WeakMap();
export function activityRules(state) {
  // Mutable transactions must use their current contents; only immutable views can be cached.
  if (!Object.isFrozen(state)) return courseActivityRules(state);
  if (!activityCache.has(state)) activityCache.set(state, courseActivityRules(state));
  return activityCache.get(state);
}
export function validDate(value) {
  check(
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value,
    '请提供有效的 YYYY-MM-DD 学习日期',
  );
  return value;
}
export const columnOf = (board, taskId) => board.columns.find(column => column.cardIds.includes(taskId));
export function isLivePracticeRef(state, ref, rules = activityRules(state), sample = sampleScope(state)) {
  const deck = state.decks.find(item => item.id === ref.deckId);
  return Boolean(
    deck && !deck.archived && !deck.systemKind && rules.deckActive(deck)
    && !isSampleDeck(deck, sample, rules.nameOfDeck(deck))
    && deck.cards.some(item => item.id === ref.cardId && !item.suspended && !item.publicationUngrable),
  );
}

function answeredPracticeRefs(state, card) {
  const run = state.runs.find(item => item.dailyPlanTaskId === card.id);
  const answered = new Set((run?.entries || []).filter(entry => entry.feedback && !entry.retry).map(entry => cardRef(entry.deckId, entry.card.id)));
  if (run) {
    for (const attempt of state.attempts.filter(attempt => isActiveAttempt(attempt) && !isSocraticAttempt(attempt) && attempt.runId === run.id && !attempt.retry)) {
      answered.add(cardRef(attempt.deckId, attempt.quiz_id));
    }
  }
  return answered;
}

/**
 * Active subset of an accepted practice task's scope (#1436 Item 7): keeps cards that are either still live
 * or already answered in this task's run, so slaying a card mid-task never deadlocks completion while
 * preserving `task.scope` intact in case the card is later restored.
 */
export function effectivePracticeScope(state, card) {
  const scope = Array.isArray(card?.learningTask?.scope) ? card.learningTask.scope : [];
  const rules = activityRules(state);
  const sample = sampleScope(state);
  const answered = answeredPracticeRefs(state, card);
  return scope.filter(ref => answered.has(cardRef(ref.deckId, ref.cardId)) || isLivePracticeRef(state, ref, rules, sample));
}

export function taskProgress(state, card) {
  const task = card.learningTask;
  if (task.kind === 'reading') return { done: task.completedAt ? 1 : 0, total: 1 };
  if (task.kind === 'workflow') {
    const session = state.workflowSessions.find(session => session.id === card.studyRef.sessionId);
    const total = session?.template?.steps?.length || task.stepCount || 1;
    const completedSteps = Object.values(session?.records || {}).filter(record => record.outcome === 'done').length;
    return { done: session?.status === 'completed' ? total : Math.min(total, completedSteps), total };
  }
  const answered = answeredPracticeRefs(state, card);
  const effective = effectivePracticeScope(state, card);
  const done = task.scope.filter(ref => answered.has(cardRef(ref.deckId, ref.cardId))).length;
  const total = effective.length > 0 ? Math.max(effective.length, done) : task.scope.length;
  return { done, total };
}

/** Actual integer minutes spent on a practice task, aggregated from active direct attempts of its run (`elapsed_ms`). */
export function observedPracticeMinutes(state, card) {
  if (card?.learningTask?.kind !== 'practice') return undefined;
  const run = (state?.runs || []).find(item => item.dailyPlanTaskId === card.id)
    || (card.learningTask.runId ? (state?.runs || []).find(item => item.id === card.learningTask.runId) : null);
  if (!run) return undefined;
  let totalMs = 0;
  let count = 0;
  for (const attempt of state?.attempts || []) {
    if (!isActiveAttempt(attempt) || isSocraticAttempt(attempt) || attempt.implicit || attempt.runId !== run.id) continue;
    const ms = Number(attempt.elapsed_ms);
    if (!Number.isFinite(ms) || ms < 0) continue;
    totalMs += ms;
    count++;
  }
  if (!count) return undefined;
  return Math.min(240, Math.max(1, Math.round(totalMs / 60000)));
}
const sourcesCache = new WeakMap();
/** Active-view materials with resolved courses and dynamic version stamping (excludes hidden outlines/books). */
export function eligibleSources(state) {
  if (!state) return [];
  if (Object.isFrozen(state) && sourcesCache.has(state)) return sourcesCache.get(state);
  const stamped = stampSourceVersions(sourcesWithCourses(state), state.documents);
  if (Object.isFrozen(state)) sourcesCache.set(state, stamped);
  return stamped;
}

/** Identify sample/example course names and record IDs that must not pollute daily plans. */
export function sampleScope(state) {
  const ids = new Set([
    state?.sample?.deckId,
    state?.sample?.caseDeckId,
    state?.sample?.draftId,
    state?.sample?.sourceId,
  ].filter(Boolean));
  const courses = new Set([
    state?.sample?.course,
    ...(state?.courses || []).filter(c => (c?.sample || c?.example) && c?.name).map(c => c.name),
    ...(state?.decks || []).filter(d => (d?.sample || ids.has(d?.id)) && d?.course).map(d => d.course),
  ].filter(Boolean));
  return { ids, courses };
}

export function isSampleDeck(deck, sample, courseName = '') {
  if (!deck) return true;
  if (deck.sample || deck.example || sample.ids.has(deck.id) || String(deck.id || '').startsWith('sample-')) return true;
  return Boolean(courseName && sample.courses.has(courseName));
}

export function isSampleSource(source, sample) {
  if (!source) return true;
  if (source.sample || source.example || sample.ids.has(source.id) || String(source.id || '').startsWith('sample-')) return true;
  const courses = Array.isArray(source.courses) ? source.courses.filter(Boolean) : (source.course ? [source.course] : []);
  return courses.length > 0 && courses.every(course => sample.courses.has(course));
}

export function available(state, card, root, { strict = false } = {}) {
  if (rootKey(card.studyRef?.root || '') !== rootKey(root)) return false;
  const task = card.learningTask;
  const rules = activityRules(state);
  const sample = sampleScope(state);
  if (task.kind === 'workflow') {
    const session = state.workflowSessions.find(session => session.id === card.studyRef.sessionId);
    return !!session && !session.archived && (!session.course?.name || rules.status(session.course.name).active);
  }
  if (task.kind === 'reading') {
    const source = eligibleSources(state).find(source => source.id === card.studyRef.id);
    return !!source && !source.archived && !source.historical && !isSampleSource(source, sample)
      && (!source.courses?.length || source.courses.some(course => rules.status(course).active));
  }
  if (strict) {
    return task.scope.length > 0 && task.scope.every(ref => isLivePracticeRef(state, ref, rules, sample));
  }
  return task.scope.length > 0 && effectivePracticeScope(state, card).length > 0;
}
export function taskView(board, state, card, root) {
  const task = card.learningTask;
  const progress = taskProgress(state, card);
  const column = columnOf(board, card.id);
  const done = progress.done === progress.total;
  return {
    id: card.id, title: card.title, reason: task.reason, minutes: task.minutes,
    kind: task.kind, studyRef: card.studyRef, progress,
    status: done ? 'done' : task.startedAt || column?.id === 'doing' ? 'doing' : 'todo',
    available: available(state, card, root),
    ...(task.runId ? { runId: task.runId } : {}),
    ...(task.actualMinutes !== undefined ? { actualMinutes: task.actualMinutes } : {}),
  };
}

export const savedTask = card => ({
  id: card.id, title: card.title,
  studyRef: structuredClone(card.studyRef), learningTask: structuredClone(card.learningTask),
});

export const findTask = (board, plan, taskId) =>
  board.cards[taskId] || board.archived.find(card => card.id === taskId) || plan?.effort?.[taskId]?.task;
