/* 3.1.0 step 2 (reworked 2026-10-08, plan revision 5): the 考点清单 build as ONE kind of Job of the unified runtime (`exam-blueprint-build`, behind `runtime.pilot.examBlueprint`).
   Bottom-up: stage 0 checks the inputs with no model; the chosen sample papers are read first (what each question tests, in two levels); the points of several papers are united (the program
   checks nothing is lost); the lecture slides are then read in windows, to find the places of the points and the points the papers did not reach; ONE material is saved at the end.
   必学 = reached by a sample paper, 补充 = slides only. Fakes only: no real model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudyService } from '../lib/service.js';
import { usageLedger } from '../lib/model-usage.js';
import { reportUsage } from '../lib/usage-scope.js';
import { until, settleJob } from './helpers/wait.mjs';
import { gate, privateRoot } from './helpers/model-family-baseline.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { loadUi } from './helpers/ui-module.mjs';
import { isExamBlueprintSource } from '../lib/exam-blueprint-material.js';
import { WINDOW_SLIDES, repairGroups, normTitle } from '../lib/contexts/generation/blueprint/plan.js';

const KIND = 'exam-blueprint-build';
const consoleCode = await loadUi(`export { taskSummary } from './ui/tasks/task-summary.js'; export { tasksOf, taskKindOf } from './ui/tasks/task-model.js';`);
const stamp = '2026-10-01T00:00:00.000Z';

/** A lecture deck of `pages` slides, one source per slide; the pages in `blank` are pictures only and were skipped at import (so they are not sources). */
const deck = (pages, { blank = [], total = pages + blank.length } = {}) => Array.from({ length: pages }, (_, index) => {
  const page = index + 1;
  return { id: `deck-${page}`, title: `传输层.pptx · p.${page}`, text: `## 第 ${page} 页 · 主题${page}\n\n要点${page}：内容${page}内容${page}`, createdAt: stamp, courses: ['网络'],
    document: { page, totalPages: total, format: 'pptx' } };
});
const PAPER_A = { id: 'paper-a', title: '2023 样卷', createdAt: stamp, courses: ['网络'], text: 'Q1 简述 TCP 三次握手的作用。(10分)\nQ2 比较 UDP 与 TCP 的可靠性差异。(10分)\nQ3 一道讲义没讲过的题。(5分)' };
const PAPER_B = { id: 'paper-b', title: '2022 样卷', createdAt: stamp, courses: ['网络'], text: 'Q1 写出三次握手的报文。(8分)\nQ2 解释滑动窗口。(8分)' };

const requestData = prompt => JSON.parse(prompt.slice(prompt.indexOf('REQUEST DATA:\n') + 'REQUEST DATA:\n'.length).split('\n\nYour previous reply')[0]);
const question = (label, type, marks, quote, ...points) => ({ label, type, marks, quote, points });
const PAPER_REPLIES = {
  [PAPER_A.id]: { questions: [
    question('Q1', '简答', 10, '简述 TCP 三次握手的作用', { title: 'TCP 连接管理', parent: '传输层协议' }),
    question('Q2', '比较', 10, '比较 UDP 与 TCP 的可靠性差异', { title: 'UDP 与 TCP 的区别', parent: '传输层协议' }),
    question('Q3', '简答', 5, '一道讲义没讲过的题', { title: 'IPv6 地址', parent: '网络层' })] },
  [PAPER_B.id]: { questions: [
    question('Q1', '简答', 8, '写出三次握手的报文', { title: 'TCP连接管理', parent: '传输层协议' }),
    question('Q2', '简答', 8, '解释滑动窗口', { title: 'TCP 与 UDP 比较', parent: '传输层协议' }, { title: '滑动窗口', parent: '传输层协议' })] },
};
const GOOD_MERGE = { groups: [{ title: 'UDP 与 TCP 的区别', members: ['c2', 'c4'] }, { title: 'TCP 连接管理', members: ['c1'] }, { members: ['c3'] }, { members: ['c5'] }] };

/** The fake model: answers each stage from the request data, and can be told to break. */
function model({ held, fail, junk, merge = GOOD_MERGE, replies = PAPER_REPLIES } = {}) {
  const calls = [];
  const complete = async (system, prompt, request) => {
    const data = requestData(prompt);
    const call = { stage: data.stage, data, request };
    calls.push(call);
    reportUsage({ uncachedInputTokens: 100, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 });
    if (held && calls.length === held.at) await held.gate.promise;
    if (fail?.(call, calls)) throw new Error('provider down');
    if (junk?.(call, calls)) return 'this is not json';
    if (data.stage === 'paper') return JSON.stringify(replies[data.paper[0].id]);
    if (data.stage === 'merge') return JSON.stringify(typeof merge === 'function' ? merge(data) : merge);
    const slides = data.slides, first = slides[0], byTitle = title => data.points.find(point => point.title === title)?.id;
    const found = [['TCP 连接管理', 'deck-3', '要点3：内容3内容3'], ['滑动窗口', 'deck-4', '要点4：内容4内容4'], ['IPv6 地址', 'deck-1', '这句话不在任何一页上']]
      .filter(([title, id]) => byTitle(title) && slides.some(slide => slide.id === id)).map(([title, slideId, quote]) => ({ pointId: byTitle(title), slideId, quote }));
    const extra = [{ title: `主题${first.page}`, parent: '传输层协议', evidence: [{ slideId: first.id, quote: `要点${first.page}：内容${first.page}内容${first.page}` }] },
      ...(slides.some(slide => slide.page === 2) ? [{ title: '主题2', parent: '新的大考点', evidence: [{ slideId: 'deck-2', quote: '要点2：内容2内容2' }] }] : []),
      { title: `虚构${first.page}`, evidence: [{ slideId: first.id, quote: '这句话不在任何一页上' }] }];
    return JSON.stringify({ evidence: found, extra });
  };
  return { calls, complete, of: stage => calls.filter(call => call.stage === stage) };
}

async function world(t, { sources = deck(5, { blank: [6] }), papers = [PAPER_A], fake = model(), enabled = true } = {}) {
  const root = await privateRoot(t, 'exam-blueprint-job-');
  const service = new StudyService(root, { complete: fake.complete, ...switchOptions(enabled ? 'runtime' : 'legacy', { complete: fake.complete, paths: enabled ? ['examBlueprint'] : [] }) });
  t.after(() => service.dispose());
  await service.store.update(state => { state.sources.push(...structuredClone(sources), ...structuredClone(papers)); });
  const slides = sources.map(source => source.id);
  const request = (extra = {}) => ({ title: '网络 · 传输层 考点清单', course: '网络', scope: { label: '传输层' }, language: 'zh',
    inputs: [{ role: 'lecture', sourceIds: slides, title: '传输层.pptx' }, ...papers.map(paper => ({ role: 'past-paper', sourceIds: [paper.id], title: paper.title }))], ...extra });
  const build = extra => service.call('generation.blueprint.build', request(extra));
  const jobs = () => [...service.runtime.work.jobs.values()].filter(job => job.type === KIND);
  const lists = async () => (await service.store.read()).sources.filter(isExamBlueprintSource);
  const contract = () => jobs()[0].contract;
  return { service, fake, request, build, jobs, lists, contract, slides };
}
const refused = (promise, code) => assert.rejects(promise, error => { assert.equal(error.code, code, error.message); return true; });
const leaves = blueprint => blueprint.points.filter(point => !blueprint.points.some(other => other.parentId === point.id));
const byTitle = blueprint => Object.fromEntries(blueprint.points.map(point => [point.title, point]));

test('stage 0 refuses, with a code, in the learner\'s words, with no model call and no Job: switch off, no slides, a paper or a textbook alone, a missing material, no text, a list used as a material', async t => {
  const off = await world(t, { enabled: false });
  await refused(off.build(), 'blueprint-disabled');
  const w = await world(t);
  await refused(w.build({ inputs: [] }), 'blueprint-needs-primary-input');
  await refused(w.build({ inputs: [{ role: 'past-paper', sourceIds: [PAPER_A.id] }] }), 'blueprint-needs-primary-input');
  await refused(w.build({ inputs: [{ role: 'textbook', sourceIds: [PAPER_A.id] }, { role: 'past-paper', sourceIds: [PAPER_A.id] }] }), 'blueprint-needs-primary-input');
  await refused(w.build({ inputs: [{ role: 'lecture', sourceIds: ['no-such-slide'] }] }), 'blueprint-input-missing');
  await refused(w.build({ inputs: [{ role: 'lecture', documentId: 'no-such-deck' }] }), 'blueprint-input-missing');
  await refused(w.build({ title: '  ' }), 'blueprint-title-required');
  const blank = await world(t, { sources: [{ ...deck(1)[0], text: '   ' }] });
  await refused(blank.build(), 'blueprint-no-readable-text');
  // a 考点清单 is not course material: it cannot be an input of another one
  await settleJob(w.service, (await w.build()).jobId);
  const [list] = await w.lists();
  await refused(w.build({ inputs: [{ role: 'lecture', sourceIds: [list.id] }] }), 'blueprint-input-invalid');
  for (const item of [off, w, blank]) assert.equal(item.jobs().length, item === w ? 1 : 0, 'a refusal starts nothing');
  assert.equal(off.fake.calls.length + blank.fake.calls.length, 0, 'a refusal costs nothing');
  // the words of the learner: 备考补习 and 考点清单, never blueprint
  const words = [];
  for (const language of ['zh', 'en']) for (const item of [off, blank]) { try { await item.build({ language }); } catch (error) { words.push(error.message); } }
  assert.equal(words.length, 4);
  assert.ok(words.every(message => !/blueprint|蓝图/i.test(message)), words.join(' | '));
  assert.ok(words[0].includes('备考补习') && /exam preparation/i.test(words[2]), words.join(' | '));
});

test('the estimate is a range of calls and tokens from the real prompts, for any number of papers, asked with no model and no Job, and the same through usage.estimate', async t => {
  const w = await world(t, { sources: deck(25), papers: [PAPER_A, PAPER_B] });
  const priced = await w.build({ estimate: true });
  assert.equal(priced.status, 'estimate');
  const windows = Math.ceil(25 / WINDOW_SLIDES);
  // a paper call each, one call to unite their points, a call a window
  assert.deepEqual([priced.estimate.calls.low, priced.estimate.calls.high, priced.steps], [2 + 1 + windows, 2 + 1 + windows, 2 + 1 + windows]);
  assert.ok(priced.estimate.totalTokens.low > 0 && priced.estimate.totalTokens.high >= priced.estimate.totalTokens.low);
  const again = await w.service.call('usage.estimate', { feature: 'blueprint', ...w.request() });
  assert.deepEqual(again.totalTokens, priced.estimate.totalTokens);
  assert.deepEqual([w.fake.calls.length, w.jobs().length], [0, 0]);
  const one = await world(t, { sources: deck(25) });
  assert.equal((await one.build({ estimate: true })).estimate.calls.high, 1 + windows, 'one paper: no uniting call');
  const none = await world(t, { papers: [] });
  assert.equal((await none.build({ estimate: true })).estimate.calls.high, 1, 'no paper: only the slide windows');
});

test('one build is one Job, bottom-up: the paper first, then the slides, then one 考点清单; 必学 points come from the paper, 补充 points from the slides only', async t => {
  const w = await world(t);
  const started = await w.build();
  assert.ok(started.jobId);
  assert.equal(w.jobs().length, 1, 'found whole the moment the call returns');
  assert.equal(w.contract().title, '网络 · 传输层 考点清单');
  assert.equal((await settleJob(w.service, started.jobId)).status, 'complete');
  const { contract } = w.jobs()[0];
  assert.deepEqual([contract.kind, contract.status, contract.result.completeness, contract.runtime.attempts.length], [KIND, 'complete', 'complete', 1]);
  const [saved] = await w.lists();
  assert.deepEqual(contract.result.refs, [{ kind: 'source', id: saved.id }]);
  assert.deepEqual(w.fake.calls.map(call => call.stage), ['paper', 'slides'], 'one paper: nothing to unite');
  assert.deepEqual(contract.calls.map(call => [call.kind, call.feature, call.executionMode]), [['plan', 'other', 'direct'], ['plan', 'other', 'direct']]);
  assert.equal(new Set(contract.calls.map(call => call.stepKey)).size, 2, 'a stable step key each');
  const { byFeature } = await usageLedger(w.service.store.root).summary({ days: 1 });
  assert.deepEqual([Object.keys(byFeature), byFeature.other.calls], [['other'], 2]);
  const { blueprint, text } = saved;
  assert.deepEqual([saved.title, saved.provenance, saved.format, saved.courses], ['网络 · 传输层 考点清单', 'exam-blueprint', 'md', ['网络']]);
  const named = byTitle(blueprint);
  // 必学: the paper's questions reached them. 补充: only the slides did.
  assert.deepEqual(['TCP 连接管理', 'UDP 与 TCP 的区别', 'IPv6 地址'].map(title => named[title].tier), ['must', 'must', 'must']);
  assert.deepEqual(['主题1', '主题2'].map(title => named[title].tier), ['extra', 'extra']);
  assert.deepEqual(blueprint.basis, { samplePapers: 1, frequency: 'not-computed', skippedSlides: 1, must: 3, extra: 2, noCourseText: 2, label: '依据 1 份样卷；必学范围可能不全' });
  // the slides gave the places of the paper's points; a point the slides never mention stays, and says so
  assert.deepEqual(named['TCP 连接管理'].evidence.map(place => [place.role, place.sourceId, place.page ?? null]), [['lecture', 'deck-3', 3], ['past-paper', PAPER_A.id, null]]);
  assert.equal(named['TCP 连接管理'].backing.kind, 'both');
  assert.deepEqual([named['UDP 与 TCP 的区别'].backing.slides, named['IPv6 地址'].backing.slides], [0, 0]);
  assert.equal(text.split('\n').filter(line => line.includes('课件里没找到对应内容')).length, 2);
  // two levels, in the order of the slides: 传输层协议 (page 1 first) ahead of 新的大考点 (page 2) ahead of 网络层 (never on a slide)
  const bigs = blueprint.points.filter(point => !point.parentId).map(point => point.title);
  assert.deepEqual(bigs, ['传输层协议', '新的大考点', '网络层']);
  assert.deepEqual(blueprint.points.filter(point => point.parentId === named['传输层协议'].id).map(point => point.title), ['主题1', 'TCP 连接管理', 'UDP 与 TCP 的区别']);
  assert.ok(blueprint.points.every(point => !point.parentId || !blueprint.points.find(other => other.id === point.parentId).parentId), 'never deeper than two levels');
  assert.ok(text.indexOf('1. [') < text.indexOf('1.1 [') && text.includes('必学') && text.includes('补充'));
  // the paper's shape: every question of the paper reaches a point
  assert.deepEqual(blueprint.examShape.questions.map(item => [item.label, item.type, item.marks, item.pointIds.length]), [['Q1', '简答', 10, 1], ['Q2', '比较', 10, 1], ['Q3', '简答', 5, 1]]);
  assert.deepEqual(blueprint.examShape.unmatched, []);
  // the console's own detail
  assert.deepEqual(contract.detail.blueprint.windows, { done: 1, total: 1 });
  assert.deepEqual(contract.detail.blueprint.papers, { done: 1, total: 1 });
  assert.deepEqual(contract.detail.blueprint.skippedPages, [6]);
  assert.deepEqual(contract.detail.blueprint.dropped, { evidence: 2, points: 1, questions: 0 }, 'the quote that is on no slide (for IPv6) and the invented extra are dropped and counted');
  assert.deepEqual([contract.progress.done, contract.progress.total, contract.progress.unit], [2, 2, 'steps']);
  assert.ok(!/蓝图|blueprint/i.test(contract.stage.text + contract.title), 'no learner-facing string says blueprint');
});

test('two papers are united: a point both papers test is one point recording both, a point one paper tests is kept, a model merge joins synonyms, and nothing is lost', async t => {
  const w = await world(t, { papers: [PAPER_A, PAPER_B] });
  await settleJob(w.service, (await w.build()).jobId);
  assert.deepEqual(w.fake.calls.map(call => call.stage), ['paper', 'paper', 'merge', 'slides']);
  assert.deepEqual(w.fake.of('merge')[0].data.candidates.map(candidate => [candidate.id, candidate.title]),
    [['c1', 'TCP 连接管理'], ['c2', 'UDP 与 TCP 的区别'], ['c3', 'IPv6 地址'], ['c4', 'TCP 与 UDP 比较'], ['c5', '滑动窗口']], 'a title that differs only in spacing is merged by the program before the model is asked');
  const [{ blueprint }] = await w.lists();
  const named = byTitle(blueprint);
  assert.deepEqual(leaves(blueprint).filter(point => point.tier === 'must').sort((a, b) => a.id.localeCompare(b.id)).map(point => point.title), ['TCP 连接管理', 'UDP 与 TCP 的区别', 'IPv6 地址', '滑动窗口']);
  assert.deepEqual(['p1', 'p2', 'p3', 'p4'], ['TCP 连接管理', 'UDP 与 TCP 的区别', 'IPv6 地址', '滑动窗口'].map(title => named[title].id), 'ids follow first appearance');
  assert.deepEqual([named['TCP 连接管理'].backing.samplePapers, named['TCP 连接管理'].backing.papers], [2, [PAPER_A.id, PAPER_B.id]], 'shared: counted once, both papers recorded');
  assert.deepEqual([named['UDP 与 TCP 的区别'].backing.papers, named['IPv6 地址'].backing.papers, named['滑动窗口'].backing.papers], [[PAPER_A.id, PAPER_B.id], [PAPER_A.id], [PAPER_B.id]], 'the synonym joined both papers');
  assert.equal(blueprint.basis.label, '依据 2 份样卷（取并集）；必学范围可能不全');
  assert.deepEqual(blueprint.basis.must, 4);
  // every question of both papers still reaches a point
  assert.equal(blueprint.examShape.questions.length, 5);
  assert.ok(blueprint.examShape.questions.every(item => item.pointIds.length >= 1) && blueprint.examShape.unmatched.length === 0);
  assert.deepEqual(blueprint.examShape.questions.map(item => [item.paper, item.label]), [[PAPER_A.id, 'Q1'], [PAPER_A.id, 'Q2'], [PAPER_A.id, 'Q3'], [PAPER_B.id, 'Q1'], [PAPER_B.id, 'Q2']]);
  // the slide pass looked for the united points, with the places of the sample papers kept beside them
  assert.deepEqual(w.fake.of('slides')[0].data.points.map(point => point.title), ['TCP 连接管理', 'UDP 与 TCP 的区别', 'IPv6 地址', '滑动窗口']);
});

test('the union is checked by the program, not trusted: a model that drops, repeats and invents ids loses nothing, and the ids do not depend on its order', async t => {
  // the pure check
  const checked = repairGroups([{ title: '滑动窗口', members: ['c5', 'c99'] }, { title: 'TCP 连接管理', members: ['c1', 'c1', 'c2'] }, { title: '空', members: [] }, { members: ['c5'] }], ['c1', 'c2', 'c3', 'c4', 'c5']);
  assert.deepEqual(checked.groups.map(group => group.members), [['c5'], ['c1', 'c2'], ['c3'], ['c4']]);
  assert.deepEqual(checked.repaired, { lost: 2, duplicated: 2, unknown: 1 });
  assert.deepEqual(repairGroups(null, ['c1', 'c2']).groups.map(group => group.members), [['c1'], ['c2']], 'an answer that is not a list of groups changes nothing: every point stands alone');
  assert.equal(normTitle(' TCP　连接管理。'), normTitle('tcp连接管理'));
  // the whole build with a bad model
  const bad = await world(t, { papers: [PAPER_A, PAPER_B], fake: model({ merge: { groups: [{ title: '滑动窗口', members: ['c5', 'c99'] }, { title: 'TCP 连接管理', members: ['c1', 'c1', 'c2'] }, { members: [] }] } }) });
  await settleJob(bad.service, (await bad.build()).jobId);
  const [{ blueprint }] = await bad.lists();
  const must = leaves(blueprint).filter(point => point.tier === 'must').sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(must.map(point => [point.id, point.title]), [['p1', 'TCP 连接管理'], ['p2', 'IPv6 地址'], ['p3', 'TCP 与 UDP 比较'], ['p4', '滑动窗口']], 'c3 and c4, which the model left out, are still points; c1 and c2 are one point because the model said so');
  assert.ok(blueprint.examShape.questions.every(item => item.pointIds.length >= 1), 'no question lost its point');
  assert.equal(new Set(blueprint.examShape.questions.flatMap(item => item.pointIds)).size, 4);
  // the same candidates in another order of groups give the same ids
  const reversed = await world(t, { papers: [PAPER_A, PAPER_B], fake: model({ merge: { groups: [...GOOD_MERGE.groups].reverse() } }) });
  await settleJob(reversed.service, (await reversed.build()).jobId);
  const forward = await world(t, { papers: [PAPER_A, PAPER_B] });
  await settleJob(forward.service, (await forward.build()).jobId);
  const idsOf = async item => (await item.lists())[0].blueprint.points.map(point => [point.id, point.title, point.parentId ?? null]);
  assert.deepEqual(await idsOf(reversed), await idsOf(forward));
  // an answer that cannot be read after one more ask does not fail the build: the program's union stands
  const unreadable = await world(t, { papers: [PAPER_A, PAPER_B], fake: model({ junk: call => call.stage === 'merge' }) });
  assert.equal((await settleJob(unreadable.service, (await unreadable.build()).jobId)).status, 'complete');
  assert.equal(unreadable.fake.of('merge').length, 2);
  assert.equal(leaves((await unreadable.lists())[0].blueprint).filter(point => point.tier === 'must').length, 5, 'without the model\'s help only the same titles are united');
});

test('a point a paper tested but the slides never mention is kept and flagged; a quote that is not on the slide is dropped and counted; nothing is invented', async t => {
  const w = await world(t);
  await settleJob(w.service, (await w.build()).jobId);
  const [{ blueprint, text }] = await w.lists();
  const ipv6 = byTitle(blueprint)['IPv6 地址'];
  assert.deepEqual([ipv6.tier, ipv6.backing.slides, ipv6.backing.kind, ipv6.evidence.map(place => place.role)], ['must', 0, 'sample-paper', ['past-paper']]);
  assert.ok(text.includes('IPv6 地址（必学') && text.includes('课件里没找到对应内容'));
  assert.ok(!blueprint.points.some(point => /虚构/.test(point.title)), 'the invented point is not in the list');
});

test('the two-level rule: a model that nests three deep is flattened to 大考点 -> 小考点, nothing is lost', async t => {
  const deep = { [PAPER_A.id]: { questions: [question('Q1', '简答', 10, '简述 TCP 三次握手的作用', { title: 'A', parent: 'B' }, { title: 'B', parent: 'C' }, { title: 'D', parent: 'A' })] } };
  const w = await world(t, { fake: model({ replies: deep }) });
  await settleJob(w.service, (await w.build()).jobId);
  const [{ blueprint }] = await w.lists();
  const named = byTitle(blueprint);
  assert.ok(blueprint.points.every(point => !point.parentId || !blueprint.points.find(other => other.id === point.parentId).parentId), 'no point has a grandparent');
  assert.deepEqual(['A', 'B', 'D'].map(title => blueprint.points.find(point => point.id === named[title].parentId)?.title), ['C', 'C', 'C']);
  assert.deepEqual(blueprint.examShape.questions[0].pointIds.length, 3);
});

test('no sample paper: no paper stage, every point is 补充, and the list says it cannot tell what is 必学', async t => {
  const w = await world(t, { papers: [] });
  await settleJob(w.service, (await w.build()).jobId);
  assert.deepEqual(w.fake.calls.map(call => call.stage), ['slides']);
  assert.deepEqual(w.fake.calls[0].data.points, [], 'nothing to look for: the slides are read for what they teach');
  const [{ blueprint, text }] = await w.lists();
  assert.ok(blueprint.points.length > 0 && blueprint.points.every(point => point.tier === 'extra'));
  assert.equal(blueprint.basis.label, '没有样卷，无法判断哪些是必学');
  assert.ok(text.includes('没有样卷，无法判断哪些是必学') && !text.includes('必学）'));
  assert.equal(blueprint.examShape, undefined);
});

test('long decks are read in windows with a checkpoint between them: pausing waits for the call in flight, then the resume asks only for the windows left', async t => {
  const held = { at: 1, gate: gate() };
  t.after(() => held.gate.release());
  const w = await world(t, { sources: deck(25), papers: [], fake: model({ held }) });
  const started = await w.build();
  await until(() => w.fake.calls.length === 1, 'the first window to reach the model');
  await w.service.call('job.control', { jobId: started.jobId, action: 'pause' });
  assert.equal(w.contract().status, 'pausing', 'the call in flight is not interrupted');
  held.gate.release();
  await until(() => w.contract().status === 'paused', 'the checkpoint between windows');
  assert.equal(w.fake.of('slides').length, 1, 'no second window was started while pausing');
  assert.deepEqual(await w.lists(), [], 'nothing is saved before the end');
  await w.service.call('job.control', { jobId: started.jobId, action: 'resume' });
  assert.equal((await settleJob(w.service, started.jobId)).status, 'complete');
  assert.equal(w.fake.of('slides').length, Math.ceil(25 / WINDOW_SLIDES), 'every window was asked once in all');
  assert.equal(w.jobs()[0].contract.calls.filter(call => call.status === 'skipped').length, 1, 'the finished window is shown as reused, not asked again');
  assert.equal(w.jobs()[0].contract.runtime.attempts.length, 2);
  assert.equal((await w.lists()).length, 1);
});

test('a pause between the papers and the slides keeps the papers\' answers: the resume asks the slides only', async t => {
  const held = { at: 1, gate: gate() };
  t.after(() => held.gate.release());
  const w = await world(t, { fake: model({ held }) });
  const started = await w.build();
  await until(() => w.fake.calls.length === 1, 'the paper to reach the model');
  await w.service.call('job.control', { jobId: started.jobId, action: 'pause' });
  held.gate.release();
  await until(() => w.contract().status === 'paused', 'the checkpoint after the paper');
  assert.deepEqual(w.fake.calls.map(call => call.stage), ['paper']);
  await w.service.call('job.control', { jobId: started.jobId, action: 'resume' });
  assert.equal((await settleJob(w.service, started.jobId)).status, 'complete');
  assert.deepEqual(w.fake.calls.map(call => call.stage), ['paper', 'slides'], 'the paper was read once');
});

test('stopping aborts the call in flight and saves nothing', async t => {
  const held = { at: 1, gate: gate() };
  t.after(() => held.gate.release());
  const w = await world(t, { fake: model({ held }) });
  const started = await w.build();
  await until(() => w.fake.calls.length === 1, 'the model to be asked');
  await w.service.call('job.control', { jobId: started.jobId, action: 'cancel' });
  assert.equal(w.fake.calls[0].request.signal.aborted, true);
  held.gate.release();
  assert.equal((await settleJob(w.service, started.jobId)).status, 'cancelled');
  assert.deepEqual(await w.lists(), [], 'no half-written list');
});

test('a failed build is retried from the start: every model call is asked again, and nothing was saved in between', async t => {
  let broke = false;
  const fake = model({ fail: call => { if (!broke && call.stage === 'slides' && call.data.slides[0].page === 11) { broke = true; return true; } return false; } });
  const w = await world(t, { sources: deck(25), papers: [], fake });
  const started = await w.build();
  assert.equal((await settleJob(w.service, started.jobId)).status, 'failed');
  assert.deepEqual(await w.lists(), [], 'a failed build leaves no list');
  assert.equal(fake.of('slides').length, 2, 'window 1 answered, window 2 failed');
  assert.equal(w.contract().actions.retry.available, true);
  await w.service.call('job.control', { jobId: started.jobId, action: 'retry' });
  assert.equal((await settleJob(w.service, started.jobId)).status, 'complete');
  assert.equal(fake.of('slides').length, 2 + 3, 'the retry asks window 1 again: nothing of the failed attempt was kept');
  assert.equal(w.jobs()[0].contract.runtime.attempts.length, 2);
  assert.equal((await w.lists()).length, 1);
});

test('an unreadable answer is asked again once; a second one fails the build (in the learner\'s words) instead of saving a list with a hole', async t => {
  const once = await world(t, { papers: [], fake: model({ junk: (call, calls) => call.stage === 'slides' && calls.length === 1 }) });
  assert.equal((await settleJob(once.service, (await once.build()).jobId)).status, 'complete');
  assert.equal(once.fake.of('slides').length, 2);
  const twice = await world(t, { papers: [], fake: model({ junk: call => call.stage === 'slides' }) });
  const failed = await settleJob(twice.service, (await twice.build()).jobId);
  assert.equal(failed.status, 'failed');
  assert.equal(twice.fake.of('slides').length, 2);
  assert.deepEqual(await twice.lists(), []);
  assert.ok(!/blueprint|蓝图/i.test(twice.contract().error.message) && twice.contract().error.message.includes('考点清单'), twice.contract().error.message);
  const paper = await world(t, { fake: model({ junk: call => call.stage === 'paper' }) });
  assert.equal((await settleJob(paper.service, (await paper.build()).jobId)).status, 'failed');
  assert.deepEqual(paper.fake.calls.map(call => call.stage), ['paper', 'paper']);
});

test('a slide that is a picture only is never sent to the model and never invented into a point', async t => {
  const w = await world(t, { sources: [...deck(2), { ...deck(3)[2], text: '' }], papers: [] });
  await settleJob(w.service, (await w.build()).jobId);
  const sent = w.fake.of('slides').flatMap(call => call.data.slides.map(slide => slide.page));
  assert.deepEqual(sent, [1, 2]);
  const [{ blueprint }] = await w.lists();
  assert.deepEqual(blueprint.inputs[0].skippedPages, [3]);
});

/** A world that has already built one list (a single call of the fake), so a rebuild is the second build. */
async function withList(t, options = {}) {
  const w = await world(t, { papers: [], ...options });
  await settleJob(w.service, (await w.build()).jobId);
  const [old] = await w.lists();
  return { w, old };
}
const sourceOf = async (w, id) => (await w.service.store.read()).sources.find(source => source.id === id);

test('a rebuild names the list it replaces: recorded on the new list, the old one is archived (never deleted) only when the new one is saved, and the page can match the running build to its row', async t => {
  const held = { at: 2, gate: gate() };
  t.after(() => held.gate.release());
  const before = Date.now();
  const { w, old } = await withList(t, { fake: model({ held }) });
  assert.equal(Date.parse(old.createdAt) >= before - 1000 && Date.parse(old.createdAt) <= Date.now() + 1000, true, `a real creation time is written at ingest: ${old.createdAt}`);
  const started = await w.build({ supersedes: old.id });
  await until(() => w.fake.calls.length === 2, 'the rebuild to reach the model');
  // while it runs: the old list stands untouched, and the job says which row it is about
  assert.deepEqual([w.jobs().at(-1).contract.detail.targetId, w.jobs().at(-1).contract.detail.supersedes], [old.id, old.id]);
  assert.equal((await sourceOf(w, old.id)).archived, undefined);
  held.gate.release();
  assert.equal((await settleJob(w.service, started.jobId)).status, 'complete');
  const fresh = (await w.lists()).find(list => list.id !== old.id);
  assert.equal(fresh.blueprint.supersedes, old.id);
  assert.deepEqual([w.jobs().at(-1).contract.detail.targetId, w.jobs().at(-1).contract.detail.supersedes], [fresh.id, old.id], 'once saved, the job points at the new list');
  const archived = await sourceOf(w, old.id);
  assert.deepEqual([archived.archived, archived.blueprint.points.length > 0, archived.text.length > 0], [true, true, true], 'archived, still whole and readable');
  const { examPointLists } = await w.service.call('snapshot');
  assert.deepEqual(examPointLists.map(item => [item.id, item.supersedes, item.archived]).sort((a, b) => String(a[1]).localeCompare(String(b[1]))), [[old.id, null, true], [fresh.id, old.id, false]].sort((a, b) => String(a[1]).localeCompare(String(b[1]))));
  assert.ok(examPointLists.every(item => Date.parse(item.createdAt) > 0), 'the summary\'s time is real');
});

test('a failure or a stop leaves the list being replaced exactly as it was', async t => {
  const { w, old } = await withList(t, { fake: model({ fail: (call, calls) => calls.length === 2 }) });
  const failed = await settleJob(w.service, (await w.build({ supersedes: old.id })).jobId);
  assert.equal(failed.status, 'failed');
  assert.deepEqual([(await sourceOf(w, old.id)).archived, (await w.lists()).length], [undefined, 1]);
  const held = { at: 2, gate: gate() };
  t.after(() => held.gate.release());
  const stopping = await withList(t, { fake: model({ held }) });
  const started = await stopping.w.build({ supersedes: stopping.old.id });
  await until(() => stopping.w.fake.calls.length === 2, 'the model to be asked');
  await stopping.w.service.call('job.control', { jobId: started.jobId, action: 'cancel' });
  held.gate.release();
  assert.equal((await settleJob(stopping.w.service, started.jobId)).status, 'cancelled');
  assert.deepEqual([(await sourceOf(stopping.w, stopping.old.id)).archived, (await stopping.w.lists()).length], [undefined, 1]);
});

test('supersedes must be a 考点清单 of this library: anything else is refused in words, with no model call and no Job', async t => {
  const { w, old } = await withList(t);
  const calls = w.fake.calls.length, jobs = w.jobs().length;
  await refused(w.build({ supersedes: 'no-such-list' }), 'blueprint-supersedes-invalid');
  await refused(w.build({ supersedes: w.slides[0] }), 'blueprint-supersedes-invalid');
  await assert.rejects(w.build({ supersedes: 42 }), /supersedes must be string/, 'the contract already refuses a non-string');
  for (const language of ['zh', 'en']) await assert.rejects(w.build({ supersedes: 'no-such-list', language }), error => { assert.ok(error.message.includes(language === 'zh' ? '考点清单' : 'exam point list'), error.message); assert.ok(!/blueprint|蓝图/i.test(error.message)); return true; });
  assert.deepEqual([w.fake.calls.length, w.jobs().length], [calls, jobs]);
  assert.equal((await sourceOf(w, old.id)).archived, undefined);
});

test('the console draws it as a task without a branch for its kind, and no kernel or console file knows its name', async t => {
  const w = await world(t);
  await settleJob(w.service, (await w.build()).jobId);
  const tasks = consoleCode.tasksOf(await w.service.call('snapshot'));
  assert.equal(tasks.length, 1);
  assert.equal(consoleCode.taskKindOf(tasks[0]), 'extension');
  const summary = consoleCode.taskSummary(tasks[0]);
  assert.deepEqual([summary.state, summary.title], ['done', '网络 · 传输层 考点清单']);
  assert.ok(summary.line && !/undefined|NaN|蓝图|blueprint/i.test(JSON.stringify(summary)));
  const names = [];
  for (const dir of ['lib/jobs', 'lib/jobs/lifecycle', 'ui/tasks', 'lib/contexts/jobs']) {
    const folder = fileURLToPath(new URL(`../${dir}/`, import.meta.url));
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.isFile() && /\.(js|jsx)$/.test(entry.name) && /exam-blueprint|examBlueprint/i.test(await readFile(join(folder, entry.name), 'utf8'))) names.push(`${dir}/${entry.name}`);
    }
  }
  assert.deepEqual(names, []);
});
