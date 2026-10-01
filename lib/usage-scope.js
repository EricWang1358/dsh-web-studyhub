import { AsyncLocalStorage } from 'node:async_hooks';

/* Where a model call reports its token usage (WP27).

   The model paths (lib/index.js modelCompletion, the generation agent) know
   what a call cost but not who asked; the callers (jobs, features) know who
   asked but not what it cost. The scope joins them without threading another
   argument through every wrapper (localized models, retries, hedged requests):
   a caller runs its model call inside `withUsageSink`, the model path calls
   `reportUsage` when the provider has reported, and every sink in the chain
   hears about it once.

   A sink never gets to break the call that is being measured: it may throw or
   reject, and recording simply does not happen. */

const scope = new AsyncLocalStorage();

/**
 * Run `fn` with `sink` added to the sinks of the surrounding scope.
 * @param entry `{ key, sink(usage, meta) }`; a key already in the chain is not added again,
 *   so a model wrapped twice still counts once.
 * @param options `{ feature }` names what the work is for; the innermost feature wins.
 */
export function withUsageSink(entry, fn, { feature } = {}) {
  const parent = scope.getStore();
  const sinks = parent?.sinks || [];
  const added = entry && typeof entry.sink === 'function' && !sinks.some((item) => item.key === entry.key) ? [...sinks, entry] : sinks;
  return scope.run({ sinks: added, feature: feature ?? parent?.feature }, fn);
}

/**
 * Tell the sinks of the current scope what one model call used.
 * @param usage DSH buckets (see lib/token-usage.js); empty or missing reports are ignored.
 * @param meta `{ calls, task, ... }`; `feature` is added from the scope.
 */
export function reportUsage(usage, meta = {}) {
  const store = scope.getStore();
  if (!store || !usage) return;
  for (const { sink } of store.sinks) {
    try {
      const pending = sink(usage, { ...meta, feature: store.feature });
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch { /* recording usage is never allowed to break the call */ }
  }
}
