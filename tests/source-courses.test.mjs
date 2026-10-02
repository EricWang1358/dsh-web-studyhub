import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StudyService } from '../lib/service.js';
import { storeDocuments } from '../lib/audio-job.js';
import { courseForSources } from '../lib/source-courses.js';
import { courseOf } from '../lib/focus.js';

async function fixture(t, complete) {
  const root = await mkdtemp(join(tmpdir(), 'study-source-courses-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return new StudyService(root, { complete });
}
const text = 'Transactions isolate concurrent changes and preserve database consistency.';

test('source-only courses are selectable; new sources inherit focus while explicit empty courses stay unassigned', async t => {
  const service = await fixture(t);
  await service.call('source.add', { id: 'a', title: 'Lecture', text, courses: ['Databases', 'Systems'] });
  assert.deepEqual((await service.call('snapshot')).focus.courses.map(x => x.name), ['Databases', 'Systems']);
  await service.call('focus.set', { course: 'Systems' });
  const inherited = await service.call('source.add', { id: 'b', title: 'Notes', text });
  assert.deepEqual(inherited.courses, ['Systems']);
  const unassigned = await service.call('source.add', { id: 'c', title: 'Inbox', text, courses: [] });
  assert.deepEqual(unassigned.courses, []);
  const filtered = await service.call('source.list', { course: 'Systems' });
  assert.deepEqual(filtered.sources.map(x => x.id), ['a', 'b']);
  assert.equal((await service.call('source.search', { query: 'Transactions', course: 'Databases' })).matchedSources, 1);
});

test('legacy citations infer courses without rewriting evidence; manual bulk changes are atomic and reversible', async t => {
  const service = await fixture(t);
  await service.store.update(s => {
    s.sources.push({ id: 'a', title: 'Lecture', text });
    s.decks.push({ id: 'd', title: 'Week 1', course: 'Databases', cards: [{ id: 'q', kind: 'flashcard', topic: 'Transactions', citations: [{ sourceId: 'a', quote: text }] }] });
    s.decks.push({ id: 'other', title: 'Shared reading', course: 'Systems', cards: [{ id: 'other-q', kind: 'flashcard', topic: 'Consistency', citations: [{ sourceId: 'a', quote: text }] }] });
  });
  const first = (await service.call('snapshot')).sources[0];
  assert.deepEqual(first.courses, ['Databases', 'Systems']);
  assert.equal(first.coursesInferred, true);
  assert.equal(first.usedBy[0].id, 'd');
  await service.call('source.courses.set', { assignments: [{ id: 'a', courses: ['Systems'], expectedCourses: ['Databases', 'Systems'] }] });
  assert.deepEqual((await service.call('source.get', { id: 'a' })).courses, ['Systems']);
  await assert.rejects(service.call('source.courses.set', { assignments: [{ id: 'a', courses: [], expectedCourses: ['Databases'] }] }), /归属已变化/);
  await assert.rejects(service.call('source.courses.set', { assignments: [{ id: 'a', courses: [] }, { id: 'missing', courses: [] }] }));
  assert.deepEqual((await service.call('source.get', { id: 'a' })).courses, ['Systems']);
  await service.call('source.courses.set', { assignments: [{ id: 'a', courses: [] }] });
  const result = (await service.call('snapshot')).sources[0];
  assert.deepEqual(result.courses, []);
  assert.equal(result.chars, text.length);
  assert.equal((await service.call('source.get', { id: 'a' })).text, text, 'course reassignment must not touch the text');
  assert.equal(result.usedBy[0].id, 'd', 'course reassignment must not break card citations');
  assert.equal(result.usedBy[1].id, 'other');
  const decks = (await service.call('export')).decks;
  assert.deepEqual(decks.map(deck => deck.course), ['Databases', 'Systems']);
  assert.ok(decks.every(deck => deck.cards[0].citations[0].sourceId === 'a' && deck.cards[0].citations[0].quote === text));
});

test('AI organization returns reviewable suggestions without mutating sources or accepting invented IDs', async t => {
  let invented = false;
  const service = await fixture(t, async () => JSON.stringify({ proposals: [{ id: invented ? 'missing' : 'a', courses: ['Databases'], reason: 'The lecture covers transactions.' }] }));
  await service.call('source.add', { id: 'a', title: 'Transactions', text, courses: [] });
  const result = await service.call('source.organize.suggest', { sourceIds: ['a'] });
  assert.deepEqual(result.proposals[0].courses, ['Databases']);
  assert.deepEqual(result.proposals[0].expectedCourses, []);
  assert.deepEqual((await service.call('source.get', { id: 'a' })).courses, []);
  await service.call('source.courses.set', { assignments: [{ id: 'a', courses: ['Manual course'] }] });
  await assert.rejects(service.call('source.courses.set', { assignments: result.proposals }), /归属已变化/);
  invented = true;
  await assert.rejects(service.call('source.organize.suggest', { sourceIds: ['a'] }), /资料/);
});

test('compact source queries keep course and usage context; export and restore preserve explicit unassigned sources', async t => {
  const service = await fixture(t);
  await service.call('source.add', { id: 'a', title: 'Lecture', text, courses: ['Databases', 'Systems'] });
  await service.call('source.add', { id: 'b', title: 'Unassigned', text, courses: [] });
  assert.deepEqual((await service.call('snapshot', { compact: true })).sources[0].courses, ['Databases', 'Systems']);
  assert.deepEqual((await service.call('source.search', { query: 'Transactions' })).results[0].courses, ['Databases', 'Systems']);
  const saved = await service.call('export');
  const other = await fixture(t);
  await other.call('restore', { state: saved });
  assert.deepEqual((await other.call('source.get', { id: 'b' })).courses, []);
  assert.deepEqual((await other.call('focus.set', { course: 'Systems' })).course, 'Systems');
});

test('source inference uses the shared course and does not choose among disjoint sources', () => {
  const state = { sources: [{ id: 'a', courses: ['A', 'Shared'] }, { id: 'b', courses: ['B', 'Shared'] }, { id: 'c', courses: ['C'] }], decks: [], drafts: [] };
  assert.equal(courseForSources(state, ['a', 'b'], 'A'), 'Shared');
  assert.equal(courseForSources(state, ['a', 'c'], 'A'), '');
  assert.equal(courseForSources(state, ['a'], 'Shared'), 'Shared');
});

test('an explicitly unassigned deck does not inherit its folder as a course', async t => {
  const service = await fixture(t);
  await service.store.update(s => {
    s.sources.push({ id: 'legacy', title: 'Evidence', text });
    s.decks.push({ id: 'deck', title: 'Questions', course: '', folder: 'Chapter folder', cards: [{ id: 'q', kind: 'flashcard', topic: 'Transactions', citations: [{ sourceId: 'legacy', quote: text }] }] });
  });
  assert.equal(courseOf({ course: '', folder: 'Chapter folder' }), '');
  assert.deepEqual((await service.call('source.get', { id: 'legacy' })).courses, []);
  assert.ok(!(await service.call('snapshot')).focus.courses.some(course => course.name === 'Chapter folder'));
  assert.equal((await service.call('snapshot')).focus.course, '');
  assert.deepEqual((await service.call('source.add', { title: 'New source', text })).courses, []);
  await service.store.update(s => { s.focus = { course: '未分类课程', mode: 'class' }; });
  assert.equal((await service.call('snapshot')).focus.course, '', 'legacy display-only focus resolves unassigned');
  await service.call('source.add', { title: 'A real named course', text, courses: ['未分类课程'] });
  await service.call('focus.set', { course: '未分类课程' });
  assert.deepEqual((await service.call('source.add', { title: 'Named inheritance', text })).courses, ['未分类课程']);
});

test('saving a reused transcript adds course relations without overwriting its text or citations', async t => {
  const service = await fixture(t);
  const request = { store: service.store, ids: ['transcript'], documents: [text], title: 'Class', meta: {}, corrections: { applied: [], skipped: [] } };
  await storeDocuments({ ...request, courses: ['A'] });
  assert.deepEqual((await service.call('source.get', { id: 'transcript' })).courses, ['A']);
  await storeDocuments({ ...request, documents: ['Replacement text must not be written'], courses: ['B'] });
  const reused = await service.call('source.get', { id: 'transcript' });
  assert.deepEqual(reused.courses, ['A', 'B']);
  assert.equal(reused.text, text);
});

test('a converted book with hundreds of pages changes course in one call (the old cap of 200 broke "改课程" on any big book)', async () => {
  const { assignSourceCourses } = await import('../lib/source-courses.js');
  const pages = 650;
  const state = { decks: [], drafts: [], sources: Array.from({ length: pages }, (_, index) => ({ id: `p${index}`, title: `Book · page ${index + 1}`, text, courses: ['Old'] })) };
  const result = assignSourceCourses(state, state.sources.map(source => ({ id: source.id, courses: ['Cloud Native Solution Design / 07 微服务设计'] })));
  assert.equal(result.updated, pages);
  assert.ok(state.sources.every(source => source.courses[0] === 'Cloud Native Solution Design / 07 微服务设计'));
  assert.throws(() => assignSourceCourses(state, []), /请选择/);
  assert.throws(() => assignSourceCourses(state, Array.from({ length: 5001 }, (_, index) => ({ id: `x${index}`, courses: [] }))), /请选择/, 'a sanity ceiling remains');
});
