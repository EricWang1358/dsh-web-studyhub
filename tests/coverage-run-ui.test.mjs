import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';

/* The rounds of a coverage run on screen (phase 3b): the 任务 console's header (the line, the controls, the rounds), the draft page (the run, the choice, the one button), the home row and the creation
   form (自动补到完整, the spending limit), in Chinese and English, light/dark being tokens only. Static markup; every number comes from lib/coverage-run.js and every word from ui/coverage/copy.js. */

const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as TaskConsole } from './ui/tasks/TaskConsole.jsx';
  export { default as GenerationParts } from './ui/tasks/GenerationParts.jsx';
  export { default as LogPanel } from './ui/tasks/LogPanel.jsx';
  export { default as RunPanel, runSummary } from './ui/coverage/RunPanel.jsx';
  export { CoverageTopUp } from './ui/coverage/CoverageTopUp.jsx';
  export { default as CoverageStrength } from './ui/coverage/CoverageStrength.jsx';
  export * as copy from './ui/coverage/copy.js';
  export { jobRunLine } from './ui/coverage/run-job.js';
  export * as form from './ui/generate-form.js';
  export { draftWork, draftWorkLabel } from './ui/draft-shortfall.js';
  export { taskSummary } from './ui/tasks/task-summary.js';
  export { freshGeneration } from './ui/generation-status.js';
  export { jobContract } from './lib/job-contract.js';
  export { draftRunFacts, runFacts, roundList } from './lib/coverage-run.js';
  export { setUiLanguage } from './ui/i18n.js';
`);
const han = /[㐀-鿿]/;
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();
const inLanguage = (language, run) => { m.setUiLanguage(language); try { return run(); } finally { m.setUiLanguage('zh'); } };
const at = seconds => new Date(Date.UTC(2026, 9, 5, 10, 0, seconds)).toISOString();
const render = (element, { language = 'zh', data = {} } = {}) => inLanguage(language, () => renderToStaticMarkup(inApp(m, element, { data, app: { lib: { taskFocus: null }, host: {} } })));

/* A run of 12 rounds, the 3rd being made: what the job's own copy of it (job.coverageRun) holds. */
const list = (statuses, extra = {}) => statuses.map((status, index) => ({ round: index + 1, questions: 24, status, fill: false, sections: 6,
  ...(status === 'done' ? { kept: 24, covered: 6, tokens: 400_000, ms: 600_000 } : {}), ...(extra[index] || {}) }));
const control = (auto = true) => ({ values: { concurrency: 4, autoComplete: auto, paused: false }, limits: { concurrency: { type: 'int', min: 1, max: 8 }, autoComplete: { type: 'bool' }, paused: { type: 'bool' } } });
const job = (over = {}, run = {}) => ({ id: 'run-1', status: 'running', deckTitle: 'Platform lectures', draftId: 'd1', kind: 'quiz', count: 24, requestedTotal: 288, savedCount: 48, parts: 2, steps: [], startedAt: at(0),
  control: control(), coveragePlan: { level: 'standard', goal: 288, round: 3, rounds: 12 },
  coverageRun: { autoComplete: true, state: 'running', percent: 31, tokensUsed: 1_200_000, startedAt: at(0), list: list(['done', 'done', 'running', ...Array(9).fill('pending')]), ...run }, ...over });
const spec = (statuses, over = {}) => ({ version: 1, level: 'standard', goal: 288, leaves: 81, mustCover: 81, weightSource: 'model', weights: [], quotas: [],
  rounds: statuses.map((status, index) => ({ round: index + 1, questions: 24, sectionIds: [`s#a${index}`, `s#b${index}`], ...(status ? { status } : {}), ...(status === 'done' ? { kept: 24, covered: 2, tokens: 400_000, ms: 600_000 } : {}) })), ...over });
const draft = (statuses = ['done'], marker, over = {}) => ({ id: 'd1', title: 'Platform lectures', draftVersion: 3, cards: [{ id: 'c1' }], editorial: { requested: 24, generation: { sourceIds: ['s'] }, coverageSpec: spec(statuses), ...(marker ? { coverageRun: marker } : {}) }, ...over });

test('the line of a run: the round, the coverage, what it used and what is left, said once for every screen (zh and en)', () => {
  const facts = m.runFacts({ rounds: m.roundList({ rounds: list(['done', 'done', 'running', ...Array(9).fill('pending')]) }), run: { autoComplete: true, state: 'running', tokensUsed: 1_200_000 }, percent: 31 });
  assert.equal(m.copy.runLine(facts), '第 3/12 轮 · 覆盖 31% · 已用 1.2M tok · 预计还要 4M tok、约 1 小时 40 分钟', 'the projection is the rounds done (about 16 700 tokens and 25 seconds per planned question) over the 240 questions still to make');
  inLanguage('en', () => assert.equal(m.copy.runLine(facts), 'Round 3/12 · Covered 31% · 1.2M tok used · About 4M tok and 1 h 40 min to go'));
  const first = m.runFacts({ rounds: m.roundList({ rounds: list(['running', ...Array(11).fill('pending')]) }), run: { autoComplete: true, state: 'running', estimate: { tokens: { low: 2_000_000, high: 4_000_000 } } }, percent: 0 });
  assert.equal(m.copy.runLine(first), '第 1/12 轮 · 覆盖 0% · 预计还要约 3M tok（出题前的估算）', 'no history yet: the estimator\'s number, labelled');
  const paused = m.runFacts({ rounds: m.roundList({ rounds: list(['done', 'pending', 'pending']) }), run: { autoComplete: true, state: 'paused', tokensUsed: 400_000 }, percent: 9 });
  assert.match(m.copy.runLine(paused), /^暂停于第 1 轮之后 · 覆盖 9% · 已用 400K tok/);
  const waiting = m.runFacts({ rounds: m.roundList({ rounds: list(['done', ...Array(11).fill('pending')]) }), run: { autoComplete: false, state: 'waiting' }, percent: 9 });
  assert.equal(m.copy.runLine(waiting), '第 1 轮完成，还有 11 轮 · 覆盖 9% · 已用 400K tok', 'with no total on the marker, what the rounds say they cost');
  inLanguage('en', () => assert.equal(m.copy.runLine(waiting), 'Round 1 is done, 11 more to go · Covered 9% · 400K tok used'));
  const done = m.runFacts({ rounds: m.roundList({ rounds: list(['done', 'done', 'done']) }), run: { state: 'complete', tokensUsed: 1_300_000 }, percent: 100 });
  assert.equal(m.copy.runLine(done), '共 3 轮 · 覆盖 100% · 共用 1.3M tok');
  assert.equal(m.copy.runLine(m.runFacts({ rounds: m.roundList({ rounds: list(['done', 'failed', 'pending']) }), run: { state: 'stopped' }, percent: 12 })), '停在第 1 轮之后 · 覆盖 12% · 共用 400K tok');
  assert.equal(m.copy.runLine(facts, { interrupted: true }), '中断于第 3 轮 · 覆盖 31% · 已用 1.2M tok · 接着做会从第 3 轮继续');
  assert.equal(m.copy.runLine(null), '');
});

test('every reason a run stops has plain words, in both languages', () => {
  const reasons = { complete: /每个小节都有题了/, target: /目标/, learner: /你在第 4 轮停了下来/, budget: /花费上限.*第 4 轮之后停下/, 'no-progress': /第 4 轮重试后仍没有补到新的小节/, 'sections-left': /还有 3 个小节没出成题/, refused: /密钥无效或没有权限/, 'round-failed': /第 4 轮出错/ };
  for (const [reason, pattern] of Object.entries(reasons)) {
    const stop = { reason, round: 4, left: 3, detail: 'the model said no' };
    assert.match(m.copy.stopText(stop), pattern, reason);
    inLanguage('en', () => assert.doesNotMatch(m.copy.stopText(stop), han, reason));
  }
  // A failure is said by its CODE in plain words; the provider's own English is never printed (D-5).
  assert.match(m.copy.stopText({ reason: 'no-progress', round: 2, code: 'plan-short' }), /原因：模型给出的考点不够数/, 'a failure says what it was');
  assert.doesNotMatch(m.copy.stopText({ reason: 'no-progress', round: 2, detail: 'plan is short' }), /plan is short/, 'a text nothing recognises is not printed');
  assert.match(m.copy.stopText({ reason: 'no-progress', round: 2, left: 18 }), /还有 18 个小节没有题，可以点「为没覆盖的部分补题」再试/, 'the stop says how many are left and what to do');
  assert.equal(m.copy.stopText({ reason: 'refused', round: 2, code: 'credential', detail: 'Part 1: 401 Unauthorized: Invalid API key; Part 2: 401 Unauthorized' }), '模型服务拒绝了请求（密钥无效或没有权限），已经停下；已通过的题都保留。', 'ONE sentence, once, not per part');
  assert.match(m.copy.stopText({ reason: 'refused', round: 2, code: 'quota' }), /余额或额度不足/);
  assert.equal(m.copy.stopText(null), '');
  assert.equal(m.copy.stopText({ reason: 'weird' }), '');
});

test('the console header of a running run: the line, 暂停, 停在这里 (everything kept), the toggle, and the rounds with their states', () => {
  const data = { jobs: [job()], drafts: [draft(['done', 'done', 'running', ...Array(9).fill('pending')])], decks: [] };
  for (const language of ['zh', 'en']) {
    const html = render(React.createElement(m.TaskConsole, { data, openers: { resultOf: () => null } }), { language });
    const plain = text(html);
    if (language === 'zh') {
      assert.match(plain, /第 3\/12 轮 · 覆盖 31% · 已用 1\.2M tok · 预计还要/);
      assert.match(html, /data-run-line/);
      assert.match(plain, /暂停/);
      assert.match(html, /停在这里/);
      assert.match(html, /title="已通过的题都保留"/);
      assert.match(html, /data-run-auto/);
      assert.match(plain, /自动补到完整/);
      assert.doesNotMatch(plain, /接着做/, 'nothing to continue while it runs');
      assert.match(plain, /第 3\/12 轮/, 'the list row says the round too');
    } else {
      assert.match(plain, /Round 3\/12 · Covered 31% · 1\.2M tok used · About/);
      assert.match(plain, /Stop here/);
      assert.match(plain, /Finish automatically/);
      assert.doesNotMatch(plain.replace(/平台|Platform lectures/g, ''), han, plain.match(/.{0,30}[㐀-鿿].{0,30}/)?.[0]);
    }
  }
});

test('the rounds tab: a row per round with its state and what it did, the parts below belong to the round in flight', () => {
  const contract = m.jobContract(job());
  const parts = render(React.createElement(m.GenerationParts, { contract: { ...contract, detail: { ...contract.detail, draftId: 'd1' } }, task: job() }), { data: { drafts: [draft()] } });
  const rows = [...parts.matchAll(/<li data-round="(\d+)" data-status="(\w+)">([\s\S]*?)<\/li>/g)];
  assert.equal(rows.length, 12);
  assert.deepEqual(rows.slice(0, 4).map(row => [row[1], row[2]]), [['1', 'done'], ['2', 'done'], ['3', 'running'], ['4', 'pending']]);
  const first = text(rows[0][3]);
  assert.match(first, /第 1 轮 · 24 题 · 6 个小节/);
  assert.match(first, /保留 24 题，新覆盖 6 个小节 · 400K tok · 10 分钟/);
  assert.match(first, /已完成/);
  assert.match(text(rows[2][3]), /第 3 轮 · 24 题 · 6 个小节.*进行中/);
  assert.match(text(rows[3][3]), /待做/);
  assert.match(text(parts), /第 3 轮的批次/);
  assert.match(text(parts), /2\/12 轮已完成/);
  const english = render(React.createElement(m.GenerationParts, { contract, task: job() }), { language: 'en', data: { drafts: [draft()] } });
  assert.match(text(english), /Round 1 · 24 questions · 6 sections/);
  assert.match(text(english), /Kept 24 questions, 6 sections newly covered/);
  assert.match(text(english), /2\/12 rounds done/);
});

test('paused: 暂停于第 2 轮之后 and 继续; pausing says what it waits for; a manual run says why it cannot pause', () => {
  const paused = job({ status: 'running', paused: true, pausedAt: at(900), control: { ...control(), values: { ...control().values, paused: true } } }, { state: 'paused', list: list(['done', 'done', 'pending', ...Array(9).fill('pending')]) });
  const html = render(React.createElement(m.TaskConsole, { data: { jobs: [paused], drafts: [], decks: [] }, openers: { resultOf: () => null } }));
  assert.match(text(html), /暂停于第 2 轮之后 · 覆盖 31%/);
  assert.match(html, />继续</);
  assert.doesNotMatch(html, />暂停</, 'it is paused: the button is 继续');
  assert.match(text(html), /已暂停/);
  const pausing = job({ status: 'running', paused: true, control: { ...control(), values: { ...control().values, paused: true } } });
  assert.match(text(render(React.createElement(m.TaskConsole, { data: { jobs: [pausing], drafts: [], decks: [] }, openers: { resultOf: () => null } }))), /正在暂停 · 第 3 轮做完后停下/);
  const manual = job({ control: control(false) }, { autoComplete: false });
  assert.match(text(render(React.createElement(m.TaskConsole, { data: { jobs: [manual], drafts: [], decks: [] }, openers: { resultOf: () => null } }))), /这次只做一轮，做完就停；勾选「自动补到完整」后，轮与轮之间才可以暂停。/);
  inLanguage('en', () => assert.match(text(render(React.createElement(m.TaskConsole, { data: { jobs: [paused], drafts: [], decks: [] }, openers: { resultOf: () => null } }), { language: 'en' })), /Paused after round 2 · Covered 31%/));
});

test('an interrupted run: 接着做 says which round it continues, the line says where it broke, and the log says the round is run again', () => {
  const broken = job({ status: 'interrupted', retryable: true, stage: 'The last run was interrupted before round 3', finishedAt: at(2000), control: undefined,
    events: [{ id: 'e1', at: at(2000), level: 'error', tag: null, code: 'run-interrupted', args: { round: 3, rounds: 12, inflight: 3 } }] }, { list: list(['done', 'done', ...Array(10).fill('pending')]) });
  const html = render(React.createElement(m.TaskConsole, { data: { jobs: [broken], drafts: [], decks: [] }, openers: { resultOf: () => null } }));
  assert.match(text(html), /中断于第 3 轮 · 覆盖 31% · 已用 1\.2M tok · 接着做会从第 3 轮继续/);
  assert.match(html, /接着做/);
  assert.match(html, /title="继续第 3 轮：已通过的题都保留，这一轮从头重做"/);
  assert.match(text(html), /中断于第 3 轮 · 点「接着做」继续/, 'the list row');
  const log = render(React.createElement(m.LogPanel, { contract: m.jobContract(broken) }));
  assert.match(text(log), /上次运行在第 3 轮被中断；接着做会从第 3 轮重新开始，已通过的题保留/);
  const rerun = m.jobContract({ ...broken, events: [{ id: 'e2', at: at(2100), level: 'warn', tag: null, code: 'round-rerun', args: { round: 3, rounds: 12 } }, { id: 'e3', at: at(2101), level: 'step', tag: null, code: 'round-start', args: { round: 3, rounds: 12, sections: 6, questions: 24, fill: false } }] });
  assert.match(text(render(React.createElement(m.LogPanel, { contract: rerun }))), /第 3 轮上次没有做完，这次从头重做/);
  inLanguage('en', () => assert.match(text(render(React.createElement(m.LogPanel, { contract: rerun }), { language: 'en' })), /Round 3 was not finished last time, so it starts again from the beginning/));
});

test('the log: one line per round boundary and one for the reason a run stops, in both languages', () => {
  const events = [
    { id: '1', at: at(1), level: 'step', code: 'round-start', args: { round: 1, rounds: 3, sections: 4, questions: 8, fill: false } },
    { id: '2', at: at(2), level: 'done', code: 'round-end', args: { round: 1, rounds: 3, status: 'done', kept: 8, covered: 4, percent: 33 } },
    { id: '3', at: at(3), level: 'info', code: 'run-paused', args: { after: 1 } },
    { id: '4', at: at(4), level: 'info', code: 'run-resumed', args: { next: 2 } },
    { id: '5', at: at(5), level: 'warn', code: 'round-end', args: { round: 2, rounds: 3, status: 'failed', kept: 0, covered: 0, percent: 33, reason: 'timeout' } },
    { id: '6', at: at(6), level: 'warn', code: 'run-stop', args: { reason: 'no-progress', round: 2, detail: 'plan is short' } },
    { id: '7', at: at(7), level: 'done', code: 'run-waiting', args: { round: 1, rounds: 3, left: 2 } }];
  const contract = m.jobContract({ id: 'x', status: 'complete', startedAt: at(0), events });
  const zh = text(render(React.createElement(m.LogPanel, { contract })));
  for (const line of ['第 1/3 轮开始 · 4 个小节，8 题', '第 1/3 轮完成：保留 8 题，新覆盖 4 个小节 · 覆盖 33%', '暂停于第 1 轮之后：不再开始新的一轮', '继续：开始第 2 轮', '第 2/3 轮没做成：保留 0 题，新覆盖 0 个小节 · 原因：这一轮用时到限',
    '第 2 轮重试后仍没有补到新的小节，为免一直重复，已经停下。', '第 1 轮完成，还有 2 轮：点「为没覆盖的部分补题」继续']) assert.ok(zh.includes(line), line);
  const en = text(render(React.createElement(m.LogPanel, { contract }), { language: 'en' }));
  for (const line of ['Round 1/3 started · 4 sections, 8 questions', 'Round 1/3 done: kept 8 questions, 4 sections newly covered · Covered 33%', 'Paused after round 1: no new round starts', 'Resumed: round 2 starts',
    'Round 2/3 did not work: kept 0 questions, 0 sections newly covered · Reason: This round reached its time limit']) assert.ok(en.includes(line), line);
});

test('the draft page: where the run is, why it stopped, the choice 自动补到完整 and the one button; the same facts as the console', () => {
  const view = { status: 'ok', canTopUp: true, coverage: { percentLeaves: 9, leaves: 81, covered: 7, units: 'part', plannedFailed: 0, neverPlanned: 74, recorded: true }, round: { sections: 6, questions: 24, picks: [], plannedFailed: 0, neverPlanned: 6, left: 0, rounds: 1, limit: 30 } };
  const waiting = draft(['done', 'pending', 'pending'], { jobId: 'run-1', autoComplete: false, state: 'waiting', tokensUsed: 400_000, startedAt: at(0), updatedAt: at(100) });
  let html = render(React.createElement(m.RunPanel, { draft: waiting, view, jobs: [] }));
  assert.match(text(html), /第 1 轮完成，还有 2 轮 · 覆盖 9% · 已用 400K tok/);
  assert.match(html, /data-run-auto/);
  assert.match(text(html), /勾选后，剩下的 2 轮会一轮接一轮自动补完/);
  assert.doesNotMatch(html, /checked/, 'a run that waits is not going on by itself');
  const stopped = draft(['done', 'failed', 'pending'], { jobId: 'run-1', autoComplete: true, state: 'stopped', tokensUsed: 900_000, startedAt: at(0), updatedAt: at(100), stop: { reason: 'budget', round: 2 } });
  html = render(React.createElement(m.RunPanel, { draft: stopped, view, jobs: [] }));
  assert.match(text(html), /停在第 1 轮之后 · 覆盖 9%/);
  assert.match(text(html), /用到了你设的花费上限，在第 2 轮之后停下；已通过的题都保留。/);
  const live = job({ draftId: 'd1' });
  html = render(React.createElement(m.RunPanel, { draft: draft(['done', 'done', 'running', ...Array(9).fill('pending')], { jobId: 'run-1', autoComplete: true, state: 'running' }), view, jobs: [live] }));
  assert.match(html, /data-run-auto/);
  assert.match(html, /checked/, 'running by itself: the box is ticked, and flipping it goes to the job');
  assert.doesNotMatch(text(html), /勾选后/);
  const status = render(React.createElement(m.CoverageTopUp, { draft: draft(['done', 'done', 'running']), view, jobs: [live] }));
  // The line is the console's (round, tokens, estimate); the coverage in it is the page's own bar (the view's 9%), not the job's copy (31%, refreshed only every few seconds): two numbers on one screen never differ.
  assert.match(text(status), /第 3\/12 轮 · 覆盖 9% · 已用 1\.2M tok/, 'while it runs the status is the console\'s line');
  const done = draft(['done', 'done', 'done'], { jobId: 'run-1', autoComplete: true, state: 'complete', tokensUsed: 1_300_000, startedAt: at(0), updatedAt: at(100), stop: { reason: 'complete', round: 3 } });
  html = render(React.createElement(m.RunPanel, { draft: done, view, jobs: [] }));
  assert.match(text(html), /共 3 轮 · 覆盖 9% · 共用 1\.3M tok/);
  assert.doesNotMatch(html, /data-run-auto/, 'nothing left to run: no choice');
  assert.equal(render(React.createElement(m.RunPanel, { draft: { ...waiting, editorial: { ...waiting.editorial, coverageSpec: undefined } }, view, jobs: [] })), '', 'a draft without a plan has no run');
  inLanguage('en', () => {
    const english = render(React.createElement(m.RunPanel, { draft: waiting, view, jobs: [] }), { language: 'en' });
    assert.match(text(english), /Round 1 is done, 2 more to go · Covered 9% · 400K tok used/);
    assert.match(text(english), /Finish automatically/);
    assert.doesNotMatch(text(english), han);
  });
});

test('the home row and the work status say the same: runSummary and the label of a draft that is being filled', () => {
  const waiting = draft(['done', 'pending', 'pending'], { jobId: 'run-1', autoComplete: false, state: 'waiting', tokensUsed: 0, startedAt: at(0), updatedAt: at(1) });
  assert.equal(m.runSummary(waiting, [], 9).line, '第 1 轮完成，还有 2 轮 · 覆盖 9% · 已用 400K tok');
  assert.equal(m.runSummary({ ...waiting, editorial: { ...waiting.editorial, coverageSpec: undefined } }, [], 9), null);
  const live = job();
  assert.equal(m.runSummary(draft(), [live], 31).line, m.jobRunLine(live), 'a draft being filled says what its job says');
  const label = m.draftWorkLabel(m.draftWork(draft(), [live]), draft());
  assert.equal(label, m.jobRunLine(live));
  assert.match(label, /^第 3\/12 轮 · 覆盖 31%/);
  // The coverage bar of the page is the newer word: the job's own copy of the percent is refreshed only every few seconds, and the two numbers on one screen must not differ.
  assert.match(m.draftWorkLabel(m.draftWork(draft(), [live]), draft(), 37), /^第 3\/12 轮 · 覆盖 37%/);
  assert.equal(m.runSummary(draft(), [live], 37).line.slice(0, 20), m.draftWorkLabel(m.draftWork(draft(), [live]), draft(), 37).slice(0, 20));
  const plain = { id: 'p', status: 'running', draftId: 'd1', continued: true, savedCount: 5, requestedTotal: 10 };
  assert.equal(m.draftWorkLabel(m.draftWork(draft(), [plain]), draft()), '补题中 · 草稿 5/10 题', 'a job of one round keeps its words');
  const legacy = m.draftRunFacts({ ...draft(), editorial: { ...draft().editorial, coverageSpec: spec([undefined, undefined, undefined]) } }, { percent: 9 });
  assert.equal(legacy.done, 1, 'a plan from before round states: the first round was made');
  assert.equal(legacy.left, 2);
  assert.equal(m.draftRunFacts({ id: 'x', cards: [], editorial: {} }), null);
});

test('the creation form: 自动补到完整 follows the level until it is touched, says what it means in rounds, and the spending limit is optional', () => {
  assert.deepEqual(['lean', 'standard', 'full'].map(level => m.form.autoOf({ coverageLevel: level })), [false, true, true]);
  assert.equal(m.form.autoOf({ coverageLevel: 'lean', autoComplete: true }), true, 'what the learner ticked wins');
  assert.equal(m.form.autoOf({ coverageLevel: 'full', autoComplete: false }), false);
  const request = (gen) => m.form.generationRequest({ kind: 'quiz', notation: 'auto', focus: '', difficulty: 'mixed', language: '中文', role: '', customCount: '', ...gen }, { course: 'C', sourceIds: ['s'] });
  assert.equal(request({ coverageLevel: 'standard' }).autoComplete, true);
  assert.equal(request({ coverageLevel: 'lean' }).autoComplete, false);
  assert.equal(request({ coverageLevel: 'lean', autoComplete: true }).autoComplete, true);
  assert.equal(request({ coverageLevel: 'standard', tokenBudget: '2.5M' }).tokenBudget, 2_500_000);
  assert.equal('tokenBudget' in request({ coverageLevel: 'standard', tokenBudget: '' }), false);
  assert.equal('tokenBudget' in request({ coverageLevel: 'standard', tokenBudget: 'lots' }), false, 'a number nobody understood is no limit');
  const fresh = m.freshGeneration({ autoComplete: false, tokenBudget: '1M', customCount: '40', coverageLevel: 'full' });
  assert.equal(fresh.autoComplete, undefined);
  assert.equal(fresh.tokenBudget, '');
  const coverage = { level: 'standard', goal: 251, sections: 81, leaves: 81, units: 'part', rounds: 9, firstRound: 28, levels: {} };
  const state = { status: 'ready', estimate: { coverage, totalTokens: { low: 1_700_000, high: 2_500_000 }, calls: { low: 205, high: 667 }, inputTokens: { low: 1, high: 2 }, outputTokens: { low: 1, high: 2 }, stages: [] } };
  const props = { level: 'standard', customCount: '', state, stats: { materials: 1, pages: 0, chars: 400000 }, onLevel() {}, onCustom() {}, onAuto() {}, onBudget() {} };
  let html = render(React.createElement(m.CoverageStrength, { ...props, auto: true, budget: '' }));
  assert.match(html, /data-coverage-auto[^>]*data-auto="on"/);
  assert.match(text(html), /自动补到完整 先出第 1 轮，剩下的 8 轮一轮接一轮自动做完；可以随时暂停，或停在这里（已出的题都保留）。/);
  assert.match(text(html), /花费上限 可选/);
  html = render(React.createElement(m.CoverageStrength, { ...props, auto: false, budget: '2M' }));
  assert.match(html, /data-auto="off"/);
  assert.match(text(html), /只出第 1 轮；其余 8 轮在草稿页点「为没覆盖的部分补题」，一次补一轮。/);
  assert.match(text(html), /花费上限 2M tok/);
  assert.match(html, /<details[^>]*cov-strength__budget[^>]*\sopen/, 'a typed limit keeps the disclosure open');
  html = render(React.createElement(m.CoverageStrength, { ...props, auto: true, budget: 'lots' }));
  assert.match(html, /aria-invalid="true"/);
  assert.match(text(html), /没看懂这个数：请写成 800K、2\.5M 或 1200000/);
  inLanguage('en', () => {
    const english = render(React.createElement(m.CoverageStrength, { ...props, auto: true, budget: '' }), { language: 'en' });
    assert.match(text(english), /Finish automatically Round 1 first, then the other 8 rounds one after another by themselves/);
    assert.match(text(english), /Spending limit Optional/);
    assert.doesNotMatch(text(english), han, text(english).match(/.{0,30}[㐀-鿿].{0,30}/)?.[0]);
  });
  assert.doesNotMatch(render(React.createElement(m.CoverageStrength, { ...props, state: { status: 'idle' }, auto: true, onAuto: undefined })), /data-coverage-auto/, 'a form that offers no choice draws none');
});

test('a run that stopped before its plan was met is partial in the list and the header, however many questions it wrote; one that met its plan is done', () => {
  const stopped = job({ status: 'complete', savedCount: 298, requestedTotal: 251, finishedAt: at(3000), control: undefined }, { state: 'stopped', stop: { reason: 'sections-left', round: 5, left: 2 }, list: list(['done', 'done', 'done', 'done', 'done']) });
  assert.equal(m.jobContract(stopped).result.completeness, 'partial');
  assert.equal(m.taskSummary(stopped).state, 'partial');
  const met = job({ status: 'complete', savedCount: 251, requestedTotal: 251, finishedAt: at(3000), control: undefined }, { state: 'complete', stop: { reason: 'complete', round: 3 }, list: list(['done', 'done', 'done']) });
  assert.equal(m.jobContract(met).result.completeness, 'complete');
  assert.equal(m.taskSummary(met).state, 'done');
  const html = render(React.createElement(m.TaskConsole, { data: { jobs: [stopped], drafts: [], decks: [] }, openers: { resultOf: () => null } }));
  assert.match(text(html), /停在第 5 轮之后 · 覆盖 31%/);
  assert.match(text(html), /重试了几轮，还有 2 个小节没出成题，已经停下。/);
  assert.match(text(html), /部分完成/);
});
