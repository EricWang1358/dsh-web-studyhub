import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { StudyRuntime } from '../lib/runtime.js';
import { acquireContexts } from '../lib/runtime/lifecycle.js';

/* #842 gate review: the strict check of the schema keywords is for the contexts the app installs (and its tests). The public `studyRuntime.forLibrary(...).register`
   is open to outside plugins that were accepted before the check existed, with the JSON Schema their tools emit (pattern, format, anyOf, $schema ...): they register,
   the keyword is ignored as it always was, and one console warning names the operation and the keyword. Constraints the validator knows are enforced for them too. */

const OUTSIDE = { type: 'object', $schema: 'http://json-schema.org/draft-07/schema#', properties: {
  code: { type: 'string', pattern: '^[a-z]+$', minLength: 2 },
  link: { type: 'string', format: 'uri' },
  either: { anyOf: [{ type: 'string' }, { type: 'number' }] },
  count: { type: 'integer', minimum: 0 } }, additionalProperties: true };

async function capture(run) {
  const warnings = [], original = console.warn;
  console.warn = (...parts) => warnings.push(parts.join(' '));
  try { return { value: await run(), warnings }; } finally { console.warn = original; }
}
const definition = id => ({ id, version: 1, operations: { run: { input: OUTSIDE, execute: () => ({ ok: true }) } } });

test('a runtime registers a context leniently when asked: unsupported keywords are ignored with one warning naming the operation and the keyword', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-lenient-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const runtime = new StudyRuntime(root);
  const { warnings } = await capture(async () => {
    const dispose = runtime.register(definition('lenient-a'), { lenientSchemas: true });
    assert.deepEqual(await runtime.invoke('lenient-a.v1', 'run', { code: 'ab', link: 'not a uri', either: true, count: 1 }), { ok: true }, 'pattern, format and anyOf are ignored');
    await assert.rejects(runtime.invoke('lenient-a.v1', 'run', { count: -1 }), /arguments\.count must be at least 0/, 'what the validator knows is still enforced');
    await assert.rejects(runtime.invoke('lenient-a.v1', 'run', { code: 'a' }), /arguments\.code must have at least 2 characters/);
    dispose();
    runtime.register(definition('lenient-a'), { lenientSchemas: true });
  });
  assert.equal(warnings.length, 4, `one warning per keyword, once: ${warnings.join(' | ')}`);
  for (const keyword of ['$schema', 'pattern', 'format', 'anyOf']) assert.ok(warnings.some(line => line.includes(`"${keyword}"`) && line.includes('lenient-a.run input')), keyword);
});

test('the same schema is refused when the runtime registers strictly, as the installed contexts and the tests do', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-lenient-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const runtime = new StudyRuntime(root);
  assert.throws(() => runtime.register(definition('strict-a')), /strict-a\.run input: .*unsupported schema keyword/);
  assert.throws(() => runtime.register(definition('strict-a'), { lenientSchemas: false }), /unsupported schema keyword/);
});

test('the public forLibrary(...).register of the studyRuntime API is lenient; the contexts it installs stay strict', async t => {
  const ctx = new Context();
  ctx.provide('tools', { register: () => () => {} });
  t.after(() => ctx.fiber.dispose());
  const directory = await mkdtemp(join(tmpdir(), 'study-lenient-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const installed = acquireContexts(ctx, ['bank']);
  const library = installed.api.forLibrary(directory);
  const { warnings } = await capture(async () => {
    const dispose = library.register(definition('outside-b'));
    assert.deepEqual(await library.invoke('outside-b.v1', 'run', { code: 'zz' }), { ok: true });
    await assert.rejects(library.invoke('outside-b.v1', 'run', { count: -2 }), /must be at least 0/);
    dispose();
  });
  assert.ok(warnings.some(line => line.includes('outside-b.run input') && line.includes('"pattern"')), warnings.join(' | '));
  assert.ok(library.describe().some(item => item.api === 'bank.v1'), 'the installed contexts registered under the strict check');
});
