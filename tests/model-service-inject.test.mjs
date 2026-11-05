import test from 'node:test';
import assert from 'node:assert/strict';
import { hostOffersModel, assertHostModelRoute, hostService } from '../lib/host-capabilities.js';
import { describesModels, modelEfforts } from '../lib/reasoning-effort.js';

/* A DSH (cordis) context that did not inject `llm`: reading the property throws, as the 即时控制 box showed when the
   learner picked a model (「cannot get property "llm" without inject」); the registry lookup `get('llm')` still answers. */
const unInjected = (llm) => new Proxy({ get: (name) => (name === 'llm' ? llm : undefined) }, {
  get(target, prop) {
    if (prop === 'llm') throw new Error('cannot get property "llm" without inject');
    return Reflect.get(target, prop);
  },
});

const llm = {
  listProviders: () => [{ id: 'tokenrhythm' }],
  resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }),
};
const route = { provider: 'tokenrhythm', model: 'qwen3.8-flash' };

test('the per-task model choice reads the model service from a context that did not inject it', async () => {
  const ctx = unInjected(llm);
  assert.equal(hostService(ctx, 'llm'), llm);
  assert.equal(hostOffersModel(ctx, route), true);
  assert.equal(hostOffersModel(ctx, { ...route, provider: 'elsewhere' }), false);
  assert.doesNotThrow(() => assertHostModelRoute(ctx, route));
  assert.throws(() => assertHostModelRoute(ctx, { ...route, provider: 'elsewhere' }), { code: 'NO_ADAPTER' });
  assert.equal(describesModels(ctx), true);
  assert.deepEqual((await modelEfforts(ctx, route.provider, route.model)).map((item) => item.id), ['low', 'high']);
});

test('a context with no model service at all stays permissive instead of throwing', async () => {
  const ctx = unInjected(undefined);
  assert.equal(hostService(ctx, 'llm'), undefined);
  assert.equal(hostOffersModel(ctx, route), undefined);
  assert.doesNotThrow(() => assertHostModelRoute(ctx, route));
  assert.equal(describesModels(ctx), false);
});
