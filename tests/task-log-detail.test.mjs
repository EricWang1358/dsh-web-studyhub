import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';

// The 日志 tab says which batch a call line belongs to and, from the counts the contract carries, how many questions the batch was asked for and kept.
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

// Four batches running in parallel: their lines interleave in the log.
const parallel = () => ({ detail: { parts: 4, partList: [{ part: 1, asked: 10, kept: 10 }, { part: 2, asked: 10, kept: 7 }, { part: 3 }, { part: 4 }] }, calls: [
  call('a2', 'author', 0, 256, { part: 2 }), call('a3', 'author', 1, 200, { part: 3 }), call('r2', 'review', 260, 392, { part: 2 }), call('x2', 'repair', 400, 462, { part: 2 }),
  call('a1', 'author', 0, 100, { part: 1, parts: 4 }), call('p', 'plan', 0, 5)] });

test('a call of a question run says WHICH batch it is, with the total when the job knows it', () => {
  const contract = parallel();
  assert.equal(lineOf(contract, 'a2').detail, '第 2/4 批 · 要求 10 道', 'the total comes from the job when the call does not carry it');
  assert.equal(lineOf(contract, 'a3').detail, '第 3/4 批', 'the batch has not reported: no count is invented');
  assert.equal(lineOf(contract, 'a1').detail, '第 1/4 批 · 要求 10 道');
  assert.equal(lineOf({ ...contract, detail: { ...contract.detail, parts: null } }, 'a3').detail, '第 3 批', 'no total anywhere: just the batch');
  assert.equal(lineOf(contract, 'p').detail, undefined, 'a call of the whole run (no batch) has no second line');
  const text = lineOf(contract, 'a2').text;
  assert.match(text, /^出题与自查 完成 · 4 分 16 秒$/, 'the step name, the word and the duration stay as they were');
  assert.doesNotMatch(text, /\d+\/\d+/, 'the batch is on the second line, not repeated in the name');
});

test('what the batch kept is said once, on the last review or repair call of that batch', () => {
  const contract = parallel();
  assert.equal(lineOf(contract, 'r2').detail, '第 2/4 批', 'a repair came after: this review is not the end of the batch');
  assert.equal(lineOf(contract, 'x2').detail, '第 2/4 批 · 留下 7/10 道');
  const noRepair = { ...contract, calls: contract.calls.filter((one) => one.callId !== 'x2') };
  assert.equal(lineOf(noRepair, 'r2').detail, '第 2/4 批 · 留下 7/10 道');
  assert.equal(lineOf({ ...contract, detail: { ...contract.detail, partList: [{ part: 2 }] } }, 'x2').detail, '第 2/4 批', 'not reported yet: nothing about counts');
});

test('a coverage run names the round, and counts are only taken from the round whose parts the list describes', () => {
  const calls = [call('old', 'author', 0, 50, { part: 1, round: 1 }), call('new', 'author', 60, 90, { part: 1, round: 2 }), call('newr', 'review', 91, 120, { part: 1, round: 2 })];
  const contract = { detail: { parts: 2, run: { round: 2 }, partList: [{ part: 1, asked: 6, kept: 5 }, { part: 2 }] }, calls };
  assert.equal(lineOf(contract, 'old').detail, '第 1 轮 · 第 1/2 批', 'the list describes round 2: round 1 gets no counts');
  assert.equal(lineOf(contract, 'new').detail, '第 2 轮 · 第 1/2 批 · 要求 6 道');
  assert.equal(lineOf(contract, 'newr').detail, '第 2 轮 · 第 1/2 批 · 留下 5/6 道');
});

test('a retry, a failure and a reused call keep their words; nothing about model, reasoning, runner or tokens is on any line', () => {
  const calls = [call('r', 'review', 0, 81, { part: 1, retry: 1 }), call('f', 'author', 0, 3, { part: 2, status: 'failed', error: '模型请求太频繁，被限流了' }), call('c', 'repair', 0, 3, { part: 3, status: 'cancelled' })];
  const contract = { detail: { parts: 3, partList: [] }, calls };
  assert.match(lineOf(contract, 'r').text, /独立审阅 · 第 1 次重新审阅 完成 · 1 分 21 秒/);
  assert.match(lineOf(contract, 'f').text, /出题与自查 失败.*原因：.*模型请求太频繁/);
  assert.equal(lineOf(contract, 'f').detail, '第 2/3 批');
  assert.match(lineOf(contract, 'c').text, /修复题目 已取消/);
  for (const one of calls) {
    const line = lineOf(contract, one.callId);
    assert.doesNotMatch(`${line.text} ${line.detail ?? ''}`, /推理|DSH|子代理|直接模型|tok|35,329|undefined|null/, one.callId);
  }
});

test('unknown fields leave no junk: no part, no counts, odd values', () => {
  const bare = call('b', 'review', 0, 5, { runner: null, reasoning: null, tokens: null });
  assert.equal(lineOf({ calls: [bare] }, 'b').detail, undefined);
  assert.equal(lineOf({ calls: [bare] }, 'b').text, '独立审阅 完成 · 5 秒');
  const odd = call('o', 'author', 0, 5, { part: 'x' });
  assert.equal(lineOf({ calls: [odd], detail: { parts: 2, partList: [{ part: 1, asked: null, kept: undefined }] } }, 'o').detail, undefined, 'a part that is not a number names no batch');
  const outOfRange = call('n', 'author', 0, 5, { part: 3 });
  assert.equal(lineOf({ calls: [outOfRange], detail: { parts: 2, partList: [] } }, 'n').detail, '第 3 批', 'a number past the total is not shown as 3/2');
  const half = call('h', 'review', 0, 5, { part: 1 });
  assert.equal(lineOf({ calls: [half], detail: { parts: 1, partList: [{ part: 1, asked: 5, kept: 0 }] } }, 'h').detail, '第 1 批 · 留下 0/5 道', 'zero kept is a count worth saying');
  for (const contract of [{ calls: [bare, odd, outOfRange, half], detail: { parts: 2, partList: [{ part: 1, asked: null }] } }, { calls: [bare] }])
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
    assert.equal(lineOf(parallel(), 'a2').detail, 'Batch 2/4 · asked for 10');
    assert.equal(lineOf(parallel(), 'x2').detail, 'Batch 2/4 · kept 7 of 10');
    assert.equal(lineOf({ detail: { parts: 2, run: { round: 2 }, partList: [] }, calls: [call('n', 'author', 0, 5, { part: 1, round: 2 })] }, 'n').detail, 'Round 2 · Batch 1/2');
  } finally { m.setUiLanguage('zh'); }
});

test('the log draws the second line in a slot of its own, only for a call that has a batch, and never inside the text', () => {
  const contract = { ...parallel(), status: 'running', events: [] };
  const out = html(React.createElement(m.LogPanel, { contract }));
  assert.equal((out.match(/class="tc-line__detail"/g) || []).length, 5, 'one second line for each of the five calls that belong to a batch, none for the plan call');
  assert.match(out, /<span class="tc-line__detail"[^>]*>第 2\/4 批 · 留下 7\/10 道<\/span>/);
  assert.match(out, /<span class="tc-line__text">出题与自查 完成 · 4 分 16 秒<\/span>/);
  assert.doesNotMatch(out, /推理|DSH 子代理|tok/);
  const en = html(React.createElement(m.LogPanel, { contract }), 'en');
  assert.match(en, /Batch 2\/4 · kept 7 of 10/);
  assert.match(html(React.createElement(m.LogPanel, { contract: { calls: [], events: [], detail: {} } })), /还没有日志/);
});
