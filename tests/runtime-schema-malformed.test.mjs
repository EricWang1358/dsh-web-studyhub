import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validate } from '../lib/runtime/schema.js';

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

test('docs/architecture.md says which way an outside plugin registers a context leniently', async () => {
  const text = (await readFile(new URL('../docs/architecture.md', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  assert.match(text, /forLibrary\(path\)\.register\(definition\)[^\n]*(?:warn|ignored)/i);
  assert.match(text, /runtimeForLibrary[^\n]*lenientSchemas/);
});
