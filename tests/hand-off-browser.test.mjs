/* global window document */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Store } from '../lib/store.js';
import { createPreviewServer, previewCall } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { seedBookFixture } from './helpers/book-fixtures.mjs';

/* 「发给主会话」 in Chromium through the REAL host adapter (ui/host/workspace.jsx) and the REAL App on a real library with a 复习全书 (the hand-off plan, S2a):
   only DSH is faked, and its conversation is wrapped in a Proxy whose submit throws. From the book's 问 AI panel:
     an empty composer gets the prompt by setDraft only, and the notice says to check it and press send;
     a composer that holds the learner's words is not written to: the prompt is copied and the notice says why;
     without a conversation it is copied; a refused clipboard shows the whole prompt in a notice that stays.
   Then the small shared-component changes, in a page of their own: ConfirmDialog's errorAction, FileDrop's rejectAction, CompactJobCard's link onClick
   and tip. Screenshots (zh; 1280×800 and 390×844, light and dark) go to HANDOFF_SHOTS when it is set; otherwise only 1280 light runs. */

const host = await build({ stdin: { contents: `
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
  // DSH's session input (SessionInputShell): what is typed is window.composerText; setDraft replaces it; submit must never be reached.
  const shell = {
    get projection() { return { detectText: window.composerText }; },
    state: { getSnapshot: () => ({ draft: window.composerText, attachmentIds: [] }) },
    setDraft: (text) => { log.push('setDraft'); window.composerText = text; },
    submit: () => { log.push('submit'); },
    actions: { submit: () => { log.push('actions.submit'); } },
  };
  const guarded = (target, path) => new Proxy(target, { get(object, key) {
    if (key === 'submit') { log.push('submit-touched:' + path); throw new Error(path + '.submit must never be called'); }
    const value = object[key];
    return value && typeof value === 'object' ? guarded(value, path + '.' + String(key)) : value;
  } });
  const conversation = { input: { for: () => guarded(shell, 'input') } };
  const services = {
    connection: { rpc },
    layout: { selectPanel: (id) => { if (window.dshReady) log.push('selectPanel:' + id); } },
    sessions: { scope: () => ({ get: (name) => (name === 'conversation' && !window.noChat ? conversation : undefined) }) },
  };
  const ctx = { get: (name) => services[name], effect(fn) { fn(); }, inject: (_n, fn) => fn(ctx),
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: { inject: (_n, fn) => fn(), register: (descriptor, component) => { seats[descriptor.name + ':' + (descriptor.key || descriptor.id)] = component; return () => {}; } },
    sidebarRightTabs: { register: () => () => {} } };
  window.installDsh = () => workspace.apply(ctx, () => {});
  window.mountPage = () => { roots.page ||= createRoot(document.getElementById('main')); roots.page.render(React.createElement(seats['study-workspace.page:undefined'], { sessionId: 's1' })); };
`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', loader: { '.css': 'text' }, logLevel: 'silent' });

const parts = await build({ stdin: { contents: `
  import React, { useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import { ConfirmDialog, FileDrop, Menu } from './ui/components/index.js';
  import CompactJobCard from './ui/tasks/CompactJobCard.jsx';
  import { AppContext } from './ui/app/app-context.js';
  import css from './ui/styles.js';
  import { setUiLanguage } from './ui/i18n.js';
  setUiLanguage('zh');
  const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
  const log = window.partsLog = [];
  const action = (label) => ({ label, onClick: () => log.push(label), tip: label + ' 的说明' });
  function Parts() {
    const [open, setOpen] = useState(true);
    const job = { id: 'j1', type: 'audio-import', filename: 'Week 3.wav', status: 'failed', error: 'ffmpeg missing', startedAt: '2026-10-05T10:00:00.000Z' };
    return React.createElement(AppContext.Provider, { value: { core: {}, nav: {} } },
      React.createElement('div', { className: 'study-app', style: { padding: 16, height: '100vh', boxSizing: 'border-box', overflow: 'auto' } },
        // (A fixed-height surface that scrolls, as the app's is: the Menu closes on a scroll of the page around it.)
        // A Menu item that carries run (useHandOff().item) runs it on select; one without goes to onSelect as before.
        React.createElement(Menu, { label: '更多', onSelect: (id) => log.push('select:' + id),
          items: [{ id: 'hand-off:deck.ask', label: '交给它', run: () => log.push('run:item') }, { id: 'plain', label: '普通项' }] }),
        React.createElement(FileDrop, { accept: ['.pdf'], multiple: true, rejectAction: (rejections) => action('拒收 ' + rejections.length), onFiles: () => {} }),
        React.createElement(FileDrop, { accept: ['.pdf'], className: 'plain-drop', onFiles: () => {} }),
        React.createElement(CompactJobCard, { job, onDismiss: () => {}, links: [{ label: '旧写法', run: () => log.push('run') }, { label: '新写法', onClick: () => log.push('onClick'), tip: '新写法的说明' }] }),
        open && React.createElement(ConfirmDialog, { title: '删除？', confirmLabel: '删除', onConfirm: async () => { throw new Error('被前置题挡住'); },
          errorAction: (error) => action('换个做法：' + error), onClose: () => setOpen(false) })));
  }
  createRoot(document.getElementById('main')).render(React.createElement(Parts));
`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', loader: { '.css': 'text' }, logLevel: 'silent' });

const shots = process.env.HANDOFF_SHOTS;
const views = shots ? [[1280, 800, 'light'], [1280, 800, 'dark'], [390, 844, 'light'], [390, 844, 'dark']] : [[1280, 800, 'light']];

test('发给主会话 from the book through the real host adapter: filled, kept, copied and shown; submit is never reached', { timeout: 600000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const root = await mkdtemp(join(tmpdir(), 'hand-off-browser-'));
  t.after(async () => { await browser.close(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  await seedBookFixture(join(root, 'library'), 'archss');
  const server = await createPreviewServer({ port: 0, libraryRoot: new Store(join(root, 'library')).root, home: join(root, 'home'), model: createFakeModel() });
  t.after(() => server.close());
  if (shots) await mkdir(shots, { recursive: true });
  for (const [width, height, theme] of views) {
    const context = await browser.newContext({ viewport: { width, height }, locale: 'zh-CN', colorScheme: theme, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.exposeFunction('invokeStudy', async (action, args) => {
      try { return { ok: true, value: await previewCall(server, action, args) }; } catch (error) { return { ok: false, error: error.message, code: error.code }; }
    });
    await context.addInitScript(([chosen]) => {
      try { localStorage.setItem('study-ui-language', 'zh'); localStorage.setItem('study-theme', chosen); } catch { /* blocked */ }
      window.composerText = ''; window.copied = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => {
        if (window.refuseClipboard) throw new Error('NotAllowedError'); window.copied.push(text); } } });
    }, [theme]);
    await page.route('**/*', (route) => (route.request().url() === 'http://hand-off.test/' ? route.fulfill({ contentType: 'text/html', body: '<div id="main"></div>' }) : route.abort()));
    await page.goto('http://hand-off.test/');
    await page.addScriptTag({ content: host.outputFiles[0].text });
    await page.evaluate(() => { window.installDsh(); window.mountPage(); });
    await page.waitForTimeout(100);
    await page.evaluate(() => { window.dshReady = true; });
    await page.locator('[data-tour="nav-book"]').first().click({ timeout: 60000 });
    await page.locator('[data-book-point]').first().waitFor({ timeout: 60000 });
    const tag = `${width}-${theme}`;
    // A picture waits for the toast's entrance to end; a hovered button waits for its Tooltip.
    const shot = async (name) => { if (shots) { await page.waitForTimeout(600); await page.screenshot({ path: join(shots, `${name}-${tag}.png`) }); } };
    // The pointer is moved onto the button without scrolling (a scroll would carry the panel or the selection bar away with its anchor).
    const hoverTip = async (button) => {
      const box = await button.boundingBox();
      if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.getByRole('tooltip').filter({ hasText: '只填进主会话的输入框' }).first().waitFor({ timeout: 3000 }).catch(() => {});
    };
    const notice = page.locator('.sh-toasts .sh-toast').first();
    const reset = async (state) => {
      await page.evaluate((s) => { Object.assign(window, { composerText: '', noChat: false, refuseClipboard: false, copied: [] }, s); window.dshLog.length = 0; }, state);
      const close = page.locator('.sh-toast__close');
      if (await close.count()) await close.first().click();
    };
    const sendFromPanel = async () => {
      await page.locator('.book-step [data-book-ask-open]').first().click();
      const panel = page.locator('.book-ask[data-placed]');
      await panel.waitFor({ timeout: 10000 });
      await panel.locator('textarea').fill('讲得再慢一点');
      if (shots && !(await page.evaluate(() => window.panelShot))) { await page.evaluate(() => { window.panelShot = true; }); await hoverTip(page.locator('[data-book-ask="chat"]')); await shot('ask-panel'); }
      await panel.locator('[data-book-ask="chat"]').click();
      await panel.waitFor({ state: 'detached', timeout: 10000 });
    };

    // An empty composer: setDraft only, the prompt in it; the conversation is revealed (the page placement asks the layout for it).
    await reset({});
    await sendFromPanel();
    await notice.getByText('已填进主会话的输入框，确认后按发送。').waitFor({ timeout: 10000 });
    let state = await page.evaluate(() => ({ log: window.dshLog.slice(), text: window.composerText, copied: window.copied.slice() }));
    assert.deepEqual(state.log, ['setDraft', 'selectPanel:null'], `${tag}: setDraft and nothing else`);
    assert.match(state.text, /请用 study-book 技能和 book\.\* 工具，帮我改复习全书里的这一个知识点/);
    assert.match(state.text, /```request 我的要求\n讲得再慢一点\n```/);
    assert.ok(state.text.endsWith('请用中文回复；已有的题目和引文保持原文，不要翻译。'), `${tag}: the one language sentence ends it`);
    assert.doesNotMatch(state.text, /languagePreference|This overrides generic language defaults/, `${tag}: no long English block in the box`);
    assert.deepEqual(state.copied, []);
    await shot('notice-filled');

    // The learner's own words in the composer: nothing is written; the prompt is copied and the notice says why.
    await reset({ composerText: '我自己先打的字' });
    await sendFromPanel();
    await notice.getByText('输入框里已有文字，没有覆盖：提示词已复制，粘贴到合适的位置再发送。').waitFor({ timeout: 10000 });
    state = await page.evaluate(() => ({ log: window.dshLog.slice(), text: window.composerText, copied: window.copied.slice() }));
    assert.deepEqual(state.log, [], `${tag}: no write, no submit, no view switch`);
    assert.equal(state.text, '我自己先打的字', `${tag}: the learner's words stay`);
    assert.equal(state.copied.length, 1);
    assert.match(state.copied[0], /讲得再慢一点/);
    await shot('notice-kept');

    // No conversation: copied.
    await reset({ noChat: true });
    await sendFromPanel();
    await notice.getByText('没有主会话：提示词已复制，粘贴到对话里再发送。').waitFor({ timeout: 10000 });
    assert.equal((await page.evaluate(() => window.copied)).length, 1);
    await shot('notice-copied');

    // The selection bar's 发给主会话 (it sends the selected words at once): a picture of the bar, then the same delivery.
    await reset({ noChat: true });
    await page.evaluate(() => {
      const paragraph = [...document.querySelectorAll('[data-book-point] .book-file p')].find((element) => (element.textContent || '').trim().length > 30 && !element.closest('.book-ai'));
      const node = [...paragraph.childNodes].find((child) => child.nodeType === 3 && child.textContent.trim().length > 12);
      paragraph.scrollIntoView({ block: 'center', behavior: 'instant' });
      const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, Math.min(node.textContent.length, 12));
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    });
    const bar = page.locator('.book-select[data-placed]');
    await bar.waitFor({ timeout: 10000 });
    if (shots) { await hoverTip(bar.locator('[data-book-select="chat"]')); await shot('selection-bar'); }
    await bar.locator('[data-book-select="chat"]').click();
    await notice.getByText('没有主会话：提示词已复制，粘贴到对话里再发送。').waitFor({ timeout: 10000 });
    assert.match((await page.evaluate(() => window.copied))[0], /```data 我选中的话\n/);

    // A refused clipboard: the whole prompt in a notice that stays, under its title.
    await reset({ noChat: true, refuseClipboard: true });
    await sendFromPanel();
    await notice.getByText('复制这段提示词，粘贴到对话里').waitFor({ timeout: 10000 });
    assert.match(await notice.locator('.sh-toast__message').innerText(), /请用 study-book 技能[\s\S]*讲得再慢一点[\s\S]*不要翻译。$/);
    await page.waitForTimeout(6500);
    assert.equal(await notice.getByText('复制这段提示词，粘贴到对话里').count(), 1, `${tag}: it stays`);
    await shot('notice-shown');
    // 更多 › 整本书 › 发给主会话…: its hint is the short rule (one line beside the label, on a phone too).
    await page.locator('.sh-toast__close').first().click();
    await page.locator('.book-bar__more').first().click();
    const item = page.getByRole('menuitem', { name: /^发给主会话…/ });
    assert.match(await item.innerText(), /只填进输入框，不自动发送/);
    await item.scrollIntoViewIfNeeded();
    await shot('more-menu');
    await page.keyboard.press('Escape');

    // 学习流 still hands over through askInChat until S2b moves it: the shared notice is the last word there too; no older toast of its own
    // (「请求已准备好，请在主对话确认发送…」) replaces it and tells a learner whose box was kept that the request is waiting in the main chat.
    if (shots || (width === 1280 && theme === 'light')) {
      await reset({ composerText: '我自己先打的字' });
      await page.getByRole('button', { name: '回到总纲' }).first().click();
      await page.locator('[data-tour="nav-workflows"]').first().click();
      await page.locator('details.wf-advanced > summary').click();
      const chat = page.locator('details.wf-advanced details.wf-chat');
      await chat.locator('summary').click();
      await chat.locator('textarea').fill('先讲例子');
      await chat.getByRole('button').click();
      await notice.getByText('输入框里已有文字，没有覆盖：提示词已复制，粘贴到合适的位置再发送。').waitFor({ timeout: 10000 });
      await page.waitForTimeout(800);
      assert.equal(await page.locator('.sh-toasts').getByText(/请求已准备好/).count(), 0, `${tag}: no toast of the page's own after the hand-off`);
      assert.match(await notice.innerText(), /输入框里已有文字，没有覆盖/, `${tag}: the shared notice stays the last word`);
      assert.equal(await page.evaluate(() => window.composerText), '我自己先打的字');
      await shot('workflows-notice-kept');
    }

    assert.equal((await page.evaluate(() => window.dshLog)).some((entry) => /submit/.test(entry)), false, `${tag}: submit was never touched`);
    assert.deepEqual(errors, [], `${tag}: no page errors`);
    await context.close();
  }
});

test('the shared parts: ConfirmDialog\'s errorAction on its error line, FileDrop\'s rejectAction under the refused files, CompactJobCard links with onClick and a tip', { timeout: 120000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 900, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => (route.request().url() === 'http://parts.test/' ? route.fulfill({ contentType: 'text/html', body: '<div id="main"></div>' }) : route.abort()));
  await page.goto('http://parts.test/');
  await page.addScriptTag({ content: parts.outputFiles[0].text });
  // The confirm fails: the error line carries the other way on, with its tip.
  const dialog = page.locator('dialog[open]');
  await dialog.getByRole('button', { name: '删除' }).click();
  const other = dialog.getByRole('button', { name: '换个做法：被前置题挡住' });
  await other.waitFor({ timeout: 5000 });
  await other.click();
  await dialog.getByRole('button', { name: '取消' }).click();
  await dialog.waitFor({ state: 'detached' });
  // A refused file: the drop with rejectAction offers it under the list; the one without does not.
  const inputs = page.locator('input[type=file]');
  await inputs.nth(0).setInputFiles({ name: 'notes.epub', mimeType: 'application/epub+zip', buffer: Buffer.from('x') });
  await inputs.nth(1).setInputFiles({ name: 'notes.epub', mimeType: 'application/epub+zip', buffer: Buffer.from('x') });
  const refused = page.locator('.sh-drop__rejects');
  await refused.first().waitFor();
  assert.equal(await refused.count(), 2);
  assert.equal(await refused.nth(0).getByRole('button', { name: '拒收 1' }).count(), 1);
  assert.equal(await refused.nth(1).locator('.sh-inline__secondary').count(), 0, 'no rejectAction, no button');
  await refused.nth(0).getByRole('button', { name: '拒收 1' }).click();
  // The card's links: run (as before) and onClick both work; a tip shows on focus.
  await page.getByRole('button', { name: '旧写法' }).click();
  const newer = page.getByRole('button', { name: '新写法' });
  await newer.focus();
  await page.getByRole('tooltip').filter({ hasText: '新写法的说明' }).waitFor({ timeout: 5000 });
  await newer.click();
  // The menu: the item with run is run (and not also handed to onSelect); the plain one reaches onSelect.
  const more = page.getByRole('button', { name: '更多' });
  // (Chosen from the keyboard, as the Menu's own focus puts the first item under it: this bare page is no study surface to place the list in view.)
  await more.click();
  await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'menuitem');
  await page.keyboard.press('Enter');
  await more.click();
  await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'menuitem');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => window.partsLog), ['换个做法：被前置题挡住', '拒收 1', 'run', 'onClick', 'run:item', 'select:plain']);
  assert.deepEqual(errors, []);
});
