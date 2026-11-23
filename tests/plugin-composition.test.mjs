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
import { pageAvailable } from '../ui/capabilities.js';

const turn = () => new Promise(resolve => setTimeout(resolve, 20));

test('independent runtime uses the same waking terminal notifier as the workbench', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'study-runtime-notice-'));
  const ctx = new Context();
  ctx.provide('llm', {});
  const installed = ctx.plugin(bank);
  await installed;
  t.after(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); });
  const pending = [], turns = [];
  const agent = { id: 'initiating-chat', session: { header: { cwd: directory },
    requestHeader: () => ({ config: { provider: 'test', model: 'test' } }) },
    inject: message => pending.push(message), followup: message => turns.push(message) };
  const services = await ctx.studyRuntime.requestServices({ agent });
  assert.equal(typeof services.notify, 'function');
  services.notify({ text: 'Final receipt', summary: 'Done', wakeup: true });
  assert.equal(turns.length, 1);
  assert.equal(turns[0].source.kind, 'plugin:daily-flashcard');
  assert.equal(turns[0].role, 'user');
  assert.ok(turns[0].id);
  services.notify({ text: 'Passive observation', summary: 'Question changed' });
  assert.equal(pending.length, 1);
  assert.equal(turns.length, 1);
});

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
  await assert.rejects(runtime.call('source.remove', { id: 'retained-source' }), /引用|referenced/);
  await installed.get('study-suite-bank').dispose();
  assert.equal(runtime.hasAction('bank.list'), false, 'bundle siblings must not retain bank');
  assert.equal(runtime.hasAction('generate'), true);
  await assert.rejects(runtime.call('source.remove', { id: 'retained-source' }), /启用.*题库/);
  assert.equal((await new Store(root).read()).sources[0].id, 'retained-source', 'disabled references must remain protected');
  const bankRow = rows.find(row => row.id === 'study-suite-bank');
  const restoredBank = ctx.plugin(await import(bankRow.name), bankRow.config);
  await restoredBank;
  assert.equal((await runtime.call('bank.list')).decks[0].id, 'retained-deck', 're-enable retains the citing deck');
  await assert.rejects(runtime.call('source.remove', { id: 'retained-source' }), /引用|referenced/);
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
  const defaultBank = ctx.plugin(bank);
  await defaultBank;
  assert.ok(ctx.studyRuntime.contextIds().includes('bank'));
  assert.ok(ctx.studyRuntime.contextIds().includes('authoring'));
  await defaultBank.dispose();
  assert.deepEqual(ctx.studyRuntime.contextIds(), ['study']);
  const independentBank = ctx.plugin(bank, { independent: true });
  await independentBank;
  assert.deepEqual(ctx.studyRuntime.contextIds(), ['study', 'bank']);
  await independentBank.dispose();
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
  assert.deepEqual(ctx.studyRuntime.contextIds(), ['bank', 'authoring']);
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
  assert.deepEqual(ctx.studyRuntime.contextIds(), ['bank', 'authoring']);
  await original.dispose();
  assert.deepEqual(ctx.studyRuntime.contextIds(), ['bank', 'authoring']);
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

test('disabling study-suite-generation keeps authoring, import, merge, split and Draft page working (#991)', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-no-gen-'));
  const ctx = new Context();
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
  const patch = parseYaml(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'));
  const installed = new Map();
  for (const row of patch.flatMap(layer => layer.insert)) {
    const fiber = ctx.plugin(await import(row.name), row.config);
    await fiber;
    installed.set(row.id, fiber);
  }
  await installed.get('study-suite-generation').dispose();
  const runtime = ctx.studyRuntime.runtimeForLibrary(root);
  assert.equal(runtime.hasAction('generate'), false);
  const snapshot = { ...await runtime.call('snapshot'), contexts: ctx.studyRuntime.contextIds() };
  assert.equal(pageAvailable(snapshot, 'draft'), true, 'Draft & publish page stays available without generation');
  assert.equal(pageAvailable(snapshot, 'generate'), false);

  const cards = (tag) => [
    { id: `${tag}-1`, kind: 'flashcard', topic: 'Topic A', objective: `Obj ${tag} 1`, prompt: `Question ${tag} 1?`, answer: 'Answer 1', hint: 'Hint 1', explanation: 'Explanation 1', misconception: 'Misconception 1', citations: [], importedFromJson: true },
    { id: `${tag}-2`, kind: 'flashcard', topic: 'Topic B', objective: `Obj ${tag} 2`, prompt: `Question ${tag} 2?`, answer: 'Answer 2', hint: 'Hint 2', explanation: 'Explanation 2', misconception: 'Misconception 2', citations: [], importedFromJson: true },
  ];
  const saved = await runtime.call('draft.save', { deck: { id: 'draft-1', title: 'Manual One', course: 'CS', cards: cards('m1') } });
  const plan = await runtime.call('draft.publish.plan', { id: saved.id, draftVersion: saved.draftVersion });
  assert.equal(plan.expect.receipt.accepted, 2);
  const similar = await runtime.call('draft.similar', { id: saved.id });
  assert.equal(similar.status, 'ok');
  assert.ok(Array.isArray(similar.similar));
  const published = await runtime.call('draft.publish', { id: saved.id, draftVersion: saved.draftVersion });
  assert.equal(published.deckId, 'draft-1');

  const quickSaved = await runtime.call('draft.save', { deck: { id: 'draft-2', title: 'Manual Two', course: 'CS', cards: cards('m2') } });
  const quickPub = await runtime.call('draft.publish.quick', { id: quickSaved.id, draftVersion: quickSaved.draftVersion });
  assert.equal(quickPub.deckId, 'draft-2');

  const imported = await runtime.call('deck.import', { text: JSON.stringify({ title: 'Imported Deck', course: 'CS',
    cards: [{ kind: 'flashcard', topic: 'Topic C', prompt: 'Imported prompt?', answer: 'Imported answer.' }] }) });
  assert.equal(imported.imported, 1);
  assert.equal((await new Store(root).read()).sources.length, 1, 'with materials enabled, deck.import still saves JSON provenance');

  const split = await runtime.call('deck.split', { id: published.deckId, title: 'Split Part', topics: ['Topic B'] });
  assert.equal(split.moved, 1);
  const merged = await runtime.call('deck.merge', { sourceIds: [split.targetId, quickPub.deckId], targetId: published.deckId });
  assert.equal(merged.count, 4);
});

test('standalone bank + study works without materials or generation (#991)', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-bank-study-'));
  const ctx = new Context();
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
  await ctx.plugin(bank);
  await ctx.plugin(study);
  assert.ok(ctx.studyRuntime.contextIds().includes('bank'));
  assert.ok(ctx.studyRuntime.contextIds().includes('authoring'));
  assert.ok(ctx.studyRuntime.contextIds().includes('study'));
  assert.equal(ctx.studyRuntime.contextIds().includes('materials'), false);
  assert.equal(ctx.studyRuntime.contextIds().includes('generation'), false);
  const runtime = ctx.studyRuntime.runtimeForLibrary(root);

  const imported = await runtime.call('deck.import', { text: JSON.stringify({ title: 'Standalone Import', course: 'Net',
    cards: [{ kind: 'flashcard', topic: 'TCP', prompt: 'SYN-ACK role?', answer: 'Acknowledge SYN and synchronize.' }] }) });
  assert.equal(imported.imported, 1);

  const saved = await runtime.call('draft.save', { deck: { id: 'std-1', title: 'Standalone Authoring', course: 'Net', cards: [
    { id: 's1', kind: 'flashcard', topic: 'A', objective: 'Obj 1', prompt: 'S1?', answer: 'A1', hint: 'H1', explanation: 'E1', misconception: 'M1', citations: [], importedFromJson: true },
    { id: 's2', kind: 'flashcard', topic: 'B', objective: 'Obj 2', prompt: 'S2?', answer: 'A2', hint: 'H2', explanation: 'E2', misconception: 'M2', citations: [], importedFromJson: true },
  ] } });
  const pub = await runtime.call('draft.publish', { id: saved.id, draftVersion: saved.draftVersion });
  const split = await runtime.call('deck.split', { id: pub.deckId, title: 'Standalone Split', topics: ['B'] });
  const merged = await runtime.call('deck.merge', { sourceIds: [split.targetId], targetId: pub.deckId });
  assert.equal(merged.count, 2);

  const run = await runtime.call('review.start', { scope: [{ deckId: pub.deckId }], mode: 'path' });
  assert.equal(run.total, 2);
});
