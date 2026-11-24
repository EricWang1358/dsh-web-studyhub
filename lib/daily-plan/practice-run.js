import { optionOrder } from '../domain.js';
import { cardRef, isActiveAttempt } from '../mastery.js';
import { projectRun } from '../contexts/study/undo-ops.js';
import { masteryAtStart } from '../run-mastery.js';
import { id } from '../util.js';
import { available, check, effectivePracticeScope } from './tasks.js';

const now = () => new Date().toISOString();
const liveCard = (state, ref) => state.decks.find(deck => deck.id === ref.deckId)
  ?.cards.find(card => card.id === ref.cardId) || null;

function createRun(state, card, scope) {
  const entries = scope.flatMap(ref => {
    const live = liveCard(state, ref);
    if (!live) return [];
    const cloned = structuredClone(live);
    return [{
      deckId: ref.deckId, card: cloned, order: optionOrder(cloned),
      startedAt: Date.now(), feedback: null, revealed: false, selected: null, response: '',
    }];
  });
  const run = {
    id: id(), mode: 'path', scope, key: `daily:${card.id}`, purpose: 'daily',
    dailyPlanTaskId: card.id, deckId: card.studyRef.id, index: 0, startedAt: now(), entries,
  };
  run.mastery = masteryAtStart(state, run);
  return run;
}

function restoredEntry(state, run, ref) {
  const live = liveCard(state, ref);
  if (!live) return null;
  const attempt = state.attempts.findLast(attempt =>
    isActiveAttempt(attempt) && attempt.runId === run.id && !attempt.retry && attempt.deckId === ref.deckId && attempt.quiz_id === ref.cardId);
  const cloned = structuredClone(live);
  return {
    deckId: ref.deckId, card: cloned, order: optionOrder(cloned),
    startedAt: Date.now(),
    feedback: attempt ? { grade: attempt.grade, correct: attempt.grade >= 3, nextDue: attempt.after?.due_at } : null,
    revealed: !!attempt, selected: null, response: '',
  };
}

function reconcileQueue(state, run, scope) {
  const current = run.entries[run.index];
  const byRef = new Map(run.entries.filter(entry => !entry.retry)
    .map(entry => [cardRef(entry.deckId, entry.card.id), entry]));
  const entries = scope.map(ref => byRef.get(cardRef(ref.deckId, ref.cardId)) || restoredEntry(state, run, ref)).filter(Boolean);
  const allowed = new Set(entries.map(entry => cardRef(entry.deckId, entry.card.id)));
  entries.push(...run.entries.filter(entry => entry.retry && allowed.has(cardRef(entry.deckId, entry.card.id))));

  // Keep the consented scope exact, restoring removed entries without discarding answers or retries.
  const changed = entries.length !== run.entries.length || entries.some((entry, index) => entry !== run.entries[index]);
  if (changed) run.queueVersion = (run.queueVersion || 0) + 1;
  run.entries = entries;
  run.scope = scope;
  // Not answered yet: the mastery before the first answer is of the questions the round has now.
  if ((changed || !run.mastery) && !entries.some(entry => entry.feedback)) run.mastery = masteryAtStart(state, run);
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
    const scope = effectivePracticeScope(state, card);
    let run = state.runs.find(run => run.dailyPlanTaskId === card.id);
    if (run) {
      reconcileQueue(state, run, scope);
    } else {
      run = createRun(state, card, scope);
      state.runs.push(run);
    }
    return projectRun(state, run);
  }, { runs: 'all' });
}
