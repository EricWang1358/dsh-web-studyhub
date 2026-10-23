/* global window document getComputedStyle DataTransfer ClipboardEvent */
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
   only DSH is faked, and its conversation is wrapped in a Proxy whose submit throws. From the book's 问 AI panel, with direction B's receipts:
     an empty composer gets the message by setDraft only (the learner's sentence first), and the receipt 填 says to check it and press send, then leaves;
     a composer that holds the learner's words is not written to: the message is copied, the receipt 留 offers 去主会话, a second send takes the same slip;
     without a conversation it is copied (复, 看看内容 opens the card); a refused clipboard opens the full-text card at once (no slip; the notes folded,
     select-all in the ochre highlighter), and only closing it without copying leaves the 手 slip, which stays; 更多 › 整本书 › 发给主会话 sends at once.
   Then the small shared-component changes, in a page of their own: ConfirmDialog's errorAction, FileDrop's rejectAction, CompactJobCard's link onClick
   and tip, a receipt in review's in-flow action slot and under reduced motion, and a receipt's time (held while pointed at, focused or the page hidden,
   then the rest of it; a newer stamp starts it again). At 390 every receipt is one title line and one text line, at most 88px, all of one height.
   Screenshots (zh and en; 1280×800 and 390×844, light and dark) go to HANDOFF_SHOTS when it is set; otherwise Chinese 1280 light and both languages at
   390 light run. */

const host = await build({ stdin: { contents: `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import * as workspace from './ui/host/workspace.jsx';
  import { setUiLanguage } from './ui/i18n.js';
  setUiLanguage(window.uiLanguage || 'zh');
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
  import ActionFeedback from './ui/ActionFeedback.jsx';
  import { handOffReceipt } from './ui/hand-off/use-hand-off.js';
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
          errorAction: (error) => action('换个做法：' + error), onClose: () => setOpen(false) }),
        // a receipt in review's in-flow action slot (placement 'auto' inside .action-feedback-slot), once the dialog is closed (an open dialog takes the page's toasts)
        !open && React.createElement('div', { className: 'action-feedback-slot' },
          React.createElement(ActionFeedback, { notice: { ...handOffReceipt('kept', { action: { label: '去主会话', run: () => log.push('chat') } }), key: 1 } }))));
  }
  // A receipt whose time the test sets (window.showReceipt(key, timeout)), in a slot of its own; it logs when it leaves.
  function Timed() {
    const [notice, setNotice] = useState(null);
    window.showReceipt = (key, timeout) => setNotice({ ...handOffReceipt('kept', { action: { label: '去主会话', run: () => log.push('timed') } }), timeout, key });
    return React.createElement('div', { className: 'timed-slot' },
      React.createElement(ActionFeedback, { notice, placement: 'inline', onCloseNotice: () => { log.push('timed:gone'); setNotice(null); } }));
  }
  createRoot(document.getElementById('main')).render(React.createElement(React.Fragment, null, React.createElement(Parts), React.createElement(Timed)));
`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', loader: { '.css': 'text' }, logLevel: 'silent' });

const shots = process.env.HANDOFF_SHOTS;
const views = shots
  ? ['zh', 'en'].flatMap((language) => [[1280, 800, 'light'], [1280, 800, 'dark'], [390, 844, 'light'], [390, 844, 'dark']].map((view) => [...view, language]))
  : [[1280, 800, 'light', 'zh'], [390, 844, 'light', 'zh'], [390, 844, 'light', 'en']];
/* What each language says (the receipts of ui/hand-off/use-hand-off.js HAND_OFF_RECEIPTS and the card's words). */
const WORDS = {
  zh: { filled: '已填进主会话的输入框', kept: '输入框里你写的字都留着', copied: '已复制到剪贴板', shown: '请手动复制', chat: '去主会话', look: '看看内容', open: '打开全文',
    copy: '复制全文', done: '已复制', send: '发给主会话', ask: /^帮我按下面的要求改复习全书的知识点 `[^`]+`：\n```request 我的要求\n讲得再慢一点\n```\n\n—— StudyHub 附注（给助手）——\n/,
    book: /^帮我看看整本复习全书：/, selected: /```data 我选中的话\n/, fold: /^StudyHub 附注（给助手）· \d+ 行$/, request: '讲得再慢一点', hint: /只填进输入框，不自动发送/ },
  en: { filled: 'In the main chat’s box', kept: 'Your typed text is kept', copied: 'Copied to the clipboard', shown: 'Copy it by hand', chat: 'Go to the main chat',
    look: 'See it', open: 'Open the full text', copy: 'Copy all', done: 'Copied', send: 'Send to the main chat',
    ask: /^Please change `[^`]+` in my Review book as I ask below:\n```request My request\nExplain it more slowly\n```\n\n— StudyHub notes \(for the assistant\) —\n/,
    book: /^Please look through my whole Review book:/, selected: /```data My selected words\n/, fold: /^StudyHub notes \(for the assistant\) · \d+ lines$/, request: 'Explain it more slowly', hint: /Only fills the input box/ },
};

test('发给主会话 from the book through the real host adapter: the four receipts, the full-text card, the whole book from 更多; submit is never reached', { timeout: 900000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const root = await mkdtemp(join(tmpdir(), 'hand-off-browser-'));
  t.after(async () => { await browser.close(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  await seedBookFixture(join(root, 'library'), 'archss');
  const server = await createPreviewServer({ port: 0, libraryRoot: new Store(join(root, 'library')).root, home: join(root, 'home'), model: createFakeModel() });
  t.after(() => server.close());
  if (shots) await mkdir(shots, { recursive: true });
  for (const [width, height, theme, language] of views) {
    const words = WORDS[language];
    const context = await browser.newContext({ viewport: { width, height }, locale: language === 'zh' ? 'zh-CN' : 'en-US', colorScheme: theme, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (process.env.HANDOFF_DEBUG) console.log('PAGE', message.type(), message.text().slice(0, 300)); });
    await page.exposeFunction('invokeStudy', async (action, args) => {
      try { return { ok: true, value: await previewCall(server, action, args) }; } catch (error) { return { ok: false, error: error.message, code: error.code }; }
    });
    await context.addInitScript(([chosen, lang]) => {
      try { localStorage.setItem('study-ui-language', lang); localStorage.setItem('study-theme', chosen); } catch { /* blocked */ }
      window.uiLanguage = lang;
      window.composerText = ''; window.copied = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => {
        if (window.refuseClipboard) throw new Error('NotAllowedError'); window.copied.push(text); } } });
    }, [theme, language]);
    await page.route('**/*', (route) => (route.request().url() === 'http://hand-off.test/' ? route.fulfill({ contentType: 'text/html', body: '<div id="main"></div>' }) : route.abort()));
    await page.goto('http://hand-off.test/');
    await page.addScriptTag({ content: host.outputFiles[0].text });
    await page.evaluate(() => { window.installDsh(); window.mountPage(); });
    await page.waitForTimeout(100);
    await page.evaluate(() => { window.dshReady = true; });
    await page.locator('[data-tour="nav-book"]').first().click({ timeout: 60000 });
    await page.locator('[data-book-point]').first().waitFor({ timeout: 60000 });
    const tag = `${language}-${width}-${theme}`;
    // A picture waits for the slip's entrance to end; a hovered button waits for its Tooltip.
    const shot = async (name) => { if (shots) { await page.waitForTimeout(600); await page.screenshot({ path: join(shots, `${name}-${tag}.png`) }); } };
    // The pointer is moved onto the button without scrolling (a scroll would carry the panel or the selection bar away with its anchor).
    const hoverTip = async (button) => {
      const box = await button.boundingBox();
      if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.getByRole('tooltip').first().waitFor({ timeout: 3000 }).catch(() => {});
    };
    const slip = page.locator('.sh-toasts .sh-toast--receipt');
    const sheet = page.locator('dialog.sh-handoff-sheet[open]');
    const reset = async (state) => {
      await page.evaluate((s) => { Object.assign(window, { composerText: '', noChat: false, refuseClipboard: false, copied: [] }, s); window.dshLog.length = 0; }, state);
      const close = page.locator('.sh-toast__close');
      if (await close.count()) await close.first().click();
      await page.mouse.move(2, 2);
    };
    const sendFromPanel = async () => {
      await page.locator('.book-step [data-book-ask-open]').first().click();
      const panel = page.locator('.book-ask[data-placed]');
      await panel.waitFor({ timeout: 10000 });
      await panel.locator('textarea').fill(words.request);
      if (shots && !(await page.evaluate(() => window.panelShot))) { await page.evaluate(() => { window.panelShot = true; }); await hoverTip(page.locator('[data-book-ask="chat"]')); await shot('ask-panel'); }
      const chat = await panel.locator('[data-book-ask="chat"]').elementHandle(), before = await chat.boundingBox();
      await chat.click();
      // the button keeps its place and its width while it hands over (no spinner beside it); a handle answers at once, null once the panel has closed
      const during = await chat.boundingBox();
      if (during) assert.equal(Math.round(during.width), Math.round(before.width), `${tag}: the trigger keeps its width`);
      await panel.waitFor({ state: 'detached', timeout: 10000 });
      await page.mouse.move(2, 2);
    };
    // On a phone every receipt is one title line and one text line, at most 88px tall, and all of them one height (a newer one never grows the slip).
    const phoneHeights = new Set();
    const receiptOf = async (outcome) => {
      await slip.and(page.locator(`[data-receipt="${outcome}"]`)).waitFor({ timeout: 10000 }).catch(async (error) => {
        console.log('DEBUG', outcome, await page.evaluate(() => ({ toasts: [...document.querySelectorAll('.sh-toasts')].map((e) => e.outerHTML.slice(0, 600)), dialogs: document.querySelectorAll('dialog[open]').length, copied: window.copied.length, log: window.dshLog })));
        throw error;
      });
      if (width < 400) {
        const fit = await slip.evaluate((element) => {
          const lines = (node) => Math.round(node.offsetHeight / parseFloat(getComputedStyle(node).lineHeight));
          return { height: element.offsetHeight, title: lines(element.querySelector('.sh-toast__title')), line: lines(element.querySelector('.sh-toast__message')) };
        });
        assert.ok(fit.height <= 88, `${tag} ${outcome}: the slip is ${fit.height}px tall`);
        assert.deepEqual({ title: fit.title, line: fit.line }, { title: 1, line: 1 }, `${tag} ${outcome}: one title line and one text line`);
        phoneHeights.add(fit.height);
      }
      return { title: await slip.locator('.sh-toast__title').innerText(), line: await slip.locator('.sh-toast__message').innerText(),
        seal: await slip.locator(`.sh-seal[data-o="${outcome}"]`).count(), action: await slip.locator('.sh-toast__action').allInnerTexts() };
    };

    // An empty composer: setDraft only, the message in it; the conversation is revealed (the page placement asks the layout for it). The receipt 填, no action.
    await reset({});
    await sendFromPanel();
    let receipt = await receiptOf('filled');
    assert.deepEqual(receipt, { title: words.filled, line: language === 'zh' ? '看一眼，再由你按发送' : 'Check it, then press send', seal: 1, action: [] }, tag);
    let state = await page.evaluate(() => ({ log: window.dshLog.slice(), text: window.composerText, copied: window.copied.slice() }));
    assert.deepEqual(state.log, ['setDraft', 'selectPanel:null'], `${tag}: setDraft and nothing else`);
    assert.match(state.text, words.ask, `${tag}: the learner's sentence, their words, then the notes`);
    assert.ok(state.text.endsWith(language === 'zh' ? '请用中文回复；已有的题目和引文保持原文，不要翻译。' : 'Please reply in English; keep existing questions and quotations as they are, do not translate them.'), `${tag}: the one language sentence ends it`);
    assert.doesNotMatch(state.text, /languagePreference|This overrides generic language defaults/, `${tag}: no long English block in the box`);
    assert.deepEqual(state.copied, []);
    // no info blue and no cinnabar on the slip: its border, its seal, its line
    const inks = await slip.evaluate((element) => [element, ...element.querySelectorAll('*')].map((node) => getComputedStyle(node)).flatMap((style) => [style.color, style.backgroundColor, style.borderTopColor, style.boxShadow]).join(' '));
    const tokens = await page.evaluate(() => { const style = getComputedStyle(document.querySelector('.study-app')); return [style.getPropertyValue('--info').trim(), style.getPropertyValue('--accent').trim()]; });
    for (const token of tokens.filter(Boolean)) assert.equal(inks.includes(token), false, `${tag}: ${token} is not on a receipt`);
    await shot('receipt-filled');
    if (width === 1280 && theme === 'light') {
      // it leaves by itself after its 5 s, and a newer receipt takes the same slip in place
      await page.waitForTimeout(5600);
      assert.equal(await slip.count(), 0, `${tag}: the filled receipt left after 5 s`);
    }

    // The learner's own words in the composer: nothing is written; the message is copied; 去主会话 is there because this host can show the chat.
    await reset({ composerText: '我自己先打的字' });
    await sendFromPanel();
    receipt = await receiptOf('kept');
    assert.equal(receipt.title, words.kept);
    assert.deepEqual(receipt.action, [words.chat]);
    state = await page.evaluate(() => ({ log: window.dshLog.slice(), text: window.composerText, copied: window.copied.slice() }));
    assert.deepEqual(state.log, [], `${tag}: no write, no submit, no view switch`);
    assert.equal(state.text, '我自己先打的字', `${tag}: the learner's words stay`);
    assert.equal(state.copied.length, 1);
    await shot('receipt-kept');
    // a second hand-off while it is up: one slip, pressed again in place
    await page.locator('.book-step [data-book-ask-open]').first().click();
    await page.locator('.book-ask[data-placed] textarea').fill(words.request);
    await page.locator('.book-ask[data-placed] [data-book-ask="chat"]').click();
    await page.waitForFunction(() => window.copied.length === 2);
    assert.equal(await page.locator('.sh-toasts .sh-toast').count(), 1, `${tag}: one slip`);
    await slip.locator('.sh-toast__action').click();
    assert.deepEqual(await page.evaluate(() => window.dshLog.slice()), ['selectPanel:null'], `${tag}: 去主会话 shows the chat`);

    // No conversation: copied; 看看内容 opens the card with what was copied (the quiet copy button there), and no slip floats inside it.
    await reset({ noChat: true });
    await sendFromPanel();
    receipt = await receiptOf('copied');
    assert.equal(receipt.title, words.copied);
    assert.deepEqual(receipt.action, [words.look]);
    assert.equal((await page.evaluate(() => window.copied)).length, 1);
    await shot('receipt-copied');
    await slip.locator('.sh-toast__action').click();
    await sheet.waitFor({ timeout: 10000 });
    assert.equal(await page.locator('.sh-toast--receipt').count(), 0, `${tag}: the slip left before the card opened`);
    assert.equal(await sheet.locator('.sh-handoff-sheet__copy.sh-btn--secondary').count(), 1);
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'detached', timeout: 10000 });

    // A refused clipboard: the card opens at once, no slip; the learner's sentence first, the notes folded; closed without copying, the 手 slip stays.
    await reset({ noChat: true, refuseClipboard: true });
    await sendFromPanel();
    await sheet.waitFor({ timeout: 10000 });
    assert.equal(await page.locator('.sh-toast--receipt').count(), 0, `${tag}: no slip beside the card`);
    assert.match(await sheet.locator('.sh-handoff-sheet__ask').innerText(), language === 'zh' ? /^帮我按下面的要求改复习全书的知识点/ : /^Please change /);
    assert.equal(await sheet.locator('.sh-handoff-sheet__request').count(), 1);
    assert.match(await sheet.locator('.sh-handoff-sheet__fold > summary').innerText(), words.fold);
    assert.equal(await sheet.locator('.sh-handoff-sheet__fold[open]').count(), 0, `${tag}: the notes are folded`);
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('sh-handoff-sheet__copy')), true, `${tag}: the copy button has the focus`);
    assert.equal(await sheet.locator('.sh-handoff-sheet__copy.sh-btn--primary').count(), 1, `${tag}: the card's one filled button`);
    const said = await sheet.innerText();
    assert.equal(said.split(words.request).length - 1, 1, `${tag}: the learner's words once`);
    assert.doesNotMatch(said, /```/, `${tag}: no raw fence on show`);
    await shot('card-shown');
    // the fold's summary from the keyboard: the app's focus ring, not the browser's own
    for (let step = 0; step < 6 && !(await page.evaluate(() => document.activeElement?.matches('.sh-handoff-sheet__fold > summary'))); step += 1) await page.keyboard.press('Shift+Tab');
    const ring = await sheet.locator('.sh-handoff-sheet__fold > summary').evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished)); // (the app's short transition into the ring)
      const probe = document.createElement('i'); probe.style.color = 'var(--accent-soft)'; element.appendChild(probe); const soft = getComputedStyle(probe).color; probe.remove();
      return { focused: element.matches(':focus-visible'), style: getComputedStyle(element).outlineStyle, color: getComputedStyle(element).outlineColor, soft };
    });
    assert.deepEqual(ring, { focused: true, style: 'solid', color: ring.soft, soft: ring.soft }, `${tag}: the fold's focus ring is the app's`);
    // the copy is refused again: the whole message is selected (the fold opened first) in the highlighter's ochre, not the system blue
    const copy = sheet.locator('.sh-handoff-sheet__copy'), wide = (await copy.boundingBox()).width;
    await copy.click();
    await page.waitForFunction(() => (window.getSelection()?.toString() || '').length > 200);
    assert.equal(await sheet.locator('.sh-handoff-sheet__fold[open]').count(), 1);
    const picked = await page.evaluate(() => window.getSelection().toString());
    assert.ok(picked.includes(language === 'zh' ? '请用中文回复' : 'Please reply in English'), `${tag}: the selection holds the notes too`);
    assert.doesNotMatch(picked, words.fold, `${tag}: but not the fold's own label`);
    const selection = await sheet.locator('.sh-handoff-sheet__ask').evaluate((element) => getComputedStyle(element, '::selection').backgroundColor);
    const ochre = await page.evaluate(() => { const probe = document.createElement('i'); probe.style.color = 'var(--warn-mark)'; document.querySelector('.sh-handoff-sheet__box').appendChild(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; });
    assert.equal(selection, ochre, `${tag}: the selection is the ochre highlighter`);
    await shot('card-selected');
    // closed without copying: the slip 手 · 打开全文, which stays
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'detached', timeout: 10000 });
    receipt = await receiptOf('shown');
    assert.equal(receipt.title, words.shown);
    assert.deepEqual(receipt.action, [words.open]);
    if (width === 1280 && theme === 'light') { await page.waitForTimeout(6500); assert.equal(await slip.count(), 1, `${tag}: it stays`); }
    await shot('receipt-shown');
    // 打开全文: the card again; this time the clipboard takes it, the button says so at the same width, the card stays; closed, nothing is left
    await page.evaluate(() => { window.refuseClipboard = false; });
    await slip.locator('.sh-toast__action').click();
    await sheet.waitFor({ timeout: 10000 });
    // what the learner copies by hand from the whole box is the message exactly as it is (the names' backticks, the request fence, the notes)
    await sheet.locator('.sh-handoff-sheet__select').click();
    await page.waitForFunction(() => (window.getSelection()?.toString() || '').length > 200);
    const byHand = await page.evaluate(() => {
      const data = new DataTransfer(), event = new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true });
      document.querySelector('.sh-handoff-sheet__box').dispatchEvent(event);
      return { text: data.getData('text/plain'), taken: event.defaultPrevented };
    });
    assert.equal(byHand.taken, true, `${tag}: the card puts the message on the clipboard itself`);
    assert.match(byHand.text, words.ask, `${tag}: the sentence with its name span and the request fence, as sent`);
    assert.ok(byHand.text.endsWith(language === 'zh' ? '请用中文回复；已有的题目和引文保持原文，不要翻译。' : 'Please reply in English; keep existing questions and quotations as they are, do not translate them.'), `${tag}: down to the language sentence`);
    await copy.click();
    await sheet.locator('.sh-handoff-sheet__copy[data-copied]').waitFor({ timeout: 5000 });
    assert.equal(Math.round((await copy.boundingBox()).width), Math.round(wide), `${tag}: 「${words.done}」 at the same width`);
    assert.match(await copy.innerText(), new RegExp(words.done));
    assert.equal((await page.evaluate(() => window.copied)).length, 1);
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'detached', timeout: 10000 });
    assert.equal(await page.locator('.sh-toast--receipt').count(), 0, `${tag}: copied in the card: no slip`);

    // The selection bar's 发给主会话 (it sends the selected words at once): a picture of the bar, then the same delivery.
    await reset({ noChat: true });
    await page.evaluate(() => {
      const paragraph = [...document.querySelectorAll('[data-book-point] .book-file p')].find((element) => (element.textContent || '').trim().length > 30 && !element.closest('.book-ai'));
      const node = [...paragraph.childNodes].find((child) => child.nodeType === 3 && child.textContent.trim().length > 12);
      paragraph.scrollIntoView({ block: 'center', behavior: 'instant' });
      const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, Math.min(node.textContent.length, 12));
      const picked = window.getSelection(); picked.removeAllRanges(); picked.addRange(range);
    });
    const bar = page.locator('.book-select[data-placed]');
    await bar.waitFor({ timeout: 10000 });
    if (shots) { await hoverTip(bar.locator('[data-book-select="chat"]')); await shot('selection-bar'); }
    await bar.locator('[data-book-select="chat"]').click();
    await receiptOf('copied');
    assert.match((await page.evaluate(() => window.copied))[0], words.selected);

    // 更多 › 整本书 › 发给主会话: no ellipsis (it opens nothing first), its hint the short rule; chosen, the whole book is handed over at once.
    await reset({ noChat: true });
    await page.locator('.book-bar__more').first().click();
    const item = page.getByRole('menuitem', { name: new RegExp(`^${words.send}`) });
    assert.match(await item.innerText(), words.hint);
    assert.doesNotMatch(await item.innerText(), /…/);
    await item.scrollIntoViewIfNeeded();
    await shot('more-menu');
    await item.click();
    await receiptOf('copied');
    assert.match((await page.evaluate(() => window.copied))[0], words.book);
    assert.equal(await page.locator('dialog[open]').count(), 0, `${tag}: no form in between`);

    // 学习流 hands over through the shared unit too: its receipt is the last word there; no older toast of its own replaces it.
    if (language === 'zh' && (shots || (width === 1280 && theme === 'light'))) {
      await reset({ composerText: '我自己先打的字' });
      await page.getByRole('button', { name: '回到总纲' }).first().click();
      await page.locator('[data-tour="nav-workflows"]').first().click();
      await page.locator('details.wf-advanced > summary').click();
      const chat = page.locator('details.wf-advanced details.wf-chat');
      await chat.locator('summary').click();
      await chat.locator('textarea').fill('先讲例子');
      await chat.getByRole('button').click();
      await receiptOf('kept');
      await page.waitForTimeout(800);
      assert.equal(await page.locator('.sh-toasts').getByText(/请求已准备好/).count(), 0, `${tag}: no toast of the page's own after the hand-off`);
      assert.equal(await page.evaluate(() => window.composerText), '我自己先打的字');
      await shot('workflows-receipt-kept');
    }

    if (width < 400) assert.equal(phoneHeights.size, 1, `${tag}: every receipt is one height (${[...phoneHeights].join(', ')}px)`);
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
  // The receipt in review's action slot: in the flow, the same stamped slip (seal, words, action), no tone stripe and no tone icon; under reduced motion the seal only fades in.
  const inline = page.locator('.action-feedback-slot .sh-toast--receipt');
  await inline.waitFor({ timeout: 5000 });
  const look = await inline.evaluate((element) => ({ position: getComputedStyle(element.closest('.sh-toasts')).position, display: getComputedStyle(element).display,
    shadow: getComputedStyle(element).boxShadow, icon: element.querySelectorAll('.sh-toast__icon').length, seal: getComputedStyle(element.querySelector('.sh-seal')).animationName }));
  assert.deepEqual({ position: look.position, display: look.display, icon: look.icon, seal: look.seal }, { position: 'static', display: 'grid', icon: 0, seal: 'sh-seal-fade' });
  assert.doesNotMatch(look.shadow, /inset 3px 0px 0px/, 'no tone stripe');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  assert.equal(await inline.locator('.sh-seal').evaluate((element) => getComputedStyle(element).animationName), 'sh-seal-press', 'the seal is pressed when motion is welcome');
  await inline.locator('.sh-toast__action').click();
  assert.equal((await page.evaluate(() => window.partsLog)).at(-1), 'chat');

  // A receipt's time (1.5 s here): held while the pointer is on it, while its action has the focus and while the page is hidden; then it leaves after
  // what was left of it, and the countdown line is held with it. A newer stamp on the slip starts the whole time again.
  const timed = page.locator('.timed-slot .sh-toast--receipt');
  const line = async () => timed.locator('.sh-toast__timer').evaluate((element) => element.getAnimations()[0]?.playState);
  const goneWithin = async (ms) => {
    const started = Date.now();
    await timed.waitFor({ state: 'detached', timeout: ms });
    return Date.now() - started;
  };
  const show = async (key) => { await page.mouse.move(2, 2); await page.evaluate((k) => window.showReceipt(k, 1500), key); await timed.waitFor({ timeout: 5000 }); };
  // the pointer
  await show(1);
  await timed.hover();
  await page.waitForTimeout(2200);
  assert.equal(await timed.count(), 1, 'pointed at: it stays past its time');
  assert.equal(await line(), 'paused', 'and its countdown line is held');
  await page.mouse.move(2, 2);
  await page.waitForTimeout(300);
  assert.equal(await timed.count(), 1, 'let go: the rest of its time first');
  assert.equal(await line(), 'running');
  await goneWithin(2000);
  // the keyboard focus on its action
  await show(2);
  await timed.locator('.sh-toast__action').focus();
  await page.waitForTimeout(2200);
  assert.equal(await timed.count(), 1, 'focused: it stays past its time');
  assert.equal(await line(), 'paused');
  await page.evaluate(() => document.activeElement.blur());
  await page.waitForTimeout(300);
  assert.equal(await timed.count(), 1, 'blurred: the rest of its time first');
  await goneWithin(2000);
  // a hidden page
  await show(3);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(2200);
  assert.equal(await timed.count(), 1, 'hidden: it stays past its time');
  assert.equal(await line(), 'paused');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(300);
  assert.equal(await timed.count(), 1, 'shown again: the rest of its time first');
  await goneWithin(2000);
  // a newer stamp on the slip that is up: the whole time again
  await show(4);
  await page.waitForTimeout(1000);
  await page.evaluate(() => window.showReceipt(5, 1500));
  await page.waitForTimeout(1000);
  assert.equal(await timed.count(), 1, 'a newer stamp started the time again');
  assert.ok(await goneWithin(1500) > 100, 'and it ends after the new time');
  assert.equal((await page.evaluate(() => window.partsLog)).filter((entry) => entry === 'timed:gone').length, 4);
  assert.deepEqual(errors, []);
});
