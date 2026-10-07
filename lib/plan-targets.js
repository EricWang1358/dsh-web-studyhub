/* The knowledge points a question run planned, as the job carries them for the 任务 console's 「目标与知识点」 (docs/job-contract.md detail.targets). Pure, bounded.

   The planning stage already asks the model for them (lib/generation.js planAssessment: a target has an objective and the passages it quotes) and lib/plan-record.js keeps them on the
   DRAFT when the run saves; this module is the compact copy the JOB keeps from the moment the plan returns, so a running task can list what it set out to do. No model call, no extra tokens.

   record = { list: [{ part, round?, id, objective, source?: { sourceId, title?, page? }, at?, state, reason? }], short?: [{ part, round?, needed, got }], more?: n }
   `part` is the number of the batch inside its round (a coverage run numbers the parts of each round from 1, `round` says which). `state` is what the record can say: 'planned' (nothing
   decided yet; whether it is being written or reviewed is the calls' to say), 'kept' (a question of it was kept), 'failed' (its part kept nothing) or 'omitted' (the review dropped it);
   `reason` is a code of lib/generation-failure.js. `at` is the offset of the quote in its source (where the reader opens). `short` is a part the plan could not fill. `more` counts the points
   past the bound that are not listed. A job that predates the record has none: the reader returns null. */

export const PLAN_TARGET_LIMITS = Object.freeze({ targets: 300, objective: 120, title: 60, id: 40, short: 80 });
const STATES = new Set(['planned', 'kept', 'failed', 'omitted']);

export const clip = (value, size) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > size ? `${text.slice(0, size - 1).trimEnd()}…` : text; };
const whole = (value) => Number.isInteger(value) && value >= 0;

/** One listed point made safe and clipped; null for what is not a point. */
function readEntry(item, round) {
  if (!item || typeof item.id !== 'string' || !item.id || !whole(item.part) || item.part < 1 || typeof item.objective !== 'string') return null;
  const source = item.source && typeof item.source.sourceId === 'string' && item.source.sourceId ? item.source : null, title = source ? clip(source.title, PLAN_TARGET_LIMITS.title) : '';
  const at = whole(item.at) ? item.at : null, reason = typeof item.reason === 'string' && item.reason ? clip(item.reason, PLAN_TARGET_LIMITS.id) : '', r = whole(round) ? round : whole(item.round) ? item.round : null;
  return { part: item.part, ...(r !== null ? { round: r } : {}), id: clip(item.id, PLAN_TARGET_LIMITS.id), objective: clip(item.objective, PLAN_TARGET_LIMITS.objective),
    ...(source ? { source: { sourceId: clip(source.sourceId, PLAN_TARGET_LIMITS.id), ...(title ? { title } : {}), ...(Number.isInteger(source.page) && source.page > 0 ? { page: source.page } : {}) } } : {}),
    ...(at !== null ? { at } : {}), state: STATES.has(item.state) ? item.state : 'planned', ...(reason ? { reason } : {}) };
}

const readShort = (item, round) => (whole(item?.part) && item.part >= 1 && whole(item.needed) && whole(item.got)
  ? { part: item.part, ...(whole(round) ? { round } : whole(item.round) ? { round: item.round } : {}), needed: item.needed, got: item.got } : null);

/** What a job record carries, made safe to read (the contract's detail.targets): null when it lists nothing, so a job that predates it shows only its goal. */
export function readPlanTargets(value) {
  if (!value || !Array.isArray(value.list)) return null;
  const all = value.list.map((item) => readEntry(item)).filter(Boolean), list = all.slice(0, PLAN_TARGET_LIMITS.targets);
  const short = (Array.isArray(value.short) ? value.short : []).map((item) => readShort(item)).filter(Boolean).slice(0, PLAN_TARGET_LIMITS.short);
  if (!list.length && !short.length) return null;
  const more = (whole(value.more) ? value.more : 0) + all.length - list.length;
  return { list, ...(short.length ? { short } : {}), ...(more ? { more } : {}) };
}

/**
 * The record of a job after a run (one round of a coverage run, or the whole of a plain run) announced `fresh`: the entries of the other rounds stay as they were, the entries of this round are
 * replaced; at most PLAN_TARGET_LIMITS.targets points are kept and the rest is counted in `more`.
 */
export function mergePlanTargets(before, round, fresh) {
  const keep = (before?.list || []).filter((item) => (item.round ?? null) !== (whole(round) ? round : null));
  const own = (fresh?.list || []).map((item) => readEntry(item, round)).filter(Boolean);
  const all = [...keep, ...own], list = all.slice(0, PLAN_TARGET_LIMITS.targets);
  const short = [...(before?.short || []).filter((item) => (item.round ?? null) !== (whole(round) ? round : null)), ...(fresh?.short || []).map((item) => readShort(item, round)).filter(Boolean)];
  const more = all.length - list.length;
  return { list, ...(short.length ? { short } : {}), ...(more > 0 ? { more } : {}) };
}
