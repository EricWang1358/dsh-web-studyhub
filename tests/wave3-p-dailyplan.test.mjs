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
const open = props => withStorage({ 'study-daily-plan:open': 'true' }, () => render(props));

test('collapsed by default: one row with the heading, the minutes left and the next step, and a named toggle', () => {
  const html = withStorage({}, () => render({}));
  assert.match(html, /<button[^>]*aria-expanded="false"[^>]*aria-label="展开 今天先做什么"/);
  assert.match(html, /今天先做什么/);
  assert.match(html, /今天剩余约 22 分钟/);
  assert.match(html, /下一步：继续练习概率/);
  assert.match(html, /<div[^>]*class="daily-plan__body"[^>]*hidden=""/, 'the body stays out of the page and the accessibility tree');
  assert.doesNotMatch(html.replace(/<div[^>]*class="daily-plan__body"[\s\S]*$/, ''), /sh-btn--primary|<progress/);
});

test('the open state is remembered per browser', () => {
  const html = open({});
  assert.match(html, /aria-expanded="true"[^>]*aria-label="收起 今天先做什么"/);
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
  assert.match(html, /role="progressbar"[^>]*aria-label="今日学习进度"[^>]*aria-valuenow="18"[^>]*aria-valuemax="40"|aria-label="今日学习进度"[^>]*role="progressbar"/);
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
  assert.match(html, /What to do first today/);
  assert.match(html, /about 22 min left today/i);
  assert.doesNotMatch(html.replace(/继续练习概率|已完成的阅读/g, ''), /[㐀-鿿]/);
});

test('the stylesheet uses tokens only, the UI font for numbers and no box around the block', () => {
  const css = readFileSync('ui/daily-plan.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|\b\d+px\b|font-weight:\s*\d{3}/i, 'no raw colours, px or numeric weights');
  assert.doesNotMatch(css, /monospace|--font-mono/);
  const block = css.match(/\.daily-plan\s*\{[^}]*\}/)?.[0] || '';
  assert.doesNotMatch(block, /background|padding:\s*var\(--space-[5-9]\)[^;]*var\(--space-[5-9]\)/, 'not a heavy box');
  assert.match(css, /tabular-nums/);
});
