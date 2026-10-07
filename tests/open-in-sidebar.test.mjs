/* global window */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Store } from '../lib/store.js';
import { createPreviewServer, previewCall } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';

/* 「在右栏打开」 on the practice page moves THAT run into DSH's right sidebar and returns the main area to the conversation.
   The REAL host adapter (ui/host/workspace.jsx) and the REAL App run in Chromium against a real library; only DSH is faked:
   a ctx whose `sidebarRight.openTab` mounts the sidebar seat (as DSH does), an `openView('chat')` that takes the main seat away and a
   `layout.selectPanel(null)` that takes the top-level page away. The sidebar of the fake DSH can also be inert, throw or be missing:
   the button must then say why instead of doing nothing. A reading-started run (`run.reading`) and a library-started run are both covered. */
const bundle = await build({ stdin: { contents: `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import * as workspace from './ui/host/workspace.jsx';
  import { setUiLanguage } from './ui/i18n.js';
  setUiLanguage('zh');
  const seats = {}, roots = {}, log = window.dshLog = [];
  const rpc = { call: async (_route, _path, payload) => {
    const reply = await window.invokeStudy(payload.action, payload.args);
    return reply.ok ? { ok: true, value: reply.value } : { ok: false, error: { message: reply.error, code: reply.code } };
  } };
  // How this fake DSH's right sidebar behaves: works (mounts the seat), inert (openTab does nothing), throws, none (no sidebarRight service).
  const mode = window.dshSidebar || 'works';
  const openTab = { works: (id) => { log.push('openTab:' + id); window.mountSidebar(); }, inert: (id) => { log.push('openTab:' + id); },
    throws: () => { throw new Error('right sidebar is not mounted'); } }[mode];
  const services = {
    connection: { rpc },
    layout: { selectPanel: (id) => { if (id !== null) return; log.push('selectPanel:null'); roots.page?.render(null); } }, // the first-run landing selects the studyhub page: not what is under test
    sidebarRight: mode === 'none' ? undefined : { openTab, openResource() {} },
  };
  const ctx = { get: (name) => services[name], effect(fn) { fn(); }, inject: (_n, fn) => fn(ctx),
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: { inject: (_n, fn) => fn(), register: (descriptor, component) => { seats[descriptor.name + ':' + (descriptor.key || descriptor.id)] = component; return () => {}; } },
    sidebarRightTabs: { register: () => () => {} } };
  window.installDsh = () => workspace.apply(ctx, () => {});
  const mount = (slot, key, node, props) => { roots[key] ||= createRoot(document.getElementById(node)); roots[key].render(React.createElement(seats[slot], props)); };
  window.mountMain = () => mount('conversation.view:study-workspace', 'main', 'main', { sessionId: 's1',
    openView: (view) => { log.push('openView:' + view); roots.main.render(null); } });
  window.mountPage = () => mount('study-workspace.page:undefined', 'page', 'main', { sessionId: 's1' });
  window.mountSidebar = () => mount('sidebar.right.pane.tab:study-workspace', 'side', 'side', { sessionId: 's1' });
`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, platform: 'browser', format: 'iife',
  loader: { '.css': 'text' }, logLevel: 'silent' });

const cards = Array.from({ length: 4 }, (_, i) => ({
  id: `q${i}`, kind: 'quiz', topic: '主动回忆', prompt: `第 ${i + 1} 题：怎样用练习检查理解？`,
  answer: 'a', explanation: '不看答案，尝试解释推理，再对照反馈检查。',
  options: [{ id: 'a', text: '尝试回忆并解释推理', correct: true }, { id: 'b', text: '只看答案', correct: false }],
  review: { repetitions: 0, interval_days: 0, ease_factor: 2.5, due_at: null },
}));
const reading = { documentId: 'doc1', sourceId: 'src1', sectionTitle: '检索练习', page: 2, scope: { kind: 'here', count: 1, label: '这一页' } };

async function open(t, { sidebar = 'works', withReading = true, premount = false, width = 1100, placement = 'main' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'open-in-sidebar-'));
  let server, browser;
  t.after(async () => { await browser?.close(); await server?.close(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  const store = new Store(join(root, 'library'));
  await store.update(state => { state.decks.push({ id: 'deck', title: '检索练习', course: '学习方法', cards }); });
  server = await createPreviewServer({ port: 0, libraryRoot: store.root, home: join(root, 'home'), model: createFakeModel() });
  await previewCall(server, 'review.start', { mode: 'path', scope: [{ deckId: 'deck', cardId: 'q0' }, { deckId: 'deck', cardId: 'q1' }],
    fresh: true, ...(withReading ? { reading } : {}) });
  try { browser = await launchChromium(); }
  catch (error) {
    if (!/browserType\.launch: Executable doesn't exist/.test(error.message)) throw error;
    t.skip('Chromium unavailable'); return null;
  }
  const page = await browser.newPage({ locale: 'zh-CN', reducedMotion: 'reduce', viewport: { width, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('invokeStudy', async (action, args) => {
    try { return { ok: true, value: await previewCall(server, action, args) }; }
    catch (error) { return { ok: false, error: error.message, code: error.code }; }
  });
  await page.route('**/*', route => route.request().url() === 'http://open-in-sidebar.test/'
    ? route.fulfill({ contentType: 'text/html', body: '<div id="main"></div><div id="side"></div>' }) : route.abort());
  await page.goto('http://open-in-sidebar.test/');
  await page.addScriptTag({ content: `window.dshSidebar = ${JSON.stringify(sidebar)};` });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate((where) => { window.installDsh(); where === 'page' ? window.mountPage() : window.mountMain(); }, placement);
  if (premount) {
    await page.evaluate(() => window.mountSidebar());
    await page.locator('#side .study-app').waitFor();
  }
  await page.locator('#main').getByRole('button', { name: /^回到题目/ }).click();
  await page.locator('#main .review-page').waitFor();
  return { page, errors };
}
const sidebarButton = page => page.locator('#main').getByRole('button', { name: '在右栏打开' });
const reasonOf = page => page.getByText(/^没能放进右栏：/).first();

for (const [label, withReading, options] of [['a run started from the reader (run.reading)', true, {}], ['a run started from the library', false, {}],
  ['a reader run into a sidebar that is already open', true, { premount: true }], ['a reader run into a narrow sidebar', true, { width: 380 }]])
  test(`在右栏打开 moves ${label} into the sidebar seat and returns the main area to the conversation`, { timeout: 90000 }, async t => {
    const opened = await open(t, { withReading, ...options });
    if (!opened) return;
    const { page, errors } = opened;
    assert.equal(await page.locator('#main').getByRole('button', { name: '回到原文' }).count(), withReading ? 1 : 0);
    const text = (await page.locator('#main .review-page').getByText('怎样用练习检查理解？').first().textContent()).trim();
    await sidebarButton(page).click();
    // The sidebar seat shows the same run at the same card.
    await page.locator('#side .review-page').getByText(text, { exact: true }).first().waitFor({ timeout: 15000 });
    assert.deepEqual(await page.evaluate(() => window.dshLog), ['openTab:study-workspace', 'openView:chat']);
    assert.equal(await page.locator('#main').innerHTML(), '', 'the main area gave the question up');
    assert.deepEqual(errors, []);
  });

test('the top-level StudyHub page reveals the conversation once the sidebar has the run', { timeout: 90000 }, async t => {
  const opened = await open(t, { placement: 'page' });
  if (!opened) return;
  const { page, errors } = opened;
  await sidebarButton(page).click();
  await page.locator('#side .review-page').waitFor({ timeout: 15000 });
  assert.deepEqual(await page.evaluate(() => window.dshLog), ['openTab:study-workspace', 'selectPanel:null']);
  assert.deepEqual(errors, []);
});

test('with no right sidebar in DSH the button is not drawn', { timeout: 90000 }, async t => {
  const opened = await open(t, { sidebar: 'none' });
  if (!opened) return;
  assert.equal(await sidebarButton(opened.page).count(), 0, 'no button that could only fail');
});

test('a sidebar that throws on openTab is explained in a sentence, the question stays, nothing is left to surprise a later sidebar', { timeout: 90000 }, async t => {
  const opened = await open(t, { sidebar: 'throws' });
  if (!opened) return;
  const { page } = opened;
  await sidebarButton(page).click();
  await reasonOf(page).waitFor({ timeout: 8000 });
  assert.match(await reasonOf(page).textContent(), /right sidebar is not mounted/);
  assert.deepEqual(await page.evaluate(() => window.dshLog), [], 'the main area stays on the question');
  assert.equal(await page.locator('#main .review-page').count(), 1);
  assert.equal(await sidebarButton(page).isEnabled(), true, 'the button is usable again');
  await page.evaluate(() => window.mountSidebar());
  await page.locator('#side .study-app').waitFor();
  await page.waitForTimeout(500);
  assert.equal(await page.locator('#side .review-page').count(), 0, 'a failed handoff is not delivered later');
});

test('a sidebar that never takes the run: busy while it waits, then the learner is told, and the question stays', { timeout: 90000 }, async t => {
  const opened = await open(t, { sidebar: 'inert' });
  if (!opened) return;
  const { page } = opened;
  await sidebarButton(page).click();
  assert.equal(await sidebarButton(page).getAttribute('aria-busy'), 'true');
  await reasonOf(page).waitFor({ timeout: 12000 });
  assert.equal(await sidebarButton(page).getAttribute('aria-busy'), null);
  assert.deepEqual(await page.evaluate(() => window.dshLog), ['openTab:study-workspace'], 'no switch to the conversation without the run in the sidebar');
  assert.equal(await page.locator('#main .review-page').count(), 1);
  // The sidebar opens later by itself: it must not find the run the learner was told did not move.
  await page.evaluate(() => window.mountSidebar());
  await page.locator('#side .study-app').waitFor();
  await page.waitForTimeout(500);
  assert.equal(await page.locator('#side .review-page').count(), 0);
});

test('the button explains itself on hover or focus through the project Tooltip, not a title attribute', { timeout: 90000 }, async t => {
  const opened = await open(t);
  if (!opened) return;
  const { page } = opened;
  const button = sidebarButton(page);
  assert.equal(await button.getAttribute('title'), null);
  const tip = page.locator('#main .review-heading [role="tooltip"]').filter({ hasText: '右栏' }).first();
  assert.equal(await tip.isVisible(), false, 'hidden until hover or focus');
  await button.focus();
  await tip.waitFor({ state: 'visible', timeout: 5000 });
  const words = await tip.textContent();
  assert.match(words, /主区域回到对话/);
  assert.match(words, /接着/);
});
