import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { ESLint } from 'eslint';

const REPOSITORY = fileURLToPath(new URL('../', import.meta.url));
const DESKTOP_ROOT = 'packages/studyhub-desktop';
const PROCESS_RUNNER = `${DESKTOP_ROOT}/adapters/cli/process-runner.mjs`;
const DESKTOP_LAYERS = ['domain', 'application', 'adapters', 'entry'];
const IGNORED_DESKTOP_DIRS = new Set(['dist', 'node_modules', 'src-tauri']);

const APPLICATION_FORBIDDEN_NODE = new Set([
  'node:child_process', 'child_process',
  'node:fs', 'fs',
  'node:fs/promises', 'fs/promises',
  'node:http', 'http',
  'node:https', 'https',
  'node:net', 'net',
]);

const BARE_NODE_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'crypto', 'dgram', 'dns', 'events',
  'fs', 'fs/promises', 'http', 'http2', 'https', 'net', 'os', 'path', 'perf_hooks',
  'process', 'readline', 'stream', 'timers', 'tls', 'tty', 'url', 'util', 'vm', 'worker_threads', 'zlib',
]);

const ALLOWED_LAYERS = Object.freeze({
  domain: new Set(['domain']),
  application: new Set(['application', 'domain']),
  adapters: new Set(['adapters', 'domain']),
  entry: new Set(['entry', 'application', 'adapters', 'domain']),
});

const normalize = (value) => value.replaceAll('\\', '/');
const toRepoRelative = (root, filePath) => normalize(relative(root, resolve(root, filePath)));
const desktopLayerOf = (relPath) => relPath.match(/^packages\/studyhub-desktop\/(domain|application|adapters|entry)\//)?.[1] ?? null;
const isNodeBuiltin = (specifier) => specifier.startsWith('node:') || BARE_NODE_BUILTINS.has(specifier);

async function listFiles(directory, extensions, ignoredDirs = new Set()) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const item of entries) {
    if (item.isDirectory()) {
      if (ignoredDirs.has(item.name)) continue;
      files.push(...await listFiles(join(directory, item.name), extensions, ignoredDirs));
    } else if (extensions.some((ext) => item.name.endsWith(ext))) {
      files.push(join(directory, item.name));
    }
  }
  return files;
}

/** Build an esbuild metafile dependency graph for all files under packages/studyhub-desktop/{domain,application,adapters,entry}/. */
async function analyzeDesktopGraph(root) {
  const entryPoints = [];
  for (const layer of DESKTOP_LAYERS) {
    entryPoints.push(...await listFiles(join(root, DESKTOP_ROOT, layer), ['.js', '.mjs']));
  }
  if (!entryPoints.length) return { entryPoints: [], inputs: {} };
  const outdir = await mkdtemp(join(tmpdir(), 'studyhub-desktop-boundaries-'));
  try {
    const { metafile } = await build({
      entryPoints,
      absWorkingDir: root,
      bundle: true,
      write: false,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      metafile: true,
      logLevel: 'silent',
      outdir,
    });
    return { entryPoints, inputs: metafile.inputs };
  } finally {
    await rm(outdir, { recursive: true, force: true });
  }
}

/** Evaluate DDD layer direction rules on a metafile inputs map. */
function findLayerViolations(inputs) {
  const violations = [];
  for (const [rawFrom, input] of Object.entries(inputs)) {
    const from = normalize(rawFrom);
    const fromLayer = desktopLayerOf(from);
    if (!fromLayer) continue;
    for (const imported of input.imports) {
      const target = normalize(imported.path);
      const targetLayer = desktopLayerOf(target);
      if (targetLayer && !ALLOWED_LAYERS[fromLayer].has(targetLayer)) {
        violations.push({ from, to: target, reason: `${fromLayer} must not depend on ${targetLayer}` });
        continue;
      }
      if (target.startsWith('ui/')) {
        violations.push({ from, to: target, reason: `${fromLayer} must not import UI module` });
        continue;
      }
      if (fromLayer === 'domain') {
        if (isNodeBuiltin(target)) {
          violations.push({ from, to: target, reason: 'domain must not import Node built-ins' });
        } else if (targetLayer !== 'domain') {
          violations.push({ from, to: target, reason: 'domain must remain pure with no external dependencies' });
        }
      } else if (fromLayer === 'application' && APPLICATION_FORBIDDEN_NODE.has(target)) {
        violations.push({ from, to: target, reason: 'application must not import Node IO/process built-ins' });
      }
      if ((target === 'node:child_process' || target === 'child_process') && from !== PROCESS_RUNNER) {
        violations.push({ from, to: target, reason: `only ${PROCESS_RUNNER} may import child_process` });
      }
    }
  }
  return violations;
}

/** Find any directed dependency cycles inside packages/studyhub-desktop/{domain,application,adapters,entry}/. */
function findDependencyCycles(inputs) {
  const graph = new Map();
  for (const [rawFrom, input] of Object.entries(inputs)) {
    const from = normalize(rawFrom);
    if (!desktopLayerOf(from)) continue;
    const targets = input.imports
      .map((item) => normalize(item.path))
      .filter((target) => desktopLayerOf(target));
    graph.set(from, [...new Set(targets)]);
  }
  const visited = new Set();
  const cycles = [];
  function visit(node, stack) {
    const at = stack.indexOf(node);
    if (at >= 0) {
      cycles.push([...stack.slice(at), node].join(' -> '));
      return;
    }
    if (visited.has(node)) return;
    const nextStack = [...stack, node];
    for (const dep of graph.get(node) ?? []) visit(dep, nextStack);
    visited.add(node);
  }
  for (const node of graph.keys()) visit(node, []);
  return cycles;
}

/** Verify every .js file in packages/studyhub-desktop/domain/ begins with // @ts-check. */
async function findMissingTsCheck(root) {
  const domainFiles = await listFiles(join(root, DESKTOP_ROOT, 'domain'), ['.js']);
  const missing = [];
  for (const absPath of domainFiles) {
    const content = (await readFile(absPath, 'utf8')).replace(/^\uFEFF/, '');
    if (!/^\/\/\s*@ts-check\b/.test(content)) {
      missing.push(toRepoRelative(root, absPath));
    }
  }
  return missing;
}

/** Verify no file under packages/studyhub-desktop/ (except adapters/cli/process-runner.mjs) references child_process. */
async function findIllegalChildProcessReferences(root) {
  const files = await listFiles(join(root, DESKTOP_ROOT), ['.js', '.mjs'], IGNORED_DESKTOP_DIRS);
  const offenders = [];
  const pattern = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:node:)?child_process['"]/;
  for (const absPath of files) {
    const rel = toRepoRelative(root, absPath);
    if (rel === PROCESS_RUNNER) continue;
    const source = await readFile(absPath, 'utf8');
    if (pattern.test(source)) offenders.push(rel);
  }
  return offenders;
}

/** Verify no lib/** or non-desktop ui/** file imports packages/studyhub-desktop/** or ui/desktop/**. */
async function findReverseImports(root) {
  const libFiles = await listFiles(join(root, 'lib'), ['.js', '.mjs']);
  const uiFiles = (await listFiles(join(root, 'ui'), ['.js', '.jsx']))
    .filter((absPath) => {
      const rel = toRepoRelative(root, absPath);
      return rel !== 'ui/desktop.jsx' && !rel.startsWith('ui/desktop/');
    });
  const importRegex = /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g;
  const violations = [];
  for (const absPath of [...libFiles, ...uiFiles]) {
    const from = toRepoRelative(root, absPath);
    const source = await readFile(absPath, 'utf8');
    for (const match of source.matchAll(importRegex)) {
      const raw = match[1];
      const target = raw.startsWith('.')
        ? toRepoRelative(root, resolve(absPath, '..', raw.split(/[?#]/)[0]))
        : raw;
      if (target.startsWith(`${DESKTOP_ROOT}/`) || target === DESKTOP_ROOT || target.startsWith('ui/desktop/') || target === 'ui/desktop.jsx') {
        violations.push({ from, to: target });
      }
    }
  }
  return violations;
}

test('desktop DDD layers are strictly acyclic and follow domain <- application / adapters <- entry', async () => {
  const { inputs } = await analyzeDesktopGraph(REPOSITORY);
  assert.deepEqual(findLayerViolations(inputs), []);
  assert.deepEqual(findDependencyCycles(inputs), []);
});

test('every .js file in packages/studyhub-desktop/domain/ starts with // @ts-check', async () => {
  assert.deepEqual(await findMissingTsCheck(REPOSITORY), []);
});

test('sole node:child_process reference in packages/studyhub-desktop/ is adapters/cli/process-runner.mjs', async () => {
  assert.deepEqual(await findIllegalChildProcessReferences(REPOSITORY), []);
});

test('zero reverse imports from lib/** or non-desktop ui/** into packages/studyhub-desktop/** or ui/desktop/**', async () => {
  assert.deepEqual(await findReverseImports(REPOSITORY), []);
});

test('synthetic negative tree proves DDD layers, cycles, @ts-check, child_process and reverse-import guards catch violations', async (t) => {
  const fakeRoot = await mkdtemp(join(tmpdir(), 'studyhub-desktop-neg-'));
  t.after(() => rm(fakeRoot, { recursive: true, force: true }));

  const write = async (rel, content) => {
    const abs = join(fakeRoot, rel);
    await mkdir(resolve(abs, '..'), { recursive: true });
    await writeFile(abs, content, 'utf8');
  };

  // 1. Domain violating purity (imports node:fs and application) + missing // @ts-check + cycle
  await write('packages/studyhub-desktop/domain/a.js', [
    'import fs from "node:fs";',
    'import { appFn } from "../application/use-case.mjs";',
    'import { b } from "./b.js";',
    'export const a = () => [fs, appFn, b];',
  ].join('\n'));
  await write('packages/studyhub-desktop/domain/b.js', [
    '// @ts-check',
    'import { a } from "./a.js";',
    'export const b = () => a;',
  ].join('\n'));

  // 2. Application importing adapters and node:http
  await write('packages/studyhub-desktop/application/use-case.mjs', [
    'import http from "node:http";',
    'import { badAdapter } from "../adapters/other.mjs";',
    'export const appFn = () => [http, badAdapter];',
  ].join('\n'));

  // 3. Adapter importing application and node:child_process outside process-runner.mjs
  await write('packages/studyhub-desktop/adapters/other.mjs', [
    'import { spawn } from "node:child_process";',
    'import { appFn } from "../application/use-case.mjs";',
    'export const badAdapter = () => [spawn, appFn];',
  ].join('\n'));

  // 4. Allowed sole child_process site: adapters/cli/process-runner.mjs
  await write('packages/studyhub-desktop/adapters/cli/process-runner.mjs', [
    'import { spawn } from "node:child_process";',
    'export const runProc = () => spawn;',
  ].join('\n'));

  // 5. Reverse imports from lib/** and non-desktop ui/**
  await write('lib/sneaky.js', 'import { b } from "../packages/studyhub-desktop/domain/b.js"; export const x = b;\n');
  await write('ui/Sneaky.jsx', 'import { P } from "./desktop/parts.jsx"; export const Y = P;\n');
  await write('ui/desktop/parts.jsx', 'export const P = () => null;\n');
  await write('ui/desktop.jsx', 'import { P } from "./desktop/parts.jsx"; export const D = P;\n');

  const { inputs } = await analyzeDesktopGraph(fakeRoot);
  const violations = findLayerViolations(inputs);
  assert.ok(violations.some((v) => v.from === 'packages/studyhub-desktop/domain/a.js' && v.to === 'node:fs'), 'catches domain -> node:fs');
  assert.ok(violations.some((v) => v.from === 'packages/studyhub-desktop/domain/a.js' && v.to === 'packages/studyhub-desktop/application/use-case.mjs'), 'catches domain -> application');
  assert.ok(violations.some((v) => v.from === 'packages/studyhub-desktop/application/use-case.mjs' && v.to === 'node:http'), 'catches application -> node:http');
  assert.ok(violations.some((v) => v.from === 'packages/studyhub-desktop/application/use-case.mjs' && v.to === 'packages/studyhub-desktop/adapters/other.mjs'), 'catches application -> adapters');
  assert.ok(violations.some((v) => v.from === 'packages/studyhub-desktop/adapters/other.mjs' && v.to === 'packages/studyhub-desktop/application/use-case.mjs'), 'catches adapters -> application');
  assert.ok(violations.some((v) => v.from === 'packages/studyhub-desktop/adapters/other.mjs' && v.to === 'node:child_process'), 'catches non-runner child_process');
  assert.ok(!violations.some((v) => v.from === PROCESS_RUNNER), 'allows process-runner.mjs to import node:child_process');

  const cycles = findDependencyCycles(inputs);
  assert.ok(cycles.some((c) => c.includes('domain/a.js') && c.includes('domain/b.js')), `catches cycle, got: ${JSON.stringify(cycles)}`);

  assert.deepEqual(await findMissingTsCheck(fakeRoot), ['packages/studyhub-desktop/domain/a.js']);
  assert.deepEqual(await findIllegalChildProcessReferences(fakeRoot), ['packages/studyhub-desktop/adapters/other.mjs']);
  assert.deepEqual(await findReverseImports(fakeRoot), [
    { from: 'lib/sneaky.js', to: 'packages/studyhub-desktop/domain/b.js' },
    { from: 'ui/Sneaky.jsx', to: 'ui/desktop/parts.jsx' },
  ]);
});

test('eslint.config.js enforces desktop anti-bad-smell, DDD layer, child_process and shell:true rules', async () => {
  const eslint = new ESLint({ cwd: REPOSITORY });
  const lint = async (filePath, code) => {
    const [result] = await eslint.lintText(code, { filePath });
    return result.messages.map((item) => `${item.ruleId}: ${item.message}`);
  };

  const domainMsgs = await lint('packages/studyhub-desktop/domain/sample.js', [
    'import fs from "node:fs/promises";',
    'import app from "../application/use-case.mjs";',
    'export function bad(a, b, c, d, e) { var v = 1; if (v == 1) { console.log(fs, app, a, b, c, d, e); } throw "nope"; }',
  ].join('\n'));
  assert.ok(domainMsgs.some((m) => m.includes('no-restricted-imports') && m.includes('node:*')));
  assert.ok(domainMsgs.some((m) => m.includes('no-restricted-imports') && m.includes('application')));
  assert.ok(domainMsgs.some((m) => m.includes('no-console')));
  assert.ok(domainMsgs.some((m) => m.includes('max-params')));
  assert.ok(domainMsgs.some((m) => m.includes('no-var')));
  assert.ok(domainMsgs.some((m) => m.includes('eqeqeq')));
  assert.ok(domainMsgs.some((m) => m.includes('no-throw-literal')));

  const appMsgs = await lint('packages/studyhub-desktop/application/sample.mjs', [
    'import { spawn } from "node:child_process";',
    'import fs from "node:fs/promises";',
    'import ad from "../adapters/other.mjs";',
    'export const run = () => [spawn, fs, ad];',
  ].join('\n'));
  assert.ok(appMsgs.some((m) => m.includes('no-restricted-imports') && m.includes('child_process')));
  assert.ok(appMsgs.some((m) => m.includes('no-restricted-imports') && m.includes('node:fs/promises')));
  assert.ok(appMsgs.some((m) => m.includes('no-restricted-imports') && m.includes('adapters')));

  const adapterMsgs = await lint('packages/studyhub-desktop/adapters/other.mjs', [
    'import { spawn } from "node:child_process";',
    'export const run = () => spawn("agy", [], { shell: true });',
  ].join('\n'));
  assert.ok(adapterMsgs.some((m) => m.includes('no-restricted-imports') && m.includes('process-runner.mjs')));
  assert.ok(adapterMsgs.some((m) => m.includes('no-restricted-syntax') && m.includes('shell: true')));

  const runnerOk = await lint('packages/studyhub-desktop/adapters/cli/process-runner.mjs', [
    'import { spawn } from "node:child_process";',
    'export function run(cmd, args) { return spawn(cmd, args, { shell: false }); }',
  ].join('\n'));
  assert.deepEqual(runnerOk, []);

  const runnerBad = await lint('packages/studyhub-desktop/adapters/cli/process-runner.mjs', [
    'import { exec, execSync } from "node:child_process";',
    'export const run = () => [exec, execSync];',
  ].join('\n'));
  assert.ok(runnerBad.some((m) => m.includes('no-restricted-syntax') && m.includes('exec')));

  const uiMsgs = await lint('ui/desktop/Bad.jsx', 'export function bad(a) { a = 1; if (a == 1) { if (a) { if (a) { if (a) { return 1; } } } } }\n');
  assert.ok(uiMsgs.some((m) => m.includes('no-param-reassign')));
  assert.ok(uiMsgs.some((m) => m.includes('max-depth')));
  assert.ok(uiMsgs.some((m) => m.includes('consistent-return')));
});
