/* global window, document */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { fetchQuery, invalidate, peekQuery, resetHostQueries, setQueryData, watchQuery } from '../ui/host-query-store.js';

// Wave 4 item 8 (#117): one store for what the host reports, shared by every reader; a write updates them all without a reload.
const read = (file) => readFileSync(file, 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('readers of one query share one request and one answer (#117)', async () => {
  resetHostQueries();
  const calls = [], gate = deferred();
  const call = (action, args) => { calls.push([action, args]); return gate.promise; };
  const first = fetchQuery(call, 'retrieval.status', {}), second = fetchQuery(call, 'retrieval.status', {});
  assert.equal(calls.length, 1, 'the request in flight is joined');
  gate.resolve({ installed: false });
  assert.deepEqual(await first, { installed: false });
  assert.deepEqual(await second, { installed: false });
  assert.deepEqual(peekQuery('retrieval.status', {}), { installed: false });
  const other = await fetchQuery(async () => ({ configured: true }), 'mineru.settings.get', {});
  assert.deepEqual(other, { configured: true }, 'another action is its own query');
  assert.notEqual(peekQuery('mineru.settings.get', {}), peekQuery('retrieval.status', {}));
});

test('queries are keyed by action and arguments (#117)', async () => {
  resetHostQueries();
  await fetchQuery(async (_a, args) => ({ for: args.course }), 'retrieval.index.plan', { course: 'A' });
  await fetchQuery(async (_a, args) => ({ for: args.course }), 'retrieval.index.plan', { course: 'B' });
  assert.deepEqual(peekQuery('retrieval.index.plan', { course: 'A' }), { for: 'A' });
  assert.deepEqual(peekQuery('retrieval.index.plan', { course: 'B' }), { for: 'B' });
});

test('invalidate makes a watched query ask again and every watcher sees the new answer; an unwatched one asks when next read (#117)', async () => {
  resetHostQueries();
  let state = { installed: false }, asked = 0;
  const call = async () => { asked++; return state; };
  await fetchQuery(call, 'retrieval.status', {});
  const seen = [];
  const stop = watchQuery('retrieval.status', {}, () => seen.push(peekQuery('retrieval.status', {})));
  state = { installed: true };
  invalidate('retrieval.status');
  await tick(); await tick();
  assert.equal(asked, 2, 'one refetch for the watchers');
  assert.deepEqual(peekQuery('retrieval.status', {}), { installed: true });
  assert.ok(seen.some((value) => value?.installed === true), 'the watcher was told');
  stop();
  state = { installed: false };
  invalidate('retrieval.status');
  await tick();
  assert.equal(asked, 2, 'nobody watches: nothing is asked until someone reads');
  assert.deepEqual(await fetchQuery(call, 'retrieval.status', {}), { installed: false });
  assert.equal(asked, 3);
});

test('a write that returns the new state updates every reader at once, and a failed refresh keeps the last good data (#117)', async () => {
  resetHostQueries();
  await fetchQuery(async () => ({ installed: false }), 'retrieval.status', {});
  const seen = [];
  const stop = watchQuery('retrieval.status', {}, () => seen.push(peekQuery('retrieval.status', {})));
  setQueryData('retrieval.status', {}, { installed: true });
  assert.deepEqual(seen.at(-1), { installed: true });
  const result = await fetchQuery(async () => { throw new Error('offline'); }, 'retrieval.status', {});
  assert.deepEqual(result, { installed: true }, 'the last good data stays');
  assert.deepEqual(peekQuery('retrieval.status', {}), { installed: true });
  stop();
});

function sources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (['locales', 'node_modules'].includes(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out); else if (/\.(jsx?)$/.test(name)) out.push(path);
  }
  return out;
}

test('retrieval.status is asked for only through the shared store, and the MinerU loads share one hook (#117)', () => {
  const allowed = new Set(['ui/retrieval-status.js', 'ui/host-query.js']);
  for (const file of sources('ui')) {
    const normal = file.split('\\').join('/');
    if (allowed.has(normal)) continue;
    assert.doesNotMatch(read(file), /call\(\s*['"]retrieval\.status['"]/, `${normal} calls retrieval.status itself`);
  }
  for (const file of ['ui/PdfConversion.jsx', 'ui/MineruSettings.jsx']) {
    const text = read(file);
    assert.match(text, /useMineruState/, `${file} uses the shared MinerU hook`);
    assert.doesNotMatch(text, /call\(\s*['"]mineru\.(settings\.get|local\.status)['"]/, `${file} loads MinerU itself`);
  }
  assert.match(read('ui/retrieval-extension-flow.js'), /refreshRetrievalStatus/, 'an install or removal updates every reader');
});

// Browser: two components read the same query; a write through the store (an install) is seen by both without a reload and without a second ask each.
const bundle = await build({ stdin: { resolveDir: process.cwd(), loader: 'jsx', contents: `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { useRetrievalStatus, invalidateRetrievalStatus } from './ui/retrieval-status.js';
  import { StudyServicesContext } from './ui/study-context.jsx';
  let installed = false; window.asked = 0;
  const call = async () => { window.asked++; return { extension: { installed } }; };
  const Reader = ({ id }) => { const { data } = useRetrievalStatus(); return <p id={id}>{data ? (data.extension.installed ? 'installed' : 'not installed') : 'unknown'}</p>; };
  window.install = () => { installed = true; invalidateRetrievalStatus(); };
  const services = { call, act: async () => {}, busy: false, notify() {}, askInChat() {}, host: {}, openSettings() {}, navigate() {}, openModal() {} };
  createRoot(document.getElementById('root')).render(<StudyServicesContext.Provider value={services}><Reader id="a" /><Reader id="b" /></StudyServicesContext.Provider>);
  window.harnessReady = true;` },
bundle: true, write: false, format: 'iife', platform: 'browser', loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
let browser, unavailable = false;
try { browser = await launchChromium(); }
catch (error) { if (!/Executable doesn't exist|browserType\.launch/.test(String(error.message))) throw error; unavailable = true; }
after(() => browser?.close());

test('in the browser: an install shows in every reader at once, from one shared request (#117)', { skip: unavailable }, async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.waitForFunction(() => window.harnessReady);
  await page.waitForFunction(() => document.getElementById('a').textContent === 'not installed' && document.getElementById('b').textContent === 'not installed');
  assert.equal(await page.evaluate(() => window.asked), 1, 'two readers, one request');
  await page.evaluate(() => window.install());
  await page.waitForFunction(() => document.getElementById('a').textContent === 'installed' && document.getElementById('b').textContent === 'installed');
  assert.equal(await page.evaluate(() => window.asked), 2, 'one refetch for both');
});
