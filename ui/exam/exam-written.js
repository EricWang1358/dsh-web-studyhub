import { ui, uiFormat } from '../i18n.js';
import { QUESTION_COUNT } from '../../lib/limits.js';

/* What the written (multiple-choice) exam needs besides the lifecycle: the question count, the choices the server
   already saved, and the words for a question's kind and the score change. */

export const DEFAULT_COUNT = 10;

export const clampCount = (value) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(QUESTION_COUNT.max, Math.max(QUESTION_COUNT.min, n)) : DEFAULT_COUNT;
};

/** The server's saved picks of an exam run ({ "deckId:cardId": [optionId…] }), for restoring and for navigating back. */
export const picksFromRun = (run) => {
  const map = {};
  for (const pick of run?.picks || [])
    if (pick?.deckId && pick?.cardId && Array.isArray(pick.selected) && pick.selected.length)
      map[`${pick.deckId}:${pick.cardId}`] = pick.selected;
  return map;
};

export const kindName = (kind) => (kind === 'multi' ? ui('多选') : ui('单选'));
export const cardKindName = (card) => kindName(card?.multiple ? 'multi' : 'quiz');

/** Which kinds of question the exam may draw, as the setup's switch labels them (keys are the server's `examKinds`). */
export const EXAM_KIND_LABELS = { all: '不限题型', quiz: '只单选', multi: '只多选', balanced: '单双均衡' };

/** How many questions of the chosen kind the picked decks hold, from their { quiz, multi } counts. */
export const typeAvailableOf = (kinds, typeMode) => (typeMode === 'quiz' ? kinds.quiz : typeMode === 'multi' ? kinds.multi : kinds.quiz + kinds.multi);

export const scoreChange = (comparison) => comparison.deltaPct > 0
  ? uiFormat('比上次高 {0} 个百分点', [comparison.deltaPct])
  : comparison.deltaPct < 0
    ? uiFormat('比上次低 {0} 个百分点', [-comparison.deltaPct])
    : ui('与上次相同');
