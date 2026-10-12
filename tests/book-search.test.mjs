/* book.search (docs/review-book-agent.md): the course's search index asked for the pages most relevant to a query, within a knowledge point's materials
   (hid) or the whole course; every status (no-extension, no-index, building, partial, ok); a hit names exactly what source.pages takes. book.coverage
   then says where the index stands and points readNext at the unopened page the index ranks highest; without an index readNext is what it was.
   The search extension is a fake port (tests/helpers/book-index-port.mjs); nothing is indexed anywhere, no model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { sourceKey } from '../lib/retrieval-index.js';
import { indexSummary, searchStatus } from '../lib/contexts/generation/retrieval/book-search.js';
import { pagesIn, pointQuery, rankedReadNext } from '../lib/book-index-rank.js';
import { libraryContracts } from '../lib/study-contracts.js';
import { writesFor } from '../lib/runtime/domain-contracts.js';
import { bookLibrary, COURSE } from './helpers/book-agent-library.mjs';
import { indexPort } from './helpers/book-index-port.mjs';
import { until } from './helpers/wait.mjs';
import { SWITCH_MODE, switchOptions } from './helpers/runtime-switch.mjs';

async function world(t, port, { long = true } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'study-book-search-home-')), root = await mkdtemp(join(tmpdir(), 'study-book-search-'));
  const before = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const study = new StudyService(root, { coach: false, ...(port ? { retrieval: port } : {}), ...switchOptions(SWITCH_MODE, { paths: ['retrievalIndex'] }) });
  t.after(async () => {
    await study.dispose();
    if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before;
    await rm(root, { recursive: true, force: true, maxRetries: 3 }); await rm(home, { recursive: true, force: true, maxRetries: 3 });
  });
  await study.call('snapshot');
  const { state } = bookLibrary({ long });
  await study.store.update(own => { own.sources.push(...state.sources); own.decks.push(...state.decks); own.focus = state.focus; });
  // These tests build by hand: new materials must not start a build of their own (index-follow.test.mjs covers that).
  if (port) await study.call('retrieval.auto.set', { on: false });
  const toc = await study.call('book.toc');
  const build = async () => {
    await study.call('retrieval.index.start', { course: COURSE });
    await until(async () => (await study.call('retrieval.index.status')).status === 'complete', 'the index build');
  };
  return { study, what: toc.toc[1], who: toc.toc[2], build };
}

test('the pure parts: the index summary, the status, page ranges, the point\'s query, the unopened page ranked highest', () => {
  const pages = [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }, { id: 'c', text: 'z' }];
  const manifest = { sources: { a: { hash: 'nope' } } };
  assert.deepEqual(indexSummary(pages, manifest), { pages: 3, indexed: 0, missing: 3 }, 'an edited page counts as missing');
  assert.deepEqual(indexSummary(pages, manifest, { done: 2, total: 9, course: 'X' }).building, { done: 2, total: 9 });
  assert.equal(searchStatus({ extension: false, index: { indexed: 3 }, scopeMissing: 0 }), 'no-extension');
  assert.equal(searchStatus({ extension: true, index: { indexed: 0 }, scopeMissing: 3 }), 'no-index');
  assert.equal(searchStatus({ extension: true, index: { indexed: 0, building: { done: 0, total: 3 } }, scopeMissing: 3 }), 'building');
  assert.equal(searchStatus({ extension: true, index: { indexed: 2 }, scopeMissing: 1 }), 'partial');
  assert.equal(searchStatus({ extension: true, index: { indexed: 3 }, scopeMissing: 0 }), 'ok');
  assert.deepEqual([...pagesIn('1-3,5')], [1, 2, 3, 5]);
  assert.equal(pointQuery({ title: 'Security', missing: ['CIA triad', 'Risk matrix'], headings: ['Ignored'] }), 'Security CIA triad Risk matrix');
  assert.equal(pointQuery({ title: 'Security', headings: ['Threats', 'Security'] }), 'Security Threats');
  const documents = [{ documentId: 'd1', opened: '1-2' }, { documentId: 'd2', opened: '' }];
  const ranked = rankedReadNext(documents, [{ documentId: 'd1', page: 2 }, { documentId: 'd9', page: 1 }, { documentId: 'd2', page: 7 }, { documentId: 'd1', page: 4 }, { documentId: 'd2', page: 7 }]);
  assert.deepEqual(ranked, { readNext: { documentId: 'd2', from: 7, to: 8, by: 'index' }, also: [{ documentId: 'd1', page: 4 }] }, 'opened pages, other documents and repeats are passed over');
  assert.equal(rankedReadNext(documents, [{ documentId: 'd1', page: 1 }]), null);
});

test('book.search without the search extension, and with it before any index: says so, finds nothing, and points to the settings', async t => {
  const none = await world(t, null);
  const off = await none.study.call('book.search', { hid: none.what.hid, query: 'architect decision' });
  assert.equal(off.status, 'no-extension');
  assert.deepEqual(off.hits, []);
  assert.ok(off.index.pages > 0 && off.index.indexed === 0, JSON.stringify(off.index));
  assert.match(off.hint, /Settings > Search extension/);
  const port = indexPort(), fresh = await world(t, port);
  const empty = await fresh.study.call('book.search', { hid: fresh.what.hid, query: 'architect decision' });
  assert.equal(empty.status, 'no-index');
  assert.deepEqual(empty.hits, []);
  assert.equal(port.calls.filter(call => call.name.endsWith('query_documents')).length, 0, 'an empty index is not asked');
  const coverage = await fresh.study.call('book.coverage', { hid: fresh.what.hid });
  assert.equal(coverage.index.status, 'no-index');
  assert.deepEqual([coverage.readNext.from, coverage.readNext.to, coverage.readNext.by], [1, 4, undefined], 'readNext stays as it was');
});

test('book.search with an index: scoped to the point\'s materials (else the course), hits mapped to source.pages\' documentId and page, best first', async t => {
  const port = indexPort(), w = await world(t, port);
  await w.build();
  const course = await w.study.call('book.search', { query: 'Microservices fact' });
  assert.equal(course.status, 'ok');
  assert.ok(course.hits.length > 0 && course.hits.length <= 8, `${course.hits.length} hits`);
  assert.ok(course.hits.some(hit => /Architecture Patterns/.test(hit.title)), 'the course scope reaches the lecture on patterns');
  for (let at = 1; at < course.hits.length; at++) assert.ok(course.hits[at - 1].score >= course.hits[at].score, 'best first');
  const point = await w.study.call('book.search', { hid: w.what.hid, query: 'Stakeholders and concerns fact', limit: 3 });
  assert.equal(point.status, 'ok');
  assert.ok(point.hits.length > 0 && point.hits.length <= 3);
  assert.ok(point.hits.every(hit => /Introduction to Solution Architecture/.test(hit.title)), 'only the point\'s own documents');
  assert.match(point.note, /pointer, never evidence/);
  const [hit] = point.hits;
  assert.deepEqual(Object.keys(hit).sort(), ['documentId', 'page', 'score', 'snippet', 'sourceId', 'title']);
  const shown = await w.study.call('source.pages', { documentId: hit.documentId, from: hit.page, to: hit.page, hid: w.what.hid });
  assert.equal(shown.shown[0].sourceId, hit.sourceId, 'documentId and page are exactly what source.pages takes');
  assert.equal((await w.study.call('book.search', { query: 'x', limit: 999 })).hits.length <= 20, true, 'at most 20');
  const status = await w.study.call('book.search', {});
  assert.deepEqual([status.status, status.hits, status.query], ['ok', [], undefined], 'without a query only the status');
});

test('book.search while the index is missing pages (partial) and while a build is going (building)', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const port = indexPort(), w = await world(t, port);
  await w.build();
  await w.study.call('source.add', { title: 'New handout', text: 'Microservices fact 9: a brand new page.', courses: [COURSE] });
  const partial = await w.study.call('book.search', { query: 'brand new page' });
  assert.equal(partial.status, 'partial');
  assert.equal(partial.index.missing, 1);
  assert.match(partial.hint, /1 of the course's \d+ pages are not in the index yet/);
  assert.equal((await w.study.call('book.search', { hid: w.what.hid, query: 'architect' })).status, 'ok', 'the point\'s own pages are all indexed');
  const slow = indexPort({ gate }), v = await world(t, slow);
  await v.study.call('retrieval.index.start', { course: COURSE });
  const building = await until(async () => { const answer = await v.study.call('book.search', { query: 'architect' }); return answer.status === 'building' && answer; }, 'a running build');
  assert.ok(building.index.building && building.index.building.total > 0, JSON.stringify(building.index));
  assert.match(building.hint, /being built/);
  release();
  await until(async () => (await v.study.call('retrieval.index.status')).status === 'complete', 'the build to end');
});

test('book.coverage with an index: where it stands, and readNext at the unopened page the index ranks highest for the point', async t => {
  // The index ranks the point's second page first, whatever the query: readNext goes there, not to the first unopened page.
  const port = indexPort({ rank: (_query, keys) => [sourceKey('document-l1-p2'), sourceKey('document-l1-p1'), ...keys] }), w = await world(t, port);
  await w.build();
  const coverage = await w.study.call('book.coverage', { hid: w.what.hid });
  assert.equal(coverage.index.status, 'ok');
  assert.ok(coverage.index.indexed > 0 && coverage.index.missing === 0);
  assert.deepEqual(coverage.readNext, { documentId: coverage.documents[0].documentId, from: 2, to: 3, by: 'index' });
  const asked = port.calls.filter(call => call.name.endsWith('query_documents')).at(-1).args.query;
  assert.match(asked, /What architects do/, 'the point is searched by its title (and its headings or missing concepts)');
  await w.study.call('source.pages', { documentId: coverage.documents[0].documentId, from: 2, to: 2, hid: w.what.hid });
  const next = await w.study.call('book.coverage', { hid: w.what.hid });
  assert.equal(next.readNext.from, 1, 'an opened page is passed over');
});

test('book.search is registered as a read of the book area, generation\'s, granted to the library for book.coverage', () => {
  assert.match(libraryContracts.book, /book\.search \{course\?,hid\?,query\?,limit\?<=20\}/);
  assert.match(libraryContracts.book, /a hit is a pointer, never evidence/);
  assert.deepEqual([writesFor('generation', 'book.search'), writesFor('generation', 'retrieval.auto.set'), writesFor('generation', 'retrieval.index.follow')], [[], [], []]);
});
