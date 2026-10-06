import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';

// WP-TC: the console renders the jobs of the snapshot as a list and the detail of one of them; every state has its words in both languages.
const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as TaskConsole } from './ui/tasks/TaskConsole.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

const iso = (minutes) => new Date(Date.UTC(2026, 9, 5, 10, minutes)).toISOString();
// Date.UTC takes whole seconds in its seconds slot, so a fractional second goes in as milliseconds.
const sec = (seconds) => new Date(Date.UTC(2026, 9, 5, 10, 0, Math.floor(seconds), Math.round((seconds % 1) * 1000))).toISOString();
const jobs = () => [
  { id: 'audio-1', type: 'audio-import', filename: 'API应用与产品策略培训 等 5 个录音', status: 'running', phase: 'proofread', done: 3, total: 9, startedAt: iso(2),
    members: [{ filename: 'a.mp3', status: 'complete', steps: { transcribe: { done: 1, total: 1 }, proofread: { done: 9, total: 9 }, translate: { done: 5, total: 5 } } },
      { filename: 'b.mp3', status: 'running', phase: 'proofread', steps: { transcribe: { done: 1, total: 1 }, proofread: { done: 3, total: 9 } } }],
    warnings: ['有 4 个文件扩展名是 .mp3，实际内容是 WAV'] },
  { id: 'gen-1', status: 'complete', kind: 'quiz', deckTitle: '架构的语境性', requestedTotal: 15, savedCount: 15, startedAt: iso(40), finishedAt: iso(50) },
  { id: 'pdf-1', type: 'pdf-convert', filename: 'Software Architecture.pdf', status: 'failed', phase: 'parse', done: 120, total: 412, stage: '密钥被拒（403）', startedAt: iso(20) },
];
const render = (extra = {}, language = 'zh') => {
  m.setUiLanguage(language);
  const html = renderToStaticMarkup(inApp(m, React.createElement(m.TaskConsole, { data: { jobs: jobs(), drafts: [], decks: [], ...extra }, openers: { resultOf: () => null } }),
    { data: { jobs: jobs() }, app: { lib: { taskFocus: null } } }));
  m.setUiLanguage('zh');
  return html;
};

test('the list has one row per job, newest first, with its state word and the filter counts', () => {
  const html = render();
  const order = [...html.matchAll(/class="[^"]*tc-row[^"]*"[^>]*data-task-id="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(order, ['gen-1', 'pdf-1', 'audio-1'], 'newest first by start time');
  assert.match(html, /全部 3/);
  assert.match(html, /进行中 1/);
  assert.match(html, /失败\/中断 1/);
  assert.match(html, /<h1>任务<\/h1>/);
});

test('the detail opens on the running job: header, overall progress with stage segments and four facts', () => {
  const html = render();
  const detail = html.slice(html.indexOf('class="tc-detail"'));
  assert.match(detail, /data-task-id="audio-1"/);
  assert.match(detail, /<h2>API应用与产品策略培训 等 5 个录音<\/h2>/);
  assert.match(detail, /aria-label="概览"/);
  assert.equal((detail.match(/class="tc-metric"/g) || []).length, 4, 'the four facts are always there, so nothing appears late');
  assert.equal((detail.match(/class="tc-segment"/g) || []).length, 4, 'transcribe, proofread, translate, save');
  assert.match(detail, /aria-label="转写 2\/2，校对 12\/18，翻译 5\/5，保存 0\/1"/);
  assert.match(detail, /停止/, 'a running job can be stopped');
  assert.doesNotMatch(detail, /知道了/, 'a running job cannot be dismissed');
});

test('a finished or failed job can be dismissed, not stopped, and says why it failed', () => {
  const html = render({ jobs: [jobs()[2]] });
  const detail = html.slice(html.indexOf('class="tc-detail"'));
  assert.match(detail, /知道了/);
  assert.doesNotMatch(detail, />停止</);
  assert.match(html, /密钥被拒（403）/);
});

test('a job with settled calls shows 实际用量 and DSH\'s two speed figures under its facts (WP27)', () => {
  // The console reads the job through its contract (ui/tasks/task-model.js), so a step's own firstOutputAt and
  // usage are all it takes: the wait before the first token and the writing after it are the job's own numbers.
  // 1.6 s to the first token twice (so the mean is 1.6 s) and 80 s of writing over 20,320 output tokens (254 tok/s).
  // 1.6 s to the first token twice (so the mean is 1.6 s) and 80 s of writing over 20,320 output tokens (254 tok/s).
  const measured = { id: 'gen-usage', type: 'generate', kind: 'quiz', status: 'complete', deckTitle: '带用量的出题', requestedTotal: 4, savedCount: 4,
    startedAt: sec(0), finishedAt: sec(120),
    tokenUsage: { uncachedInputTokens: 185616, outputTokens: 20320, cacheReadTokens: 2863104, cacheWriteTokens: 0, calls: 2 },
    steps: [
      { id: 's1', stage: 'Writing and self-checking questions', status: 'complete', startedAt: sec(0), firstOutputAt: sec(1.6), finishedAt: sec(41.6), part: 1,
        tokenUsage: { uncachedInputTokens: 90000, outputTokens: 10000, cacheReadTokens: 1400000, cacheWriteTokens: 0 } },
      { id: 's2', stage: 'Reviewing ambiguity and source support', status: 'complete', startedAt: sec(60), firstOutputAt: sec(61.6), finishedAt: sec(101.6), part: 1,
        tokenUsage: { uncachedInputTokens: 95616, outputTokens: 10320, cacheReadTokens: 1463104, cacheWriteTokens: 0 } }] };
  const html = render({ jobs: [measured] });
  const detail = html.slice(html.indexOf('class="tc-detail"'));
  assert.match(detail, /data-task-usage/);
  assert.match(detail, /data-task-timing/);
  assert.match(detail, /实际用量/);
  assert.match(detail, /185,616 tok/);
  assert.match(detail, /2,863,104 tok/);
  assert.match(detail, /20,320 tok/);
  assert.match(detail, /首 token 平均（TTFT）/);
  assert.match(detail, /1\.6秒/);
  assert.match(detail, /输出速度（TPS）/);
  assert.match(detail, /254 tok\/s/);
  assert.doesNotMatch(html, /[¥$￥]|价格|费用/);
  // A job that reported nothing keeps the same shape: no strip at all, rather than a row of dashes.
  const quiet = render({ jobs: [jobs()[1]] });
  assert.doesNotMatch(quiet, /data-task-usage|data-task-timing/);
  const en = render({ jobs: [measured] }, 'en');
  assert.match(en, /<dt>Avg time to first token \(TTFT\)<\/dt><dd>1\.6s<\/dd>/);
  assert.match(en, /<dt>Tokens per second \(TPS\)<\/dt><dd>254 tok\/s<\/dd>/);
  assert.match(en, /Actual usage/);
});

test('English: the same surface in the other language, no Chinese left in the chrome', () => {
  const html = render({}, 'en');
  assert.match(html, /<h1>Jobs<\/h1>/, 'the learner already has "Tasks" (待办): the console of background work is "Jobs" in English');
  assert.match(html, /All 3/);
  assert.match(html, /In progress 1/);
  assert.match(html, /Job detail/);
  const chrome = html.replace(/API应用与产品策略培训 等 5 个录音|架构的语境性|密钥被拒（403）/g, '');
  assert.doesNotMatch(chrome.replace(/<[^>]+>/g, ' ').replace(/aria-label="[^"]*"/g, ''), /[一-鿿]/);
});

test('nothing to show is said once, in the list, and the detail asks for a selection', () => {
  const html = render({ jobs: [] });
  assert.match(html, /现在没有任务/);
  assert.match(html, /选择左边的一个任务查看详情/);
});

test('a task interrupted by a restart is 已中断, not 失败: its own word, its own tone, and it says how to go on (2.6.2)', () => {
  const interrupted = { id: 'gen-2', type: 'generate', kind: 'quiz', status: 'interrupted', deckTitle: '被中断的出题', requestedTotal: 30, savedCount: 12, startedAt: iso(60), stage: '中断于第 3 轮' };
  const zh = render({ jobs: [interrupted] }, 'zh');
  assert.match(zh, /data-state="interrupted"/);
  assert.match(zh, /已中断/);
  assert.doesNotMatch(zh.slice(zh.indexOf('tc-row')), /tc-num" data-state="fail"/, 'not a failure');
  const en = render({ jobs: [interrupted] }, 'en');
  assert.match(en, /Interrupted/);
  assert.match(en, /Failed \/ interrupted/, 'the filter says both');
});
