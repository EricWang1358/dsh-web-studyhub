/* 3.1.0 step 1: an exam blueprint is a special kind of material. It is an ordinary source record (readable text + extra fields), so it goes in through the
   existing `sources.ingest` of the materials context, opens in the 资料 list and reader like any text material, keeps where each exam point came from as
   resolvable selections, and a library that holds one stays readable by release 3.0.0. Fakes only: no model, no network. */
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
const PAPER = { id: 'paper-2023', title: '2023 期末试卷', text: '第一题 简述 TCP 三次握手的作用。\n第二题 比较 UDP 与 TCP 的可靠性差异。' };
const SYLLABUS = { id: 'syllabus-2024', title: '2024 考试大纲', text: '掌握传输层协议：TCP 连接管理、可靠传输、拥塞控制。' };
const SOURCES = [PAPER, SYLLABUS].map(source => ({ ...source, createdAt: '2026-10-01T00:00:00.000Z', courses: ['网络'] }));
const input = () => ({ title: '网络 · 传输层 考点清单', courses: ['网络'], scope: { label: '传输层' },
  inputs: [{ role: 'past-paper', sourceId: PAPER.id, title: PAPER.title }, { role: 'syllabus', sourceId: SYLLABUS.id, title: SYLLABUS.title }],
  points: [
    { id: 'p1', title: 'TCP 连接管理', requirement: '掌握', evidence: [{ sourceId: SYLLABUS.id, quote: 'TCP 连接管理' }, { sourceId: PAPER.id, quote: '简述 TCP 三次握手的作用' }] },
    { id: 'p2', title: 'TCP 与 UDP 的可靠性', status: 'confirmed', evidence: [{ sourceId: PAPER.id, quote: '比较 UDP 与 TCP 的可靠性差异' }] },
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
  for (const word of ['传输层', 'TCP 连接管理', '[p2]', '已确认', '2024 考试大纲', '依据：“简述 TCP 三次握手的作用”']) assert.ok(a.text.includes(word), word);
  assert.ok(isExamBlueprintSource(a));
  assert.ok(!isExamBlueprintSource({ id: 'x', text: 'plain' }) && !isExamBlueprintSource({ provenance: 'exam-blueprint' }));
  const changed = input(); changed.points[1].title = 'TCP 与 UDP 的差别';
  assert.notEqual(examBlueprintMaterial(changed).id, a.id, 'a changed blueprint is a new material; the old one stays');
});

test('a blueprint that cannot be traced is refused before anything is stored', () => {
  const bad = patch => { const value = input(); patch(value); return () => examBlueprintMaterial(value); };
  assert.throws(bad(v => { v.points = []; }), /at least one exam point/);
  assert.throws(bad(v => { v.points[1].id = 'p1'; }), /repeated/);
  assert.throws(bad(v => { v.points[0].evidence = []; }), /at least one place/);
  assert.throws(bad(v => { v.points[0].evidence[0].quote = '   '; }), /quote is required/);
  assert.throws(bad(v => { v.points[0].evidence[0].sourceId = 'other'; }), /not an input/);
  assert.throws(bad(v => { v.points[0].status = 'sure'; }), /unknown status/);
  assert.throws(bad(v => { v.points[0].parentId = 'nope'; }), /parent/);
  assert.throws(bad(v => { v.inputs[0].role = 'rumour'; }), /Unknown input role/);
  assert.throws(bad(v => { v.inputs.push({ role: 'past-paper', sourceId: PAPER.id }); }), /twice/);
  assert.throws(bad(v => { v.points[0].evidence[0].start = 3; }), /together/);
  assert.throws(bad(v => { v.points = Array.from({ length: BLUEPRINT_LIMITS.points + 1 }, (_, i) => ({ id: `q${i}`, title: 't', evidence: [{ sourceId: PAPER.id, quote: 'q' }] })); }), /at most 300/);
  assert.throws(() => examBlueprintMaterial({ ...input(), title: '' }), /title is required/);
  assert.deepEqual(normalizeExamBlueprint({ points: [{ title: 'a', evidence: [{ sourceId: 'any', quote: 'q' }] }] }).points[0].id, 'p1', 'a blueprint with no named inputs may cite any material');
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
  assert.equal(items.length, 3);
  // The documents list and the reader open it as extracted text.
  const listed = await runtime.call('materials.document.list', {});
  assert.ok(listed.documents.some(document => document.sourceIds.includes(record.id)));
  const opened = await runtime.call('materials.document.get', { sourceId: record.id });
  assert.equal(opened.sources[0].text, record.text);
  assert.equal(opened.originalAvailable, false);
  // A different text under the same id is the identity conflict the pipeline already refuses.
  await assert.rejects(runtime.invoke('materials.v1', 'sources.ingest', { sources: [{ ...structuredClone(record), text: `${record.text}x` }] }), /identity conflict/);
});

test('every place an exam point came from is checked by the one resolver that checks citations', async t => {
  const { runtime } = await library(t);
  const record = examBlueprintMaterial(input());
  await runtime.invoke('materials.v1', 'sources.ingest', { sources: [structuredClone(record)] });
  const state = await runtime.invoke('materials.v1', 'state.read', {});
  const resolve = selection => resolveSelectionState(state, selection);
  assert.deepEqual(blueprintEvidenceIssues(record, resolve), []);
  // The material the point came from changes its wording (a new import with another text): the place no longer resolves and the point says which.
  const edited = structuredClone(state); edited.sources.find(source => source.id === PAPER.id).text = '第一题 简述 TCP 的作用。';
  assert.deepEqual(blueprintEvidenceIssues(record, selection => resolveSelectionState(edited, selection)).map(issue => [issue.pointId, issue.sourceId, issue.status]),
    [['p1', PAPER.id, 'missing'], ['p2', PAPER.id, 'missing']]);
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
  assert.equal(after.sources.find(item => item.id === record.id).text, record.text);
  assert.deepEqual(after.sources.find(item => item.id === record.id).blueprint, record.blueprint);
  assert.equal(after.sources.find(item => item.id === record.id).provenance, 'exam-blueprint');
  assert.ok(after.sources.some(item => item.id === 'later'));
});
