/* "查看后台助手" / "查看子代理": the panel opens a DSH subagent's session. The click must always say
   what happened: the host function resolves or rejects with a reason, the button waits and
   shows the reason, and the top-level page reveals the conversation the assistant opens in. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export { openBackgroundAgent } from './ui/host/open-agent.js';
  export { default as AgentLink, attemptOpen } from './ui/AgentLink.jsx';
  export { default as GenerationTrace } from './ui/GenerationTrace.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { openBackgroundAgent, AgentLink, attemptOpen, GenerationTrace, setUiLanguage } = module.exports;
const h = React.createElement;

/** A host context whose services are the given ones. */
const host = services => ({ get: name => services[name] });
const rejects = async (work, pattern) => { await assert.rejects(work, error => { assert.match(error.message, pattern); return true; }); };

test('openBackgroundAgent opens the session, waits for DSH, then reveals the conversation', async () => {
  const order = [];
  const sessions = { open: async id => { order.push(`open:${id}`); await new Promise(done => setTimeout(done, 5)); order.push('opened'); } };
  await openBackgroundAgent(host({ sessions }), 'child-1', { reveal: () => order.push('reveal') });
  assert.deepEqual(order, ['open:child-1', 'opened', 'reveal'], 'the page switch comes after DSH accepted the session');
  await openBackgroundAgent(host({ sessions: { open: () => {} } }), 'child-2');
});

test('openBackgroundAgent never stays silent: no id, no host support, or a host failure each say why', async () => {
  setUiLanguage('zh');
  await rejects(() => openBackgroundAgent(host({ sessions: { open() {} } }), ''), /没有可打开的后台助手/);
  await rejects(() => openBackgroundAgent(host({}), 'child-1'), /当前 DSH 版本不能从这里打开后台助手/);
  await rejects(() => openBackgroundAgent(host({ sessions: {} }), 'child-1'), /当前 DSH 版本不能/);
  await rejects(() => openBackgroundAgent(host({ sessions: { open: async () => { throw new Error('Session not found: child-1'); } } }), 'child-1'),
    /没能打开后台助手：Session not found: child-1/);
  await rejects(() => openBackgroundAgent(host({ sessions: { open() { throw new Error('no such tab'); } } }), 'child-1'), /没能打开后台助手：no such tab/);
  await rejects(() => openBackgroundAgent(host({ sessions: { open: () => Promise.reject(undefined) } }), 'child-1'), /助手可能已经结束/);
  setUiLanguage('en');
  try { await rejects(() => openBackgroundAgent(host({}), 'child-1'), /cannot open background assistants/); }
  finally { setUiLanguage('zh'); }
});

test('a failed open does not switch the page, and a failing page switch does not fail the open', async () => {
  let revealed = 0;
  await rejects(() => openBackgroundAgent(host({ sessions: { open: async () => { throw new Error('x'); } } }), 'child-1', { reveal: () => { revealed++; } }), /没能打开/);
  assert.equal(revealed, 0);
  await openBackgroundAgent(host({ sessions: { open: async () => {} } }), 'child-1', { reveal: () => { throw new Error('layout gone'); } });
});

test('attemptOpen returns an empty string on success and the reason on failure', async () => {
  setUiLanguage('zh');
  assert.equal(await attemptOpen(async () => {}, 'c'), '');
  assert.equal(await attemptOpen(() => {}, 'c'), '', 'a host that returns nothing counts as opened');
  assert.equal(await attemptOpen(async () => { throw new Error('boom'); }, 'c'), 'boom');
  assert.equal(await attemptOpen(() => { throw new Error('sync boom'); }, 'c'), 'sync boom');
  assert.equal(await attemptOpen(() => Promise.reject(null), 'c'), '没能打开后台助手。');
  const seen = [];
  await attemptOpen(async id => { seen.push(id); }, 'child-9');
  assert.deepEqual(seen, ['child-9']);
});

test('the button shows only when there is an assistant and a host that can open it', () => {
  const link = props => renderToStaticMarkup(h(AgentLink, { label: '查看后台助手', ...props }));
  const html = link({ childId: 'c1', openAgent() {} });
  assert.match(html, /^<button type="button">查看后台助手<\/button>$/);
  assert.equal(link({ childId: 'c1' }), '', 'no host support, no button');
  assert.equal(link({ openAgent() {} }), '', 'no assistant id, no button');
  assert.match(link({ childId: 'c1', openAgent() {}, className: 'link-btn', ariaLabel: '查看子代理：校对 1/30' }), /class="link-btn" aria-label="查看子代理：校对 1\/30"/);
});

test('the generation trace offers the assistant of a step only when the host can open one', () => {
  const job = { id: 'j', status: 'running', steps: [
    { id: 's1', stage: 'review', status: 'running', childId: 'child-7', runtime: 'subagent', startedAt: new Date().toISOString() },
    { id: 's2', stage: 'extract', status: 'complete', runtime: 'direct' }] };
  const trace = props => renderToStaticMarkup(h(GenerationTrace, { job, ...props }));
  assert.equal((trace({ openAgent() {} }).match(/查看后台助手/g) || []).length, 1, 'one button, for the step that has a child');
  assert.doesNotMatch(trace({}), /查看后台助手/);
});
