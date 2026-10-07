/* 3.1.0 step 1 (revised 2026-10-08): an exam point list (code name: exam blueprint; the learner calls it 考点清单) is a special kind of material. It is an ordinary source record (readable text +
   extra fields), so it goes in through the existing `sources.ingest` of the materials context, keeps where each exam point came from as resolvable selections, and a library that holds one
   stays readable by release 3.0.0 (which simply shows it as a Markdown material). Points have two levels (大考点 -> 小考点) and a tier derived from the evidence: 必学 when at least one chosen
   sample paper reached it, 补充 when only the slides did. Fakes only: no model, no network. */
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
import { sourceFormat } from '../lib/source-groups.js';
import { extractRelease } from './fixtures/extract-release.mjs';
import { BLUEPRINT_LIMITS, blueprintEvidenceIssues, examBlueprintMaterial, isExamBlueprintSource, isExamPointListSource, normalizeExamBlueprint } from '../lib/exam-blueprint-material.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// A lecture deck is one source per slide (slide 5 is a picture only and was skipped at import), plus sample papers.
const PAPER = { id: 'paper-2023', title: '2023 样卷', text: '第一题 简述 TCP 三次握手的作用。\n第二题 比较 UDP 与 TCP 的可靠性差异。\n第三题 说明拥塞控制。' };
const PAPER_B = { id: 'paper-2022', title: '2022 样卷', text: '一、解释滑动窗口。\n二、写出三次握手的报文。' };
const SLIDE_3 = { id: 'deck-3', title: '传输层.pptx · 第 3 页', text: '## 第 3 页 · TCP 连接管理\n\n三次握手：SYN、SYN-ACK、ACK', document: { id: 'deck', page: 3, format: 'pptx' } };
const SLIDE_4 = { id: 'deck-4', title: '传输层.pptx · 第 4 页', text: '## 第 4 页 · 可靠传输\n\n滑动窗口与累积确认', document: { id: 'deck', page: 4, format: 'pptx' } };
const SOURCES = [PAPER, PAPER_B, SLIDE_3, SLIDE_4].map(source => ({ ...source, createdAt: '2026-10-01T00:00:00.000Z', courses: ['网络'] }));
// p1 is a 大考点 with no place of its own; p2 is reached by the paper and the slides, p3 by the slides only, p4 by the paper only (the slides never mention it).
const input = () => ({ title: '网络 · 传输层 考点清单', courses: ['网络'], scope: { label: '传输层' },
  recommendedReading: { title: 'Computer Networking: A Top-Down Approach', author: 'Kurose & Ross' },
  inputs: [{ role: 'lecture', documentId: 'deck', sourceIds: [SLIDE_3.id, SLIDE_4.id], title: '传输层.pptx', skippedPages: [5] },
    { role: 'past-paper', sourceId: PAPER.id, title: PAPER.title }],
  points: [
    { id: 'p1', title: '传输层协议' },
    { id: 'p2', parentId: 'p1', title: 'TCP 连接管理', requirement: '掌握', evidence: [{ sourceId: SLIDE_3.id, page: 3, quote: '三次握手：SYN、SYN-ACK、ACK' }, { sourceId: PAPER.id, quote: '简述 TCP 三次握手的作用' }] },
    { id: 'p3', parentId: 'p1', title: '可靠传输', status: 'confirmed', evidence: [{ sourceId: SLIDE_4.id, page: 4, quote: '滑动窗口与累积确认' }] },
    { id: 'p4', parentId: 'p1', title: '拥塞控制', evidence: [{ sourceId: PAPER.id, quote: '说明拥塞控制' }] },
  ] });

async function library(t) {
  const root = await mkdtemp(join(tmpdir(), 'exam-blueprint-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const runtime = createStudyRuntime(root, { contexts: ['materials'] });
  t.after(() => runtime.dispose());
  await runtime.invoke('materials.v1', 'sources.ingest', { sources: structuredClone(SOURCES) });
  return { root, runtime };
}

test('the record is deterministic, readable text that exports the two-level outline with the tier words', () => {
  const a = examBlueprintMaterial(input()), b = examBlueprintMaterial(input());
  assert.equal(a.id, b.id, 'the same list is one material');
  assert.match(a.id, /^exam-blueprint-[0-9a-f]{40}$/);
  assert.deepEqual([a.provenance, a.format, a.courses, a.blueprint.version], ['exam-blueprint', 'md', ['网络'], 1]);
  assert.deepEqual(a.blueprint.points.map(point => [point.id, point.parentId ?? null, point.tier]), [['p1', null, 'must'], ['p2', 'p1', 'must'], ['p3', 'p1', 'extra'], ['p4', 'p1', 'must']]);
  assert.deepEqual(a.blueprint.points.map(point => point.noSlidePlace), [false, false, false, true], 'the flag is derived from the same evidence: only the point the slides never mention');
  assert.equal(examBlueprintMaterial({ ...input(), supersedes: 'older-list' }).blueprint.supersedes, 'older-list', 'a rebuild records the list it replaces');
  const lines = a.text.split('\n');
  const at = word => lines.findIndex(line => line.includes(word));
  assert.ok(at('1. [p1] 传输层协议（必学') >= 0 && at('1.1 [p2] TCP 连接管理（必学') > at('1. [p1]') && at('1.2 [p3] 可靠传输（补充') > at('1.1 [p2]') && at('1.3 [p4] 拥塞控制（必学') > at('1.2 [p3]'), 'a 大/小 outline, children under their 大考点');
  for (const word of ['依据（讲义 第 3 页）：“三次握手：SYN、SYN-ACK、ACK”', '传输层.pptx', '范围：传输层', '课件里没找到对应内容']) assert.ok(a.text.includes(word), word);
  assert.equal(lines.filter(line => line.includes('课件里没找到对应内容')).length, 1, 'only the point the slides never mention is flagged');
  assert.ok(!/蓝图|blueprint/i.test(a.text), 'the words of the learner never say blueprint');
  assert.ok(isExamBlueprintSource(a) && isExamPointListSource(a));
  assert.ok(!isExamPointListSource({ id: 'x', text: 'plain' }) && !isExamPointListSource({ provenance: 'exam-blueprint' }) && !isExamPointListSource(null));
  const changed = input(); changed.points[2].title = '可靠数据传输';
  assert.notEqual(examBlueprintMaterial(changed).id, a.id, 'a changed list is a new material; the old stays');
});

test('the tier comes from the evidence: 必学 when a sample paper reached the point, 补充 when only the slides did; no paper means every point is 补充 and the list says so', () => {
  const { blueprint, text } = examBlueprintMaterial(input());
  const byId = Object.fromEntries(blueprint.points.map(point => [point.id, point]));
  assert.deepEqual([byId.p2.backing, byId.p3.backing, byId.p4.backing],
    [{ slides: 1, samplePapers: 1, papers: [PAPER.id], kind: 'both' }, { slides: 1, samplePapers: 0, papers: [], kind: 'slides' }, { slides: 0, samplePapers: 1, papers: [PAPER.id], kind: 'sample-paper' }]);
  assert.deepEqual(byId.p1.backing, { slides: 2, samplePapers: 1, papers: [PAPER.id], kind: 'both' }, 'a 大考点 is backed by what its children are');
  assert.equal(byId.p1.tier, 'must', 'a 大考点 is 必学 when any 小考点 is');
  assert.deepEqual(blueprint.basis, { samplePapers: 1, frequency: 'not-computed', skippedSlides: 1, must: 2, extra: 1, noCourseText: 1, label: '依据 1 份样卷；必学范围可能不全' });
  assert.ok(text.includes('依据 1 份样卷；必学范围可能不全'));
  // no sample paper at all
  const none = input();
  none.inputs.pop(); none.points = none.points.filter(point => point.id !== 'p4'); none.points[1].evidence.pop();
  const bare = normalizeExamBlueprint(none);
  assert.deepEqual(bare.points.map(point => point.tier), ['extra', 'extra', 'extra']);
  assert.deepEqual(bare.basis, { samplePapers: 0, frequency: 'not-computed', skippedSlides: 1, must: 0, extra: 2, noCourseText: 0, label: '没有样卷，无法判断哪些是必学' });
  assert.ok(examBlueprintMaterial(none).text.includes('没有样卷，无法判断哪些是必学'));
  assert.ok(!examBlueprintMaterial(none).text.includes('必学）'), 'no point is called 必学 without a paper');
  // the recommended textbook stays a note
  assert.deepEqual(blueprint.recommendedReading, { title: 'Computer Networking: A Top-Down Approach', author: 'Kurose & Ross' });
  assert.equal(blueprint.inputs.some(item => item.role === 'textbook'), false);
});

test('several sample papers: a point reached by two papers records both, one reached by one paper records that one, and the label says 取并集', () => {
  const two = input();
  two.inputs.push({ role: 'past-paper', sourceId: PAPER_B.id, title: PAPER_B.title });
  two.points[1].evidence.push({ sourceId: PAPER_B.id, quote: '写出三次握手的报文' });
  two.points[2].evidence.push({ sourceId: PAPER_B.id, quote: '解释滑动窗口' });
  const { blueprint } = examBlueprintMaterial(two);
  const byId = Object.fromEntries(blueprint.points.map(point => [point.id, point]));
  assert.deepEqual([byId.p2.backing.samplePapers, byId.p2.backing.papers], [2, [PAPER.id, PAPER_B.id]]);
  assert.deepEqual([byId.p3.backing.samplePapers, byId.p3.backing.papers, byId.p3.tier], [1, [PAPER_B.id], 'must'], 'a paper reaching a point makes it 必学');
  assert.deepEqual([byId.p4.backing.papers], [[PAPER.id]]);
  assert.deepEqual(blueprint.basis, { samplePapers: 2, frequency: 'not-computed', skippedSlides: 1, must: 3, extra: 0, noCourseText: 1, label: '依据 2 份样卷（取并集）；必学范围可能不全' });
  const three = structuredClone(two);
  three.inputs.push({ role: 'past-paper', sourceId: 'paper-c' });
  three.points[3].evidence.push({ sourceId: 'paper-c', quote: '拥塞' });
  assert.deepEqual([normalizeExamBlueprint(three).basis.frequency, normalizeExamBlueprint(three).basis.label], ['allowed', '依据 3 份样卷（取并集）；样本由学生选定，不是随机样本']);
});

test('a list that cannot be traced is refused before anything is stored; the words are the learner\'s, never blueprint', () => {
  const bad = patch => { const value = input(); patch(value); return () => examBlueprintMaterial(value); };
  assert.throws(bad(v => { v.points = []; }), /at least one exam point/);
  assert.throws(bad(v => { v.points[2].id = 'p2'; }), /repeated/);
  assert.throws(bad(v => { v.points[1].evidence = []; }), /needs at least one place/, 'a 小考点 with no place at all');
  assert.throws(bad(v => { v.points[1].evidence[0].quote = '   '; }), /quote is required/);
  assert.throws(bad(v => { v.points[1].evidence[0].sourceId = 'other'; }), /not an input/);
  assert.throws(bad(v => { v.points[1].evidence[0].role = 'textbook'; }), /not an input/, 'a textbook that was never imported cannot be cited');
  assert.throws(bad(v => { v.points[1].evidence = [{ sourceId: PAPER.id, role: 'answer-key', quote: '简述' }]; }), /not an input/);
  assert.throws(bad(v => { v.points[1].status = 'sure'; }), /unknown status/);
  assert.throws(bad(v => { v.points[1].parentId = 'nope'; }), /parent/);
  assert.throws(bad(v => { v.points[0].parentId = 'p2'; }), /at most two levels/, 'a 大考点 cannot have a parent: p1 under p2 under p1');
  assert.throws(bad(v => { v.points.push({ id: 'p5', parentId: 'p2', title: '更深', evidence: [{ sourceId: SLIDE_3.id, quote: '三次握手' }] }); }), /at most two levels/, 'p5 under p2 under p1 is three levels');
  assert.throws(bad(v => { v.inputs[0].role = 'rumour'; }), /Unknown input role/);
  assert.throws(bad(v => { v.inputs.push({ role: 'past-paper', sourceId: PAPER.id }); }), /twice/);
  assert.throws(bad(v => { v.inputs.push({ role: 'lecture' }); }), /documentId or sourceIds/);
  assert.throws(bad(v => { v.points[1].evidence[0].start = 3; }), /together/);
  assert.throws(bad(v => { v.recommendedReading = { title: '某教材', url: 'ftp://example.invalid/x' }; }), /http or https/);
  assert.throws(bad(v => { v.recommendedReading = { author: 'nobody' }; }), /title is required/);
  assert.throws(bad(v => { v.points = Array.from({ length: BLUEPRINT_LIMITS.points + 1 }, (_, i) => ({ id: `q${i}`, title: 't', evidence: [{ sourceId: SLIDE_3.id, quote: 'q' }] })); }), /at most 300/);
  assert.throws(() => examBlueprintMaterial({ ...input(), title: '' }), /title is required/i);
  const messages = [];
  for (const patch of [v => { v.points = []; }, v => { v.inputs = []; }, v => { v.points[1].evidence = []; }, v => { v.points[0].parentId = 'p2'; }, v => { v.recommendedReading = { author: 'x' }; }]) {
    try { const value = input(); patch(value); examBlueprintMaterial(value); } catch (error) { messages.push(error.message); }
  }
  assert.equal(messages.length, 5);
  assert.ok(messages.every(message => !/blueprint|蓝图/i.test(message)), messages.join(' | '));
});

test('the minimal valid input is lecture slides (or a syllabus); a paper alone is refused, but a point the paper reached and the slides never mention is kept and flagged', () => {
  const only = roles => ({ ...input(), inputs: input().inputs.filter(item => roles.includes(item.role)), points: [{ id: 'p1', title: 't', evidence: [{ sourceId: PAPER.id, quote: '第一题' }] }] });
  for (const roles of [[], ['past-paper']]) assert.throws(() => examBlueprintMaterial(only(roles)), /needs lecture slides or a syllabus/);
  assert.throws(() => examBlueprintMaterial({ ...input(), inputs: [...input().inputs.filter(item => item.role !== 'lecture'), { role: 'textbook', sourceId: 'book-1' }] }), /needs lecture slides or a syllabus/, 'a textbook is never the source of the points');
  const kept = normalizeExamBlueprint(only(['lecture', 'past-paper']));
  assert.deepEqual([kept.points[0].tier, kept.points[0].backing.slides, kept.basis.noCourseText], ['must', 0, 1]);
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
  assert.equal(sourceFormat(stored), 'md');
  // The record itself is a readable source: the reader opens it and a citation can point into it, whatever the lists decide to show.
  const opened = await runtime.call('materials.document.get', { sourceId: record.id });
  assert.equal(opened.sources[0].text, record.text);
  assert.equal(opened.originalAvailable, false);
  await assert.rejects(runtime.invoke('materials.v1', 'sources.ingest', { sources: [{ ...structuredClone(record), text: `${record.text}x` }] }), /identity conflict/);
});

test('every place an exam point came from is checked by the one resolver that checks citations, slide page included', async t => {
  const { runtime } = await library(t);
  const record = examBlueprintMaterial(input());
  await runtime.invoke('materials.v1', 'sources.ingest', { sources: [structuredClone(record)] });
  const state = await runtime.invoke('materials.v1', 'state.read', {});
  const resolve = selection => resolveSelectionState(state, selection);
  assert.deepEqual(blueprintEvidenceIssues(record, resolve), []);
  const edited = structuredClone(state); edited.sources.find(source => source.id === PAPER.id).text = '第一题 简述 TCP 的作用。';
  assert.deepEqual(blueprintEvidenceIssues(record, selection => resolveSelectionState(edited, selection)).map(issue => [issue.pointId, issue.index, issue.sourceId, issue.status]),
    [['p2', 1, PAPER.id, 'missing'], ['p4', 0, PAPER.id, 'missing']], 'only the places that changed are reported; the slide places still resolve');
  const wrongPage = structuredClone(record); wrongPage.blueprint.points[2].evidence[0].page = 3;
  assert.deepEqual(blueprintEvidenceIssues(wrongPage, resolve).map(issue => [issue.pointId, issue.status]), [['p3', 'missing']]);
  assert.deepEqual(blueprintEvidenceIssues({ id: 'plain' }, resolve).map(issue => issue.status), ['not-a-blueprint']);
});

test('a library holding an exam point list stays readable, and is not damaged by a write, in release 3.0.0 (which shows it as a normal Markdown material)', async t => {
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
  assert.equal(olderGroups(state.sources, { documents: state.documents }).find(item => item.sourceIds.includes(record.id)).format, 'md', 'and lists it as a Markdown material: it knows nothing of the hiding');
  const ops = createMaterialsOperations({ root, read: async () => ({ sources: state.sources, documents: state.documents || [] }), update: async () => { throw new Error('read only'); } });
  const listed = await ops.handlers['materials.document.list']({});
  assert.ok(listed.documents.some(document => document.sourceIds.includes(record.id)), 'the older release lists it');
  assert.equal((await ops.handlers['materials.document.get']({ sourceId: record.id })).sources[0].text, record.text, 'and opens it');
  await store.update(next => { next.sources.push({ id: 'later', title: 'later', text: 'written by 3.0.0', createdAt: '2026-10-02T00:00:00.000Z' }); });
  const after = await new Store(root).read();
  const kept = after.sources.find(item => item.id === record.id);
  assert.equal(kept.text, record.text);
  assert.deepEqual(kept.blueprint, record.blueprint);
  assert.equal(kept.provenance, 'exam-blueprint');
  assert.ok(after.sources.some(item => item.id === 'later'));
});

test('the shape of the sample papers is kept beside the points: question labels, types, marks, which paper and the points each reaches; it needs a paper and real points', () => {
  const shaped = patch => {
    const value = input();
    value.inputs.push({ role: 'past-paper', sourceId: PAPER_B.id, title: PAPER_B.title });
    value.examShape = { questions: [{ paper: PAPER.id, label: 'Q1', type: '简答', marks: 10, pointIds: ['p2'] }, { paper: PAPER_B.id, label: 'Q1', marks: 5, pointIds: [] }], unmatched: ['Q1'] };
    patch?.(value); return value;
  };
  const { blueprint, text } = examBlueprintMaterial(shaped());
  assert.deepEqual(blueprint.examShape, { questions: [{ paper: PAPER.id, label: 'Q1', type: '简答', marks: 10, pointIds: ['p2'] }, { paper: PAPER_B.id, label: 'Q1', marks: 5, pointIds: [] }], unmatched: ['Q1'] });
  for (const word of ['样卷形态', '2023 样卷 Q1 简答 10 分 → p2', '2022 样卷 Q1 5 分 → 没有对应考点']) assert.ok(text.includes(word), word);
  assert.equal(examBlueprintMaterial(input()).blueprint.examShape, undefined, 'no shape unless the build read a sample paper');
  assert.throws(() => examBlueprintMaterial(shaped(v => { v.examShape.questions[0].pointIds = ['p9']; })), /not in the list/);
  assert.throws(() => examBlueprintMaterial({ ...input(), inputs: input().inputs.filter(item => item.role !== 'past-paper'), points: [{ id: 'p1', title: 't', evidence: [{ sourceId: SLIDE_3.id, quote: '三次握手' }] }], examShape: { questions: [] } }), /needs a sample paper/);
  assert.throws(() => examBlueprintMaterial(shaped(v => { v.examShape.questions[1].marks = -1; })), /marks/);
  assert.throws(() => examBlueprintMaterial(shaped(v => { v.examShape.questions.push({ paper: PAPER.id, label: 'Q1', pointIds: [] }); })), /repeated/);
});
