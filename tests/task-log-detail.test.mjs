import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';

// The 日志 tab says which batch a call line belongs to and the question counts the call recorded (lib/call-counts.js): what the writing was asked for and wrote, how many
// cards a review judged / passed / flagged, how many a repair re-worded and how many of those the following re-review passed.
// It does NOT say which model, reasoning level, runner or token usage a call had (the 实时输出 header is the place for those).
const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export * from './ui/tasks/call-model.js';
  export { default as LogPanel } from './ui/tasks/LogPanel.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

const at = (seconds) => new Date(Date.UTC(2026, 9, 5, 10, 0, seconds)).toISOString();
const call = (callId, kind, from, to, extra = {}) => ({ callId, jobId: 'j', stepKey: kind, kind, stage: null, slot: null, startedAt: at(from), endedAt: to === null ? null : at(to),
  status: to === null ? 'running' : 'ok', runner: 'subagent', childId: null, parentId: null, part: null, parts: null, reasoning: 'low', tokens: 35329, ...extra });
const lineOf = (contract, id) => m.logLines({ events: [], ...contract }, 'all').find((line) => line.id === `call:${id}`);
const html = (element, language = 'zh') => {
  m.setUiLanguage(language);
  try { return renderToStaticMarkup(inApp(m, element, { data: {}, app: { lib: { taskFocus: null }, host: {} } })); } finally { m.setUiLanguage('zh'); }
};

// Four batches running in parallel: their lines interleave in the log. Batch 2 wrote 9 of the 10 asked for, the review flagged 3, the repair re-worded 3 and the re-review passed 2.
const parallel = () => ({ detail: { parts: 4, partList: [{ part: 1, asked: 10, kept: 10 }, { part: 2, asked: 10, kept: 8 }, { part: 3 }, { part: 4 }] }, calls: [
  call('a2', 'author', 0, 256, { part: 2, counts: { written: 9 } }), call('a3', 'author', 1, 200, { part: 3 }), call('r2', 'review', 260, 392, { part: 2, counts: { reviewed: 9, passed: 6, flagged: 3 } }),
  call('x2', 'repair', 400, 462, { part: 2, counts: { rewritten: 3 } }), call('rr2', 'review', 465, 500, { part: 2, retry: 1, counts: { reviewed: 3, passed: 2, flagged: 1 } }),
  call('a1', 'author', 0, 100, { part: 1, parts: 4, counts: { written: 10 } }), call('p', 'plan', 0, 5)] });

test('a call of a question run says WHICH batch it is, with the total when the job knows it', () => {
  const contract = parallel();
  assert.equal(lineOf(contract, 'a3').detail, '第 3/4 批', 'the batch has not reported and the call has no counts: only the batch');
  assert.equal(lineOf({ ...contract, detail: { ...contract.detail, parts: null } }, 'a3').detail, '第 3 批', 'no total anywhere: just the batch');
  assert.equal(lineOf(contract, 'p').detail, undefined, 'a call of the whole run (no batch, no counts) has no second line');
  const text = lineOf(contract, 'a2').text;
  assert.match(text, /^出题与自查 完成 · 4 分 16 秒$/, 'the step name, the word and the duration stay as they were');
  assert.doesNotMatch(text, /\d+\/\d+/, 'the batch is on the second line, not repeated in the name');
});

test('the writing says how many questions it was asked for and how many it wrote', () => {
  const contract = parallel();
  assert.equal(lineOf(contract, 'a2').detail, '第 2/4 批 · 要求 10 道 · 写出 9 道');
  assert.equal(lineOf(contract, 'a1').detail, '第 1/4 批 · 要求 10 道 · 写出 10 道');
  const unreported = { ...contract, detail: { ...contract.detail, partList: [] } };
  assert.equal(lineOf(unreported, 'a2').detail, '第 2/4 批 · 写出 9 道', 'asked for is only said when the run has reported it');
});

test('a review says how many cards it judged, how many passed and how many it flagged; a re-review counts its own cards', () => {
  const contract = parallel();
  assert.equal(lineOf(contract, 'r2').detail, '第 2/4 批 · 审了 9 道 · 通过 6 · 未通过 3');
  assert.equal(lineOf(contract, 'rr2').detail, '第 2/4 批 · 审了 3 道 · 通过 2 · 未通过 1', 'the repaired cards only, not the whole batch');
  assert.match(lineOf(contract, 'rr2').text, /独立审阅 · 第 1 次重新审阅 完成/);
  assert.equal(lineOf({ ...contract, calls: [call('z', 'review', 0, 5, { part: 1, counts: { reviewed: 4, passed: 4, flagged: 0 } })] }, 'z').detail, '第 1/4 批 · 审了 4 道 · 通过 4 · 未通过 0', 'none flagged is a count worth saying');
});

test('a repair says how many cards it re-worded and, once the review after it has run, how many of those passed', () => {
  const contract = parallel();
  assert.equal(lineOf(contract, 'x2').detail, '第 2/4 批 · 重写 3 道 · 通过 2');
  const waiting = { ...contract, calls: contract.calls.filter((one) => one.callId !== 'rr2') };
  assert.equal(lineOf(waiting, 'x2').detail, '第 2/4 批 · 重写 3 道', 'the review after it has not ended or recorded counts: no pass count is invented');
  const other = { ...contract, calls: [...waiting.calls, call('r3', 'review', 470, 480, { part: 3, counts: { reviewed: 5, passed: 5, flagged: 0 } }), call('old', 'review', 100, 120, { part: 2, counts: { reviewed: 9, passed: 9, flagged: 0 } })] };
  assert.equal(lineOf(other, 'x2').detail, '第 2/4 批 · 重写 3 道', 'another batch, or a review from before the repair, is not its re-review');
});

test('a coverage run names the round; the batch totals of the list only apply to the round it describes', () => {
  const calls = [call('old', 'author', 0, 50, { part: 1, round: 1, counts: { written: 6 } }), call('new', 'author', 60, 90, { part: 1, round: 2, counts: { written: 5 } }), call('newr', 'review', 91, 120, { part: 1, round: 2 })];
  const contract = { detail: { parts: 2, run: { round: 2 }, partList: [{ part: 1, asked: 6, kept: 5 }, { part: 2 }] }, calls };
  assert.equal(lineOf(contract, 'old').detail, '第 1 轮 · 第 1/2 批 · 写出 6 道', 'the list describes round 2: round 1 gets no asked count');
  assert.equal(lineOf(contract, 'new').detail, '第 2 轮 · 第 1/2 批 · 要求 6 道 · 写出 5 道');
  assert.equal(lineOf(contract, 'newr').detail, '第 2 轮 · 第 1/2 批');
});

test('a retry, a failure and a cancel keep their words; nothing about model, reasoning, runner or tokens is on any line', () => {
  const calls = [call('r', 'review', 0, 81, { part: 1, retry: 1 }), call('f', 'author', 0, 3, { part: 2, status: 'failed', error: '模型请求太频繁，被限流了' }), call('c', 'repair', 0, 3, { part: 3, status: 'cancelled' })];
  const contract = { detail: { parts: 3, partList: [] }, calls };
  assert.match(lineOf(contract, 'r').text, /独立审阅 · 第 1 次重新审阅 完成 · 1 分 21 秒/);
  assert.match(lineOf(contract, 'f').text, /出题与自查 失败.*原因：.*模型请求太频繁/);
  assert.equal(lineOf(contract, 'f').detail, '第 2/3 批');
  assert.match(lineOf(contract, 'c').text, /修复题目 已取消/);
  for (const one of [...calls, ...parallel().calls]) {
    const line = lineOf(one.callId === 'r' || one.callId === 'f' || one.callId === 'c' ? contract : parallel(), one.callId);
    assert.doesNotMatch(`${line.text} ${line.detail ?? ''}`, /推理|DSH|子代理|直接模型|tok|35,329|undefined|null/, one.callId);
  }
});

test('unknown fields leave no junk: no part, no counts, odd values', () => {
  const bare = call('b', 'review', 0, 5, { runner: null, reasoning: null, tokens: null });
  assert.equal(lineOf({ calls: [bare] }, 'b').detail, undefined);
  assert.equal(lineOf({ calls: [bare] }, 'b').text, '独立审阅 完成 · 5 秒');
  const odd = call('o', 'author', 0, 5, { part: 'x', counts: { written: 'many' } });
  assert.equal(lineOf({ calls: [odd], detail: { parts: 2, partList: [{ part: 1, asked: null, kept: undefined }] } }, 'o').detail, undefined, 'a part that is not a number and a count that is not a number say nothing');
  const outOfRange = call('n', 'author', 0, 5, { part: 3 });
  assert.equal(lineOf({ calls: [outOfRange], detail: { parts: 2, partList: [] } }, 'n').detail, '第 3 批', 'a number past the total is not shown as 3/2');
  const counted = call('k', 'review', 0, 5, { counts: { reviewed: 2 } });
  assert.equal(lineOf({ calls: [counted] }, 'k').detail, '审了 2 道', 'a count without a batch (a plain run) still shows, and only the figures it has');
  assert.equal(lineOf({ calls: [call('w', 'author', 0, 5, { part: 1, counts: { written: 0 } })] }, 'w').detail, '第 1 批 · 写出 0 道');
  for (const contract of [{ calls: [bare, odd, outOfRange, counted], detail: { parts: 2, partList: [{ part: 1, asked: null }] } }, { calls: [bare] }])
    for (const line of m.logLines({ events: [], ...contract }, 'all')) assert.doesNotMatch(`${line.text} ${line.detail ?? ''}`, /undefined|null|NaN|·\s*$|^\s*·/);
});

test('audio calls keep their own wording: a part there is a segment (校对 5/9), never a batch', () => {
  const audio = call('a', 'proofread', 0, 41, { part: 5, parts: 9, file: 'a.wav' });
  const line = lineOf({ calls: [audio] }, 'a');
  assert.match(line.text, /校对 5\/9 · a\.wav 完成 · 41 秒/);
  assert.equal(line.detail, undefined);
});

test('English', () => {
  m.setUiLanguage('en');
  try {
    assert.equal(lineOf(parallel(), 'a2').detail, 'Batch 2/4 · asked for 10 · wrote 9');
    assert.equal(lineOf(parallel(), 'r2').detail, 'Batch 2/4 · reviewed 9 · passed 6 · not passed 3');
    assert.equal(lineOf(parallel(), 'x2').detail, 'Batch 2/4 · re-wrote 3 · passed 2');
    assert.equal(lineOf({ detail: { parts: 2, run: { round: 2 }, partList: [] }, calls: [call('n', 'author', 0, 5, { part: 1, round: 2 })] }, 'n').detail, 'Round 2 · Batch 1/2');
  } finally { m.setUiLanguage('zh'); }
});

test('the log draws the second line in a slot of its own, one line cut with an ellipsis, only for a call that has something to say', () => {
  const contract = { ...parallel(), status: 'running', events: [] };
  const out = html(React.createElement(m.LogPanel, { contract }));
  assert.equal((out.match(/class="tc-line__detail"/g) || []).length, 6, 'one second line for each of the six calls with a batch, none for the plan call');
  assert.match(out, /<span class="tc-line__detail"[^>]*>第 2\/4 批 · 审了 9 道 · 通过 6 · 未通过 3<\/span>/);
  assert.match(out, /<span class="tc-line__text">出题与自查 完成 · 4 分 16 秒<\/span>/);
  assert.doesNotMatch(out, /推理|DSH 子代理|tok/);
  const en = html(React.createElement(m.LogPanel, { contract }), 'en');
  assert.match(en, /Batch 2\/4 · reviewed 9 · passed 6 · not passed 3/);
  assert.match(html(React.createElement(m.LogPanel, { contract: { calls: [], events: [], detail: {} } })), /还没有日志/);
});
