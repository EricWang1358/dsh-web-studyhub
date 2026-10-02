/* Bilingual reading, the backend (materials.translation.*): one passage or a list translated with the request model, kept per
   document REVISION beside the document's own records, cached by words + target + glossary, retranslated with the learner's
   comment, deleted and restored, a per-document glossary, a price before the call and the usage after it. A fake model; no
   network. The text, citations, selections and card links of a document are never touched. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { createMaterialsOperations } from '../lib/contexts/materials/operations.js';
import { reportUsage } from '../lib/usage-scope.js';
import { paragraphKey, textHash } from '../lib/passage-translation.js';

const A = "Architecture includes the principles guiding a system's design and evolution.";
const B = 'Quality attributes such as latency and availability shape which tactics a team selects.';
const C = 'A CQRS design separates the read model from the write model.';
const ZH = '平台让两类人群找到彼此。';
const markdown = (...lines) => `# Notes\n\n${lines.join('\n\n')}\n`;
const usage = { uncachedInputTokens: 900, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** A model that translates like a careful one: Chinese of a believable length for each passage, with the glossary applied. */
function fakeModel({ answer, usageReport = false } = {}) {
  const control = { calls: [], inFlight: 0, peak: 0, delay: 0 };
  control.complete = async (system, prompt, options = {}) => {
    const data = JSON.parse(prompt);
    control.calls.push({ system, data, options });
    control.inFlight += 1; control.peak = Math.max(control.peak, control.inFlight);
    try {
      if (control.delay) await new Promise(resolve => setTimeout(resolve, control.delay));
      options.signal?.throwIfAborted();
      if (usageReport) reportUsage(usage, { calls: 1 });
      if (answer) return answer(data, control.calls.length);
      return JSON.stringify({ translations: data.passages.map(passage => ({ id: passage.id, text: zh(passage.text, data.glossary) })) });
    } finally { control.inFlight -= 1; }
  };
  return control;
}
const zh = (text, glossary = []) => {
  const kept = glossary.filter(entry => entry.rule.startsWith('keep') && text.includes(entry.term)).map(entry => entry.term).join('、');
  const fixed = glossary.filter(entry => entry.rule.startsWith('translate as') && text.toLowerCase().includes(entry.term.toLowerCase())).map(entry => entry.rule.replace('translate as: ', '')).join('、');
  return `译文${kept ? `（保留 ${kept}）` : ''}${fixed ? `（${fixed}）` : ''}：${'字'.repeat(Math.ceil(text.replace(/\s/g, '').length * 0.5))}`;
};

async function fixture(t, { model = fakeModel(), noModel = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'materials-translation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const ops = createMaterialsOperations({ root,
    read: async () => { const state = await store.read(); return structuredClone({ sources: state.sources, documents: state.documents || [] }); },
    update: fn => store.update(async state => {
      const own = { sources: state.sources, documents: state.documents || [] };
      const result = await fn(own); state.sources = own.sources; state.documents = own.documents; return result;
    }), ...(noModel ? {} : { complete: model.complete }) });
  const call = (action, args = {}, request = {}) => ops.handlers[`materials.translation.${action}`](args, request);
  const imported = async (body = markdown(A, B, C), filename = 'notes.md', documentId) => {
    const result = await ops.handlers['materials.document.import']({ filename, ...(documentId ? { documentId } : {}), dataBase64: Buffer.from(body).toString('base64') });
    const document = await ops.handlers['materials.document.get']({ id: result.documentId });
    return { ...result, document, source: document.sources[0] };
  };
  return { root, store, ops, call, imported, model, state: async () => store.read() };
}
const passage = (source, text, extra = {}) => ({ sourceId: source.id, text, ...extra });

/* ---------- one passage ---------- */

test('one passage is translated, kept beside its document revision, and the stored text is untouched', async t => {
  const f = await fixture(t), { source, documentId, revision } = await f.imported();
  const before = JSON.stringify((await f.state()).sources);
  const result = await f.call('translate', { documentId, passages: [passage(source, A)] });
  assert.equal(result.status, 'done');
  assert.equal(result.target, 'zh');
  const [item] = result.results;
  assert.equal(item.status, 'translated');
  assert.equal(item.item.key, paragraphKey(source.id, { text: A, ordinal: 0 }));
  assert.match(item.item.text, /^译文：/);
  assert.equal(item.item.version, 1);
  assert.equal(result.counts.translated, 1);
  assert.equal(f.model.calls.length, 1);
  assert.equal(JSON.parse(JSON.stringify(f.model.calls[0].data)).passages[0].text, A);
  const listed = await f.call('list', { documentId });
  assert.equal(listed.revision, revision);
  assert.deepEqual(listed.items.map(entry => entry.key), [item.item.key]);
  assert.equal(listed.items[0].outdated, false);
  assert.equal(JSON.stringify((await f.state()).sources), before, 'no source text, id or citation changed');
  const document = await f.ops.handlers['materials.document.get']({ id: documentId });
  assert.equal(JSON.stringify(document).includes('译文'), false, 'the document descriptor does not carry the translations');
  assert.equal(document.revision, revision);
});

test('a passage already translated is never sent to the model again, and neither is identical text in the same call', async t => {
  const f = await fixture(t), { source, documentId } = await f.imported(markdown(A, B, A));
  const first = await f.call('translate', { documentId, passages: [passage(source, A, { ordinal: 0 }), passage(source, A, { ordinal: 1 }), passage(source, B)] });
  assert.equal(first.counts.translated, 3);
  const sent = f.model.calls.flatMap(call => call.data.passages.map(item => item.text));
  assert.equal(sent.filter(text => text === A).length, 1, 'the same words are translated once');
  assert.notEqual(first.results[0].item.key, first.results[1].item.key, 'but each paragraph has its own record');
  const again = await f.call('translate', { documentId, passages: [passage(source, A, { ordinal: 0 }), passage(source, B)] });
  assert.deepEqual(again.results.map(entry => entry.status), ['cached', 'cached']);
  assert.equal(f.model.calls.length, 1, 'no further model call');
  assert.equal(again.status, 'done');
});

test('text that is already in the target language is skipped unless it is forced', async t => {
  const f = await fixture(t), { source, documentId } = await f.imported(markdown(A, ZH));
  const skipped = await f.call('translate', { documentId, passages: [passage(source, ZH)] });
  assert.equal(skipped.results[0].status, 'skipped');
  assert.equal(skipped.results[0].code, 'same-language');
  assert.equal(f.model.calls.length, 0);
  const toEnglish = await f.call('translate', { documentId, target: 'en', passages: [passage(source, ZH)] }, {});
  assert.equal(toEnglish.target, 'en');
  assert.notEqual(toEnglish.results[0].status, 'skipped');
});

test('a passage that is not in the document is reported, not translated', async t => {
  const f = await fixture(t), { source, documentId } = await f.imported();
  const result = await f.call('translate', { documentId, passages: [passage(source, 'Text that no page of this document holds.'), { sourceId: 'nope', text: A }] });
  assert.deepEqual(result.results.map(entry => entry.status), ['unlocated', 'unlocated']);
  assert.equal(f.model.calls.length, 0);
  assert.equal(result.status, 'failed');
});

/* ---------- retranslation, deletion, history ---------- */

test('retranslating with a comment passes the comment and the old translation, bumps the version and keeps a short history', async t => {
  const f = await fixture(t), { source, documentId } = await f.imported();
  const first = await f.call('translate', { documentId, passages: [passage(source, A)] });
  const second = await f.call('translate', { documentId, retranslate: true, comment: 'Use a more formal register.', passages: [passage(source, A)] });
  const prompt = f.model.calls.at(-1).data;
  assert.equal(prompt.learnerComment, 'Use a more formal register.');
  assert.equal(prompt.previousTranslation, first.results[0].item.text);
  assert.match(f.model.calls.at(-1).system, /untrusted/i);
  const item = second.results[0].item;
  assert.equal(item.version, 2);
  assert.equal(item.comment, 'Use a more formal register.');
  assert.deepEqual(item.history.map(entry => [entry.version, entry.text]), [[1, first.results[0].item.text]]);
  for (let round = 0; round < 7; round += 1) await f.call('translate', { documentId, retranslate: true, comment: `round ${round}`, passages: [passage(source, A)] });
  const listed = await f.call('list', { documentId });
  assert.equal(listed.items[0].version, 9);
  assert.ok(listed.items[0].history.length <= 5, 'the history stays short');
  assert.equal(listed.items[0].history.at(-1).version, 8);
});

test('deleting a translation removes it and hands back what is needed to restore it', async t => {
  const f = await fixture(t), { source, documentId } = await f.imported();
  const done = await f.call('translate', { documentId, passages: [passage(source, A), passage(source, B)] });
  const removed = await f.call('delete', { documentId, keys: [done.results[0].item.key] });
  assert.equal(removed.deleted, 1);
  assert.equal((await f.call('list', { documentId })).items.length, 1);
  const restored = await f.call('save', { documentId, restore: removed.removed });
  assert.equal(restored.saved, 1);
  const listed = await f.call('list', { documentId });
  assert.equal(listed.items.length, 2);
  assert.equal(listed.items.find(entry => entry.key === done.results[0].item.key).text, done.results[0].item.text);
  await assert.rejects(f.call('save', { documentId, restore: [{ ...removed.removed[0], hash: 'tampered', text: 'x' }] }), /does not match/i);
  const all = await f.call('delete', { documentId, all: true });
  assert.equal(all.deleted, 2);
  assert.equal((await f.call('list', { documentId })).items.length, 0);
});

test('a translation can be saved by hand for a passage of the document, and nothing else', async t => {
  const f = await fixture(t), { source, documentId } = await f.imported();
  const saved = await f.call('save', { documentId, passages: [{ ...passage(source, A), translation: '建筑包括指导系统设计与演化的原则。' }] });
  assert.equal(saved.saved, 1);
  assert.equal((await f.call('list', { documentId })).items[0].text, '建筑包括指导系统设计与演化的原则。');
  await assert.rejects(f.call('save', { documentId, passages: [{ ...passage(source, 'Not in the document at all.'), translation: 'x' }] }), /not in this document|not found|locat/i);
  await assert.rejects(f.call('save', { documentId, passages: [{ ...passage(source, B), translation: '   ' }] }), /empty/i);
});

/* ---------- glossary ---------- */

test('the glossary always reaches the model for the passages it matches, and changing it lists what would be affected', async t => {
  const f = await fixture(t), { source, documentId } = await f.imported();
  await f.call('translate', { documentId, passages: [passage(source, A), passage(source, C)] });
  assert.equal(f.model.calls[0].data.glossary, undefined, 'no glossary yet');
  const set = await f.call('glossary.set', { documentId, glossary: [{ term: 'CQRS', to: '' }, { term: 'latency', to: '延迟' }, { term: 'unused', to: 'x' }] });
  assert.equal(set.glossary.length, 3);
  assert.equal(set.affected.count, 1, 'only the paragraph that contains a term is affected');
  assert.deepEqual(set.affected.passages.map(entry => entry.text), [C]);
  assert.equal(set.affected.passages[0].sourceId, source.id);
  const listed = await f.call('list', { documentId });
  assert.deepEqual(listed.items.map(entry => [entry.quote.slice(0, 6), entry.outdated]), [['Archit', false], ['A CQRS', true]]);
  assert.deepEqual((await f.call('glossary.get', { documentId })).glossary, set.glossary);
  const again = await f.call('translate', { documentId, retranslate: true, passages: set.affected.passages.map(entry => ({ sourceId: entry.sourceId, text: entry.text, ordinal: entry.ordinal })) });
  assert.deepEqual(f.model.calls.at(-1).data.glossary, [{ term: 'CQRS', rule: 'keep exactly as written' }]);
  assert.match(again.results[0].item.text, /保留 CQRS/);
  assert.equal(again.results[0].item.version, 2);
  assert.equal((await f.call('list', { documentId })).items.every(entry => !entry.outdated), true);
  const same = await f.call('glossary.set', { documentId, glossary: [{ term: 'CQRS', to: '' }, { term: 'latency', to: '延迟' }, { term: 'unused', to: 'x' }] });
  assert.equal(same.affected.count, 0, 'saving the same glossary changes nothing');
});

test('the glossary and the target belong to the document, not to one revision', async t => {
  const f = await fixture(t), { documentId } = await f.imported();
  await f.call('glossary.set', { documentId, glossary: [{ term: 'CQRS', to: '' }], target: 'en' });
  const next = await f.imported(markdown(A, B, C, 'One more paragraph about the CQRS pattern and queries.'), 'notes.md', documentId);
  assert.equal(next.documentId, documentId);
  const settings = await f.call('glossary.get', { documentId });
  assert.deepEqual(settings.glossary, [{ term: 'CQRS', to: '' }]);
  assert.equal(settings.target, 'en');
  await assert.rejects(f.call('glossary.set', { documentId, target: 'fr' }), /target/i);
});

/* ---------- checks on the answer ---------- */

test('an answer that is a refusal is retried once; a good second answer is kept, two bad ones are rejected and nothing is saved', async t => {
  const model = fakeModel({ answer: (data, call) => JSON.stringify({ translations: data.passages.map(item => ({ id: item.id, text: call === 1 ? "I'm sorry, I cannot help with that." : zh(item.text) })) }) });
  const f = await fixture(t, { model }), { source, documentId } = await f.imported();
  const retried = await f.call('translate', { documentId, passages: [passage(source, A)] });
  assert.equal(retried.results[0].status, 'translated');
  assert.equal(model.calls.length, 2);
  assert.match(model.calls[1].system, /rejected \(/);
  const bad = fakeModel({ answer: data => JSON.stringify({ translations: data.passages.map(item => ({ id: item.id, text: '' })) }) });
  const g = await fixture(t, { model: bad }), second = await g.imported();
  const rejected = await g.call('translate', { documentId: second.documentId, passages: [passage(second.source, A)] });
  assert.equal(rejected.results[0].status, 'rejected');
  assert.equal(rejected.results[0].code, 'empty');
  assert.equal(rejected.status, 'failed');
  assert.equal(bad.calls.length, 2, 'one retry, no more');
  assert.equal((await g.call('list', { documentId: second.documentId })).items.length, 0);
});

test('an answer that cannot be read as JSON is retried; a model that answers for fewer passages leaves the others rejected as missing', async t => {
  let round = 0;
  const model = fakeModel({ answer: data => (round += 1) === 1 ? 'Sure! Here are your translations.' : JSON.stringify({ translations: data.passages.slice(0, 1).map(item => ({ id: item.id, text: zh(item.text) })) }) });
  const f = await fixture(t, { model }), { source, documentId } = await f.imported();
  const result = await f.call('translate', { documentId, passages: [passage(source, A), passage(source, B)] });
  assert.deepEqual(result.results.map(entry => entry.status), ['translated', 'rejected']);
  assert.equal(result.results[1].code, 'missing');
  assert.equal(result.status, 'partial');
  assert.equal((await f.call('list', { documentId })).items.length, 1, 'what passed is kept');
});

/* ---------- size, batches, concurrency ---------- */

test('a long paragraph is split on sentence boundaries for the model, rebuilt as one translation, and the split is reported', async t => {
  const sentence = 'The platform changes how each group of users decides what to do next.';
  const long = Array.from({ length: 40 }, () => sentence).join(' ');
  const f = await fixture(t), { source, documentId } = await f.imported(markdown(long, A));
  const result = await f.call('translate', { documentId, passages: [passage(source, long)] });
  assert.equal(result.results[0].status, 'translated');
  assert.ok(result.split.parts > 1 && result.split.paragraphs === 1);
  assert.equal(result.results[0].item.parts, result.split.parts);
  const sent = f.model.calls.flatMap(call => call.data.passages.map(item => item.text));
  assert.ok(sent.every(text => text.length <= 1200 && /\.$/.test(text)), 'every piece is a whole number of sentences within the cap');
  assert.equal(sent.join(' '), long);
  assert.equal((await f.call('list', { documentId })).items.length, 1);
});

test('many passages go in bounded batches and no more calls are in flight than were asked for', async t => {
  const lines = Array.from({ length: 24 }, (_, index) => `Paragraph number ${index} explains one more consequence of the architecture in some detail.`);
  const model = fakeModel(); model.delay = 15;
  const f = await fixture(t, { model }), { source, documentId } = await f.imported(markdown(...lines));
  const result = await f.call('translate', { documentId, concurrency: 2, passages: lines.map(line => passage(source, line)) });
  assert.equal(result.counts.translated, 24);
  assert.ok(model.calls.every(call => call.data.passages.length <= 6), 'a call carries a bounded number of passages');
  assert.ok(model.calls.length >= 4);
  assert.equal(model.peak, 2);
  const one = fakeModel(); one.delay = 5;
  const g = await fixture(t, { model: one }), second = await g.imported(markdown(...lines));
  await g.call('translate', { documentId: second.documentId, concurrency: 99, passages: lines.map(line => passage(second.source, line)) });
  assert.equal(one.peak, 3, 'the cap is three');
});

test('a stopped call stops asking the model and keeps what was already translated', async t => {
  const lines = Array.from({ length: 18 }, (_, index) => `Paragraph number ${index} explains one more consequence of the architecture in some detail.`);
  const controller = new AbortController();
  const model = fakeModel({ answer: (data, call) => { if (call === 2) controller.abort(new Error('stopped')); return JSON.stringify({ translations: data.passages.map(item => ({ id: item.id, text: zh(item.text) })) }); } });
  const f = await fixture(t, { model }), { source, documentId } = await f.imported(markdown(...lines));
  await assert.rejects(f.call('translate', { documentId, concurrency: 1, passages: lines.map(line => passage(source, line)) }, { signal: controller.signal }), /stopped/);
  const kept = (await f.call('list', { documentId })).items.length;
  assert.ok(kept >= 6 && kept < 18, `batches that finished are kept (${kept})`);
  assert.ok(model.calls.length <= 3);
});

/* ---------- price, usage, no model ---------- */

test('the price comes before the call, needs no model, and counts what is cached or skipped for free', async t => {
  const f = await fixture(t, { noModel: true }), { source, documentId } = await f.imported(markdown(A, B, ZH));
  const estimate = await f.call('translate', { documentId, estimate: true, passages: [passage(source, A), passage(source, B), passage(source, ZH)] });
  assert.equal(estimate.status, 'estimate');
  assert.equal(estimate.modelAvailable, false);
  assert.deepEqual([estimate.counts.toTranslate, estimate.counts.skipped, estimate.counts.cached], [2, 1, 0]);
  assert.ok(estimate.estimate.totalTokens.high >= estimate.estimate.totalTokens.low && estimate.estimate.totalTokens.low > 0);
  assert.equal(estimate.estimate.calls.low, 1);
  const bigger = await f.call('translate', { documentId, estimate: true, passages: [passage(source, A), passage(source, B)], target: 'en' });
  assert.ok(bigger.estimate.totalTokens.low >= 0);
});

test('without a model the call says so plainly and writes nothing; cached passages still come back', async t => {
  const f = await fixture(t, { noModel: true }), { source, documentId } = await f.imported();
  const none = await f.call('translate', { documentId, passages: [passage(source, A)] });
  assert.equal(none.status, 'unavailable');
  assert.equal(none.capability, 'model');
  assert.equal((await f.call('list', { documentId })).modelAvailable, false);
  await f.call('save', { documentId, passages: [{ ...passage(source, B), translation: '延迟与可用性决定团队选择的策略。' }] });
  const mixed = await f.call('translate', { documentId, passages: [passage(source, B), passage(source, A)] });
  assert.equal(mixed.status, 'unavailable');
  assert.equal(mixed.results.find(entry => entry.status === 'cached').item.text, '延迟与可用性决定团队选择的策略。');
});

test('what the model reports is totalled and returned with the answer', async t => {
  const f = await fixture(t, { model: fakeModel({ usageReport: true }) }), { source, documentId } = await f.imported();
  const result = await f.call('translate', { documentId, passages: [passage(source, A), passage(source, B)] });
  assert.equal(result.usage.uncachedInputTokens, 900);
  assert.equal(result.usage.outputTokens, 300);
  assert.equal(result.usage.calls, 1);
});

/* ---------- revisions ---------- */

test('a new revision never inherits translations, lists the old ones as stale, and reuses the words that did not change', async t => {
  const f = await fixture(t), first = await f.imported(markdown(A, B));
  await f.call('translate', { documentId: first.documentId, passages: [passage(first.source, A), passage(first.source, B)] });
  const second = await f.imported(markdown(A, B, C), 'notes.md', first.documentId);
  assert.equal(second.documentId, first.documentId);
  assert.notEqual(second.revision, first.revision);
  const listed = await f.call('list', { documentId: second.documentId });
  assert.equal(listed.revision, second.revision);
  assert.equal(listed.items.length, 0, 'not applied');
  assert.deepEqual(listed.stale.map(entry => [entry.revision, entry.count]), [[first.revision, 2]]);
  const calls = f.model.calls.length;
  const reused = await f.call('translate', { documentId: second.documentId, passages: [passage(second.source, A), passage(second.source, C)] });
  assert.deepEqual(reused.results.map(entry => entry.status), ['reused', 'translated']);
  assert.equal(f.model.calls.length, calls + 1, 'only the new paragraph is sent');
  assert.equal(reused.results[0].item.text, (await f.call('list', { documentId: first.documentId, revision: first.revision })).items.find(entry => entry.quote.startsWith('Architecture')).text);
  const old = await f.call('list', { documentId: first.documentId, revision: first.revision });
  assert.equal(old.items.length, 2, 'the old revision keeps its own');
});

test('a document with no record keeps its translations on its first source, out of the library snapshot', async t => {
  const f = await fixture(t);
  await f.store.update(state => { state.sources.push({ id: 'legacy-1', title: 'Pasted notes', text: `${A}\n\n${B}`, createdAt: '2026-10-01T08:00:00.000Z' }); });
  const result = await f.call('translate', { sourceId: 'legacy-1', passages: [{ sourceId: 'legacy-1', text: A }] });
  assert.equal(result.results[0].status, 'translated');
  const stored = (await f.state()).sources.find(source => source.id === 'legacy-1');
  assert.ok(stored.translations?.items?.length === 1, 'kept on the source record');
  assert.equal(stored.text, `${A}\n\n${B}`);
  const listed = await f.call('list', { sourceId: 'legacy-1' });
  assert.equal(listed.items.length, 1);
  const document = await f.ops.handlers['materials.document.get']({ sourceId: 'legacy-1' });
  assert.equal(JSON.stringify(document).includes('译文'), false);
});

/* ---------- selections ---------- */

test('a selected sentence inside a paragraph is a selection passage: found with its context, kept with its quote', async t => {
  const f = await fixture(t), { source, documentId } = await f.imported(markdown('First sentence is here. Second sentence follows it. First sentence is here. Use it again.'));
  const selected = { sourceId: source.id, kind: 'selection', text: 'First sentence is here.', prefix: '', suffix: ' Second sentence follows it.' };
  const result = await f.call('translate', { documentId, passages: [selected] });
  const item = result.results[0].item;
  assert.equal(item.kind, 'selection');
  assert.ok(item.key.startsWith('sel:'));
  assert.equal(item.quote, 'First sentence is here.');
  assert.equal(item.start, (await f.state()).sources[0].text.indexOf('First sentence is here.'));
  const second = await f.call('translate', { documentId, passages: [{ ...selected, prefix: 'follows it. ', suffix: ' Use it again.' }] });
  assert.equal(second.results[0].item.start > item.start, true);
  assert.notEqual(second.results[0].item.key, item.key);
  const ambiguous = await f.call('translate', { documentId, passages: [{ ...selected, prefix: 'zz', suffix: 'qq' }] });
  assert.equal(ambiguous.results[0].status, 'unlocated');
  assert.equal(ambiguous.results[0].code, 'ambiguous');
});

test('a selection that is exactly one paragraph is the paragraph', async t => {
  const f = await fixture(t), { source, documentId } = await f.imported();
  const result = await f.call('translate', { documentId, passages: [{ sourceId: source.id, kind: 'selection', text: A, prefix: 'Notes ', suffix: B.slice(0, 10) }] });
  assert.equal(result.results[0].item.kind, 'paragraph');
  assert.equal(result.results[0].item.key, paragraphKey(source.id, { text: A, ordinal: 0 }));
});

/* ---------- a page or a chapter: which paragraphs ---------- */

test('plan lists the paragraphs of some sources with what is done, what is to do and what needs nothing', async t => {
  const f = await fixture(t), { source, documentId } = await f.imported(markdown(A, ZH, B, C));
  await f.call('translate', { documentId, passages: [passage(source, A)] });
  const plan = await f.call('plan', { documentId, scope: { sourceIds: [source.id] } });
  const states = plan.passages.map(entry => [entry.text.slice(0, 12), entry.state]);
  assert.deepEqual(states, [['Notes', 'todo'], ['Architecture', 'done'], [ZH.slice(0, 12), 'skip'], ['Quality attr', 'todo'], ['A CQRS desig', 'todo']]);
  assert.deepEqual([plan.counts.todo, plan.counts.done, plan.counts.skipped, plan.counts.paragraphs], [3, 1, 1, 5]);
  assert.ok(plan.counts.chars > 100);
  assert.ok(plan.passages.every(entry => entry.key === paragraphKey(entry.sourceId, entry)));
  const estimate = await f.call('translate', { documentId, estimate: true, scope: { sourceIds: [source.id] } });
  assert.equal(estimate.counts.toTranslate, 3);
  assert.equal(estimate.counts.cached, 1);
  const unknown = await f.call('plan', { documentId, scope: { sourceIds: ['nope'] } });
  assert.equal(unknown.passages.length, 0);
});

test('the text of a plain page is cut at its blank lines, a Markdown projection at its lines', async t => {
  const f = await fixture(t);
  await f.store.update(state => { state.sources.push({ id: 'plain-1', title: 'Plain', text: `${A}\nstill the same paragraph.\n\n${B}`, createdAt: '2026-10-01T08:00:00.000Z' }); });
  const plan = await f.call('plan', { sourceId: 'plain-1', scope: { sourceIds: ['plain-1'] } });
  assert.deepEqual(plan.passages.map(entry => entry.text), [`${A}\nstill the same paragraph.`, B]);
  assert.equal(textHash(plan.passages[1].text), plan.passages[1].hash);
});

/* ---------- backup ---------- */

test('translations and the glossary travel in the full backup and come back identical, for a stored document and for one with no record', async t => {
  const { StudyService } = await import('../lib/service.js');
  const target = await mkdtemp(join(tmpdir(), 'materials-translation-restored-'));
  t.after(() => rm(target, { recursive: true, force: true }));
  const f = await fixture(t), { source, documentId, revision } = await f.imported();
  await f.store.update(state => { state.sources.push({ id: 'legacy-1', title: 'Pasted notes', text: `${A}\n\n${B}`, createdAt: '2026-10-01T08:00:00.000Z' }); });
  await f.call('glossary.set', { documentId, glossary: [{ term: 'CQRS', to: '' }], target: 'zh' });
  await f.call('translate', { documentId, passages: [passage(source, A), passage(source, C), { sourceId: source.id, kind: 'selection', text: 'principles guiding a system', prefix: 'includes the ', suffix: ' design and evolution.' }] });
  await f.call('translate', { documentId, retranslate: true, comment: 'Plainer.', passages: [passage(source, A)] });
  await f.call('translate', { sourceId: 'legacy-1', passages: [{ sourceId: 'legacy-1', text: B }] });
  const bare = ({ modelAvailable: _model, ...rest }) => rest;
  const before = { stored: bare(await f.call('list', { documentId })), legacy: bare(await f.call('list', { sourceId: 'legacy-1' })) };
  assert.equal(before.stored.items.length, 3);
  const backup = await new StudyService(f.root).call('export');
  await new StudyService(target).call('restore', { state: JSON.parse(JSON.stringify(backup)) });
  const restored = new Store(target);
  const ops = createMaterialsOperations({ root: target, read: async () => { const state = await restored.read(); return structuredClone({ sources: state.sources, documents: state.documents || [] }); },
    update: fn => restored.update(async state => { const own = { sources: state.sources, documents: state.documents || [] }; const result = await fn(own); state.sources = own.sources; state.documents = own.documents; return result; }) });
  const after = { stored: bare(await ops.handlers['materials.translation.list']({ documentId })), legacy: bare(await ops.handlers['materials.translation.list']({ sourceId: 'legacy-1' })) };
  assert.deepEqual(after, before, 'every translation, version, history and the glossary survive the round trip');
  assert.equal(after.stored.revision, revision);
  assert.equal(after.stored.items.find(entry => entry.version === 2).comment, 'Plainer.');
});

test('a call that names a requestId can be cancelled from outside: the model is told to stop, nothing is saved, the call rejects', async t => {
  const model = fakeModel(); model.delay = 150;
  const f = await fixture(t, { model }), { source, documentId } = await f.imported();
  const running = f.call('translate', { documentId, requestId: 'r1', passages: [passage(source, A)] });
  for (let i = 0; i < 100 && !model.calls.length; i += 1) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(model.calls.length, 1, 'the model was asked');
  assert.equal((await f.call('cancel', { requestId: 'r1' })).cancelled, true);
  assert.equal(model.calls[0].options.signal.aborted, true, 'the model call is aborted, not just ignored');
  await assert.rejects(running, /cancelled/i);
  assert.equal((await f.call('list', { documentId })).items.length, 0);
  assert.equal((await f.call('cancel', { requestId: 'r1' })).cancelled, false, 'nothing is left to cancel');
  const again = await f.call('translate', { documentId, requestId: 'r1', passages: [passage(source, A)] });
  assert.equal(again.status, 'done', 'a request id can be used again once its call is over');
});

/* ---------- a chapter: the effective segmentation decides which paragraphs ---------- */

test('a chapter is read through the effective segmentation: the chapters a kept outline defines, places inside one text', async t => {
  const f = await fixture(t), { source, documentId } = await f.imported(markdown(A, B, C, 'The fourth paragraph closes the second part of the notes.'));
  const before = await f.call('plan', { documentId, scope: { chapter: 0 } });
  assert.equal(before.chapters.length, 0, 'no chapters, nothing to name');
  assert.equal(before.passages.length, 0, 'a chapter that does not exist is no passage');
  await f.ops.handlers['materials.outline.save']({ documentId, entries: [{ title: 'Part one', level: 1, startBlock: 0 }, { title: 'Part two', level: 1, startBlock: 3 }], segmentLevel: 1 });
  const one = await f.call('plan', { documentId, scope: { chapter: 0 } });
  assert.deepEqual(one.chapters.map(chapter => [chapter.index, chapter.title]), [[0, 'Part one'], [1, 'Part two']]);
  assert.deepEqual(one.passages.map(entry => entry.text.slice(0, 12)), ['Notes', 'Architecture'.slice(0, 12), B.slice(0, 12)]);
  const two = await f.call('plan', { documentId, scope: { chapter: 1 } });
  assert.deepEqual(two.passages.map(entry => entry.text), [C, 'The fourth paragraph closes the second part of the notes.']);
  assert.deepEqual(two.sourceIds, [source.id]);
  const estimate = await f.call('translate', { documentId, estimate: true, scope: { chapter: 1 } });
  assert.equal(estimate.counts.toTranslate, 2);
  const done = await f.call('translate', { documentId, scope: { chapter: 1 } });
  assert.equal(done.counts.translated, 2);
  assert.deepEqual((await f.call('list', { documentId })).items.map(entry => entry.quote.slice(0, 6)), ['A CQRS', 'The fo']);
  const missing = await f.call('plan', { documentId, scope: { chapter: 9 } });
  assert.equal(missing.passages.length, 0);
});

test('a chapter of a converted book is the pages the accessor gives it', async t => {
  const f = await fixture(t);
  await f.store.update(state => {
    ['p1', 'p2', 'p3'].forEach((id, index) => state.sources.push({ id, title: `Deck · p. ${index + 1}`, text: `${[A, B, C][index]}\n\nA second paragraph on page ${index + 1}, in plain words.`, createdAt: '2026-10-01T08:00:00.000Z',
      document: { id: 'pdf-1', page: index + 1, format: 'pdf', filename: 'deck.pdf', origin: 'converted', converter: 'test-converter', chapter: { index: index === 2 ? 1 : 0, title: index === 2 ? 'Second' : 'First', level: 1 } } }));
  });
  const plan = await f.call('plan', { sourceId: 'p1', scope: { chapter: 0 } });
  assert.deepEqual([...new Set(plan.passages.map(entry => entry.sourceId))], ['p1', 'p2']);
  assert.equal(plan.passages.length, 4);
  assert.deepEqual(plan.chapters.map(chapter => chapter.title), ['First', 'Second']);
});
