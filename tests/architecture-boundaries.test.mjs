import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
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
