/* Plan revision 5: a 考点清单 is a source record but NOT course material. Every list of the library's materials leaves it out (the 资料 list's grouping, the snapshot's sources, source.list /
   search / coverage, document.list, the counts, the pickers' feeds, the retrieval index), requests that name it as material are refused, and the 备考补习 page reads it from
   `snapshot.examPointLists` and `source.get`. It stays readable (citations, document.get). Fakes only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StudyService } from '../lib/service.js';
import { privateRoot } from './helpers/model-family-baseline.mjs';
import { groupSourcesByDocument, countDocuments } from '../lib/source-groups.js';
import { examBlueprintMaterial } from '../lib/exam-blueprint-material.js';
import { isExamPointListSource, notExamPointList, examPointListSummary } from '../lib/exam-point-list.js';

const stamp = '2026-10-01T00:00:00.000Z';
const material = (id, text) => ({ id, title: `资料 ${id}`, text, createdAt: stamp, courses: ['网络'] });
const LIST = examBlueprintMaterial({ title: '网络 考点清单', courses: ['网络'], inputs: [{ role: 'lecture', sourceIds: ['m1', 'm2'], title: '传输层' }],
  points: [{ id: 'p1', title: '三次握手考点', evidence: [{ sourceId: 'm1', quote: '三次握手' }] }] });

async function library(t) {
  const root = await privateRoot(t, 'exam-point-list-hidden-');
  const service = new StudyService(root, { complete: async () => '{}' });
  t.after(() => service.dispose());
  await service.runtime.invoke('materials.v1', 'sources.ingest', { sources: [material('m1', '传输层讲义：三次握手建立连接，之后传输数据。'), material('m2', '网络层讲义：路由与转发。'), { ...structuredClone(LIST), createdAt: stamp }] });
  return service;
}

test('the predicate is browser-safe, exact, and the summary is small', () => {
  assert.ok(isExamPointListSource(LIST) && !notExamPointList(LIST));
  assert.ok(!isExamPointListSource(material('x', 't')) && !isExamPointListSource({ ...LIST, blueprint: undefined }) && !isExamPointListSource({ ...LIST, provenance: 'other' }) && !isExamPointListSource(null));
  const summary = examPointListSummary({ ...LIST, createdAt: stamp });
  assert.deepEqual(Object.keys(summary), ['id', 'title', 'courses', 'createdAt', 'archived', 'scope', 'basis', 'points', 'chars']);
  assert.ok(!('text' in summary) && !('blueprint' in summary));
});

test('the 资料 list\'s grouping and the material count leave it out', async t => {
  const service = await library(t);
  const { sources, documents } = await service.runtime.invoke('materials.v1', 'state.read', {});
  assert.ok(sources.some(isExamPointListSource), 'it is in the library');
  const items = groupSourcesByDocument(sources, { documents });
  assert.deepEqual(items.map(item => item.sourceIds).flat().sort(), ['m1', 'm2']);
  assert.equal(countDocuments(sources), 2);
});

test('the snapshot lists materials without it and carries its summary for the 备考补习 page', async t => {
  const service = await library(t);
  const snapshot = await service.call('snapshot');
  assert.deepEqual(snapshot.sources.map(source => source.id).sort(), ['m1', 'm2']);
  assert.deepEqual(snapshot.examPointLists.map(item => [item.id, item.title, item.courses, item.points, item.basis.label]), [[LIST.id, '网络 考点清单', ['网络'], 1, '没有样卷，无法判断哪些是必学']]);
  assert.ok(snapshot.examPointLists.every(item => !('text' in item) && !('blueprint' in item)));
});

test('the tools that list, search and cover materials leave it out, but source.get still reads it whole', async t => {
  const service = await library(t);
  assert.deepEqual((await service.call('source.list', {})).sources.map(source => source.id).sort(), ['m1', 'm2']);
  const found = await service.call('source.search', { query: '三次握手' });
  assert.ok(JSON.stringify(found).includes('m1') && !JSON.stringify(found).includes(LIST.id), 'the search finds the lecture, not the list that quotes it');
  assert.ok(!JSON.stringify(await service.call('source.coverage', {})).includes(LIST.id));
  const got = await service.call('source.get', { id: LIST.id });
  assert.ok(got.text.includes('三次握手考点') && got.blueprint.points.length === 1);
  assert.equal((await service.call('library.context', {})).counts.sources, 2);
});

test('document.list leaves it out; document.get still opens it', async t => {
  const service = await library(t);
  const listed = await service.call('materials.document.list', {});
  assert.deepEqual(listed.documents.flatMap(document => document.sourceIds).sort(), ['m1', 'm2']);
  assert.equal(listed.total, 2);
  const opened = await service.call('materials.document.get', { sourceId: LIST.id });
  assert.equal(opened.sources[0].text, LIST.text);
});

test('course counts do not count it as a material', async t => {
  const service = await library(t);
  const course = (await service.call('course.list')).courses.find(item => item.name === '网络');
  assert.deepEqual([course.sources, course.sourcesTotal], [2, 2]);
});

test('the retrieval index does not see it as a page to index', async t => {
  const service = await library(t);
  const coverage = await service.call('retrieval.index.coverage', {});
  assert.deepEqual([...coverage.missing].sort(), ['m1', 'm2']);
});

test('a request that names it as material is refused in words: questions from it, reference questions, course guidance', async t => {
  const service = await library(t);
  const words = error => { assert.equal(error.code, 'exam-point-list-not-material', error.message); assert.ok(error.message.includes('考点清单')); return true; };
  await assert.rejects(service.call('generate', { sourceIds: [LIST.id], kind: 'quiz', count: 3 }), words);
  await assert.rejects(service.call('generate', { sourceIds: ['m1'], referenceSourceIds: [LIST.id], kind: 'quiz', count: 3 }), words);
  await assert.rejects(service.call('course.save', { name: '网络', guidanceSourceIds: [LIST.id] }), error => { assert.ok(error.message.includes('考点清单')); return true; });
  const priced = await service.call('usage.estimate', { feature: 'generate', sourceIds: [LIST.id], kind: 'quiz', count: 3 }).catch(() => null);
  assert.ok(!priced || priced.totalTokens.high === 0, 'and it is not priced as one either');
});
