/* Reasoning effort for question generation (WP16).
   DSH reports the levels a model offers (`ctx.llm.resolveModelInfo`). The
   learner may prefer one for generation; it rides on the resolved route as an
   invisible marker (a symbol: it never serialises and never reaches a child
   agent) and is applied only when the model in effect offers that exact id.
   Everything else (陪学, audio, live correction) keeps its own effort rules. */

export const EFFORT_PREFERENCE = Symbol.for('studyhub.effortPreference');
const MAX_PREFERENCE = 64;
const LOOKUP_MS = 1500, TTL_MS = 60000, FAILURE_TTL_MS = 5000;
const caches = new WeakMap();

/** A saved preference is a short id; anything else counts as "follow". */
export function cleanEffortPreference(value) {
  if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
  return typeof value === 'string' ? value.trim().slice(0, MAX_PREFERENCE) : '';
}

/** The route with the learner's preference attached, or the route itself when there is none. */
export function withEffortPreference(route, preference) {
  const wanted = cleanEffortPreference(preference);
  return route && wanted ? { ...route, [EFFORT_PREFERENCE]: wanted } : route;
}
export const preferenceOf = (route) => (route && route[EFFORT_PREFERENCE]) || '';

function llmOf(ctx) {
  let llm;
  try { llm = ctx?.get?.('llm'); } catch { llm = undefined; }
  return llm ?? ctx?.llm;
}

const normalise = (efforts) => (Array.isArray(efforts) ? efforts : []).flatMap((item) => {
  const id = item && typeof item === 'object' && item.id !== undefined && item.id !== null ? String(item.id) : '';
  if (!id) return [];
  const name = typeof item.name === 'string' && item.name.trim() ? item.name : id;
  return [{ id, name }];
});

/**
 * The levels `provider`/`model` offers, lowest first as DSH lists them.
 * A failing, slow or absent catalogue is an empty list, never an error, and a
 * lookup is remembered so a polling panel never waits on it twice.
 * @returns {Promise<{id: string, name: string}[]>}
 */
export async function modelEfforts(ctx, provider, model, signal, { timeoutMs = LOOKUP_MS } = {}) {
  const llm = llmOf(ctx);
  if (!provider || !model || typeof llm?.resolveModelInfo !== 'function' || signal?.aborted) return [];
  let cache = caches.get(llm);
  if (!cache) caches.set(llm, cache = new Map());
  const key = `${provider}\0${model}`;
  let entry = cache.get(key);
  if (!entry || Date.now() - entry.at > (entry.failed ? FAILURE_TTL_MS : TTL_MS)) {
    entry = { at: Date.now(), failed: false };
    const guard = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { guard.abort(); reject(new Error('model info timed out')); }, timeoutMs);
    });
    entry.efforts = Promise.race([Promise.resolve().then(() => llm.resolveModelInfo(provider, model, guard.signal)), timeout])
      .then((info) => normalise(info?.reasoning?.efforts), () => { entry.failed = true; return []; })
      .finally(() => clearTimeout(timer));
    cache.set(key, entry);
  }
  return entry.efforts;
}

/**
 * The route a generation call should use: the learner's preference replaces
 * the route's own level when the model offers it, otherwise the route is kept.
 * The result is a plain `{provider, model, reasoningEffort?}` object.
 */
export async function effortRoute(ctx, route, signal) {
  const wanted = preferenceOf(route);
  if (!route || !wanted) return route;
  const { provider, model, reasoningEffort } = route;
  const offered = (await modelEfforts(ctx, provider, model, signal)).some((item) => item.id === wanted);
  const level = offered ? wanted : reasoningEffort;
  return { provider, model, ...(level === undefined ? {} : { reasoningEffort: level }) };
}

/**
 * What Settings needs: the levels on offer, the one in effect and where it
 * comes from ('binding' preference, followed 'session', or the model 'default').
 * `stale` marks a saved preference the current model does not offer.
 */
export async function effortState(ctx, route, preference) {
  const wanted = cleanEffortPreference(preference);
  const options = route ? await modelEfforts(ctx, route.provider, route.model) : [];
  const applied = !!wanted && options.some((item) => item.id === wanted);
  const own = options.length && route?.reasoningEffort !== undefined ? String(route.reasoningEffort) : '';
  return {
    options,
    current: applied ? wanted : own,
    source: applied ? 'binding' : own ? 'session' : 'default',
    applied,
    ...(wanted && !applied ? { stale: true } : {}),
  };
}

/** Attach `effort` to a binding value; a catalogue problem never fails the binding. */
export async function withEffortState(ctx, value) {
  try { value.effort = await effortState(ctx, value.route, value.reasoningEffort); }
  catch { value.effort = { options: [], current: '', source: 'default', applied: false }; }
  return value;
}
