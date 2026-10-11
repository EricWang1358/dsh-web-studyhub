/* 资料清点 (the inventory of a course's materials): the first stage of 生成总纲 and 生成复习全书. Every page range of every material is read once, in parallel
   at the learner's text concurrency, each range its own place in a call that is retried alone; anchors are checked word for word (an unverifiable one is kept,
   flagged); near-duplicates are merged; an unchanged range is never asked again. The synthetic 134-material library and a fake model: no real model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StudyService } from '../lib/service.js';
import { settleJob } from './helpers/wait.mjs';
import { privateRoot } from './helpers/model-family-baseline.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { COURSE, outlineLibrary, outlineModel } from './helpers/course-outline-library.mjs';
import { isCourseInventorySource, isLibraryListSource } from '../lib/exam-point-list.js';
import { inventoryCoverage, itemId, nameKey } from '../lib/course-book-inventory.js';
import { buildOutlineIndex } from '../lib/course-outline-index.js';
import { courseRanges, inventoryCalls } from '../lib/contexts/generation/inventory/ranges.js';
import { RANGE_CHARS } from '../lib/contexts/generation/inventory/constants.js';
import { createParallel } from '../lib/contexts/generation/inventory/parallel.js';

const PAPER = 'doc:document-paper-2025';

async function world(t, { fake = outlineModel(), library = {}, extra = [] } = {}) {
  const root = await privateRoot(t, 'book-inventory-');
  const service = new StudyService(root, { complete: fake.complete, ...switchOptions('runtime', { complete: fake.complete, paths: [] }) });
  t.after(() => service.dispose());
  const { sources, decks } = outlineLibrary(library);
  await service.store.update(state => { state.sources.push(...structuredClone([...sources, ...extra])); state.decks.push(...structuredClone(decks)); state.focus = { mode: 'class', course: COURSE }; });
  const build = async (args = {}) => {
    const job = await settleJob(service, (await service.call('generation.courseOutline.build', { course: COURSE, language: 'zh', ...args })).jobId);
    assert.equal(job.status, 'complete', JSON.stringify(job.error ?? null));
    return job;
  };
  const inventories = async () => (await service.store.read()).sources.filter(isCourseInventorySource);
  return { service, fake, build, inventories, of: stage => fake.calls.filter(call => call.stage === stage) };
}

test('every page of every material is in exactly one range of whole pages, a paper and an empty material are listed with the reason', async () => {
  const { sources, decks } = outlineLibrary({ paper: true });
  const blank = { id: 'scan-1', title: 'Scanned handout', text: '   ', createdAt: '2026-09-30T00:00:00.000Z', courses: [COURSE], document: { materialId: 'document-scan', format: 'pdf' } };
  const state = { sources: [...sources, blank], decks, documents: [] };
  const documents = buildOutlineIndex(state, { course: COURSE }).allDocuments;
  const { ranges, documents: docs } = courseRanges(state, documents, { papers: new Set([PAPER]), language: 'zh' });
  assert.equal(docs.length, documents.length, 'every material is listed');
  assert.deepEqual(docs.filter(doc => doc.reason).map(doc => [doc.title, doc.reason]), [['SA 2025 样卷', 'paper'], ['Scanned handout', 'no-text']]);
  const byId = new Map(state.sources.map(source => [source.id, source]));
  for (const doc of documents.filter(item => !docs.find(each => each.key === item.key).reason)) {
    const pieces = ranges.filter(range => range.doc === doc.key).flatMap(range => range.pieces);
    assert.deepEqual(pieces.map(piece => piece.sourceId), doc.sourceIds.filter(id => byId.get(id)?.text?.trim()), `${doc.title}: each page once, in order`);
    assert.ok(pieces.every(piece => piece.start === 0 && piece.end === byId.get(piece.sourceId).text.length), 'whole pages');
  }
  assert.ok(ranges.every(range => range.chars <= RANGE_CHARS));
  const calls = inventoryCalls(ranges);
  assert.equal(new Set(calls.flatMap(call => call.ranges.map(range => range.print))).size, new Set(ranges.map(range => range.print)).size, 'a copy is read once');
  assert.ok(calls.every(call => call.ranges.reduce((sum, range) => sum + range.chars, 0) <= 15000 || call.ranges.length === 1));
});

test('a long material is cut into ranges of whole pages; a page bigger than a range alone is cut at a line', () => {
  const page = n => ({ id: `big-p${n}`, title: `Big · p. ${n}`, text: `${'Paging fact 1: a page of the long lecture. '.repeat(160)}\n`, createdAt: '2026-09-01T00:00:00.000Z', courses: ['Big'],
    document: { materialId: 'document-big', page: n, totalPages: 9, format: 'pdf' } });
  const huge = { ...page(9), id: 'big-p9', text: 'A line of a very long page.\n'.repeat(1400) };
  const state = { sources: [...Array.from({ length: 8 }, (_, at) => page(at + 1)), huge], decks: [], documents: [] };
  const documents = buildOutlineIndex(state, { course: 'Big' }).allDocuments;
  const { ranges } = courseRanges(state, documents, { language: 'zh' });
  assert.ok(ranges.length >= 4 && ranges.every(range => range.chars <= RANGE_CHARS));
  assert.deepEqual(ranges.slice(0, -2).map(range => [range.from, range.to]).flat().filter(Number.isInteger).length % 2, 0);
  assert.ok(ranges.filter(range => range.pieces.some(piece => piece.sourceId === 'big-p9')).length >= 2, 'the huge page is cut');
  assert.ok(ranges.flatMap(range => range.pieces).filter(piece => piece.sourceId !== 'big-p9').every(piece => piece.start === 0), 'the other pages stay whole');
});

test('the 134-material course: every range read once in a handful of calls, items merged across materials, the record hidden; a rerun asks nothing', async t => {
  const w = await world(t, { library: { paper: true } });
  await w.build();
  const calls = w.of('inventory'), asked = calls.flatMap(call => call.data.ranges);
  const [record] = await w.inventories(), inventory = record.courseInventory;
  t.diagnostic(`inventory calls for 134 materials: ${calls.length} (${inventory.ranges.length} ranges, ${inventory.items.length} items)`);
  assert.ok(calls.length >= 3 && calls.length <= 12, `a handful of calls: ${calls.length}`);
  assert.ok(calls.every(call => call.data.ranges.reduce((sum, range) => sum + range.text.length, 0) <= 15500), 'every call modest');
  assert.equal(asked.length, new Set(inventory.ranges.map(range => range.print)).size, 'one place per distinct range, never twice');
  assert.ok(inventory.ranges.every(range => range.status === 'read'));
  assert.ok(!asked.some(range => /Q1 Explain the difference/.test(range.text)), 'the sample paper is not inventoried');
  assert.deepEqual(inventory.documents.filter(doc => doc.reason).map(doc => doc.reason), ['paper']);
  // One item per name: "Views and viewpoints fact 0" is taught by lecture 1, its second import, notes and handouts.
  const views = inventory.items.find(item => item.name === 'Views and viewpoints fact 0');
  assert.ok(views.places.length > 2 && new Set(views.places.map(place => place.doc)).size > 2, 'merged across materials and versions');
  assert.equal(views.id, itemId('views and viewpoints FACT 0'));
  const state = await w.service.store.read(), byId = new Map(state.sources.map(source => [source.id, source]));
  for (const item of inventory.items) for (const place of item.places.filter(each => each.verified)) {
    assert.equal(byId.get(place.sourceId).text.slice(place.start, place.end).replace(/\s+/g, ' ').trim(), place.quote, 'a verified anchor is the original\'s own words at its place');
  }
  const coverage = inventoryCoverage(inventory);
  assert.deepEqual([coverage.documents.used, coverage.documents.total, coverage.pages.read === coverage.pages.total], [coverage.documents.total, 133, true]);
  // Hidden: a machine-owned record, never a material.
  assert.ok(isLibraryListSource(record));
  const snapshot = await w.service.call('snapshot');
  assert.ok(!snapshot.sources.some(source => source.id === record.id));
  assert.ok(!(await w.service.call('source.list', {})).sources.some(source => source.id === record.id));
  await assert.rejects(w.service.call('generate', { sourceIds: [record.id], kind: 'quiz', count: 3 }), error => error.code === 'course-inventory-not-material');
  // A rerun: every range has the same print, nothing is asked, nothing written.
  const before = w.fake.calls.length;
  await w.build();
  assert.equal(w.of('inventory').length, calls.length, 'no inventory call the second time');
  assert.deepEqual(w.fake.calls.slice(before).map(call => call.stage), ['map', 'reduce', 'paper'], 'only the outline itself (the paper is found by its name)');
  assert.deepEqual((await w.inventories()).map(item => item.id), [record.id]);
});

test('one changed page: only its range is read again; the old inventory is replaced, not archived', async t => {
  const w = await world(t);
  await w.build();
  const [first] = await w.inventories(), count = w.of('inventory').length;
  await w.service.store.update(state => { state.sources.find(source => source.id === 'document-l3-p1').text += ' Layers fact 9: a new rule about layering.'; });
  await w.build();
  const again = w.of('inventory').slice(count);
  assert.equal(again.length, 1);
  assert.deepEqual(again[0].data.ranges.map(range => range.material), ['03. Architecture Patterns v2.1']);
  const all = await w.inventories();
  assert.equal(all.length, 1, 'the old inventory is removed (a cache)');
  assert.notEqual(all[0].id, first.id);
  assert.ok(all[0].courseInventory.items.some(item => item.name === 'Layers fact 9'));
});

test('an anchor that is not in the range is kept and flagged unverified; a failed call leaves only its ranges unread', async t => {
  const w = await world(t, { fake: outlineModel({ inventory: 'invent' }) });
  await w.build();
  const [record] = await w.inventories();
  assert.ok(record.courseInventory.items.length > 20);
  assert.ok(record.courseInventory.items.every(item => item.places.every(place => !place.verified && place.start === place.end)), 'kept, flagged, placed at its range');
  assert.equal(inventoryCoverage(record.courseInventory).unverified, record.courseInventory.items.length);
  const f = await world(t, { fake: outlineModel({ fail: call => call.stage === 'inventory' && call.data.part === 2 }) });
  await f.build();
  const [partial] = await f.inventories(), failed = partial.courseInventory.ranges.filter(range => range.status === 'failed');
  assert.ok(failed.length > 0 && failed.length < partial.courseInventory.ranges.length, 'only the ranges of the failed call');
  assert.equal(f.of('inventory').filter(call => call.data.part === 2).length, 2, 'asked once more, then left alone');
  const before = f.of('inventory').length;
  f.fake.calls.length = 0;
  await f.build();
  assert.deepEqual(f.of('inventory').map(call => call.data.ranges.length), [new Set(failed.map(range => range.print)).size], `the next build reads only what failed (${before} calls before)`);
});

test('names that differ in case, width, punctuation or a bracketed gloss are one item', () => {
  assert.equal(nameKey('威胁建模（threat modelling）'), nameKey('威胁建模'));
  assert.equal(nameKey('CIA Triad'), nameKey('cia-triad'));
  assert.notEqual(nameKey('Availability'), nameKey('Reliability'));
});

/** A context of the runtime as a parallel stage sees it, with a fake gateway: `complete(key, system, prompt)` answers each call. */
function fakeContext(complete) {
  const steps = [];
  const gateway = { step: (key, policy, options) => ({ complete: (system, prompt) => { steps.push({ key, policy, labels: options.labels }); return complete(key, system, prompt); },
    reuse: async () => { steps.push({ key, reused: true }); }, run: operation => operation(), observe: (_meta, operation) => operation() }) };
  return { context: { gateway, signal: new AbortController().signal, pauseRequested: false, attemptId: 'attempt-1' }, kept: { results: new Map() }, state: { reused: 0 }, show: () => {},
    boundary: () => false, steps };
}

test('the pool never runs more calls at once than the text concurrency, and a 429 lowers it; the refused call is asked again, not failed', async () => {
  let running = 0, most = 0, refusals = 1;
  const ctx = fakeContext(async () => {
    running++; most = Math.max(most, running);
    await new Promise(resolve => setTimeout(resolve, 15));
    running--;
    if (refusals-- > 0) throw Object.assign(new Error('Too many requests'), { status: 429 });
    return '{"ok":true}';
  });
  const parallel = createParallel(ctx, { limit: 2 });
  const answers = await parallel.each(Array.from({ length: 8 }, (_, at) => at), at => parallel.ask(`k${at}`, { stage: 'inventory', part: at + 1 }, { purpose: 'inventory' },
    { system: 's', prompt: 'p' }, text => JSON.parse(text)), 'test');
  assert.equal(answers.filter(Boolean).length, 8, 'all answered, the refused one too');
  assert.ok(most <= 2, `at most 2 at once (was ${most})`);
  assert.equal(ctx.state.pool.lowered, true, 'a 429 lowered the pool');
  assert.ok(ctx.steps.every(step => step.reused || Number.isInteger(step.labels.slot)), 'each call names its lane');
  // A retry of the same Job: the calls that finished are answered from what was kept.
  const again = createParallel(ctx, { limit: 2 });
  await again.each([0, 1], at => again.ask(`k${at}`, {}, { purpose: 'inventory' }, { system: 's', prompt: 'p' }, text => JSON.parse(text)), 'test');
  assert.equal(ctx.state.reused, 2);
});

test('a call that fails twice fails alone; a pause lets the running calls end and starts no new one', async () => {
  const ctx = fakeContext(async key => { if (key.startsWith('bad')) throw new Error('provider down'); await new Promise(resolve => setTimeout(resolve, 5)); return '{"ok":true}'; });
  const parallel = createParallel(ctx, { limit: 3 });
  const answers = await parallel.each(['good-1', 'bad-1', 'good-2'], key => parallel.ask(key, {}, { purpose: 'write' }, { system: 's', prompt: 'p' }, text => JSON.parse(text)), 'test');
  assert.deepEqual(answers.map(Boolean), [true, false, true]);
  assert.equal(ctx.steps.filter(step => step.key.startsWith('bad')).length, 2, 'asked once more, then left alone');
  let asked = 0;
  const p = fakeContext(async () => { asked++; if (asked === 2) p.context.pauseRequested = true; await new Promise(resolve => setTimeout(resolve, 5)); return '{"ok":true}'; });
  p.boundary = () => { throw Object.assign(new Error('paused'), { code: 'checkpoint-pause' }); };
  const paused = createParallel(p, { limit: 1 });
  await assert.rejects(paused.each([1, 2, 3, 4, 5], at => paused.ask(`p${at}`, {}, { purpose: 'write' }, { system: 's', prompt: 'p' }, text => JSON.parse(text)), 'write'),
    error => error.code === 'checkpoint-pause');
  assert.equal(asked, 2, 'no call started after the pause');
  assert.equal(p.kept.results.size, 2, 'what finished is kept for the resume');
});
