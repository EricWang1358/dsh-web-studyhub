import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

// #116: busy / error / unmount-guard boilerplate lives in one place.
const m = await loadUi(`export * from './ui/use-async.js'; export { setUiLanguage } from './ui/i18n.js';`);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const watch = (options) => { const states = []; const runner = m.createAsyncRunner({ ...options, onChange: state => states.push(state) }); return { runner, states }; };

test('run reports which kind is working, then clears it', async () => {
  const { runner, states } = watch();
  const gate = deferred();
  const done = runner.run('save', () => gate.promise);
  assert.equal(runner.state().working, 'save');
  gate.resolve('ok');
  assert.equal(await done, 'ok');
  assert.equal(runner.state().working, null);
  assert.deepEqual(states.map(state => state.working), ['save', null]);
});

test('a second run of the same kind while one is in flight is ignored (single flight)', async () => {
  const { runner } = watch();
  const gate = deferred();
  let calls = 0;
  const first = runner.run('verify', () => { calls += 1; return gate.promise; });
  const second = runner.run('verify', () => { calls += 1; return Promise.resolve('other'); });
  gate.resolve('first');
  assert.equal(await first, 'first');
  assert.equal(await second, 'first', 'the caller joins the run already going');
  assert.equal(calls, 1);
  await runner.run('verify', () => { calls += 1; });
  assert.equal(calls, 2, 'a finished kind can run again');
});

test('failures become a readable error through uiMessage and the next run clears it', async () => {
  m.setUiLanguage('zh');
  const { runner } = watch();
  assert.equal(await runner.run('save', () => { throw new Error('服务暂时不可用'); }), undefined);
  assert.equal(runner.state().error, '服务暂时不可用');
  assert.equal(runner.state().working, null);
  await runner.run('save', () => Promise.reject('plain text failure'));
  assert.equal(runner.state().error, 'plain text failure', 'a non-Error rejection is still text');
  await runner.run('save', () => 1);
  assert.equal(runner.state().error, '', 'a new run clears the old error');
  await runner.run('save', () => { throw new Error('x'); });
  runner.clearError();
  assert.equal(runner.state().error, '');
});

test('errors pass through uiMessage so English readers get English', async () => {
  m.setUiLanguage('en');
  const { runner } = watch();
  await runner.run('save', () => { throw new Error('API 密钥格式不对，请重新复制服务商页面里的完整密钥'); });
  assert.doesNotMatch(runner.state().error, /[㐀-鿿]/);
  m.setUiLanguage('zh');
});

test('nothing is reported after the owner unmounts', async () => {
  const { runner, states } = watch();
  const gate = deferred();
  const done = runner.run('save', () => gate.promise);
  const seen = states.length;
  runner.detach();
  gate.reject(new Error('late'));
  await done;
  assert.equal(states.length, seen, 'no state update after unmount');
  runner.attach();
  await runner.run('save', () => 1);
  assert.ok(states.length > seen, 'a remounted owner is told again');
});

test('different kinds may be in flight together; working names the latest one', async () => {
  const { runner } = watch();
  const a = deferred(), b = deferred();
  const first = runner.run('a', () => a.promise), second = runner.run('b', () => b.promise);
  assert.equal(runner.state().working, 'b');
  b.resolve(); await second;
  assert.equal(runner.state().working, 'a');
  a.resolve(); await first;
  assert.equal(runner.state().working, null);
});

test('the hook starts idle', () => {
  const Probe = () => { const { working, error } = m.useAsyncAction(); return React.createElement('i', null, `${working === null}|${error === ''}`); };
  assert.match(renderToStaticMarkup(React.createElement(Probe)), /true\|true/);
});
