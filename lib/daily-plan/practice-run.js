import { cardRef } from '../mastery.js';
import { projection } from '../study-state.js';
import { id } from '../util.js';
import { available, check } from './tasks.js';

const now = () => new Date().toISOString();
const liveCard = (state, ref) => state.decks.find(deck => deck.id === ref.deckId)
  .cards.find(card => card.id === ref.cardId);

function createRun(state, card) {
  const task = card.learningTask;
  const entries = task.scope.map(ref => ({
    deckId: ref.deckId, card: structuredClone(liveCard(state, ref)),
    startedAt: Date.now(), feedback: null, revealed: false, selected: null, response: '',
  }));
  for (const entry of entries) entry.order = (entry.card.options || []).map(option => option.id);
  return {
    id: id(), mode: 'path', scope: task.scope, key: `daily:${card.id}`, purpose: 'daily',
    dailyPlanTaskId: card.id, deckId: card.studyRef.id, index: 0, startedAt: now(), entries,
  };
}

function restoredEntry(state, run, ref) {
  const live = liveCard(state, ref);
  const attempt = state.attempts.findLast(attempt =>
    attempt.runId === run.id && !attempt.retry && attempt.deckId === ref.deckId && attempt.quiz_id === ref.cardId);
  return {
    deckId: ref.deckId, card: structuredClone(live), order: (live.options || []).map(option => option.id),
    startedAt: Date.now(),
    feedback: attempt ? { grade: attempt.grade, correct: attempt.grade >= 3, nextDue: attempt.after?.due_at } : null,
    revealed: !!attempt, selected: null, response: '',
  };
}

function reconcileQueue(state, run, scope) {
  const current = run.entries[run.index];
  const byRef = new Map(run.entries.filter(entry => !entry.retry)
    .map(entry => [cardRef(entry.deckId, entry.card.id), entry]));
  const entries = scope.map(ref => byRef.get(cardRef(ref.deckId, ref.cardId)) || restoredEntry(state, run, ref));
  const allowed = new Set(scope.map(ref => cardRef(ref.deckId, ref.cardId)));
  entries.push(...run.entries.filter(entry => entry.retry && allowed.has(cardRef(entry.deckId, entry.card.id))));

  // Keep the consented scope exact, restoring removed entries without discarding answers or retries.
  if (entries.length !== run.entries.length || entries.some((entry, index) => entry !== run.entries[index])) {
    run.queueVersion = (run.queueVersion || 0) + 1;
  }
  run.entries = entries;
  run.scope = scope;
  const retainedIndex = current ? entries.findIndex(entry => entry === current) : -1;
  if (run.closedAt || retainedIndex < 0) {
    run.index = entries.findIndex(entry => !entry.feedback);
  } else {
    run.index = retainedIndex;
  }
  if (run.index < 0) run.index = entries.length;
  if (run.index < entries.length) delete run.closedAt;
}

export async function startPracticeRun(storage, card, root) {
  return storage.update(state => {
    check(available(state, card, root), '学习内容已删除、归档或停用，请重新安排');
    let run = state.runs.find(run => run.dailyPlanTaskId === card.id);
    if (run) {
      reconcileQueue(state, run, card.learningTask.scope);
    } else {
      run = createRun(state, card);
      state.runs.push(run);
    }
    return projection(state, run);
  }, { runs: 'all' });
}
