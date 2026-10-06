import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { auditManagedModule, inspectCalls, hasDefinition } from './helpers/runtime-architecture.mjs';

test('managed definitions reject lifecycle/model bypasses while ordinary caches and non-model fetches remain legal', () => {
  for (const source of [
    'const jobs = new Map();', 'const queue = [];', 'worker.complete(system, prompt);',
    'ctx.llm.stream(request);', 'work.jobs.set(id, job);', 'contract.status = "complete";',
    'fetch("https://api.groq.com/openai/v1/chat/completions", options);',
    'import { GeminiTiers } from "../../gemini.js"; new GeminiTiers(options);',
  ]) assert.ok(auditManagedModule(source).length, source);
  assert.deepEqual(auditManagedModule('const cache = new Map(); const text = "fetch jobs complete"; fetch("https://example.invalid/help.txt");'), []);
  // The managed path itself is never a bypass; a step result that is not the gateway's still is.
  assert.deepEqual(auditManagedModule('context.gateway.step("k", policy, { model: "light" }).complete(system, prompt); gateway.step("k", p).complete(s, q);'), []);
  assert.ok(auditManagedModule('other.step("k", p).complete(system, prompt);').length);
});

test('single audio definition keeps all execution behind approved runtime and pipeline adapters', async () => {
  const source = await readFile(new URL('../lib/contexts/audio/jobs/single-import.js', import.meta.url), 'utf8');
  assert.deepEqual(auditManagedModule(source), []);
  assert.ok(source.includes('gateway: context.gateway'), 'shared pipeline must receive the runtime gateway');
});

test('model-shaped legacy call sites require an exact registered inventory and phase owner', async () => {
  const inventory = JSON.parse(await readFile(new URL('../docs/plans/unified-job-runtime/s1-7-legacy-exceptions.json', import.meta.url)));
  const root = new URL('../', import.meta.url), observed = [], definitions = [];
  async function visit(directory) {
    for (const entry of await readdir(new URL(directory, root), { withFileTypes: true })) {
      const file = join(directory, entry.name).replaceAll('\\', '/');
      if (entry.isDirectory()) await visit(file + '/');
      else if (entry.name.endsWith('.js') && !entry.name.startsWith('client.')) {
        const source = await readFile(new URL(file, root), 'utf8'), calls = inspectCalls(source);
        if (hasDefinition(source)) { definitions.push(file); assert.deepEqual(auditManagedModule(source), [], file); }
        if (calls.length) observed.push({ file, calls });
      }
    }
  }
  await visit('lib/');
  assert.deepEqual(definitions.sort(), [...inventory.managedDefinitions].sort(), 'new definitions require a reviewed migration registration');
  assert.deepEqual(observed.sort((a, b) => a.file.localeCompare(b.file)), inventory.entries.map(({ file, calls }) => ({ file, calls })).sort((a, b) => a.file.localeCompare(b.file)));
  for (const entry of inventory.entries) for (const field of ['owner', 'reason', 'removeAt', 'evidence']) assert.ok(entry[field], `${entry.file}: ${field}`);
});
