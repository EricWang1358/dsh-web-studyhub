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
  export { default as OutputPanel, OutputView } from './ui/tasks/OutputPanel.jsx';
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
  waits: [{ id: 'w1', kind: 'wait', slot: 2, reason: 'rate-limit', startedAt: at(27), endedAt: at(31) }],
  events: [{ id: 'e1', at: at(5), level: 'done', tag: 'transcribe', code: 'milestone', args: { phase: 'transcribe', partial: false } }, { id: 'e2', at: at(21), level: 'warn', tag: null, code: 'rate-limit', args: { slot: 2, seconds: 4 } }],
  ...extra });
const contractOf = (job) => m.jobContract(job);

test('the timeline: a lane per file in order, a dashed wait on the file whose slot it was, every bar a named button', () => {
  const contract = contractOf(audioJob());
  const out = html(React.createElement(m.Timeline, { calls: contract.calls, running: false, family: 'audio', selected: 'b-p', onSelect: () => {} }));
  assert.match(out, /aria-label="并行时间线"/);
  for (const lane of ['file:a.wav', 'file:b.mp3']) assert.match(out, new RegExp(`data-lane="${lane.replace('.', '\.')}"`), lane);
  assert.doesNotMatch(out, /data-lane="(slot|transcribe)-/, 'the lanes are units of work, not pool slots');
  assert.doesNotMatch(out, /data-lane="other/, 'the wait found its file');
  const bLane = out.slice(out.indexOf('data-lane="file:b.mp3"'));
  assert.match(bLane, /data-wait="true"/, 'the wait is on the lane of b.mp3 (slot 2)');
  assert.doesNotMatch(out.slice(out.indexOf('data-lane="file:a.wav"'), out.indexOf('data-lane="file:b.mp3"')), /data-wait/);
  assert.equal((out.match(/class="[^"]*tc-callbar[^"]*"/g) || []).length, 4, 'one bar per call and wait');
  assert.match(out, /data-wait="true"/);
  assert.match(out, /aria-pressed="true"[^>]*aria-label="校对 2\/4 · b\.mp3"|aria-label="校对 2\/4 · b\.mp3"[^>]*aria-pressed="true"/);
  assert.match(out, /tc-lane__label"><span tabindex="0"[^>]*>a\.wav<\/span><span[^>]*role="tooltip"[^>]*>a\.wav</, 'the lane is named by its file, with the full name as a tooltip (reachable by keyboard)');
  assert.match(out, /title="校对 2\/4 · b\.mp3 · 槽 2"/, 'the bar says which slot it ran in');
  const en = html(React.createElement(m.Timeline, { calls: [{ ...contract.calls[0], file: undefined, part: 2, parts: 3 }, { ...contract.calls[0], callId: 'x', file: undefined, part: null }], running: false, family: 'generation', selected: null, onSelect: () => {} }), 'en');
  assert.match(en, />Whole run</);
  assert.match(en, />Batch 2</);
  const many = Array.from({ length: 30 }, (_, index) => ({ ...contract.calls[1], callId: `m${index}`, file: `f${index}.wav`, startedAt: at(index), endedAt: at(index + 1), status: 'ok' }));
  assert.match(html(React.createElement(m.Timeline, { calls: many, running: false, family: 'audio', onSelect: () => {} })), /另有 6 条/);
  assert.match(html(React.createElement(m.Timeline, { calls: many, running: false, family: 'audio', onSelect: () => {} }), 'en'), /6 more/);
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
  assert.doesNotMatch(ended, /输出不保留/, '2.6.1: the owner rejected "not kept": an ended call is read, not declared gone');
  assert.match(ended, /data-mode="ended"/);
  assert.match(ended, /正在读取这一步的输出/, 'static markup of an ended call: the one fetch has not answered yet');
  const live = contract.calls.find((call) => call.status === 'running');
  // The clock is fixed: five seconds into the call. (With the real clock the answer depends on when the test runs: the fixture's dates are today's.)
  const streaming = html(React.createElement(m.OutputView, { jobId: 'batch', record: live, active: true, view: { text: '', total: 0, reasoning: 0, supported: true, ended: false }, now: Date.parse(live.startedAt) + 5000 }));
  assert.match(streaming, /data-mode="stream"/);
  assert.match(streaming, /role="log"/);
  assert.match(streaming, /等待模型开始输出/);
  assert.match(streaming, /缓存最后约 8 KB/);
  assert.match(streaming, /结束后仍可回看/);
  assert.doesNotMatch(streaming, /输出不保留/);
});

// 2.6.1: what the panel says about an ended call, from what job.output answered (the view is a plain object, so static markup can show every state).
const endedCall = () => contractOf(audioJob()).calls.find((call) => call.kind === 'proofread' && call.status !== 'running');
const endedView = (extra) => ({ phase: 'ready', text: '', supported: true, source: null, partial: false, clipped: false, sessionUnreadable: false, ...extra });
const endedHtml = (extra, language = 'zh') => html(React.createElement(m.OutputView, { jobId: 'batch', record: endedCall(), active: true, view: endedView(extra), now: Date.parse(at(60)) }), language);

test('an ended call: its whole text from memory, the tail of a long one, a full reply read from the DSH session, and the honest nothing', () => {
  assert.ok(endedCall(), 'the sample job has an ended proofreading call');
  const whole = endedHtml({ text: 'All of it.', source: 'memory' });
  assert.match(whole, /data-mode="ended"/);
  assert.match(whole, /role="log"/);
  assert.match(whole, /All of it\./);
  assert.match(whole, /已结束 · 显示这一步写下的全部输出/);
  assert.equal(whole.includes('tc-output__caret'), false, 'nothing is being written any more');
  assert.doesNotMatch(whole, /输出不保留|等待模型开始输出/);

  const tail = endedHtml({ text: 'the end of a long reply', source: 'memory', partial: true });
  assert.match(tail, /已结束 · 显示最后约 8 KB/);
  assert.match(tail, /the end of a long reply/);

  const tailUnreadable = endedHtml({ text: 'the end', source: 'memory', partial: true, sessionUnreadable: true });
  assert.match(tailUnreadable, /已结束 · 显示最后约 8 KB/);
  assert.match(tailUnreadable, /DSH 会话读取不到，无法补全/);

  const session = endedHtml({ text: '{"a": 1}', source: 'session' });
  assert.match(session, /已结束 · 完整回复读取自 DSH 会话/);
  assert.doesNotMatch(session, /最后约 8 KB/);

  const clipped = endedHtml({ text: '{"a": 1}', source: 'session', clipped: true });
  assert.match(clipped, /完整回复读取自 DSH 会话/);
  assert.match(clipped, /回复很长，只显示前 200 KB/);

  const nothing = endedHtml({});
  assert.match(nothing, /已结束；这一步没有留下可读的输出/);
  assert.equal(nothing.includes('role="log"'), false, 'no empty console body for nothing');
  assert.match(endedHtml({ sessionUnreadable: true }), /DSH 会话读取不到/);

  assert.match(endedHtml({ phase: 'loading' }), /正在读取这一步的输出/);
  assert.match(endedHtml({ phase: 'error' }), /没能读取这一步的输出/);
});

test('an ended call in English: every new sentence has its translation', () => {
  assert.match(endedHtml({ text: 'x', source: 'memory', partial: true }, 'en'), /Ended · showing the last ~8 KB/);
  assert.match(endedHtml({ text: 'x', source: 'memory' }, 'en'), /Ended · showing everything this step wrote/);
  assert.match(endedHtml({ text: 'x', source: 'session' }, 'en'), /Ended · the full reply is read from the DSH session/);
  assert.match(endedHtml({ text: 'x', source: 'session', clipped: true }, 'en'), /reply is very long, showing the first 200 KB/);
  assert.match(endedHtml({ text: 'x', source: 'memory', partial: true, sessionUnreadable: true }, 'en'), /The DSH session cannot be read, so it cannot be completed/);
  assert.match(endedHtml({}, 'en'), /Ended; this step left no readable output/);
  assert.match(endedHtml({ phase: 'loading' }, 'en'), /Reading this step.{1,8}s output/);
  assert.match(endedHtml({ phase: 'error' }, 'en'), /Could not read this step.{1,8}s output/);
  for (const text of [endedHtml({}, 'en'), endedHtml({ text: 'x', source: 'session' }, 'en')]) assert.doesNotMatch(text, /[\u4e00-\u9fff]{3}/, 'no untranslated Chinese sentence');
});

test('JSON the model wrote is shown indented, finished or still streaming; other text as it was; the scroller and the caret stay', () => {
  const text = (markup) => markup.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"');
  const json = '{"issues":[{"id":"q1","problem":"Too vague"}],"verdict":"repair"}';
  const done = endedHtml({ text: json, source: 'memory' });
  assert.match(done, /tc-json__key/);
  assert.equal(text(done).includes(json), false, 'the dense one-line text is gone');
  assert.ok(text(done).includes('{\n  "issues": [\n    {\n      "id": "q1",\n      "problem": "Too vague"\n    }\n  ],\n  "verdict": "repair"\n}'), 'indented by structure');
  const live = contractOf(audioJob()).calls.find((call) => call.status === 'running');
  const streaming = html(React.createElement(m.OutputView, { jobId: 'batch', record: live, active: true, view: { phase: 'ready', text: '{"issues":[{"id":"q1","prob', total: 25, reasoning: 0, supported: true, source: null }, now: Date.parse(at(60)) }));
  assert.match(streaming, /role="log"/);
  assert.match(streaming, /tc-output__caret/);
  assert.ok(text(streaming).includes('{\n  "issues": [\n    {\n      "id": "q1",\n      "prob'), 'a text still being written is indented too');
  const prose = endedHtml({ text: 'Plain words, [1] and {x}.', source: 'memory' });
  assert.match(prose, /Plain words, \[1\] and \{x\}\./);
  assert.equal(prose.includes('tc-json__'), false);
  const hostile = endedHtml({ text: '{"a":"<img src=x onerror=alert(1)>"}', source: 'memory' });
  assert.equal(hostile.includes('<img'), false, 'text is text, never markup');
});

test('a panel opened late (the host keeps the last ~8 KB) starts mid-JSON: the tail is still laid out by structure, running or ended', () => {
  const text = (markup) => markup.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"');
  const tail = 'ough to see it","citations":[{"sourceId":"src-1","quote":"a b"}],"answerability":{"mode":"recall"}}]}';
  const live = contractOf(audioJob()).calls.find((call) => call.status === 'running');
  const streaming = html(React.createElement(m.OutputView, { jobId: 'batch', record: live, active: true, view: { phase: 'ready', text: tail, total: 20000, reasoning: 0, supported: true, source: null }, now: Date.parse(at(60)) }));
  assert.ok(text(streaming).includes('\n  "citations": ['), 'running, text shorter than what was written: a fragment');
  assert.match(streaming, /tc-json__key/);
  const whole = html(React.createElement(m.OutputView, { jobId: 'batch', record: live, active: true, view: { phase: 'ready', text: tail, total: tail.length, reasoning: 0, supported: true, source: null }, now: Date.parse(at(60)) }));
  assert.equal(text(whole).includes('\n  "citations"'), false, 'the whole text of a call is not a fragment: nothing to resync');
  const endedTail = endedHtml({ text: tail, source: 'memory', partial: true });
  assert.ok(text(endedTail).includes('\n  "citations": ['), 'ended, only the tail kept: a fragment too');
  assert.match(endedTail, /已结束 · 显示最后约 8 KB/);
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
