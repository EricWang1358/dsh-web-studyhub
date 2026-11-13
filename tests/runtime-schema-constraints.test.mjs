import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyRuntime } from '../lib/runtime.js';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { materialsSchemas } from '../lib/contexts/materials/contracts.js';
import { SCHEMA_KEYWORDS, validate } from '../lib/runtime/schema.js';

/* #842: a constraint a schema declares is enforced (minimum, maximum, minItems, maxItems, minLength, maxLength), and a keyword the validator cannot
   enforce is refused when the context registers, never silently ignored. */

async function runtimeWith(t, input, output) {
  const root = await mkdtemp(join(tmpdir(), 'study-schema-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const runtime = new StudyRuntime(root);
  runtime.register({ id: 'probe', version: 1, operations: { run: { input, output, execute: args => (args.result !== undefined ? args.result : { ok: true }) } } });
  return runtime;
}
const call = (runtime, args) => runtime.invoke('probe.v1', 'run', args);
const wrap = properties => ({ type: 'object', properties, additionalProperties: true });

test('minimum and maximum are enforced for numbers and integers, the bounds themselves are allowed', async t => {
  const runtime = await runtimeWith(t, wrap({ count: { type: 'integer', minimum: 0, maximum: 10 }, ratio: { type: 'number', minimum: 0.5 } }));
  for (const ok of [{ count: 0 }, { count: 10 }, { count: 5, ratio: 0.5 }]) assert.deepEqual(await call(runtime, ok), { ok: true });
  await assert.rejects(call(runtime, { count: -1 }), /arguments\.count must be at least 0/);
  await assert.rejects(call(runtime, { count: 11 }), /arguments\.count must be at most 10/);
  await assert.rejects(call(runtime, { ratio: 0.4 }), /arguments\.ratio must be at least 0\.5/);
});

test('minItems and maxItems are enforced, and the items of a long enough array are still checked', async t => {
  const runtime = await runtimeWith(t, wrap({ list: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string' } } }));
  assert.deepEqual(await call(runtime, { list: ['a'] }), { ok: true });
  assert.deepEqual(await call(runtime, { list: ['a', 'b', 'c'] }), { ok: true });
  await assert.rejects(call(runtime, { list: [] }), /arguments\.list must have at least 1 item/);
  await assert.rejects(call(runtime, { list: ['a', 'b', 'c', 'd'] }), /arguments\.list must have at most 3 items/);
  await assert.rejects(call(runtime, { list: ['a', 2] }), /arguments\.list\[1\] must be string/);
});

test('minLength and maxLength count characters, not UTF-16 units', async t => {
  const runtime = await runtimeWith(t, wrap({ word: { type: 'string', minLength: 2, maxLength: 3 } }));
  assert.deepEqual(await call(runtime, { word: 'ab' }), { ok: true });
  assert.deepEqual(await call(runtime, { word: '😀😀😀' }), { ok: true });
  await assert.rejects(call(runtime, { word: 'a' }), /arguments\.word must have at least 2 characters/);
  await assert.rejects(call(runtime, { word: 'abcd' }), /arguments\.word must have at most 3 characters/);
  await assert.rejects(call(runtime, { word: '😀😀😀😀' }), /at most 3 characters/);
});

test('a constraint applies only to a value of its own kind: a minimum says nothing of a string', () => {
  assert.doesNotThrow(() => validate('abc', { minimum: 5 }));
  assert.doesNotThrow(() => validate(7, { minLength: 5, minItems: 5 }));
  assert.throws(() => validate('abc', { type: 'number', minimum: 5 }), /must be number/);
});

test('constraints inside nested objects, items and oneOf options are enforced', async t => {
  const runtime = await runtimeWith(t, { type: 'object', properties: {
    deep: wrap({ n: { type: 'integer', minimum: 1 } }),
    rows: { type: 'array', items: wrap({ n: { type: 'integer', maximum: 2 } }) },
    either: { oneOf: [{ type: 'integer', minimum: 10 }, { type: 'null' }] },
  } });
  assert.deepEqual(await call(runtime, { deep: { n: 1 }, rows: [{ n: 2 }], either: 10 }), { ok: true });
  assert.deepEqual(await call(runtime, { either: null }), { ok: true });
  await assert.rejects(call(runtime, { deep: { n: 0 } }), /arguments\.deep\.n must be at least 1/);
  await assert.rejects(call(runtime, { rows: [{ n: 1 }, { n: 3 }] }), /arguments\.rows\[1\]\.n must be at most 2/);
  await assert.rejects(call(runtime, { either: 9 }), /either does not match exactly one schema/);
});

test('the declared output is held to its constraints too', async t => {
  const runtime = await runtimeWith(t, undefined, wrap({ total: { type: 'integer', minimum: 0 } }));
  assert.deepEqual(await call(runtime, { result: { total: 0 } }), { total: 0 });
  await assert.rejects(call(runtime, { result: { total: -2 } }), /result\.total must be at least 0/);
});

test('an additionalProperties schema checks the keys the properties do not name', async t => {
  const runtime = await runtimeWith(t, { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: { type: 'integer', minimum: 0 } });
  assert.deepEqual(await call(runtime, { id: 'x', a: 1, b: 0 }), { ok: true });
  await assert.rejects(call(runtime, { a: -1 }), /arguments\.a must be at least 0/);
  await assert.rejects(call(runtime, { a: 'x' }), /arguments\.a must be integer/);
});

test('registration refuses a keyword the validator cannot enforce, naming the operation, the path and the keyword', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-schema-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const runtime = new StudyRuntime(root);
  const register = (input, output) => runtime.register({ id: 'bad', version: 1, collections: ['badRecords'], operations: { run: { input, output, execute: () => ({}) } } });
  assert.throws(() => register(wrap({ code: { type: 'string', pattern: '^a' } })), /bad\.run input: properties\.code has the unsupported schema keyword "pattern"/);
  assert.throws(() => register(wrap({ rows: { type: 'array', items: { type: 'integer', multipleOf: 2 } } })), /properties\.rows\.items has the unsupported schema keyword "multipleOf"/);
  assert.throws(() => register({ oneOf: [{ type: 'string', format: 'uri' }, { type: 'null' }] }), /oneOf\[0\] has the unsupported schema keyword "format"/);
  assert.throws(() => register(undefined, { type: 'object', minProperties: 1 }), /bad\.run output: .*"minProperties"/);
  assert.throws(() => register({ type: 'object', properties: { a: { type: 'sting' } } }), /properties\.a has an unknown type "sting"/);
  assert.throws(() => register({ type: 'array', items: [{ type: 'string' }] }), /items that must be one schema/);
  assert.throws(() => register({ type: 'integer', minimum: '0' }), /"minimum" that must be a number/);
  assert.throws(() => register({ type: 'array', maxItems: -1 }), /"maxItems" that must be a non-negative integer/);
  // A refused registration leaves nothing behind: the same id registers once the schema is right.
  runtime.register({ id: 'bad', version: 1, collections: ['badRecords'], operations: { run: { input: wrap({ code: { type: 'string', maxLength: 4, description: 'a short code' } }), execute: () => ({}) } } });
});

test('annotations are allowed beside the enforced keywords', () => {
  assert.doesNotThrow(() => new StudyRuntime(tmpdir()).register({ id: 'annotated', version: 1, operations: { run: {
    input: { type: 'object', title: 'Input', description: 'x', default: {}, examples: [{}], additionalProperties: true, properties: {} }, execute: () => ({}) } } })());
});

test('the keywords the validator supports are listed once and include every constraint', () => {
  for (const keyword of ['type', 'enum', 'const', 'required', 'properties', 'additionalProperties', 'items', 'oneOf', 'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength']) {
    assert.ok(SCHEMA_KEYWORDS.includes(keyword), keyword);
  }
});

test('every schema the built-in contexts publish uses only supported keywords (the runtime is created without a refusal)', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-schema-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  assert.doesNotThrow(() => createStudyRuntime(root));
});

test('materials contracts: the declared offset and thread limits are enforced, an ordinary ask is accepted', () => {
  const { input } = materialsSchemas['materials.selection.ask'];
  const ask = { selection: { sourceId: 's', quote: 'q' }, question: 'why?' };
  assert.doesNotThrow(() => validate({ ...ask, offset: 0, thread: [{ question: 'a', answer: 'b' }, { question: 'c', answer: 'd' }, { question: 'e', answer: 'f' }] }, input));
  assert.doesNotThrow(() => validate(ask, input));
  assert.throws(() => validate({ ...ask, offset: -1 }, input), /arguments\.offset must be at least 0/);
  assert.throws(() => validate({ ...ask, thread: Array.from({ length: 4 }, () => ({ question: 'a', answer: 'b' })) }, input), /arguments\.thread must have at most 3 items/);
});
