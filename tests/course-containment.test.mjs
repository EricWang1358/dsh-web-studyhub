import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { sourceMatchesCourse } from '../lib/source-courses.js';
import { learningScope } from '../lib/learning-scope.js';
import { courseTopics } from '../lib/audio-job.js';
import { weakTopicsFor } from '../lib/contexts/generation/suggest.js';
import { courseBatch } from '../lib/course-route.js';

/* Courses may contain courses: choosing a parent reads the parent and every descendant, choosing a chapter only
   that chapter, and the owner's real naming (spaced slash, no-space slash, a parent nobody filed under) all work. */
const P = 'Cloud Native Solution Design';
const C01 = `${P}/01 云计算概览与参考架构`;
const C05 = `${P} / 05 Kubernetes：对象、运行机制与故障诊断`;
const C07 = `${P} / 07 微服务设计：边界、通信、发现与兼容演进`;
const now = '2026-10-01T08:00:00.000Z';
const cards = (prefix, n = 2) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i + 1}`, kind: 'flashcard', topic: `${prefix}-topic`, prompt: `${prefix}${i + 1}?`, answer: 'a' }));
const deck = (id, course, title = id) => ({ id, title, course, cards: cards(id) });
const source = (id, courses) => ({ id, title: id, text: `text of ${id}`, createdAt: now, courses });

async function library(t, { attempts = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'study-containment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  await service.store.update(state => {
    state.decks.push(deck('dP', P), deck('d01', C01), deck('d05', C05), deck('d07', C07), deck('dNative', 'Cloud Native'),
      deck('dTcp', 'TCP/IP'), deck('dNone', ''), deck('dLone1', 'Lone / ch 1'), deck('dLone2', 'Lone / ch 2'));
    state.sources.push(source('sP', [P]), source('s01', [C01]), source('s05', [C05]), source('s07', [C07]), source('sNative', ['Cloud Native']),
      source('sTcp', ['TCP/IP']), source('sNone', []), source('sTwo', [C05, C07]), source('sLone', ['Lone / ch 1']));
    if (attempts) for (const d of state.decks) for (const c of d.cards) state.attempts.push({ deckId: d.id, quiz_id: c.id, grade: 1, timestamp: now, at: now });
  });
  return service;
}
const ids = items => items.map(item => item.id).sort();

test('sources: a parent lists the whole subtree, a chapter only itself, uncategorised only the uncategorised', async t => {
  const service = await library(t);
  const list = async course => ids((await service.call('source.list', { course })).sources);
  assert.deepEqual(await list(P), ['s01', 's05', 's07', 'sP', 'sTwo']);
  assert.deepEqual(await list(C05), ['s05', 'sTwo']);
  assert.deepEqual(await list(C01), ['s01'], 'the no-space chapter is its own scope');
  assert.deepEqual(await list('Cloud Native'), ['sNative'], 'Cloud Native is not a parent of Cloud Native Solution Design');
  assert.deepEqual(await list(''), ['sNone']);
  assert.deepEqual(await list('TCP/IP'), ['sTcp']);
  assert.deepEqual(await list('Lone'), ['sLone'], 'a parent that no item is filed under is still a scope');
  assert.equal((await list('*')).length, 9);
  assert.equal((await service.call('source.list', {})).total, 9);
});

test('the wrong book follows the scope: parent = parent + chapters, chapter = itself', async t => {
  const service = await library(t);
  const decks = async course => [...new Set((await service.call('wrongbook', { course })).items.map(item => item.deckId))].sort();
  assert.deepEqual(await decks(P), ['d01', 'd05', 'd07', 'dP']);
  assert.deepEqual(await decks(C07), ['d07']);
  assert.deepEqual(await decks('Cloud Native'), ['dNative']);
  assert.deepEqual(await decks('Lone'), ['dLone1', 'dLone2']);
  assert.deepEqual(await decks(''), ['dNone']);
  assert.equal((await service.call('wrongbook', { course: P })).total, 8);
});

test('stats, new-question practice and the route use the same containment', async t => {
  const service = await library(t);
  const fresh = await library(t, { attempts: false });
  assert.equal((await service.call('stats', { course: P })).totals.cards, 8);
  assert.equal((await service.call('stats', { course: C05 })).totals.cards, 2);
  const run = await fresh.call('review.start', { mode: 'path', course: P, fresh: true });
  assert.deepEqual([...new Set(run.navigation.map(item => item.deckId))].sort(), ['d01', 'd05', 'd07', 'dP']);
  const chapter = await fresh.call('review.start', { mode: 'path', course: C07, fresh: true });
  assert.deepEqual([...new Set(chapter.navigation.map(item => item.deckId))], ['d07']);
  const route = await fresh.call('course.route', { course: P });
  assert.deepEqual(route.chapters.map(item => item.deckId), ['dP', 'd01', 'd05', 'd07'], 'parent first, then chapters in natural order');
  assert.deepEqual((await fresh.call('course.route', { course: C05 })).chapters.map(item => item.deckId), ['d05']);
});

test('continue-course on a parent walks its chapters and keeps the exact scope name', async t => {
  const service = await library(t, { attempts: false });
  const run = await service.call('review.start', { mode: 'course', course: P });
  assert.equal(run.course.name, P, 'the run keeps the exact scope name');
  assert.ok(new Set(run.navigation.map(item => item.deckId)).size > 1);
});

test('focus: an implicit parent can be chosen, the list carries it with subtree totals, writes stay exact', async t => {
  const service = await library(t);
  const focus = await service.call('focus.set', { course: 'Lone' });
  assert.equal(focus.course, 'Lone', 'a parent nobody filed under is a valid current course');
  const lone = focus.courses.find(item => item.name === 'Lone');
  assert.deepEqual([lone.count, lone.sourceCount, lone.deckTotal, lone.sourceTotal, lone.implicit], [0, 0, 2, 1, true]);
  const parent = focus.courses.find(item => item.name === P);
  assert.deepEqual([parent.count, parent.deckTotal, parent.sourceTotal, parent.implicit], [1, 4, 5, undefined]);
  assert.equal(focus.courses.find(item => item.name === C01).deckTotal, 1, 'stored names are listed exactly as typed');
  assert.equal(focus.courses.filter(item => item.name === 'Lone / ch 1').length, 1);
  await service.call('focus.set', { course: P });
  assert.equal((await service.call('snapshot')).focus.course, P);
  await assert.rejects(() => service.call('focus.set', { course: 'Nothing / here' }));
  const state = await service.call('export');
  assert.deepEqual(state.decks.map(item => item.course ?? item.folder).sort(), ['', 'Cloud Native', 'Lone / ch 1', 'Lone / ch 2', 'TCP/IP', P, C01, C05, C07].sort());
});

test('pure sites share the helper: sources, learning scope, vocabulary, weak topics, course batch', async t => {
  const service = await library(t);
  const state = await service.call('export');
  const known = [P, C01, C05, C07, 'Cloud Native', 'TCP/IP'];
  assert.equal(sourceMatchesCourse({ courses: [C01] }, P, known), true);
  assert.equal(sourceMatchesCourse({ courses: [C01] }, P), false, 'without the course list a no-space slash is part of the name');
  assert.equal(sourceMatchesCourse({ courses: [C01] }, C05, known), false);
  assert.equal(sourceMatchesCourse({ courses: [] }, P, known), false);
  assert.equal(sourceMatchesCourse({ courses: [] }, '', known), true);
  assert.equal(sourceMatchesCourse({ courses: [C01] }, '', known), false);
  assert.equal(sourceMatchesCourse({ courses: [C01] }, undefined, known), true);
  const scope = learningScope(state, { course: P });
  assert.deepEqual(scope.scope.map(ref => ref.deckId).sort(), ['d01', 'd05', 'd07', 'dP']);
  assert.deepEqual(courseTopics(state, P).filter(topic => topic.endsWith('-topic')).sort(), ['d01-topic', 'd05-topic', 'd07-topic', 'dP-topic']);
  assert.deepEqual(courseTopics(state, C05).filter(topic => topic.endsWith('-topic')), ['d05-topic']);
  assert.equal(weakTopicsFor(state, P).length, 4);
  assert.equal(weakTopicsFor(state, C07).length, 1);
  assert.deepEqual(courseBatch({ ...state, attempts: [] }, { course: P }).fresh.map(item => item.deckId).slice(0, 3), ['dP', 'dP', 'd01']);
});

test('the course list (settings) carries subtree totals next to its own counts', async t => {
  const service = await library(t);
  const { courses } = await service.call('course.list');
  const byName = new Map(courses.map(course => [course.name, course]));
  assert.deepEqual([byName.get(P).decks, byName.get(P).decksTotal, byName.get(P).sources, byName.get(P).sourcesTotal], [1, 4, 1, 5]);
  assert.deepEqual([byName.get(C05).decks, byName.get(C05).decksTotal, byName.get(C05).sourcesTotal], [1, 1, 2]);
  assert.equal(byName.get('Cloud Native').decksTotal, 1);
});
