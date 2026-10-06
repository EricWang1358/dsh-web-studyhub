import test from 'node:test';
import assert from 'node:assert/strict';
import { validateResourceProposal, resourceProposals } from './fixtures/unified-runtime-resources.mjs';

test('S1-3 proposed resource contract preserves explicit identities without fabricating observations', () => {
  for (const fixture of Object.values(resourceProposals)) {
    const input = structuredClone(fixture), before = structuredClone(input);
    assert.deepEqual(validateResourceProposal(input), before);
    assert.deepEqual(input, before);
  }
});

test('S1-3 pilot admission and shared provider policy are independent', () => {
  const input = structuredClone(resourceProposals.baseline);
  input.audioPilot = true;
  assert.equal(validateResourceProposal(input).sharedProviderQuota, false);
  assert.equal(input.quotaDomainRef, null);
});

const reject = (name, update, code) => {
  const input = structuredClone(resourceProposals[name]); update(input);
  assert.throws(() => validateResourceProposal(input), { code });
};

test('S1-3 unknown contracts, implicit defaults and guessed quota scopes are refused', () => {
  reject('baseline', x => { x.resourceContractVersion = 2; }, 'resource-contract-version');
  reject('baseline', x => { delete x.sharedProviderQuota; }, 'invalid-resource-contract');
  reject('baseline', x => { x.quotaDomainRef = 'model-name'; }, 'policy-domain-mismatch');
  reject('shared', x => { x.quotaDomainRef = null; }, 'policy-domain-mismatch');
  reject('shared', x => { x.resolution = 'inferred-model'; }, 'invalid-resource-contract');
  reject('shared', x => { x.bindings[0].scopeKind = 'recording'; }, 'resource-scope-mismatch');
});

test('S1-3 a recording window cannot masquerade as a physical provider request permit', () => {
  reject('shared', x => { x.bindings[0].unit = 'window'; }, 'resource-unit-mismatch');
  reject('shared', x => { x.bindings[0].scopeRef = 'different-domain'; }, 'resource-domain-mismatch');
  reject('shared', x => { x.bindings[0].counterOwnerRef = ''; }, 'invalid-resource-contract');
  reject('baseline', x => { x.bindings[0].scopeKind = 'quota-domain'; }, 'resource-scope-mismatch');
});

test('S1-3 duplicate resource identities and unbounded new provider waiting are refused', () => {
  reject('shared', x => { x.bindings.push(structuredClone(x.bindings[0])); }, 'duplicate-resource');
  reject('shared', x => { x.bindings.push({ ...x.bindings[0], resourceRef: 'another-name', counterOwnerRef: 'another-counter' }); }, 'duplicate-resource-domain');
  reject('shared', x => { x.queueTimeoutMs = null; }, 'provider-wait-unbounded');
  for (const bad of [-1, Infinity, NaN, '10']) reject('shared', x => { x.queueTimeoutMs = bad; }, 'invalid-resource-contract');
  for (const bad of [0, 1.5, Infinity]) reject('shared', x => { x.bindings[0].limit = bad; }, 'invalid-resource-contract');
});

test('S1-3 unsupported and unknown inputs cannot silently select a new strategy', () => {
  reject('baseline', x => { x.autoRetry = true; }, 'unknown-resource-field');
  reject('baseline', x => { x.observerWaitMs = 100; }, 'unknown-resource-field');
  reject('shared', x => { x.bindings[0].apiKey = 'synthetic-do-not-store'; }, 'unknown-resource-field');
  reject('shared', x => { x.bindings[0].kind = 'gpu'; }, 'invalid-resource-contract');
  reject('shared', x => { x.bindings[0].scopeRef = 'https://provider.invalid/account'; }, 'invalid-resource-contract');
});
