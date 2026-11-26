import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditManagedModule, inspectCalls, inspectStarts, hasDefinition } from './helpers/runtime-architecture.mjs';
import { MIGRATION_SWITCHES } from '../lib/runtime-config.js';
import { singleAudioDefinition } from '../lib/contexts/audio/jobs/single-import.js';
import { prepareSingleAudioRecord } from '../lib/audio-batch.js';
import { AUDIO_DEFAULTS } from '../lib/audio-settings.js';
import { flushAudioUsage } from '../lib/audio-dashboard.js';
import { Store } from '../lib/store.js';
import { TEST_KEY, wav } from './fixtures/audio-single-characterization-process.mjs';
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

test('single audio definition keeps all execution behind approved runtime and pipeline adapters', async t => {
  const source = await readFile(new URL('../lib/contexts/audio/jobs/single-import.js', import.meta.url), 'utf8');
  assert.deepEqual(auditManagedModule(source), []);

  const dir = await mkdtemp(join(tmpdir(), 'single-audio-gateway-'));
  const root = join(dir, 'library');
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = join(dir, 'home');
  const registeredControls = [];
  let admission = null;
  t.after(async () => {
    for (const ctrl of registeredControls) ctrl.close?.();
    await admission?.finish?.();
    await flushAudioUsage();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  const audioPath = join(dir, 'lecture.wav');
  await writeFile(audioPath, wav());
  const store = new Store(root);
  const record = await prepareSingleAudioRecord(root, { path: audioPath, courses: ['Databases'] });

  const httpUrls = [];
  const gatewaySteps = [];
  const observedExternal = [];
  const worker = {
    store,
    audioStore: store,
    language: 'zh',
    audioSettings: async () => ({
      ...AUDIO_DEFAULTS,
      paidKey: TEST_KEY,
      textProvider: 'host',
      transcribeConcurrency: 1,
    }),
    httpFetch: async url => {
      httpUrls.push(String(url));
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'Today we study transactions and B-tree indexes.' }] } }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 12 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    complete: async () => {
      throw new Error('singleAudioDefinition must route text model calls through context.gateway instead of calling worker.complete directly');
    },
    notify() {},
  };
  const work = {
    audioGate: { active: new Set(), waiting: [], limit: 1 },
    jobOutputs: { open() {}, append() {}, reasoning() {}, close() {}, endJob() {} },
  };

  const persistence = await singleAudioDefinition.persistence.open({ singleId: record.id }, { worker, cleanup: () => {} });
  const controller = new AbortController();
  const pauseController = new AbortController();
  const gateway = {
    step(key, policy, display) {
      return {
        async run(fn) {
          gatewaySteps.push({ method: 'run', key, policy, display });
          return fn();
        },
        async reuse(reason) {
          gatewaySteps.push({ method: 'reuse', key, policy, reason });
        },
        async complete(system, prompt) {
          gatewaySteps.push({ method: 'complete', key, policy, display });
          if (system.startsWith('You proofread')) return '{"corrections":[]}';
          if (system.startsWith('You translate')) {
            return JSON.stringify({
              titleZh: '数据库',
              titleEn: 'Databases',
              paragraphs: JSON.parse(prompt).paragraphs.map(p => ({ n: p.n, zh: '今天我们学习事务与 B 树索引。' })),
            });
          }
          return '{"titleEn":"Database Lecture"}';
        },
      };
    },
    async observe(meta, fn) {
      observedExternal.push(meta);
      const result = await fn(controller.signal);
      if (result.ledgerEvent && typeof meta.recordUsage === 'function') await meta.recordUsage(result.ledgerEvent);
      return result.value;
    },
  };
  const context = {
    attemptId: 'att-gateway-check',
    signal: controller.signal,
    pauseSignal: pauseController.signal,
    pauseRequested: false,
    persistence,
    resources: undefined,
    gateway,
    present() {},
    controls(ctrl) { registeredControls.push(ctrl); },
    async saveCheckpoint() {},
    async commitArtifact(_stepKey, build, { publish }) {
      const prepared = await build();
      return publish(prepared, { assertCurrent() {} });
    },
  };

  admission = await singleAudioDefinition.admit(context, persistence.input, { worker, work });
  context.admission = admission;
  const outcome = await singleAudioDefinition.run(context, persistence.input, { worker, work });

  assert.equal(outcome.completeness, 'complete');
  assert.equal(outcome.refs.length, 1);
  assert.ok(httpUrls.length >= 1, 'fake transcription HTTP fetch ran without touching external network');
  assert.ok(observedExternal.some(entry => entry.boundary === 'external-request'), 'transcription HTTP call is observed through context.gateway');
  assert.ok(gatewaySteps.some(step => step.method === 'run' && step.key.startsWith('transcribe:')), 'transcription step runs through context.gateway');
  const completeKeys = gatewaySteps.filter(step => step.method === 'complete').map(step => step.key.split(':')[0]);
  assert.deepEqual(completeKeys, ['proofread', 'translate', 'title'], 'proofread, translate, and title model calls route through context.gateway');
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
      if (site.disposition === 'delete-s6-2') assert.equal(entry.removeAt, 'after default flip', `${where}: switches are off by default, so the original path is the rollback until the default flips`);
      if (site.disposition === 'exception') assert.ok(site.reached === true && site.kind !== 'legacy-bypass', `${where}: an exception is reached and says what it is`);
    }
  }
});

test('every migration switch bypasses something in the inventory, and every inventory row appears in the coverage document', async () => {
  const inventory = JSON.parse(await readFile(INVENTORY)), doc = await readFile(COVERAGE_DOC, 'utf8');
  // A switch that changes how a Job runs (who answers its calls) bypasses no original path: it is listed in `policySwitches`, saying what it changes.
  const policies = Object.entries(inventory.policySwitches ?? {});
  for (const [name, what] of policies) assert.ok(typeof what === 'string' && what.length > 20, `${name}: say what the policy switch changes`);
  const named = new Set([...[...inventory.entries, ...inventory.starts].flatMap(entry => entry.sites.flatMap(site => site.switches ?? [])), ...policies.map(([name]) => name)]);
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
