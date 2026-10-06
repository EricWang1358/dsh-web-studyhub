import { withQualityStages, qualityReview } from './assessment.mjs';

/* The fixtures of the S3-0 restart baselines of the supplement paths, shared with the restart-continuation suite (S3-3): fake models only. */

export const evidence = 'Bridge separates an abstraction from its implementation so the two can vary independently.';
export const other = 'A trade-off analysis weighs the cost of each architectural characteristic against the others.';
export const card = (id, sourceId = 'p1', quote = evidence) => ({ id, kind: 'flashcard', topic: 'Bridge', objective: `Explain dimension ${id}`,
  prompt: `Why separate report and renderer dimension ${id}?`, answer: 'They can vary independently.', hint: 'Consider two reasons to change.',
  explanation: 'Report types and rendering backends vary independently.', misconception: 'A subclass for every combination causes a cross product.', citations: [{ sourceId, quote }] });
export const SCHEDULE = { repetitions: 3, interval_days: 16, ease_factor: 2.6, due_at: '2026-10-16T00:00:00.000Z' };
export const ONE_BY_ONE = { concurrency: 1, batchSize: 1, jobTimeoutMinutes: 20, fillRounds: 0, effortPlanning: 'follow', effortReview: 'follow', effortWriting: 'low', effortRepair: 'low' };

/** A model that authors one fresh card per part (ids `<name>-n`) and holds the author stage of the `at`-th part (1-based) until the gate is opened. */
export function authoring(hold, at, name = 'new') {
  let authors = 0, seen = 0;
  const inner = withQualityStages(async (system, prompt) => {
    if (system.startsWith('You author')) return JSON.stringify({ title: 'Supplement', cards: [card(`${name}-${++authors}`, 'p1')] });
    return JSON.stringify(qualityReview(JSON.parse(prompt).candidate));
  });
  return async (system, prompt, context = {}) => {
    if (system.startsWith('You author') && ++seen === at && !hold.entered) { hold.entered = true; await hold.promise; }
    return inner(system, prompt, context);
  };
}

