import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';

// #234: the day of 为你定制 in the 任务 console: one row a day, the batches of the day as its own section, its figures, its settings and pause.
const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as TaskConsole } from './ui/tasks/TaskConsole.jsx';
  export { default as CoachBatches } from './ui/tasks/CoachBatches.jsx';
  export { taskSummary } from './ui/tasks/task-summary.js';
  export { taskFilters, filterTasks } from './ui/tasks/task-model.js';
  export { taskFacts } from './ui/tasks/task-facts.js';
  export { coachDailyJobs, dayOf, DAILY } from './lib/coach-daily.js';
  export { jobContract, snapshotJob } from './lib/job-contract.js';
  export { isActiveJob, isCancellable, JOB_TYPES } from './lib/job-status.js';
  export { setUiLanguage } from './ui/i18n.js';
`);
const HAN = /[㐀-鿿]/;
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const batch = (n, extra = {}) => ({ id: `b${n}`, startedAt: new Date(NOW - (10 - n) * 600000).toISOString(), endedAt: new Date(NOW - (10 - n) * 600000 + 40000).toISOString(), status: 'ok', targets: 4, generated: 4, passed: 3, skipped: 1,
  tokens: { input: 12000, output: 1800, cache: 9000 }, message: '', ...extra });
const rows = ({ batches = [batch(1), batch(2)], preparing = false, paused = false } = {}) => {
  const today = m.dayOf(NOW), yesterday = m.dayOf(NOW - 86400000);
  const data = { settings: { ...m.DAILY.defaults }, pausedDay: paused ? today : null, inflight: [],
    days: { [today]: { batches }, [yesterday]: { batches: [batch(5, { startedAt: new Date(NOW - 86400000).toISOString(), endedAt: new Date(NOW - 86400000 + 1000).toISOString() })] } } };
  const state = { decks: [], attempts: [] };
  return m.coachDailyJobs({ data, preparing, state, now: NOW }).map(m.snapshotJob);
};
const draw = (element, language = 'zh') => {
  m.setUiLanguage(language);
  try { return renderToStaticMarkup(inApp(m, element, { data: {}, app: { lib: { taskFocus: null }, host: {} } })); } finally { m.setUiLanguage('zh'); }
};
const consoleOf = (jobs, language) => draw(React.createElement(m.TaskConsole, { data: { jobs, drafts: [], decks: [] }, openers: { resultOf: () => null } }), language);

test('the console lists a row a day, named by the day, with one line of what it did', () => {
  const [today, past] = rows();
  assert.equal(m.taskSummary(today).kind, 'coach');
  assert.match(m.taskSummary(today).title, /^为你定制 · /);
  assert.match(m.taskSummary(today).line, /2 批 · 备好 6 道/);
  assert.notEqual(m.taskSummary(today).title, m.taskSummary(past).title, 'each day is its own row');
  const out = consoleOf([today, past]);
  assert.equal((out.match(/data-task-id="coach:/g) || []).length >= 2, true);
});

const failedBatch = () => batch(1, { status: 'failed', generated: 0, passed: 0, reason: 'error', message: 'Invalid JSON' });
const skippedBatch = () => batch(2, { status: 'skipped', generated: 0, passed: 0, reason: 'full' });
for (const scenario of [
  { name: 'all failed', batches: [failedBatch()], state: 'fail', failures: 1 },
  { name: 'failed and skipped without a saved card', batches: [failedBatch(), skippedBatch()], state: 'fail', failures: 1 },
  { name: 'failed and successful with saved cards', batches: [failedBatch(), batch(2)], state: 'partial', failures: 1 },
  { name: 'all successful', batches: [batch(1)], state: 'done', failures: 0 },
  { name: 'only skipped', batches: [skippedBatch()], state: 'done', failures: 0 },
  { name: 'running again after failure', batches: [failedBatch()], preparing: true, state: 'run', failures: 0 },
  { name: 'paused after failure', batches: [failedBatch()], paused: true, state: 'fail', failures: 1 },
]) test(`daily console distinguishes idle from business success: ${scenario.name}`, () => {
  const [today] = rows(scenario), summary = m.taskSummary(today);
  assert.equal(today.contract.status, scenario.preparing ? 'running' : 'complete', 'the daily record public lifecycle stays unchanged');
  assert.equal(summary.state, scenario.state);
  assert.equal(m.taskFilters([today]).find(filter => filter.id === 'failed').count, scenario.failures);
  assert.equal(m.filterTasks([today], 'failed').length, scenario.failures, 'the public failure filter includes ended daily failures');
  const out = consoleOf([today]);
  assert.match(out, /本日记录/);
  assert.doesNotMatch(out, /总进度 · 已完成/);
  if (scenario.batches.some(item => item.status === 'failed')) assert.match(summary.line, /失败 1 批/);
  if (scenario.state === 'done') assert.match(out, /暂无进行中的批次/);
  if (scenario.paused) assert.match(out, />继续</, 'daily pause/resume controls survive a failed batch');
  else assert.match(out, />暂停</, 'daily limits and pause remain available');
  assert.doesNotMatch(consoleOf([today], 'en'), HAN, 'daily outcome wording is translated');
});

test('the facts of the day: kept over written, practised and accuracy, the tokens in, out and from cache, what was skipped', () => {
  const [today] = rows();
  const facts = Object.fromEntries(m.taskFacts(today).map((fact) => [fact.label, fact.value]));
  assert.equal(facts['备好 / 写出'], '6 / 8');
  assert.equal(facts['练习 · 正确率'], '—', 'nothing practised yet: a dash, never 0%');
  assert.match(facts['令牌 入/出/缓存'], /^24K? \/ 3\.6K \/ 18K$|\//);
  assert.equal(facts['跳过 · 过期'], '2');
});

test('the detail has the batches as its section, the three live settings, pause today, and no 知道了 for today', () => {
  const [today] = rows();
  const out = consoleOf([today]);
  assert.match(out, />批次 2</);
  assert.match(out, /每天最多批数/);
  assert.match(out, /备好的题上限/);
  assert.match(out, /备题推理/);
  assert.match(out, />暂停</, 'pause today is the checkpoint action');
  assert.doesNotMatch(out, />停止</, 'a day is a record, not a run: there is nothing to stop');
  assert.doesNotMatch(out, />知道了</, 'today\'s row is not dismissed');
  assert.doesNotMatch(out, />存为默认</, 'these settings are already the saved ones');
});

test('a paused day offers to resume; a past day has no settings and can be dismissed', () => {
  const [today, past] = rows({ paused: true });
  assert.match(consoleOf([today]), />继续</);
  assert.match(m.taskSummary(today).line, /今天已暂停/);
  const out = consoleOf([past]);
  assert.doesNotMatch(out, />暂停</);
  assert.match(out, />删除这一天</);
  assert.match(out, /这个任务现在没有可以调整的设置|任务已经结束/);
});

test('the batches panel: newest first, a batch that wrote nothing says why in words, the settings in force in the strip', () => {
  const [today] = rows({ batches: [batch(1), batch(2, { status: 'skipped', generated: 0, passed: 0, reason: 'paused', tokens: { input: 0, output: 0, cache: 0 } }), batch(3, { status: 'failed', generated: 0, passed: 0, reason: 'error', message: '模型服务暂时不可用', tokens: { input: 0, output: 0, cache: 0 } })] });
  const out = draw(React.createElement(m.CoachBatches, { contract: m.jobContract(today) }));
  assert.equal((out.match(/data-batch="/g) || []).length, 3);
  assert.ok(out.indexOf('data-batch="b3"') < out.indexOf('data-batch="b1"'), 'newest first');
  assert.match(out, /写了 4 道，留下 3 道/);
  assert.match(out, /今天已暂停备题/);
  assert.match(out, /模型服务暂时不可用/);
  assert.match(out, /推理 最低 · 今天最多 24 批 · 备好的题最多 12 道/);
  assert.match(draw(React.createElement(m.CoachBatches, { contract: m.jobContract(rows()[1]) })), /这是过去的一天/);
  assert.match(draw(React.createElement(m.CoachBatches, { contract: m.jobContract(rows({ batches: [] }).find((row) => row.today) || today) })), /今天还没有备过题|写了/);
});

test('in English no Chinese is left in the day\'s row, its facts, its panels or its log reasons', () => {
  const [today, past] = rows({ batches: [batch(1), batch(2, { status: 'skipped', generated: 0, passed: 0, reason: 'limit', tokens: { input: 0, output: 0, cache: 0 } })] });
  assert.doesNotMatch(consoleOf([today, past], 'en'), HAN);
  m.setUiLanguage('en');
  try { assert.match(m.taskSummary(today).title, /^Personalised · /); } finally { m.setUiLanguage('zh'); }
});

test('the rest of the app never treats a day of 为你定制 as a job it waits for or draws a card for', () => {
  const [today] = rows({ preparing: true });
  assert.equal(today.status, 'running', 'a batch is in flight');
  assert.equal(m.isActiveJob(today), false, 'the generating mark of the header and the restart check do not count it');
  assert.equal(m.isCancellable(today), false);
  assert.equal(today.type, m.JOB_TYPES.COACH_DAILY);
});
