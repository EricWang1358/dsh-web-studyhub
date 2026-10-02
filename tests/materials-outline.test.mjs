/* AI re-outline of a document (materials.outline.*): the numbered blocks the model is given, the validator of its
   answer, the operations with a fake model, and the outline kept per document revision. No network, no real model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { createMaterialsOperations } from '../lib/contexts/materials/operations.js';
import { OUTLINE_LIMITS, planOutline, outlinePrompt, validateOutline } from '../lib/contexts/materials/outline.js';
import { reportUsage, withUsageSink } from '../lib/usage-scope.js';
import { bilingualMarkdown, projectedText } from './helpers/bilingual-transcript.mjs';

const text = projectedText(bilingualMarkdown());
const source = (body, id = 's1') => ({ id, text: body });
const reply = entries => JSON.stringify({ outline: entries });

/** The outline a careful model would write for the fixture: the title, then each part. */
function fakeOutline(prompt) {
  const { blocks } = JSON.parse(prompt);
  return reply(blocks.filter(block => block.text === '平台经济课堂实录' || block.text.startsWith('第')).map(block =>
    ({ title: block.text, level: block.text.startsWith('第') ? 2 : 1, startBlock: block.index })));
}
const withUsage = (run, sink) => withUsageSink({ key: 'test', sink }, run);
const usage = { uncachedInputTokens: 1800, outputTokens: 420, cacheReadTokens: 0, cacheWriteTokens: 0 };
const fakeModel = async (_system, prompt) => { reportUsage(usage); return fakeOutline(prompt); };

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'materials-outline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const ops = createMaterialsOperations({ root,
    read: async () => { const state = await store.read(); return structuredClone({ sources: state.sources, documents: state.documents || [] }); },
    update: fn => store.update(async state => {
      const own = { sources: state.sources, documents: state.documents || [] };
      const result = await fn(own); state.sources = own.sources; state.documents = own.documents; return result;
    }), ...options });
  const call = (action, args = {}, request = {}) => ops.handlers[action](args, request);
  const imported = async (body = bilingualMarkdown(), filename = 'platform.md') => {
    const result = await call('materials.document.import', { filename, dataBase64: Buffer.from(body).toString('base64') });
    return { ...result, document: await call('materials.document.get', { id: result.documentId }) };
  };
  return { root, store, call, imported };
}

/* ---------- what the model is given ---------- */

test('the document becomes numbered blocks: a block per line of a projected text, a block per paragraph of a text with blank lines', () => {
  const lines = planOutline([source(text)]);
  assert.equal(lines.condensed, false);
  assert.equal(lines.units[0].excerpt, '平台经济课堂实录');
  assert.equal(lines.units[1].excerpt, '第一部分：平台的含义与作用');
  assert.equal(lines.units.length, text.split('\n').length);
  assert.deepEqual(lines.units.map(unit => unit.index), lines.units.map((_, index) => index));
  const paragraphs = planOutline([source('Title\nsubtitle line\n\nFirst paragraph\nwraps here.\n\nSecond paragraph.')]);
  assert.deepEqual(paragraphs.units.map(unit => [unit.excerpt, unit.lines]), [['Title', 2], ['First paragraph', 2], ['Second paragraph.', 1]], 'the model sees the first line, and that the block goes on');
  assert.deepEqual(JSON.parse(outlinePrompt(paragraphs).prompt).blocks.map(block => block.lines), [2, 2, undefined]);
  const unit = lines.units[2];
  assert.equal(text.slice(unit.start, unit.start + unit.excerpt.length), unit.excerpt, 'a block starts where its text starts in the stored text');
  assert.deepEqual(planOutline([source('  \n \n')]).units, []);
});

test('a long document is condensed deterministically: headings-like lines stay, the rest is sampled, and the plan says so', () => {
  const body = Array.from({ length: 1500 }, (_, n) => n % 50 === 0 ? `Chapter ${n / 50 + 1}` : `A sentence of body text number ${n} that goes on for a while so it is not a heading, and ends here.`).join('\n\n');
  const plan = planOutline([source(body)]);
  assert.equal(plan.blocks, 1500);
  assert.equal(plan.condensed, true);
  assert.ok(plan.units.length <= OUTLINE_LIMITS.maxUnits && plan.units.length > 30);
  assert.equal(plan.units.filter(unit => unit.excerpt.startsWith('Chapter ')).length, 30, 'every chapter heading is a start the model can point to');
  assert.deepEqual(planOutline([source(body)]).units, plan.units, 'the same text always gives the same plan');
  const { system, prompt } = outlinePrompt(plan, { title: 'Big book' });
  assert.ok(system.length + prompt.length < 40000, 'the prompt is capped, not the document');
  assert.ok(prompt.length < body.length / 2);
  assert.equal(JSON.parse(prompt).condensed, true);
});

test('the prompt carries the numbered blocks, calls the text untrusted and asks for JSON only', () => {
  const { system, prompt } = outlinePrompt(planOutline([source(text)]), { title: '平台经济', language: '中文' });
  assert.match(system, /untrusted/i);
  assert.match(system, /JSON/);
  assert.match(system, /startBlock/);
  const data = JSON.parse(prompt);
  assert.equal(data.blocks[1].index, 1);
  assert.equal(data.blocks[1].text, '第一部分：平台的含义与作用');
  assert.equal(data.title, '平台经济');
  assert.equal(data.condensed, false);
});

/* ---------- what comes back ---------- */

const plan = planOutline([source(text)]);
const parts = plan.units.filter(unit => unit.excerpt.startsWith('第'));
const valid = [{ title: '平台经济课堂实录', level: 1, startBlock: 0 }, ...parts.map(unit => ({ title: unit.excerpt, level: 2, startBlock: unit.index }))];

test('a valid outline is accepted, with the position each title points to', () => {
  const result = validateOutline(reply(valid), plan);
  assert.equal(result.ok, true);
  assert.equal(result.entries.length, 10);
  assert.deepEqual(result.entries.slice(0, 2).map(entry => [entry.title, entry.level, entry.startBlock, entry.kind]), [['平台经济课堂实录', 1, 0, 'quoted'], ['第一部分：平台的含义与作用', 2, 1, 'quoted']]);
  const entry = result.entries[3];
  assert.equal(entry.anchor.sourceId, 's1');
  assert.equal(text.slice(entry.anchor.offset, entry.anchor.offset + 4), entry.title.slice(0, 4), 'the anchor is a real offset of the stored text');
  assert.equal(entry.anchor.ordinal, 0);
  assert.deepEqual(result.warnings, []);
  assert.equal(validateOutline(JSON.stringify(valid), plan).ok, true, 'a bare array is fine');
  assert.equal(validateOutline('Here you go:\n```json\n' + reply(valid) + '\n```', plan).ok, true, 'a fenced answer is fine');
});

test('the anchor of a repeated line says which occurrence it is', () => {
  const repeated = planOutline([source('Intro\nOriginal\nsome text here\nOriginal\nmore text here\nOriginal\nlast text here')]);
  const result = validateOutline(reply([{ title: 'Intro', level: 1, startBlock: 0 }, { title: 'Original', level: 2, startBlock: 3 }, { title: 'Original', level: 2, startBlock: 5 }]), repeated);
  assert.equal(result.ok, true);
  assert.deepEqual(result.entries.map(entry => entry.anchor.ordinal), [0, 1, 2], 'the second and third "Original" are not the first');
});

test('a label the model adds is accepted when short, marked as a label, and it must point at a real block', () => {
  const result = validateOutline(reply([{ title: '开场', level: 1, startBlock: 0 }, { title: '平台是什么', level: 2, startBlock: 2 }]), plan);
  assert.equal(result.ok, true);
  assert.deepEqual(result.entries.map(entry => entry.kind), ['label', 'label']);
});

test('invalid answers are rejected with a code and a plain message; the heuristic outline stays', () => {
  const check = (raw, code) => { const result = validateOutline(raw, plan); assert.equal(result.ok, false, code); assert.equal(result.code, code); assert.ok(result.message.length > 10); };
  check('I cannot do that.', 'not-json');
  check('{"outline": []}', 'empty');
  check('{"outline": "none"}', 'not-json');
  check(reply([{ title: 'A', level: 1, startBlock: 9999 }]), 'bad-start');
  check(reply([{ title: 'A', level: 1, startBlock: -1 }]), 'bad-start');
  check(reply([{ title: 'A', level: 1, startBlock: 1.5 }]), 'bad-start');
  check(reply([{ title: 'A', level: 1, startBlock: '3' }]), 'bad-start');
  check(reply([{ title: '开场', level: 1, startBlock: 3 }, { title: '续', level: 1, startBlock: 3 }]), 'not-increasing');
  check(reply([{ title: '开场', level: 1, startBlock: 5 }, { title: '续', level: 1, startBlock: 2 }]), 'not-increasing');
  check(reply([{ title: '开场', level: 0, startBlock: 0 }]), 'bad-level');
  check(reply([{ title: '开场', level: 4, startBlock: 0 }]), 'bad-level');
  check(reply([{ title: '开场', level: 1.5, startBlock: 0 }]), 'bad-level');
  check(reply([{ title: '', level: 1, startBlock: 0 }]), 'bad-title');
  check(reply([{ title: '   ', level: 1, startBlock: 0 }]), 'bad-title');
  check(reply([{ title: 'x'.repeat(OUTLINE_LIMITS.maxTitle + 1), level: 1, startBlock: 0 }]), 'bad-title');
  check(reply([{ level: 1, startBlock: 0 }]), 'bad-title');
  check(reply(Array.from({ length: OUTLINE_LIMITS.maxEntries + 1 }, (_, n) => ({ title: `第 ${n}`, level: 1, startBlock: n }))), 'too-many');
});

test('a title that is not in the text and is not a short label is invented, and is rejected', () => {
  const invented = '本章系统论述了平台经济的垄断风险以及监管部门应当采取的全部治理措施和长期政策建议';
  const result = validateOutline(reply([{ title: invented, level: 1, startBlock: 1 }]), plan);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ungrounded');
});

test('a heading quoted from the text but pointed at the wrong block is misplaced, and is rejected', () => {
  const fifth = parts[4];
  const result = validateOutline(reply([{ title: fifth.excerpt, level: 1, startBlock: 1 }]), plan);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'misplaced');
  assert.equal(validateOutline(reply([{ title: fifth.excerpt, level: 1, startBlock: fifth.index }]), plan).ok, true);
});

test('levels are repaired, not trusted: the first entry opens at 1 and a level never skips down more than one', () => {
  const result = validateOutline(reply([{ title: '开场', level: 2, startBlock: 0 }, { title: '深处', level: 3, startBlock: 1 }, { title: '更深', level: 3, startBlock: 2 }]), plan);
  assert.equal(result.ok, true);
  assert.deepEqual(result.entries.map(entry => entry.level), [1, 2, 3]);
  assert.ok(result.warnings.includes('levels-adjusted'));
  const skip = validateOutline(reply([{ title: '开场', level: 1, startBlock: 0 }, { title: '深处', level: 3, startBlock: 1 }]), plan);
  assert.deepEqual(skip.entries.map(entry => entry.level), [1, 2]);
});

test('titles are tidied: markers and extra space go, the text of the heading stays', () => {
  const result = validateOutline(reply([{ title: '  ## 第一部分：  平台的含义与作用 ', level: 1, startBlock: 1 }]), plan);
  assert.equal(result.ok, true);
  assert.equal(result.entries[0].title, '第一部分： 平台的含义与作用');
});

test('in a condensed document a position is a unit, so a block that was folded away cannot be pointed at', () => {
  const body = Array.from({ length: 1500 }, (_, n) => n % 50 === 0 ? `Chapter ${n / 50 + 1}` : `A sentence of body text number ${n} that goes on for a while so it is not a heading, and ends here.`).join('\n\n');
  const big = planOutline([source(body)]);
  const chapters = big.units.filter(unit => unit.excerpt.startsWith('Chapter '));
  assert.equal(validateOutline(reply(chapters.map(unit => ({ title: unit.excerpt, level: 1, startBlock: unit.index }))), big).ok, true);
  assert.equal(validateOutline(reply([{ title: 'Chapter 1', level: 1, startBlock: 1000 }]), big).code, 'bad-start', 'there are fewer units than blocks');
});

/* ---------- operations ---------- */

test('suggest with estimate: true prices the one call and does not call the model', async t => {
  const { call, imported } = await fixture(t, { complete: () => { throw new Error('the estimate must not call the model'); } });
  const { documentId } = await imported();
  const result = await call('materials.outline.suggest', { documentId, estimate: true });
  assert.equal(result.status, 'estimate');
  assert.equal(result.modelAvailable, true);
  assert.equal(result.coverage.condensed, false);
  assert.ok(result.coverage.units > 60 && result.coverage.chars > 1000);
  assert.equal(result.estimate.feature, 'outline');
  assert.ok(result.estimate.totalTokens.high >= result.estimate.totalTokens.low && result.estimate.totalTokens.low > 0);
  assert.deepEqual(result.estimate.calls, { low: 1, high: 1 });
  const noModel = await fixture(t);
  const { documentId: other } = await noModel.imported();
  assert.equal((await noModel.call('materials.outline.suggest', { documentId: other, estimate: true })).modelAvailable, false);
});

test('suggest without a model says so plainly and changes nothing', async t => {
  const { call, imported } = await fixture(t);
  const { documentId } = await imported();
  const result = await call('materials.outline.suggest', { documentId });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.capability, 'model');
  assert.match(result.message, /model/i);
});

test('suggest makes ONE call with the numbered blocks and returns the checked outline with the usage', async t => {
  const calls = [];
  const { call, imported } = await fixture(t);
  const { documentId } = await imported();
  const result = await call('materials.outline.suggest', { documentId }, { complete: async (system, prompt, options) => { calls.push({ system, prompt, options }); return fakeModel(system, prompt); } });
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].prompt).blocks.length, result.coverage.units);
  assert.equal(result.status, 'proposed');
  assert.equal(result.entries.length, 10);
  assert.deepEqual(result.usage, { ...usage, calls: 1 });
  assert.equal(result.documentId, documentId);
  assert.ok(result.revision);
});

test('suggest rejects an invalid answer with the reason and the usage it cost, and stores nothing', async t => {
  const { call, imported } = await fixture(t);
  const { documentId } = await imported();
  const result = await call('materials.outline.suggest', { documentId }, { complete: async () => { reportUsage(usage); return reply([{ title: 'A', level: 1, startBlock: 99999 }]); } });
  assert.equal(result.status, 'rejected');
  assert.equal(result.code, 'bad-start');
  assert.equal(result.usage.outputTokens, 420);
  assert.equal((await call('materials.document.get', { documentId })).outline, undefined);
});

test('suggest honours an abort and reports no usage when the model did not report any', async t => {
  const { call, imported } = await fixture(t);
  const { documentId } = await imported();
  const controller = new AbortController();
  await assert.rejects(call('materials.outline.suggest', { documentId }, { signal: controller.signal, complete: async (system, prompt) => { controller.abort(new Error('stopped')); return fakeOutline(prompt); } }), /stopped/);
  const quiet = await call('materials.outline.suggest', { documentId }, { complete: async (_system, prompt) => fakeOutline(prompt) });
  assert.equal(quiet.status, 'proposed');
  assert.equal(quiet.usage, null);
});

test('save keeps the outline on the current revision; the text, the selections and the links do not change', async t => {
  const { call, imported, store } = await fixture(t);
  const { documentId, document } = await imported();
  const quote = '平台让两类人群找到彼此，第3个例子说明平台规则如何改变各方的行为。';
  const before = await call('materials.selection.resolve', { documentId, revision: document.revision, quote });
  assert.equal(before.status, 'resolved');
  const stateBefore = JSON.stringify((await store.read()).sources);
  const suggestion = await call('materials.outline.suggest', { documentId }, { complete: fakeModel });
  const saved = await call('materials.outline.save', { documentId, revision: document.revision, entries: suggestion.entries.map(({ title, level, startBlock }) => ({ title, level, startBlock })), usage: suggestion.usage });
  assert.equal(saved.saved, true);
  const after = await call('materials.document.get', { documentId });
  assert.equal(after.outline.entries.length, 10);
  assert.equal(after.outline.entries[2].anchor.sourceId, document.sources[0].id);
  assert.equal(after.outline.revision, document.revision);
  assert.ok(after.outline.savedAt);
  assert.deepEqual(after.outline.usage, { ...usage, calls: 1 });
  assert.equal(after.outlineStale, undefined);
  assert.equal(JSON.stringify((await store.read()).sources), stateBefore, 'the stored text and sources are untouched');
  assert.deepEqual(await call('materials.selection.resolve', { documentId, revision: document.revision, quote }), before, 'a selection resolves to the same position');
  assert.ok(!JSON.stringify(after.versions).includes('anchor'), 'the outline is not repeated in the version list');
  const listed = await call('materials.document.list', {});
  assert.equal(listed.documents[0].outline, undefined, 'the list stays light');
});

test('save validates again: an outline that does not fit the stored text is refused', async t => {
  const { call, imported } = await fixture(t);
  const { documentId } = await imported();
  await assert.rejects(call('materials.outline.save', { documentId, entries: [{ title: 'A', level: 1, startBlock: 99999 }] }), /bad-start|position/i);
  await assert.rejects(call('materials.outline.save', { documentId, entries: [] }), /empty|outline/i);
  await assert.rejects(call('materials.outline.save', { documentId }), /entries/);
  assert.equal((await call('materials.document.get', { documentId })).outline, undefined);
});

test('clear returns to the automatic outline; clearing nothing is harmless', async t => {
  const { call, imported } = await fixture(t);
  const { documentId } = await imported();
  assert.deepEqual(await call('materials.outline.clear', { documentId }), { cleared: false, hadSegmentation: false, documentId, revision: (await call('materials.document.get', { documentId })).revision });
  const suggestion = await call('materials.outline.suggest', { documentId }, { complete: fakeModel });
  await call('materials.outline.save', { documentId, entries: suggestion.entries });
  assert.equal((await call('materials.outline.clear', { documentId })).cleared, true);
  assert.equal((await call('materials.document.get', { documentId })).outline, undefined);
});

test('a new revision drops the outline from the current view and says an older one exists; the old revision keeps its own', async t => {
  const { call, imported } = await fixture(t);
  const first = await imported();
  const suggestion = await call('materials.outline.suggest', { documentId: first.documentId }, { complete: fakeModel });
  await call('materials.outline.save', { documentId: first.documentId, entries: suggestion.entries });
  const edited = bilingualMarkdown() + '\n\n## 第十部分：补充材料\n\n新增的一段内容。\n';
  await call('materials.document.attach', { documentId: first.documentId, filename: 'platform.md', dataBase64: Buffer.from(edited).toString('base64') });
  const current = await call('materials.document.get', { documentId: first.documentId });
  assert.notEqual(current.revision, first.document.revision);
  assert.equal(current.outline, undefined, 'the outline of the old text is not applied to the new text');
  assert.equal(current.outlineStale.revision, first.document.revision);
  assert.equal(current.outlineStale.entries, 10);
  const old = await call('materials.document.get', { documentId: first.documentId, revision: first.document.revision });
  assert.equal(old.outline.entries.length, 10, 'a citation opened at the old revision still sees the old outline');
  assert.equal(old.outlineStale, undefined);
  await call('materials.document.attach', { documentId: first.documentId, filename: 'platform.md', dataBase64: Buffer.from(bilingualMarkdown()).toString('base64') });
  assert.equal((await call('materials.document.get', { documentId: first.documentId })).outline.entries.length, 10, 'back to the same text: the same revision, the outline is there again');
});

test('a source with no document record (an audio transcript, an older import) keeps its outline too', async t => {
  const { call, store } = await fixture(t);
  await store.update(state => { state.sources.push({ id: 'legacy-1', title: '课堂录音', text, createdAt: '2026-09-01T00:00:00.000Z' }); });
  const suggestion = await call('materials.outline.suggest', { sourceId: 'legacy-1' }, { complete: fakeModel });
  assert.equal(suggestion.status, 'proposed');
  await call('materials.outline.save', { sourceId: 'legacy-1', entries: suggestion.entries });
  const got = await call('materials.document.get', { sourceId: 'legacy-1' });
  assert.equal(got.outline.entries.length, 10);
  assert.equal((await call('materials.document.list', {})).total, 1, 'no second document appears');
  assert.equal((await store.read()).documents?.length ?? 0, 0, 'no document record was invented');
  await call('materials.outline.clear', { sourceId: 'legacy-1' });
  assert.equal((await call('materials.document.get', { sourceId: 'legacy-1' })).outline, undefined);
});

test('an outline travels with a library backup like other document metadata', async t => {
  const { call, imported, store } = await fixture(t);
  const { documentId } = await imported();
  const suggestion = await call('materials.outline.suggest', { documentId }, { complete: fakeModel });
  await call('materials.outline.save', { documentId, entries: suggestion.entries });
  const exported = structuredClone(await store.read()); // what "export the library" returns (library.export reads the same state)
  assert.equal(exported.documents[0].versions[0].outline.entries.length, 10);
  const other = await fixture(t);
  await other.store.restore(structuredClone(exported));
  assert.equal((await other.call('materials.document.get', { documentId })).outline.entries.length, 10);
});

test('the preview fake model answers the outline prompt with an outline that passes the same check, and reports usage', async () => {
  const { createFakeModel } = await import('../scripts/fake-model.mjs');
  const seen = [], { system, prompt } = outlinePrompt(plan, { title: '平台经济课堂实录' });
  const reply = await withUsage(() => createFakeModel({ usage: true })(system, prompt), report => seen.push(report));
  const checked = validateOutline(reply, plan);
  assert.equal(checked.ok, true, checked.message);
  assert.equal(checked.entries.length, 10, 'the title and nine parts');
  assert.deepEqual(checked.entries.map(entry => entry.level), [1, ...Array(9).fill(2)]);
  assert.equal(seen.length, 1);
  const chapters = outlinePrompt(plan, { title: '平台经济课堂实录', mode: 'chapters' });
  const checkedChapters = validateOutline(await createFakeModel()(chapters.system, chapters.prompt), plan, { mode: 'chapters' });
  assert.equal(checkedChapters.ok, true, checkedChapters.message);
  assert.deepEqual([checkedChapters.entries.length, [...new Set(checkedChapters.entries.map(entry => entry.level))]], [9, [1]], 'the nine parts, no title, one level');
});

/* ---------- through the runtime, as the panel and the tools call it ---------- */

test('the runtime exposes outline.suggest / save / clear; suggest needs a model only to run, not to be priced', async t => {
  const { root } = await fixture(t);
  const runtime = createStudyRuntime(root, { contexts: ['materials'] });
  t.after(() => runtime.dispose());
  const described = runtime.capabilities({ complete: fakeModel }).find(domain => domain.id === 'materials');
  const names = described.operations.map(operation => operation.name);
  for (const name of ['outline.suggest', 'outline.save', 'outline.clear']) assert.ok(names.includes(name), name);
  const imported = await runtime.call('materials.document.import', { filename: 'platform.md', dataBase64: Buffer.from(bilingualMarkdown()).toString('base64') });
  const priced = await runtime.call('materials.outline.suggest', { documentId: imported.documentId, estimate: true }, {});
  assert.equal(priced.status, 'estimate');
  assert.equal(priced.modelAvailable, false);
  const refused = await runtime.call('materials.outline.suggest', { documentId: imported.documentId }, {});
  assert.deepEqual([refused.available, refused.reason], [false, 'model_unavailable']);
  const proposed = await runtime.call('materials.outline.suggest', { documentId: imported.documentId }, { complete: fakeModel });
  assert.equal(proposed.status, 'proposed');
  const saved = await runtime.call('materials.outline.save', { documentId: imported.documentId, entries: proposed.entries });
  assert.equal(saved.saved, true);
  assert.equal((await runtime.call('materials.document.get', { documentId: imported.documentId })).outline.entries.length, 10);
});
