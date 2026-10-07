import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';
import { runForecast, FORECAST } from '../lib/coverage-run.js';
import { jobContract } from '../lib/job-contract.js';

/* What is left of a running coverage run, said from the run's OWN progress (the owner's request of 2026-10-07): the tokens (used + still to come = the whole, so it can be checked), the time, which basis
   a number has (出题前的估算 / 按已跑的进度估算), and nothing at all when the data is thin. The pure core is lib/coverage-run.js runForecast; its words are ui/coverage/copy.js; the 已用 tile and the
   run line of the 任务 console show them (ui/tasks/task-facts.js forecastOf, RunLine.jsx). A task that waits in the queue does not run: its clock is the wait, never 已用. */

const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as RunLine } from './ui/tasks/RunLine.jsx';
  export { default as TimeLimit } from './ui/tasks/TimeLimit.jsx';
  export { taskFacts, elapsedMs, forecastOf } from './ui/tasks/task-facts.js';
  export { limitFacts } from './ui/tasks/time-limit.js';
  export * as copy from './ui/coverage/copy.js';
  export { setUiLanguage } from './ui/i18n.js';
`);
const inLanguage = (language, run) => { m.setUiLanguage(language); try { return run(); } finally { m.setUiLanguage('zh'); } };
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();
const MIN = 60_000;

/* ---------- the pure core ---------- */

/** A run of 77 questions in 3 rounds (30, 30, 17), the pre-run estimate 3.0M to 4.8M (3.9M in the middle). */
const base = (over = {}) => ({ phase: 'running', ended: false, projection: { tokens: 3_900_000, minutes: null, basis: 'estimate' }, estimate: 3_900_000, tokens: 0, kept: 0, goal: 77, base: 0, elapsedMs: 0, ...over });

test('the threshold is written down once: at least 8 questions of this run AND 15% of the work it has to do, a change of more than 25% shows both numbers', () => {
  assert.deepEqual({ ...FORECAST }, { minKept: 8, minShare: 0.15, divergence: 0.25 });
});

test('the first minutes: the owner\'s screenshot (5 of 77, 1.55M tokens) gives no silly number; the estimate made before the run, less what was used, is shown and labelled', () => {
  const early = runForecast(base({ tokens: 1_546_895, kept: 5, elapsedMs: 9 * MIN }));
  assert.equal(early.basis, 'estimate', '5 questions is a batch, not a pace');
  assert.deepEqual(early.tokens, { used: 1_500_000, left: 2_400_000, total: 3_900_000 }, 'the 3.9M is the whole run as priced before it started, so what is LEFT is the whole less what was used; the parts are rounded to two digits and add up');
  assert.equal(early.preRun, null, 'the same number is not said twice');
  assert.deepEqual(early.time, { state: 'thin', elapsedMs: 9 * MIN });
});

test('a steady pace: tokens per kept question of THIS run give what is left; used + left is the whole, and the time follows the same progress', () => {
  const mid = runForecast(base({ tokens: 1_240_000, kept: 24, elapsedMs: 20 * MIN }));
  assert.equal(mid.basis, 'live');
  // 1 240 000 / 24 = 51 667 a question; 53 questions left = 2.74M
  assert.deepEqual(mid.tokens, { used: 1_200_000, left: 2_700_000, total: 3_900_000 });
  assert.equal(mid.preRun, null, 'within 25% of what was said before the run');
  // 20 min over 24 of 77: 20 x 53 / 24 = 44 min; the pace is still noisy (a third of the work), so a range: 25% either side, to five minutes
  assert.deepEqual(mid.time, { state: 'ok', elapsedMs: 20 * MIN, lowMin: 35, highMin: 55 });
  const late = runForecast(base({ tokens: 3_000_000, kept: 60, elapsedMs: 50 * MIN }));
  assert.deepEqual(late.time, { state: 'ok', elapsedMs: 50 * MIN, lowMin: 15, highMin: 15 }, 'past half way one number: 50 x 17 / 60 = 14 min, to five minutes');
});

test('a run that costs far more than was said shows both: the live number and the one from before the run', () => {
  const dear = runForecast(base({ tokens: 2_400_000, kept: 24, elapsedMs: 20 * MIN }));
  assert.equal(dear.basis, 'live');
  assert.deepEqual(dear.tokens, { used: 2_400_000, left: 5_300_000, total: 7_700_000 });
  assert.equal(dear.preRun, 3_900_000);
  const cheap = runForecast(base({ tokens: 400_000, kept: 24, elapsedMs: 20 * MIN }));
  assert.equal(cheap.preRun, 3_900_000, 'cheaper by more than a quarter: the same');
});

test('no junk: nothing is made of zero progress, zero time, a missing goal, numbers that are not numbers, or more used than was ever estimated', () => {
  const zero = runForecast(base());
  assert.equal(zero.basis, 'estimate');
  assert.deepEqual(zero.tokens, { used: 0, left: 3_900_000, total: 3_900_000 });
  assert.equal(zero.time.state, 'thin');
  for (const bad of [{ tokens: NaN, kept: NaN, elapsedMs: NaN }, { tokens: -5, kept: -1, elapsedMs: -9 }, { tokens: Infinity, kept: 30, elapsedMs: 30 * MIN }, { tokens: 1e6, kept: 30, elapsedMs: 0 }]) {
    const forecast = runForecast(base(bad)), everything = JSON.stringify(forecast);
    for (const value of [forecast.tokens?.used, forecast.tokens?.left, forecast.tokens?.total, forecast.time?.lowMin, forecast.time?.highMin]) if (value !== undefined) assert.ok(Number.isFinite(value) && value >= 0, everything);
  }
  assert.equal(runForecast(base({ goal: 0, kept: 3, tokens: 10_000 })), null, 'no goal: no forecast');
  assert.equal(runForecast(base({ goal: null })), null);
  // everything of the estimate used up and no pace yet: no number rather than 「还要 0」
  const spent = runForecast(base({ tokens: 4_000_000, kept: 5, elapsedMs: 30 * MIN }));
  assert.equal(spent.tokens, null);
  assert.equal(spent.basis, null);
  // no estimate at all and no pace: nothing
  assert.equal(runForecast(base({ estimate: null, projection: null, tokens: 100_000, kept: 2, elapsedMs: 5 * MIN })).tokens, null);
});

test('a run is not a pace when the work was not started here: a continued run whose start is unknown never extrapolates; one whose start is known counts only what it made itself', () => {
  const unknown = runForecast(base({ tokens: 1_240_000, kept: 48, base: null, elapsedMs: 20 * MIN }));
  assert.equal(unknown.basis, 'estimate', 'the 48 questions may be the earlier run\'s');
  assert.equal(unknown.time.state, 'thin');
  // 48 of 77 with 40 there at the start: this run made 8 of the 37 it has to make (22%): enough; 1.24M / 8 = 155k a question; 29 left
  const continued = runForecast(base({ tokens: 1_240_000, kept: 48, base: 40, elapsedMs: 20 * MIN }));
  assert.equal(continued.basis, 'live');
  assert.equal(continued.tokens.left, 4_500_000);
  // the same 48 with 44 there at the start: 4 questions is not a pace
  assert.equal(runForecast(base({ tokens: 1_240_000, kept: 48, base: 44, elapsedMs: 20 * MIN })).basis, 'estimate');
});

test('rounds already done give the number when this round has not made enough yet; its minutes come from the rounds', () => {
  const history = runForecast(base({ projection: { tokens: 2_000_000, minutes: 40, basis: 'history' }, tokens: 1_300_000, kept: 6, base: 0, elapsedMs: 25 * MIN }));
  assert.equal(history.basis, 'history');
  assert.deepEqual(history.tokens, { used: 1_300_000, left: 2_000_000, total: 3_300_000 });
  assert.deepEqual(history.time, { state: 'ok', elapsedMs: 25 * MIN, lowMin: 30, highMin: 50 }, '40 minutes from the rounds done, a quarter either side');
  const live = runForecast(base({ projection: { tokens: 2_000_000, minutes: 40, basis: 'history' }, tokens: 1_240_000, kept: 24, elapsedMs: 20 * MIN }));
  assert.equal(live.basis, 'live', 'once this run has a pace of its own, that is the number');
});

test('queued, paused, finished and stopped: the tokens may still be said, the time only while it runs, nothing for an ended run', () => {
  assert.deepEqual(runForecast(base({ phase: 'queued' })).time, { state: 'queued' });
  assert.deepEqual(runForecast(base({ phase: 'paused', tokens: 1_240_000, kept: 24, elapsedMs: 20 * MIN })).time, { state: 'paused', elapsedMs: 20 * MIN });
  assert.equal(runForecast(base({ phase: 'paused', tokens: 1_240_000, kept: 24, elapsedMs: 20 * MIN })).basis, 'live');
  assert.equal(runForecast(base({ ended: true, tokens: 1_240_000, kept: 24 })), null);
  assert.equal(runForecast(base({ phase: null })), null);
  assert.deepEqual(runForecast(base({ tokens: 3_800_000, kept: 77, elapsedMs: 70 * MIN })).time, { state: 'finishing', elapsedMs: 70 * MIN }, 'every question is there: it is closing up');
});

/* ---------- the words ---------- */

test('the words: the basis in the run line, both numbers when they differ, the sum as a line to check, the time as a figure or a range', () => {
  const early = runForecast(base({ tokens: 1_546_895, kept: 5, elapsedMs: 9 * MIN }));
  const mid = runForecast(base({ tokens: 1_240_000, kept: 24, elapsedMs: 20 * MIN }));
  const dear = runForecast(base({ tokens: 2_400_000, kept: 24, elapsedMs: 20 * MIN }));
  assert.equal(m.copy.forecastText(early), '预计还要约 2.4M tok（出题前的估算）');
  assert.equal(m.copy.forecastText(mid), '预计还要约 2.7M tok（按已跑的进度估算）');
  assert.equal(m.copy.forecastText(dear), '预计还要约 5.3M tok（按已跑的进度估算） · 出题前估 3.9M tok');
  assert.equal(m.copy.forecastMath(early), '已用 1.5M + 还要约 2.4M ≈ 共约 3.9M tok');
  assert.equal(m.copy.forecastMath(dear), '已用 2.4M + 还要约 5.3M ≈ 共约 7.7M tok');
  assert.equal(m.copy.forecastMath(runForecast(base())), '', 'nothing used yet: nothing to add up');
  assert.equal(m.copy.forecastText(runForecast(base({ estimate: null, projection: null, tokens: 1e5, kept: 1 }))), '');
  assert.equal(m.copy.forecastTime(mid.time), '预计还要约 35–55 分钟');
  assert.equal(m.copy.forecastTime(runForecast(base({ tokens: 3_000_000, kept: 60, elapsedMs: 50 * MIN })).time), '预计还要约 15 分钟');
  assert.equal(m.copy.forecastTime(runForecast(base({ tokens: 3_000_000, kept: 40, elapsedMs: 300 * MIN })).time), '预计还要约 4 小时 40 分钟', 'long ones in hours, to ten minutes');
  assert.equal(m.copy.forecastTime(early.time), '还没有足够的进度来估计时间');
  assert.equal(m.copy.forecastTime({ state: 'queued' }), '开始运行后才估计时间');
  assert.equal(m.copy.forecastTime({ state: 'paused', elapsedMs: 5 }), '已暂停，继续后再估计时间');
  assert.equal(m.copy.forecastTime({ state: 'finishing', elapsedMs: 5 }), '就快做完了');
  assert.equal(m.copy.forecastTime(null), '');
  inLanguage('en', () => {
    assert.equal(m.copy.forecastText(early), 'About 2.4M tok to go (the estimate made before the run)');
    assert.equal(m.copy.forecastText(mid), 'About 2.7M tok to go (from the progress so far)');
    assert.equal(m.copy.forecastText(dear), 'About 5.3M tok to go (from the progress so far) · Before the run: 3.9M tok');
    assert.equal(m.copy.forecastMath(early), 'Used 1.5M + about 2.4M to go ≈ about 3.9M tok in all');
    assert.equal(m.copy.forecastTime(mid.time), 'About 35–55 min to go');
    assert.equal(m.copy.forecastTime(early.time), 'Not enough progress yet to estimate the time');
    assert.equal(m.copy.forecastTime({ state: 'queued' }), 'The time is estimated once it starts running');
    assert.equal(m.copy.forecastTime({ state: 'paused', elapsedMs: 5 }), 'Paused; the time is estimated again once it continues');
    assert.equal(m.copy.forecastTime({ state: 'finishing', elapsedMs: 5 }), 'Almost done');
  });
});

test('the run line says the forecast instead of the projection of runFacts; without one it is what it was', () => {
  const facts = { total: 3, rounds: 3, round: 1, done: 0, left: 3, percent: 38, tokensUsed: 0, state: 'running', ended: false, waiting: false, projection: { tokens: 3_900_000, minutes: null, basis: 'estimate' } };
  assert.equal(m.copy.runLine(facts), '第 1/3 轮 · 覆盖 38% · 预计还要约 3.9M tok（出题前的估算）');
  const forecast = runForecast(base({ tokens: 1_240_000, kept: 24, elapsedMs: 20 * MIN }));
  assert.equal(m.copy.runLine(facts, { forecast }), '第 1/3 轮 · 覆盖 38% · 预计还要约 2.7M tok（按已跑的进度估算）');
  assert.equal(m.copy.runLine(facts, { forecast: null }), '第 1/3 轮 · 覆盖 38% · 预计还要约 3.9M tok（出题前的估算）', 'no forecast: the old projection');
  assert.equal(m.copy.runLine({ ...facts, ended: true }, { forecast }), '共 0 轮 · 覆盖 38%', 'an ended run says nothing of what is left');
});

/* ---------- the console: the contract, the 已用 tile, the line ---------- */

const T0 = Date.UTC(2026, 9, 7, 9, 0, 0);
const at = (minutes, seconds = 0) => new Date(T0 + minutes * MIN + seconds * 1000).toISOString();
const usage = (total) => ({ uncachedInputTokens: Math.round(total * 0.36), outputTokens: Math.round(total * 0.1), cacheReadTokens: total - Math.round(total * 0.36) - Math.round(total * 0.1), cacheWriteTokens: 0, calls: 12 });
const list = (statuses) => statuses.map((status, index) => ({ round: index + 1, questions: [30, 30, 17][index], status, fill: false, sections: 6 }));
/** The owner's run: 3 rounds, 77 questions, the pre-run estimate 3.0M to 4.8M. */
const job = (over = {}, run = {}) => ({ id: 'run-1', status: 'running', deckTitle: 'Platform lectures', draftId: 'd1', kind: 'quiz', count: 30, requestedTotal: 77, savedCount: 24, parts: 2, steps: [],
  startedAt: at(0), runStartedAt: at(0), totalTimeoutSeconds: 1800, tokenUsage: usage(1_240_000), control: { values: { concurrency: 4, autoComplete: true, paused: false }, limits: {} },
  coveragePlan: { level: 'standard', goal: 77, round: 1, rounds: 3 },
  coverageRun: { autoComplete: true, state: 'running', percent: 38, tokensUsed: 0, startedAt: at(0), list: list(['running', 'pending', 'pending']), estimate: { tokens: { low: 3_000_000, high: 4_800_000 } }, ...run }, ...over });
const now = (minutes, seconds = 0) => T0 + minutes * MIN + seconds * 1000;
const facts = (j, minutes, seconds = 0) => Object.fromEntries(m.taskFacts({ ...j, contract: jobContract(j) }, now(minutes, seconds)).map((fact) => [fact.key, fact]));

test('the contract carries when the job really began running and where the questions stood then', () => {
  const detail = jobContract(job()).detail;
  assert.equal(detail.runStartedAt, at(0));
  assert.equal(detail.keptAtStart, 0, 'a run that started a draft starts from none');
  assert.equal(jobContract(job({ continued: true, savedAtStart: 40 })).detail.keptAtStart, 40);
  assert.equal(jobContract(job({ continued: true })).detail.keptAtStart, null, 'a continued run of an older host: not known, so nothing is extrapolated');
  assert.equal(jobContract(job({ runStartedAt: undefined })).detail.runStartedAt, undefined, 'an older record has none');
  assert.equal(jobContract(job({ type: 'translation', runStartedAt: at(3) })).detail.runStartedAt, at(3), 'whatever kind has one says it');
});

test('已用 counts the time the task RUNS: a queued task shows the wait, as a wait; when it starts the clock starts at 0', () => {
  const queued = job({ status: 'queued', startedAt: at(0), runStartedAt: undefined, savedCount: 0, tokenUsage: undefined });
  const waiting = facts(queued, 44, 25).elapsed;
  assert.equal(waiting.label, '排队中');
  assert.equal(waiting.value, '已等 44 分 25 秒');
  assert.equal(waiting.note, '开始运行后才估计时间');
  assert.equal(m.elapsedMs(jobContract(queued), true, now(44, 25)), null, 'there is no run time yet');
  inLanguage('en', () => { const en = facts(queued, 44, 25).elapsed; assert.deepEqual([en.label, en.value, en.note], ['Queued', 'Waited 44 min 25 sec', 'The time is estimated once it starts running']); });
  // 44 minutes later it starts: the clock is the run's
  const started = job({ status: 'running', startedAt: at(0), runStartedAt: at(44), savedCount: 0, tokenUsage: undefined });
  const running = facts(started, 44, 25).elapsed;
  assert.equal(running.label, '已用');
  assert.equal(running.value, '25 秒');
  assert.equal(m.elapsedMs(jobContract(started), true, now(44, 25)), 25_000);
});

test('an older record without runStartedAt that is not queued counts from its start, as it always did; a paused run keeps its run clock; a finished one stops at its end', () => {
  const old = job({ runStartedAt: undefined });
  assert.equal(facts(old, 20).elapsed.value, '20 分 0 秒');
  const paused = job({ status: 'running', paused: true, pausedAt: at(21) });
  assert.equal(jobContract(paused).status, 'paused');
  assert.equal(facts(paused, 25).elapsed.label, '已用');
  assert.equal(facts(paused, 25).elapsed.value, '25 分 0 秒');
  assert.equal(facts(paused, 25).elapsed.note, '已暂停，继续后再估计时间');
  const ended = job({ status: 'complete', runStartedAt: at(5), finishedAt: at(35), savedCount: 77 });
  assert.equal(facts(ended, 90).elapsed.value, '30 分 0 秒', 'a finished task counts from its run start to its end, not to now');
  assert.equal(facts(ended, 90).elapsed.note, '', 'and does not estimate');
  const cancelledInQueue = job({ status: 'cancelled', runStartedAt: undefined, finishedAt: at(3) });
  assert.equal(facts(cancelledInQueue, 90).elapsed.value, '3 分 0 秒');
});

test('the time limit counts against the same clock: nothing used while queued, and from the start of the run once it runs', () => {
  const plain = (over) => job({ coverageRun: undefined, coveragePlan: undefined, totalTimeoutSeconds: 1200, ...over });
  const queued = plain({ status: 'queued', runStartedAt: undefined });
  assert.equal(m.limitFacts(jobContract(queued), { now: now(44) }).usedMs, null);
  const running = plain({ status: 'running', startedAt: at(0), runStartedAt: at(44) });
  assert.equal(m.limitFacts(jobContract(running), { now: now(50) }).usedMs, 6 * MIN, 'the 44 minutes in the queue are not the run\'s');
  assert.equal(m.limitFacts(jobContract(plain({ runStartedAt: undefined })), { now: now(10) }).usedMs, 10 * MIN, 'an older record: from its start');
});

test('the 已用 tile carries the time forecast in its note, from the same progress as the tokens', () => {
  const mid = facts(job(), 20).elapsed;
  assert.equal(mid.value, '20 分 0 秒');
  assert.equal(mid.note, '预计还要约 35–55 分钟');
  const thin = facts(job({ savedCount: 5, tokenUsage: usage(1_546_895) }), 9).elapsed;
  assert.equal(thin.note, '还没有足够的进度来估计时间');
  assert.equal(facts({ id: 'a', type: 'pdf-convert', status: 'running', startedAt: at(0), total: 4, done: 1 }, 5).elapsed.note, undefined, 'only a question run has the line');
  assert.equal(facts(job({ coverageRun: { ...job().coverageRun, autoComplete: false } }), 20).elapsed.note, '', 'a run that waits for the learner after one round has no rounds to add up');
});

test('the tile that counts questions says what it counts when a run has rounds: the draft over the WHOLE plan', () => {
  assert.equal(facts(job(), 20).primary.label, '题数 · 全部计划');
  assert.equal(facts(job(), 20).primary.value, '24 / 77');
  assert.equal(facts(job({ coverageRun: undefined, coveragePlan: undefined }), 20).primary.label, '题数', 'a plain run is what it was');
  inLanguage('en', () => assert.equal(facts(job(), 20).primary.label, 'Questions · whole plan'));
});

const lineOf = (j, minutes, language = 'zh') => inLanguage(language, () => renderToStaticMarkup(inApp(m, React.createElement(m.RunLine, { task: { ...j, contract: jobContract(j) }, now: now(minutes) }), { data: {} })));

test('the run line of the console: the forecast and, under it, the sum; the slot is there from the first poll, whatever it says, so nothing moves when the numbers come', () => {
  const html = lineOf(job(), 20);
  const plain = text(html);
  assert.match(plain, /第 1\/3 轮 · 覆盖 38% · 预计还要约 2\.7M tok（按已跑的进度估算）/);
  assert.match(html, /data-run-math[^>]*>已用 1\.2M \+ 还要约 2\.7M ≈ 共约 3\.9M tok</);
  const early = lineOf(job({ savedCount: 5, tokenUsage: usage(1_546_895) }), 9);
  assert.match(text(early), /预计还要约 2\.4M tok（出题前的估算）/);
  assert.match(early, /data-run-math[^>]*>已用 1\.5M \+ 还要约 2\.4M ≈ 共约 3\.9M tok</);
  const nothing = lineOf(job({ savedCount: 0, tokenUsage: undefined, coverageRun: { ...job().coverageRun, estimate: undefined } }), 1);
  assert.match(nothing, /data-run-math[^>]*>\u00a0<\/span>/, 'empty, but there');
  const diverging = lineOf(job({ tokenUsage: usage(2_400_000) }), 20);
  assert.match(text(diverging), /预计还要约 5\.3M tok（按已跑的进度估算） · 出题前估 3\.9M tok/);
  const queued = lineOf(job({ status: 'queued', runStartedAt: undefined, savedCount: 0, tokenUsage: undefined }), 40);
  assert.match(queued, /data-run-math/, 'a queued run has the slot too: the page does not move when it starts');
  const done = lineOf(job({ status: 'complete', savedCount: 77, finishedAt: at(60), coverageRun: { ...job().coverageRun, state: 'complete', list: list(['done', 'done', 'done']) } }), 90);
  assert.doesNotMatch(done, /data-run-math/, 'an ended run has nothing left to forecast');
  inLanguage('en', () => assert.match(lineOf(job(), 20, 'en'), /Used 1\.2M \+ about 2\.7M to go ≈ about 3\.9M tok in all/));
});

test('both lines are fixed in height: one line cut with an ellipsis for the sum, two reserved lines for the note of the tile', async () => {
  const css = (await import('node:fs')).readFileSync(new URL('../ui/tasks/task-console.css', import.meta.url), 'utf8');
  assert.match(css, /\.tc-run__math\s*\{[^}]*white-space:\s*nowrap[^}]*text-overflow:\s*ellipsis[^}]*min-height/);
  assert.match(css, /\.tc-metric__note\s*\{[^}]*font-variant-numeric:\s*tabular-nums[^}]*min-height/);
});
