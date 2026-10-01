/* WP21 · 知识骨架 page: a stale remembered skeleton must not show a raw server
   error, topic groups only show the members that live in the current course,
   and "regroup" is scoped to that course instead of replacing the library. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { StudyService } from '../lib/service.js';
import { createHostHandler } from '../lib/host.js';
import { groupPrompt } from '../ui/topic-group-prompt.js';
import { createPreviewServer, previewCall } from '../scripts/preview-server.mjs';

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export * from './ui/skeleton-groups.js';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { courseGroupRows, countGroupRows, classifySkeletonError, openSkeleton, focusSurvivesCourse, setUiLanguage } = module.exports;
const han = /[㐀-鿿]/;

const quote = 'Retries amplify load and replicas absorb failures when properly isolated.';
const card = (id, topic) => ({
  id, kind: 'quiz', topic, objective: `why ${id}`, prompt: `为什么 ${id} 需要隔离？`, answer: 'A', hint: 'h', misconception: 'm',
  explanation: '隔离可以把故障限制在局部，避免连锁放大成全面故障，这是它存在的原因。',
  citations: [{ sourceId: 's1', quote }],
  options: [{ id: 'a', text: 'A', correct: true, explanation: '对' }, { id: 'b', text: 'B', correct: false, explanation: '错' }, { id: 'c', text: 'C', correct: false, explanation: '错' }],
});
async function library(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-wp21-'));
  const service = new StudyService(root);
  t.after(() => rm(root, { recursive: true, force: true }));
  await service.call('source.add', { id: 's1', title: 'HA', text: quote });
  for (const [id, course, cards] of [
    ['arch', 'Architecture', [card('a1', 'Availability'), card('a2', 'Redundancy'), card('a3', 'Messaging')]],
    ['db', 'Databases', [card('b1', 'Indexes'), card('b2', 'Transactions'), card('b3', 'Availability')]],
  ]) {
    await service.call('draft.save', { deck: { id, title: id, course, cards } });
    await service.call('draft.publish', { id });
  }
  // Groups are stored library-wide: one per course plus one that spans both.
  await service.call('topic.groups.save', { mode: 'replace', groups: [
    { title: '数据库内核', topics: ['Indexes', 'Transactions'] },
    { title: '可用性', description: 'uptime', topics: ['Availability', 'Redundancy'] },
    { title: '通信', topics: ['Messaging'] },
  ] });
  return service;
}

test('a course-scoped topic read hides groups that have no members in that course', async t => {
  const service = await library(t);
  const arch = await service.call('skeleton.topics', { course: 'Architecture' });
  assert.deepEqual(arch.groups.groups.map(group => group.title).sort(), ['可用性', '通信']);
  assert.equal(arch.groups.groups.find(group => group.title === '可用性').count, 2, 'only this course\'s questions are counted');
  const all = await service.call('skeleton.topics', {});
  assert.equal(all.groups.groups.length, 3, 'the library-wide read keeps every group');
  const paged = await service.call('skeleton.topics', { course: 'Databases', limit: 50 });
  assert.deepEqual(paged.groups.groups.map(group => group.title).sort(), ['可用性', '数据库内核']);
});

test('regrouping one course replaces only that course and keeps every other course\'s groups', async t => {
  const service = await library(t);
  await service.call('topic.groups.save', { mode: 'replace', course: 'Architecture', groups: [
    { title: '架构基础', topics: ['Availability', 'Redundancy', 'Messaging'] },
  ] });
  const view = (await service.call('skeleton.topics', {})).groups;
  const byTitle = Object.fromEntries(view.groups.map(group => [group.title, group.topics.slice().sort()]));
  assert.deepEqual(byTitle['数据库内核'], ['indexes', 'transactions'], 'the other course\'s group is untouched');
  assert.deepEqual(byTitle['架构基础'], ['availability', 'messaging', 'redundancy']);
  assert.equal('通信' in byTitle, false, 'a group that only held this course\'s topics is replaced');
  assert.equal('可用性' in byTitle, false, 'old group emptied by the regroup disappears; shared topic moved');
  assert.equal(view.ungrouped.length, 0);
  // The course view shows only the new group; the other course still shows its own.
  const dbView = (await service.call('skeleton.topics', { course: 'Databases' })).groups;
  assert.deepEqual(dbView.groups.map(group => group.title).sort(), ['数据库内核', '架构基础']);
});

test('a missing skeleton fails with a stable not-found code instead of only text', async t => {
  const service = await library(t);
  await assert.rejects(service.call('skeleton.get', { id: 'gone' }), error => error.code === 'not-found');
  await assert.rejects(service.call('skeleton.patch', { id: 'gone', ops: [{ op: 'set', title: 'x' }] }), error => error.code === 'not-found');
  await assert.rejects(service.call('skeleton.save', { skeleton: { id: 'gone', title: 'x', scope: [] } }), error => error.code === 'not-found');
});

test('the host transport hands the not-found code to the UI', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'study-wp21-host-'));
  const home = await mkdtemp(join(tmpdir(), 'study-wp21-home-'));
  const saved = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(async () => { if (saved === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved; await rm(cwd, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); });
  const handler = createHostHandler({ sessions: { get: () => ({ header: { cwd } }) } }, {}, () => async () => '{}');
  const response = await handler('call', { sessionId: 's', action: 'skeleton.get', args: { id: 'gone' } });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'not-found');
  const other = await handler('call', { sessionId: 's', action: 'no.such.action', args: {} });
  assert.equal(other.error.code, 'STUDY_ERROR', 'unrelated failures keep the generic code');
});

test('the browser preview also carries the not-found code to the page', async t => {
  const base = await mkdtemp(join(tmpdir(), 'study-wp21-preview-'));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 3 }));
  const server = await createPreviewServer({ libraryRoot: join(base, 'lib'), home: join(base, 'home'), port: 0 });
  t.after(() => server.close());
  await assert.rejects(previewCall(server, 'skeleton.get', { id: 'gone' }), error => error.code === 'not-found');
  const raw = await fetch(server.url + '/api/call', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Study-Token': server.token }, body: JSON.stringify({ action: 'skeleton.get', args: { id: 'gone' } }) });
  assert.equal((await raw.json()).code, 'not-found');
});

const topic = (key, count, decks = 1) => ({ key, topic: key, count, decks: Array.from({ length: decks }, (_, i) => ({ deckId: `d${i}`, deckTitle: `D${i}`, folder: '', topic: key, count })) });
const view = (groups, ungrouped = []) => ({ groups: groups.map(([id, title, topics]) => ({ id, title, description: `${title} scope`, topics })), ungrouped });

test('group rows for a course drop empty groups, the header counts the rest, and ungrouped stays', () => {
  const topics = [topic('a', 2), topic('b', 1), topic('loose', 3)];
  const groupView = view([['g1', 'Alpha', ['a', 'b']], ['g2', 'Foreign', ['x', 'y']], ['g3', 'Also foreign', []]], ['loose']);
  const rows = courseGroupRows({ topics, groupView, query: '', shown: topics });
  assert.deepEqual(rows.map(row => row.title), ['Alpha', '未归入主题组']);
  assert.equal(countGroupRows(rows), 1, 'the 未归入 bucket is not a saved group');
  assert.deepEqual(rows[0].members.map(member => member.key), ['a', 'b']);
  assert.equal(rows.every(row => row.members.length > 0), true);
});

test('search never resurrects an empty group, even when its title matches', () => {
  const topics = [topic('cache', 2)];
  const groupView = view([['g1', 'Caching', ['cache']], ['g2', 'Caching in Other Course', ['elsewhere']]]);
  const rows = courseGroupRows({ topics, groupView, query: 'caching', shown: topics });
  assert.deepEqual(rows.map(row => row.id), ['g1']);
  assert.equal(courseGroupRows({ topics, groupView, query: 'zzz', shown: [] }).length, 0);
});

test('a library with no groups yields no group rows and a zero header count', () => {
  const topics = [topic('a', 1)];
  assert.deepEqual(courseGroupRows({ topics, groupView: view([], ['a']), query: '', shown: topics }), []);
  assert.deepEqual(courseGroupRows({ topics: null, groupView: null, query: '', shown: [] }), []);
  assert.equal(countGroupRows([]), 0);
});

test('a stale remembered skeleton is a quiet note, never a raw error', async () => {
  const stale = Object.assign(new Error('Skeleton not found'), { code: 'not-found' });
  assert.deepEqual(classifySkeletonError(stale), { kind: 'stale' });
  const result = await openSkeleton(async () => { throw stale; }, 'gone');
  assert.deepEqual(result, { stale: true });
  const found = await openSkeleton(async (action, args) => ({ id: args.id, action }), 'k1');
  assert.deepEqual(found, { skeleton: { id: 'k1', action: 'skeleton.get' } });
});

test('other skeleton failures become plain language in both languages, without server English', async () => {
  const technical = Object.assign(new Error('Study request failed'), { code: 'STUDY_ERROR' });
  setUiLanguage('zh');
  const zh = classifySkeletonError(technical);
  assert.equal(zh.kind, 'error');
  assert.match(zh.text, han);
  assert.doesNotMatch(zh.text, /Study request failed/);
  setUiLanguage('en');
  try {
    const en = classifySkeletonError(technical);
    assert.doesNotMatch(en.text, han);
    assert.doesNotMatch(en.text, /Study request failed|STUDY_ERROR/);
    const unavailable = classifySkeletonError(Object.assign(new Error('x'), { code: 'STUDY_UNAVAILABLE' }));
    assert.doesNotMatch(unavailable.text, han);
  } finally { setUiLanguage('zh'); }
  // A message that is already readable in the user's language is kept.
  assert.equal(classifySkeletonError(new Error('一次最多 200 道题，当前选中 300 道，请缩小范围')).text, '一次最多 200 道题，当前选中 300 道，请缩小范围');
  const failed = await openSkeleton(async () => { throw technical; }, 'k');
  assert.equal(failed.error.kind, 'error');
});

test('switching course keeps the open skeleton only when the new course lists it', async () => {
  const calls = [];
  const call = async (action, args) => { calls.push([action, args]); return { skeletons: [{ id: 'keep' }, { id: 'other' }] }; };
  assert.equal(await focusSurvivesCourse(call, 'keep', 'Architecture'), true);
  assert.deepEqual(calls[0], ['skeleton.list', { course: 'Architecture' }]);
  assert.equal(await focusSurvivesCourse(call, 'gone', 'Databases'), false);
  assert.equal(await focusSurvivesCourse(call, null, 'Databases'), true, 'nothing open: nothing to clear');
  assert.equal(await focusSurvivesCourse(async () => { throw new Error('offline'); }, 'keep', 'X'), true, 'a failed check never discards the user\'s place');
});

test('the regroup prompts are scoped to the course they run in', () => {
  const zh = groupPrompt({ mode: 'replace', topicCount: 33, course: 'Architecture' }, 'zh');
  assert.match(zh, /"course": "Architecture"/);
  assert.match(zh, /只归并课程「Architecture」/);
  const en = groupPrompt({ mode: 'replace', topicCount: 33, course: 'Architecture' }, 'en');
  assert.match(en, /"course":"Architecture"/);
  assert.match(en, /only the course "Architecture"/i);
  assert.match(groupPrompt({ mode: 'merge', ungrouped: 4, course: 'Architecture' }, 'zh'), /"course": "Architecture"/);
  assert.match(groupPrompt({ mode: 'merge', ungrouped: 4, course: 'Architecture' }, 'en'), /"course":"Architecture"/);
  for (const course of [undefined, '*']) {
    const prompt = groupPrompt({ mode: 'replace', topicCount: 5, course }, 'zh');
    assert.doesNotMatch(prompt, /"course"/, 'all courses: the library-wide wording is unchanged');
  }
});
