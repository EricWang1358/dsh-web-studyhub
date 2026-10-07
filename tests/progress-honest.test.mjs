import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';
import { jobContract } from '../lib/job-contract.js';

/* The progress numbers of a question run (the owner's screenshots of 2026-10-08, 「API 粒度与产品思维 · 第二部分」): the headline is what the run is FOR (the sections that have a question, not the questions
   made), a top-up or continuation counts its OWN work (0% when it starts, never the draft it inherited), nothing is 100% while it runs, and a run that stopped short says its true fraction, not 99.
   The pure rule is lib/job-contract.js progressOf (docs/job-contract.md); the words and the hover explanations are ui/tasks/task-facts.js and ui/tasks/Metrics.jsx. */

const m = await loadUi(`
  export { default as Metrics } from './ui/tasks/Metrics.jsx';
  export { default as CompactJobCard, cardLine } from './ui/tasks/CompactJobCard.jsx';
  export { jobSavedProgress } from './ui/generation-status.js';
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { taskFacts, progressHint, forecastOf } from './ui/tasks/task-facts.js';
  export { taskSummary } from './ui/tasks/task-summary.js';
  export { setUiLanguage } from './ui/i18n.js';
`);
const inLanguage = (language, run) => { m.setUiLanguage(language); try { return run(); } finally { m.setUiLanguage('zh'); } };
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();

const T0 = Date.UTC(2026, 9, 8, 0, 0, 0);
const at = (minutes) => new Date(T0 + minutes * 60_000).toISOString();
const rounds = (statuses, questions = 30) => statuses.map((status, index) => ({ round: index + 1, questions, status, fill: false, sections: 6 }));
const pct = (job) => jobContract(job).progress.percent;
const card = (job) => ({ ...job, contract: jobContract(job) });

/** The first job of the screenshot: five rounds, 86 questions for a plan of 77, 82 of 108 sections have a question, the run stopped with 26 left. */
const stoppedRun = (over = {}, run = {}) => ({ id: 'first', status: 'complete', deckTitle: 'API 粒度', draftId: 'd1', kind: 'quiz', count: 30, requestedTotal: 77, savedCount: 86, parts: 2, steps: [],
  startedAt: at(0), runStartedAt: at(0), finishedAt: at(60), coveragePlan: { level: 'standard', goal: 77, round: 5, rounds: 5 },
  coverageRun: { autoComplete: true, state: 'stopped', percent: 76, leaves: 108, covered: 82, coveredAtStart: 0, askedSections: 108, tokensUsed: 12_900_000, startedAt: at(0), list: rounds(['done', 'done', 'done', 'done', 'done']),
    stop: { reason: 'sections-left', round: 5, left: 26, unit: 'part' }, ...run }, ...over });

/** The job started from that draft with 为没覆盖的部分补题: the 86 questions are the draft's, the 26 sections are what it was asked for. */
const continuation = (over = {}, run = {}) => ({ id: 'second', status: 'running', deckTitle: 'API 粒度', draftId: 'd1', kind: 'quiz', count: 30, requestedTotal: 86, savedCount: 86, savedAtStart: 86, continued: true, askedQuestions: 30, parts: 2, steps: [],
  startedAt: at(70), runStartedAt: at(70), coveragePlan: { level: 'standard', goal: 77, round: 1, rounds: 1 },
  coverageRun: { autoComplete: true, state: 'running', percent: 76, leaves: 108, covered: 82, coveredAtStart: 82, askedSections: 26, tokensUsed: 12_900_000, startedAt: at(70), list: rounds(['running']), ...run }, ...over });

test('the stopped run of the screenshot: 76% (the sections that have a question), not 99%; the tile says 86 / 77 plainly', () => {
  assert.equal(pct(stoppedRun()), 76);
  const detail = jobContract(stoppedRun()).detail;
  assert.deepEqual(detail.cover, { covered: 82, leaves: 108, atStart: 0, asked: 108 });
  assert.equal(detail.own, null, 'a run that started a draft has no earlier draft to subtract');
  const progress = jobContract(stoppedRun()).progress;
  assert.deepEqual([progress.done, progress.total], [86, 77], 'the questions are not capped to look like progress');
  const primary = m.taskFacts(card(stoppedRun()), T0 + 90 * 60_000).find((fact) => fact.key === 'primary');
  assert.deepEqual([primary.label, primary.value], ['题数 · 全部计划', '86 / 77']);
  assert.equal(m.taskSummary(card(stoppedRun())).state, 'partial');
});

test('a fresh run: 0% when it starts, and the coverage as it rises; every question made does not count, only the sections that have one', () => {
  const fresh = (covered, over = {}) => ({ id: 'n', status: 'running', kind: 'quiz', count: 30, requestedTotal: 77, savedCount: 24, startedAt: at(0), runStartedAt: at(0), steps: [], coveragePlan: { goal: 77, round: 1, rounds: 3 },
    coverageRun: { autoComplete: true, state: 'running', percent: Math.round(covered / 108 * 100), leaves: 108, covered, coveredAtStart: 0, askedSections: 108, list: rounds(['running', 'pending', 'pending']) }, ...over });
  assert.equal(pct(fresh(0, { savedCount: 0 })), 0);
  assert.equal(pct(fresh(27)), 25);
  assert.equal(pct(fresh(54)), 50);
  assert.equal(pct(fresh(108)), 99, 'every section covered but the job still running: never 100%');
  assert.equal(pct({ ...fresh(108), status: 'complete', finishedAt: at(9), coverageRun: { ...fresh(108).coverageRun, state: 'complete', stop: { reason: 'complete', round: 3 } }, savedCount: 77 }), 100);
});

test('a continuation that has just started: 0%, its own counters (0 of about 30), the draft total as a second line; it never inherits the 86 as numerator and denominator', () => {
  assert.equal(pct(continuation()), 0, 'was 100: 86 / 86');
  const contract = jobContract(continuation());
  assert.deepEqual(contract.detail.own, { made: 0, asked: 30, base: 86 });
  assert.deepEqual(contract.detail.cover, { covered: 82, leaves: 108, atStart: 82, asked: 26 });
  const primary = m.taskFacts(card(continuation()), T0 + 71 * 60_000).find((fact) => fact.key === 'primary');
  assert.deepEqual([primary.label, primary.value, primary.note], ['题数 · 本任务', '0 / 约 30', '草稿共 86 题']);
  assert.equal(m.taskSummary(card(continuation())).percent, 0);
  inLanguage('en', () => {
    const en = m.taskFacts(card(continuation()), T0 + 71 * 60_000).find((fact) => fact.key === 'primary');
    assert.deepEqual([en.label, en.value, en.note], ['Questions · this task', '0 / about 30', 'Draft has 86 questions in all']);
  });
});

test('a continuation midway: the sections it has covered over the sections it was asked for, the questions it has written over what it was asked for', () => {
  const midway = continuation({ savedCount: 100 }, { covered: 90, percent: 83 });
  assert.equal(pct(midway), 31, '8 of 26 sections');
  assert.deepEqual(jobContract(midway).detail.own, { made: 14, asked: 30, base: 86 });
  assert.equal(m.taskFacts(card(midway), T0 + 80 * 60_000).find((fact) => fact.key === 'primary').value, '14 / 约 30');
});

test('a continuation that ends: 100% only when nothing is missing; stopped with sections left it says its true fraction', () => {
  const done = continuation({ status: 'complete', finishedAt: at(90), savedCount: 112 }, { covered: 108, percent: 100, state: 'complete', stop: { reason: 'complete', round: 1 } });
  assert.equal(pct(done), 100);
  const short = continuation({ status: 'complete', finishedAt: at(90), savedCount: 112 }, { covered: 100, percent: 93, state: 'stopped', stop: { reason: 'sections-left', round: 1, left: 8 } });
  assert.equal(pct(short), 69, '18 of 26 sections');
  assert.equal(m.taskSummary(card(short)).state, 'partial');
  const failed = continuation({ status: 'failed', finishedAt: at(75), savedCount: 90 }, { covered: 85, percent: 79, state: 'stopped', stop: { reason: 'refused', round: 1 } });
  assert.equal(pct(failed), 12, '3 of 26 sections');
});

test('a plain top-up (no plan) counts its own questions: 0 when it starts, never the draft it continues', () => {
  const plain = (over = {}) => ({ id: 'p', status: 'running', kind: 'quiz', count: 10, requestedTotal: 30, savedCount: 20, savedAtStart: 20, continued: true, askedQuestions: 10, startedAt: at(0), runStartedAt: at(0), steps: [], ...over });
  assert.equal(pct(plain()), 0, 'was 67');
  assert.equal(pct(plain({ savedCount: 25 })), 50);
  assert.equal(pct(plain({ savedCount: 30, status: 'complete', finishedAt: at(5) })), 100);
  assert.equal(pct(plain({ savedCount: 28, status: 'complete', finishedAt: at(5) })), 80, 'ended short of what it was asked for');
  assert.deepEqual(jobContract(plain({ savedCount: 25 })).detail.own, { made: 5, asked: 10, base: 20 });
  assert.equal(jobContract(plain()).detail.cover, null);
});

test('a plain run is what it was: questions over the request; 100 only when it is complete', () => {
  const plain = (over = {}) => ({ id: 'q', status: 'running', kind: 'quiz', count: 10, requestedTotal: 10, savedCount: 4, startedAt: at(0), steps: [], ...over });
  assert.equal(pct(plain()), 40);
  assert.equal(pct(plain({ savedCount: 10 })), 99, 'all written, still reviewing: not 100');
  assert.equal(pct(plain({ savedCount: 10, status: 'complete', finishedAt: at(5) })), 100);
  assert.equal(pct(plain({ savedCount: 6, status: 'failed', finishedAt: at(5) })), 60);
  assert.equal(jobContract(plain()).detail.own, null);
});

test('an old record (3.0.0, written without the new fields) still reads: its coverage, never 100% for a continuation that has just started', () => {
  const old = stoppedRun({}, { leaves: undefined, covered: undefined, coveredAtStart: undefined, askedSections: undefined });
  assert.equal(pct(old), 76, 'the finished run of the screenshot reads 76% even though it was written before the counts');
  assert.equal(jobContract(old).detail.cover, null);
  const started = continuation({ savedAtStart: undefined, askedQuestions: undefined }, { leaves: undefined, covered: undefined, coveredAtStart: undefined, askedSections: undefined });
  assert.equal(pct(started), null, 'a continuation that does not know where it started has no honest percent while it runs: unknown, not 100');
  assert.equal(jobContract(started).detail.own, null);
  const ended = { ...started, status: 'complete', finishedAt: at(90), savedCount: 112, coverageRun: { ...started.coverageRun, state: 'complete', stop: { reason: 'complete', round: 1 } } };
  assert.equal(pct(ended), 100);
  const oldShort = { ...started, status: 'complete', finishedAt: at(90), coverageRun: { ...started.coverageRun, state: 'stopped', stop: { reason: 'sections-left', round: 1, left: 8 } } };
  assert.ok(pct(oldShort) < 100);
  // a plain job from before percent counted anything but the questions: unchanged
  assert.equal(pct({ id: 'o', status: 'running', kind: 'quiz', count: 10, requestedTotal: 10, savedCount: 4, steps: [] }), 40);
});

test('the forecast of a continuation is measured from its own start: the goal is the draft it started with plus what it was asked for', () => {
  const contract = jobContract(continuation({ tokenUsage: { uncachedInputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 3 } }));
  const forecast = m.forecastOf(contract, T0 + 75 * 60_000);
  assert.ok(forecast, 'something is left, so the run can say what');
  assert.notEqual(forecast.time.state, 'finishing', '86 of 86 would read as finished');
});

test('the hover explanations say what each number counts, in both languages; only for a question run', () => {
  const hint = (job, language = 'zh') => inLanguage(language, () => m.progressHint(card(job)));
  assert.match(hint(stoppedRun()).percent, /覆盖：有题的小节 ÷ 计划里的小节/);
  assert.match(hint(stoppedRun()).questions, /题数可以超过计划/);
  assert.match(hint(continuation()).percent, /这个任务自己的进度.*26 个小节/);
  assert.match(hint(continuation()).questions, /本任务新写的题.*草稿共 86 题/);
  assert.match(hint(stoppedRun(), 'en').percent, /Coverage: sections that have a question ÷ sections in the plan/);
  assert.match(hint(continuation(), 'en').percent, /This task's own progress.*26 sections/);
  assert.match(hint(continuation(), 'en').questions, /written by this task/);
  assert.deepEqual(m.progressHint(card({ id: 'a', type: 'pdf-convert', status: 'running', startedAt: at(0), total: 4, done: 1 })), { percent: '', questions: '' });
});

test('the metrics: the percent, the label and each question tile carry a focusable anchor with the hover text (no title attribute); the tile shows nothing different when there is no hint', () => {
  const html = renderToStaticMarkup(React.createElement(m.Metrics, { job: card(continuation()), summary: m.taskSummary(card(continuation())), now: T0 + 71 * 60_000 }));
  assert.match(html, /总进度 · 进行中/);
  assert.match(html, /<strong[^>]*>0%<\/strong>/);
  assert.doesNotMatch(html, /\btitle="/, 'the project\'s Tooltip, never a title attribute');
  assert.equal((html.match(/data-metric-hint/g) || []).length, 2, 'the percent and the question tile');
  assert.match(html, /<span(?=[^>]*data-metric-hint)(?=[^>]*tabindex="0")[^>]*>/i);
  assert.match(html, /aria-label="进度 0\/26"/, 'the bar is the job\'s own work (0 of the 26 sections it was asked for), not the 86 questions the draft already held');
  const audio = { id: 'a', type: 'pdf-convert', status: 'running', startedAt: at(0), total: 4, done: 1 };
  const plainHtml = renderToStaticMarkup(React.createElement(m.Metrics, { job: card(audio), summary: m.taskSummary(card(audio)), now: T0 }));
  assert.doesNotMatch(plainHtml, /data-metric-hint/);
  assert.match(text(inLanguage('en', () => renderToStaticMarkup(React.createElement(m.Metrics, { job: card(continuation()), summary: m.taskSummary(card(continuation())), now: T0 + 71 * 60_000 })))), /Questions · this task/);
});

test('the other rows say the same: the home card and the compact card of a continuation count its own questions, and the percent explains itself on hover', () => {
  const started = continuation();
  assert.deepEqual(m.jobSavedProgress(started, []), { saved: 0, total: 30, label: '本次已保存', note: '草稿共 86 题' }, 'was 草稿已保存 86/86');
  assert.deepEqual(m.jobSavedProgress({ ...started, savedCount: 100 }, []).saved, 14);
  assert.equal(m.jobSavedProgress(stoppedRun(), []).total, 77, 'a run that began a draft is what it was');
  assert.equal(m.cardLine(card({ ...started, status: 'complete', finishedAt: at(90), savedCount: 100 })).includes('本任务 14/30 题'), true);
  assert.match(m.cardLine(card({ ...started, status: 'cancelled', finishedAt: at(80), savedCount: 90 })), /停在 本任务 4\/30 题/);
  const html = (job, language = 'zh') => { m.setUiLanguage(language); try { return renderToStaticMarkup(inApp(m, React.createElement(m.CompactJobCard, { job: card(job) }), {})); } finally { m.setUiLanguage('zh'); } };
  const running = html(started);
  assert.match(running, /<span(?=[^>]*data-metric-hint)(?=[^>]*tabindex="0")[^>]*>0%<\/span>/);
  assert.doesNotMatch(running, /title="/);
  assert.match(text(running), /这个任务自己的进度.*26 个小节/);
  assert.match(text(html(stoppedRun())), /覆盖：有题的小节 ÷ 计划里的小节.*76%|76%.*覆盖：有题的小节/);
  assert.match(text(html(started, 'en')), /This task's own progress/);
  assert.doesNotMatch(html({ id: 'f', type: 'pdf-convert', status: 'running', startedAt: at(0), total: 4, done: 1 }), /data-metric-hint/);
});
