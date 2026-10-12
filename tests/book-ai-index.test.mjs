/* 弄懂 / 加一段 with the course's search index (lib/contexts/generation/book-ai/index-pages.js): the pages book.search finds for the selected words and
   the instruction (within the point, topped up from the course) go first into the material the model sees, inside the same budget; quotes are checked
   against exactly that text; the task's console names the pages. Without an index the material is today's. Fake model, fake search extension. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { MATERIAL_CHARS, planAi } from '../lib/contexts/generation/book-ai/plan.js';
import { INDEX_CHARS, findIndexPages, hitPages, requestQuery, withIndexPages } from '../lib/contexts/generation/book-ai/index-pages.js';
import { aiBlocks } from '../lib/course-book-ai-text.js';
import { bookLibrary, COURSE } from './helpers/book-agent-library.mjs';
import { indexPort } from './helpers/book-index-port.mjs';
import { settleJob, until } from './helpers/wait.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';

const lengthOf = parts => parts.reduce((sum, part) => sum + part.text.length, 0);
const segment = (id, size, extra = {}) => ({ sourceId: id, start: 0, end: size, text: 'x'.repeat(size), material: `M ${id}`, ...extra });

test('the plan with index pages: those pages first, the point\'s own passages in what is left, the same budget, quotes checked against all of them', () => {
  const plan = { mode: 'explain', words: 'CIA triad', instruction: '', leaf: { title: 'Security' }, segments: [segment('own1', 9000), segment('own2', 9000), segment('hit2', 500)], materials: [] };
  const pages = [segment('hit1', 5000, { page: 7, fromIndex: true }), segment('hit2', 4000, { page: 8, fromIndex: true })];
  const merged = withIndexPages(plan, pages);
  assert.deepEqual(merged.materials.slice(0, 2).map(part => part.sourceId), ['hit1', 'hit2'], 'the index\'s pages first');
  assert.ok(lengthOf(merged.materials.slice(0, 2)) <= INDEX_CHARS);
  assert.ok(lengthOf(merged.materials) <= MATERIAL_CHARS, `${lengthOf(merged.materials)} characters: within the existing budget`);
  assert.deepEqual(merged.materials.slice(2).map(part => part.sourceId), ['own1', 'own2'], 'a page given whole is not repeated as a passage');
  assert.deepEqual(merged.segments.map(part => part.sourceId), ['hit1', 'hit2', 'own1', 'own2'], 'what quotes are checked against');
  assert.deepEqual(merged.indexPages, [{ material: 'M hit1', page: 7 }, { material: 'M hit2', page: 8 }]);
  assert.equal(withIndexPages(plan, []), plan, 'no pages: the plan as it was');
  assert.equal(requestQuery(plan), 'CIA triad');
  assert.equal(requestQuery({ mode: 'here', words: '', instruction: '加个例子', leaf: { title: 'Security' } }), '加个例子 Security');
  const byId = new Map([['p1', { id: 'p1', title: 'Deck · p. 3', text: 'Some text.' }], ['p2', { id: 'p2', title: 'Empty', text: '  ' }]]);
  assert.deepEqual(hitPages([{ sourceId: 'p1', title: 'Deck', page: 3 }, { sourceId: 'p1' }, { sourceId: 'p2' }, { sourceId: 'gone' }], byId),
    [{ sourceId: 'p1', start: 0, end: 10, text: 'Some text.', material: 'Deck', page: 3, fromIndex: true }]);
});

test('findIndexPages asks the point first, the course when the point gives too few, and nothing when the index cannot be used', async () => {
  const plan = { course: 'C', mode: 'explain', words: 'w', instruction: '', leaf: { hid: 'h1', title: 'T' }, segments: [] };
  const state = { sources: ['a', 'b', 'c'].map(id => ({ id, title: id, text: `${id} text` })) };
  const asked = [];
  const search = async args => { asked.push(args); return args.hid ? { status: 'ok', hits: [{ sourceId: 'a', title: 'A', page: 1 }] } : { status: 'ok', hits: [{ sourceId: 'a' }, { sourceId: 'b', title: 'B', page: 4 }] }; };
  const pages = await findIndexPages(plan, { search, read: async () => state });
  assert.deepEqual(asked.map(args => args.hid ?? null), ['h1', null], 'topped up from the course');
  assert.deepEqual(pages.map(item => item.sourceId), ['a', 'b']);
  for (const status of ['no-index', 'no-extension']) assert.deepEqual(await findIndexPages(plan, { search: async () => ({ status, hits: [] }), read: async () => state }), []);
  assert.deepEqual(await findIndexPages(plan, { search: async () => { throw new Error('down'); }, read: async () => state }), [], 'a failing search: as before');
  assert.deepEqual(await findIndexPages(plan, {}), [], 'no search: as before');
});

/** A fake model that quotes the first material it was given. */
function quotingModel() {
  const calls = [];
  const complete = async (system, prompt) => {
    const data = JSON.parse(prompt.slice(prompt.indexOf('REQUEST DATA:\n') + 'REQUEST DATA:\n'.length));
    calls.push(data);
    return JSON.stringify({ text: `Answer on ${data.words}.`, quotes: [data.materials[0].text.slice(0, 40)], extra: [] });
  };
  return { calls, complete };
}

async function world(t, port) {
  const home = await mkdtemp(join(tmpdir(), 'study-ai-index-home-')), root = await mkdtemp(join(tmpdir(), 'study-ai-index-'));
  const before = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const fake = quotingModel();
  const study = new StudyService(root, { coach: false, complete: fake.complete, retrieval: port, ...switchOptions('runtime', { complete: fake.complete, paths: [] }) });
  t.after(async () => {
    await study.dispose();
    if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before;
    await rm(root, { recursive: true, force: true, maxRetries: 3 }); await rm(home, { recursive: true, force: true, maxRetries: 3 });
  });
  await study.call('snapshot');
  const { state } = bookLibrary({ long: true });
  await study.store.update(own => { own.sources.push(...state.sources); own.decks.push(...state.decks); own.focus = state.focus; });
  await study.call('retrieval.auto.set', { on: false });
  const book = await study.call('course.book.open'), point = book.nodes[0].children[0];
  const explain = async words => {
    const started = await study.call('generation.courseBook.explain', { course: COURSE, heading: point.hid, language: 'zh', mode: 'explain', words });
    await settleJob(study, started.jobId);
    return [...study.runtime.work.jobs.values()].filter(job => job.type === 'course-book-ai').at(-1);
  };
  return { study, fake, point, explain, state: () => study.store.read() };
}

test('弄懂 with an index: the pages found go first in the material, the console names them, a quote from them is kept; no extra model call', async t => {
  const port = indexPort(), w = await world(t, port);
  await w.study.call('retrieval.index.start', { course: COURSE });
  await until(async () => (await w.study.call('retrieval.index.status')).status === 'complete', 'the index build');
  const job = await w.explain('Microservices');
  assert.equal(job.contract.status, 'complete', JSON.stringify(job.contract.error ?? null));
  assert.equal(w.fake.calls.length, 1, 'one model call');
  const [first] = w.fake.calls[0].materials;
  assert.match(first.title, /Architecture Patterns/, 'the point has no page on it: the course\'s page the index found comes first');
  assert.ok(lengthOf(w.fake.calls[0].materials) <= MATERIAL_CHARS);
  const detail = job.contract.detail;
  assert.ok(detail.indexPages.length >= 1 && detail.indexPages.every(item => Number.isInteger(item.page)), JSON.stringify(detail.indexPages));
  assert.match(detail.notices[0].text, /检索索引找到的 \d+ 页放在了资料最前面：《.*Architecture Patterns.*》第 \d+ 页/);
  assert.equal(detail.dropped, 0, 'the quote taken from an index page is found in the text given');
  const block = aiBlocks((await w.study.call('course.book.open')).nodes[0].children[0].mine).at(-1);
  assert.match(block.body, /资料原文/);
});

test('弄懂 without an index: exactly the material of today', async t => {
  const port = indexPort(), w = await world(t, port);
  const job = await w.explain('writes down why');
  assert.equal(job.contract.status, 'complete');
  const expected = planAi(await w.state(), { course: COURSE, heading: w.point.hid, mode: 'explain', words: 'writes down why', language: 'zh' });
  assert.deepEqual(w.fake.calls[0].materials.map(part => part.text), expected.materials.map(part => part.text));
  assert.equal(job.contract.detail.indexPages, undefined);
  assert.equal(port.calls.filter(call => call.name.endsWith('query_documents')).length, 0, 'no index: never asked');
});
