import test from 'node:test';
import assert from 'node:assert/strict';
import { EFFORT_PREFERENCES, chooseEffort, classifyEffort, describeEfforts, effortChoices, effortNote, providerLevel, reasoningFor } from '../lib/model-effort.js';
import { correctionEffort } from '../lib/live-correction-agent.js';

/* WP-AU #220: a preference is a relative strength (lowest / low / medium / high / highest, or the model default) and is mapped
   onto the levels the model really offers: never silently dropped when the model has no level of that name. */

const deepseek = [{ id: 'default', name: 'Default' }, { id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }];
const classic = [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }];

test('the options of a model are its own levels plus the model default', () => {
  assert.deepEqual(effortChoices(deepseek), [{ value: 'default' }, { value: 'lowest', id: 'off', name: 'Off' }, { value: 'low', id: 'low', name: 'Low' },
    { value: 'high', id: 'high', name: 'High' }, { value: 'highest', id: 'max', name: 'Max' }]);
  assert.deepEqual(effortChoices(classic).map(choice => choice.value), ['default', 'low', 'medium', 'high']);
  assert.deepEqual(effortChoices([]), [{ value: 'default' }]);
  assert.equal(describeEfforts(deepseek).hasDefault, true);
  assert.deepEqual(describeEfforts(deepseek).levels.map(level => level.id), ['off', 'low', 'high', 'max'], 'the default entry is not a level to pick');
});

test('"medium" on a model without a medium level maps to a definite level and says so', () => {
  const choice = chooseEffort(deepseek, 'medium');
  assert.equal(choice.id, 'high', 'a tie between Low and High goes to the stronger');
  assert.equal(choice.applied, 'high');
  assert.equal(choice.exact, false);
  assert.equal(choice.reason, 'nearest');
  assert.deepEqual(effortNote(choice), { reason: 'nearest', wanted: '中', used: 'High' });
});

test('exact matches need no note, and the model default sends no level at all', () => {
  for (const [preference, id] of [['lowest', 'off'], ['low', 'low'], ['high', 'high'], ['highest', 'max']]) {
    const choice = chooseEffort(deepseek, preference);
    assert.deepEqual([choice.id, choice.exact, choice.reason], [id, true, null], preference);
    assert.equal(effortNote(choice), null);
  }
  assert.deepEqual(chooseEffort(classic, 'medium'), { preference: 'medium', id: 'medium', applied: 'medium', name: 'Medium', exact: true, reason: null });
  const plain = chooseEffort(deepseek, 'default');
  assert.deepEqual([plain.id, plain.applied, plain.exact], [undefined, 'default', true]);
  assert.equal(chooseEffort(classic, 'nonsense').id, undefined, 'an unknown preference is the default');
});

test('the same preference follows a change of model, and the interface is told when it moved', () => {
  assert.equal(chooseEffort(classic, 'highest').id, 'high');
  assert.equal(chooseEffort(deepseek, 'highest').id, 'max');
  assert.equal(chooseEffort(classic, 'lowest').id, 'low', 'no Off level: the weakest there is');
  assert.equal(chooseEffort([{ id: 'low' }, { id: 'high' }], 'medium').id, 'high');
  assert.equal(chooseEffort([{ id: 'minimal' }, { id: 'low' }, { id: 'medium' }, { id: 'high' }, { id: 'xhigh' }], 'highest').id, 'xhigh');
});

test('a model with no adjustable levels says so instead of pretending', () => {
  const choice = chooseEffort([], 'high');
  assert.deepEqual([choice.id, choice.reason, choice.exact], [undefined, 'unsupported', false]);
  assert.deepEqual(effortNote(choice), { reason: 'unsupported', wanted: '高', used: '模型默认' });
});

test('names nobody recognises are placed by position', () => {
  const levels = describeEfforts([{ id: 'a' }, { id: 'b' }, { id: 'c' }]).levels;
  assert.deepEqual(levels.map(level => level.strength), ['lowest', 'medium', 'highest']);
  assert.equal(classifyEffort({ id: 'weird', name: 'Max' }), 'highest', 'the display name counts too');
  assert.equal(classifyEffort({ id: 'weird' }), null);
});

test('the levels of a route come from the host once, and the options reach correction and audio alike', async () => {
  let lookups = 0;
  const ctx = { llm: { resolveModelInfo: async () => { lookups++; return { reasoning: { efforts: deepseek } }; } } };
  const route = { provider: 'deepseek', model: 'v4.1-flash' };
  const first = await reasoningFor(ctx, route, 'medium'), second = await reasoningFor(ctx, route, 'low');
  assert.deepEqual([first.id, second.id], ['high', 'low']);
  assert.equal(lookups, 1);
  assert.equal(await correctionEffort(ctx, route, 'highest'), 'max');
  assert.equal(await correctionEffort(ctx, route, 'default'), undefined);
  assert.equal(await correctionEffort({ llm: {} }, { provider: 'x', model: 'y' }, 'high'), undefined);
  assert.equal((await reasoningFor(ctx, null, 'high')).reason, 'unsupported');
});

test('Gemini and Groq take only low, medium or high', () => {
  assert.deepEqual(EFFORT_PREFERENCES.map(providerLevel), [undefined, 'low', 'low', 'medium', 'high', 'high']);
});
