import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditManagedModule, inspectCalls, inspectStarts, hasDefinition } from './helpers/runtime-architecture.mjs';
import { MIGRATION_SWITCHES } from '../lib/runtime-config.js';
import { managedRuntimeOptions } from './helpers/runtime-switch.mjs';

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
  assert.deepEqual(auditManagedModule('const step = context.gateway.step("k", p); step.complete(system, prompt);'), []);
  assert.ok(auditManagedModule('const step = other.step("k", p); step.complete(system, prompt);').length);
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

/* S6-0: the inventory is read two ways. `entries` are the model-shaped call sites, `starts` are the places background work BEGINS (a job-table write, an owner, a cancel
   controller, a host sub-agent, a process, a timer, a registry of live runs). A new site in either list fails here until someone has put it, with a disposition, in
   docs/plans/unified-job-runtime/s1-7-legacy-exceptions.json and explained it in s6-0-coverage.md. */
const INVENTORY = new URL('../docs/plans/unified-job-runtime/s1-7-legacy-exceptions.json', import.meta.url);
const COVERAGE_DOC = new URL('../docs/plans/unified-job-runtime/s6-0-coverage.md', import.meta.url);
const DISPOSITIONS = ['migrate', 'exception', 'delete-s6-2'];

async function observedStarts() {
  const root = new URL('../', import.meta.url), found = [];
  async function visit(directory) {
    for (const entry of await readdir(new URL(directory, root), { withFileTypes: true })) {
      const file = join(directory, entry.name).replaceAll('\\', '/');
      if (entry.isDirectory()) await visit(file + '/');
      else if (entry.name.endsWith('.js') && !entry.name.startsWith('client.')) {
        const calls = inspectStarts(await readFile(new URL(file, root), 'utf8'));
        if (calls.length) found.push({ file, calls });
      }
    }
  }
  await visit('lib/');
  return found.sort((a, b) => a.file.localeCompare(b.file));
}

test('inspectStarts sees real starts, not strings, comments or regular expressions', () => {
  for (const source of ['ownWork(job, owner);', 'jobs.set(id, job);', 'work.retryable.set(id, entry);', 'registry.generationControllers.set(id, controller);',
    'spawn(command, args);', 'runLocalCommand(cli, args);', 'setInterval(poll, 15000);', 'subagents.start("spawn", request);', 'new Worker(file);',
    'const runs = new Map();', 'export const live = new Set();'])
    assert.ok(inspectStarts(source).length, source);
  assert.deepEqual(inspectStarts('const text = "ownWork spawn setInterval jobs.set"; /spawn/.exec(text); // runLocalCommand(); \nconst cache = new Map(); function f() { const runs = new Map(); }'), []);
  assert.deepEqual(inspectStarts('/* a host child */ const child = subagents.startContinuable(request);'), [{ callee: 'subagents.startContinuable', count: 1 }]);
});

test('every place background work starts is reviewed: a new start outside the inventory fails, with every switch on', async () => {
  const inventory = JSON.parse(await readFile(INVENTORY));
  assert.deepEqual(await observedStarts(), inventory.starts.map(({ file, calls }) => ({ file, calls })).sort((a, b) => a.file.localeCompare(b.file)),
    'a new start of background work needs a reviewed row (with a disposition) in s1-7-legacy-exceptions.json `starts`');
  for (const entry of inventory.starts) for (const field of ['owner', 'evidence']) assert.ok(entry[field], `${entry.file}: ${field}`);
});

test('every reviewed site has a disposition that holds: migrate names its step, delete-s6-2 names the switch that bypasses it, an exception says what it is', async () => {
  const inventory = JSON.parse(await readFile(INVENTORY)), switches = Object.keys(MIGRATION_SWITCHES);
  for (const entry of [...inventory.entries, ...inventory.starts]) {
    assert.ok(entry.sites?.length, `${entry.file}: no reviewed site`);
    for (const site of entry.sites) {
      const where = `${entry.file}: ${site.what}`;
      assert.ok(site.what && DISPOSITIONS.includes(site.disposition), where);
      assert.ok(inventory.kinds.includes(site.kind), `${where}: kind ${site.kind}`);
      assert.equal(typeof site.reached, 'boolean', where);
      for (const name of site.switches ?? []) assert.ok(switches.includes(name), `${where}: unknown switch ${name}`);
      if (site.disposition === 'migrate') assert.ok(site.reached && /^S\d-\d{1,2}$/.test(site.step ?? ''), `${where}: a path still outside the runtime needs its step`);
      if (site.disposition === 'delete-s6-2') assert.ok(site.reached === false && site.switches?.length, `${where}: a deletable path is unreachable behind a switch`);
      if (site.disposition === 'exception') assert.ok(site.reached === true && site.kind !== 'legacy-bypass', `${where}: an exception is reached and says what it is`);
    }
  }
});

test('every migration switch bypasses something in the inventory, and every inventory row appears in the coverage document', async () => {
  const inventory = JSON.parse(await readFile(INVENTORY)), doc = await readFile(COVERAGE_DOC, 'utf8');
  const named = new Set([...inventory.entries, ...inventory.starts].flatMap(entry => entry.sites.flatMap(site => site.switches ?? [])));
  assert.deepEqual(Object.keys(MIGRATION_SWITCHES).filter(name => !named.has(name)), [], 'a switch whose original path is not recorded');
  for (const entry of [...inventory.entries, ...inventory.starts]) assert.ok(doc.includes(entry.file), `${entry.file} is not in s6-0-coverage.md`);
  for (const name of Object.keys(MIGRATION_SWITCHES)) assert.ok(doc.includes(`\`${name}\``), `${name} is not in s6-0-coverage.md`);
});

test('with every migration switch on at once the service starts, reads its snapshot and offers the runtime to each context', async t => {
  const { StudyService } = await import('../lib/service.js'), root = await mkdtemp(join(tmpdir(), 'runtime-all-switches-'));
  const { starts: _starts, ...options } = managedRuntimeOptions({ paths: Object.keys(MIGRATION_SWITCHES) });
  assert.ok(Object.keys(MIGRATION_SWITCHES).every(name => options.runtimePilot[name] === true));
  const service = new StudyService(root, { coach: false, ...options });
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  const snapshot = await service.call('snapshot');
  assert.ok(Array.isArray(snapshot.jobs) && Array.isArray(snapshot.sources));
});
