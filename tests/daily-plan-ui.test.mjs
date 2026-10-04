import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export { default as DailyPlan, RelatedTasks } from './ui/DailyPlan.jsx'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { DailyPlan, RelatedTasks, setUiLanguage } = module.exports;
const noop = () => {};
const state = { date: '2026-10-04', budgetMinutes: 40, profile: { weekdayMinutes: 30, weekendMinutes: 40 }, tasks: [],
  proposal: { id: 'p1', method: 'ai', items: [{ title: '练习概率', reason: '上次混淆了两个概念', minutes: 15 }] } };
const render = (Component, props, language = 'zh') => { setUiLanguage(language); try { return renderToStaticMarkup(React.createElement(Component, props)); } finally { setUiLanguage('zh'); } };
const controls = { state, busy: '', error: '', suggest: noop, accept: noop, saveProfile: noop, start: noop, complete: noop, refresh: noop };

test('proposal shows reasons, estimates and an explicit acceptance control before real tasks', () => {
  const html = render(DailyPlan, { plan: controls });
  assert.match(html, /上次混淆了两个概念/);
  assert.match(html, /15/);
  assert.match(html, /接受这份安排/);
  assert.match(html, /调整今天/);
  assert.doesNotMatch(html, /<textarea/);
  assert.match(html, /尚未加入待办/);
});

test('loading and failed requests stay visible with retry and no fabricated proposal', () => {
  assert.match(render(DailyPlan, { plan: { ...controls, state: null } }), /正在读取/);
  const html = render(DailyPlan, { plan: { ...controls, state: null, error: '读取失败' } });
  assert.match(html, /读取失败/);
  assert.match(html, /重试/);
  assert.doesNotMatch(html, /接受这份安排/);
});

test('a rest-day proposal can still be accepted and regular pace supports zero', () => {
  const html = render(DailyPlan, { plan: { ...controls, state: { ...state, budgetMinutes: 0, proposal: { ...state.proposal, items: [] } } } });
  assert.match(html, /今天休息/);
  assert.match(html, /接受这份安排/);
  assert.doesNotMatch(html, /<textarea/);
});

test('real practice progress and unavailable targets are distinct from completion', () => {
  const tasks = [{ id: 't1', title: '练习概率', kind: 'practice', minutes: 15, status: 'doing', progress: { done: 2, total: 5 } },
    { id: 't2', title: '旧资料', kind: 'reading', minutes: 10, status: 'todo', available: false }];
  const html = render(DailyPlan, { plan: { ...controls, state: { ...state, proposal: null, tasks } } });
  assert.match(html, /2\/5/);
  assert.match(html, /继续/);
  assert.match(html, /内容已不可用/);
  assert.doesNotMatch(html, /接受这份安排/);
});

test('accepted plan foregrounds one in-progress action and keeps adjustments out of the default view', () => {
  const tasks = [
    { id: 'done', title: '已完成的阅读', kind: 'reading', minutes: 10, status: 'done' },
    { id: 'queued', title: '下一份阅读', kind: 'reading', minutes: 10, status: 'todo' },
    { id: 'active', title: '继续练习概率', kind: 'practice', minutes: 20, status: 'doing', progress: { done: 2, total: 5 } },
  ];
  const html = render(DailyPlan, { plan: { ...controls, state: { ...state, proposal: null, spentMinutes: 18, tasks } } });
  assert.match(html, /今天先做什么/);
  assert.match(html, /data-next-task="active"/);
  assert.match(html, /<h3>完成 3 道练习<\/h3>/);
  assert.match(html, /class="daily-plan__subject">继续练习概率/);
  assert.match(html, /今天剩余约 22 分钟/);
  assert.match(html, /<details[^>]*class="daily-plan__list"/);
  assert.doesNotMatch(html, /<textarea/);
  assert.equal((html.match(/sh-btn--primary/g) || []).length, 1);
});

test('an open proposal takes precedence over the accepted next action', () => {
  const task = { id: 'active', title: '继续练习概率', minutes: 20, kind: 'practice', status: 'doing' };
  const html = render(DailyPlan, { plan: { ...controls, state: { ...state, tasks: [task] } } });
  assert.doesNotMatch(html, /data-next-task/);
  assert.equal((html.match(/sh-btn--primary/g) || []).length, 1);
});

test('completed and rest-day plans never present a next action or negative remaining allowance', () => {
  const task = { id: 'done', title: '已完成阅读', minutes: 10, kind: 'reading', status: 'done' };
  const html = render(DailyPlan, { plan: { ...controls, state: { ...state, proposal: null, budgetMinutes: 0, spentMinutes: 12, tasks: [task] } } });
  assert.doesNotMatch(html, /data-next-task|剩余约 -/);
  assert.match(html, /今天休息/);
});

test('an unavailable action is not presented as completed learning', () => {
  const task = { id: 'gone', title: '旧资料', kind: 'reading', minutes: 10, status: 'todo', available: false };
  const html = render(DailyPlan, { plan: { ...controls, state: { ...state, proposal: null, tasks: [task] } } });
  assert.doesNotMatch(html, /data-next-task|今天的行动告一段落/);
  assert.match(html, /有行动暂时无法继续/);
});

test('context strip resolves only exact related content and English copy is complete', () => {
  const ref = { root: '/library', kind: 'source', id: 's1' };
  const task = { id: 't1', title: 'Read chapter 3', kind: 'reading', minutes: 10, status: 'todo', studyRef: ref };
  const html = render(RelatedTasks, { plan: { ...controls, state: { ...state, tasks: [task] } }, reference: ref }, 'en');
  assert.match(html, /Read chapter 3/);
  assert.doesNotMatch(html, /Start|<ul|<textarea/);
  assert.doesNotMatch(html, /[㐀-鿿]/);
  assert.equal(render(RelatedTasks, { plan: { ...controls, state: { ...state, tasks: [task] } }, reference: { ...ref, root: '/other' } }), '');
});

test('archived completed history stays visible without offering a write to the archived task', () => {
  const task = { id: 'archived', title: 'Read chapter 3', kind: 'reading', minutes: 10,
    status: 'done', available: false, archived: true, actualMinutes: 12 };
  const html = render(DailyPlan, { plan: { ...controls, state: { ...state, proposal: null, tasks: [task] } } }, 'en');
  assert.match(html, /Read chapter 3/);
  assert.match(html, /Archived/);
  assert.doesNotMatch(html, /Record actual time|Content unavailable/);
});
