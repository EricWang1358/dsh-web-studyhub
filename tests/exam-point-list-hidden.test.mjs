/* Plan revision 5: a 考点清单 is a source record but NOT course material. Every list of the library's materials leaves it out (the 资料 list's grouping, the snapshot's sources, source.list /
   search / coverage, document.list, the counts, the pickers' feeds, the retrieval index), requests that name it as material are refused, and the 备考补习 page reads it from
   `snapshot.examPointLists` and `source.get`. It stays readable (citations, document.get). Fakes only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StudyService } from '../lib/service.js';
import { privateRoot } from './helpers/model-family-baseline.mjs';
import { groupSourcesByDocument, countDocuments } from '../lib/source-groups.js';
import { examBlueprintMaterial } from '../lib/exam-blueprint-material.js';
import { isExamPointListSource, notExamPointList, examPointListSummary, inputFingerprint } from '../lib/exam-point-list.js';
import { libraryCourses, knownCourseNames, materialsView } from '../lib/source-courses.js';
import { courseList } from '../lib/courses.js';

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
  assert.deepEqual(Object.keys(summary), ['id', 'title', 'courses', 'createdAt', 'archived', 'scope', 'basis', 'supersedes', 'points', 'chars', 'stale']);
  assert.ok(!('text' in summary) && !('blueprint' in summary));
  assert.equal(summary.supersedes, null);
  assert.equal(examPointListSummary({ ...LIST, blueprint: { ...LIST.blueprint, supersedes: 'older' } }).supersedes, 'older');
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
  assert.deepEqual(snapshot.examPointLists.map(item => [item.id, item.title, item.courses, item.points, item.basis.label]), [[LIST.id, '网络 考点清单', ['网络'], 1, '没有样卷，无法标出样卷考过的点']]);
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

/* Review fixes (M-1..M-3). */
const TEXT1 = '传输层讲义：三次握手建立连接，之后传输数据。', TEXT2 = '网络层讲义：路由与转发。';
/** A copy of LIST saved with `texts` as the fingerprint of its first input (`undefined`: a list saved before fingerprints existed). */
const listWith = (id, texts, sourceIds) => {
  const list = { ...structuredClone(LIST), id, createdAt: stamp };
  if (sourceIds) list.blueprint.inputs[0].sourceIds = sourceIds;
  if (texts) list.blueprint.inputs[0].fingerprint = inputFingerprint(texts);
  return list;
};
async function libraryOf(t, records) {
  const root = await privateRoot(t, 'exam-point-list-review-');
  const service = new StudyService(root, { complete: async () => '{}' });
  t.after(() => service.dispose());
  await service.runtime.invoke('materials.v1', 'sources.ingest', { sources: records });
  return service;
}

test('M-1 a list is stale when what it was built from changed or is gone; an old list without fingerprints never is', async t => {
  const service = await libraryOf(t, [material('m1', TEXT1), material('m2', TEXT2),
    listWith('fresh', [TEXT1, TEXT2]), listWith('changed', ['更早的传输层讲义', TEXT2]), listWith('old', null), listWith('gone', ['x', 'y'], ['m1', 'm9'])]);
  const stale = Object.fromEntries((await service.call('snapshot')).examPointLists.map(item => [item.id, item.stale]));
  assert.deepEqual(stale, { fresh: false, changed: true, old: false, gone: true });
  assert.equal(examPointListSummary(listWith('plain', null)).stale, false, 'a summary made without the library never claims stale');
});

test('M-1 removing a material a list cites is allowed and names the lists', async t => {
  const cites = (id, { input, evidence }) => { const list = listWith(id, null, [input]); list.blueprint.points[0].evidence[0].sourceId = evidence; return { ...list, title: `清单 ${id}` }; };
  const service = await libraryOf(t, ['m1', 'm2', 'm3', 'm4'].map(id => ({ ...material(id, `讲义 ${id}`), archived: true })).concat([
    cites('by-input', { input: 'm2', evidence: 'm1' }), cites('by-evidence', { input: 'm1', evidence: 'm3' })]));
  const byInput = await service.call('source.remove', { id: 'm2', confirm: true });
  assert.deepEqual(byInput.citedByLists, [{ id: 'by-input', title: '清单 by-input' }], 'an input counts as a citation');
  const byEvidence = await service.call('source.remove', { id: 'm3', confirm: true });
  assert.deepEqual(byEvidence.citedByLists, [{ id: 'by-evidence', title: '清单 by-evidence' }], 'an evidence place counts as a citation too');
  const free = await service.call('source.remove', { id: 'm4', confirm: true });
  assert.equal(free.ok, true);
  assert.ok(!('citedByLists' in free), 'nothing cites it, nothing is said');
  assert.deepEqual((await service.call('source.get', { id: 'm2' }).catch(() => null)), null, 'and the removal really happened');
});

test('M-2 a list never adds a course name or changes the course views', async t => {
  const list = (id, courses) => ({ ...listWith(id, null), courses });
  // One course name in the library, stated by the material and by lists (one of them with no course at all).
  const withList = await libraryOf(t, [material('m1', TEXT1), list('l1', ['网络']), list('l3', [])]);
  const without = await libraryOf(t, [material('m1', TEXT1)]);
  assert.deepEqual((await withList.call('library.context', {})).courses, (await without.call('library.context', {})).courses);
  assert.deepEqual(await withList.call('source.coverage', {}), await without.call('source.coverage', {}));
  const rows = async service => (await service.call('snapshot')).courses.map(({ id, name, sources, sourcesTotal, decks }) => ({ id, name, sources, sourcesTotal, decks }));
  assert.deepEqual(await rows(withList), await rows(without));
  const [a, b] = [await withList.call('export'), await without.call('export')];
  assert.ok(a.sources.some(isExamPointListSource), 'the lists are in the library');
  assert.deepEqual(libraryCourses(a), libraryCourses(b));
  assert.deepEqual(knownCourseNames(a), knownCourseNames(b));
  assert.deepEqual(libraryCourses(a), ['网络'], 'no empty name for a list without courses');
  // A name only a list states is not a course of the library, and does not enter the course rows of the materials view.
  const state = { sources: [material('m1', TEXT1), list('l2', ['只在清单里']), list('l3', [])], decks: [], drafts: [], courses: [] };
  assert.deepEqual(libraryCourses(state), ['网络']);
  assert.deepEqual(knownCourseNames(state), ['网络']);
  assert.deepEqual(courseList(materialsView(state), libraryCourses(state)).map(course => course.name), ['网络']);
});

test('M-3 a list id given to organize or enrich is refused, and no list text reaches a model', async t => {
  const seen = [];
  const root = await privateRoot(t, 'exam-point-list-organize-');
  const service = new StudyService(root, { complete: async (system, user) => { seen.push(user); return '{"proposals":[]}'; } });
  t.after(() => service.dispose());
  await service.runtime.invoke('materials.v1', 'sources.ingest', { sources: [material('m1', TEXT1), { ...structuredClone(LIST), createdAt: stamp }] });
  const refused = error => { assert.equal(error.code, 'exam-point-list-not-material', error.message); return true; };
  await assert.rejects(service.call('source.organize.suggest', { sourceIds: ['m1', LIST.id] }), refused);
  await assert.rejects(service.call('materials.enrich', { sourceIds: [LIST.id] }), refused);
  assert.ok(!seen.some(user => String(user).includes('三次握手考点')), 'no model call carried the list');
  const enriched = await service.call('materials.enrich', {});
  assert.ok(!enriched.changes.some(change => change.id === LIST.id) && !enriched.unresolved.some(item => item.id === LIST.id), 'enriching everything leaves lists alone');
});
