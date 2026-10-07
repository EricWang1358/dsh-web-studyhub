/* 3.1.0 step 1: an exam blueprint is a special kind of material. It is an ordinary source record (readable text + extra fields), so it goes in through the
   existing `sources.ingest` of the materials context, opens in the 资料 list and reader like any text material, keeps where each exam point came from as
   resolvable selections, and a library that holds one stays readable by release 3.0.0. Fakes only: no model, no network.
   First-release inputs: a lecture deck (primary), ONE sample paper (shape, no frequency), a recommended textbook that is only a note. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from '../lib/store.js';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { resolveSelectionState } from '../lib/contexts/materials/operations.js';
import { groupSourcesByDocument, sourceFormat } from '../lib/source-groups.js';
import { extractRelease } from './fixtures/extract-release.mjs';
import { BLUEPRINT_LIMITS, blueprintEvidenceIssues, examBlueprintMaterial, isExamBlueprintSource, normalizeExamBlueprint } from '../lib/exam-blueprint-material.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// A lecture deck is one source per slide (slide 5 is a picture only and was skipped at import), plus ONE sample paper.
const PAPER = { id: 'paper-2023', title: '老师给的样卷', text: '第一题 简述 TCP 三次握手的作用。\n第二题 比较 UDP 与 TCP 的可靠性差异。' };
const SLIDE_3 = { id: 'deck-3', title: '传输层.pptx · 第 3 页', text: '## 第 3 页 · TCP 连接管理\n\n三次握手：SYN、SYN-ACK、ACK', document: { id: 'deck', page: 3, format: 'pptx' } };
const SLIDE_4 = { id: 'deck-4', title: '传输层.pptx · 第 4 页', text: '## 第 4 页 · 可靠传输\n\n滑动窗口与累积确认', document: { id: 'deck', page: 4, format: 'pptx' } };
const SOURCES = [PAPER, SLIDE_3, SLIDE_4].map(source => ({ ...source, createdAt: '2026-10-01T00:00:00.000Z', courses: ['网络'] }));
const input = () => ({ title: '网络 · 传输层 考点清单', courses: ['网络'], scope: { label: '传输层' },
  recommendedReading: { title: 'Computer Networking: A Top-Down Approach', author: 'Kurose & Ross' },
  inputs: [{ role: 'lecture', documentId: 'deck', sourceIds: [SLIDE_3.id, SLIDE_4.id], title: '传输层.pptx', skippedPages: [5] },
    { role: 'past-paper', sourceId: PAPER.id, title: PAPER.title }],
  points: [
    { id: 'p1', title: 'TCP 连接管理', requirement: '掌握', evidence: [{ sourceId: SLIDE_3.id, page: 3, quote: '三次握手：SYN、SYN-ACK、ACK' }, { sourceId: PAPER.id, quote: '简述 TCP 三次握手的作用' }] },
    { id: 'p2', title: '可靠传输', status: 'confirmed', evidence: [{ sourceId: SLIDE_4.id, page: 4, quote: '滑动窗口与累积确认' }] },
  ] });

async function library(t) {
  const root = await mkdtemp(join(tmpdir(), 'exam-blueprint-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const runtime = createStudyRuntime(root, { contexts: ['materials'] });
  t.after(() => runtime.dispose());
  await runtime.invoke('materials.v1', 'sources.ingest', { sources: structuredClone(SOURCES) });
  return { root, runtime };
}

test('the record is deterministic, readable text with the structured list beside it', () => {
  const a = examBlueprintMaterial(input()), b = examBlueprintMaterial(input());
  assert.equal(a.id, b.id, 'the same blueprint is one material');
  assert.match(a.id, /^exam-blueprint-[0-9a-f]{40}$/);
  assert.equal(a.provenance, 'exam-blueprint');
  assert.equal(a.format, 'md');
  assert.deepEqual(a.courses, ['网络']);
  assert.equal(a.blueprint.version, 1);
  assert.deepEqual(a.blueprint.points.map(point => [point.id, point.status]), [['p1', 'pending'], ['p2', 'confirmed']]);
  for (const word of ['传输层', 'TCP 连接管理', '[p2]', '已确认', '传输层.pptx', '依据（讲义 第 3 页）：“三次握手：SYN、SYN-ACK、ACK”']) assert.ok(a.text.includes(word), word);
  assert.ok(isExamBlueprintSource(a));
  assert.ok(!isExamBlueprintSource({ id: 'x', text: 'plain' }) && !isExamBlueprintSource({ provenance: 'exam-blueprint' }));
  const changed = input(); changed.points[1].title = '可靠数据传输';
  assert.notEqual(examBlueprintMaterial(changed).id, a.id, 'a changed blueprint is a new material; the old stays');
});

test('every point says how it is backed, and the blueprint says it rests on one sample paper', () => {
  const { blueprint, text } = examBlueprintMaterial(input());
  assert.deepEqual(blueprint.points.map(point => point.backing), [{ slides: 1, samplePapers: 1, kind: 'both' }, { slides: 1, samplePapers: 0, kind: 'slides' }]);
  assert.deepEqual(blueprint.basis, { samplePapers: 1, frequency: 'not-computed', skippedSlides: 1, label: '依据 1 份样卷；权重仅供参考' });
  for (const word of ['依据 1 份样卷；权重仅供参考', '（待核对；讲义 1 页 + 样卷）', '（已确认；讲义 1 页）', '第 5 页没有可读文字，未列入']) assert.ok(text.includes(word), word);
  // The evidence role is written even when the caller left it out; a slide place counts as a slide.
  assert.deepEqual(blueprint.points[0].evidence.map(place => place.role), ['lecture', 'past-paper']);
  // Without a sample paper there is no exam shape and no weights; with three there may be a frequency, with the sampling caveat.
  const none = input(); none.inputs.pop(); none.points[0].evidence.pop();
  assert.equal(normalizeExamBlueprint(none).basis.label, '没有样卷：只列出讲义中的考点，不含考试形态与权重');
  assert.equal(normalizeExamBlueprint(none).points[0].backing.kind, 'slides');
  const many = input();
  for (const id of ['paper-b', 'paper-c']) many.inputs.push({ role: 'past-paper', sourceId: id });
  many.points[0].evidence.push({ sourceId: 'paper-b', quote: '第一题' }, { sourceId: 'paper-c', quote: '第二题' });
  assert.deepEqual(normalizeExamBlueprint(many).basis, { samplePapers: 3, frequency: 'allowed', skippedSlides: 1, label: '依据 3 份样卷；样本由学生选定，不是随机样本' });
  assert.equal(normalizeExamBlueprint(many).points[0].backing.samplePapers, 3);
  // The recommended textbook is a note: shown, never an input and never evidence.
  assert.deepEqual(blueprint.recommendedReading, { title: 'Computer Networking: A Top-Down Approach', author: 'Kurose & Ross' });
  assert.ok(text.includes('推荐阅读（未导入，不作依据）'));
  assert.equal(blueprint.inputs.some(item => item.role === 'textbook'), false);
});

test('a blueprint that cannot be traced is refused before anything is stored', () => {
  const bad = patch => { const value = input(); patch(value); return () => examBlueprintMaterial(value); };
  assert.throws(bad(v => { v.points = []; }), /at least one exam point/);
  assert.throws(bad(v => { v.points[1].id = 'p1'; }), /repeated/);
  assert.throws(bad(v => { v.points[0].evidence = []; }), /at least one place/);
  assert.throws(bad(v => { v.points[0].evidence[0].quote = '   '; }), /quote is required/);
  assert.throws(bad(v => { v.points[0].evidence[0].sourceId = 'other'; }), /not an input/);
  assert.throws(bad(v => { v.points[0].evidence[0].role = 'textbook'; }), /not an input/, 'a textbook that was never imported cannot be cited');
  assert.throws(bad(v => { v.points[0].status = 'sure'; }), /unknown status/);
  assert.throws(bad(v => { v.points[0].parentId = 'nope'; }), /parent/);
  assert.throws(bad(v => { v.inputs[0].role = 'rumour'; }), /Unknown input role/);
  assert.throws(bad(v => { v.inputs.push({ role: 'past-paper', sourceId: PAPER.id }); }), /twice/);
  assert.throws(bad(v => { v.inputs.push({ role: 'lecture' }); }), /documentId or sourceIds/);
  assert.throws(bad(v => { v.points[0].evidence[0].start = 3; }), /together/);
  assert.throws(bad(v => { v.recommendedReading = { title: '某教材', url: 'ftp://example.invalid/x' }; }), /http or https/);
  assert.throws(bad(v => { v.recommendedReading = { author: 'nobody' }; }), /title is required/);
  assert.throws(bad(v => { v.points = Array.from({ length: BLUEPRINT_LIMITS.points + 1 }, (_, i) => ({ id: `q${i}`, title: 't', evidence: [{ sourceId: SLIDE_3.id, quote: 'q' }] })); }), /at most 300/);
  assert.throws(() => examBlueprintMaterial({ ...input(), title: '' }), /title is required/);
});

test('the minimal valid input is lecture slides (or a syllabus); a paper alone is refused, and a paper cannot back a point alone', () => {
  const only = roles => ({ ...input(), inputs: input().inputs.filter(item => roles.includes(item.role)), points: [{ id: 'p1', title: 't', evidence: [{ sourceId: PAPER.id, quote: '第一题' }] }] });
  for (const roles of [[], ['past-paper']]) assert.throws(() => examBlueprintMaterial(only(roles)), /needs lecture slides or a syllabus/);
  assert.throws(() => examBlueprintMaterial({ ...input(), inputs: [...input().inputs.filter(item => item.role !== 'lecture'), { role: 'textbook', sourceId: 'book-1' }] }),
    /needs lecture slides or a syllabus/, 'a textbook is never the source of the points');
  assert.throws(() => examBlueprintMaterial(only(['lecture', 'past-paper'])), /needs a place in the lecture slides or syllabus/, 'a point backed by the sample paper alone is refused');
  const syllabus = { ...input(), inputs: [{ role: 'syllabus', sourceId: 'syllabus-1' }], points: [{ id: 'p1', title: 't', evidence: [{ sourceId: 'syllabus-1', quote: 'q' }] }] };
  assert.equal(normalizeExamBlueprint(syllabus).basis.samplePapers, 0, 'a syllabus is an accepted primary input too');
});

test('it goes in through the existing material pipeline and shows as one ordinary Markdown material', async t => {
  const { runtime } = await library(t);
  const record = examBlueprintMaterial(input());
  await runtime.invoke('materials.v1', 'sources.ingest', { sources: [structuredClone(record)] });
  await runtime.invoke('materials.v1', 'sources.ingest', { sources: [structuredClone(record)] }); // saving it twice changes nothing
  const state = await runtime.invoke('materials.v1', 'state.read', {});
  assert.equal(state.sources.filter(source => source.id === record.id).length, 1);
  const stored = state.sources.find(source => source.id === record.id);
  assert.deepEqual(stored.blueprint, record.blueprint, 'the structured list is kept as written');
  assert.equal(stored.provenance, 'exam-blueprint');
  // The 资料 list groups it as one item of the format it already knows; nothing in the list needed to change.
  const items = groupSourcesByDocument(state.sources, { documents: state.documents });
  const item = items.find(entry => entry.sourceIds.includes(record.id));
  assert.equal(item.format, 'md');
  assert.equal(sourceFormat(stored), 'md');
  // The documents list and the reader open it as extracted text.
  const listed = await runtime.call('materials.document.list', {});
  assert.ok(listed.documents.some(document => document.sourceIds.includes(record.id)));
  const opened = await runtime.call('materials.document.get', { sourceId: record.id });
  assert.equal(opened.sources[0].text, record.text);
  assert.equal(opened.originalAvailable, false);
  // A different text under the same id is the identity conflict the pipeline already refuses.
  await assert.rejects(runtime.invoke('materials.v1', 'sources.ingest', { sources: [{ ...structuredClone(record), text: `${record.text}x` }] }), /identity conflict/);
});

test('every place an exam point came from is checked by the one resolver that checks citations, slide page included', async t => {
  const { runtime } = await library(t);
  const record = examBlueprintMaterial(input());
  await runtime.invoke('materials.v1', 'sources.ingest', { sources: [structuredClone(record)] });
  const state = await runtime.invoke('materials.v1', 'state.read', {});
  const resolve = selection => resolveSelectionState(state, selection);
  assert.deepEqual(blueprintEvidenceIssues(record, resolve), []);
  // The sample paper changes its wording (a new import with another text): only that place no longer resolves, and the point says which.
  const edited = structuredClone(state); edited.sources.find(source => source.id === PAPER.id).text = '第一题 简述 TCP 的作用。';
  assert.deepEqual(blueprintEvidenceIssues(record, selection => resolveSelectionState(edited, selection)).map(issue => [issue.pointId, issue.index, issue.sourceId, issue.status]),
    [['p1', 1, PAPER.id, 'missing']], 'only the place that changed is reported; the slide places still resolve');
  // A place that names the wrong slide page does not resolve either.
  const wrongPage = structuredClone(record); wrongPage.blueprint.points[1].evidence[0].page = 3;
  assert.deepEqual(blueprintEvidenceIssues(wrongPage, resolve).map(issue => [issue.pointId, issue.status]), [['p2', 'missing']]);
  assert.deepEqual(blueprintEvidenceIssues({ id: 'plain' }, resolve).map(issue => issue.status), ['not-a-blueprint']);
});

test('a library holding a blueprint stays readable, and is not damaged by a write, in release 3.0.0', async t => {
  const { root, runtime } = await library(t);
  const record = examBlueprintMaterial(input());
  await runtime.invoke('materials.v1', 'sources.ingest', { sources: [structuredClone(record)] });
  await runtime.dispose();
  // The release 3.0.0 tree sits under the repository's ignored output/ folder so that it resolves the same packages.
  const older = join(repo, 'output', 'old-3.0.0');
  await extractRelease(repo, 'v3.0.0', older);
  assert.ok(existsSync(join(older, 'lib', 'store.js')));
  const { Store: OlderStore } = await import(pathToFileURL(join(older, 'lib', 'store.js')).href);
  const { createMaterialsOperations } = await import(pathToFileURL(join(older, 'lib', 'contexts', 'materials', 'operations.js')).href);
  const { groupSourcesByDocument: olderGroups } = await import(pathToFileURL(join(older, 'lib', 'source-groups.js')).href);
  const store = new OlderStore(root);
  const state = await store.read();
  const source = state.sources.find(item => item.id === record.id);
  assert.equal(source.text, record.text, 'the older release reads it as text');
  assert.equal(olderGroups(state.sources, { documents: state.documents }).find(item => item.sourceIds.includes(record.id)).format, 'md');
  const ops = createMaterialsOperations({ root, read: async () => ({ sources: state.sources, documents: state.documents || [] }), update: async () => { throw new Error('read only'); } });
  const listed = await ops.handlers['materials.document.list']({});
  assert.ok(listed.documents.some(document => document.sourceIds.includes(record.id)), 'the older release lists it');
  assert.equal((await ops.handlers['materials.document.get']({ sourceId: record.id })).sources[0].text, record.text, 'and opens it');
  // The older release writes something else: the blueprint record, with its extra fields, comes through unchanged.
  await store.update(next => { next.sources.push({ id: 'later', title: 'later', text: 'written by 3.0.0', createdAt: '2026-10-02T00:00:00.000Z' }); });
  const after = await new Store(root).read();
  const kept = after.sources.find(item => item.id === record.id);
  assert.equal(kept.text, record.text);
  assert.deepEqual(kept.blueprint, record.blueprint);
  assert.equal(kept.provenance, 'exam-blueprint');
  assert.ok(after.sources.some(item => item.id === 'later'));
});

test('the shape of the sample paper is kept beside the points: question labels, types, marks and the points each reaches; it needs a paper and real points', () => {
  const shaped = patch => { const value = input(); value.examShape = { questions: [{ label: 'Q1', type: '简答', marks: 10, pointIds: ['p1'] }, { label: 'Q2', marks: 5, pointIds: [] }], unmatched: ['Q2'] }; patch?.(value); return value; };
  const { blueprint, text } = examBlueprintMaterial(shaped());
  assert.deepEqual(blueprint.examShape, { questions: [{ label: 'Q1', type: '简答', marks: 10, pointIds: ['p1'] }, { label: 'Q2', marks: 5, pointIds: [] }], unmatched: ['Q2'] });
  for (const word of ['样卷形态', 'Q1 简答 10 分 → p1', 'Q2 5 分 → 讲义里找不到对应考点']) assert.ok(text.includes(word), word);
  assert.equal(examBlueprintMaterial(input()).blueprint.examShape, undefined, 'no shape unless the build read a sample paper');
  assert.throws(() => examBlueprintMaterial(shaped(v => { v.examShape.questions[0].pointIds = ['p9']; })), /not in the list/);
  assert.throws(() => examBlueprintMaterial(shaped(v => { v.inputs.pop(); v.points[0].evidence.pop(); })), /needs a sample paper/);
  assert.throws(() => examBlueprintMaterial(shaped(v => { v.examShape.questions[1].marks = -1; })), /marks/);
  assert.throws(() => examBlueprintMaterial(shaped(v => { v.examShape.questions.push({ label: 'Q1', pointIds: [] }); })), /repeated/);
});
