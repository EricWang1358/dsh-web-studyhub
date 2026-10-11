/* 复习全书 M4 (docs/plans/review-book.md): 弄懂 / 加一段 while reading. The anchor of selected words and where its block goes (a paragraph that moved, was
   edited, was deleted); the task as ONE Job of the unified runtime (`course-book-ai`) with a fake model: explain, an instruction, under a heading, a
   follow-up, 重新生成, 保留 / 删除, a retry and a stop; it writes only a NEW block into the point's own file, quotes checked in the materials, 补充 apart;
   an editor save that met it keeps both; the book is never material. No real model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StudyService } from '../lib/service.js';
import { settleJob, until } from './helpers/wait.mjs';
import { gate, privateRoot } from './helpers/model-family-baseline.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { courseOutlineMaterial, materialsFingerprint } from '../lib/course-outline-book.js';
import { courseNotesMaterial } from '../lib/course-book.js';
import { buildOutlineIndex } from '../lib/course-outline-index.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { aiBlock, aiBlocks, anchorIn, weaveBlocks, withoutAiBlocks } from '../lib/course-book-ai-text.js';
import { plainBook, stitchBook } from '../lib/course-book-links.js';
import { assertMaterials, isLibraryListSource } from '../lib/exam-point-list.js';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';

const KIND = 'course-book-ai';

test('the anchor and where a block goes: after its paragraph; a moved or a little edited paragraph still holds it; a deleted one leaves it at the end, 原位置已变', () => {
  const gen = 'First paragraph about logs.\n\nThe architect records each decision and its reasons.\n\nThird paragraph.';
  const anchor = anchorIn(gen, 'records each decision');
  assert.ok(anchor && anchor.quote === 'records each decision' && /^[0-9a-f]{8}$/.test(anchor.hash));
  assert.equal(anchorIn(gen, 'nothing like this at all here'), null);
  const block = aiBlocks(aiBlock({ id: 'ai1', at: anchor.hash, about: 'records each decision', body: 'An explanation.' }, 'zh'))[0];
  assert.equal(block.first, '关于：「records each decision」');
  const placed = weaveBlocks([{ name: 'gen', text: gen }, { name: 'mine', text: '' }], [block]);
  assert.deepEqual(placed.parts.map(part => part.block ? `block:${part.status}` : part.text.slice(0, 12)), ['First paragr', 'block:same', 'Third paragr'], 'right after its paragraph');
  assert.match(placed.parts[0].text, /its reasons\.$/);
  const moved = 'Third paragraph.\n\nThe architect records each decision and its reasons.\n\nFirst paragraph about logs.';
  assert.deepEqual(weaveBlocks([{ name: 'gen', text: moved }], [block]).parts.map(part => part.block ? 'block' : part.text.slice(0, 5)), ['Third', 'block', 'First'], 'it follows its paragraph');
  const edited = 'First paragraph about logs.\n\nToday the architect records each   decision, with the reasons, in the log.\n\nThird paragraph.';
  const again = weaveBlocks([{ name: 'gen', text: edited }], [block]);
  assert.deepEqual(again.parts.map(part => part.block ? `block:${part.status}` : part.text.slice(0, 5)), ['First', 'block:moved', 'Third'], 'a little edited: found again');
  const deleted = weaveBlocks([{ name: 'gen', text: 'First paragraph about logs.\n\nThird paragraph.' }], [block]);
  assert.deepEqual([deleted.parts.some(part => part.block), deleted.lost.map(item => item.status)], [false, ['gone']], 'gone: shown at the end, flagged');
  const heading = aiBlocks(aiBlock({ id: 'ai2', at: 'h:h3', about: 'Point', body: 'Under the heading.' }, 'en'))[0];
  assert.deepEqual(weaveBlocks([{ name: 'gen', text: gen }], [heading]).top.map(item => item.block.id), ['ai2'], 'a 加一段 sits under the heading');
  assert.equal(heading.first, 'About: “Point”');
  // The stitched book and plain Markdown put the block after its paragraph too, without its markers.
  const stitched = stitchBook({ title: 'T', nodes: [{ hid: 'h1', number: '1', title: 'A', leaf: true, gen, mine: `My note.\n\n${block.raw}`, children: [] }], unplaced: { title: 'U', text: '' } });
  assert.ok(stitched.indexOf('An explanation.') > stitched.indexOf('its reasons.') && stitched.indexOf('An explanation.') < stitched.indexOf('Third paragraph.'));
  assert.doesNotMatch(plainBook(stitched), /sh:ai/);
  assert.equal(withoutAiBlocks(`My note.\n\n${block.raw}`), 'My note.');
});

function library() {
  const { sources, decks } = outlineLibrary();
  const state = { sources, decks, documents: [], drafts: [], attempts: [], focus: { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] } };
  const lecture = groupSourcesByDocument(sources).find(item => item.sourceIds.includes('document-l1-p1')).key;
  const outline = { ...courseOutlineMaterial({ title: '总纲 · SA', course: COURSE, orderBasis: { codes: ['numbering'] }, fingerprint: materialsFingerprint(buildOutlineIndex(state, { course: COURSE }).allDocuments),
    nodes: [{ id: 'c1', title: 'Introduction', children: [{ id: 'what', title: 'What architects do', anchors: [`${lecture}#0`] }, { id: 'none', title: 'A point with no material', anchors: ['doc:nothing'] }] }],
    other: { anchors: [] }, counts: { units: 2, leftover: 0, invalid: 0, repeated: 0 } }), createdAt: '2026-10-09T00:00:00.000Z' };
  sources.push(outline);
  const page = sources.find(source => source.id === 'document-l1-p1'), leaf = outline.courseOutline.nodes[0].children[0];
  sources.push({ ...courseNotesMaterial({ title: '复习全书 · SA', course: COURSE, outlineId: outline.id, language: 'zh', papers: [], counts: {}, leaves: [{ id: leaf.id, title: leaf.title, anchors: leaf.anchors,
    body: { fingerprint: 'f'.repeat(16), points: ['Architects decide [^1].'], explain: 'An architect writes each decision down with its reasons.\n\nA second paragraph of the explanation.',
      cites: [{ n: 1, sourceId: page.id, quote: page.text.slice(0, 30), start: 0, end: 30 }] } }] }), createdAt: '2026-10-09T01:00:00.000Z' });
  return { state, page };
}

/** A fake model: the answer names what it was asked; one invented quote (dropped by the program), one real one, one extra. */
function aiModel({ fail = () => false, held } = {}) {
  const calls = [];
  const complete = async (system, prompt) => {
    const data = JSON.parse(prompt.slice(prompt.indexOf('REQUEST DATA:\n') + 'REQUEST DATA:\n'.length));
    calls.push({ system, data });
    if (held && calls.length === held.at) await held.gate.promise;
    if (fail(calls.length)) throw new Error('provider down');
    const real = data.materials[0].text.slice(0, 40);
    return JSON.stringify({ text: `Answer ${calls.length} on ${data.words || data.point}${data.instruction ? ` (${data.instruction})` : ''}.`, quotes: [real, 'A quote that is in no material at all.'], extra: ['A general intuition.'] });
  };
  return { calls, complete };
}

async function world(t, fake = aiModel()) {
  const root = await privateRoot(t, 'course-book-ai-');
  const service = new StudyService(root, { complete: fake.complete, ...switchOptions('runtime', { complete: fake.complete, paths: [] }) });
  t.after(() => service.dispose());
  const { state, page } = library();
  await service.store.update(own => { own.sources.push(...structuredClone(state.sources)); own.decks.push(...structuredClone(state.decks)); own.focus = state.focus; });
  const book = await service.call('course.book.open');
  const point = book.nodes[0].children[0];
  const explain = args => service.call('generation.courseBook.explain', { course: COURSE, heading: point.hid, language: 'zh', ...args });
  const finish = async args => { const started = await explain(args); const job = await settleJob(service, started.jobId); return { started, job }; };
  return { service, fake, book, point, page, explain, finish, open: () => service.call('course.book.open'), jobs: () => [...service.runtime.work.jobs.values()].filter(job => job.type === KIND) };
}
const mineOf = view => view.nodes[0].children[0].mine;

test('弄懂: one visible Job, one call over the point\'s materials; a NEW block in the own file only, quotes checked, 补充 apart; the book is never material', async t => {
  const w = await world(t);
  const before = await w.open();
  const { started, job } = await w.finish({ mode: 'explain', words: 'writes each decision down' });
  assert.equal(job.status, 'complete', JSON.stringify(w.jobs().at(-1)?.contract?.error ?? null));
  assert.equal(w.fake.calls.length, 1, 'one model call');
  assert.match(w.fake.calls[0].system, /Answer the learner question using only the selected source evidence/, 'the reader\'s passage-grounded ask');
  assert.equal(w.fake.calls[0].data.words, 'writes each decision down');
  assert.ok(w.fake.calls[0].data.materials.length >= 1, 'the point\'s own materials');
  const after = await w.open(), [block] = aiBlocks(mineOf(after));
  assert.equal(block.id, started.blockId);
  assert.equal(block.first, '关于：「writes each decision down」');
  assert.equal(block.state, 'new');
  assert.match(block.body, /^Answer 1 on writes each decision down\./);
  assert.match(block.body, new RegExp(`\\*\\*资料原文\\*\\*\\n\\n> ${w.page.text.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.doesNotMatch(block.body, /in no material/, 'an unfound quote is dropped');
  assert.match(block.body, /\*\*补充（资料以外）\*\*\n\n- A general intuition\./);
  assert.equal(w.jobs().at(-1).contract.detail.dropped, 1);
  assert.equal(after.nodes[0].children[0].gen, before.nodes[0].children[0].gen, 'the generated file is not touched');
  for (const [name, file] of Object.entries(after.files)) if (name !== w.point.files.mine) assert.equal(file.version, before.files[name].version, `${name} unchanged`);
  assert.ok(after.history[w.point.files.mine] >= 1, 'in the version history');
  const record = (await w.service.store.read()).sources.find(source => source.provenance === 'course-book-doc');
  assert.ok(isLibraryListSource(record));
  assert.throws(() => assertMaterials([record]), error => error.code === 'course-book-doc-not-material');
  assert.equal(JSON.stringify(await w.service.call('source.search', { query: 'Answer 1 on' })).includes(record.id), false, 'not found by the library search');
  assert.equal(w.jobs().at(-1).contract.title, '复习全书 · 弄懂 · What architects do');
});

test('an instruction, 加一段 under a heading, a follow-up under its block, 重新生成, 保留 and 删除', async t => {
  const w = await world(t);
  const first = await w.finish({ mode: 'write', words: 'writes each decision down', instruction: '加个例子' });
  assert.match(w.fake.calls[0].data.instruction, /加个例子/);
  const here = await w.finish({ mode: 'here', instruction: '对比两种做法做个表' });
  assert.equal(w.fake.calls[1].data.words, undefined);
  const follow = await w.finish({ mode: 'follow', words: 'writes each decision down', instruction: 'Why down?', after: first.started.blockId });
  let blocks = aiBlocks(mineOf(await w.open()));
  assert.deepEqual(blocks.map(block => block.id), [first.started.blockId, follow.started.blockId, here.started.blockId], 'a follow-up goes right under the block it continues');
  assert.equal(blocks[2].at, `h:${w.point.hid}`);
  assert.deepEqual([blocks[0].mode, blocks[0].ask, blocks[2].mode, blocks[2].ask], ['write', '加个例子', 'here', '对比两种做法做个表'], 'a block remembers what was asked (for 重新生成)');
  const redo = await w.finish({ mode: 'write', words: 'writes each decision down', instruction: '加个例子', replace: first.started.blockId });
  assert.equal(redo.started.blockId, first.started.blockId);
  blocks = aiBlocks(mineOf(await w.open()));
  assert.equal(blocks.length, 3, '重新生成 writes the same block again');
  assert.match(blocks[0].body, /^Answer 4 on/);
  const kept = await w.service.call('course.book.block', { file: w.point.files.mine, id: first.started.blockId, action: 'keep' });
  assert.equal(kept.write, 'kept');
  assert.equal(aiBlocks(mineOf(kept))[0].state, 'kept');
  const deleted = await w.service.call('course.book.block', { file: w.point.files.mine, id: here.started.blockId, action: 'delete' });
  assert.deepEqual(aiBlocks(mineOf(deleted)).map(block => block.id), [first.started.blockId, follow.started.blockId]);
});

test('the system message follows the mode: an instruction is not given the explain shape and is only in the user message; 弄懂 keeps it; a follow-up has neither', async t => {
  const w = await world(t), words = 'writes each decision down', instruction = '用厨师例子通俗解释 Day1-5';
  const written = await w.finish({ mode: 'write', words, instruction });
  await w.finish({ mode: 'explain', words });
  await w.finish({ mode: 'follow', words, instruction: '没听懂，再解释一下', after: written.started.blockId });
  const [asked, explained, followed] = w.fake.calls;
  assert.doesNotMatch(asked.system, /这段在讲什么|原文说：|意思就是：|ORDER of the source/);
  assert.match(asked.system, /for the form, tone, length and examples/);
  assert.match(asked.system, /short tag "（资料以外）"/);
  assert.ok(!asked.system.includes('厨师'), 'the instruction is not in the system message');
  assert.equal(asked.data.instruction, instruction);
  assert.match(explained.system, /这段在讲什么/);
  assert.match(explained.system, /原文说：/);
  assert.doesNotMatch(followed.system, /这段在讲什么|原文说：|for the form, tone, length and examples/);
  const [block] = aiBlocks(mineOf(await w.open())).filter(item => item.id === written.started.blockId);
  assert.match(block.body, /^Answer 1 on writes each decision down/, 'the body is the model\'s text as written');
});

test('refusals cost nothing; a provider failure fails the Job with nothing written, a retry writes it once; a stop writes nothing', async t => {
  const w = await world(t, aiModel({ fail: n => n <= 2 }));
  const refused = (promise, code) => assert.rejects(promise, error => { assert.equal(error.code, code, error.message); return true; });
  await refused(w.explain({ mode: 'explain', words: '' }), 'course-book-ai-no-request');
  await refused(w.explain({ mode: 'write', words: 'x' }), 'course-book-ai-no-request');
  await refused(w.explain({ heading: 'h999', mode: 'explain', words: 'x' }), 'course-book-ai-no-point');
  await refused(w.explain({ heading: w.book.nodes[0].children[1].hid, mode: 'explain', words: 'x' }), 'course-book-ai-no-materials');
  await refused(w.service.call('generation.courseBook.explain', { course: 'No such course', heading: 'h1', words: 'x' }), 'course-book-ai-no-book');
  assert.equal(w.fake.calls.length, 0, 'no model call');
  const started = await w.explain({ mode: 'explain', words: 'writes each decision down' });
  assert.equal((await settleJob(w.service, started.jobId)).status, 'failed');
  assert.equal(aiBlocks(mineOf(await w.open())).length, 0, 'nothing written');
  await w.service.call('job.control', { jobId: started.jobId, action: 'retry' });
  assert.equal((await settleJob(w.service, started.jobId)).status, 'complete');
  assert.equal(aiBlocks(mineOf(await w.open())).length, 1);
  const held = { at: 1, gate: gate() };
  t.after(() => held.gate.release());
  const s = await world(t, aiModel({ held }));
  const run = await s.explain({ mode: 'explain', words: 'writes each decision down' });
  await until(() => s.fake.calls.length === 1, 'the call');
  await s.service.call('job.control', { jobId: run.jobId, action: 'cancel' });
  held.gate.release();
  assert.equal((await settleJob(s.service, run.jobId)).status, 'cancelled');
  assert.equal(aiBlocks(mineOf(await s.open())).length, 0, 'a stop writes nothing');
});

test('an editor save of the own file that met a new block carries the block into the learner\'s text: both kept, no suggestion', async t => {
  const held = { at: 1, gate: gate() };
  t.after(() => held.gate.release());
  const w = await world(t, aiModel({ held }));
  const opened = await w.open(), version = opened.files[w.point.files.mine].version;
  const run = await w.explain({ mode: 'explain', words: 'writes each decision down' });
  await until(() => w.fake.calls.length === 1, 'the call');
  held.gate.release();
  await settleJob(w.service, run.jobId);
  const saved = await w.service.call('course.book.save', { file: w.point.files.mine, text: 'My own note, typed while it ran.', version });
  assert.equal(saved.write, 'merged');
  assert.match(mineOf(saved), /^My own note, typed while it ran\./, 'the learner\'s text is saved');
  assert.deepEqual(aiBlocks(mineOf(saved)).map(block => block.id), [run.blockId], 'and the block that landed meanwhile comes along');
  assert.deepEqual(saved.files[w.point.files.mine].suggestions, [], 'nothing else changed: no suggestion to choose');
  // A second block while the learner edits again: it goes after the first; the learner's edit stays.
  const again = (await w.open()).files[w.point.files.mine].version;
  const next = await w.explain({ mode: 'follow', words: 'writes each decision down', instruction: 'More?', after: run.blockId });
  await settleJob(w.service, next.jobId);
  const twice = await w.service.call('course.book.save', { file: w.point.files.mine, text: `${mineOf(saved)}\n\nOne more line of mine.`, version: again });
  assert.deepEqual(aiBlocks(mineOf(twice)).map(block => block.id), [run.blockId, next.blockId]);
  assert.match(mineOf(twice), /One more line of mine\./);
  assert.deepEqual(twice.files[w.point.files.mine].suggestions, []);
});
