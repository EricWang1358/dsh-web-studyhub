import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

// UI wave 3 · WP-P (#173): the home's 今天先做什么 block folds to one hairline row, is remembered per browser, has no heavy
// box, one adjust menu, a real ProgressBar, and gives the home's one filled primary to the today card.
const { DailyPlan, setUiLanguage } = await loadUi(`export { default as DailyPlan } from './ui/DailyPlan.jsx'; export { setUiLanguage } from './ui/i18n.js';`);
const noop = () => {};
const controls = { busy: '', error: '', suggest: noop, accept: noop, saveProfile: noop, start: noop, complete: noop, refresh: noop };
const tasks = [
  { id: 'done', title: '已完成的阅读', kind: 'reading', minutes: 10, status: 'done' },
  { id: 'active', title: '继续练习概率', kind: 'practice', minutes: 20, status: 'doing', progress: { done: 2, total: 5 } },
];
const state = { date: '2026-10-04', budgetMinutes: 40, spentMinutes: 18, profile: { weekdayMinutes: 30, weekendMinutes: 40 }, tasks, proposal: null };
const withStorage = (stored, run) => {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const data = new Map(Object.entries(stored));
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => data.has(key) ? data.get(key) : null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) } });
  try { return run(data); } finally { if (before) Object.defineProperty(globalThis, 'localStorage', before); else delete globalThis.localStorage; }
};
const render = (props, language = 'zh') => { setUiLanguage(language); try { return renderToStaticMarkup(React.createElement(DailyPlan, { plan: { ...controls, state }, ...props })); } finally { setUiLanguage('zh'); } };
const tag = (html, pattern) => html.match(new RegExp(`<[a-z]+ [^>]*${pattern}[^>]*>`))?.[0] || '';
const open = props => withStorage({ 'study-daily-plan:open': 'true' }, () => render(props));

test('collapsed by default: one row with the heading, the minutes left and the next step, and a named toggle', () => {
  const html = withStorage({}, () => render({}));
  const toggle = tag(html, 'sh-disclosure-toggle');
  assert.match(toggle, /aria-expanded="false"/);
  assert.match(toggle, /aria-label="展开 今天先做什么"/);
  assert.match(toggle, /aria-controls=/);
  assert.match(html, /今天先做什么/);
  assert.match(html, /今天剩余约 22 分钟/);
  assert.match(html, /下一步：继续练习概率/);
  assert.match(html, /<div[^>]*class="daily-plan__body"[^>]*hidden=""/, 'the body stays out of the page and the accessibility tree');
  assert.doesNotMatch(html.replace(/<div[^>]*class="daily-plan__body"[\s\S]*$/, ''), /sh-btn--primary|<progress/);
});

test('the open state is remembered per browser', () => {
  const html = open({});
  assert.match(tag(html, 'sh-disclosure-toggle'), /aria-expanded="true"/);
  assert.match(tag(html, 'sh-disclosure-toggle'), /aria-label="收起 今天先做什么"/);
  assert.doesNotMatch(html, /class="daily-plan__body"[^>]*hidden/);
  assert.match(html, /data-next-task="active"/);
});

test('a proposal waiting for a decision says so in the collapsed row', () => {
  const html = withStorage({}, () => render({ plan: { ...controls, state: { ...state, tasks: [], proposal: { id: 'p1', method: 'ai', items: [{ title: '练习概率', reason: 'r', minutes: 15 }] } } } }));
  assert.match(html, /有一份安排等你接受/);
});

test('progress is the shared ProgressBar and never a native progress element', () => {
  const html = open({});
  assert.doesNotMatch(html, /<progress/);
  const bar = tag(html, 'role="progressbar"');
  for (const part of ['aria-label="今日学习进度"', 'aria-valuenow="18"', 'aria-valuemax="40"']) assert.ok(bar.includes(part), part);
});

test('the home keeps the one filled primary for the today card; the board keeps it here', () => {
  const home = open({ primaryAction: false });
  assert.equal((home.match(/sh-btn--primary/g) || []).length, 0, 'home: none');
  assert.match(home, /继续学习/);
  const board = open({});
  assert.equal((board.match(/sh-btn--primary/g) || []).length, 1, 'board: the next action');
  const empty = open({ primaryAction: false, plan: { ...controls, state: { ...state, tasks: [], proposal: null } } });
  assert.match(empty, /请 AI 安排今天/);
  assert.doesNotMatch(empty, /sh-btn--primary/);
  assert.match(open({ plan: { ...controls, state: { ...state, tasks: [], proposal: null } } }), /sh-btn--primary[^>]*>[^<]*(?:<[^>]*>)*请 AI 安排今天/);
  const proposal = open({ primaryAction: false, plan: { ...controls, state: { ...state, tasks: [], proposal: { id: 'p1', method: 'ai', items: [{ title: 't', reason: 'r', minutes: 5 }] } } } });
  assert.match(proposal, /接受这份安排/);
  assert.doesNotMatch(proposal, /sh-btn--primary/);
});

test('the three tools are one 调整 menu, not three underlined links', () => {
  const html = open({ onBoard: noop });
  assert.match(html, /<button[^>]*aria-haspopup="menu"[^>]*>[^<]*调整/);
  assert.doesNotMatch(html, /学习量习惯|查看待办/, 'the entries live in the closed menu');
  assert.doesNotMatch(html, /daily-plan__tools/);
});

test('English is complete', () => {
  const html = withStorage({ 'study-daily-plan:open': 'true' }, () => render({}, 'en'));
  assert.match(html, /What to study next/);
  assert.match(html, /About 22 min left today/);
  assert.doesNotMatch(html.replace(/继续练习概率|已完成的阅读/g, ''), /[㐀-鿿]/);
});

test('the stylesheet uses tokens only, the UI font for numbers and no box around the block', () => {
  const css = readFileSync('ui/daily-plan.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*/g, '');
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|\b(?![123]px)\d+px\b|font-weight:\s*\d{3}/i, 'no raw colours, px sizes (hairlines aside) or numeric weights');
  assert.doesNotMatch(css, /monospace|--font-mono/);
  const block = css.match(/\.daily-plan\s*\{[^}]*\}/)?.[0] || '';
  assert.doesNotMatch(block, /background:\s*(?!none)\S|padding:\s*var\(--space-[5-9]\)[^;]*var\(--space-[5-9]\)/, 'not a heavy box');
  assert.match(css, /tabular-nums/);
});

// #174: a failed AI planning call names its reason and its fix, next to the 本地建议 heading.
const withFailure = (failure, extra = {}) => ({ plan: { ...controls, state: { ...state, tasks: [], proposal: { id: 'p1', method: 'local', failure,
  warnings: ['AI 建议暂不可用，以下是依据已有内容和时间预算的本地建议。调整意见尚未由 AI 处理。'], items: [{ title: '练习概率', reason: 'r', minutes: 15 }] } } }, ...extra });
const textOf = html => html.replace(/<[^>]*>/g, ' ');

test('rate limit, key, timeout and an unusable reply each say their own reason', () => {
  const copy = new Map();
  for (const [kind, message] of [['rate-limit', '429 Too Many Requests'], ['credential', 'Incorrect API key provided'], ['timeout', 'The operation timed out'], ['invalid-response', 'Invalid planner response']]) {
    const html = open(withFailure({ kind, message }, { openModelSettings: noop }));
    const note = html.match(/<div[^>]*class="[^"]*daily-plan__failure[^"]*"[^>]*>[\s\S]*?<\/details>/)?.[0] || '';
    assert.ok(note, kind);
    copy.set(kind, textOf(note.replace(/<details[\s\S]*$/, '')).replace(/\s+/g, ' ').trim());
    assert.ok(html.indexOf('daily-plan__failure') < html.indexOf('<h3>'), `${kind}: the reason is at the heading, not below the list`);
    assert.match(html, new RegExp(`<code[^>]*>${message}</code>`), `${kind}: the provider text is in the technical details`);
    assert.match(html, /技术详情/);
    assert.doesNotMatch(html, /AI 建议暂不可用，以下是依据/, `${kind}: the bare old warning is not repeated`);
  }
  assert.equal(new Set(copy.values()).size, 4, `four different sentences: ${JSON.stringify([...copy])}`);
  assert.match(copy.get('rate-limit'), /太忙|限流/);
  assert.match(copy.get('credential'), /密钥/);
  assert.match(copy.get('timeout'), /没有回应/);
  assert.match(copy.get('invalid-response'), /没有通过检查/);
});

test('settings failures offer 打开模型设置, the others a retry', () => {
  const key = open(withFailure({ kind: 'credential', message: 'Incorrect API key provided' }, { openModelSettings: noop }));
  assert.match(key, /sh-btn[^>]*>[^<]*打开模型设置/);
  const quota = open(withFailure({ kind: 'quota', message: 'insufficient_quota' }, { openModelSettings: noop }));
  assert.match(quota, /sh-btn[^>]*>[^<]*打开模型设置/);
  for (const [kind, message] of [['rate-limit', '429'], ['timeout', 'timed out'], ['network', 'fetch failed']]) {
    const html = open(withFailure({ kind, message }, { openModelSettings: noop }));
    assert.match(html, /daily-plan__failure[\s\S]*?sh-btn[^>]*>[^<]*重试/, kind);
    assert.doesNotMatch(html.match(/daily-plan__failure[\s\S]*?<\/details>/)[0], /打开模型设置/, kind);
  }
  assert.match(open(withFailure({ kind: 'invalid-response', message: 'Invalid planner response' })), /daily-plan__failure[\s\S]*?sh-btn[^>]*>[^<]*再试一次/);
});

test('an old saved proposal without failure keeps the plain warning', () => {
  const html = open({ plan: { ...controls, state: { ...state, tasks: [], proposal: { id: 'p1', method: 'local', items: [{ title: 't', reason: 'r', minutes: 5 }],
    warnings: ['AI 建议暂不可用，以下是依据已有内容和时间预算的本地建议。调整意见尚未由 AI 处理。'] } } } });
  assert.match(html, /AI 建议暂不可用，以下是依据已有内容/);
  assert.doesNotMatch(html, /daily-plan__failure/);
});

test('the failure note is English in the English UI', () => {
  const html = withStorage({ 'study-daily-plan:open': 'true' }, () => render(withFailure({ kind: 'rate-limit', message: '429 Too Many Requests' }), 'en'));
  assert.match(textOf(html), /busy|rate/i);
  assert.doesNotMatch(textOf(html).replace(/练习概率/g, ''), /[㐀-鿿]/);
});
