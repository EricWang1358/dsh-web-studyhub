import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptedEfforts, replacementEffort } from '../lib/effort-rejection.js';

// 2.6.1: 帮我想想 failed with 400 `Invalid option: expected one of "off"|"low"|…` on a model that declares `minimal` (Muse Spark).
const MESSAGE = '400: {"message":"Invalid option: expected one of \\"off\\"|\\"low\\"|\\"medium\\"|\\"high\\"|\\"xhigh\\"|\\"max\\"","type":"invalid_request_error","param":"reasoning_effort"}';

test('the accepted values are read from a refused reasoning_effort, and from nothing else', () => {
  assert.deepEqual(acceptedEfforts(MESSAGE), ['off', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(acceptedEfforts('Invalid option: expected one of "off"|"low" param reasoning_effort'), ['off', 'low']);
  assert.equal(acceptedEfforts('Invalid option: expected one of "a"|"b" param: temperature'), null);
  assert.equal(acceptedEfforts('Too many requests'), null);
  assert.equal(acceptedEfforts(undefined), null);
});

test('the replacement is the nearest accepted level the model offers; none when nothing fits', () => {
  const accepted = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];
  assert.equal(replacementEffort('minimal', accepted, ['minimal', 'low', 'medium', 'high', 'xhigh']), 'low');
  assert.equal(replacementEffort('minimal', accepted, ['off', 'minimal', 'low']), 'off', 'off is the same strength as minimal');
  assert.equal(replacementEffort('minimal', accepted, ['minimal']), undefined, 'the only level offered is the refused one');
  assert.equal(replacementEffort('mystery', accepted, ['low']), undefined);
  assert.equal(replacementEffort('minimal', accepted, []), undefined);
});

test('a light call refused for its level is asked again once with an accepted one, and the choice is remembered', async (t) => {
  let plugin;
  try { plugin = await import('../lib/index.js'); } catch (e) {
    if (e.code === 'ERR_MODULE_NOT_FOUND' && e.message.includes('@deepseek-ai')) return t.skip('Host SDK absent');
    throw e;
  }
  const sent = [];
  const levels = ['minimal', 'low', 'medium', 'high', 'xhigh'].map((id) => ({ id, name: id }));
  const ctx = { llm: {
    resolveModelInfo: async () => ({ reasoning: { efforts: levels } }),
    resolveCallConfig: async (config) => config,
    stream: async function* (call) {
      sent.push(call.reasoningEffort);
      if (call.reasoningEffort === 'minimal') {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: MESSAGE, code: 'INVALID_REQUEST', status: 400 } } };
        return;
      }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: '{"ok":true}' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"ok":true}' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  } };
  const light = plugin.modelCompletion(ctx, () => ({ provider: 'p', model: 'muse-refusal' }), 's', { light: true, hedgeMs: 1000 });
  assert.equal(await light('sys', 'ask'), '{"ok":true}');
  assert.deepEqual(sent, ['minimal', 'low'], 'refused once, then the nearest accepted level');
  assert.equal(await light('sys', 'ask again'), '{"ok":true}');
  assert.deepEqual(sent, ['minimal', 'low', 'low'], 'the next call goes straight to the level that worked');
});
