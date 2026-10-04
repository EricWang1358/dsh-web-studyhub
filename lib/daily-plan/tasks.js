import { createHash } from 'node:crypto';
import { resolve, win32 } from 'node:path';
import { courseActivityRules } from '../course-active.js';
import { cardRef } from '../mastery.js';

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
export function taskProgress(state, card) {
  const task = card.learningTask;
  if (task.kind === 'reading') return { done: task.completedAt ? 1 : 0, total: 1 };
  if (task.kind === 'workflow') {
    const session = state.workflowSessions.find(session => session.id === card.studyRef.sessionId);
    const total = session?.template?.steps?.length || task.stepCount || 1;
    const completedSteps = Object.values(session?.records || {}).filter(record => record.outcome === 'done').length;
    return { done: session?.status === 'completed' ? total : Math.min(total, completedSteps), total };
  }
  const run = state.runs.find(run => run.dailyPlanTaskId === card.id);
  const answered = new Set((run?.entries || []).filter(entry => entry.feedback && !entry.retry).map(entry => cardRef(entry.deckId, entry.card.id)));
  if (run) {
    for (const attempt of state.attempts.filter(attempt => attempt.runId === run.id && !attempt.retry)) {
      answered.add(cardRef(attempt.deckId, attempt.quiz_id));
    }
  }
  return { done: task.scope.filter(ref => answered.has(cardRef(ref.deckId, ref.cardId))).length, total: task.scope.length };
}
export function available(state, card, root) {
  if (rootKey(card.studyRef?.root || '') !== rootKey(root)) return false;
  const task = card.learningTask;
  const rules = activityRules(state);
  if (task.kind === 'workflow') {
    const session = state.workflowSessions.find(session => session.id === card.studyRef.sessionId);
    return !!session && !session.archived && (!session.course?.name || rules.status(session.course.name).active);
  }
  if (task.kind === 'reading') {
    const source = state.sources.find(source => source.id === card.studyRef.id);
    return !!source && !source.archived && (!source.courses?.length || source.courses.some(course => rules.status(course).active));
  }
  return task.scope.length > 0 && task.scope.every(ref => {
    const deck = state.decks.find(deck => deck.id === ref.deckId);
    return deck && !deck.archived && !deck.systemKind && rules.deckActive(deck) &&
      deck.cards.some(card => card.id === ref.cardId && !card.suspended && !card.publicationUngrable);
  });
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
