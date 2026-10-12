import { normalizeGenerationPerformance } from '../../../generation-settings.js';
import { EFFORT_PREFERENCES, FOLLOW_EFFORT } from '../../../model-effort.js';
import { EFFORT_STAGES, effortKey } from '../../../stage-effort.js';

/* The gateway policy of a parallel call: its purpose (the console's lane: inventory, outline, write, review, repair, plan), the learner's own model, direct,
   at the reasoning level the learner set for its stage (Settings > generation: planning, writing, review, repair; lib/stage-effort.js). The level is only named here; the
   one mapping onto the levels a model offers is lib/model-effort.js'. */

/** The level of each stage from the saved generation settings: a relative preference, else `follow` (the session's own level). */
export function effortsOf(settings) {
  const performance = normalizeGenerationPerformance(settings?.generation);
  const levelOf = wanted => (EFFORT_PREFERENCES.includes(wanted) ? wanted : FOLLOW_EFFORT);
  return Object.fromEntries(EFFORT_STAGES.map(stage => [stage, levelOf(performance[effortKey(stage)])]));
}

/** Which stage's level a purpose is asked at. */
const STAGE_OF = Object.freeze({ inventory: 'planning', outline: 'planning', plan: 'planning', write: 'writing', exam: 'writing', review: 'review', repair: 'repair' });

export const policyOf = (purpose, efforts) => Object.freeze({ purpose, feature: 'other', requestedEffort: efforts?.[STAGE_OF[purpose]] ?? FOLLOW_EFFORT, executionMode: 'direct',
  budget: null });
