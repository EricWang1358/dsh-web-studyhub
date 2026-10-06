import { randomUUID } from 'node:crypto';
import { addUsage } from './token-usage.js';
import { withUsageSink } from './usage-scope.js';

/**
 * A model service that already does its own transport work (language and image preparation, light effort, hedging, transient retry:
 * `modelServices(...)` without `recordedModels`) as ONE observed host attempt of a Job's gateway. The Step names the work, the Job's stop
 * signal reaches the request, and the usage the host reports rides back on the Call so the gateway books it once (lib/jobs/gateway.js).
 * `policyFor(options)` is the Step policy of one call; the options go to the model as given, plus the signal.
 */
export function gatewayModel(gateway, { stepKey, policyFor }, model) {
  return async (system, prompt, options = {}) => {
    const step = gateway.step(stepKey, policyFor(options));
    return step.run(() => step.observe({ boundary: 'host-attempt', runner: 'direct' }, async signal => {
      let used = null;
      const sink = { key: `gateway-model:${randomUUID()}`, sink: usage => { used = addUsage(used, usage); } };
      const value = await withUsageSink(sink, () => model(system, prompt, { ...options, signal }));
      const { calls: _calls, ...tokenUsage } = used ?? {};
      return { value, tokenUsage: used ? tokenUsage : null };
    }));
  };
}
