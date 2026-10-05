import { stageCodeForText } from './contexts/jobs/contracts.js';
import { EFFORT_PREFERENCES, reasoningFor } from './model-effort.js';

/* Reasoning level per generation stage (#218). Planning the targets and the independent review are where careful reasoning pays; writing a
   question from a verified blueprint, a replacement and a wording repair do not need it. The learner states each stage in RELATIVE terms
   (lib/model-effort.js: default, lowest, low, medium, high, highest) or as `follow` (the session's own level, as before).

   This module knows only WHICH preference a stage carries. Mapping a preference onto the levels a model really offers is lib/model-effort.js'
   job and nobody else's (#226): generation and the audio settings get the same level, tie-break and wording from it. */

/** The generation vocabulary: the shared preferences of lib/model-effort.js, plus following the session. */
export const STAGE_EFFORT_PREFERENCES = Object.freeze(['follow', ...EFFORT_PREFERENCES]);
/** The stages that carry a level, keyed like the generation settings (effortPlanning, effortReview, effortWriting, effortRepair). */
export const EFFORT_STAGES = Object.freeze(['planning', 'review', 'writing', 'repair']);
/** Defaults: planning and review keep the session's level (they decide what is true); writing and repair run low. */
export const EFFORT_DEFAULTS = Object.freeze({ planning: 'follow', review: 'follow', writing: 'low', repair: 'low' });
export const effortKey = (stage) => `effort${stage[0].toUpperCase()}${stage.slice(1)}`;

/** The effort stage a model call belongs to, from the stage text the pipeline reports; undefined (leave alone) when it is none of them. */
export function effortStageOf(stageText) {
  const code = stageCodeForText(stageText);
  if (code === 'planning' || code === 'blueprinting') return 'planning';
  if (code === 'reviewing') return 'review';
  if (code === 'authoring') return 'writing';
  if (code === 'repairing') return 'repair';
  return undefined;
}

/**
 * The route one generation call should use: the stage's preference resolved against the levels `route`'s model offers (lib/model-effort.js).
 * A stage that follows, a stage this module does not know, or a model without adjustable levels keeps the route as it is. The model default
 * clears the session's level (the model runs at its own). `choice` is the shared mapping's answer, for the step's note.
 */
export async function stageEffortRoute(ctx, route, stageText, stageEfforts, signal) {
  const stage = effortStageOf(stageText), preference = stage && stageEfforts?.[stage];
  if (!route || !preference || preference === 'follow' || !EFFORT_PREFERENCES.includes(preference)) return { route, choice: null };
  const choice = await reasoningFor(ctx, route, preference, signal);
  if (choice.reason === 'unsupported') return { route, choice };
  return { route: { ...route, reasoningEffort: choice.id }, choice, stage };
}
