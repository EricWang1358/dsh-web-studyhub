// REVIEW-ONLY schema and synthetic inputs. No admission, queue, retry or production adapter.
import Schema from 'schemastery';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const ref = () => Schema.string().pattern(/^[a-zA-Z0-9_-]{1,128}$/).required();
const choice = values => Schema.union(values.map(value => Schema.const(value))).required();
const count = () => Schema.number().min(1).step(1).required();
const Binding = Schema.object({
  resourceRef: ref(), counterOwnerRef: ref(), scopeRef: ref(),
  kind: choice(['transcription-slot', 'text-window', 'provider-request']),
  scopeKind: choice(['host', 'recording', 'batch', 'quota-domain']),
  unit: choice(['transcription', 'window', 'physical-request']), limit: count(),
}).required();
const Proposal = Schema.object({
  resourceContractVersion: Schema.const(1).required(),
  audioPilot: Schema.boolean().required(), sharedProviderQuota: Schema.boolean().required(),
  enforcementScope: Schema.const('host-process').required(),
  providerObservation: choice(['none', 'external-request', 'host-attempt']),
  quotaDomainRef: Schema.union([Schema.const(null), ref()]),
  resolution: choice(['baseline-instance', 'explicit-trusted-binding']),
  queueTimeoutMs: Schema.union([Schema.const(null), Schema.number().min(0)]),
  bindings: Schema.array(Binding).required(),
});
const rootKeys = new Set(['resourceContractVersion', 'audioPilot', 'sharedProviderQuota', 'enforcementScope', 'providerObservation', 'quotaDomainRef', 'resolution', 'queueTimeoutMs', 'bindings']);
const bindingKeys = new Set(['resourceRef', 'counterOwnerRef', 'scopeRef', 'kind', 'scopeKind', 'unit', 'limit']);

/** Validate review data only. String refs describe trusted resolutions; they grant no authority. */
export function validateResourceProposal(input) {
  if (input?.resourceContractVersion !== 1) fail('resource-contract-version');
  if (Object.keys(input).some(key => !rootKeys.has(key))) fail('unknown-resource-field');
  if ([...rootKeys].some(key => !Object.hasOwn(input, key))) fail('invalid-resource-contract');
  if (Array.isArray(input.bindings) && input.bindings.some(binding => binding && Object.keys(binding).some(key => !bindingKeys.has(key)))) fail('unknown-resource-field');
  let value;
  try { value = Proposal(structuredClone(input)); } catch { fail('invalid-resource-contract'); }
  if (value.queueTimeoutMs !== null && !Number.isFinite(value.queueTimeoutMs)) fail('invalid-resource-contract');
  if (!value.bindings.length || value.bindings.some(binding => !Number.isFinite(binding.limit))) fail('invalid-resource-contract');
  if (value.sharedProviderQuota !== (value.quotaDomainRef !== null)) fail('policy-domain-mismatch');
  if (value.resolution !== (value.sharedProviderQuota ? 'explicit-trusted-binding' : 'baseline-instance')) fail('policy-domain-mismatch');
  const refs = new Set(), domains = new Set(); let hasProvider = false;
  for (const binding of value.bindings) {
    if (refs.has(binding.resourceRef)) fail('duplicate-resource'); refs.add(binding.resourceRef);
    const domain = `${binding.kind}:${binding.scopeKind}:${binding.scopeRef}`;
    if (domains.has(domain)) fail('duplicate-resource-domain'); domains.add(domain);
    const scopes = { 'transcription-slot': ['host'], 'text-window': ['recording', 'batch'], 'provider-request': ['quota-domain'] };
    const units = { 'transcription-slot': 'transcription', 'text-window': 'window', 'provider-request': 'physical-request' };
    if (!scopes[binding.kind].includes(binding.scopeKind)) fail('resource-scope-mismatch');
    if (binding.unit !== units[binding.kind]) fail('resource-unit-mismatch');
    if (binding.kind === 'provider-request') {
      hasProvider = true;
      if (!value.sharedProviderQuota || binding.scopeRef !== value.quotaDomainRef) fail('resource-domain-mismatch');
    }
  }
  if (hasProvider !== value.sharedProviderQuota) fail('policy-domain-mismatch');
  if (value.providerObservation !== (hasProvider ? 'external-request' : 'none')) fail('provider-boundary-unobservable');
  if (hasProvider && value.queueTimeoutMs === null) fail('provider-wait-unbounded');
  return value;
}

export const resourceProposals = {
  baseline: {
    resourceContractVersion: 1, audioPilot: false, sharedProviderQuota: false,
    enforcementScope: 'host-process', providerObservation: 'none',
    quotaDomainRef: null, resolution: 'baseline-instance', queueTimeoutMs: null,
    bindings: [
      { resourceRef: 'host-transcribe', counterOwnerRef: 'host-gate', scopeRef: 'host-1', kind: 'transcription-slot', scopeKind: 'host', unit: 'transcription', limit: 1 },
      { resourceRef: 'recording-text', counterOwnerRef: 'recording-pool', scopeRef: 'recording-1', kind: 'text-window', scopeKind: 'recording', unit: 'window', limit: 3 },
    ],
  },
  shared: {
    resourceContractVersion: 1, audioPilot: true, sharedProviderQuota: true,
    enforcementScope: 'host-process', providerObservation: 'external-request',
    quotaDomainRef: 'quota-1', resolution: 'explicit-trusted-binding', queueTimeoutMs: 1000,
    bindings: [
      { resourceRef: 'provider-requests', counterOwnerRef: 'verified-owner-1', scopeRef: 'quota-1', kind: 'provider-request', scopeKind: 'quota-domain', unit: 'physical-request', limit: 2 },
      { resourceRef: 'batch-text', counterOwnerRef: 'batch-pool', scopeRef: 'batch-1', kind: 'text-window', scopeKind: 'batch', unit: 'window', limit: 3 },
    ],
  },
};
