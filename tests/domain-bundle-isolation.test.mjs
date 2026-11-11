import test from 'node:test';
import assert from 'node:assert/strict';
import { builtinModules } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Context } from '@deepseek-ai/cordis';
import * as hostModel from '../lib/runtime/host-model.js';
import * as workbenchEntry from '../lib/index.js';
import * as materialsPlugin from '../lib/plugins/materials.js';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const DOMAIN_PLUGINS = ['runtime', 'materials', 'bank', 'study', 'generation', 'audio'];
const UI_ONLY_DEPENDENCIES = [
  '@base-ui/react',
  '@codemirror/lang-markdown',
  '@uiw/react-codemirror',
  'dompurify',
  'katex',
  'markdown-it-texmath',
];

const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map(name => `node:${name}`),
]);

function packageNameOf(specifier) {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  return specifier.split('/')[0];
}

test('domain plugin module graphs exclude lib/index.js, lib/client*.js, and UI-only npm dependencies', async () => {
  const manifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  const retainedDeps = new Set([
    '@deepseek-ai/cordis',
    ...Object.keys(manifest.dependencies).filter(pkg => !UI_ONLY_DEPENDENCIES.includes(pkg)),
    ...Object.keys(manifest.peerDependencies || {}),
  ]);

  const entryPoints = DOMAIN_PLUGINS.map(domain => join(repoRoot, `lib/plugins/${domain}.js`));
  const { metafile } = await build({
    entryPoints,
    absWorkingDir: repoRoot,
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    metafile: true,
    logLevel: 'silent',
    outdir: join(tmpdir(), 'study-domain-bundle-isolation-meta'),
  });

  const normalizedInputs = Object.keys(metafile.inputs).map(p => p.replaceAll('\\', '/'));
  assert.equal(normalizedInputs.includes('lib/index.js'), false, 'domain plugins and runtime must not import lib/index.js');
  assert.equal(normalizedInputs.some(p => /^lib\/client(?:\.[A-Za-z0-9._-]+)?\.js$/.test(p)), false,
    'domain plugins must not import prebuilt UI client bundles');

  const externalPackages = new Set();
  for (const input of Object.values(metafile.inputs)) {
    for (const imp of input.imports) {
      if (!imp.external) continue;
      if (imp.path.startsWith('.') || imp.path.startsWith('/') || builtins.has(imp.path)) continue;
      externalPackages.add(packageNameOf(imp.path));
    }
  }

  for (const uiDep of UI_ONLY_DEPENDENCIES) {
    assert.equal(externalPackages.has(uiDep), false, `UI-only package ${uiDep} must not be imported by domain plugins`);
  }
  const undeclared = [...externalPackages].filter(pkg => !retainedDeps.has(pkg));
  assert.deepEqual(undeclared, [], `Every external import of domain plugins must remain declared in dependencies/peerDependencies: ${undeclared.join(', ')}`);
});

test('host-model exports remain re-exported identically from lib/index.js and pickLightEffort handles edge cases', () => {
  assert.equal(workbenchEntry.hostTokenMeter, hostModel.hostTokenMeter);
  assert.equal(workbenchEntry.sessionNotifier, hostModel.sessionNotifier);
  assert.equal(workbenchEntry.pickLightEffort, hostModel.pickLightEffort);
  assert.equal(workbenchEntry.modelCompletion, hostModel.modelCompletion);

  assert.equal(hostModel.pickLightEffort([]), null);
  assert.deepEqual(hostModel.pickLightEffort([{ id: 'none', name: 'No thinking' }, { id: 'low', name: 'Low' }]), { id: 'none', off: true });
  assert.deepEqual(hostModel.pickLightEffort([{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }]), { id: 'low', off: false });
  assert.deepEqual(hostModel.pickLightEffort([{ id: 'high', name: 'High' }, { id: 'max', name: 'Max' }]), { id: 'high', off: false });
});

test('standalone materials plugin resolves defaultServices via host-model without workbench installation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'study-standalone-host-model-'));
  const ctx = new Context();
  const fakeMeter = { estimate: text => String(text).length };
  ctx.provide('llm', {});
  ctx.provide('tokenMeter', fakeMeter);
  await ctx.plugin(materialsPlugin);
  t.after(async () => {
    await ctx.fiber.dispose();
    await rm(directory, { recursive: true, force: true });
  });

  const turns = [];
  const agent = {
    id: 'standalone-materials-chat',
    session: {
      header: { cwd: directory },
      requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-chat' } }),
    },
    inject: () => {},
    followup: msg => turns.push(msg),
  };

  const services = await ctx.studyRuntime.requestServices({ agent });
  assert.equal(services.tokenMeter, fakeMeter);
  assert.equal(typeof services.notify, 'function');
  if (hostModel.hasModelSdk()) {
    assert.equal(typeof services.complete, 'function');
    assert.equal(typeof services.completeLight, 'function');
  }
  services.notify({ text: 'Import finished', summary: 'Done', wakeup: true });
  assert.equal(turns.length, 1);
  assert.equal(turns[0].source.kind, 'plugin:daily-flashcard');
});
