/* #489 item 6: what the book page needs to say about upkeep without going to the 总纲 page: materials changed since the outline (`outdated`), a point left short (`short`),
   补漏 of one point while materials changed (never rewriting the outline or hiding `outdated`), and the model gate on 补漏. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';
import { planBook } from '../lib/contexts/generation/book/plan.js';
import { inventoryRecord } from '../lib/contexts/generation/inventory/stage.js';
import { courseOutlineMaterial } from '../lib/course-outline-book.js';
import { buildOutlineIndex } from '../lib/course-outline-index.js';
import { bookService, COURSE } from './helpers/book-agent-library.mjs';
import { settleJob } from './helpers/wait.mjs';
import { privateRoot } from './helpers/model-family-baseline.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { outlineLibrary } from './helpers/course-outline-library.mjs';
import { bookModel } from './helpers/course-book-model.mjs';
import { loadUi } from './helpers/ui-module.mjs';

const POINTS = (lecture, lectureKey) => [{ id: 'c1', title: '第 1 章', children: ['一', '二'].map((title, at) => ({ id: `p${at + 1}`, title: `知识点${title}`, anchors: [`${lectureKey}#${at}`] })) }];
const leavesOf = nodes => (nodes || []).flatMap(node => (node.leaf ? [node] : leavesOf(node.children)));
const stageCounts = calls => calls.reduce((acc, call) => ({ ...acc, [call.stage]: (acc[call.stage] || 0) + 1 }), {});

test('course.book.open says outdated only when the course\'s materials changed since the outline', async t => {
  const { study } = await bookService(t, { chapters: POINTS });
  assert.equal((await study.call('course.book.open')).outdated, undefined);
  await study.call('source.add', { title: 'A new lecture', text: 'New material for this course.', course: COURSE });
  assert.equal((await study.call('course.book.open')).outdated, true);
});

test('a point left short says so; a complete one says nothing', async t => {
  const { study } = await bookService(t, { chapters: POINTS });
  await study.store.update(state => {
    const notes = state.sources.find(source => source.provenance === 'course-outline-notes');
    notes.courseNotes.leaves[0].body.status = 'short';
  });
  const [one, two] = (await study.call('course.book.open')).nodes[0].children;
  assert.equal(one.short, true);
  assert.equal(two.short, undefined);
});

test('补漏 when materials changed mends only that point without rewriting the outline or hiding outdated, and fails honestly without a model', async t => {
  const fake = bookModel({ omit: 1, stubborn: ['Layers'] });
  let unavailable = false, thrown = 0;
  const complete = async (...args) => {
    if (unavailable) { thrown++; throw Object.assign(new Error('No model route'), { code: 'model-unavailable' }); }
    return fake.complete(...args);
  };
  const root = await privateRoot(t, 'book-upkeep-stale-');
  const service = new StudyService(root, { complete, ...switchOptions('runtime', { complete, paths: [] }) });
  t.after(() => service.dispose());
  const built = outlineLibrary({});
  await service.store.update(state => {
    state.sources.push(...structuredClone(built.sources));
    state.decks.push(...structuredClone(built.decks));
    state.focus = { mode: 'class', course: COURSE };
  });
  const runBuild = async args => {
    const started = await service.call('generation.courseBook.build', { course: COURSE, language: 'zh', ...args });
    return settleJob(service, started.jobId);
  };
  assert.equal((await runBuild({})).status, 'complete');
  let book = await service.call('course.book.open', { course: COURSE });
  const shortLeaf = leavesOf(book.nodes).find(node => node.short);
  assert.equal(shortLeaf?.title, 'Layers');
  const point = String(shortLeaf.key).replace(/^bk:/, '');
  const beforeDocs = book.coverage.documents;

  // Add a brand-new lecture so both the book page (`outdated`) and the 总纲 page (`stale`, `notes.stale`) show the course needs an update.
  await service.call('source.add', { title: 'New lecture', text: 'Brand new topic about quorum consensus. '.repeat(60), course: COURSE });
  assert.equal((await service.call('course.book.open', { course: COURSE })).outdated, true);
  const midOutline = await service.call('course.outline', { course: COURSE });
  assert.deepEqual([midOutline.book.stale, midOutline.book.notes.stale], [true, true]);

  // 补漏 on the short point while materials are outdated: zero inventory / cluster / order calls, outline and outdated stay as they are.
  fake.opts.stubborn = [];
  const mark = fake.calls.length;
  assert.equal((await runBuild({ point })).status, 'complete');
  assert.deepEqual(stageCounts(fake.calls.slice(mark)), { review: 2, repair: 1 });
  book = await service.call('course.book.open', { course: COURSE });
  const postOutline = await service.call('course.outline', { course: COURSE });
  assert.equal(book.outdated, true, 'the book page still offers 更新全书 for the new lecture');
  assert.deepEqual([postOutline.book.stale, postOutline.book.notes.stale], [true, true], 'the 总纲 page still says the materials changed');
  assert.deepEqual(leavesOf(book.nodes).filter(node => node.short).map(node => node.title), [], 'the short point itself is mended');
  assert.deepEqual(leavesOf(book.nodes).filter(node => !String(node.gen).trim()).map(node => node.title), [], 'no blank point was slipped into the book');
  assert.deepEqual(book.coverage.documents, beforeDocs, 'unread new material is not counted as read');
  assert.equal(JSON.stringify(book.nodes).includes('quorum'), false);

  // Subsequent 更新全书 reads the new lecture, keeps the mended point, and clears outdated.
  const updateMark = fake.calls.length;
  assert.equal((await runBuild({})).status, 'complete');
  assert.equal(fake.calls.slice(updateMark).some(call => call.data.point?.title === 'Layers'), false, 'the mended point is kept');
  book = await service.call('course.book.open', { course: COURSE });
  const finalOutline = await service.call('course.outline', { course: COURSE });
  assert.equal(book.outdated, undefined);
  assert.deepEqual([finalOutline.book.stale, finalOutline.book.notes.stale], [false, false]);
  assert.equal(JSON.stringify(book.nodes).includes('quorum'), true, 'the new lecture is now written into the book');

  // Without a model route, a direct 补漏 call fails at once instead of claiming the book was saved.
  await service.store.update(state => {
    const notes = state.sources.find(source => source.provenance === 'course-outline-notes' && !source.archived);
    notes.courseNotes.leaves[0].body.status = 'short';
    notes.courseNotes.leaves[0].body.units[0].status = 'short';
  });
  const anyPoint = String(leavesOf((await service.call('course.book.open', { course: COURSE })).nodes)[0].key).replace(/^bk:/, '');
  unavailable = true;
  const failedJob = await runBuild({ point: anyPoint });
  assert.equal(failedJob.status, 'failed');
  assert.equal(thrown, 1, 'a missing model is not retried or swallowed as a saved partial build');
});

test('LeafNotes disables 补漏 and 读更多 when no model is ready', async () => {
  const uiMod = await loadUi(`
    import React from 'react';
    import LeafNotes from './ui/outline/LeafNotes.jsx';
    export const renderLeaf = modelReady => React.createElement(LeafNotes, { modelReady, onReadMore() {}, notes: { id: 'p1', concepts: { covered: 2, total: 3 },
      coverage: { unit: 'pages', read: 1, total: 2, more: 'full' }, body: { text: 'Body', cites: [], status: 'short', coverage: { missing: [{ id: 'i1', name: 'Layers' }] } } } });
  `);
  const off = renderToStaticMarkup(uiMod.renderLeaf(false));
  const buttonsOff = off.match(/<button[^>]*>[\s\S]*?<\/button>/g) || [];
  assert.equal(buttonsOff.length, 2);
  assert.ok(buttonsOff.every(button => /\bdisabled\b/.test(button)), `without a model both buttons are disabled: ${buttonsOff.join(' | ')}`);
  const on = renderToStaticMarkup(uiMod.renderLeaf(true));
  const buttonsOn = on.match(/<button[^>]*>[\s\S]*?<\/button>/g) || [];
  assert.ok(buttonsOn.every(button => !/\bdisabled\b/.test(button)), 'with a ready model both buttons are enabled');
});

test('planBook for one point inventories only that point\'s unread material and keeps earlier entries for edited other lectures', () => {
  const sources = [
    { id: 's1', title: 'Lecture 1', text: 'Alpha concept explained clearly here.', courses: [COURSE] },
    { id: 's2', title: 'Lecture 2', text: 'Beta concept explained clearly here.', courses: [COURSE] },
  ];
  const state = { sources, decks: [], documents: [] };
  const [d1, d2] = buildOutlineIndex(state, { course: COURSE }).allDocuments;
  const outline = courseOutlineMaterial({ title: 'Outline', course: COURSE, language: 'zh', orderBasis: { codes: ['logic'] }, fingerprint: '12345678',
    nodes: [{ id: 'c1', title: 'Ch 1', children: [{ id: 'p1', title: 'P1', anchors: [d1.key] }, { id: 'p2', title: 'P2', anchors: [d2.key] }] }] });
  state.sources.push(outline);
  const full = planBook(state, { course: COURSE, language: 'zh' });
  const initialFound = new Map(full.inventory.ranges.map((range, at) => [range.print,
    [{ kind: 'concept', name: at ? 'Beta' : 'Alpha', gist: 'g', quote: at ? 'Beta concept explained' : 'Alpha concept explained' }]]));
  state.sources.push(inventoryRecord(full, full.inventory, initialFound));

  // Edit BOTH existing lectures and add a third brand-new lecture; filling gaps of p1 reads ONLY Lecture 1 and preserves Lecture 2's earlier inventory.
  sources[0].text = 'Alpha concept revised with new paragraph.';
  sources[1].text = 'Beta concept revised elsewhere in the course.';
  sources.push({ id: 's3', title: 'Lecture 3', text: 'Gamma brand new lecture.', courses: [COURSE] });
  const scoped = planBook(state, { course: COURSE, language: 'zh', point: 'p1' });
  assert.equal(scoped.mode, 'keep');
  assert.deepEqual(scoped.inventory.calls.flatMap(call => call.ranges.map(range => range.doc)), [d1.key]);
  const updatedFound = new Map(scoped.inventory.reused);
  updatedFound.set(scoped.inventory.calls[0].ranges[0].print, [{ kind: 'concept', name: 'Alpha', gist: 'g', quote: 'Alpha concept revised' }]);
  const saved = inventoryRecord(scoped, scoped.inventory, updatedFound).courseInventory;
  assert.deepEqual(saved.documents.map(doc => [doc.key, doc.read]), [[d1.key, 1], [d2.key, 1]]);
  assert.deepEqual(saved.items.map(item => item.name).sort(), ['Alpha', 'Beta']);
});
