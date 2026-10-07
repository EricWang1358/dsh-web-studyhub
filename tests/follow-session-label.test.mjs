import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createHostHandler, sessionFollow } from '../lib/host.js';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';

/* 「跟随当前会话」 says which model and reasoning level it follows: the conversation's own default (the DSH session route),
   not the learner's saved generation preference. The host puts it on snapshot.model.session; the 即时控制 row and 出题偏好 draw it. */

const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as TaskConsole } from './ui/tasks/TaskConsole.jsx';
  export { default as GenerationSettings } from './ui/GenerationSettings.jsx';
  export { followLabel } from './ui/follow-session.js';
  export { controlItems } from './ui/tasks/task-control.js';
  export { setUiLanguage } from './ui/i18n.js';
`);

const SESSION = { provider: 'deepseek-official', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' };
const EFFORTS = ['effortPlanning', 'effortReview', 'effortWriting', 'effortRepair'];

test('the label names the model and the level, or the word default when the session sets no level', () => {
  assert.equal(m.followLabel(SESSION), '跟随当前会话 · deepseek-v4.1-flash · high');
  assert.equal(m.followLabel({ ...SESSION, reasoningEffort: null }), '跟随当前会话 · deepseek-v4.1-flash · default');
  assert.equal(m.followLabel({ provider: 'p', model: 'm' }), '跟随当前会话 · m · default');
  assert.equal(m.followLabel({ provider: 'p', model: 'm', reasoningEffort: '' }), '跟随当前会话 · m · default');
});

test('an unknown session model keeps the plain label', () => {
  for (const session of [undefined, null, {}, { provider: 'p' }, { model: '' }]) assert.equal(m.followLabel(session), '跟随当前会话');
  m.setUiLanguage('en');
  assert.equal(m.followLabel(SESSION), 'Follow current session · deepseek-v4.1-flash · high');
  assert.equal(m.followLabel(null), 'Follow current session');
  m.setUiLanguage('zh');
});

const generation = () => ({ id: 'g1', status: 'running', deckTitle: 'Deck', requestedTotal: 10, savedCount: 2, startedAt: '2026-10-05T10:00:00.000Z', paused: false,
  control: { values: { concurrency: 4, paused: false, effortPlanning: 'follow', effortReview: 'follow', effortWriting: 'low', effortRepair: 'low' },
    limits: { concurrency: { type: 'int', min: 1, max: 8 }, paused: { type: 'bool' }, ...Object.fromEntries(EFFORTS.map((key) => [key, { type: 'enum', values: ['follow', 'lowest', 'low', 'default', 'high', 'highest'] }])) } } });

test('controlItems puts the label on the follow option of the four reasoning selects only, and stays pure', () => {
  const job = generation();
  const labelOf = (items, key) => items.find((item) => item.key === key).options.find((option) => option.value === 'follow').label;
  const plain = m.controlItems(job);
  for (const key of EFFORTS) assert.equal(labelOf(plain, key), '跟随当前会话', key);
  const enriched = m.controlItems(job, SESSION);
  for (const key of EFFORTS) assert.equal(labelOf(enriched, key), '跟随当前会话 · deepseek-v4.1-flash · high', key);
  assert.deepEqual(enriched.find((item) => item.key === 'concurrency').options, []);
  assert.deepEqual(enriched.map((item) => item.value), plain.map((item) => item.value), 'the values in force are untouched');
});

const render = (data) => {
  const job = generation();
  return renderToStaticMarkup(inApp(m, React.createElement(m.TaskConsole, { data: { jobs: [job], drafts: [], decks: [] }, openers: { resultOf: () => null } }),
    { data: { jobs: [job], ...data }, app: { lib: { taskFocus: null } } }));
};

test('the 即时控制 row shows the followed model in the follow option, and the plain label when there is no session model', () => {
  const html = render({ model: { ready: true, reason: 'ok', label: 'DeepSeek · deepseek-v4.1-flash', provider: SESSION.provider, model: SESSION.model, session: SESSION } });
  assert.equal((html.match(/<option value="follow"[^>]*>跟随当前会话 · deepseek-v4\.1-flash · high<\/option>/g) || []).length, 4, 'every reasoning select offers it');
  const noLevel = render({ model: { ready: true, session: { ...SESSION, reasoningEffort: null } } });
  assert.match(noLevel, /<option value="follow" selected="">跟随当前会话 · deepseek-v4\.1-flash · default<\/option>/);
  assert.match(render({ model: { ready: true } }), /<option value="follow" selected="">跟随当前会话<\/option>/);
  assert.match(render({}), /<option value="follow" selected="">跟随当前会话<\/option>/);
});

test('出题偏好 shows the same label on its follow options', () => {
  const html = renderToStaticMarkup(React.createElement(m.GenerationSettings, { root: '/library', act: () => {}, followLabel: m.followLabel(SESSION) }));
  assert.equal((html.match(/<option value="follow"[^>]*>跟随当前会话 · deepseek-v4\.1-flash · high<\/option>/g) || []).length, 4);
  assert.match(renderToStaticMarkup(React.createElement(m.GenerationSettings, { root: '/library', act: () => {} })), /<option value="follow"[^>]*>跟随当前会话<\/option>/);
});

/* The host: the session route rides on the model status of the snapshot. */

test('sessionFollow keeps provider, model and the level, with null for a session that sets none', () => {
  assert.deepEqual(sessionFollow(SESSION), SESSION);
  assert.deepEqual(sessionFollow({ provider: 'p', model: 'm' }), { provider: 'p', model: 'm', reasoningEffort: null });
  assert.equal(sessionFollow(undefined), undefined);
  assert.equal(sessionFollow({ provider: 'p' }), undefined);
});

async function panel(t, { route } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'study-follow-label-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const state = { route };
  const session = { header: { cwd }, requestHeader: () => ({ config: state.route }) };
  const handler = createHostHandler({ sessions: { get: () => session }, get: () => undefined }, {}, () => async () => '{}');
  const run = async (args) => {
    const response = await handler('call', { sessionId: 's', action: 'snapshot', args });
    assert.equal(response.ok, true, response.error?.message);
    return response.value;
  };
  return { state, run, handler, cwd };
}

test('the snapshot carries the session model and level, and a changed session model refreshes an otherwise unchanged snapshot', async (t) => {
  const { state, run } = await panel(t, { route: SESSION });
  const first = await run();
  assert.deepEqual(first.model.session, SESSION);
  assert.equal((await run({ since: first.fingerprint })).unchanged, true);
  state.route = { ...SESSION, reasoningEffort: 'low' };
  const second = await run({ since: first.fingerprint });
  assert.equal(second.unchanged, undefined);
  assert.equal(second.model.session.reasoningEffort, 'low');
});

test('a session without an explicit level says null, so the label says default', async (t) => {
  const { run } = await panel(t, { route: { provider: SESSION.provider, model: SESSION.model } });
  assert.deepEqual((await run()).model.session, { provider: SESSION.provider, model: SESSION.model, reasoningEffort: null });
});

test('the saved custom route does not hide what the conversation defaults to', async (t) => {
  const { run, handler } = await panel(t, { route: SESSION });
  const saved = await handler('call', { sessionId: 's', action: 'binding.set', args: { provider: 'siliconflow', model: 'Qwen/Qwen2.5-7B-Instruct', reasoningEffort: 'low' } });
  assert.equal(saved.ok, true, saved.error?.message);
  const value = await run();
  assert.equal(value.model.model, 'Qwen/Qwen2.5-7B-Instruct', 'the status still describes the model generation uses');
  assert.deepEqual(value.model.session, SESSION, 'the follow label describes the conversation, not the saved choice');
});

test('a host without a session model says nothing about one', async (t) => {
  const { run } = await panel(t, { route: undefined });
  assert.equal((await run()).model.session, undefined);
});
