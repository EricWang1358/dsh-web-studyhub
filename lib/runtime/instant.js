import { modelServices } from './models.js';
import { recordedModels } from '../model-usage.js';
import { providerResourcesFor } from '../jobs/resources.js';
import { isRateLimit } from '../rate-limit.js';

/** The resource and route instant text requests take their quota lease on. The config's `runtime.resources.bindings` decides which quota domain and limit it is (a binding
 * with `resourceRef: 'instant-text'` and the route `instant-text`); with no such binding instant requests are not limited, whatever audio is bound to. */
export const INSTANT_ROUTE = 'instant-text';
/** After a rate-limit answer the shared pool admits nothing new for this long. */
export const INSTANT_COOLDOWN_MS = 5000;
const PROVIDER_DOMAIN = 'audio.v1';
/** Waiting for the lease shorter than this is the scheduler's own turn, not a wait the learner could notice: it is not counted. */
export const INSTANT_NOTICEABLE_MS = 50;

/** The model requests answered while the learner waits: no Job, no card, one answer. Exactly these (and every `oral.*`) take the lease; everything else that is handed a
 * model (a Job's executor, a background request) keeps the ledger-only path it always had. The S6-0 inventory lists the same names. */
export const INSTANT_ACTIONS = Object.freeze([
  'capture', 'ingest', 'card.grade', 'card.translate', 'card.followup', 'card.followup.suggest', 'focus.suggest', 'teach.start', 'teach.answer',
  'coach.nudge', 'coach.reply', 'coach.feedback', 'coach.rewrite.retry', 'generate.suggest', 'generate.path.suggest', 'case.drills', 'source.organize.suggest',
  'deck.merge.suggest', 'draft.import.propose', 'draft.publish.review', 'materials.selection.ask', 'materials.outline.suggest', 'materials.translation.translate',
]);
const isInstant = action => INSTANT_ACTIONS.includes(action) || (typeof action === 'string' && action.startsWith('oral.'));

/**
 * The one entry through which a request's model is made: `models(services, { ledger, feature, action })` is the model services of that request with the usage booked once in
 * the library's ledger (as `recordedModels` always did) and, for an instant request under a shared provider quota, every call made inside the quota lease of
 * INSTANT_ROUTE. With the shared quota off this is exactly `recordedModels(modelServices(services), ledger, feature)`: same functions, same ledger rows.
 * `stats()` is what the usage panel may show: counted in memory only, it starts again from zero with the process and is never written anywhere.
 */
export function createInstant() {
  const counters = { calls: 0, waitedCalls: 0, waitedMs: 0, cooldowns: 0 };
  const now = () => performance.now();

  const leased = (model, resources) => typeof model !== 'function' ? model : Object.assign(async (system, prompt, ...rest) => {
    let lease;
    try { lease = resources.open(rest[0]?.signal); } catch { return model(system, prompt, ...rest); }
    try {
      const adapter = providerResourcesFor(lease.resources);
      try { adapter?.assertRoute(INSTANT_ROUTE); } catch { return await model(system, prompt, ...rest); }
      if (!adapter) return await model(system, prompt, ...rest);
      const asked = now();
      return await adapter.run(INSTANT_ROUTE, async signal => {
        const waited = now() - asked;
        counters.calls += 1;
        if (waited >= INSTANT_NOTICEABLE_MS) { counters.waitedCalls += 1; counters.waitedMs += Math.round(waited); }
        const [options, ...others] = rest;
        try { return await model(system, prompt, options && typeof options === 'object' ? { ...options, signal } : options, ...others); }
        catch (error) {
          if (isRateLimit(error)) { counters.cooldowns += 1; try { adapter.cooldown(INSTANT_ROUTE, INSTANT_COOLDOWN_MS); } catch { /* the pool is closing */ } }
          throw error;
        }
      }, rest[0]?.signal);
    } finally { await lease.finish(); }
  }, model);

  return Object.freeze({
    models(services, { ledger, feature, action, workOwner = services.workOwner }) {
      const recorded = recordedModels(modelServices(services), ledger, feature);
      const resources = services.providerResources?.enabled && isInstant(action) ? services.providerResources.scoped(workOwner, PROVIDER_DOMAIN) : null;
      return resources ? { ...recorded, complete: leased(recorded.complete, resources), light: leased(recorded.light, resources) } : recorded;
    },
    stats: () => ({ ...counters }),
  });
}
