/* 今天先做什么 without a model: the local proposal is asked for on purpose (local: true), costs no model call, says no "AI is not configured" where nobody asked for AI,
   and the page shows it first with 接受; AI 重排 is the optional second step. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';

const date = '2026-10-05';
async function isolated(fn) {
  const home = await mkdtemp(join(tmpdir(), 'daily-plan-local-'));
  const old = process.env.DSH_HOME; process.env.DSH_HOME = home;
  const service = new StudyService(join(home, 'library'));
  try {
    await service.store.update((s) => {
      s.decks.push({ id: 'deck', title: 'Probability', course: 'Math', cards: Array.from({ length: 7 }, (_, i) => ({ id: `q${i}`, kind: 'flashcard', topic: 'Conditional probability',
        prompt: `Question ${i}`, answer: 'Answer', options: [], citations: [], requires: [], review: { repetitions: 0, interval_days: 0, ease_factor: 2.5, due_at: null } })) });
    });
    await fn(service);
  } finally { await service.dispose(); if (old === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = old; await rm(home, { recursive: true, force: true }); }
}

test('local: true is a proposal made without the model, even when a model is there, and says nothing about AI not being set up', () => isolated(async (service) => {
  let calls = 0;
  service.light = async () => { calls++; return JSON.stringify({ items: [] }); };
  const plan = await service.call('daily.plan.suggest', { date, minutes: 20, local: true });
  assert.equal(calls, 0, 'no model call');
  assert.equal(plan.proposal.method, 'local');
  assert.ok(plan.proposal.items.length);
  assert.deepEqual(plan.proposal.warnings, [], 'nobody asked for AI, so nothing says it is missing');
  assert.equal(plan.proposal.failure, undefined);
  const again = await service.call('daily.plan.suggest', { date, minutes: 20 });
  assert.equal(calls, 1, 'without local the planner still asks the model, as it always did');
  assert.equal(again.proposal.method, 'ai');
}));

test('local: true with no model at all is the same proposal, and asking for AI with none still explains why it is local', () => isolated(async (service) => {
  const local = await service.call('daily.plan.suggest', { date, minutes: 20, local: true });
  assert.deepEqual(local.proposal.warnings, []);
  const asked = await service.call('daily.plan.suggest', { date, minutes: 20 });
  assert.ok(asked.proposal.warnings.some((warning) => warning.includes('尚未配置 AI')));
}));

test('the plan says whether today was already settled, so a closed day is not offered a new proposal on every visit', () => isolated(async (service) => {
  assert.equal((await service.call('daily.plan.get', { date })).accepted, false);
  const draft = await service.call('daily.plan.suggest', { date, minutes: 0, local: true });
  assert.deepEqual(draft.proposal.items, []);
  assert.equal((await service.call('daily.plan.accept', { date, proposalId: draft.proposal.id })).accepted, true);
  assert.equal((await service.call('daily.plan.get', { date })).accepted, true);
  const open = await service.call('daily.plan.suggest', { date: '2026-10-06', minutes: 20, local: true });
  assert.equal(open.accepted, false, 'a proposal that is waiting has not been accepted');
}));

test('local must be a boolean', () => isolated(async (service) => {
  await assert.rejects(service.call('daily.plan.suggest', { date, local: 'yes' }), /local/);
}));

/* ---------- the page ---------- */

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export { default as DailyPlan, shouldSuggestLocal } from './ui/DailyPlan.jsx'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { DailyPlan, shouldSuggestLocal, setUiLanguage } = module.exports;
const noop = () => {};
const proposal = (method) => ({ id: 'p1', method, items: [{ title: '练习概率', reason: '上次混淆了两个概念', minutes: 15 }], warnings: [] });
const state = (extra = {}) => ({ date, budgetMinutes: 40, spentMinutes: 0, accepted: false, profile: { weekdayMinutes: 30, weekendMinutes: 40 }, tasks: [], proposal: proposal('local'), ...extra });
const controls = (extra = {}) => ({ state: state(), date, busy: '', error: '', suggest: noop, accept: noop, saveProfile: noop, start: noop, complete: noop, refresh: noop, ...extra });
const render = (props, language = 'zh') => { setUiLanguage(language); try { return renderToStaticMarkup(React.createElement(DailyPlan, props)); } finally { setUiLanguage('zh'); } };
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('a local proposal is shown first with 接受 as the one filled button, and AI 重排 as the optional second step', () => {
  const html = render({ plan: controls(), modelReady: true });
  assert.match(text(html), /本地建议 · 尚未加入待办/);
  assert.match(text(html), /按到期、薄弱程度和你的时间排出，没有调用模型/);
  assert.match(html, /接受这份安排/);
  assert.match(html, /AI 重排/);
  assert.equal((html.match(/sh-btn--primary/g) || []).length, 1);
  assert.ok(html.indexOf('接受这份安排') < html.indexOf('AI 重排'));
});

test('an AI proposal does not offer AI 重排 (the adjust menu already does), and without a model the gate stays the one line that says so', () => {
  assert.doesNotMatch(render({ plan: controls({ state: state({ proposal: proposal('ai') }) }), modelReady: true }), /AI 重排/);
  const gated = render({ plan: controls(), modelReady: false, openModelSettings: noop });
  assert.doesNotMatch(gated, /AI 重排/, 'no button that cannot work');
  assert.match(gated, /接受这份安排/, 'the local proposal can still be accepted');
  assert.equal((text(gated).match(/配置模型后可以协商安排/g) || []).length, 1);
  assert.match(gated, /打开模型设置/);
});

test('English: the new lines are translated', () => {
  const html = render({ plan: controls(), modelReady: true }, 'en');
  assert.doesNotMatch(text(html).replace('练习概率', '').replace('上次混淆了两个概念', ''), /[㐀-鿿]/);
  assert.match(text(html), /Re-plan with AI/);
  assert.match(text(html), /no model was used/);
});

test('the page asks for the local proposal once a day, only when there is nothing to accept, nothing planned and nothing settled', () => {
  const idle = { state: state({ proposal: null }), busy: '', error: '' };
  assert.equal(shouldSuggestLocal(idle, new Set()), true);
  assert.equal(shouldSuggestLocal({ ...idle, state: null }, new Set()), false, 'not loaded yet');
  assert.equal(shouldSuggestLocal({ ...idle, state: state() }, new Set()), false, 'a proposal is waiting');
  assert.equal(shouldSuggestLocal({ ...idle, state: state({ proposal: null, tasks: [{ id: 't' }] }) }, new Set()), false, 'today is planned');
  assert.equal(shouldSuggestLocal({ ...idle, state: state({ proposal: null, accepted: true }) }, new Set()), false, 'a closed day stays closed');
  assert.equal(shouldSuggestLocal({ ...idle, state: state({ proposal: null, warnings: ['The board is read-only'] }) }, new Set()), false, 'a board that cannot be written is not written to');
  assert.equal(shouldSuggestLocal({ ...idle, busy: 'suggest' }, new Set()), false);
  assert.equal(shouldSuggestLocal({ ...idle, error: '读取失败' }, new Set()), false);
  assert.equal(shouldSuggestLocal(idle, new Set([date])), false, 'asked once for this day already');
});
