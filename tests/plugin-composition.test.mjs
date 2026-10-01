import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import * as bank from '../lib/plugins/bank.js';
import * as workbench from '../lib/plugins/composition.js';
import { Store } from '../lib/store.js';
import { acquireContexts } from '../lib/runtime/lifecycle.js';

const turn = () => new Promise(resolve => setTimeout(resolve, 20));

test('failed context acquisition leaves no provider or partially installed capabilities', async t => {
  const ctx = new Context(), tools = new Map();
  let rejectMaterials = false;
  ctx.provide('tools', { register(definition) {
    if (rejectMaterials && definition.name === 'study_materials') throw new Error('Tool registration refused');
    tools.set(definition.name, definition);
    return () => tools.delete(definition.name);
  } });
  t.after(() => ctx.fiber.dispose());
  assert.throws(() => acquireContexts(ctx, ['bank', 'unknown']), /Unknown context/);
  assert.equal(ctx.studyRuntime, undefined);
  assert.equal(tools.size, 0);
  const installed = acquireContexts(ctx, ['bank']);
  const directory = await mkdtemp(join(tmpdir(), 'study-acquisition-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const library = installed.api.forLibrary(directory);
  rejectMaterials = true;
  assert.throws(() => acquireContexts(ctx, ['materials']), /Tool registration refused/);
  assert.deepEqual(installed.api.contextIds(), ['bank']);
  assert.deepEqual(library.describe().map(context => context.api), ['bank.v1']);
  rejectMaterials = false;
  const materials = acquireContexts(ctx, ['materials']);
  materials.release();
  installed.release();
  assert.equal(ctx.studyRuntime, undefined);
  assert.equal(tools.size, 0);
});

test('real Cordis composes standalone then workbench and unloads only final-owned capabilities', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-composition-'));
  const ctx = new Context();
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
  const standalone = ctx.plugin(bank);
  await turn();
  assert.deepEqual(ctx.studyRuntime.contextIds(), ['bank']);
  assert.equal((await ctx.studyRuntime.forLibrary(root).call('bank.list')).decks.length, 0);
  const composed = ctx.plugin(workbench);
  await turn();
  assert.equal(ctx.studyRuntime.contextIds().filter(id => id === 'bank').length, 1);
  await standalone.dispose();
  assert.ok(ctx.studyRuntime.contextIds().includes('bank'));
  await composed.dispose();
  assert.equal(ctx.studyRuntime, undefined);
});

test('real Cordis composes workbench then standalone with one provider and one bank tool', async t => {
  const ctx = new Context();
  const tools = new Map();
  ctx.provide('tools', { register(definition) {
    if (tools.has(definition.name)) throw new Error('Duplicate tool');
    tools.set(definition.name, definition);
    return () => tools.delete(definition.name);
  } });
  t.after(() => ctx.fiber.dispose());
  const composed = ctx.plugin(workbench);
  await turn();
  const standalone = ctx.plugin(bank);
  await turn();
  assert.equal([...tools.keys()].filter(name => name === 'study_bank').length, 1);
  await composed.dispose();
  assert.equal(tools.has('study_bank'), true);
  await standalone.dispose();
  assert.equal(tools.has('study_bank'), false);
});

test('independently installed module copies share the scope identity and final-owner disposal', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'study-plugin-copy-'));
  const ctx = new Context();
  t.after(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); });
  await cp(new URL('../lib/', import.meta.url), join(directory, 'lib'), { recursive: true });
  await cp(new URL('../references/', import.meta.url), join(directory, 'references'), { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
  await symlink(fileURLToPath(new URL('../node_modules/', import.meta.url)), join(directory, 'node_modules'), 'junction');
  const independentBank = await import(pathToFileURL(join(directory, 'lib/plugins/bank.js')).href);
  const original = ctx.plugin(bank);
  await original;
  const copied = ctx.plugin(independentBank);
  await copied;
  assert.deepEqual(ctx.studyRuntime.contextIds(), ['bank']);
  await original.dispose();
  assert.deepEqual(ctx.studyRuntime.contextIds(), ['bank']);
  await copied.dispose();
  assert.equal(ctx.studyRuntime, undefined);
});

test('compact tools await the host binding and request services, and disposed hooks restore the previous owner', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'study-plugin-binding-'));
  const ctx = new Context();
  const tools = new Map();
  ctx.provide('tools', { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); } });
  t.after(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); });
  const installed = ctx.plugin(bank);
  await installed;
  await new Store(directory).update(state => { state.decks.push({ id: 'bound', title: 'Bound library', cards: [] }); });
  let servicesRead = 0;
  const previous = ctx.studyRuntime.configureHost({ resolveWorkspace: async () => directory,
    requestServices: async () => { servicesRead++; return {}; } });
  const newer = ctx.studyRuntime.configureHost({ resolveWorkspace: async () => 'newer-owner' });
  assert.equal(await ctx.studyRuntime.resolveWorkspace({}), 'newer-owner');
  newer(); newer();
  const result = await tools.get('study_bank').execute({ operation: 'list' }, { agent: { session: { header: { cwd: 'wrong-session-workspace' } } } });
  assert.equal(result.decks[0].title, 'Bound library');
  assert.equal(servicesRead, 1);
  previous();
});
