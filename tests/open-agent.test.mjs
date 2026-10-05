/* global document, window */
/* "查看后台助手" / "查看子代理": the panel opens a DSH subagent's session. The click must always say
   what happened: the host function resolves or rejects with a reason, the button waits and
   shows the reason, and the top-level page reveals the conversation the assistant opens in. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { launchChromium } from '../scripts/qa/browser.mjs';

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export { openBackgroundAgent, canOpenBackgroundAgent } from './ui/host/open-agent.js';
  export { default as AgentLink, attemptOpen } from './ui/AgentLink.jsx';
  export { default as GenerationTrace } from './ui/GenerationTrace.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { openBackgroundAgent, canOpenBackgroundAgent, AgentLink, attemptOpen, GenerationTrace, setUiLanguage } = module.exports;
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

test('a failed open does not switch the page, and a failing page switch explains the partial success', async () => {
  let revealed = 0;
  await rejects(() => openBackgroundAgent(host({ sessions: { open: async () => { throw new Error('x'); } } }), 'child-1', { reveal: () => { revealed++; } }), /没能打开/);
  assert.equal(revealed, 0);
  for (const reveal of [() => { throw new Error('layout gone'); }, () => Promise.reject(new Error('layout gone'))])
    await rejects(() => openBackgroundAgent(host({ sessions: { open: async () => {} } }), 'child-1', { reveal }),
      /后台助手已打开，但未能切换到对话区：layout gone/);
  setUiLanguage('en');
  try {
    await rejects(() => openBackgroundAgent(host({ sessions: { open: async () => {} } }), 'child-1',
      { reveal: () => Promise.reject(null) }), /The assistant opened.*Open the assistant from the session list/);
  } finally { setUiLanguage('zh'); }
});

test('opening waits for an asynchronous page switch before reporting success', async () => {
  let finish, resolved = false;
  const opening = openBackgroundAgent(host({ sessions: { open: async () => {} } }), 'child-1',
    { reveal: () => new Promise(done => { finish = done; }) }).then(() => { resolved = true; });
  await new Promise(done => setImmediate(done));
  assert.equal(resolved, false);
  finish();
  await opening;
  assert.equal(resolved, true);
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
  assert.match(html, /^<button type="button" class="sh-btn sh-btn--link sh-btn--sm">查看后台助手<\/button>$/);
  assert.equal(link({ childId: 'c1' }), '', 'no host support, no button');
  assert.equal(link({ openAgent() {} }), '', 'no assistant id, no button');
  assert.match(link({ childId: 'c1', openAgent() {}, className: 'link-btn', ariaLabel: '查看子代理：校对 1/30' }), /class="sh-btn sh-btn--link sh-btn--sm link-btn" aria-label="查看子代理：校对 1\/30"/);
});

test('the generation trace offers the assistant of a step only when the host can open one', () => {
  const job = { id: 'j', status: 'running', steps: [
    { id: 's1', stage: 'review', status: 'running', childId: 'child-7', runtime: 'subagent', startedAt: new Date().toISOString() },
    { id: 's2', stage: 'extract', status: 'complete', runtime: 'direct' }] };
  const trace = props => renderToStaticMarkup(h(GenerationTrace, { job, ...props }));
  assert.equal((trace({ openAgent() {} }).match(/查看后台助手/g) || []).length, 1, 'one button, for the step that has a child');
  assert.doesNotMatch(trace({}), /查看后台助手/);
});

/** DSH 0.2: no sessions.open; a sub-agent is opened from its parent's catalog through uiWorkspace.openSession(address). */
function dsh02({ known = {}, loadable = {} } = {}) {
  const opened = [], loaded = [], catalog = { ...known };
  const sessions = { subagentAddress: id => catalog[id], refreshProjections: async parent => { loaded.push(parent); Object.assign(catalog, loadable[parent] || {}); } };
  return { ctx: host({ sessions, uiWorkspace: { openSession: address => { opened.push(address); } } }), opened, loaded };
}
const address = (parent, child) => ({ parentSessionId: parent, childSessionId: child, mode: 'one-shot' });

test('without sessions.open, a child in a loaded catalog opens through its address', async () => {
  const { ctx, opened, loaded } = dsh02({ known: { c1: address('p', 'c1') } });
  assert.equal(canOpenBackgroundAgent(ctx), true);
  assert.equal(canOpenBackgroundAgent(ctx, 'c1'), true);
  await openBackgroundAgent(ctx, 'c1', { reveal: () => opened.push('reveal') });
  assert.deepEqual(opened, [address('p', 'c1'), 'reveal']);
  assert.deepEqual(loaded, [], 'nothing needed loading');
});

test('a child that is not listed yet is found by loading its parent\'s catalog, and the link says so only when that is possible', async () => {
  const { ctx, opened, loaded } = dsh02({ loadable: { coordinator: { c2: address('coordinator', 'c2') } } });
  assert.equal(canOpenBackgroundAgent(ctx, 'c2'), false, 'unknown child, unknown parent: no link');
  assert.equal(canOpenBackgroundAgent(ctx, 'c2', { parentId: 'coordinator' }), true, 'the parent is known and can be asked');
  await openBackgroundAgent(ctx, 'c2', { parentId: 'coordinator' });
  assert.deepEqual(loaded, ['coordinator']);
  assert.deepEqual(opened, [address('coordinator', 'c2')]);
  await rejects(() => openBackgroundAgent(ctx, 'ghost', { parentId: 'coordinator' }), /没能打开后台助手：DSH 的子代理列表里还没有它/);
});

test('a host with neither way offers no link at all, before anything is clicked', () => {
  assert.equal(canOpenBackgroundAgent(host({})), false);
  assert.equal(canOpenBackgroundAgent(host({ sessions: {} })), false);
  assert.equal(canOpenBackgroundAgent(host({ sessions: { subagentAddress() {} } })), false, 'an address without a way to open it is no capability');
  assert.equal(canOpenBackgroundAgent(host({ sessions: { open() {} } })), true);
  assert.equal(canOpenBackgroundAgent(host({ sessions: { open() {} } }), 'any-child'), true, 'sessions.open takes any id');
});

test('the link asks the host about this child and is not drawn when it cannot be opened', () => {
  const link = props => renderToStaticMarkup(h(AgentLink, { label: '查看子代理', childId: 'c1', ...props }));
  const openAgent = Object.assign(() => {}, { canOpen: (id, options) => id === 'c1' && options.parentId === 'p' });
  assert.match(link({ openAgent, parentId: 'p' }), /查看子代理/);
  assert.equal(link({ openAgent, parentId: 'other' }), '');
  assert.equal(link({ openAgent, childId: 'c9', parentId: 'p' }), '');
});

test('the assistant button prevents duplicate opens and recovers after a visible failure', { timeout: 60000 }, async t => {
  const browserBundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import AgentLink from './ui/AgentLink.jsx';
    window.opens = 0;
    const openAgent = () => { window.opens++; return new Promise((resolve, reject) => {
      window.finishOpen = resolve; window.failOpen = reject;
    }); };
    createRoot(document.getElementById('root')).render(<AgentLink childId="child-1" openAgent={openAgent} label="查看后台助手" />);
  `, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', loader: { '.css': 'text' }, logLevel: 'silent' });
  let browser;
  try { browser = await launchChromium(); }
  catch (error) {
    if (!/browserType\.launch: Executable doesn't exist/.test(String(error.message))) throw error;
    t.skip('Chromium unavailable'); return;
  }
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: 'zh-CN' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent('<main id="root"></main>');
  await page.addScriptTag({ content: browserBundle.outputFiles[0].text });
  const button = page.getByRole('button');
  await button.click();
  await page.waitForFunction(() => document.querySelector('button')?.disabled === true);
  assert.equal(await button.innerText(), '正在打开…');
  await button.dispatchEvent('click');
  assert.equal(await page.evaluate(() => window.opens), 1);
  await page.evaluate(() => window.failOpen(new Error('host refused')));
  await page.waitForFunction(() => document.querySelector('[role="alert"]')?.textContent === 'host refused');
  assert.equal(await button.isEnabled(), true);
  await button.click();
  await page.waitForFunction(() => window.opens === 2 && !document.querySelector('[role="alert"]'));
  await page.evaluate(() => window.finishOpen());
  await page.waitForFunction(() => !document.querySelector('button').disabled);
  assert.equal(await button.innerText(), '查看后台助手');
  assert.deepEqual(errors, []);
});
