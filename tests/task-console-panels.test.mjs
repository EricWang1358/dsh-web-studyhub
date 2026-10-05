import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';

// WP-TC: the console's panels, drawn from a contract: timeline, calls in flight, files, parts, output, log. Static markup, both languages.
const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as Timeline } from './ui/tasks/Timeline.jsx';
  export { default as RunningCalls } from './ui/tasks/RunningCalls.jsx';
  export { default as AudioFiles } from './ui/tasks/AudioFiles.jsx';
  export { default as GenerationParts } from './ui/tasks/GenerationParts.jsx';
  export { default as OutputPanel } from './ui/tasks/OutputPanel.jsx';
  export { default as LogPanel, noticeLine } from './ui/tasks/LogPanel.jsx';
  export { default as TaskConsole } from './ui/tasks/TaskConsole.jsx';
  export { jobContract } from './lib/job-contract.js';
  export { setUiLanguage } from './ui/i18n.js';
`);
const at = (seconds) => new Date(Date.UTC(2026, 9, 5, 10, 0, seconds)).toISOString();
const html = (element, language = 'zh') => {
  m.setUiLanguage(language);
  try { return renderToStaticMarkup(inApp(m, element, { data: {}, app: { lib: { taskFocus: null }, host: {} } })); } finally { m.setUiLanguage('zh'); }
};
const audioJob = (extra = {}) => ({ id: 'attempt', type: 'audio-import', batchId: 'batch', filename: 'Week 3', status: 'running', phase: 'proofread', startedAt: at(0),
  warnings: ['b.mp3：文件扩展名是 .mp3，实际内容是 WAV 格式，已按 WAV 处理'],
  members: [
    { filename: 'a.wav', status: 'complete', phase: 'done', steps: { transcribe: { done: 1, total: 1 }, proofread: { done: 4, total: 4 }, translate: { done: 2, total: 2 } },
      tasks: [{ id: 'a-t', kind: 'transcribe', status: 'complete', runtime: 'gemini', startedAt: at(1), finishedAt: at(9) }, { id: 'a-p', kind: 'proofread', part: 1, parts: 4, status: 'complete', runtime: 'subagent', slot: 1, startedAt: at(10), finishedAt: at(30) }] },
    { filename: 'b.mp3', status: 'running', phase: 'proofread', warnings: ['文件扩展名是 .mp3，实际内容是 WAV 格式，已按 WAV 处理'], steps: { transcribe: { done: 1, total: 1 }, proofread: { done: 1, total: 4 } },
      tasks: [{ id: 'b-p', kind: 'proofread', part: 2, parts: 4, status: 'running', runtime: 'subagent', slot: 2, childId: 'child-1', startedAt: at(31), reasoning: 'high' }] }],
  waits: [{ id: 'w1', kind: 'wait', slot: 2, reason: 'rate-limit', startedAt: at(20), endedAt: at(24) }],
  events: [{ id: 'e1', at: at(5), level: 'done', tag: 'transcribe', code: 'milestone', args: { phase: 'transcribe', partial: false } }, { id: 'e2', at: at(21), level: 'warn', tag: null, code: 'rate-limit', args: { slot: 2, seconds: 4 } }],
  ...extra });
const contractOf = (job) => m.jobContract(job);

test('the timeline: a lane per slot, transcription apart, a dashed wait, every bar a named button', t => {
  // Keep the fixture within the running timeline's ten-minute window on every date.
  t.mock.method(Date, 'now', () => Date.parse(at(40)));
  const contract = contractOf(audioJob());
  const out = html(React.createElement(m.Timeline, { calls: contract.calls, running: true, family: 'audio', selected: 'b-p', onSelect: () => {} }));
  assert.match(out, /aria-label="并行时间线"/);
  for (const lane of ['transcribe-1', 'slot-1', 'slot-2']) assert.match(out, new RegExp(`data-lane="${lane}"`), lane);
  assert.doesNotMatch(out, /data-lane="slot-3"/);
  assert.equal((out.match(/class="[^"]*tc-callbar[^"]*"/g) || []).length, 4, 'one bar per call and wait');
  assert.match(out, /data-wait="true"/);
  assert.match(out, /aria-pressed="true"[^>]*aria-label="校对 2\/4 · b\.mp3"|aria-label="校对 2\/4 · b\.mp3"[^>]*aria-pressed="true"/);
  assert.match(out, />槽 1</);
  assert.match(html(React.createElement(m.Timeline, { calls: [], running: true, family: 'audio', onSelect: () => {} })), /还没有模型调用/);
});

test('the list of calls in flight shows what runs, for how long and by whom; an ended job says there is nothing', () => {
  const contract = contractOf(audioJob());
  const out = html(React.createElement(m.RunningCalls, { calls: contract.calls, active: true, selected: null, onSelect: () => {} }));
  assert.equal((out.match(/data-call-id=/g) || []).length, 1, 'only the call that is running');
  assert.match(out, /校对 2\/4 · b\.mp3/);
  assert.match(out, /DSH 子代理 · 推理 高/);
  assert.match(html(React.createElement(m.RunningCalls, { calls: [], active: false, onSelect: () => {} })), /任务已经结束，没有正在进行的调用/);
});

test('the files: a row per recording with its three bars, a 实为 WAV badge on its own row, and a fixed strip for the one picked', () => {
  const contract = contractOf(audioJob());
  const out = html(React.createElement(m.AudioFiles, { contract }));
  assert.equal((out.match(/data-file="/g) || []).length, 2);
  const b = out.slice(out.indexOf('data-file="b.mp3"'));
  assert.match(b, /实为 WAV/);
  assert.doesNotMatch(out.slice(0, out.indexOf('data-file="b.mp3"')), /实为 WAV/, 'the other file carries no badge');
  assert.equal((out.match(/tc-cells/g) || []).length, 2);
  assert.match(out, /class="tc-strip"/);
  assert.match(out, /选一个文件/);
  const single = out.length && html(React.createElement(m.AudioFiles, { contract: contractOf(audioJob({ members: undefined, warnings: [], filename: 'only.wav', steps: { transcribe: { done: 1, total: 1 }, proofread: { done: 1, total: 3 } } })) }));
  assert.equal((single.match(/data-file="/g) || []).length, 1, 'a recording on its own is one row');
  assert.match(single, /only\.wav/);
  assert.match(single, /转写 1\/1 · 校对 1\/3/, 'and the one row is already picked: the strip shows its stages');
  assert.match(html(React.createElement(m.AudioFiles, { contract }), 'en'), /actually WAV/);
});

test('the parts of a question run: stage cells per part and the calls of the picked one', () => {
  const contract = contractOf({ id: 'g', status: 'running', deckTitle: 'Deck', requestedTotal: 10, savedCount: 2, parts: 2, startedAt: at(0), steps: [
    { id: 'a', stage: 'Writing and self-checking questions', part: 1, status: 'complete', startedAt: at(1), finishedAt: at(11) }, { id: 'r', stage: 'Reviewing ambiguity and source support', part: 1, status: 'running', startedAt: at(12) }] });
  const out = html(React.createElement(m.GenerationParts, { contract }));
  assert.equal((out.match(/data-part="/g) || []).length, 2);
  assert.match(out, /data-stage="author" data-state="ok"/);
  assert.match(out, /data-stage="review" data-state="running"/);
  assert.match(out, /data-part="2"[\s\S]*等待中/);
});

test('the log: newest first, a filter with its count, the notices as one fixed line and a switch that follows the latest', () => {
  const contract = contractOf(audioJob());
  const out = html(React.createElement(m.LogPanel, { contract }));
  assert.match(out, /aria-label="日志筛选"/);
  assert.match(out, /提醒 1/);
  assert.match(out, /里程碑 1/);
  assert.match(out, /跟随最新/);
  assert.equal((out.match(/class="tc-log__notice"/g) || []).length, 1, 'ONE notice line, never a list');
  assert.match(out, /1 个文件的扩展名与实际格式不符（实为 WAV）/);
  assert.equal(out.includes('b.mp3'), false, 'the file is named on its own row, not in the log');
  assert.ok(out.indexOf('槽 2 被限流') < out.indexOf('转写全部完成'), 'newest first');
  assert.equal(m.noticeLine(contractOf(audioJob({ warnings: [], members: undefined }))), '');
  assert.match(html(React.createElement(m.LogPanel, { contract: contractOf(audioJob({ members: undefined, warnings: [] })) })), /没有提醒/);
  assert.match(html(React.createElement(m.LogPanel, { contract }), 'en'), /Follow latest/);
});

test('the output: no call, a call that cannot write on the way, and one that can', () => {
  const contract = contractOf(audioJob());
  const idle = html(React.createElement(m.OutputPanel, { jobId: 'batch', call: null, active: true }));
  assert.match(idle, /点「正在进行」里的一行/);
  const gemini = contract.calls.find((call) => call.kind === 'transcribe');
  const quiet = html(React.createElement(m.OutputPanel, { jobId: 'batch', call: { ...gemini, status: 'running', endedAt: null }, active: true }));
  assert.match(quiet, /不提供中间输出/);
  assert.match(quiet, /data-mode="none"/);
  const ended = html(React.createElement(m.OutputPanel, { jobId: 'batch', call: gemini, active: true }));
  assert.match(ended, /输出不保留/);
  const live = contract.calls.find((call) => call.status === 'running');
  const streaming = html(React.createElement(m.OutputPanel, { jobId: 'batch', call: live, active: true }));
  assert.match(streaming, /data-mode="stream"/);
  assert.match(streaming, /role="log"/);
  assert.match(streaming, /等待模型开始输出/);
  assert.match(streaming, /只显示最后约 8 KB/);
});

test('the console puts the two columns under the controls, with the kind\'s own tab, and a full-screen switch in the header', () => {
  const job = audioJob();
  const out = html(React.createElement(m.TaskConsole, { data: { jobs: [job], drafts: [], decks: [] }, openers: { resultOf: () => null } }));
  assert.match(out, /aria-label="左侧面板"/);
  assert.match(out, /aria-label="右侧面板"/);
  assert.match(out, /正在进行 1/);
  assert.match(out, /文件 2/);
  assert.match(out, />实时输出</);
  assert.match(out, />日志</);
  assert.match(out, /aria-pressed="false"[^>]*>全屏/);
  assert.match(out, /data-full="false"/);
  assert.equal((out.match(/class="tc-col"/g) || []).length, 2);
  // the output of the call in flight is the one shown first
  assert.match(out, /校对 2\/4 · b\.mp3/);
});
