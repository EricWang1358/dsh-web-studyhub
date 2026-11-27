/* global document, innerWidth */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Store } from '../lib/store.js';
import { recapTitle } from '../lib/contexts/notes/note-links.js';
import { createPreviewServer, previewCall } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { launchChromium, skipMissingChromium } from '../scripts/qa/browser.mjs';

/* #1709 / #1710 / #1711, measured in the app: the list of 学习笔记 is as wide as the other pages and centred like them (the owner saw it from a 2000px dark
   window with the sidebar put away), its rows are one height, today's recap is offered once (by the card), and a sidebar page has no way back. */

const bundle = await build({ stdin: { contents: `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import App from './ui/App.jsx';
  import { setUiLanguage } from './ui/i18n.js';
  import css from './ui/styles.js';
  setUiLanguage('zh');
  const style = document.createElement('style'); style.textContent = css; document.head.append(style);
  window.callStudy = async (action, args) => {
    const reply = await window.invokeStudy(action, args);
    if (!reply.ok) throw Object.assign(new Error(reply.error), { code: reply.code });
    return reply.value;
  };
  createRoot(document.getElementById('root')).render(<App call={window.callStudy} />);
`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, platform: 'browser', format: 'iife',
  loader: { '.css': 'text' }, logLevel: 'silent' });

const pad = (value) => String(value).padStart(2, '0');
const dayBack = (days) => { const at = new Date(); at.setDate(at.getDate() - days); return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`; };
const course = '学习方法';
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const card = (id) => ({ id, kind: 'quiz', topic: '主动回忆', prompt: `怎样用练习检查理解？${id}`, answer: 'a', explanation: '先回忆，再核对。',
  options: [{ id: 'a', text: '回忆后核对', correct: true }, { id: 'b', text: '只看答案', correct: false }],
  review: { repetitions: 0, interval_days: 0, ease_factor: 2.5, due_at: null } });
const recap = (days) => {
  const daily = { day: dayBack(days), course, answeredCount: 10 + days, wrongCount: 1, timeZone };
  return { id: `recap-${days}`, kind: 'daily-recap', title: recapTitle(daily, 'zh'), daily, status: 'draft', revision: 1, cards: [{ deckId: 'deck', cardId: 'q0' }],
    markdown: '## 已经稳住的\n\n先回忆再核对。', createdAt: `${daily.day}T10:00:00.000Z`, updatedAt: `${daily.day}T10:00:00.000Z` };
};

const box = (page, selector) => page.evaluate((value) => {
  const element = document.querySelector(value);
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) };
}, selector);

test('学习笔记: the list shares the width of every page, its rows are even, today\'s recap is offered once, and the sidebar page has no way back', { timeout: 120000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'notes-page-'));
  let server, browser;
  t.after(async () => { await browser?.close(); await server?.close(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  const store = new Store(join(root, 'library'));
  await store.update((state) => {
    state.settings = { ...state.settings, dailyRecap: { automatic: false, tone: 'friendly', timeZone } };
    state.decks.push({ id: 'deck', title: '检索练习', course, cards: Array.from({ length: 3 }, (_, i) => card(`q${i}`)) });
    state.sources.push({ id: 'source', title: '讲义', course, text: '先回忆，再核对。', createdAt: new Date().toISOString() });
    state.notes = [recap(0), recap(1), recap(2),
      { id: 'plain', title: '一篇标题很长的笔记：怎样把练过的题写成能公开发布的知识点文章，并且在很窄的窗口里也只占和别的行一样的高度', status: 'draft', revision: 0,
        markdown: '# 笔记', cards: [{ deckId: 'deck', cardId: 'q1' }], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }];
  });
  server = await createPreviewServer({ port: 0, libraryRoot: store.root, home: join(root, 'home'), model: createFakeModel() });
  await previewCall(server, 'focus.set', { course });
  try { browser = await launchChromium(); }
  catch (error) { skipMissingChromium(t, error); return; }
  const page = await browser.newPage({ locale: 'zh-CN', reducedMotion: 'reduce', viewport: { width: 2000, height: 1088 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.exposeFunction('invokeStudy', async (action, args) => {
    try { return { ok: true, value: await previewCall(server, action, args) }; }
    catch (error) { return { ok: false, error: error.message, code: error.code }; }
  });
  await page.route('**/*', (route) => route.request().url() === 'http://notes-page.test/'
    ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<meta charset="utf-8"><style>body{margin:0}#root{height:100vh}</style><div id="root"></div>' }) : route.abort());
  await page.goto('http://notes-page.test/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  // The sidebar is put away (the owner's window), so a page is reached through the drawer.
  const go = async (id) => {
    await page.locator('[data-tour="nav-menu"]').first().click();
    const item = page.locator(`[data-tour="nav-${id}"]`).first();
    if (!await item.isVisible()) await page.locator('dialog[open] [data-nav-fold] .nav-fold__toggle').first().click();
    await item.click();
    await item.waitFor({ state: 'hidden' });
  };
  await page.locator('[data-tour="nav-collapse"]').first().click({ timeout: 30000 });
  await go('sources');
  await page.locator('main .page h1').first().waitFor();
  const widths = [[2000, 1088], [1440, 900], [1920, 1080], [2560, 1440]];
  const reference = new Map();
  for (const [width, height] of widths) {
    await page.setViewportSize({ width, height });
    reference.set(width, await box(page, 'main .page'));
  }
  await page.setViewportSize({ width: 2000, height: 1088 });
  await go('notes');
  await page.getByRole('button', { name: '阅读今日合集' }).waitFor({ timeout: 20000 });
  for (const [width, height] of widths) {
    await page.setViewportSize({ width, height });
    const list = await box(page, '.blog-notes-page');
    assert.deepEqual(list, reference.get(width), `${width}px: the notes page is where the sources page is`);
    const inner = await box(page, '.blog-notes-page .note-list'), header = await box(page, '.blog-notes-page .sh-page-header');
    assert.deepEqual([inner.left, inner.right], [header.left, header.right], `${width}px: header and list are one column`);
    assert.ok(inner.width > list.width - 100, `${width}px: the list fills the column (${inner.width} of ${list.width})`);
  }

  // Today's recap is the card's; the rows are the other three, each as high as the next, at a wide and at a narrow window.
  const rows = () => page.locator('.note-list-item').evaluateAll((items) => items.map((item) => ({ height: Math.round(item.getBoundingClientRect().height), text: item.innerText })));
  await page.waitForFunction(() => document.querySelectorAll('.note-list-item').length === 3);
  for (const [width, height] of [[2000, 1088], [420, 860]]) {
    await page.setViewportSize({ width, height });
    const seen = await rows();
    assert.equal(new Set(seen.map((row) => row.height)).size, 1, `${width}px: one height: ${JSON.stringify(seen)}`);
    assert.ok(!seen.some((row) => row.text.includes(dayBack(0))), 'today\'s recap is not listed again');
    assert.equal(seen.filter((row) => row.text.includes(dayBack(1))).length, 1);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px: nothing runs off the side`);
  }
  await page.setViewportSize({ width: 2000, height: 1088 });
  assert.equal(await page.getByRole('button', { name: /返回学习库/ }).count(), 0, 'from the sidebar there is no way back');

  // 挑题成文: a button above the rows that opens its form and closes it again.
  const compose = page.getByRole('button', { name: '挑题成文', exact: true });
  assert.ok((await compose.boundingBox()).y < (await page.locator('.note-list-item').first().boundingBox()).y);
  await compose.click();
  await page.getByLabel('笔记标题').waitFor();
  assert.equal(await compose.getAttribute('aria-expanded'), 'true');
  await compose.click();
  assert.equal(await page.getByLabel('笔记标题').count(), 0);

  // An open note keeps the whole window, as before, and its way back to the list.
  await page.locator('.note-list-item').first().click();
  await page.locator('.blog-notes-page[data-note-open]').waitFor();
  const main = await box(page, '.study-app main'), open = await box(page, '.blog-notes-page');
  assert.ok(open.width >= main.width - 24, `an open note takes the window (${open.width} of ${main.width})`);
  await page.getByRole('button', { name: '全部笔记', exact: true }).click();
  await page.locator('.note-list').waitFor();
  assert.deepEqual(errors, []);
});
