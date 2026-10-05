import { stageCodeForText } from './contexts/jobs/contracts.js';
import { modelReasoning } from './reasoning-effort.js';

/* Reasoning level per generation stage (#218). Planning the targets and the independent review are where careful reasoning pays; writing a
   question from a verified blueprint, a replacement and a wording repair do not need it. The learner states each stage in RELATIVE terms,
   because models offer different real levels (some have no "medium"): lowest, low, default, high, highest, or follow (the session's level, as
   before). `resolveEffort` maps a relative level to the nearest level the model really offers and says so when it is not an exact match.

   INTEGRATION POINT: `resolveEffort(efforts, relative, defaultEffort)` is the one place that maps a relative level to a model's real level.
   The shared module of the audio work (lib/ resolveModelInfo(...).reasoning.efforts mapping with a visible note) can replace its body
   as long as it keeps the `{ id, name, note }` result. */

export const RELATIVE_EFFORTS = Object.freeze(['follow', 'lowest', 'low', 'default', 'high', 'highest']);
/** The stages that carry a level, keyed like the generation settings (effortPlanning, effortReview, effortWriting, effortRepair). */
export const EFFORT_STAGES = Object.freeze(['planning', 'review', 'writing', 'repair']);
/** Defaults: planning and review keep the session's level (they decide what is true); writing and repair run low. */
export const EFFORT_DEFAULTS = Object.freeze({ planning: 'follow', review: 'follow', writing: 'low', repair: 'low' });
export const effortKey = (stage) => `effort${stage[0].toUpperCase()}${stage.slice(1)}`;

/** The effort stage a model call belongs to, from the stage text the pipeline reports; planning when unknown never happens (undefined = leave alone). */
export function effortStageOf(stageText) {
  const code = stageCodeForText(stageText);
  if (code === 'planning' || code === 'blueprinting') return 'planning';
  if (code === 'reviewing') return 'review';
  if (code === 'authoring') return 'writing';
  if (code === 'repairing') return 'repair';
  return undefined;
}

const NAME = { lowest: /^(off|none|disabled?|no[-_ ]?think(ing)?|minimal|non[-_ ]?thinking)$/i, low: /low/i, high: /^high$/i, highest: /(max|xhigh|ultra)/i };
const positionOf = { lowest: 0, low: 0.25, high: 0.75, highest: 1 };

/**
 * The real level for a relative one. `efforts` are the model's levels lowest first (`[{id, name}]`), `defaultEffort` the level it applies when none is chosen.
 * @returns `{ id, name, note }`: `id` is undefined when the model offers no levels or the preference is follow (nothing to set); `note` is '' for an
 *   exact match and otherwise says which level was used instead.
 */
export function resolveEffort(efforts, relative, defaultEffort = '') {
  const list = Array.isArray(efforts) ? efforts : [];
  if (!list.length || !RELATIVE_EFFORTS.includes(relative) || relative === 'follow') return { id: undefined, name: '', note: '' };
  const named = (re) => list.find((level) => re.test(String(level.id)) || re.test(String(level.name)));
  const exact = relative === 'default' ? list.find((level) => String(level.id) === String(defaultEffort)) : named(NAME[relative]);
  if (exact) return { id: String(exact.id), name: exact.name, note: '' };
  const target = relative === 'default'
    ? Math.max(0, list.findIndex((level) => String(level.id) === String(defaultEffort)))
    : Math.round(positionOf[relative] * (list.length - 1));
  const used = list[Math.min(list.length - 1, Math.max(0, target))];
  return { id: String(used.id), name: used.name, note: `The model has no "${relative}" level; used "${used.name}" instead.` };
}

/**
 * The route one generation call should use: the stage's relative level resolved against the levels `route`'s model offers. A stage that follows
 * (or a model without levels, or a stage this module does not know) keeps the route as it is. `note` is set when the level was approximated.
 */
export async function stageEffortRoute(ctx, route, stageText, stageEfforts, signal) {
  const stage = effortStageOf(stageText), relative = stage && stageEfforts?.[stage];
  if (!route || !relative || relative === 'follow') return { route, note: '' };
  const { efforts, defaultEffort } = await modelReasoning(ctx, route.provider, route.model, signal);
  const chosen = resolveEffort(efforts, relative, defaultEffort);
  if (chosen.id === undefined) return { route, note: '' };
  return { route: { ...route, reasoningEffort: chosen.id }, note: chosen.note, stage, relative, effort: chosen.id };
}
