/* Reasoning effort as a RELATIVE STRENGTH, mapped onto the levels the model in use really offers.

   Models name their levels differently: low / medium / high, or Default / Off / Low / High / Max (DeepSeek V4.1 Flash in DSH),
   or none / minimal / low / medium / high / xhigh. A saved preference must not be one model's level name, and must never be
   dropped silently when the model changes (the old exact-id match turned "medium" into "model default" without a word).

   So a preference is one of
       'default'   no explicit level: the model's own default
       'lowest' 'low' 'medium' 'high' 'highest'   a strength, whatever the model calls it
   and `chooseEffort()` maps it onto the nearest level the model offers (a tie goes to the stronger level), reporting whether
   that was exact and, when it was not, why, so the interface can say "this model has no 「中」; High is used".

   Public API (pure functions, no I/O, safe to import from the interface too):
     EFFORT_PREFERENCES, STRENGTHS, STRENGTH_LABEL, isEffortPreference(value)
     classifyEffort(effort)           → 'default' | 'lowest' | … | 'highest' | null   (null: a name this module does not know)
     describeEfforts(efforts)         → { levels: [{ id, name, strength, rank }] sorted weakest first, hasDefault }
     effortChoices(efforts)           → [{ value: 'default' }, { value: strength, id, name }, …]  the options of a select
     chooseEffort(efforts, preference)→ { preference, id, applied, name, exact, reason }
         id: the level id to send (undefined = send none, the model default); applied: 'default' or the strength of that level;
         reason: null | 'nearest' (the model has no such strength) | 'unsupported' (the model offers no adjustable levels)
     effortNote(choice)               → { wanted, used } for wording, or null when nothing needs saying
     providerLevel(preference)        → 'low' | 'medium' | 'high' | undefined   for APIs that only take those (Gemini, Groq)
   And one async helper that reads the levels of a route from the host:
     reasoningFor(ctx, route, preference, signal) → chooseEffort(...) for that route's model (levels are cached per route). */

import { modelReasoning } from './reasoning-effort.js';

export const STRENGTHS = Object.freeze(['lowest', 'low', 'medium', 'high', 'highest']);
export const EFFORT_PREFERENCES = Object.freeze(['default', ...STRENGTHS]);
/** Chinese source text: the interface translates it with ui(). */
export const STRENGTH_LABEL = Object.freeze({ default: '模型默认', lowest: '最低', low: '低', medium: '中', high: '高', highest: '最高' });
const RANK = Object.freeze({ lowest: 0, low: 1, medium: 2, high: 3, highest: 4 });

export const isEffortPreference = (value) => EFFORT_PREFERENCES.includes(value);

const CLASSES = [
  ['default', /^(default|auto|automatic|model[\s_-]?default|adaptive)$/i],
  ['lowest', /^(off|none|disabled?|no[\s_-]?think(ing)?|non[\s_-]?thinking|minimal|minimum|min)$/i],
  ['low', /^low$/i],
  ['medium', /^(medium|mid|middle|moderate|normal|standard|balanced)$/i],
  ['high', /^high$/i],
  ['highest', /^(max|maximum|highest|xhigh|x[\s_-]?high|extra[\s_-]?high|ultra)$/i],
];
/** The strength class of one level (by its id, then its name), or null for a name that is not recognised. */
export function classifyEffort(effort) {
  for (const text of [effort?.id, effort?.name]) {
    const value = String(text ?? '').trim();
    if (!value) continue;
    const found = CLASSES.find(([, pattern]) => pattern.test(value));
    if (found) return found[0];
  }
  return null;
}

/**
 * The levels of a model as the host lists them ([{ id, name }], weakest first as DSH lists them), classified. A level that
 * means "the model default" is not a level to choose: it is `hasDefault`. A name nobody recognises is placed by its position.
 */
export function describeEfforts(efforts = []) {
  const items = (Array.isArray(efforts) ? efforts : []).flatMap((item) => {
    const id = item && item.id !== undefined && item.id !== null ? String(item.id) : '';
    return id ? [{ id, name: typeof item.name === 'string' && item.name.trim() ? item.name : id }] : [];
  });
  const classed = items.map((item) => ({ ...item, strength: classifyEffort(item) }));
  const hasDefault = classed.some((item) => item.strength === 'default');
  const real = classed.filter((item) => item.strength !== 'default');
  const levels = real.map((item, index) => {
    // An unknown name takes the place its position gives it among the levels, spread over the scale.
    const strength = item.strength ?? STRENGTHS[real.length < 2 ? 2 : Math.round(index / (real.length - 1) * 4)];
    return { id: item.id, name: item.name, strength, rank: RANK[strength], at: index };
  }).sort((a, b) => a.rank - b.rank || a.at - b.at).map(({ at, ...level }) => level);
  return { levels, hasDefault };
}

/** The options of a select: the model default first, then one option per strength the model offers (its own name for it). */
export function effortChoices(efforts = []) {
  const seen = new Set(), choices = [{ value: 'default' }];
  for (const level of describeEfforts(efforts).levels) {
    if (seen.has(level.strength)) continue;
    seen.add(level.strength);
    choices.push({ value: level.strength, id: level.id, name: level.name });
  }
  return choices;
}

/** Map a preference onto the model's levels. See the file comment. */
export function chooseEffort(efforts = [], preference = 'default') {
  const wanted = isEffortPreference(preference) ? preference : 'default';
  if (wanted === 'default') return { preference: wanted, id: undefined, applied: 'default', name: '', exact: true, reason: null };
  const { levels } = describeEfforts(efforts);
  if (!levels.length) return { preference: wanted, id: undefined, applied: 'default', name: '', exact: false, reason: 'unsupported' };
  const target = RANK[wanted];
  const best = levels.reduce((pick, level) => {
    const gap = Math.abs(level.rank - target), held = Math.abs(pick.rank - target);
    return gap < held || (gap === held && level.rank > pick.rank) ? level : pick;
  });
  const exact = best.strength === wanted;
  return { preference: wanted, id: best.id, applied: best.strength, name: best.name, exact, reason: exact ? null : 'nearest' };
}

/** What to tell the learner when the preference could not be met exactly; null when there is nothing to say. */
export function effortNote(choice) {
  if (!choice || choice.exact || choice.preference === 'default') return null;
  return { reason: choice.reason, wanted: STRENGTH_LABEL[choice.preference], used: choice.name || STRENGTH_LABEL.default };
}

/** For APIs that take only low / medium / high (Gemini thinking levels, Groq reasoning effort): the nearest of those. */
export function providerLevel(preference) {
  return ({ lowest: 'low', low: 'low', medium: 'medium', high: 'high', highest: 'high' })[preference];
}

/** The choice for the model a route points at; levels are read from the host once per route and remembered. */
export async function reasoningFor(ctx, route, preference, signal) {
  if (!isEffortPreference(preference) || preference === 'default') return chooseEffort([], 'default');
  const { efforts } = route?.provider && route?.model ? await modelReasoning(ctx, route.provider, route.model, signal) : { efforts: [] };
  return chooseEffort(efforts, preference);
}
