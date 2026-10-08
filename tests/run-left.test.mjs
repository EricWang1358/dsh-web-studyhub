import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';
import { inFlightDue, roundsDue, runFacts, runForecast, roundList, markRound } from '../lib/coverage-run.js';
import { listOf, mirrorOf } from '../lib/contexts/generation/coverage-runs.js';
import { jobContract } from '../lib/job-contract.js';

/* What is LEFT of a coverage run, said once (the owner's screen of 2026-10-08, 「这个预估是不是不太准」): a top-up of a draft that was 99% covered said 「还要 1 轮、约 30 题」, 「题数 · 本任务 1 / 约 30」 and
   「预计还要约 3.1M tok」 for a round whose planner had returned 3 points, and 「已用 5M tok」 beside 「已用 210K」 and a usage panel of 212,255. The questions left are the sections that still have no
   question and, for the round in flight, the points its planner returned; 已用 is the job's own count on a job's screen. Pure rules (lib/coverage-run.js), the live copy (coverage-runs.js), the
   contract, and the words of the 任务 console (ui/coverage/copy.js, ui/tasks). The executor path is tests/run-left-exec.test.mjs. */

const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as RunLine } from './ui/tasks/RunLine.jsx';
  export { taskFacts, forecastOf } from './ui/tasks/task-facts.js';
  export { goalLines } from './ui/tasks/plan-table.js';
  export { jobRunLine } from './ui/coverage/run-job.js';
  export * as copy from './ui/coverage/copy.js';
  export { setUiLanguage } from './ui/i18n.js';
`);
const inLanguage = (language, run) => { m.setUiLanguage(language); try { return run(); } finally { m.setUiLanguage('zh'); } };
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();

/* ---------- the round in flight ---------- */

test('the round in flight: what it was asked until its planner answers, then the points it returned that are not decided yet', () => {
  assert.deepEqual(inFlightDue({ asked: 3 }), { asked: 3, left: 3 }, 'before the plan: what it was asked for');
  const points = (...states) => states.map((state, index) => ({ id: `t${index}`, part: 1, round: 1, objective: 'x', state }));
  assert.deepEqual(inFlightDue({ asked: 3, points: points('kept', 'planned', 'planned'), kept: 1 }), { asked: 3, left: 2 }, 'the owner\'s screen: 3 points, 1 passed, 2 being written');
  assert.deepEqual(inFlightDue({ asked: 3, points: points('kept', 'failed', 'omitted'), kept: 1 }), { asked: 3, left: 0 }, 'a point that failed or was dropped is decided: nothing more comes of it in this round');
  assert.deepEqual(inFlightDue({ asked: 3, points: points('planned', 'planned'), short: [{ part: 2, round: 1, needed: 2, got: 1 }] }), { asked: 2, left: 2 }, 'a plan that came back short: the round makes what it returned');
  assert.deepEqual(inFlightDue({ asked: 10, points: points('planned', 'planned', 'planned', 'planned', 'planned') }), { asked: 10, left: 10 }, 'one group has answered, the other not yet: its five are still what was asked');
  assert.deepEqual(inFlightDue({ asked: 2, kept: 5 }), { asked: 2, left: 0 }, 'never below zero');
  assert.deepEqual(inFlightDue({ asked: NaN, points: [null, {}], short: [null, { needed: 'x' }], kept: -3 }), { asked: 0, left: 0 }, 'junk says nothing');
});

/* ---------- the rounds not run yet ---------- */

const quotas = (entries) => Object.entries(entries).map(([sectionId, quota]) => ({ sectionId, quota, reason: 'share' }));
const plan = (rounds, q) => ({ version: 1, goal: 51, quotas: quotas(q), rounds });

test('a round not run yet still has to make the quotas of its sections that have no question, never what it was planned for when the plan was made', () => {
  const spec = plan([
    { round: 1, questions: 4, sectionIds: ['a', 'b'], status: 'done' },
    { round: 2, questions: 30, sectionIds: ['c', 'd', 'e', 'f'], status: 'running' },
    { round: 3, questions: 5, sectionIds: ['g', 'h', 'i'] },
    { round: 4, questions: 4, sectionIds: ['j', 'k'] },
    { round: 5, questions: 3, sectionIds: ['l'], status: 'failed' },
  ], { a: 2, b: 2, c: 9, d: 9, e: 9, f: 3, g: 2, h: 2, i: 1, j: 2, k: 2, l: 3 });
  const uncovered = new Set(['f', 'h', 'l']);
  assert.deepEqual(roundsDue(spec, { uncovered, running: { asked: 3, left: 2 } }), [0, 2, 2, 0, 0], 'round 2 in flight: 2 to come; round 3: only h; round 4: all covered (skipped); done and failed rounds: 0');
  assert.deepEqual(roundsDue(spec, { uncovered }), [0, 30, 2, 0, 0], 'without what the round in flight knows: what it was asked for');
  assert.deepEqual(roundsDue(spec), [0, 30, 5, 4, 0], 'nothing known of the sections: what each round was planned for');
  assert.deepEqual(roundsDue(spec, { uncovered: new Set(['g', 'h', 'i']), asked: ['h'] }), [0, 30, 3, 0, 0], 'a section a job that starts is already asked for is not counted again');
  // A fill round in flight that writes a section of a later round again: that section is not owed twice.
  const fill = plan([{ round: 1, questions: 6, sectionIds: ['a', 'b'] }, { round: 2, questions: 2, sectionIds: ['a'], fill: true, status: 'running' }], { a: 2, b: 4 });
  assert.deepEqual(roundsDue(fill, { uncovered: new Set(['a', 'b']), running: { asked: 2, left: 2 } }), [4, 2]);
  assert.deepEqual(roundsDue(plan([{ round: 1, questions: 2, sectionIds: ['x', 'y', 'z'] }], { x: 5 }), { uncovered: new Set(['x', 'y', 'z']) }), [2], 'never more than the round was planned for');
});

test('a round that starts says what it is asked for now; the plan\'s other numbers stay', () => {
  const spec = plan([{ round: 1, questions: 30, sectionIds: ['a', 'b'], status: 'failed' }], { a: 2, b: 1 });
  const marked = markRound(spec, 0, 'running', { at: 'now', questions: 1 });
  assert.deepEqual(marked.rounds[0], { round: 1, questions: 1, sectionIds: ['a', 'b'], status: 'running', startedAt: 'now' });
  assert.equal(markRound(spec, 0, 'running', { at: 'now' }).rounds[0].questions, 30, 'nothing said: the number stays');
  assert.equal(markRound(spec, 0, 'running', { at: 'now', questions: -1 }).rounds[0].questions, 30);
});

/* ---------- the facts of a run, and its live copy ---------- */

const usage = (total) => ({ uncachedInputTokens: Math.round(total * 0.9), outputTokens: total - Math.round(total * 0.9), calls: 9 });
/** The owner's draft as the executor now copies it: a top-up of round 1 (planned for 30 questions, the job asks for 3), rounds 2-4 done by the earlier job (4.8M tokens). */
const ownerSpec = () => plan([
  { round: 1, questions: 30, sectionIds: ['s1', 's2', 's22', 's28'], status: 'failed', kept: 25 },
  { round: 2, questions: 8, sectionIds: ['s3', 's4'], status: 'done', kept: 8, tokens: 800_000, ms: 240_000 },
  { round: 3, questions: 4, sectionIds: ['s1', 's2'], fill: true, status: 'done', kept: 4, tokens: 400_000, ms: 120_000 },
  { round: 4, questions: 4, sectionIds: ['s1'], fill: true, status: 'done', kept: 4, tokens: 400_000, ms: 120_000 },
], { s1: 9, s2: 9, s22: 2, s28: 1, s3: 4, s4: 4 });

test('the facts: questionsLeft is the rounds\' due, the rounds left those that still have something to make, and nothing is projected when nothing is left', () => {
  const running = markRound(ownerSpec(), 0, 'running', { at: 'now', questions: 3 });
  const due = roundsDue(running, { uncovered: new Set(['s22', 's28']), running: { asked: 3, left: 2 } });
  const facts = runFacts({ rounds: listOf(running, due), run: { autoComplete: true, state: 'running', tokensUsed: 4_800_000 }, percent: 99 });
  assert.equal(facts.questionsLeft, 2, 'not the 30 round 1 was planned for');
  assert.equal(facts.roundsLeft, 1);
  assert.equal(facts.dueKnown, true);
  assert.deepEqual(facts.projection, { tokens: 200_000, minutes: 1, basis: 'history' }, 'the rounds done: 1.6M for the 16 questions they were asked, times the 2 left');
  const old = runFacts({ rounds: listOf(running), run: { autoComplete: true, state: 'running' }, percent: 99 });
  assert.equal(old.questionsLeft, 3, 'a copy without `due` (an older host): what the round was asked for');
  assert.equal(old.dueKnown, undefined);
  const settled = runFacts({ rounds: listOf(running, [0, 0, 0, 0]), run: { autoComplete: true, state: 'running', estimate: { tokens: { low: 100, high: 200 } } }, percent: 99 });
  assert.equal(settled.questionsLeft, 0);
  assert.equal(settled.projection, null, 'every point decided: nothing is projected, whatever was priced before the run');
  const pending = plan([{ round: 1, questions: 8, sectionIds: ['a'], status: 'running' }, { round: 2, questions: 8, sectionIds: ['b'] }, { round: 3, questions: 8, sectionIds: ['c'] }], { a: 8, b: 8, c: 8 });
  const skipping = runFacts({ rounds: listOf(pending, roundsDue(pending, { uncovered: new Set(['a', 'c']), running: { asked: 8, left: 8 } })), run: { state: 'running' }, percent: 50 });
  assert.deepEqual([skipping.left, skipping.roundsLeft, skipping.questionsLeft], [3, 2, 16], 'round 2 has every section covered: it will be skipped, so it is not one of the rounds left');
});

test('已用: a job\'s live copy says the job\'s own tokens (the same number as its usage); a draft\'s marker says the run\'s; a job that continues a run that spent tokens says so', () => {
  const spec = markRound(ownerSpec(), 0, 'running', { at: 'now', questions: 3 });
  const marker = { autoComplete: true, state: 'running', startedAt: 'x', tokensUsed: 4_800_000 };
  const copy = mirrorOf(spec, marker, { percent: 99, tokensBase: 4_800_000, due: [2, 0, 0, 0] });
  assert.equal(copy.tokensBase, 4_800_000);
  assert.deepEqual(copy.list.map((round) => round.due), [2, undefined, undefined, undefined], 'only a round that is not done carries what it still has to make');
  const job = { tokenUsage: usage(210_000) };
  const facts = runFacts({ rounds: copy.list, run: copy, percent: 99, job });
  assert.equal(facts.tokensUsed, 210_000, 'not the run\'s 4.8M');
  assert.equal(facts.ownTokens, true);
  assert.equal(runFacts({ rounds: copy.list, run: copy, percent: 99 }).tokensUsed, 0, 'no live count: the copy\'s own (the run\'s count less what it had before the job), not the run\'s');
  assert.equal(runFacts({ rounds: copy.list, run: { ...copy, tokensUsed: 5_000_000 }, percent: 99 }).tokensUsed, 200_000);
  const fresh = mirrorOf(spec, { ...marker, tokensUsed: 0 }, { tokensBase: 0 });
  assert.equal(runFacts({ rounds: fresh.list, run: fresh, job }).ownTokens, undefined, 'a job that began the run: its tokens ARE the run\'s, said as they always were');
  const draftMarker = runFacts({ rounds: roundList(spec), run: marker, percent: 99 });
  assert.equal(draftMarker.tokensUsed, 4_800_000, 'the draft\'s own line: the run\'s tokens');
  assert.equal(draftMarker.ownTokens, undefined);
  const restored = mirrorOf(spec, marker, { draftId: 'd1' });
  assert.equal(runFacts({ rounds: restored.list, run: restored, job: { status: 'interrupted' } }).tokensUsed, 4_800_000, 'a record rebuilt from the draft after a restart has no tokens of its own: the run\'s');
});

/* ---------- the forecast ---------- */

test('the forecast counts the questions that are left (runFacts\'), not the goal less what the draft holds; its share is measured against what this job makes plus what is left', () => {
  const owner = runForecast({ phase: 'running', projection: { tokens: 200_000, minutes: 1, basis: 'history' }, estimate: 400_000, tokens: 210_000, kept: 37, goal: 39, base: 36, elapsedMs: 4 * 60_000, left: 2 });
  assert.equal(owner.basis, 'history', 'one question of its own is not a pace');
  assert.deepEqual(owner.tokens, { used: 210_000, left: 200_000, total: 410_000 });
  assert.equal(owner.preRun, null);
  // 9 made of its own, 3 left: 75% of the work it has: a pace (210K / 9 a question, 3 left = 70K)
  const pace = runForecast({ phase: 'running', estimate: 400_000, tokens: 210_000, kept: 45, goal: 80, base: 36, elapsedMs: 10 * 60_000, left: 3 });
  assert.equal(pace.basis, 'live');
  assert.deepEqual(pace.tokens, { used: 210_000, left: 70_000, total: 280_000 }, 'not the 35 questions goal less kept would say');
  const done = runForecast({ phase: 'running', estimate: 400_000, tokens: 210_000, kept: 45, goal: 80, base: 36, elapsedMs: 10 * 60_000, left: 0 });
  assert.equal(done.tokens, null, 'nothing left: nothing to add');
  assert.equal(done.time.state, 'finishing');
  assert.deepEqual(runForecast({ phase: 'running', estimate: 400_000, tokens: 0, kept: 0, goal: 77, base: 0 }).tokens, { used: 0, left: 400_000, total: 400_000 }, 'without `left`: as it always was');
});

/* ---------- the 任务 console of the owner's job ---------- */

const T0 = Date.UTC(2026, 9, 8, 9, 0, 0), MIN = 60_000;
const at = (minutes) => new Date(T0 + minutes * MIN).toISOString();
/** The owner's top-up as the executor now records it: the draft held 36 questions, the plan's goal is 38, the job asked for 3 (sections 22 and 28), its planner returned 3 points, 1 has passed. */
function ownerJob(over = {}) {
  const spec = markRound(ownerSpec(), 0, 'running', { at: at(0), questions: 3 });
  const coverageRun = mirrorOf(spec, { autoComplete: true, state: 'running', startedAt: at(0), tokensUsed: 4_800_000, estimate: { tokens: { low: 340_000, high: 460_000 } } },
    { percent: 99, tokensBase: 4_800_000, due: [2, 0, 0, 0], cover: { leaves: 120, covered: 119, atStart: 118 }, draftId: 'd1' });
  const point = (id, state) => ({ id, part: 1, round: 1, objective: `Point ${id}`, state });
  return { id: 'topup-1', status: 'running', continued: true, draftId: 'd1', deckTitle: 'Lecture.mp3 + 4', kind: 'quiz', count: 3, savedAtStart: 36, savedCount: 37, askedQuestions: 3, requestedTotal: 38,
    parts: 1, steps: [], startedAt: at(0), runStartedAt: at(0), totalTimeoutSeconds: 1200, tokenUsage: usage(212_255),
    control: { values: { concurrency: 4, autoComplete: true, paused: false }, limits: {} },
    coveragePlan: { level: 'standard', goal: 38, round: 1, rounds: 4 }, coverageRun, planTargets: { list: [point('t1', 'kept'), point('t2', 'planned'), point('t3', 'planned')] }, ...over };
}
const lineOf = (job, language = 'zh') => inLanguage(language, () => renderToStaticMarkup(inApp(m, React.createElement(m.RunLine, { task: { ...job, contract: jobContract(job) }, now: T0 + 4 * MIN }), { data: {} })));

test('the owner\'s screen, fixed: every number of the console says the same thing, the 2 questions still to come of the 3 points the planner returned', () => {
  const job = ownerJob(), contract = jobContract(job);
  assert.equal(contract.detail.run.questionsLeft, 2);
  assert.equal(contract.detail.run.tokensUsed, contract.usage.tokens, '已用 is the usage panel\'s number');
  assert.deepEqual(contract.detail.own, { made: 1, asked: 3, base: 36 });
  const html = lineOf(job), plain = text(html);
  assert.match(plain, /^出题计划 第 1\/4 轮 · 覆盖 99% · 本任务已用 212K tok · 预计还要约 200K tok（按已跑的进度估算）/, plain);
  assert.doesNotMatch(plain, /出题前估/, 'the job\'s own estimate (400K) agrees with what it used and has left: it is not said twice');
  assert.match(html, /data-run-math[^>]*>本任务已用 212K \+ 还要约 200K ≈ 共约 412K tok</, 'the sum under it says 已用 in the same words and the same figure as the line (212K, not 210K)');
  assert.match(html, /data-coverage-path[^>]*>覆盖现在 99% → 目标 100%，还要 1 轮、约 2 题</);
  const facts = Object.fromEntries(m.taskFacts({ ...job, contract }, T0 + 4 * MIN).map((fact) => [fact.key, fact]));
  assert.deepEqual([facts.primary.label, facts.primary.value, facts.primary.note], ['题数 · 本任务', '1 / 约 3', '草稿共 37 题'], '1 made of the 3 asked: 2 left, as the line says');
  assert.match(facts.calls.value, /212K$/, 'the tile of the model calls: the same tokens');
  const goal = m.goalLines(contract, { kindLabel: '出题' }).find((line) => line.key === 'round').text;
  assert.equal(goal, '第 1/4 轮 · 覆盖现在 99% → 目标 100%，还要 1 轮、约 2 题', '目标与知识点 says the same way');
  assert.equal(m.jobRunLine(job), '第 1/4 轮 · 覆盖 99% · 本任务已用 212K tok · 预计还要 200K tok、约 1 分钟', 'the home row\'s line of the job: the same 已用');
  inLanguage('en', () => {
    const english = text(lineOf(job, 'en'));
    assert.match(english, /212K tok used by this task/);
    assert.match(english, /Coverage now 99% → target 100%, 1 more round, about 2 questions/);
    assert.match(lineOf(job, 'en'), /This task used 212K \+ about 200K to go ≈ about 412K tok in all/);
  });
});

test('the words: a job that continues a run says 「本任务」 for its tokens, ended or running; a draft\'s run and a job that began it say them as before', () => {
  const facts = { total: 4, rounds: 4, round: 1, done: 3, left: 1, roundsLeft: 1, questionsLeft: 2, percent: 99, tokensUsed: 212_255, ownTokens: true, state: 'running', ended: false, waiting: false, projection: null };
  assert.equal(m.copy.runLine(facts), '第 1/4 轮 · 覆盖 99% · 本任务已用 212K tok');
  assert.equal(m.copy.runLine({ ...facts, ended: true, done: 4, state: 'complete' }), '共 4 轮 · 覆盖 99% · 本任务共用 212K tok');
  assert.equal(m.copy.runLine({ ...facts, ownTokens: undefined }), '第 1/4 轮 · 覆盖 99% · 已用 212K tok');
  assert.equal(m.copy.runPathText(facts), '覆盖现在 99% → 目标 100%，还要 1 轮、约 2 题');
  assert.equal(m.copy.runPathText({ ...facts, left: 3, roundsLeft: 1 }), '覆盖现在 99% → 目标 100%，还要 1 轮、约 2 题', 'a round whose sections all have a question is not one of the rounds left');
  assert.equal(m.copy.runPathText({ ...facts, roundsLeft: undefined, left: 2 }), '覆盖现在 99% → 目标 100%，还要 2 轮、约 2 题', 'an older record: the rounds not done');
  const forecast = { basis: 'history', tokens: { used: 210_000, left: 200_000, total: 410_000 }, preRun: null };
  assert.equal(m.copy.forecastMath(forecast), '已用 210K + 还要约 200K ≈ 共约 410K tok');
  assert.equal(m.copy.forecastMath(forecast, { own: true }), '本任务已用 210K + 还要约 200K ≈ 共约 410K tok');
  assert.equal(m.copy.forecastMath(forecast, { own: true, used: 212_255 }), '本任务已用 212K + 还要约 200K ≈ 共约 412K tok', 'the job\'s count as the line says it; the whole is that plus what is left');
  inLanguage('en', () => {
    assert.equal(m.copy.runLine(facts), 'Round 1/4 · Covered 99% · 212K tok used by this task');
    assert.equal(m.copy.runLine({ ...facts, ended: true, done: 4, state: 'complete' }), '4 rounds in all · Covered 99% · 212K tok in all by this task');
  });
});
