import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';

// 目标与知识点: the goal of a question run and the knowledge points its planning stage listed, drawn from the contract alone (detail.targets, partList, run, progress).
const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as PlanTable, planTabItem } from './ui/tasks/PlanTable.jsx';
  export { default as TaskBody } from './ui/tasks/TaskBody.jsx';
  export * as table from './ui/tasks/plan-table.js';
  export { jobContract } from './lib/job-contract.js';
  export { setUiLanguage } from './ui/i18n.js';
`);
const { table } = m;
const at = (seconds) => new Date(Date.UTC(2026, 9, 5, 10, 0, seconds)).toISOString();
const html = (element, language = 'zh', app = {}) => {
  m.setUiLanguage(language);
  try { return renderToStaticMarkup(inApp(m, element, { data: { sources: [{ id: 's1', title: 'Networks' }] }, app: { lib: { taskFocus: null }, host: {}, learn: { openSourceAt() {}, openAudioSources() {} }, ...app } })); } finally { m.setUiLanguage('zh'); }
};
const point = (index, extra = {}) => ({ part: Math.floor(index / 3) + 1, id: `t${index}`, objective: `Point ${index}: what a client and a server are`, state: 'planned', source: { sourceId: 's1', title: 'Networks', page: index + 1 }, ...extra });
const job = (extra = {}) => ({ id: 'g', status: 'running', deckTitle: 'Deck', requestedTotal: 9, savedCount: 3, parts: 3, startedAt: at(0), steps: [], ...extra });
const contractOf = (extra) => m.jobContract(job(extra));
const author = (part, status, id = `a${part}`) => ({ id, stage: 'Writing and self-checking questions', part, status, startedAt: at(1), ...(status === 'running' ? {} : { finishedAt: at(9) }) });
const review = (part, status, id = `r${part}`) => ({ id, stage: 'Reviewing ambiguity and source support', part, status, startedAt: at(10), ...(status === 'running' ? {} : { finishedAt: at(19) }) });
const states = (t) => t.groups.flatMap((group) => group.rows.map((row) => row.state));

test('one batch: every point is a row of one group, with its source and the plain words of its state', () => {
  const t = table.planTable(contractOf({ planTargets: { list: [0, 1, 2].map((i) => point(i, { state: 'kept' })) }, steps: [author(1, 'complete'), review(1, 'complete')], status: 'complete' }));
  assert.equal(t.groups.length, 1);
  assert.equal(t.points, 3);
  assert.deepEqual(states(t), ['passed', 'passed', 'passed']);
  assert.equal(table.groupTitle(t.groups[0]), '第 1 批 · 3 个考点');
  assert.equal(table.sourceText(t.groups[0].rows[1].source), 'Networks · 第 2 页');
  assert.equal(table.stateWord('passed'), '已通过');
});

test('several batches with mixed states: the state of a point still undecided comes from what its batch is doing', () => {
  const c = contractOf({ planTargets: { list: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => point(i, i < 3 ? { state: 'kept' } : {})) },
    steps: [author(1, 'complete'), review(1, 'complete'), author(2, 'running'), author(3, 'complete', 'a3')] });
  const t = table.planTable(c);
  assert.equal(t.groups.length, 3);
  assert.deepEqual(t.groups.map((group) => group.rows.map((row) => row.state)), [['passed', 'passed', 'passed'], ['authoring', 'authoring', 'authoring'], ['awaiting-review', 'awaiting-review', 'awaiting-review']]);
  assert.deepEqual(t.counts, { passed: 3, failed: 0, stopped: 0, running: 6, pending: 0 });
  const reviewing = table.planTable(contractOf({ planTargets: { list: [point(3), point(4), point(5)] }, steps: [author(2, 'complete'), review(2, 'running')] }));
  assert.deepEqual(states(reviewing), ['reviewing', 'reviewing', 'reviewing']);
  const waiting = table.planTable(contractOf({ planTargets: { list: [point(0)] } }));
  assert.deepEqual(states(waiting), ['pending'], 'a batch without a call has not started');
});

test('a failed point says why in the words the log uses, and a cancelled reason is a stop, not a failure', () => {
  const t = table.planTable(contractOf({ status: 'complete', planTargets: { list: [point(0, { state: 'failed', reason: 'quote' }), point(1, { state: 'omitted', reason: 'quality' }), point(2, { state: 'failed', reason: 'cancelled' })] } }));
  assert.deepEqual(states(t), ['failed', 'failed', 'stopped']);
  assert.equal(table.pointWhy('quote'), '引用在资料里找不到');
  assert.equal(table.pointWhy('quality'), '题没有通过质量审阅');
  assert.equal(table.pointWhy('pending'), '');
  assert.match(table.pointWhyLong('quote'), /^原因：引用在资料里找不到。/);
  const only = table.narrowTable(t, { filter: 'failed' });
  assert.deepEqual(only.flatMap((group) => group.rows.map((row) => row.id)), ['t0', 't1']);
});

test('a task that ended with a point undecided calls it stopped; a finished one does not claim anything it cannot know', () => {
  const stopped = table.planTable(contractOf({ status: 'cancelled', cancelRequestedAt: at(5), finishedAt: at(6), planTargets: { list: [point(0)] } }));
  assert.deepEqual(states(stopped), ['stopped']);
  const done = table.planTable(contractOf({ status: 'complete', finishedAt: at(6), planTargets: { list: [point(0)] } }));
  assert.deepEqual(states(done), ['']);
});

test('a coverage-run round: groups carry their round, a later round waits and an earlier one is not claimed', () => {
  const list = [point(0, { round: 1, state: 'kept' }), point(1, { round: 1, state: 'planned' }), point(2, { round: 2 }), point(3, { round: 3 })].map((item, index) => ({ ...item, id: `r${index}`, part: 1 }));
  const c = contractOf({ planTargets: { list }, coverageRun: { state: 'running', list: [{ round: 1, status: 'done' }, { round: 2, status: 'running' }, { round: 3, status: 'pending' }], draftId: 'd' }, steps: [{ ...author(1, 'running'), round: 2 }] });
  const t = table.planTable(c);
  assert.deepEqual(t.groups.map((group) => [group.round, group.part]), [[1, 1], [2, 1], [3, 1]]);
  assert.deepEqual(t.groups.map((group) => group.rows.map((row) => row.state)), [['passed', ''], ['authoring'], ['pending']]);
  assert.equal(table.groupTitle(t.groups[1]), '第 2 轮 · 第 1 批 · 1 个考点');
});

test('no plan yet: a running task says planning is going on; the table has no frame', () => {
  const t = table.planTable(contractOf({ steps: [{ id: 'p', stage: 'Planning evidence and learning targets', status: 'running', startedAt: at(1) }] }));
  assert.equal(t.planning, true);
  assert.equal(t.groups.length, 0);
  const out = html(React.createElement(m.PlanTable, { contract: contractOf({ steps: [{ id: 'p', stage: 'Planning evidence and learning targets', status: 'running', startedAt: at(1) }] }), task: job() }));
  assert.match(out, /规划还在进行，考点清单出来后会列在这里/);
  assert.doesNotMatch(out, /role="table"/);
  assert.match(html(React.createElement(m.PlanTable, { contract: contractOf({ steps: [] }), task: job() }), 'en'), /Planning is still going on; the points will be listed here once it returns/);
});

test('an old job without detail.targets shows its goal lines only, and says it kept no list', () => {
  const c = contractOf({ status: 'complete', finishedAt: at(9), partPlan: [{ part: 1, sourceIds: ['s1'], sourceCount: 1, label: 'Networks · 第 1–3 页' }] });
  assert.equal(c.detail.targets, null);
  const out = html(React.createElement(m.PlanTable, { contract: c, task: job({ status: 'complete' }) }));
  assert.match(out, /目标 9 题/);
  assert.match(out, /范围：Networks · 第 1–3 页/);
  assert.match(out, /这个任务没有记录考点清单/);
  assert.doesNotMatch(out, /role="table"/);
  assert.equal(table.planCount(c), '');
});

test('300 points: bounded and clipped by the contract, one row each, the count says what is not listed', () => {
  const list = Array.from({ length: 450 }, (_, i) => point(i, { objective: `P${i} ${'long '.repeat(80)}`, source: { sourceId: 's1', title: 'T'.repeat(200) } }));
  const c = contractOf({ planTargets: { list, more: 7 } });
  const t = table.planTable(c);
  assert.equal(t.points, 300);
  assert.equal(t.more, 157, 'the 7 the recorder counted and the 150 the reader had no room for');
  assert.ok(t.groups.flatMap((group) => group.rows).every((row) => row.objective.length <= 120 && row.source.title.length <= 60));
  assert.equal(table.planCount(c), 457);
  const out = html(React.createElement(m.PlanTable, { contract: c, task: job() }));
  assert.equal((out.match(/data-point="/g) || []).length, 300);
});

test('the search finds a point by its words or its source; the filters count what they hold', () => {
  const c = contractOf({ planTargets: { list: [point(0, { objective: 'TCP handshake' }), point(1, { objective: 'UDP datagrams', state: 'failed', reason: 'quote' }), point(2, { objective: 'DNS caching', source: { sourceId: 's1', title: 'Resolver notes' } })] }, steps: [author(1, 'running')] });
  const t = table.planTable(c);
  assert.deepEqual(table.filterCounts(t), { all: 3, active: 2, failed: 1 });
  assert.deepEqual(table.narrowTable(t, { query: 'udp' }).flatMap((group) => group.rows.map((row) => row.id)), ['t1']);
  assert.deepEqual(table.narrowTable(t, { query: 'resolver' }).flatMap((group) => group.rows.map((row) => row.id)), ['t2']);
  assert.deepEqual(table.narrowTable(t, { filter: 'active' }).flatMap((group) => group.rows.map((row) => row.id)), ['t0', 't2']);
  assert.equal(table.narrowTable(t, { query: 'nothing like this' }).length, 0);
});

test('a batch the plan came back short for is a group with its numbers, in the words of the plan block', () => {
  const c = contractOf({ status: 'complete', planTargets: { list: [point(0, { state: 'kept' })], short: [{ part: 2, needed: 3, got: 1 }] } });
  const t = table.planTable(c);
  assert.deepEqual(t.groups.map((group) => group.part), [1, 2]);
  assert.equal(table.groupShort(t.groups[1]), '要 3 个考点，只给出 1 个');
  assert.match(html(React.createElement(m.PlanTable, { contract: c, task: job() })), /要 3 个考点，只给出 1 个/);
});

test('the goal lines use the numbers of the facts: what is asked, what is kept, the round and the coverage path', () => {
  const c = contractOf({ requestedTotal: 24, savedCount: 6, planTargets: { list: [point(0, { state: 'kept' }), point(1, { state: 'failed', reason: 'quote' })] },
    coverageRun: { state: 'running', percent: 31, list: [{ round: 1, status: 'done', questions: 6 }, { round: 2, status: 'running', questions: 6 }, { round: 3, status: 'pending', questions: 12 }], draftId: 'd' } });
  const lines = table.goalLines(c, { material: 'Networks', kindLabel: '出题', table: table.planTable(c) });
  assert.equal(lines[0].text, '出题：目标 24 题 · 已出 6/24 题 · 来自「Networks」');
  assert.match(lines.find((line) => line.key === 'round').text, /^第 2\/3 轮 · /);
  assert.equal(lines.find((line) => line.key === 'points').text, '规划了 2 个考点 · 已通过 1 · 没通过 1');
});

test('the section: hover anchors are focusable, every state and the title have an explanation, both languages', () => {
  const c = contractOf({ planTargets: { list: [point(0, { state: 'kept' }), point(1, { state: 'failed', reason: 'quote' }), point(2)] }, steps: [author(1, 'running')] });
  const zh = html(React.createElement(m.PlanTable, { contract: c, task: job() }));
  assert.match(zh, /这是 AI 在规划阶段为本次任务列出的知识点；不会额外花 token/);
  assert.match(zh, /role="tooltip"/);
  assert.match(zh, /tabindex="0"[^>]*>已通过</);
  assert.match(zh, /tabindex="0"[^>]*>没通过</);
  assert.match(zh, /引用在资料里找不到/);
  assert.match(zh, /第 1 批 · 3 个考点/);
  assert.doesNotMatch(zh, / title="/, 'no title attribute on text: the project Tooltip');
  const en = html(React.createElement(m.PlanTable, { contract: c, task: job() }), 'en');
  assert.match(en, /The knowledge points the AI listed while planning this task; this costs no extra tokens/);
  assert.match(en, />Passed</);
  assert.match(en, />Failed</);
  assert.match(en, /Batch 1 · 3 points/);
  assert.match(en, /Goal/);
  assert.doesNotMatch(en, /[一-鿿]/, 'nothing is left in Chinese');
});

test('the third tab: only question runs and top-ups have it, with the count; other kinds keep their strip', () => {
  const run = job({ planTargets: { list: [point(0), point(1)] } });
  const strip = (task, language = 'zh') => html(React.createElement(m.TaskBody, { task }), language);
  const zh = strip({ ...run, contract: m.jobContract(run) });
  assert.match(zh, /正在进行 0/);
  assert.match(zh, /轮次与批次 3/);
  assert.match(zh, /目标与知识点 2/);
  assert.match(strip({ ...run, contract: m.jobContract(run) }, 'en'), /Goal and points 2/);
  const bare = job();
  assert.match(strip({ ...bare, contract: m.jobContract(bare) }), /目标与知识点(?! \d)/, 'the count is left out while it is unknown');
  const audio = { id: 'a', type: 'audio-import', filename: 'x.wav', status: 'running', startedAt: at(0), steps: [] };
  assert.doesNotMatch(strip({ ...audio, contract: m.jobContract(audio) }), /目标与知识点/);
});
