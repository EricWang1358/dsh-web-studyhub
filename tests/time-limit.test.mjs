import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { jobContract, archivedContract } from '../lib/job-contract.js';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';

/* The time limit of a task, said on the task's page (the owner's complaint of 2026-10-06: 「生成用时太长，已自动停止」 with no number, no way to change it, and no
   word on which step took the time). One fact, one place: the contract says the limit (detail.timeLimit, docs/job-contract.md), ui/tasks/time-limit.js says
   which steps ran long, and the strip (ui/tasks/TimeLimit.jsx) and the timeline's marks read those two and nothing else. */

const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export * from './ui/tasks/time-limit.js';
  export { default as TimeLimit } from './ui/tasks/TimeLimit.jsx';
  export { default as Timeline } from './ui/tasks/Timeline.jsx';
  export { timelineModel } from './ui/tasks/call-model.js';
  export { describeFailure, hitTimeLimit } from './ui/generation-status.js';
  export { setUiLanguage } from './ui/i18n.js';
`);
const T0 = Date.UTC(2026, 9, 6, 9, 0, 0);
const at = (seconds) => new Date(T0 + seconds * 1000).toISOString();
const step = (id, kind, from, to, extra = {}) => ({ id, kind, stage: kind, runtime: 'subagent', startedAt: at(from), ...(to === null ? { status: 'running' } : { finishedAt: at(to), status: 'complete' }), ...extra });
const BUDGET = 'Generation reached its 20-minute total budget; approved questions were retained';

/** The owner's screenshot: 13 of 40 questions, a failed run that ended at its 20 minutes, one planning call that took 9 minutes 12 seconds. */
const owner = (extra = {}) => ({ id: 'gen-recovered', status: 'failed', stage: BUDGET, deckTitle: 'Recovered questions', requestedTotal: 40, savedCount: 13, startedAt: at(0), finishedAt: at(1201),
  totalTimeoutSeconds: 1200, generationTimeoutSeconds: 600, parts: 3,
  steps: [step('plan-1', 'plan', 0, 552, { part: 1 }), step('plan-2', 'plan', 2, 410, { part: 2 }), step('plan-3', 'plan', 3, 455, { part: 3 }),
    step('author-1', 'author', 560, 700, { part: 1 }), step('review-1', 'review', 705, 760, { part: 1 }), step('author-2', 'author', 420, 640, { part: 2, status: 'failed', error: 'x' })], ...extra });
const view = (job) => jobContract(job);
const html = (element, language = 'zh', openSettings = () => {}) => {
  m.setUiLanguage(language);
  try { return renderToStaticMarkup(inApp(m, element, { data: {}, app: { settingsEntry: { openSettings, openModelSettings: () => {} } } })); } finally { m.setUiLanguage('zh'); }
};
const strip = (job, { language = 'zh', now = T0 + 1201 * 1000, hit } = {}) => {
  const contract = view(job), calls = contract.calls, ended = !['queued', 'running', 'pausing', 'paused', 'cancelling'].includes(contract.status);
  const limited = hit ?? (ended && m.hitTimeLimit(contract.error?.message || contract.stage?.text));
  const steps = m.slowSteps(calls, { now: ended ? Date.parse(contract.finishedAt) : now, hitLimit: limited });
  return html(React.createElement(m.TimeLimit, { task: job, now, steps, onPick: () => {} }), language);
};

test('the contract says the limit of a plain run: the whole run, with the per-call limit and what is kept', () => {
  const limit = view(owner()).detail.timeLimit;
  assert.deepEqual(limit, { seconds: 1200, scope: 'run', callSeconds: 600, keeps: 'questions' });
});

test('a coverage run has its limit PER ROUND (lib/contexts/generation/operations.js roundMs), and a plan of one round is the whole run', () => {
  const run = { state: 'running', autoComplete: true, list: [{ round: 1, status: 'done', questions: 30, sections: 5 }, { round: 2, status: 'running', questions: 30, sections: 5 }], percent: 20 };
  const limit = view(owner({ status: 'running', stage: 'Writing', finishedAt: undefined, coverageRun: run })).detail.timeLimit;
  assert.equal(limit.scope, 'round');
  assert.equal(limit.seconds, 1200);
  assert.equal(limit.keeps, 'questions');
});

test('a time limit nobody can change is fixed and says what it keeps: a translation (60 minutes, paragraphs kept), a selection run (20 minutes, nothing saved)', () => {
  const translation = view({ id: 't1', type: 'translation', status: 'running', startedAt: at(0), totalTimeoutSeconds: 3600, done: 2, total: 9 }).detail.timeLimit;
  assert.deepEqual(translation, { seconds: 3600, scope: 'fixed', callSeconds: null, keeps: 'paragraphs' });
  const selection = view({ id: 's1', type: 'supplement', origin: 'selection', status: 'running', startedAt: at(0), totalTimeoutSeconds: 1200, generationTimeoutSeconds: 600 }).detail.timeLimit;
  assert.deepEqual(selection, { seconds: 1200, scope: 'fixed', callSeconds: 600, keeps: 'nothing' });
  const supplement = view({ id: 's2', type: 'supplement', status: 'running', startedAt: at(0), totalTimeoutSeconds: 2400, generationTimeoutSeconds: 600, mergeTargetId: 'deck' }).detail.timeLimit;
  assert.equal(supplement.scope, 'run', 'a supplement of a deck is a run of the setting');
  assert.equal(supplement.seconds, 2400);
});

test('an older record, a kind without a limit, and an archived task: no limit is invented, nothing crashes', () => {
  assert.equal(view({ id: 'old', status: 'failed', stage: BUDGET, startedAt: at(0) }).detail.timeLimit, undefined, 'a job record without totalTimeoutSeconds says nothing');
  assert.equal(view({ id: 'a1', type: 'audio-import', status: 'running', startedAt: at(0), filename: 'x', members: [] }).detail.timeLimit, undefined);
  assert.equal(view({ id: 'p1', type: 'pdf-convert', status: 'running', startedAt: at(0), filename: 'x.pdf' }).detail.timeLimit, undefined);
  const kept = archivedContract(view(owner()), at(2000));
  assert.deepEqual(kept.detail.timeLimit, { seconds: 1200, scope: 'run', callSeconds: 600, keeps: 'questions' }, 'the archive keeps the limit with the rest of the detail');
  const { timeLimit: _gone, ...detail } = kept.detail;
  const old = { ...kept, detail };
  const restored = jobContract({ id: 'restored', restoredContract: old, finishedAt: at(2100) });
  assert.equal(restored.detail.timeLimit, undefined, 'a record archived before this field existed shows no limit');
  assert.equal(m.limitFacts(restored, { now: T0 }), null);
});

test('hitTimeLimit is the classifier of the list row: the same words that make 「生成用时太长，已自动停止」 make a task "ended by the limit"', () => {
  for (const text of [BUDGET, 'Generation reached its 20-minute budget for this round; approved questions were retained', 'Translation reached its time budget; translated paragraphs are kept', '已达到 20 分钟执行时限；已验收题目已保留']) {
    assert.equal(m.hitTimeLimit(text), true, text);
    assert.equal(m.describeFailure(text).title, '生成用时太长，已自动停止', 'the row says the same thing');
  }
  for (const text of ['Study generation timed out after 10 minutes; this is not an editorial rejection', 'Quality gate failed', '', undefined, '401 Unauthorized: Invalid API key']) {
    assert.equal(m.hitTimeLimit(text), false, String(text));
    assert.notEqual(m.describeFailure(text).title, '生成用时太长，已自动停止');
  }
});

test('which step ran long: past 3 times the median of the finished steps of its kind (not counting itself) and past 2 minutes; a running step counts up to now', () => {
  assert.deepEqual([m.LONG_CALL.times, m.LONG_CALL.floorMs], [3, 120000]);
  const calls = view(owner()).calls;
  const plan = calls.find((call) => call.callId === 'plan-1');
  assert.equal(m.callMs(plan, T0), 552000);
  assert.equal(m.longCallMs(calls, plan), 1290000, 'three times the median of the OTHER plans (408 s and 452 s: 430 s)');
  // Three plans of 9, 7 and 7.5 minutes: nothing is out of line with its kind.
  assert.deepEqual(m.slowSteps(calls, { now: T0 + 1201e3, hitLimit: false }), []);
  // The job ended by its limit: the one step that took the most time is named anyway.
  const named = m.slowSteps(calls, { now: T0 + 1201e3, hitLimit: true });
  assert.deepEqual(named.map((item) => [item.callId, item.mark, item.ms]), [['plan-1', 'slowest', 552000]]);
});

test('a running step far past its siblings is long: 10 minutes against plans that took 1; the floor of 2 minutes holds when nothing of its kind has finished', () => {
  const calls = view({ id: 'r', status: 'running', startedAt: at(0), totalTimeoutSeconds: 1200, generationTimeoutSeconds: 600, steps: [
    step('p1', 'plan', 0, 60, { part: 1 }), step('p2', 'plan', 1, 70, { part: 2 }), step('p3', 'plan', 2, null, { part: 3 }), step('a1', 'author', 80, null, { part: 1 })] }).calls;
  const at5 = m.slowSteps(calls, { now: T0 + 300e3 });
  assert.deepEqual(at5.map((item) => [item.callId, item.mark, item.running]), [['p3', 'long', true], ['a1', 'long', true]], 'longest first; the author has no finished sibling, so only the floor applies');
  assert.equal(m.longCallMs(calls, calls.find((call) => call.callId === 'p3')), 193500, 'three times the median of the finished plans (60 s and 69 s), which is more than the floor');
  assert.equal(m.longCallMs(calls, calls.find((call) => call.callId === 'a1')), 120000);
});

test('a step that is not long is not marked: a rate-limit wait, the first minutes of a call with no sibling, a finished step in line with its kind', () => {
  const calls = view({ id: 'r', status: 'running', startedAt: at(0), steps: [step('p1', 'plan', 0, 100, { part: 1 }), step('p2', 'plan', 1, 130, { part: 2 }), step('a1', 'author', 10, null, { part: 1 })],
    waits: [{ id: 'w', kind: 'wait', slot: 1, startedAt: at(0), endedAt: at(1000) }] }).calls;
  assert.deepEqual(m.slowSteps(calls, { now: T0 + 119e3 }), [], 'under 2 minutes nothing is long, and a rate-limit wait is never a step');
  assert.deepEqual(m.slowSteps(calls, { now: T0 + 131e3 }).map((item) => item.callId), ['a1'], 'past 2 minutes with no sibling to compare to');
});

test('the strip of the owner\'s task: the limit that fired, the time used, what is kept, the slowest step, and the one link to the setting', () => {
  const out = strip(owner());
  assert.match(out, /data-limit-scope="run"/);
  assert.match(out, /data-limit-hit="true"/);
  assert.match(out, /运行时限 20 分钟/);
  assert.match(out, /已用 20 分 1 秒/, 'the same number as 已用 in the facts above');
  assert.match(out, /单次模型调用最长 10 分钟/);
  assert.match(out, /已用满时限，任务自动停止；已通过检查的题已保留/);
  assert.match(out, /最慢的一步/);
  assert.match(out, /data-slow-call="plan-1"[^>]*>[^<]*提取知识点与原文[^<]*9 分 12 秒/, 'the step is a button that names it and says how long it took');
  assert.match(out, /data-limit-adjust/);
  assert.match(out, /调整时限/);
});

test('the same strip in English reads English (no Chinese is left), with the same facts', () => {
  const out = strip(owner(), { language: 'en' });
  assert.doesNotMatch(out.replace(/<[^>]+>/g, ' '), /[㐀-鿿]/, 'every word is translated');
  assert.match(out, /Time budget 20 min/);
  assert.match(out, /Elapsed 20 min 1 sec/);
  assert.match(out, /Adjust time budget/);
  assert.match(out, /Slowest step/);
});

test('a coverage run says the limit is per round, and which rounds reached it; running, it says how long this round has run', () => {
  const run = { state: 'running', autoComplete: true, list: [{ round: 1, status: 'done', questions: 30, sections: 5 }, { round: 2, status: 'failed', questions: 30, sections: 5, reason: 'timeout' },
    { round: 3, status: 'running', questions: 30, sections: 5 }], percent: 20 };
  const job = { id: 'cov', status: 'running', stage: 'Writing', startedAt: at(0), totalTimeoutSeconds: 1200, generationTimeoutSeconds: 600, coverageRun: run,
    steps: [step('c1', 'plan', 0, 30, { part: 1, round: 1 }), step('c2', 'plan', 2400, 2430, { part: 1, round: 3 }), step('c3', 'author', 2440, null, { part: 1, round: 3 })] };
  const out = strip(job, { now: T0 + 2400e3 + 12 * 60e3 });
  assert.match(out, /data-limit-scope="round"/);
  assert.match(out, /每轮运行时限 20 分钟/);
  assert.match(out, /本轮已用 12 分 0 秒/, 'this round started with its first call, not with the run');
  assert.match(out, /第 2 轮到了时限/);
  assert.match(out, /data-limit-adjust/);
  assert.match(out, /data-limit-rounds="2"/);
  assert.match(out, /data-limit-hit="false"/, 'the run is still going: only a round reached the limit');
});

test('a running task shows the limit quietly: no "stopped" sentence, a step that runs long named with its rule in the title', () => {
  const job = { id: 'run', status: 'running', stage: 'Writing', startedAt: at(0), totalTimeoutSeconds: 1200, generationTimeoutSeconds: 600,
    steps: [step('p1', 'plan', 0, 50, { part: 1 }), step('p2', 'plan', 1, null, { part: 2 })] };
  const out = strip(job, { now: T0 + 600e3 });
  assert.match(out, /data-limit-hit="false"/);
  assert.match(out, /运行时限 20 分钟/);
  assert.match(out, /已用 10 分 0 秒/);
  assert.doesNotMatch(out, /自动停止/);
  assert.match(out, /运行偏久/);
  assert.match(out, /data-slow-call="p2"/);
  assert.match(out, /title="[^"]*3 倍[^"]*2 分钟/, 'the rule is in the tooltip');
});

test('a fixed limit is stated and never offered for change: translation and selection show no 调整时限', () => {
  const translation = strip({ id: 't1', type: 'translation', status: 'failed', startedAt: at(0), finishedAt: at(3601), totalTimeoutSeconds: 3600, done: 2, total: 9,
    stage: 'Translation reached its time budget; translated paragraphs are kept' });
  assert.match(translation, /运行时限 60 分钟（固定）/);
  assert.match(translation, /已翻译的段落已保留/);
  assert.doesNotMatch(translation, /data-limit-adjust|调整时限/);
  assert.doesNotMatch(translation, /单次模型调用/);
  const selection = strip({ id: 's1', type: 'supplement', origin: 'selection', status: 'failed', startedAt: at(0), finishedAt: at(1201), totalTimeoutSeconds: 1200, generationTimeoutSeconds: 600,
    stage: 'Generation reached its 20-minute total budget; nothing was saved' });
  assert.match(selection, /运行时限 20 分钟（固定）/);
  assert.match(selection, /题组没有变化/);
  assert.doesNotMatch(selection, /data-limit-adjust/);
});

test('nothing is drawn for a task whose record has no limit (an older record, an audio import)', () => {
  assert.equal(strip({ id: 'old', status: 'failed', stage: BUDGET, startedAt: at(0), finishedAt: at(10) }), '');
  assert.equal(strip({ id: 'a', type: 'audio-import', status: 'running', startedAt: at(0), filename: 'x', members: [] }), '');
});

test('the link opens 设置 › 出题偏好 at the field of the limit: the strip calls openSettings with the one anchor the setting has', () => {
  const calls = [];
  const element = React.createElement(m.TimeLimit, { task: owner(), now: T0 + 1201e3, steps: [], onPick: () => {} });
  m.setUiLanguage('zh');
  const tree = inApp(m, element, { data: {}, app: { settingsEntry: { openSettings: (section) => calls.push(section), openModelSettings: () => {} } } });
  renderToStaticMarkup(tree);
  assert.deepEqual(calls, [], 'rendering opens nothing');
  assert.equal(m.LIMIT_ANCHOR, 'settings-generation-time');
});

test('the timeline marks the long steps and the slowest one: data-slow on the bar, and the rule in its title (not colour alone: the CSS adds a pattern and an outline)', () => {
  const contract = view(owner());
  const marks = new Map(m.slowSteps(contract.calls, { now: T0 + 1201e3, hitLimit: true }).map((item) => [item.callId, item.mark]));
  const out = html(React.createElement(m.Timeline, { calls: contract.calls, running: false, family: 'generation', selected: null, marks, onSelect: () => {} }));
  assert.match(out, /data-slow="slowest"/);
  assert.equal((out.match(/data-slow=/g) || []).length, 1, 'only the marked bar');
  assert.match(out, /title="[^"]*9 分 12 秒/, 'the title of a marked bar says how long it took');
  assert.match(out, /aria-label="[^"]*最慢的一步"/, 'a screen reader hears the mark, not only sighted users');
  assert.match(out, /data-kind="slow"/, 'the legend names the mark');
  const plain = html(React.createElement(m.Timeline, { calls: contract.calls, running: false, family: 'generation', selected: null, onSelect: () => {} }));
  assert.doesNotMatch(plain, /data-slow=/, 'no marks: the timeline is as it was');
  assert.doesNotMatch(plain, /data-kind="slow"/);
});

test('the timeline window (the last ten minutes) never cuts away a step the strip points at: it reaches back to where the earliest marked step began', () => {
  // A planning call that took most of the first ten minutes and failed; the run went on and ended at 20 minutes: that bar lies before the last ten minutes.
  const job = { id: 'win', status: 'failed', stage: BUDGET, startedAt: at(0), finishedAt: at(1200), totalTimeoutSeconds: 1200, generationTimeoutSeconds: 600, steps: [
    step('plan-1', 'plan', 0, 560, { part: 1, status: 'failed', error: '模型长时间没有响应（请求超时），可以稍后重试' }), step('plan-2', 'plan', 1, 601, { part: 2 }),
    step('author-1', 'author', 610, 900, { part: 1 }), step('review-1', 'review', 905, 1200, { part: 1 })] };
  const calls = view(job).calls, ids = (model) => model.lanes.flatMap((lane) => lane.bars.map((bar) => bar.callId));
  const plain = m.timelineModel(calls, { now: T0 + 1200e3, running: false });
  assert.equal(plain.windowMs, 600000, 'without marks it is the last ten minutes, as it always was');
  assert.ok(!ids(plain).includes('plan-1'), 'plan-1 ended before that window began: not drawn');
  const wide = m.timelineModel(calls, { now: T0 + 1200e3, running: false, pinned: ['plan-1'] });
  assert.equal(wide.windowMs, 1200000);
  assert.ok(ids(wide).includes('plan-1'), 'the marked step is drawn, from the left edge');
  assert.equal(wide.lanes.find((lane) => lane.bars.some((bar) => bar.callId === 'plan-1')).bars.find((bar) => bar.callId === 'plan-1').left, 0);
  const capped = m.timelineModel(calls.map((call) => ({ ...call, startedAt: new Date(Date.parse(call.startedAt) - 7200e3).toISOString() })), { now: T0 + 1200e3, running: false, pinned: ['plan-1'] });
  assert.ok(capped.windowMs <= 3600000, 'an hour at most');
});

test('a step that failed at the limit of one call says so: it ran as long as callSeconds, and its words are the timeout of the model, not a quality rejection', () => {
  const calls = view({ id: 'lim', status: 'failed', stage: BUDGET, startedAt: at(0), finishedAt: at(1200), totalTimeoutSeconds: 1200, generationTimeoutSeconds: 600, steps: [
    step('plan-1', 'plan', 0, 600, { part: 1, status: 'failed', error: '模型长时间没有响应（请求超时），可以稍后重试' }), step('plan-2', 'plan', 1, 601, { part: 2, status: 'failed', error: 'Quality gate failed: q1' }),
    step('plan-3', 'plan', 1, 300, { part: 3, status: 'failed', error: '模型长时间没有响应（请求超时），可以稍后重试' }), step('plan-4', 'plan', 1, 50, { part: 4 })] }).calls;
  const by = (id) => calls.find((call) => call.callId === id);
  assert.equal(m.callLimitHit(by('plan-1'), 600, T0), true);
  assert.equal(m.callLimitHit(by('plan-2'), 600, T0), false, 'it ran 10 minutes but it was rejected, not timed out');
  assert.equal(m.callLimitHit(by('plan-3'), 600, T0), false, 'a timeout well before the limit is the provider, not our limit');
  assert.equal(m.callLimitHit(by('plan-4'), 600, T0), false);
  assert.equal(m.callLimitHit(by('plan-1'), null, T0), false, 'a job that records no per-call limit cannot say');
  const out = strip({ id: 'lim', status: 'failed', stage: BUDGET, startedAt: at(0), finishedAt: at(1200), totalTimeoutSeconds: 1200, generationTimeoutSeconds: 600, steps: [
    step('plan-1', 'plan', 0, 600, { part: 1, status: 'failed', error: '模型长时间没有响应（请求超时），可以稍后重试' }), step('plan-4', 'plan', 1, 50, { part: 4 })] }, { now: T0 + 1200e3 });
  assert.match(out, /data-slow-call="plan-1"[^>]*>[^<]*10 分 0 秒[^<]*到了单次调用上限/);
});
