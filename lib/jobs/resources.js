import { createPool } from './scheduler.js';

const adapters = new WeakMap();
const opaque = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const error = code => Object.assign(new Error(code), { code, resourceAdmission: true });
/** Only genuine scoped ports expose the internal provider adapter; strings grant no authority. */
export const providerResourcesFor = resources => {
  if (resources !== undefined && !adapters.has(resources)) throw error('resource-unbound');
  return adapters.get(resources);
};

/** Host-owned provider resources. This registry contains resources and leases, never Jobs.
 * Configuration is trusted host input; no request arguments can register/replace a binding.
 * Only the externally observable HTTP audio adapter is supported in this first version. */
export function createProviderResources({ owner, scopeId, sharedProviderQuota = false, queueTimeoutMs = 30_000, bindings = [] } = {}) {
  if (owner === undefined || typeof scopeId !== 'string' || !scopeId) throw error('resource-unbound');
  if (typeof sharedProviderQuota !== 'boolean') throw error('capability-unverified');
  if (!Number.isFinite(queueTimeoutMs) || queueTimeoutMs < 0) throw error('queue-timeout-invalid');
  const resources = new Map(), domains = new Map(), routes = new Map(), leases = new Set();
  let enabled = sharedProviderQuota, closing = false, disposed = false, transition;
  for (const binding of bindings) {
    if (!opaque(binding.quotaDomainRef)) throw error('quota-domain-unresolved');
    if (binding.providerObservation !== 'external-request') throw error('capability-unverified');
    if (!Number.isSafeInteger(binding.limit) || binding.limit < 1) throw error('resource-limit-invalid');
    if (!opaque(binding.resourceRef) || resources.has(binding.resourceRef) || !Array.isArray(binding.routes) || !binding.routes.length) throw error('resource-unbound');
    let entry = domains.get(binding.quotaDomainRef);
    if (entry) throw error('resource-owner-conflict');
    if (!entry) {
      entry = { limit: binding.limit, pool: createPool({ mode: 'permit', limit: binding.limit }) };
      domains.set(binding.quotaDomainRef, entry);
    }
    resources.set(binding.resourceRef, entry);
    for (const route of binding.routes) {
      if (!opaque(route) || routes.has(route)) throw error('resource-unbound');
      routes.set(route, binding.resourceRef);
    }
  }
  if (enabled && !routes.size) throw error('quota-domain-unresolved');
  const open = signal => {
    if (closing || disposed) throw error('scope-unloaded');
    const controller = new AbortController(), stop = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const settled = Promise.withResolvers(), pending = new Set(), active = enabled;
    let finished = false, finishing;
    const assertLive = (cleanup = false) => { if (finished) throw error('scope-unloaded'); if (!cleanup) stop.throwIfAborted(); };
    const run = async (ref, operation, options = {}, cleanup = false) => {
      assertLive(cleanup);
      const resource = active && resources.get(ref);
      if (!resource) throw error('resource-unbound');
      const executionSignal = cleanup ? options.signal : options.signal ? AbortSignal.any([stop, options.signal]) : stop;
      const execution = resource.pool.run(() => operation(executionSignal), { signal: executionSignal, queueTimeoutMs: options.queueTimeoutMs });
      pending.add(execution);
      try { return await execution; } finally { pending.delete(execution); }
    };
    const port = Object.freeze({ run: (ref, operation, options) => run(ref, operation, options) });
    adapters.set(port, null);
    if (active) adapters.set(port, Object.freeze({
      assertRoute(route, cleanup = false) { assertLive(cleanup); if (!routes.has(route)) throw error('resource-unbound'); },
      run(route, operation, signal, cleanup = false) { return run(routes.get(route), operation, { signal, queueTimeoutMs }, cleanup); },
      cooldown(route, ms) {
        // A request admitted before revocation may still report its final response.
        const ref = routes.get(route); if (!ref) throw error('resource-unbound');
        resources.get(ref).pool.cooldown(ms);
      },
    }));
    const lease = Object.freeze({ enabled: active, resources: port,
      finish() {
        if (!finishing) {
          finished = true;
          finishing = Promise.allSettled([...pending]).then(() => { leases.delete(record); settled.resolve(); });
        }
        return finishing;
      },
    });
    const record = { controller, done: settled.promise };
    leases.add(record);
    return lease;
  };
  const close = permanent => {
    if (permanent) disposed = true;
    if (disposed) for (const lease of leases) lease.controller.abort(error('scope-unloaded'));
    if (!transition) {
      closing = true;
      // Stop new Attempts first. Admitted Attempts keep their fixed binding through
      // their cleanup; only then can baseline callers bypass the old domain policy.
      transition = Promise.all([...leases].map(lease => lease.done))
        .then(() => Promise.all([...domains.values()].map(entry => entry.pool.closeAndDrain())))
        .then(() => { enabled = false; closing = false; transition = undefined; });
    }
    return transition;
  };
  const scoped = (requestOwner, domain) => {
    if (requestOwner !== owner || domain !== scopeId) throw error('resource-unbound');
    return Object.freeze({ open, get enabled() { return enabled; } });
  };
  return Object.freeze({
    get enabled() { return enabled; },
    scoped,
    forDomain: (requestOwner, domain) => domain === scopeId ? scoped(requestOwner, domain) : undefined,
    setLimit(quotaDomainRef, limit) {
      const resource = domains.get(quotaDomainRef); if (!resource) throw error('resource-unbound');
      resource.pool.setLimit(limit); resource.limit = limit;
    },
    disable: () => close(false), dispose: () => close(true),
  });
}
