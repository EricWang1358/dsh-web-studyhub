import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { schemaProblems, validate } from '../lib/runtime/schema.js';

/* #842 follow-up: a constraint whose value has the wrong shape (`maxLength: null`, `minimum: "0"`) is a problem warned about at registration of an outside
   plugin's context, and it is ignored, as it always was: it never refuses a value. A constraint with a right shape is enforced as before. */

test('a constraint whose value has the wrong shape refuses nothing', () => {
  for (const [value, schema] of [
    ['abc', { type: 'string', maxLength: null }], ['abc', { type: 'string', minLength: '5' }], ['abc', { type: 'string', maxLength: 1.5 }], ['abc', { type: 'string', maxLength: -1 }],
    [-1, { type: 'number', minimum: null }], [-1, { type: 'number', minimum: '0' }], [5, { type: 'number', maximum: '1' }], [5, { type: 'number', maximum: Number.NaN }],
    [['a', 'b'], { type: 'array', maxItems: null }], [[], { type: 'array', minItems: '1' }], [['a', 'b'], { type: 'array', maxItems: -1 }],
  ]) assert.doesNotThrow(() => validate(value, schema), JSON.stringify(schema));
});

test('a constraint with the right shape is enforced, zero included', () => {
  assert.throws(() => validate('abc', { type: 'string', maxLength: 2 }), /at most 2 characters/);
  assert.throws(() => validate('', { type: 'string', minLength: 1 }), /at least 1 character/);
  assert.throws(() => validate('a', { type: 'string', maxLength: 0 }), /at most 0 characters/);
  assert.throws(() => validate(-1, { type: 'number', minimum: 0 }), /at least 0/);
  assert.throws(() => validate(1, { type: 'number', maximum: 0 }), /at most 0/);
  assert.throws(() => validate([1], { type: 'array', maxItems: 0 }), /at most 0 items/);
  assert.doesNotThrow(() => validate(0, { type: 'number', minimum: 0, maximum: 0 }));
});

test('a malformed enum, required, oneOf, properties or items refuses nothing and throws nothing', () => {
  for (const [value, schema] of [
    ['abc', { enum: 5 }], ['abc', { enum: 'abc' }], ['b', { enum: 'abc' }], [{}, { type: 'object', required: 'id' }], [{}, { type: 'object', required: 5 }],
    [{}, { type: 'object', required: [5, null] }], [1, { oneOf: [] }], [1, { oneOf: {} }], [1, { oneOf: 'x' }], [{ a: 1 }, { type: 'object', properties: 'abc' }],
    [{ a: 1 }, { type: 'object', properties: 5 }], [['a'], { type: 'array', items: [{ type: 'number' }] }], [['a'], { type: 'array', items: 5 }],
    [1, { type: 'sting' }], [1, { type: 5 }], [1, { type: [] }], [1, { type: ['sting'] }], [{ constructor: 1 }, { type: 'object', properties: {} }],
  ]) assert.doesNotThrow(() => validate(value, schema), JSON.stringify(schema));
});

test('a well-formed enum, required and oneOf are enforced as before', () => {
  assert.throws(() => validate('d', { enum: ['a', 'b'] }), /not an allowed value/);
  assert.throws(() => validate({}, { type: 'object', required: ['id'] }), /arguments\.id is required/);
  assert.throws(() => validate(1, { oneOf: [{ type: 'string' }, { type: 'boolean' }] }), /exactly one schema/);
  assert.doesNotThrow(() => validate(1, { oneOf: [{ type: 'string' }, { type: 'number' }] }));
});

test('type may be a list of types, the nullable form tool libraries emit: a value matching any of them passes', () => {
  const nullable = { type: ['number', 'null'], minimum: 0 };
  assert.doesNotThrow(() => validate(3, nullable));
  assert.doesNotThrow(() => validate(null, nullable));
  assert.throws(() => validate('x', nullable), /must be number or null/);
  assert.throws(() => validate(-1, nullable), /at least 0/);
  const object = { type: ['object', 'null'], required: ['id'], properties: { id: { type: ['string', 'null'] } }, additionalProperties: false };
  assert.doesNotThrow(() => validate(null, object));
  assert.doesNotThrow(() => validate({ id: null }, object));
  assert.throws(() => validate({}, object), /arguments\.id is required/);
  assert.throws(() => validate({ id: 1 }, object), /arguments\.id must be string or null/);
  assert.throws(() => validate({ id: 'a', other: 1 }, object), /arguments\.other is not supported/);
  const list = { type: ['array', 'null'], items: { type: 'integer' }, maxItems: 2 };
  assert.doesNotThrow(() => validate(null, list));
  assert.doesNotThrow(() => validate([1], list));
  assert.throws(() => validate([1.5], list), /arguments\[0\] must be integer/);
  assert.throws(() => validate([1, 2, 3], list), /at most 2 items/);
});

test('strict registration accepts a list of known types and still names the malformed ones', () => {
  assert.deepEqual(schemaProblems({ type: ['string', 'null'] }, 'x.run input'), []);
  assert.match(schemaProblems({ type: ['string', 'sting'] }, 'x.run input')[0], /unknown type "sting"/);
  assert.match(schemaProblems({ type: [] }, 'x.run input')[0], /unknown type/);
  assert.match(schemaProblems({ enum: 5, required: 'id', oneOf: {} }, 'x.run input').join('|'), /"enum".*"required".*"oneOf"/);
});

test('docs/architecture.md says which way an outside plugin registers a context leniently', async () => {
  const text = (await readFile(new URL('../docs/architecture.md', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  assert.match(text, /forLibrary\(path\)\.register\(definition\)[^\n]*(?:warn|ignored)/i);
  assert.match(text, /runtimeForLibrary[^\n]*lenientSchemas/);
});
