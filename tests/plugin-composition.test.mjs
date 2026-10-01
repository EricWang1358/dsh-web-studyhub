import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import * as bank from '../lib/plugins/bank.js';
import * as generation from '../lib/plugins/generation.js';
import * as study from '../lib/plugins/study.js';
import * as workbench from '../lib/plugins/composition.js';
import { Store } from '../lib/store.js';
import { acquireContexts } from '../lib/runtime/lifecycle.js';

const turn = () => new Promise(resolve => setTimeout(resolve, 20));

test('published bundle imports its real package exports and allows independent capability removal', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-bundle-'));
  const ctx = new Context();
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
  const patch = parseYaml(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'));
  const rows = patch.flatMap(layer => layer.insert);
  const installed = new Map();
  for (const row of rows) {
    const fiber = ctx.plugin(await import(row.name), row.config);
    await fiber;
    installed.set(row.id, fiber);
  }
  const runtime = ctx.studyRuntime.runtimeForLibrary(root);
  assert.equal((await runtime.call('bank.list')).decks.length, 0);
  assert.equal(runtime.hasAction('generate'), true);
  assert.equal(runtime.hasAction('audio.settings.get'), true);
  await runtime.call('source.add', { id: 'retained-source', title: 'Source', text: 'original evidence' });
  await new Store(root).update(state => {
    state.decks.push({ id: 'retained-deck', title: 'Retained deck', cards: [{ id: 'retained-card', kind: 'flashcard',
      prompt: 'Question', answer: 'Answer', citations: [{ sourceId: 'retained-source', quote: 'original evidence' }] }] });
  });
  await assert.rejects(runtime.call('source.remove', { id: 'retained-source' }), /referenced/);
  await installed.get('study-suite-bank').dispose();
  assert.equal(runtime.hasAction('bank.list'), false, 'bundle siblings must not retain bank');
  assert.equal(runtime.hasAction('generate'), true);
  await assert.rejects(runtime.call('source.remove', { id: 'retained-source' }), /启用.*题库/);
  assert.equal((await new Store(root).read()).sources[0].id, 'retained-source', 'disabled references must remain protected');
  const bankRow = rows.find(row => row.id === 'study-suite-bank');
  const restoredBank = ctx.plugin(await import(bankRow.name), bankRow.config);
  await restoredBank;
  assert.equal((await runtime.call('bank.list')).decks[0].id, 'retained-deck', 're-enable retains the citing deck');
  await assert.rejects(runtime.call('source.remove', { id: 'retained-source' }), /referenced/);
  await installed.get('study-suite-learning').dispose();
  await assert.rejects(runtime.call('source.remove', { id: 'retained-source' }), /启用.*学习/);
  await installed.get('study-suite-materials').dispose();
  assert.equal(runtime.hasAction('materials.document.list'), false, 'generation must not retain materials');
  await installed.get('study-suite-audio').dispose();
  assert.equal(runtime.hasAction('audio.settings.get'), false, 'workbench must not retain audio');
  assert.equal(runtime.hasAction('snapshot'), true, 'remaining workbench still provides its public snapshot');
});

test('standalone defaults retain dependencies while independent leaves only own their domains', async t => {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  const practice = ctx.plugin(study);
  await practice;
  assert.deepEqual(ctx.studyRuntime.contextIds(), ['bank', 'study']);
  const writing = ctx.plugin(generation);
  await writing;
  assert.ok(ctx.studyRuntime.contextIds().includes('materials'));
  await practice.dispose();
  assert.ok(ctx.studyRuntime.contextIds().includes('bank'), 'standalone generation retains its required bank');
  await writing.dispose();
  assert.equal(ctx.studyRuntime, undefined);
  const independentPractice = ctx.plugin(study, { independent: true });
  await independentPractice;
  assert.deepEqual(ctx.studyRuntime.contextIds(), ['study']);
  const independentWriting = ctx.plugin(generation, { independent: true });
  await independentWriting;
  assert.deepEqual(ctx.studyRuntime.contextIds(), ['study', 'authoring', 'generation']);
  await independentWriting.dispose();
  assert.deepEqual(ctx.studyRuntime.contextIds(), ['study']);
});

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
