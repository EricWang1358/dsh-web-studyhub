import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';

/* The audio task card (WP-AU): effective parallelism (#212), and below the history, the sub-agent links (#211, #214). */

const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { AudioJobs, parallelNote, reuseNote, reasoningNote } from './ui/audio/AudioJobs.jsx';
  export { default as OutputPanel, callFacts } from './ui/tasks/OutputPanel.jsx';
  export { usageLine } from './ui/tasks/task-facts.js';
  export { unifyCall } from './lib/job-calls.js';
  export { AudioDashboardView } from './ui/AudioDashboard.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);
const { AudioJobs, parallelNote, reuseNote, reasoningNote, OutputPanel, callFacts, usageLine, unifyCall, AudioDashboardView, setUiLanguage } = m;
const HAN = /[㐀-鿿]/;
const inLanguage = (language, run) => { try { setUiLanguage(language); return run(); } finally { setUiLanguage('zh'); } };
const noop = () => {};
const render = (job, props = {}) => renderToStaticMarkup(inApp(m, React.createElement(AudioJobs, { data: { jobs: [job] }, busy: false, act: noop, ...props }), { data: { jobs: [job] } }));
const running = (extra = {}) => ({ id: 'j1', type: 'audio-import', filename: 'lecture.mp3', status: 'running', phase: 'proofread', done: 2, total: 6,
  steps: { transcribe: { done: 1, total: 1 }, proofread: { done: 2, total: 6 } }, warnings: [], startedAt: new Date().toISOString(), ...extra });

/* The page shows the compact card; the notes below are in the console's one usage line (the console's panels test draws the console itself). */
test('the console says how many windows run at once, and when a rate limit lowered it', () => {
  assert.equal(parallelNote({ limit: 3, effective: 3, lowest: 3 }), '并行 3');
  assert.equal(parallelNote({ limit: 6, effective: 4, lowest: 4 }), '并行 4（已因限流从 6 降到 4）');
  assert.equal(parallelNote({ limit: 6, effective: 6, lowest: 3 }), '并行 6（曾因限流降到 3，已恢复）');
  assert.equal(parallelNote(null), '');
  assert.match(usageLine(running({ parallel: { text: { limit: 6, effective: 4, lowest: 4 } } })), /并行 4（已因限流从 6 降到 4）/);
  assert.doesNotMatch(usageLine(running({ phase: 'transcribe', parallel: { text: { limit: 6, effective: 4, lowest: 4 } } })), /并行 4/, 'only while the text steps run');
  inLanguage('en', () => {
    const line = usageLine(running({ parallel: { text: { limit: 6, effective: 4, lowest: 4 } } }));
    assert.match(line, /4 in parallel \(lowered from 6 because of rate limits\)/);
    assert.doesNotMatch(line, HAN);
  });
});

test('a recording resumed from a saved transcript says so, where the requests are counted (#209)', () => {
  assert.equal(reuseNote({ transcribe: { done: 2, total: 2, reused: 2 } }), '复用已保存的转写，没有向转写服务发请求');
  assert.equal(reuseNote({ transcribe: { done: 3, total: 3, reused: 1 } }), '复用已保存的转写 1/3 段，其余 2 段重新转写');
  assert.equal(reuseNote({ transcribe: { done: 2, total: 2, reused: 0 } }), '');
  const job = running({ steps: { transcribe: { done: 2, total: 2, reused: 2 }, proofread: { done: 1, total: 6 } } });
  assert.match(usageLine(job), /复用已保存的转写，没有向转写服务发请求/);
  inLanguage('en', () => {
    const line = usageLine(job);
    assert.match(line, /Reused the saved transcript; nothing was sent to the transcription provider/);
    assert.doesNotMatch(line, HAN);
  });
});

test('the card on the page is the compact one: no history list, no sub-agent rows, one button', () => {
  const page = render(running({ tasks: [{ id: 't1', kind: 'proofread', part: 1, parts: 6, status: 'running', runtime: 'subagent', childId: 'c1', startedAt: new Date().toISOString() }] }));
  assert.equal((page.match(/class="cjc[ "]/g) || []).length, 1);
  assert.doesNotMatch(page, /查看历史任务|查看子代理|<details/);
  assert.match(page, /查看详情/);
});

const emptyCount = { requests: 0, success: 0, failures: 0, limited: 0, inputTokens: 0, outputTokens: 0, outputUnknown: 0, audioSeconds: 0 };
const usage = { providers: ['free', 'siliconflow', 'groq', 'paid'].map(tier => ({ tier, configured: tier === 'free', today: { ...emptyCount, requests: tier === 'free' ? 3 : 0 }, total: emptyCount, models: [],
  ...(tier === 'free' ? { quotaDay: { timeZone: 'America/Los_Angeles', day: '2026-10-04', resetTime: '15:00', resetsAt: 0 } } : {}) })),
  trend: [{ date: '2026-10-05', free: 3, groq: 0, paid: 0, siliconflow: 0 }], timings: [], other: { today: { ...emptyCount, requests: 2 }, total: { ...emptyCount, requests: 5 } } };
const keySet = { set: true, hint: '••••1234' }, settings = { freeKey: keySet, siliconflowKey: { set: false }, groqKey: { set: false }, paidKey: { set: false }, dailyLimits: {}, proofreadReasoning: 'default', translateReasoning: 'low' };

test('the usage console keeps the Pacific quota day apart from the local day, with the reset in local time (#210)', () => {
  const page = renderToStaticMarkup(React.createElement(AudioDashboardView, { data: usage, settings, busy: false, refresh: noop, save: noop }));
  assert.match(page, /额度按太平洋时间每天 0 点重置（本地时间 15:00）· 当前额度日 2026-10-04/);
  assert.match(page, /按你所在时区的日期/);
  assert.doesNotMatch(page, /今日按太平洋时间/);
  assert.match(page, /其他（未归类的服务或密钥）：今日 2 次请求，累计 5 次/);
  inLanguage('en', () => {
    const english = renderToStaticMarkup(React.createElement(AudioDashboardView, { data: usage, settings, busy: false, refresh: noop, save: noop }));
    assert.match(english, /resets every day at 00:00 Pacific time \(15:00 your local time\)/);
    assert.doesNotMatch(english, HAN);
  });
});

/* ---- what is known about a call, and the sub-agent link (#211, #213, #214): in the console's output panel, for the call picked ---- */

const finished = (n, extra = {}) => unifyCall({ id: `t${n}`, kind: 'proofread', part: n, parts: 12, stage: `校对 ${n}/12`, status: 'complete', runtime: 'subagent', childId: `child-${n}`,
  reasoning: 'medium', reasoningEffort: 'default', startedAt: '2026-10-05T01:00:00.000Z', finishedAt: `2026-10-05T01:00:${String(10 + n).padStart(2, '0')}.000Z`, ...extra });
const openAgent = Object.assign(async () => {}, { canOpen: () => true });
const panel = (call, host = {}) => renderToStaticMarkup(inApp(m, React.createElement(OutputPanel, { jobId: 'j1', call, active: false }), { data: {}, host, app: { host } }));

test('the reasoning line says what happened in plain words, and only when it differs (#214, #220)', () => {
  assert.equal(reasoningNote({ reasoning: 'default', reasoningEffort: 'default' }), '');
  assert.equal(reasoningNote({ reasoning: 'high', reasoningEffort: 'high', reasoningApplied: 'high' }), '');
  assert.equal(reasoningNote({ reasoning: 'medium', reasoningEffort: 'high', reasoningReason: 'nearest', reasoningName: 'High' }), '推理强度：要求「中」，当前模型没有，已用「High」');
  assert.equal(reasoningNote({ reasoning: 'high', reasoningEffort: 'default', reasoningReason: 'unsupported' }), '推理强度：要求「高」，当前模型没有可调档位，按模型默认');
  assert.equal(reasoningNote({ reasoning: 'medium', reasoningEffort: 'default' }), '推理强度：要求「中」，当前模型没有可调档位，按模型默认', 'older records without a reason');
  const call = finished(1, { reasoning: 'medium', reasoningEffort: 'high', reasoningReason: 'nearest', reasoningName: 'High' });
  assert.match(panel(call), /推理强度：要求「中」，当前模型没有，已用「High」/);
  assert.doesNotMatch(panel(call), /推理：/, 'no "medium → default" arrow line any more');
  inLanguage('en', () => {
    const english = panel(call);
    assert.match(english, /Reasoning strength: &quot;Mid&quot; was asked for, this model has no such level, &quot;High&quot; was used/);
    assert.doesNotMatch(english, HAN);
  });
});

test('"在 DSH 中打开完整会话" is drawn only when the host can open it, one per call picked (#211)', () => {
  const call = finished(3);
  assert.doesNotMatch(panel(call), /在 DSH 中打开完整会话/, 'no host function: no link');
  assert.match(panel(call, { openAgent }), /在 DSH 中打开完整会话：校对 3\/12/);
  assert.doesNotMatch(panel(call, { openAgent: Object.assign(async () => {}, { canOpen: () => false }) }), /在 DSH 中打开完整会话/, 'the host says it cannot');
  assert.doesNotMatch(panel(finished(2, { childId: undefined }), { openAgent }), /在 DSH 中打开完整会话/, 'a call without a child has nothing to open');
});

test('what can be said about a call without opening it is one line: input size, tokens, start of the answer (#213)', () => {
  const call = finished(1, { inputChars: 5800, reasoning: 'default', tokenUsage: { outputTokens: 300 }, outputPreview: '{"corrections":[]}' });
  assert.equal(callFacts(call), '输入约 5,800 字 · 用量：300 tok · 最近输出：{"corrections":[]}');
  assert.match(panel(call), /最近输出：\{&quot;corrections&quot;:\[\]\}/);
  assert.equal(callFacts(finished(1, { reasoning: 'default' })), '', 'nothing to say, nothing drawn');
});
