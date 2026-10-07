/* S6-3: the structure and API boundaries of the unified runtime, as guards a future change meets before review does.
   What a Job module may not do: ask a model outside the gateway, import a provider, write the public job table or its controllers, allocate a queue of its own, write the lifecycle (status,
   attempt, times, calls, events) itself. What it may do and is never caught: a plain `fetch`, domain Maps (reserve, candidates, writers), a per-file writer queue and a private controller.
   Every exception is an exact row of s1-7-legacy-exceptions.json `boundaries` (module, rule, API, count, reason): no wildcards, and a row that no longer matches is a failure too. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { RULES, auditJobModule, diagnose } from './helpers/runtime-architecture.mjs';
import { fingerprint, manifestPaths } from './helpers/kernel-shape.mjs';

const INVENTORY = new URL('../docs/plans/unified-job-runtime/s1-7-legacy-exceptions.json', import.meta.url);
const SHAPES = new URL('./fixtures/release-2.7.1/shape-baseline.json', import.meta.url);
const root = new URL('../', import.meta.url);
const rules = source => auditJobModule(source).map(item => `${item.rule}:${item.api}`);

/* ---------- the rules, on synthetic modules ---------- */

test('a Job module that asks a model outside the gateway, imports a provider, writes the public job table, allocates its own queue or writes the lifecycle is rejected, at the API', () => {
  const cases = [
    ['gateway-bypass', 'worker.complete(system, prompt);', 'worker.complete'],
    ['gateway-bypass', 'ctx.llm.stream(request);', 'ctx.llm.stream'],
    ['gateway-bypass', 'await providedComplete(system, prompt);', 'providedComplete'],
    ['gateway-bypass', 'fetch("https://generativelanguage.googleapis.com/v1/models", { method: "POST" });', 'fetch'],
    ['gateway-bypass', 'other.step("k", policy).complete(system, prompt);', 'complete'],
    ['provider-import', 'import { GeminiTiers } from "../../gemini.js";', '../../gemini.js'],
    ['provider-import', 'import { startBoundedChild } from "../host-capabilities.js";', '../host-capabilities.js'],
    ['public-table-write', 'work.jobs.set(id, job);', 'work.jobs.set'],
    ['public-table-write', 'work.generationControllers.set(id, controller);', 'work.generationControllers.set'],
    ['public-table-write', 'retryable.set(id, entry);', 'retryable.set'],
    ['public-table-write', 'settled.set(id, promise);', 'settled.set'],
    ['public-table-write', 'work.jobControls.delete(id);', 'work.jobControls.delete'],
    ['public-queue', 'const queue = [];', 'queue'],
    ['public-queue', 'const jobs = new Map();', 'jobs'],
    ['public-queue', 'const tasks = new Set();', 'tasks'],
    ['lifecycle-write', 'job.contract.status = "complete";', 'job.contract.status'],
    ['lifecycle-write', 'contract.finishedAt = new Date();', 'contract.finishedAt'],
  ];
  for (const [rule, source, api] of cases) assert.ok(rules(source).some(found => found.startsWith(`${rule}:`) && found.includes(api.split('.').at(-1))), `${rule} must catch: ${source} (got ${rules(source)})`);
});

test('a plain fetch, domain Maps, a per-file writer queue and a private controller are never caught', () => {
  const legitimate = [
    'const text = await (await fetch("https://example.invalid/help.txt")).text();',
    'const reserve = new Map(); const candidates = new Map(); reserve.set(key, 1); candidates.set(id, card);',
    // a per-file writer queue, shaped like lib/store-lock.js and lib/atomic-json.js
    'const tails = new Map(); const holding = new AsyncLocalStorage(); function lock(file, work) { const turn = (tails.get(file) ?? Promise.resolve()).then(work); tails.set(file, turn.then(() => {}, () => {})); return turn; }',
    'const writers = new Map(); const locks = new Set(); writers.set(path, tail); locks.add(path);',
    // a private controller of one run
    'const controller = new AbortController(); const controllers = new Map(); controllers.set(key, controller); class Run { #controller = new AbortController(); stop() { this.#controller.abort(); } }',
    // the gateway is the way to a model
    'context.gateway.step("a:1", policy).complete(system, prompt); const step = context.gateway.step("b:1", policy); step.complete(system, prompt);',
    'const view = { status: "running" }; view.status = "done"; progress.finishedAt = Date.now();',
  ];
  for (const source of legitimate) assert.deepEqual(auditJobModule(source), [], source);
});

test('a failure names the module, the API and why, in one line', () => {
  const [violation] = auditJobModule('work.jobs.set(id, job);');
  const line = diagnose('lib/contexts/notes/jobs/example.js', violation);
  assert.match(line, /^lib\/contexts\/notes\/jobs\/example\.js: public-table-write — `work\.jobs\.set`: /);
  assert.ok(line.includes(RULES['public-table-write']) && !line.includes('\n'));
  for (const rule of Object.keys(RULES)) assert.match(RULES[rule], /\w+ \w+ \w+/, `${rule} has an explanation`);
});

/* ---------- the real Job modules ---------- */

async function jobModules() {
  const inventory = JSON.parse(await readFile(INVENTORY, 'utf8'));
  const directories = [...new Set(inventory.managedDefinitions.map(file => dirname(file)))].sort(), found = [];
  async function visit(directory) {
    for (const entry of await readdir(new URL(directory, root), { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await visit(file); else if (entry.name.endsWith('.js')) found.push(file);
    }
  }
  for (const directory of directories) await visit(directory);
  return { inventory, files: [...new Set(found)].sort() };
}

test('every Job module is clean, except the exact reviewed rows of `boundaries`, and no reviewed row has gone stale', async () => {
  const { inventory, files } = await jobModules(), observed = [];
  for (const file of files) for (const violation of auditJobModule(await readFile(new URL(file, root), 'utf8'))) observed.push({ file, ...violation });
  const key = row => `${row.file}\u0000${row.rule}\u0000${row.api}\u0000${row.count}`, allowed = new Set(inventory.boundaries.map(key));
  assert.deepEqual(observed.filter(row => !allowed.has(key(row))).map(row => diagnose(row.file, row)), [],
    'a Job module crossed a boundary: use the runtime\'s way (see the rule), or add an exact row to s1-7-legacy-exceptions.json `boundaries` with a reason and a removeAt');
  const seen = new Set(observed.map(key));
  assert.deepEqual(inventory.boundaries.filter(row => !seen.has(key(row))).map(row => `${row.file}: ${row.rule} \`${row.api}\` ×${row.count} is no longer there: remove the row`), []);
});

test('reviewed boundary rows are exact: a module, a rule, an API and a count, each with a reason and a removeAt; no wildcard, no pattern, no directory', async () => {
  const { inventory } = await jobModules();
  assert.ok(inventory.boundaries.length > 0);
  for (const row of inventory.boundaries) {
    const where = `${row.file} ${row.rule} ${row.api}`;
    assert.ok(Object.keys(RULES).includes(row.rule), `${where}: unknown rule`);
    assert.ok(/^lib\/[\w./-]+\.js$/.test(row.file) && !/[*?[\]{}()|^$\\]/.test(row.file), `${where}: a module, not a pattern`);
    assert.ok(row.api && !/[*?[\]{}|^$\\]/.test(row.api.replace(/\.\.\//g, '')), `${where}: an API, not a pattern`);
    assert.ok(Number.isInteger(row.count) && row.count > 0, `${where}: a count`);
    assert.ok(row.reason?.length > 20 && row.removeAt, `${where}: a reason and a removeAt`);
  }
  const keys = inventory.boundaries.map(row => `${row.file}|${row.rule}|${row.api}`);
  assert.equal(new Set(keys).size, keys.length, 'one row per module, rule and API');
  // The check the rows are held to, on a synthetic row: widening one fails.
  const widened = { file: 'lib/contexts/**/*.js', rule: 'public-table-write', api: 'work.*.set', count: 1, reason: 'everything', removeAt: 'never' };
  assert.ok(!/^lib\/[\w./-]+\.js$/.test(widened.file) || /[*?[\]{}()|^$\\]/.test(widened.file), 'a wildcard module is refused');
  assert.ok(/[*?[\]{}|^$\\]/.test(widened.api), 'a wildcard API is refused');
});

test('a Job definition has no reviewed exception to the model, provider, queue or lifecycle rules; the only rows it may carry are the two control-adapter writes of S6-0, kept on purpose', async () => {
  const { inventory } = await jobModules(), definitions = new Set(inventory.managedDefinitions);
  const rows = inventory.boundaries.filter(row => definitions.has(row.file));
  assert.deepEqual(rows.map(row => `${row.file} ${row.rule} ${row.api}`).sort(), [
    'lib/contexts/generation/jobs/generation.js public-table-write binding.work.generationControllers.set',
    'lib/contexts/generation/translation/jobs/translation.js public-table-write task.work.generationControllers.set']);
  assert.ok(rows.every(row => row.removeAt === 'retained: cancel-controller registration is the control adapter'), 'kept on purpose (S6-7): the console controls read this table, the registration is the control adapter');
});

/* ---------- persisted kernel shapes change only together with the rollback fixtures ---------- */

test('the persisted shape of the kernel manifest is the one the rollback fixtures were checked against; a change needs them changed in the same commit', async t => {
  const baseline = JSON.parse(await readFile(SHAPES, 'utf8')), now = await manifestPaths(t);
  const added = now.filter(path => !baseline.paths.includes(path)), removed = baseline.paths.filter(path => !now.includes(path));
  assert.deepEqual({ added, removed }, { added: [], removed: [] },
    `The persisted shape of a Job manifest changed (added ${JSON.stringify(added)}, removed ${JSON.stringify(removed)}). Persisted shapes change only together with the rollback fixtures: `
    + 'check that release 2.7.1 still reads what is written (tests/unified-runtime-rollback-shape.test.mjs; the validators are tests/fixtures/release-2.7.1, see its README.md: never edit '
    + 'them to make a failure pass), then update tests/fixtures/release-2.7.1/shape-baseline.json in the same commit.');
  assert.equal(baseline.digest, fingerprint(baseline.paths), 'the baseline file was edited by hand: regenerate it with tests/fixtures/release-2.7.1/make-shape-baseline.mjs');
});

test('the rollback fixtures are still the release\'s own, and the baseline names the release they belong to', async () => {
  const baseline = JSON.parse(await readFile(SHAPES, 'utf8')), readme = await readFile(new URL('./fixtures/release-2.7.1/README.md', import.meta.url), 'utf8');
  assert.equal(baseline.release, '2.7.1');
  assert.ok(readme.includes('v2.7.1') && readme.includes('Never edit them'), 'the README says what the fixtures are and that they are not to be edited');
});
