import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';

/* The audio task card (WP-AU): effective parallelism (#212), and below the history, the sub-agent links (#211, #214). */

const compiled = await build({
  stdin: { contents: `export { AudioJobs, parallelNote, reuseNote, reasoningNote } from './ui/audio/AudioJobs.jsx'; export { AudioDashboardView } from './ui/AudioDashboard.jsx'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.json': 'json', '.css': 'text' },
});
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { AudioJobs, parallelNote, reuseNote, reasoningNote, AudioDashboardView, setUiLanguage } = module.exports;
const HAN = /[㐀-鿿]/;
const inLanguage = (language, run) => { try { setUiLanguage(language); return run(); } finally { setUiLanguage('zh'); } };
const noop = () => {};
const render = (job, props = {}) => renderToStaticMarkup(React.createElement(AudioJobs, { data: { jobs: [job] }, busy: false, act: noop, ...props }));
const running = (extra = {}) => ({ id: 'j1', type: 'audio-import', filename: 'lecture.mp3', status: 'running', phase: 'proofread', done: 2, total: 6,
  steps: { transcribe: { done: 1, total: 1 }, proofread: { done: 2, total: 6 } }, warnings: [], startedAt: new Date().toISOString(), ...extra });

test('the card says how many windows run at once, and when a rate limit lowered it', () => {
  assert.equal(parallelNote({ limit: 3, effective: 3, lowest: 3 }), '并行 3');
  assert.equal(parallelNote({ limit: 6, effective: 4, lowest: 4 }), '并行 4（已因限流从 6 降到 4）');
  assert.equal(parallelNote({ limit: 6, effective: 6, lowest: 3 }), '并行 6（曾因限流降到 3，已恢复）');
  assert.equal(parallelNote(null), '');
  assert.match(render(running({ parallel: { text: { limit: 6, effective: 4, lowest: 4 } } })), /并行 4（已因限流从 6 降到 4）/);
  assert.doesNotMatch(render(running({ phase: 'transcribe', parallel: { text: { limit: 6, effective: 4, lowest: 4 } } })), /并行 4/, 'only while the text steps run');
  inLanguage('en', () => {
    const page = render(running({ parallel: { text: { limit: 6, effective: 4, lowest: 4 } } }));
    assert.match(page, /4 in parallel \(lowered from 6 because of rate limits\)/);
    assert.doesNotMatch(page, HAN);
  });
});

test('a recording resumed from a saved transcript says so on its card (#209)', () => {
  assert.equal(reuseNote({ transcribe: { done: 2, total: 2, reused: 2 } }), '复用已保存的转写，没有向转写服务发请求');
  assert.equal(reuseNote({ transcribe: { done: 3, total: 3, reused: 1 } }), '复用已保存的转写 1/3 段，其余 2 段重新转写');
  assert.equal(reuseNote({ transcribe: { done: 2, total: 2, reused: 0 } }), '');
  assert.match(render(running({ steps: { transcribe: { done: 2, total: 2, reused: 2 }, proofread: { done: 1, total: 6 } } })), /复用已保存的转写，没有向转写服务发请求/);
  inLanguage('en', () => {
    const page = render(running({ steps: { transcribe: { done: 2, total: 2, reused: 2 }, proofread: { done: 1, total: 6 } } }));
    assert.match(page, /Reused the saved transcript; nothing was sent to the transcription provider/);
    assert.doesNotMatch(page, HAN);
  });
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

/* ---- the history of model tasks (#214), the sub-agent link (#211) ---- */

const NOTE = '处理结果由插件直接回收并保存，不回流主会话。';
const finished = (n, extra = {}) => ({ id: `t${n}`, kind: 'proofread', part: n, parts: 12, stage: `校对 ${n}/12`, status: 'complete', runtime: 'subagent', childId: `child-${n}`, note: NOTE,
  reasoning: 'medium', reasoningEffort: 'default', startedAt: '2026-10-05T01:00:00.000Z', finishedAt: `2026-10-05T01:00:${String(10 + n).padStart(2, '0')}.000Z`, ...extra });
const history = count => Array.from({ length: count }, (_, i) => finished(i + 1));
const withHistory = (count, extra = {}) => running({ status: 'complete', phase: 'done', tasks: history(count), ...extra });
const openAgent = async () => {};
const rows = html => html.match(/<li>/g)?.length || 0;

test('the history shows the latest five, the rest on request, and no scroller of its own (#214)', () => {
  const page = render(withHistory(12), { openAgent });
  assert.match(page, /查看历史任务 · 12 次模型任务/);
  assert.equal(rows(page), 5);
  assert.match(page, /再显示 7 条/);
  assert.ok(page.indexOf('校对 12/12') < page.indexOf('校对 8/12'), 'latest first');
  assert.ok(!page.includes('校对 7/12'), 'older ones wait behind the button');
  assert.doesNotMatch(render(withHistory(4), { openAgent }), /再显示/);
  const css = readFileSync('ui/audio-import.css', 'utf8');
  const rule = css.split('\n').filter(line => /\.audio-trace\b/.test(line)).join('\n');
  assert.doesNotMatch(rule, /overflow|max-height/, 'the history list is not a nested scroller');
});

test('what every row would repeat is said once, quietly, and the rows are one line each (#214)', () => {
  const page = render(withHistory(6), { openAgent });
  assert.equal((page.match(new RegExp(NOTE, 'g')) || []).length, 1, 'the common note appears once');
  assert.doesNotMatch(page.slice(page.indexOf('audio-trace-note') - 40, page.indexOf('audio-trace-note') + 60), /tone-warning|sh-hint--warning/);
  assert.match(page, /都由「DSH 子代理」完成/);
  assert.match(page, /校对 6\/12 · 已完成 · 16 秒/, 'one compact line per task: what, how it ended, how long');
  assert.doesNotMatch(page, /<small[^>]*>[^<]*DSH 子代理[^<]*已完成/, 'the runtime is not repeated on each row');
});

test('the reasoning line says what happened in plain words, and only when it differs (#214, #220)', () => {
  assert.equal(reasoningNote({ reasoning: 'default', reasoningEffort: 'default' }), '');
  assert.equal(reasoningNote({ reasoning: 'high', reasoningEffort: 'high', reasoningApplied: 'high' }), '');
  assert.equal(reasoningNote({ reasoning: 'medium', reasoningEffort: 'high', reasoningReason: 'nearest', reasoningName: 'High' }), '推理强度：要求「中」，当前模型没有，已用「High」');
  assert.equal(reasoningNote({ reasoning: 'high', reasoningEffort: 'default', reasoningReason: 'unsupported' }), '推理强度：要求「高」，当前模型没有可调档位，按模型默认');
  assert.equal(reasoningNote({ reasoning: 'medium', reasoningEffort: 'default' }), '推理强度：要求「中」，当前模型没有可调档位，按模型默认', 'older records without a reason');
  const page = render(withHistory(1, { tasks: [finished(1, { reasoning: 'medium', reasoningEffort: 'high', reasoningReason: 'nearest', reasoningName: 'High' })] }), { openAgent });
  assert.match(page, /推理强度：要求「中」，当前模型没有，已用「High」/);
  assert.doesNotMatch(page, /推理：/, 'no "medium → default" arrow line any more');
  inLanguage('en', () => {
    const english = render(withHistory(1, { tasks: [finished(1, { reasoning: 'medium', reasoningEffort: 'high', reasoningReason: 'nearest', reasoningName: 'High' })] }), { openAgent });
    assert.match(english, /Reasoning strength: &quot;Mid&quot; was asked for, this model has no such level, &quot;High&quot; was used/);
    assert.match(english, /The plugin collects and saves the results directly/);
    assert.doesNotMatch(english, HAN);
  });
});

test('"查看子代理" is drawn only when the host can open it (#211)', () => {
  const job = withHistory(3);
  assert.doesNotMatch(render(job), /查看子代理/, 'no host function: no link');
  assert.match(render(job, { openAgent }), /查看子代理/);
  assert.equal((render(job, { openAgent }).match(/查看子代理：校对/g) || []).length, 3, 'one link per task, naming its task');
  assert.doesNotMatch(render(running({ tasks: [{ ...finished(1), status: 'running', finishedAt: undefined }] })), /查看子代理/);
  assert.match(render(running({ tasks: [{ ...finished(1), status: 'running', finishedAt: undefined }] }), { openAgent }), /查看子代理/);
  assert.doesNotMatch(render(withHistory(2, { tasks: history(2).map(task => ({ ...task, childId: undefined })) }), { openAgent }), /查看子代理/, 'a task without a child has nothing to open');
});

test('what can be said about a sub-agent without opening it is on the card: input size, tokens, start of the answer (#213)', () => {
  const task = finished(1, { inputChars: 5800, tokenUsage: { input: 7000, output: 300 }, outputPreview: '{"corrections":[]}' });
  const page = render(withHistory(1, { tasks: [task] }), { openAgent });
  assert.match(page, /约 5,800 字的稿件窗口/);
  assert.match(page, /最近输出：\{&quot;corrections&quot;:\[\]\}/);
  assert.match(render(running({ tasks: [{ ...task, status: 'running', finishedAt: undefined }] }), { openAgent }), /输入约 5,800 字/);
});
