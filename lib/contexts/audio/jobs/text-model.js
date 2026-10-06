import { gatewayCalls } from '../../../audio-gateway-calls.js';
import { tiersFromSettings } from '../../../gemini.js';

/**
 * The text model of a text-only audio job on the runtime (a subtitle file, a review): the host's or Gemini's, every request a step of the gateway.
 * `tiers` carries what Gemini was asked (its tally and warnings); `finish(view)` puts that on the card once the work is over.
 */
export function textJobModel(context, { worker, work }, { view, settings, paidOnly }) {
  const tiers = tiersFromSettings(settings, { fetch: worker.fetch, skipFree: paidOnly === true, gateway: context.gateway });
  const calls = gatewayCalls({ gateway: context.gateway, settings, job: view, outputs: work.jobOutputs, tiers });
  return { complete: calls.text, tiers, finish() {
    const usage = tiers.summary();
    Object.assign(view, { usage, usageRun: usage });
    for (const text of tiers.warnings) if (!view.warnings.includes(text)) view.warnings.push(text);
    return usage;
  } };
}
