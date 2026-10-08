/* 3.1.0 step 2 (reworked 2026-10-08, plan revision 5): the 考点清单 build as ONE kind of Job of the unified runtime (`exam-blueprint-build`, behind `runtime.pilot.examBlueprint`).
   Bottom-up: stage 0 checks the inputs with no model; the chosen sample papers are read first (what each question tests, in two levels); the points of several papers are united (the program
   checks nothing is lost); the lecture slides are then read in windows, to find the places of the points and the points the papers did not reach; ONE material is saved at the end.
   样卷考过 (tier must) = reached by a sample paper, 补充 = slides only. Fakes only: no real model, no network. */
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
import { WINDOW_SLIDES, repairGroups, normTitle, planBuild, readSlides } from '../lib/contexts/generation/blueprint/plan.js';
import * as union from '../lib/contexts/generation/blueprint/union.js';
import * as quoteModule from '../lib/contexts/generation/blueprint/quote.js';
import { inputFingerprint } from '../lib/exam-point-list.js';

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
function model({ held, fail, junk, merge = GOOD_MERGE, replies = PAPER_REPLIES, slides: slideReply } = {}) {
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
    if (slideReply) return JSON.stringify(slideReply(data));
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

async function world(t, { sources = deck(5, { blank: [6] }), papers = [PAPER_A], fake = model(), enabled = true, inputs } = {}) {
  const root = await privateRoot(t, 'exam-blueprint-job-');
  const service = new StudyService(root, { complete: fake.complete, ...switchOptions(enabled ? 'runtime' : 'legacy', { complete: fake.complete, paths: enabled ? ['examBlueprint'] : [] }) });
  t.after(() => service.dispose());
  await service.store.update(state => { state.sources.push(...structuredClone(sources), ...structuredClone(papers)); });
  const slides = sources.map(source => source.id);
  const request = (extra = {}) => ({ title: '网络 · 传输层 考点清单', course: '网络', scope: { label: '传输层' }, language: 'zh',
    inputs: inputs ? inputs(slides) : [{ role: 'lecture', sourceIds: slides, title: '传输层.pptx' }, ...papers.map(paper => ({ role: 'past-paper', sourceIds: [paper.id], title: paper.title }))], ...extra });
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
  // a paper call each, one call to unite their points, a call a window, one call to unite the extra points of the windows
  assert.deepEqual([priced.estimate.calls.low, priced.estimate.calls.high, priced.steps], [2 + 1 + windows + 1, 2 + 1 + windows + 1, 2 + 1 + windows + 1]);
  assert.ok(priced.estimate.totalTokens.low > 0 && priced.estimate.totalTokens.high >= priced.estimate.totalTokens.low);
  const again = await w.service.call('usage.estimate', { feature: 'blueprint', ...w.request() });
  assert.deepEqual(again.totalTokens, priced.estimate.totalTokens);
  assert.deepEqual([w.fake.calls.length, w.jobs().length], [0, 0]);
  const one = await world(t, { sources: deck(25) });
  assert.equal((await one.build({ estimate: true })).estimate.calls.high, 1 + windows + 1, 'one paper in one chunk: no uniting call for the papers, one for the extra points of the windows');
  const none = await world(t, { papers: [] });
  assert.equal((await none.build({ estimate: true })).estimate.calls.high, 1, 'no paper and one window: only the slide window');
});

test('one build is one Job, bottom-up: the paper first, then the slides, then one 考点清单; 样卷考过 points come from the paper, 补充 points from the slides only', async t => {
  const w = await world(t);
  const started = await w.build();
  assert.ok(started.jobId);
  assert.equal(w.jobs().length, 1, 'found whole the moment the call returns');
  assert.equal(w.contract().title, '网络 · 传输层 考点清单');
  assert.equal((await settleJob(w.service, started.jobId)).status, 'complete');
  const { contract } = w.jobs()[0];
  assert.deepEqual([contract.kind, contract.status, contract.result.completeness, contract.runtime.attempts.length], [KIND, 'complete', 'complete', 1]);
  const [saved] = await w.lists();
  assert.deepEqual(contract.result.refs, [{ kind: 'exam-point-list', id: saved.id }], 'the result names a 考点清单, not a material');
  assert.deepEqual(w.fake.calls.map(call => call.stage), ['paper', 'slides'], 'one paper: nothing to unite');
  assert.deepEqual(contract.calls.map(call => [call.kind, call.feature, call.executionMode]), [['plan', 'other', 'direct'], ['plan', 'other', 'direct']]);
  assert.equal(new Set(contract.calls.map(call => call.stepKey)).size, 2, 'a stable step key each');
  const { byFeature } = await usageLedger(w.service.store.root).summary({ days: 1 });
  assert.deepEqual([Object.keys(byFeature), byFeature.other.calls], [['other'], 2]);
  const { blueprint, text } = saved;
  assert.deepEqual([saved.title, saved.provenance, saved.format, saved.courses], ['网络 · 传输层 考点清单', 'exam-blueprint', 'md', ['网络']]);
  const named = byTitle(blueprint);
  // 样卷考过: the paper's questions reached them. 补充: only the slides did.
  assert.deepEqual(['TCP 连接管理', 'UDP 与 TCP 的区别', 'IPv6 地址'].map(title => named[title].tier), ['must', 'must', 'must']);
  assert.deepEqual(['主题1', '主题2'].map(title => named[title].tier), ['extra', 'extra']);
  assert.deepEqual(blueprint.basis, { samplePapers: 1, frequency: 'not-computed', skippedSlides: 1, must: 3, extra: 2, noCourseText: 2, label: '依据 1 份样卷；样卷考过的点可能不全' });
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
  assert.ok(text.indexOf('1. [') < text.indexOf('1.1 [') && text.includes('样卷考过（1/1 份）') && text.includes('补充') && !text.includes('必学'));
  // the paper's shape: every question of the paper reaches a point
  assert.deepEqual(blueprint.examShape.questions.map(item => [item.label, item.type, item.marks, item.pointIds.length]), [['Q1', '简答', 10, 1], ['Q2', '比较', 10, 1], ['Q3', '简答', 5, 1]]);
  assert.deepEqual(blueprint.examShape.unmatched, []);
  // the console's own detail
  assert.deepEqual(contract.detail.blueprint.windows, { done: 1, total: 1 });
  assert.deepEqual(contract.detail.blueprint.papers, { done: 1, total: 1 });
  assert.deepEqual(contract.detail.blueprint.skippedPages, [6]);
  assert.deepEqual(contract.detail.blueprint.dropped, { evidence: 2, unresolved: 0, points: 1, questions: 0, places: 0 }, 'the quote that is on no slide (for IPv6) and the invented extra are dropped and counted');
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
  assert.equal(blueprint.basis.label, '依据 2 份样卷（取并集）；样卷考过的点可能不全');
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
  assert.ok(text.includes('IPv6 地址（样卷考过（1/1 份）') && text.includes('课件里没找到对应内容'));
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

test('no sample paper: no paper stage, every point is 补充, and the list says it cannot tell which points a sample paper tested', async t => {
  const w = await world(t, { papers: [] });
  await settleJob(w.service, (await w.build()).jobId);
  assert.deepEqual(w.fake.calls.map(call => call.stage), ['slides']);
  assert.deepEqual(w.fake.calls[0].data.points, [], 'nothing to look for: the slides are read for what they teach');
  const [{ blueprint, text }] = await w.lists();
  assert.ok(blueprint.points.length > 0 && blueprint.points.every(point => point.tier === 'extra'));
  assert.equal(blueprint.basis.label, '没有样卷，无法标出样卷考过的点');
  assert.ok(text.includes('没有样卷，无法标出样卷考过的点') && !text.includes('样卷考过（') && !text.includes('必学'));
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

test('a retry keeps the answers of the calls that finished: only what failed is asked again, and a provider error is retried once inside the call', async t => {
  let thrown = 0;
  const fake = model({ fail: call => call.stage === 'slides' && call.data.slides[0].page === 11 && thrown++ < 2 });
  const w = await world(t, { sources: deck(25), papers: [], fake });
  const started = await w.build();
  assert.equal((await settleJob(w.service, started.jobId)).status, 'failed');
  assert.deepEqual(await w.lists(), [], 'a failed build leaves no list');
  assert.equal(fake.of('slides').length, 3, 'window 1 answered; window 2 threw, was asked once more and threw again');
  assert.equal(w.contract().actions.retry.available, true);
  await w.service.call('job.control', { jobId: started.jobId, action: 'retry' });
  assert.equal((await settleJob(w.service, started.jobId)).status, 'complete');
  assert.equal(fake.of('slides').length, 3 + 2, 'the retry asks window 2 and window 3 only: window 1 was kept');
  assert.equal(w.jobs()[0].contract.runtime.attempts.length, 2);
  assert.equal((await w.lists()).length, 1);
  // one thrown error is absorbed inside the call: the build needs no retry at all
  let once = 0;
  const calm = await world(t, { sources: deck(25), papers: [], fake: model({ fail: call => call.stage === 'slides' && call.data.slides[0].page === 11 && once++ < 1 }) });
  assert.equal((await settleJob(calm.service, (await calm.build()).jobId)).status, 'complete');
  assert.equal(calm.fake.of('slides').length, 3 + 1);
  assert.equal(calm.jobs()[0].contract.runtime.attempts.length, 1);
});

test('an unreadable answer is asked again once; a window that is still unreadable is skipped and noted, and the list is saved marked partial; a paper chunk that is unreadable fails the build', async t => {
  const once = await world(t, { papers: [], fake: model({ junk: (call, calls) => call.stage === 'slides' && calls.length === 1 }) });
  assert.equal((await settleJob(once.service, (await once.build()).jobId)).status, 'complete');
  assert.equal(once.fake.of('slides').length, 2);
  assert.equal((await once.lists())[0].blueprint.basis.partial, undefined, 'a list that read everything is not partial');
  // window 2 (slides 11-20) is unreadable twice: the other windows still make the list
  const part = await world(t, { sources: deck(25), papers: [], fake: model({ junk: call => call.stage === 'slides' && call.data.slides[0].page === 11 }) });
  assert.equal((await settleJob(part.service, (await part.build()).jobId)).status, 'complete');
  assert.equal(part.fake.of('slides').length, 3 + 1, 'the unreadable window was asked twice, the others once');
  const [{ blueprint, text }] = await part.lists();
  assert.equal(blueprint.basis.partial, true);
  assert.deepEqual(blueprint.skippedWindows.map(item => item.pages), [Array.from({ length: 10 }, (_, index) => 11 + index)]);
  assert.ok(text.includes('课件第 11–20 页没能读出来') && blueprint.basis.label.includes('不完整'), text.slice(0, 300));
  const { detail, result, stage } = part.contract();
  assert.deepEqual(detail.blueprint.skippedWindows, [{ number: 2, pages: Array.from({ length: 10 }, (_, index) => 11 + index) }]);
  assert.equal(result.completeness, 'partial');
  assert.ok(stage.text.includes('第 11–20 页'), stage.text);
  assert.ok(!/blueprint|蓝图/i.test(JSON.stringify([stage.text, text])));
  // nothing readable at all: the build fails, in the learner's words, and saves nothing
  const twice = await world(t, { papers: [], fake: model({ junk: call => call.stage === 'slides' }) });
  const failed = await settleJob(twice.service, (await twice.build()).jobId);
  assert.equal(failed.status, 'failed');
  assert.equal(twice.fake.of('slides').length, 2);
  assert.deepEqual(await twice.lists(), []);
  assert.ok(!/blueprint|蓝图/i.test(twice.contract().error.message) && twice.contract().error.message.includes('考点清单'), twice.contract().error.message);
  const paper = await world(t, { fake: model({ junk: call => call.stage === 'paper' }) });
  assert.equal((await settleJob(paper.service, (await paper.build()).jobId)).status, 'failed');
  assert.deepEqual(paper.fake.calls.map(call => call.stage), ['paper', 'paper'], 'a sample paper chunk stays a hard failure: the required points would be wrong');
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
  const { w, old } = await withList(t, { fake: model({ fail: (call, calls) => calls.length === 2 || calls.length === 3 }) });
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

/* ---------- review fixes (design review of 3.1.0, items G-1 to G-8) ---------- */

const quoteOf = number => `第${number}题的题干内容说明`;
/** A sample paper of `count` numbered questions; every question has its own line, so its quote can be found in the paper. */
const longPaper = (id, count, from = 1) => ({ id, title: `${id} 样卷`, createdAt: stamp, courses: ['网络'],
  text: Array.from({ length: count }, (_, index) => `Q${from + index} ${quoteOf(from + index)}。(2分)`).join('\n') });
/** One page of a paper that is long enough that two pages do not fit one chunk. */
const paperPage = (id, from) => ({ id, title: id, createdAt: stamp, courses: ['网络'], text: `Q1 ${quoteOf(from)}。\nQ2 ${quoteOf(from + 1)}。\n${'填'.repeat(5000)}` });
const alone = data => ({ groups: data.candidates.map(candidate => ({ members: [candidate.id] })) });
const finish = async (w, extra) => {
  const status = (await settleJob(w.service, (await w.build(extra)).jobId)).status;
  assert.equal(status, 'complete', JSON.stringify(w.jobs().at(-1)?.contract.error));
  return (await w.lists()).at(-1);
};

test('G-1: a question label that repeats is kept: twice in one chunk, in two chunks of one paper, and a paper of 30 questions is read whole', async t => {
  const twice = { id: 'paper-dup', title: '重复题号', createdAt: stamp, courses: ['网络'], text: `Q1 ${quoteOf(1)}。\nQ1 ${quoteOf(2)}。\nQ2 ${quoteOf(3)}。` };
  const dup = await world(t, { papers: [twice], fake: model({ replies: { [twice.id]: { questions: [question('Q1', '简答', 5, quoteOf(1), { title: '链路层' }),
    question('Q1', '简答', 5, quoteOf(2), { title: '路由选择' }), question('Q2', '简答', 5, quoteOf(3), { title: '链路层' })] } } }) });
  const { blueprint } = await finish(dup);
  const named = byTitle(blueprint);
  assert.deepEqual(blueprint.examShape.questions.map(item => item.label), ['Q1', 'Q1 (2)', 'Q2'], 'the printed label is shown; a repeat is told apart in a fixed way');
  assert.deepEqual(blueprint.examShape.questions.map(item => item.pointIds), [[named['链路层'].id], [named['路由选择'].id], [named['链路层'].id]]);
  assert.deepEqual(dup.contract().detail.blueprint.dropped.questions, 0);
  // the same labels in two chunks of one paper: neither mapping overwrites the other
  const [one, two] = [paperPage('paper-p1', 1), paperPage('paper-p2', 3)];
  const replies = { [one.id]: { questions: [question('Q1', '简答', 5, quoteOf(1), { title: '链路层' }), question('Q2', '简答', 5, quoteOf(2), { title: '路由选择' })] },
    [two.id]: { questions: [question('Q1', '简答', 5, quoteOf(3), { title: '拥塞控制' }), question('Q2', '简答', 5, quoteOf(4), { title: '滑动窗口' })] } };
  const split = await world(t, { papers: [one, two], fake: model({ replies, merge: alone }),
    inputs: slides => [{ role: 'lecture', sourceIds: slides, title: '传输层.pptx' }, { role: 'past-paper', sourceIds: [one.id, two.id], title: '2023 样卷' }] });
  const listed = await finish(split);
  assert.equal(split.fake.of('paper').length, 2, 'the paper really is read in two chunks');
  const byName = byTitle(listed.blueprint);
  assert.deepEqual(listed.blueprint.examShape.questions.map(item => [item.label, item.pointIds.length]), [['Q1', 1], ['Q2', 1], ['Q1 (2)', 1], ['Q2 (2)', 1]]);
  assert.deepEqual(listed.blueprint.examShape.questions.map(item => item.pointIds[0]), ['链路层', '路由选择', '拥塞控制', '滑动窗口'].map(title => byName[title].id));
  // a paper of 30 questions: all 30 are kept
  const thirty = longPaper('paper-30', 30);
  const big = await world(t, { papers: [thirty], fake: model({ replies: { [thirty.id]: { questions: Array.from({ length: 30 }, (_, index) => question(`Q${index + 1}`, '简答', 2, quoteOf(index + 1), { title: `考点${index + 1}` })) } } }) });
  const whole = await finish(big);
  assert.equal(whole.blueprint.examShape.questions.length, 30);
  assert.equal(leaves(whole.blueprint).filter(point => point.tier === 'must').length, 30);
  assert.deepEqual(whole.blueprint.examShape.unmatched, []);
});

test('G-2: the limits are checked before the first model call, in the learner\'s words', async t => {
  const huge = await world(t, { sources: deck(501) });
  await refused(huge.build(), 'blueprint-input-too-large');
  const w = await world(t);
  await refused(w.build({ title: '长'.repeat(201) }), 'blueprint-title-too-long');
  await refused(w.build({ scope: { label: '长'.repeat(201) } }), 'blueprint-scope-too-long');
  await refused(w.build({ recommendedReading: { title: '某教材', url: 'ftp://example.invalid/x' } }), 'blueprint-reading-invalid');
  assert.deepEqual([huge.fake.calls.length + w.fake.calls.length, huge.jobs().length + w.jobs().length], [0, 0], 'a refusal costs nothing and starts nothing');
  const words = [];
  for (const language of ['zh', 'en']) for (const request of [{ title: '长'.repeat(201) }, { scope: { label: '长'.repeat(201) } }, { recommendedReading: { title: 'x', url: 'ftp://x' } }]) {
    try { await w.build({ ...request, language }); } catch (error) { words.push(error.message); }
  }
  assert.equal(words.length, 6);
  assert.ok(words.every(message => !/blueprint|蓝图|must be|required/i.test(message)), words.join(' | '));
  assert.ok(words.slice(0, 3).every(message => /[一-鿿]/.test(message)) && words.slice(3).every(message => !/[一-鿿]/.test(message)), words.join(' | '));
});

test('G-2: the producer stays inside the limits: five papers that hit one point save with at most 12 places, and more than 300 points keep the paper\'s points first', async t => {
  const papers = [1, 2, 3, 4, 5].map(number => longPaper(`paper-5-${number}`, 2));
  const replies = Object.fromEntries(papers.map(paper => [paper.id, { questions: [question('Q1', '简答', 2, quoteOf(1), { title: '拥塞控制' }), question('Q2', '简答', 2, quoteOf(2), { title: '拥塞控制' })] }]));
  const slides = data => ({ evidence: [1, 2, 3].map(number => ({ pointId: data.points.find(point => point.title === '拥塞控制').id, slideId: `deck-${number}`, quote: `要点${number}：内容${number}内容${number}` })), extra: [] });
  const five = await world(t, { papers, fake: model({ replies, slides, merge: alone }) });
  const listed = await finish(five);
  const point = byTitle(listed.blueprint)['拥塞控制'];
  assert.equal(point.evidence.length, 12, '3 slide places and 9 of the 10 paper places');
  assert.equal(point.backing.samplePapers, 5, 'every paper still counts');
  assert.equal(new Set(point.evidence.filter(place => place.role === 'past-paper').map(place => place.sourceId)).size, 5, 'every paper keeps a place');
  assert.equal(five.contract().detail.blueprint.dropped.places, 1);
  // 250 points from the paper and 72 extra ones from six windows of slides: 22 are left out, all of them extras, the earliest extras are kept
  const many = longPaper('paper-many', 50);
  const manyReplies = { [many.id]: { questions: Array.from({ length: 50 }, (_, index) => question(`Q${index + 1}`, '简答', 2, quoteOf(index + 1),
    ...Array.from({ length: 5 }, (_, k) => ({ title: `试卷考点${index + 1}-${k + 1}` })))) } };
  const extras = data => ({ evidence: [], extra: Array.from({ length: 12 }, (_, k) => ({ title: `补充${Math.ceil(data.slides[0].page / 10)}-${k + 1}`,
    evidence: [{ slideId: data.slides[0].id, quote: `要点${data.slides[0].page}：内容${data.slides[0].page}内容${data.slides[0].page}` }] })) });
  const capped = await world(t, { sources: deck(60), papers: [many], fake: model({ replies: manyReplies, slides: extras }) });
  const full = await finish(capped);
  assert.equal(full.blueprint.points.length, 300);
  assert.equal(full.blueprint.points.filter(point => point.tier === 'must').length, 250, 'every point the paper reached is kept');
  assert.ok(full.blueprint.points.some(point => point.title === '补充1-1') && !full.blueprint.points.some(point => point.title === '补充6-12'), 'the best-ranked extras are kept, the last are left out');
  assert.equal(capped.contract().detail.blueprint.dropped.points, 22);
});

test('G-2/G-3: a save that fails says so in the learner\'s words and keeps the answers: the retry saves without asking the model again', async t => {
  const w = await world(t, { papers: [] });
  const original = w.service.store.update.bind(w.service.store);
  let broken = true;
  w.service.store.update = async (...args) => { if (broken) throw new Error('EACCES: permission denied, rename library.json'); return original(...args); };
  const started = await w.build();
  const failed = await settleJob(w.service, started.jobId);
  assert.equal(failed.status, 'failed');
  const { message, code } = w.contract().error;
  assert.ok(message.includes('考点清单') && !/EACCES|rename|blueprint/i.test(message), message);
  assert.ok(code, 'a coded error');
  const asked = w.fake.calls.length;
  broken = false;
  await w.service.call('job.control', { jobId: started.jobId, action: 'retry' });
  assert.equal((await settleJob(w.service, started.jobId)).status, 'complete');
  assert.equal(w.fake.calls.length, asked, 'the retry did not call the model again');
  assert.equal((await w.lists()).length, 1);
});

test('G-4: extra points found in different windows are united with the paper union\'s machinery; one paper read in two chunks is united too; C, C++ and C# stay three points', async t => {
  const regression = data => ({ evidence: [], extra: data.slides[0].page === 1 ? [{ title: '线性回归', evidence: [{ slideId: 'deck-1', quote: '要点1：内容1内容1' }] }]
    : data.slides[0].page === 11 ? [{ title: '一元线性回归', evidence: [{ slideId: 'deck-11', quote: '要点11：内容11内容11' }] }] : [] });
  const joined = data => data.candidates.some(candidate => candidate.title === '线性回归') ? { groups: [{ title: '线性回归', members: data.candidates.map(candidate => candidate.id) }] } : alone(data);
  const w = await world(t, { sources: deck(15), papers: [], fake: model({ slides: regression, merge: joined }) });
  const { blueprint } = await finish(w);
  assert.deepEqual(w.fake.calls.map(call => call.stage), ['slides', 'slides', 'merge'], 'the extra points of the windows go through the union once, after the windows');
  assert.deepEqual(w.fake.of('merge')[0].data.candidates, [{ id: 'x1', title: '线性回归' }, { id: 'x2', title: '一元线性回归' }], 'titles and parents only');
  const regressions = blueprint.points.filter(point => /线性回归/.test(point.title));
  assert.deepEqual(regressions.map(point => point.title), ['线性回归']);
  assert.deepEqual(regressions[0].evidence.map(place => place.sourceId), ['deck-1', 'deck-11']);
  assert.equal(w.contract().detail.blueprint.merge.done, 1);
  // one paper, read in two chunks, is united: candidates from more than one chunk
  const [one, two] = [paperPage('paper-q1', 1), paperPage('paper-q2', 3)];
  const replies = { [one.id]: { questions: [question('Q1', '简答', 5, quoteOf(1), { title: '三次握手' })] }, [two.id]: { questions: [question('Q1', '简答', 5, quoteOf(3), { title: 'TCP 三次握手' })] } };
  const split = await world(t, { papers: [one, two], fake: model({ replies, merge: data => ({ groups: [{ title: '三次握手', members: data.candidates.map(candidate => candidate.id) }] }) }),
    inputs: slides => [{ role: 'lecture', sourceIds: slides, title: '传输层.pptx' }, { role: 'past-paper', sourceIds: [one.id, two.id], title: '2023 样卷' }] });
  const listed = await finish(split);
  assert.equal(split.fake.of('merge').length, 1);
  assert.deepEqual(leaves(listed.blueprint).filter(point => point.tier === 'must').map(point => point.title), ['三次握手']);
  assert.equal(listed.blueprint.basis.samplePapers, 1, 'still one paper');
  // symbols that name things are not noise
  assert.notEqual(normTitle('C'), normTitle('C#'));
  assert.notEqual(normTitle('C'), normTitle('C++'));
  assert.notEqual(normTitle('C#'), normTitle('C++'));
  assert.equal(normTitle('C＋＋'), normTitle('c++'), 'full-width and case do not matter');
  const { candidates } = union.candidatesOf([{ key: 'k', questions: [{ qid: '1.1', label: 'Q1', points: [{ title: 'C' }, { title: 'C++' }, { title: 'C#' }, { title: 'c' }, { title: '(C)' }] }] }]);
  assert.deepEqual(candidates.map(candidate => candidate.title), ['C', 'C++', 'C#']);
});

test('G-4: at most one quote per slide for a point, and a slide cited for many points does not fill every slot', () => {
  const place = (sourceId, quote = 'q') => ({ sourceId, quote: `${quote}-${sourceId}` });
  const points = [{ id: 'a', slidePlaces: [place('g'), place('s1'), place('s1', 'other'), place('s2'), place('s3')] },
    { id: 'b', slidePlaces: [place('g')] }, { id: 'c', slidePlaces: [place('g')] }, { id: 'd', slidePlaces: [place('g')] }];
  union.limitSlidePlaces(points, 3);
  assert.deepEqual(points[0].slidePlaces.map(item => item.quote), ['q-s1', 'q-s2', 'q-s3'], 'one quote a slide; the slide every point cites gives way to the specific ones');
  assert.deepEqual(points.slice(1).map(point => point.slidePlaces.map(item => item.sourceId)), [['g'], ['g'], ['g']], 'a point that has only the shared slide keeps it');
});

test('G-5: a point says how many of the chosen sample papers tested it, in words that claim no more than that', async t => {
  const w = await world(t, { papers: [PAPER_A, PAPER_B] });
  const { blueprint, text } = await finish(w);
  assert.ok(text.includes('TCP 连接管理（样卷考过（2/2 份）') && text.includes('IPv6 地址（样卷考过（1/2 份）') && text.includes('（补充'), text.slice(0, 600));
  assert.ok(!text.includes('必学') && !blueprint.basis.label.includes('必学'));
  assert.equal(blueprint.basis.label, '依据 2 份样卷（取并集）；样卷考过的点可能不全');
});

test('G-6: a quote is located in the slide by one matcher and the exact words of the slide are stored: half-width brackets still find the place, and a 2-character quote is not evidence', async t => {
  const sources = deck(3).map(source => source.document.page === 2 ? { ...source, text: '## 第 2 页\n\n握手（SYN 与 ACK）：双方确认序号' } : source);
  const slides = () => ({ evidence: [], extra: [
    { title: '握手确认', evidence: [{ slideId: 'deck-2', quote: '握手(SYN 与 ACK):双方确认序号' }] },
    { title: '太短的引文', evidence: [{ slideId: 'deck-2', quote: '握手' }] }] });
  const w = await world(t, { sources, papers: [], fake: model({ slides }) });
  const { blueprint } = await finish(w);
  const named = byTitle(blueprint);
  assert.deepEqual(named['握手确认'].evidence.map(place => place.quote), ['握手（SYN 与 ACK）：双方确认序号'], 'the slide\'s own words, which the library finds again');
  assert.equal(named['太短的引文'], undefined, 'two characters are not a place');
  assert.deepEqual(w.contract().detail.blueprint.dropped, { evidence: 1, unresolved: 0, points: 1, questions: 0, places: 0 }, 'a rejected quote is not an unresolved one');
  // the matcher itself
  assert.deepEqual(quoteModule.locateQuote('定义（SYN）：确认序号', '定义(SYN):确认序号')?.quote, '定义（SYN）：确认序号');
  assert.deepEqual(quoteModule.locateQuote('Q1 简述 TCP\n三次握手的作用。', '简述 TCP 三次握手的作用')?.quote, '简述 TCP 三次握手的作用');
  assert.equal(quoteModule.locateQuote('握手确认', '握手'), null);
  assert.equal(quoteModule.locateQuote('three-way handshake', 'handshake'), null, '9 other characters are too few');
  assert.ok(quoteModule.locateQuote('the three-way handshake', 'three-way handshake'));
  assert.equal(quoteModule.locateQuote('some other words', 'three-way handshake'), null);
});

test('G-7: the result names a 考点清单, the job says what a retry and a stop keep and which course it is for, and each input records a fingerprint of the texts it was built from', async t => {
  const w = await world(t);
  const list = await finish(w);
  const { result, capabilities, detail } = w.contract();
  assert.deepEqual(result.refs, [{ kind: 'exam-point-list', id: list.id }]);
  assert.deepEqual([capabilities.retryKeeps, capabilities.stopKeeps], ['completed', 'nothing'], 'a retry goes on from the finished calls; a stop saves nothing');
  assert.equal(detail.course, '网络');
  const none = await world(t);
  await finish(none, { course: '' });
  assert.equal(none.contract().detail.course, null);
  const texts = ids => ids.map(id => deck(5, { blank: [6] }).find(source => source.id === id).text);
  const [lecture, paper] = list.blueprint.inputs;
  assert.equal(lecture.fingerprint, inputFingerprint(texts(lecture.sourceIds)));
  assert.equal(paper.fingerprint, inputFingerprint([PAPER_A.text]));
  assert.match(lecture.fingerprint, /^[0-9a-f]{8}$/);
  // a changed slide gives another fingerprint
  const changed = await world(t, { sources: deck(5, { blank: [6] }).map(source => source.document.page === 3 ? { ...source, text: `${source.text}（改）` } : source) });
  const other = await finish(changed);
  assert.notEqual(other.blueprint.inputs[0].fingerprint, lecture.fingerprint);
  assert.equal(other.blueprint.inputs[1].fingerprint, paper.fingerprint);
});

test('G-1: the shape keeps at most the list\'s 400 questions and says how many it left out; their points still count', async t => {
  const paper = longPaper('paper-405', 405);
  const reply = { questions: Array.from({ length: 405 }, (_, index) => question(`Q${index + 1}`, '简答', 1, quoteOf(index + 1), { title: `考点${index % 20}` })) };
  const w = await world(t, { papers: [paper], fake: model({ replies: { [paper.id]: reply } }) });
  const listed = await finish(w);
  assert.equal(listed.blueprint.examShape.questions.length, 400);
  assert.equal(w.contract().detail.blueprint.dropped.questions, 5);
  assert.equal(leaves(listed.blueprint).filter(point => point.tier === 'must').length, 20);
});

test('G-3: the answers kept for a retry belong to the plan: the same request gives the same key, another text or language another key', async t => {
  const w = await world(t);
  const state = await w.service.store.read();
  const key = request => planBuild(state, request).planKey;
  const asked = w.request();
  assert.equal(key(asked), key(w.request()));
  assert.notEqual(key({ ...asked, language: 'en' }), key(asked));
  assert.notEqual(key({ ...asked, scope: { label: '网络层' } }), key(asked));
  const edited = structuredClone(state);
  edited.sources.find(source => source.id === 'deck-3').text += '（改）';
  assert.notEqual(planBuild(edited, asked).planKey, key(asked), 'a changed slide is another plan');
  assert.equal(planBuild(state, { ...asked, title: '另一个名字' }).planKey, key(asked), 'the name of the list changes no call');
});

test('G-4/G-6: the reader keeps one place per slide for a point, drops what is not on the slide or too short, and counts them apart from the places the library cannot find', () => {
  const window = { slides: [{ id: 's1', page: 1, text: '握手（SYN 与 ACK）：双方确认序号。第二句话讲窗口。' }, { id: 's2', page: 2, text: '滑动窗口控制发送速率，避免拥塞。' }] };
  const reply = JSON.stringify({ evidence: [
    { pointId: 'p1', slideId: 's1', quote: '握手(SYN 与 ACK):双方确认序号' }, { pointId: 'p1', slideId: 's1', quote: '第二句话讲窗口' },
    { pointId: 'p1', slideId: 's2', quote: '滑动窗口控制发送速率' }, { pointId: 'p1', slideId: 's2', quote: '窗口' }, { pointId: 'px', slideId: 's2', quote: '滑动窗口控制发送速率' }],
  extra: [{ title: '拥塞避免', evidence: [{ slideId: 's2', quote: '避免拥塞' }, { slideId: 's2', quote: '滑动窗口控制发送速率，避免拥塞' }, { slideId: 's1', quote: '不在这一页的一句话' }] }] });
  const read = readSlides(reply, window, new Set(['p1']));
  assert.deepEqual(read.evidence.map(item => [item.pointId, item.sourceId, item.quote]), [['p1', 's1', '握手（SYN 与 ACK）：双方确认序号'], ['p1', 's2', '滑动窗口控制发送速率']]);
  assert.deepEqual(read.extra.map(item => item.evidence.map(place => place.quote)), [['滑动窗口控制发送速率，避免拥塞']], 'the 4-character quote is too short, the other slide does not have its sentence');
  assert.deepEqual(read.dropped, { evidence: 4 }, '"窗口", an unknown point id, "避免拥塞", and the sentence that is on no slide');
});
