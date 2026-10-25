import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { createMaterialsOperations } from '../lib/contexts/materials/operations.js';
import { materialsSchemas } from '../lib/contexts/materials/contracts.js';
import { PAGE_EVIDENCE_MAX } from '../lib/ask-prompt.js';

/* materials.selection.ask: plain, explanation, term and thread questions reach the model in the right shape and the
   result keeps its old shape. */

const BASE = 'Answer the learner question using only the selected source evidence and its nearby context.';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'materials-ask-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const ops = createMaterialsOperations({ root,
    read: async () => { const state = await store.read(); return structuredClone({ sources: state.sources, documents: state.documents || [] }); },
    update: fn => store.update(async state => {
      const own = { sources: state.sources, documents: state.documents || [] };
      const result = await fn(own); state.sources = own.sources; state.documents = own.documents; return result;
    }) });
  const call = (action, args = {}, request = {}) => ops.handlers[action](args, request);
  const imported = await call('materials.document.import', { filename: 'plain.txt', dataBase64: Buffer.from('We ship logs to ELK. ELK stores and searches them.').toString('base64') });
  const resolved = await call('materials.selection.resolve', { documentId: imported.documentId, revision: imported.revision, quote: 'We ship logs to ELK.' });
  const seen = [];
  const ask = (args, answer = 'ok') => call('materials.selection.ask', { selection: resolved.selection, ...args }, { complete: async (system, prompt, options) => { seen.push({ system, input: JSON.parse(prompt), options }); return answer; } });
  return { ask, seen, selection: resolved.selection };
}

test('a plain question is sent exactly as before and answers in the old shape', async t => {
  const { ask, seen, selection } = await fixture(t);
  const result = await ask({ question: 'Why?' }, 'Because.');
  assert.equal(result.status, 'answered'); assert.equal(result.answer, 'Because.');
  assert.deepEqual(result.selection, selection); assert.equal(result.citations.length, 1);
  assert.equal(seen[0].system.startsWith(BASE), true);
  assert.ok(!seen[0].system.includes('ORDER'));
  assert.deepEqual(Object.keys(seen[0].input).sort(), ['context', 'language', 'question', 'selection']);
  assert.equal(seen[0].input.language, '中文');
});

test('an explanation request carries the answer skeleton in the request language', async t => {
  const { ask, seen } = await fixture(t);
  await ask({ question: '没听懂' });
  assert.match(seen[0].system, /这段在讲什么/);
  await ask({ question: 'explain this', language: 'English' });
  assert.match(seen[1].system, /What this passage is about/);
  assert.equal(seen[1].input.language, 'English');
});

test('a term and a thread are added to the input, never to the instructions', async t => {
  const { ask, seen } = await fixture(t);
  const thread = [{ question: '没听懂', answer: 'About [[ELK]]' }];
  const result = await ask({ question: 'what is ELK', term: 'ELK', thread, terms: true });
  assert.equal(result.status, 'answered');
  assert.equal(seen[0].input.term, 'ELK');
  assert.deepEqual(seen[0].input.thread, thread);
  assert.match(seen[0].system, /general knowledge, not from the source/);
  assert.match(seen[0].system, /\[\[term\]\]/);
  assert.ok(!seen[0].system.includes('ELK'));
});

/* scope 'page' (原始 PDF view, issue #456): the question is about one whole page, named by its page number, not a selected passage. */
async function pageFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'materials-ask-page-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const ops = createMaterialsOperations({ root,
    read: async () => { const state = await store.read(); return structuredClone({ sources: state.sources, documents: state.documents || [] }); },
    update: fn => store.update(async state => {
      const own = { sources: state.sources, documents: state.documents || [] };
      const result = await fn(own); state.sources = own.sources; state.documents = own.documents; return result;
    }) });
  const call = (action, args = {}, request = {}) => ops.handlers[action](args, request);
  // A paged document as an import leaves it: one source per page, each with its page number (a synthetic PDF is too sparse to import).
  const pages = ['Page 1 text', 'Page 2: ownership moves on assignment.', 'Page 3 text'];
  await store.update(state => {
    state.sources.push(...pages.map((text, index) => ({ id: `p${index + 1}`, title: `Slides · p.${index + 1}`, text, document: { id: 'slides', page: index + 1, totalPages: pages.length } })));
    state.documents = [{ id: 'document-slides', title: 'Slides', format: 'pdf', filename: 'slides.pdf', currentRevision: 'r1', versions: [{ revision: 'r1', sourceIds: ['p1', 'p2', 'p3'], attachment: null }] }];
  });
  const imported = { documentId: 'document-slides', revision: 'r1', sourceIds: ['p1', 'p2', 'p3'] };
  const seen = [];
  const ask = (args, answer = 'ok') => call('materials.selection.ask', args, { complete: async (system, prompt) => { seen.push({ system, input: JSON.parse(prompt) }); return answer; } });
  const page = number => ({ documentId: imported.documentId, revision: imported.revision, page: number });
  return { ask, call, seen, page, imported, store, pages };
}

test('a page question is answered from that page\'s saved text, without a selected quote', async t => {
  const { ask, seen, page, imported, pages } = await pageFixture(t);
  const result = await ask({ scope: 'page', selection: page(2), question: 'What is on this page?' }, 'Page two.');
  assert.equal(result.status, 'answered'); assert.equal(result.answer, 'Page two.');
  assert.equal(result.scope, 'page');
  assert.equal(result.selection.page, 2);
  assert.equal(result.selection.sourceId, imported.sourceIds[1]);
  assert.deepEqual(result.evidence, { page: 2, chars: pages[1].length, used: pages[1].length, truncated: false });
  assert.match(seen[0].input.context, /Page 2/);
  assert.doesNotMatch(seen[0].input.context, /Page 1|Page 3/, 'only that page is evidence');
  assert.equal(seen[0].input.page, 2);
  assert.equal(seen[0].input.scope, 'page');
  assert.equal(seen[0].input.selection, undefined, 'the page text is not sent twice');
  assert.match(seen[0].system, /one whole page/);
  assert.equal(seen[0].system.startsWith(BASE), true);
});

test('a long page is cut at the named cap and the answer says so', async t => {
  const { ask, seen, page, imported, store } = await pageFixture(t);
  const long = 'x'.repeat(PAGE_EVIDENCE_MAX + 500);
  await store.update(state => { state.sources.find(item => item.id === imported.sourceIds[2]).text = long; });
  const result = await ask({ scope: 'page', selection: page(3), question: 'Summarise' });
  assert.equal(result.status, 'answered');
  assert.deepEqual(result.evidence, { page: 3, chars: long.length, used: PAGE_EVIDENCE_MAX, truncated: true });
  assert.equal(seen[0].input.context.length, PAGE_EVIDENCE_MAX);
  assert.equal(seen[0].input.truncated, true);
});

test('a page with no saved text, a page that is not there and an old revision are refused before any model call', async t => {
  const { ask, seen, page, imported, store } = await pageFixture(t);
  await store.update(state => { state.sources.find(item => item.id === imported.sourceIds[0]).text = '  \n '; });
  const blank = await ask({ scope: 'page', selection: page(1), question: 'q' });
  assert.equal(blank.status, 'missing'); assert.equal(blank.reason, 'empty');
  assert.equal((await ask({ scope: 'page', selection: page(9), question: 'q' })).status, 'missing');
  assert.equal((await ask({ scope: 'page', selection: { ...page(2), revision: 'older' }, question: 'q' })).status, 'stale');
  await assert.rejects(ask({ scope: 'chapter', selection: page(2), question: 'q' }), /scope/);
  assert.equal(seen.length, 0);
});

test('a page question without a model says the capability is missing', async t => {
  const { call, page } = await pageFixture(t);
  const result = await call('materials.selection.ask', { scope: 'page', selection: page(1), question: 'q' });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.capability, 'model');
});

test('the contract names the optional page scope', () => {
  const schema = materialsSchemas['materials.selection.ask'];
  assert.deepEqual(schema.input.properties.scope.enum, ['selection', 'page']);
  assert.deepEqual(schema.input.required, ['selection', 'question']);
  assert.match(schema.description, /scope "page"/);
});

test('a thread that is too long or malformed is refused before any model call', async t => {
  const { ask, seen } = await fixture(t);
  await assert.rejects(ask({ question: 'x', thread: new Array(4).fill({ question: 'q', answer: 'a' }) }), /at most 3/);
  await assert.rejects(ask({ question: 'x', thread: [{ question: 'q' }] }), /question and answer/);
  await assert.rejects(ask({ question: 'x', term: 7 }), /Term/);
  assert.equal(seen.length, 0);
});
