import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createStudyRuntime } from '../lib/runtime/builtins.js';

const repository = fileURLToPath(new URL('../', import.meta.url));
const normalize = path => path.replaceAll('\\', '/');
const contextOwner = path => normalize(relative(repository, resolve(repository, path))).match(/^lib\/contexts\/([^/]+)\//)?.[1];
async function javascriptFiles(directory) {
  const files = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) files.push(...await javascriptFiles(path));
    else if (item.name.endsWith('.js')) files.push(path);
  }
  return files;
}

test('context imports cross neither legacy authority nor private foreign implementations', async () => {
  const entryPoints = await javascriptFiles(join(repository, 'lib/contexts'));
  const { metafile } = await build({ entryPoints, absWorkingDir: repository, bundle: true, write: false,
    platform: 'node', format: 'esm', packages: 'external', metafile: true, logLevel: 'silent',
    outdir: join(tmpdir(), 'study-boundaries-metadata-only') });
  const forbidden = [];
  for (const [from, input] of Object.entries(metafile.inputs)) {
    const owner = contextOwner(from);
    if (!owner) continue;
    for (const imported of input.imports) {
      const target = normalize(imported.path);
      const foreign = contextOwner(target);
      if (['legacy-kernel.js', 'legacy-registration.js', 'store.js'].includes(basename(target)) ||
        foreign && foreign !== owner && !target.endsWith('/contracts.js')) {
        forbidden.push({ from: normalize(from), to: target, kind: imported.kind });
      }
    }
  }
  assert.deepEqual(forbidden, [], `Forbidden context imports: ${forbidden.length}`);
});

test('installed built-in API dependency graph is acyclic and contains no transition context', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'study-domain-graph-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtime = createStudyRuntime(directory);
  t.after(() => runtime.dispose());
  const graph = new Map(runtime.describe().map(context => [context.api, context.dependencies]));
  assert.equal(graph.has('transition.v1'), false, 'all transition responsibilities must have a lasting owner');
  const checked = new Set();
  function visit(api, path = []) {
    assert.ok(!path.includes(api), `Dependency cycle: ${[...path, api].join(' -> ')}`);
    if (checked.has(api)) return;
    assert.ok(graph.has(api), `Declared dependency ${api} has no built-in owner`);
    for (const dependency of graph.get(api)) visit(dependency, [...path, api]);
    checked.add(api);
  }
  for (const api of graph.keys()) visit(api);
});

test('retired legacy authority and transition container are removed from distribution source', async () => {
  assert.ok(!(await readdir(join(repository, 'lib'))).includes('legacy-kernel.js'));
  assert.ok(!(await readdir(join(repository, 'lib/runtime'))).includes('legacy-registration.js'));
  assert.ok(!(await readdir(join(repository, 'lib/contexts'))).includes('transition'));
});

// The kernel (lib/jobs) is the layer below every domain: it reaches out of its own folder to exactly these shared infrastructure modules (storage, usage and effort vocabularies, the
// worker owner marker, the permit pool, the host child helper) and to nothing of a context, a domain pipeline or the UI. A new import is a review, not a wildcard.
const KERNEL_REACHES = ['lib/atomic-json.js', 'lib/audio-pool.js', 'lib/host-capabilities.js', 'lib/job-output.js', 'lib/model-effort.js', 'lib/model-usage.js', 'lib/reasoning-effort.js',
  'lib/runtime/work-ownership.js', 'lib/token-usage.js', 'lib/usage-scope.js'];

test('the kernel imports only the reviewed shared infrastructure outside lib/jobs, and no context, pipeline or UI', async () => {
  const reaches = new Map();
  for (const file of await javascriptFiles(join(repository, 'lib/jobs'))) {
    const from = normalize(relative(repository, file));
    for (const match of (await readFile(file, 'utf8')).matchAll(/(?:from\s+|import\s*\(\s*)['"](\.[^'"]+)['"]/g)) {
      const target = normalize(relative(repository, resolve(file, '..', match[1])));
      if (!target.startsWith('lib/jobs/')) reaches.set(target, [...(reaches.get(target) ?? []), from]);
    }
  }
  const unreviewed = [...reaches].filter(([target]) => !KERNEL_REACHES.includes(target)).map(([target, users]) => `${[...new Set(users)].join(', ')} imports ${target}: the kernel does not depend on a module of a context or a domain pipeline; pass it in through the definition`);
  assert.deepEqual(unreviewed, []);
  assert.deepEqual(KERNEL_REACHES.filter(target => !reaches.has(target)).map(target => `${target} is no longer imported by the kernel: take it off KERNEL_REACHES`), []);
  assert.ok(![...reaches.keys()].some(target => /^lib\/(?:contexts|ui)\//.test(target)), 'never a context or the UI');
});

test('a synthetic import of another context\'s private implementation is what the boundary above would name', () => {
  const owner = path => path.match(/^lib\/contexts\/([^/]+)\//)?.[1];
  const violates = (from, to) => owner(to) && owner(to) !== owner(from) && !to.endsWith('/contracts.js');
  assert.ok(violates('lib/contexts/notes/jobs/note-generate.js', 'lib/contexts/audio/jobs/view.js'), 'a Job of one context reading the private module of another');
  assert.ok(!violates('lib/contexts/notes/jobs/note-generate.js', 'lib/contexts/audio/contracts.js'), 'the published contract of another context is allowed');
  assert.ok(!violates('lib/contexts/notes/jobs/note-generate.js', 'lib/contexts/notes/note-generation.js'), 'its own context is allowed');
});
