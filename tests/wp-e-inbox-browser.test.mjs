/* global window, document */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { launchChromium } from '../scripts/qa/browser.mjs';

// UI wave 1, WP-E: the mailbox is a dialog panel, so focus goes in when it opens and comes back to the toggle on Escape,
// an outside press closes it without stealing focus, and the toggle closes it too. Needs a real browser.
const bundle = await build({ stdin: { resolveDir: process.cwd(), loader: 'jsx', contents: `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import Inbox from './ui/Inbox.jsx';
  const items = [{ id: 'm1', kind: 'pdf-result', label: 'PDF 转换完成', prompt: 'a.pdf', deckTitle: 'PDF 转换', detail: '', at: new Date().toISOString(), read: false }];
  createRoot(document.getElementById('root')).render(<div className="study-app"><Inbox inbox={{ unread: 1, items }} onOpen={() => {}} onReadAll={() => {}} />
    <button id="elsewhere" type="button">elsewhere</button></div>);
  window.harnessReady = true;` },
bundle: true, write: false, format: 'iife', platform: 'browser', loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
const script = bundle.outputFiles[0].text;

let browser, unavailable = false;
try { browser = await launchChromium(); }
catch (error) { if (!/Executable doesn't exist|browserType\.launch/.test(String(error.message))) throw error; unavailable = true; }
after(() => browser?.close());

async function open(t) {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 }, locale: 'zh-CN' });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>');
  await page.addScriptTag({ content: script });
  await page.waitForFunction(() => window.harnessReady);
  return page;
}
const inside = page => page.evaluate(() => !!document.activeElement?.closest('.mailbox__panel'));
const onToggle = page => page.evaluate(() => document.activeElement?.classList.contains('mailbox__toggle'));

test('opening the mailbox moves focus into the panel; Escape closes it and returns focus to the toggle', { skip: unavailable }, async t => {
  const page = await open(t);
  await page.locator('.mailbox__toggle').click();
  await page.locator('.mailbox__panel').waitFor();
  assert.equal(await inside(page), true, 'focus is inside the dialog');
  await page.keyboard.press('Escape');
  await page.locator('.mailbox__panel').waitFor({ state: 'detached' });
  assert.equal(await onToggle(page), true, 'focus is back on the toggle');
});

test('an outside press closes the mailbox without taking focus; the toggle closes it too', { skip: unavailable }, async t => {
  const page = await open(t);
  await page.locator('.mailbox__toggle').click();
  await page.locator('.mailbox__panel').waitFor();
  await page.locator('#elsewhere').click();
  await page.locator('.mailbox__panel').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'elsewhere', 'focus stays where the learner went');
  await page.locator('.mailbox__toggle').click();
  await page.locator('.mailbox__panel').waitFor();
  await page.locator('.mailbox__toggle').click();
  await page.locator('.mailbox__panel').waitFor({ state: 'detached' });
  assert.equal(await onToggle(page), true);
});
