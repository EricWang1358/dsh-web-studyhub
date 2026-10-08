import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { createMaterialsOperations } from '../lib/contexts/materials/operations.js';

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

test('a thread that is too long or malformed is refused before any model call', async t => {
  const { ask, seen } = await fixture(t);
  await assert.rejects(ask({ question: 'x', thread: new Array(4).fill({ question: 'q', answer: 'a' }) }), /at most 3/);
  await assert.rejects(ask({ question: 'x', thread: [{ question: 'q' }] }), /question and answer/);
  await assert.rejects(ask({ question: 'x', term: 7 }), /Term/);
  assert.equal(seen.length, 0);
});
